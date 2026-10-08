import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LearningError, type LearningRepository, type PdfSourceRecord } from "./repository";

/** Transport capability is separate from the unchanged OCR output contract. */
export const PdfSourceCapability = z.object({
  version: z.literal("v1"), upload_method: z.literal("PUT"),
  max_bytes: z.number().int().positive().max(64 * 1024 * 1024),
  max_sources: z.number().int().positive(), max_total_bytes: z.number().int().positive(),
  ttl_seconds: z.number().int().positive(), upload_timeout_seconds: z.number().int().positive().max(600)
});
export type PdfSourceConnection = {
  url: string; token: string; serviceEpoch: string; instance: string;
  sourceTransport: z.infer<typeof PdfSourceCapability>;
};
const Receipt = z.object({
  source_id: z.string(), document_id: z.string(), sha256: z.string(),
  bytes: z.number().int().nonnegative(), physical_page_count: z.number().int().positive().nullable(),
  service_epoch: z.string(), instance: z.string(),
  status: z.enum(["uploading", "ready", "failed", "deleted", "expired"]),
  created_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }).nullable()
});

/** Never expose upstream error bodies, URLs or credentials through Learning errors. */
export async function boundedPdfTransportJson(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_response");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > maxBytes) { await reader.cancel(); throw new Error("oversized_response"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function boundReceipt(raw: unknown, source: PdfSourceRecord) {
  const receipt = Receipt.parse(raw);
  if (receipt.source_id !== source.sourceId || receipt.document_id !== source.materialId
    || receipt.sha256 !== source.sha256 || receipt.bytes !== source.byteSize
    || receipt.service_epoch !== source.serviceEpoch || receipt.instance !== source.instance
    || (receipt.status === "ready" && (receipt.physical_page_count !== source.pageCount || !receipt.expires_at)))
    throw new Error("source_binding_mismatch");
  return receipt;
}

/** One persisted original identity per upload. Unknown uploads are queried, never replayed. */
export async function ensurePdfSource(repo: LearningRepository, pageId: string, materialId: string,
  config: PdfSourceConnection, transport: typeof fetch,
  options: { assertOwner: () => void; explicitResume: boolean; now: () => number }): Promise<string> {
  const { assertOwner, now } = options;
  assertOwner();
  const original = repo.pdfOriginal(pageId, materialId, false).material;
  const metadata = original.pdf!;
  const sources = repo.listPdfSources(pageId, materialId);
  // An endpoint/instance change does not resolve a previously ambiguous upload.
  const uncertain = sources.find(s => s.status === "uploading" || s.status === "unknown");
  if (uncertain && (uncertain.serviceUrl !== config.url || uncertain.serviceEpoch !== config.serviceEpoch || uncertain.instance !== config.instance))
    throw new LearningError(409, "pdf_source_outcome_unknown");
  let source = uncertain ?? sources.filter(s => s.serviceUrl === config.url && s.serviceEpoch === config.serviceEpoch && s.instance === config.instance).at(-1);
  if (source && ["uploading", "unknown", "ready"].includes(source.status)) {
    let response: Response, receipt: z.infer<typeof Receipt> | undefined;
    let terminalLookup = false;
    try {
      response = await transport(`${config.url}/pdf-sources/${source.sourceId}`, {
        headers: { Authorization: `Bearer ${config.token}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000)
      });
      const raw = await boundedPdfTransportJson(response);
      // The deployed adapter returns a minimal authenticated tombstone for
      // this exact saved source URL. It supplies no content or new authority.
      terminalLookup = response.status === 410 && z.object({
        error: z.enum(["source_deleted", "source_expired"]), accepted: z.literal(false)
      }).strict().safeParse(raw).success;
      if (!terminalLookup) receipt = boundReceipt(raw, source);
      if (!(response.ok || response.status === 410)) throw new Error("source_lookup_failed");
    } catch { throw new LearningError(409, "pdf_source_outcome_unknown"); }
    assertOwner();
    if (receipt?.status === "ready" && Date.parse(receipt.expires_at!) > now()) {
      repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: source.status, status: "ready", expiresAt: receipt.expires_at });
      return source.sourceId;
    }
    if (receipt?.status === "uploading") throw new LearningError(409, "pdf_source_outcome_unknown");
    const terminal = receipt?.status === "failed" ? "failed" : "expired";
    source = repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: source.status, status: terminal });
  }
  if (source && ["failed", "expired"].includes(source.status) && !options.explicitResume)
    throw new LearningError(409, "pdf_source_unavailable");
  if (!source || source.status !== "pending") {
    source = repo.createPdfSource(pageId, { sourceId: randomUUID(), materialId,
      sha256: metadata.sha256, originalVersion: metadata.originalVersion, serviceUrl: config.url,
      serviceEpoch: config.serviceEpoch, instance: config.instance, byteSize: original.byteLength, pageCount: metadata.pageCount });
  }
  if (original.byteLength > config.sourceTransport.max_bytes) throw new LearningError(413, "pdf_source_too_large");
  assertOwner();
  const bytes = repo.pdfOriginal(pageId, materialId).bytes!;
  repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "uploading" });
  try {
    const response = await transport(`${config.url}/pdf-sources/${source.sourceId}`, {
      method: "PUT", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(config.sourceTransport.upload_timeout_seconds * 1000),
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/pdf", "Content-Length": String(bytes.length),
        "X-OCR-Document-ID": materialId, "X-OCR-SHA256": metadata.sha256,
        "X-OCR-Service-Epoch": config.serviceEpoch, "X-OCR-Instance": config.instance },
      body: new Uint8Array(bytes)
    });
    const raw = await boundedPdfTransportJson(response);
    assertOwner();
    if (response.status === 503 && z.object({ error: z.literal("source_capacity_exhausted") }).safeParse(raw).success) {
      repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "uploading", status: "failed" });
      throw new LearningError(503, "pdf_source_capacity_exhausted");
    }
    const receipt = boundReceipt(raw, source);
    if (receipt.status === "failed" || receipt.status === "expired" || receipt.status === "deleted") {
      repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "uploading", status: receipt.status === "failed" ? "failed" : "expired" });
      throw new LearningError(409, "pdf_source_unavailable");
    }
    if (!response.ok || receipt.status !== "ready" || Date.parse(receipt.expires_at!) <= now()) throw new Error("source_upload_unconfirmed");
    repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "uploading", status: "ready", expiresAt: receipt.expires_at });
    return source.sourceId;
  } catch (error) {
    assertOwner();
    const current = repo.getPdfSource(pageId, materialId, source.sourceId);
    if (current.status === "uploading") repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "uploading", status: "unknown" });
    if (error instanceof LearningError) throw error;
    throw new LearningError(409, "pdf_source_outcome_unknown");
  }
}

/** Cleanup is scoped to durable local deletion intents, never active page results.
 * A config change cannot send a saved handle (or today's key) to an old endpoint. */
export async function cleanupDeletedPdfSources(repo: LearningRepository, pageId: string, materialId: string | undefined,
  config: { url: string; token: string }, transport: typeof fetch = fetch) {
  for (const source of repo.listPdfSourcesPendingCleanup(pageId, materialId)) {
    if (source.serviceUrl !== config.url) continue;
    let result: "deleted" | "failed" = "failed";
    try {
      const response = await transport(`${config.url}/pdf-sources/${source.sourceId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${config.token}` },
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const receipt = boundReceipt(await boundedPdfTransportJson(response), source);
        if (receipt.status === "deleted") result = "deleted";
      }
      // 404 is not a durable tombstone: an in-flight upload can still arrive.
    } catch { /* Local deletion succeeds; retain the failed cleanup intent. */ }
    repo.markPdfSourceCleanup(source.pageId, source.materialId, source.sourceId, result);
  }
}
