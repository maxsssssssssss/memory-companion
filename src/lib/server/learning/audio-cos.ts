import { createHash, randomUUID } from "node:crypto";
import { LearningAudioRepository } from "./audio-repository";
import { LearningError, type LearningRepository } from "./repository";
import { cosAuthorization, cosConfig, cosUrl, sha256, type CosConfig } from "./audio-cos-client";

export type CosObject = {
  object_id: string; account_id: string; page_id: string; material_id: string; run_id: string; chunk_index: number;
  original_sha256: string; chunk_sha256: string; byte_size: number; bucket: string; region: string; object_key: string;
  upload_state: "uploading" | "ready" | "unknown"; version_id: string | null; expires_at: number;
  delete_requested: number; cleanup: "pending" | "unknown" | "confirmed"; next_cleanup_at: number;
};
type Address = { pageId: string; runId: string; materialId: string; index: number };
const query = (row: CosObject): Record<string, string> => row.version_id ? { versionId: row.version_id } : {};
const ownedKey = (row: CosObject) => row.object_key === `cloud-asr/learning-${row.object_id}/chunk.mp3`
  && /^[0-9a-f-]{36}$/.test(row.object_id);
const binding = (row: CosObject) => sha256(JSON.stringify([row.account_id, row.page_id, row.run_id,
  row.material_id, row.chunk_index, row.original_sha256, row.chunk_sha256]));

/** No bucket/list/public operations; all requests derive from a persisted owned identity. */
async function send(config: CosConfig, row: CosObject, transport: typeof fetch, method: string,
  body?: Buffer, signal?: AbortSignal) {
  if (!ownedKey(row) || row.bucket !== config.bucket || row.region !== config.region)
    throw new LearningError(409, "audio_cos_destination_changed");
  const headers: Record<string, string> = body ? { "Content-Type": "audio/mpeg", "Content-Length": String(body.length),
    "Content-MD5": createHash("md5").update(body).digest("base64"), "Cache-Control": "private, no-store",
    "x-cos-acl": "private", "x-cos-meta-binding": binding(row), "x-cos-meta-sha256": row.chunk_sha256 } : {};
  const params = method === "PUT" ? {} : query(row);
  const start = Math.floor(Date.now() / 1000) - 1;
  const response = await transport(cosUrl(config, row.object_key, params), { method,
    headers: { ...headers, Authorization: cosAuthorization(config, method, row.object_key, params, headers, start, start + 60) },
    ...(body ? { body: new Uint8Array(body) } : {}), redirect: "error", cache: "no-store",
    signal: AbortSignal.any([AbortSignal.timeout(method === "PUT" ? 15000 : 5000), ...(signal ? [signal] : [])]) });
  // Receipts are headers only. Never retain/log provider bodies or download URLs.
  await response.body?.cancel();
  return response;
}
function matches(response: Response, row: CosObject) {
  return response.status === 200 && response.headers.get("x-cos-meta-binding") === binding(row)
    && response.headers.get("x-cos-meta-sha256") === row.chunk_sha256
    && Number(response.headers.get("content-length")) === row.byte_size
    && (response.headers.get("x-cos-version-id") ?? null) === row.version_id;
}

/** PUT is separate from the ASR submission intent. A lost PUT receipt never
 * becomes a submitted ASR chunk and never authorizes another upload. */
export async function uploadLearningCosChunk(learning: LearningRepository, address: Address,
  config: CosConfig, signal: AbortSignal, transport: typeof fetch = fetch) {
  const audio = new LearningAudioRepository(learning);
  const row = learning.database.transaction(() => {
    audio.assertActive(address.pageId, address.runId, address.materialId);
    const chunk = audio.chunks(address.pageId, address.materialId)[address.index];
    if (!chunk?.bytes || chunk.state !== "pending") throw new LearningError(409, "audio_terminal");
    if (chunk.original_sha256 !== audio.original(address.pageId, address.materialId).audio.sha256)
      throw new LearningError(409, "source_changed");
    const old = learning.database.prepare("SELECT object_id FROM learning_audio_cos_objects WHERE account_id=? AND material_id=? AND chunk_index=?")
      .get(learning.accountId, address.materialId, address.index);
    if (old) throw new LearningError(409, "audio_cos_upload_unresolved");
    const id = randomUUID();
    const value: CosObject = { object_id: id, account_id: learning.accountId, page_id: address.pageId,
      material_id: address.materialId, run_id: address.runId, chunk_index: address.index,
      original_sha256: chunk.original_sha256, chunk_sha256: sha256(chunk.bytes), byte_size: chunk.bytes.length,
      bucket: config.bucket, region: config.region, object_key: `cloud-asr/learning-${id}/chunk.mp3`,
      upload_state: "uploading", version_id: null, expires_at: Math.floor(Date.now() / 1000) + 300,
      delete_requested: 0, cleanup: "pending", next_cleanup_at: 0 };
    learning.database.prepare(`INSERT INTO learning_audio_cos_objects (${Object.keys(value).join(",")})
      VALUES (${Object.keys(value).map(k => `@${k}`).join(",")})`).run(value);
    return { value, bytes: chunk.bytes };
  }).immediate();
  try {
    signal.throwIfAborted();
    const response = await send(config, row.value, transport, "PUT", row.bytes, signal);
    if (response.status !== 200 || response.headers.get("etag")?.replaceAll('"', "") !== createHash("md5").update(row.bytes).digest("hex"))
      throw new Error("upload_unconfirmed");
    const version = response.headers.get("x-cos-version-id");
    if (version && !/^[a-zA-Z0-9._~-]{1,200}$/.test(version)) throw new Error("version_invalid");
    // Save even after deletion: the late receipt grants cleanup, never permission to submit.
    learning.database.prepare("UPDATE learning_audio_cos_objects SET upload_state='ready',version_id=?,cleanup='pending',next_cleanup_at=0 WHERE object_id=? AND account_id=?")
      .run(version, row.value.object_id, learning.accountId);
    row.value.upload_state = "ready"; row.value.version_id = version;
    audio.assertActive(address.pageId, address.runId, address.materialId); signal.throwIfAborted();
    if (!matches(await send(config, row.value, transport, "HEAD", undefined, signal), row.value)) throw new Error("binding_mismatch");
    audio.assertActive(address.pageId, address.runId, address.materialId); signal.throwIfAborted();
    // One fixed expiry; no refresh on resume, cancellation or a repeated request.
    if (row.value.expires_at <= Math.floor(Date.now() / 1000) + 5) throw new Error("url_expired");
    const expires = row.value.expires_at;
    return { objectId: row.value.object_id, url: cosUrl(config, row.value.object_key, query(row.value),
      cosAuthorization(config, "GET", row.value.object_key, query(row.value), {}, expires - 300, expires)).toString() };
  } catch {
    learning.database.prepare(`UPDATE learning_audio_cos_objects SET upload_state=CASE WHEN upload_state='uploading' THEN 'unknown' ELSE upload_state END,
      delete_requested=1,next_cleanup_at=0 WHERE object_id=? AND account_id=?`).run(row.value.object_id, learning.accountId);
    throw new LearningError(409, "audio_cos_upload_unresolved");
  }
}

export function releaseLearningCosChunk(learning: LearningRepository, materialId: string, index: number) {
  learning.database.prepare("UPDATE learning_audio_cos_objects SET delete_requested=1,next_cleanup_at=0 WHERE account_id=? AND material_id=? AND chunk_index=?")
    .run(learning.accountId, materialId, index);
}

/** At most three objects per pass. Local deletion is not delayed indefinitely;
 * failure/ambiguous PUT remains durable. Next authenticated Learning request
 * resumes cleanup (including deleted pages) after restart, never resumes ASR. */
export async function cleanupLearningCos(learning: LearningRepository, config?: CosConfig, transport: typeof fetch = fetch) {
  if (!config) {
    if (process.env.DAILY_BRIEF_CLOUD_LEARNING_AUDIO !== "cos-synthetic") return;
    try { config = cosConfig(process.env); } catch { return; }
  }
  const db = learning.database;
  db.prepare(`UPDATE learning_audio_cos_objects SET delete_requested=1 WHERE account_id=? AND cleanup<>'confirmed'
    AND NOT EXISTS (SELECT 1 FROM learning_audio_runs r JOIN learning_pages p ON p.id=r.page_id
      WHERE r.id=learning_audio_cos_objects.run_id AND p.account_id=learning_audio_cos_objects.account_id
      AND p.deleted_at IS NULL AND r.status='processing' AND r.deadline>?)`).run(learning.accountId, Date.now());
  const rows = db.prepare(`SELECT * FROM learning_audio_cos_objects WHERE account_id=? AND delete_requested=1
    AND cleanup<>'confirmed' AND next_cleanup_at<=? ORDER BY next_cleanup_at,rowid LIMIT 3`).all(learning.accountId, Date.now()) as CosObject[];
  for (const row of rows) {
    // Claim the cleanup pass before I/O; racing requests need not all delete.
    const claimed = db.prepare(`UPDATE learning_audio_cos_objects SET next_cleanup_at=? WHERE object_id=? AND account_id=? AND next_cleanup_at=?`)
      .run(Date.now() + 60000, row.object_id, learning.accountId, row.next_cleanup_at).changes;
    if (!claimed) continue;
    let confirmed = false;
    try {
      const removed = await send(config, row, transport, "DELETE");
      const absent = await send(config, row, transport, "HEAD");
      // Even DELETE+404 cannot prove absence when a lost PUT may arrive later.
      confirmed = row.upload_state === "ready" && [200, 204].includes(removed.status) && absent.status === 404;
    } catch { /* Retain the identity; never print the response/URL/credentials. */ }
    db.prepare("UPDATE learning_audio_cos_objects SET cleanup=? WHERE object_id=? AND account_id=?")
      .run(confirmed ? "confirmed" : "unknown", row.object_id, learning.accountId);
  }
}
