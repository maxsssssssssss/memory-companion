// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { syntheticLearningWav } from "../../../../scripts/fixtures/learning-audio.mjs";
import { LearningRepository } from "./repository";
import { LearningAudioRepository } from "./audio-repository";
import { transcribeLearningAudio, learningAsrConfig } from "./audio-service";
import { cleanupLearningCos, uploadLearningCosChunk, type CosObject } from "./audio-cos";
import { cosConfig } from "./audio-cos-client";
import type { requestCompanyAsr } from "../transcription/speaker-asr-provider";

const env = { DAILY_BRIEF_COS_BUCKET: "synthetic-123456", DAILY_BRIEF_COS_REGION: "ap-shanghai",
  DAILY_BRIEF_COS_PREFIX: "cloud-asr/", DAILY_BRIEF_COS_SECRET_ID: "SYNTHETIC_ID", DAILY_BRIEF_COS_SECRET_KEY: "SYNTHETIC_KEY" };
const config = cosConfig(env), bytes = syntheticLearningWav();
const metadata = { sha256: createHash("sha256").update(bytes).digest("hex"), originalVersion: 1 as const,
  mimeType: "audio/wav", durationSeconds: 1, transcription: "not_transcribed" as const, completedChunks: 0, totalChunks: 0 };
const result = { asr_result: { sentences: [{ text: "[合成] 面积", timestamp: [{ start: 0, end: 800 }] }] } };
const plan = [{ index: 0, start: 0, end: 1, bytes: Buffer.from("SYNTHETIC NORMALIZED CHUNK") }];
let root: string, repo: LearningRepository, pageId: string, materialId: string;
const objects = new Map<string, { headers: Record<string, string>; bytes: Uint8Array }>();
let versioned = false;
const network = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input)), method = init?.method ?? "GET";
  expect(url.hostname).toBe("synthetic-123456.cos.ap-shanghai.myqcloud.com");
  expect(url.pathname).toMatch(/^\/cloud-asr\/learning-[0-9a-f-]{36}\/chunk.mp3$/);
  expect(init?.redirect).toBe("error");
  if (method === "PUT") {
    const headers = new Headers(init!.headers), value = init!.body as Uint8Array;
    expect(headers.get("x-cos-acl")).toBe("private");
    expect(headers.get("content-md5")).toBe(createHash("md5").update(value).digest("base64"));
    const receipt = { "x-cos-meta-binding": headers.get("x-cos-meta-binding")!,
      "x-cos-meta-sha256": headers.get("x-cos-meta-sha256")!, "content-length": String(value.length),
      etag: `"${createHash("md5").update(value).digest("hex")}"`, ...(versioned ? { "x-cos-version-id": "v1" } : {}) };
    objects.set(url.pathname, { headers: receipt, bytes: value });
    return new Response(null, { status: 200, headers: receipt });
  }
  if (method === "DELETE") { objects.delete(url.pathname); return new Response(null, { status: 204 }); }
  const object = objects.get(url.pathname);
  return new Response(null, { status: object ? 200 : 404, headers: object?.headers });
});
const request = vi.fn(async (_input: Parameters<typeof requestCompanyAsr>[0]) => result);
const prepare = vi.fn(async () => plan);
const deps = { configure: () => ({ origin: "", secret: "", cos: config }), prepare, request, cosTransport: network };
const rows = () => repo.database.prepare("SELECT * FROM learning_audio_cos_objects").all() as CosObject[];
const run = () => transcribeLearningAudio(repo, pageId, { id: randomUUID(), materialIds: [materialId] }, deps);
const methods = () => network.mock.calls.map(([, init]) => init?.method);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-cos-synthetic-")); repo = new LearningRepository(root, "synthetic-owner");
  pageId = randomUUID(); materialId = randomUUID(); repo.create({ id: pageId, title: "[合成] COS 生命周期" });
  repo.saveMaterials(pageId, [{ id: materialId, kind: "audio", title: "[合成] 音频", filename: "synthetic.wav", bytes, audio: metadata }]);
  objects.clear(); versioned = false; network.mockClear(); request.mockReset().mockResolvedValue(result); prepare.mockClear();
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("external_network_forbidden"); }));
});
afterEach(async () => { if (repo.database.open) repo.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("enables COS only by the Cloud marker; the ordinary application still requires its HMAC", () => {
  expect(() => learningAsrConfig({ ...env, SPEAKER_ASR_BASE_URL: "http://asr.invalid:8790" })).toThrow("learning_asr_not_configured");
  expect(learningAsrConfig({ ...env, DAILY_BRIEF_CLOUD_LEARNING_AUDIO: "cos-synthetic", SPEAKER_ASR_BASE_URL: "http://asr.invalid:8790" }).cos).toEqual(config);
});
it("migrates schema 11 transactionally without changing originals and refuses future versions", () => {
  const before = repo.get(pageId);
  repo.database.exec("DROP TABLE learning_audio_cos_objects; PRAGMA user_version=11"); repo.close();
  repo = new LearningRepository(root, "synthetic-owner");
  expect(repo.database.pragma("user_version", { simple: true })).toBe(12);
  expect(repo.get(pageId)).toEqual(before); expect(new LearningAudioRepository(repo).original(pageId, materialId).bytes).toEqual(bytes);
  expect(repo.database.pragma("foreign_key_check")).toEqual([]);
  repo.database.exec("PRAGMA user_version=13"); repo.close();
  expect(() => new LearningRepository(root, "synthetic-owner")).toThrow("unsupported_learning_schema");
  const db = new Database(join(root, "learning-organizer.sqlite"));
  expect(db.pragma("user_version", { simple: true })).toBe(13); db.close();
});
it.each([false, true])("uploads exact normalized bytes once, transcribes, persists originals and deletes versioned=%s", async version => {
  versioned = version;
  request.mockImplementationOnce(async input => {
    expect(rows()[0].upload_state).toBe("ready");
    expect(new LearningAudioRepository(repo).chunks(pageId, materialId)[0].state).toBe("submitted");
    const url = new URL(input.audioUrl); expect(objects.get(url.pathname)?.bytes).toEqual(new Uint8Array(plan[0].bytes));
    expect(url.searchParams.get("versionId")).toBe(version ? "v1" : null);
    const [start, end] = url.searchParams.get("q-sign-time")!.split(";").map(Number);
    expect(end - start).toBe(300); expect(input.resume).toBe(false); return result;
  });
  const response = await run();
  expect(response.page.materials[0].audio?.transcription).toBe("completed");
  expect(methods()).toEqual(["PUT", "HEAD", "DELETE", "HEAD"]);
  expect(rows()[0]).toMatchObject({ cleanup: "confirmed", delete_requested: 1 });
  expect(objects.size).toBe(0); expect(new LearningAudioRepository(repo).original(pageId, materialId).bytes).toEqual(bytes);
  expect(JSON.stringify(rows())).not.toMatch(/SYNTHETIC_KEY|q-signature|q-ak|https:/);
  if (version) for (const [url, init] of network.mock.calls.slice(1)) expect(new URL(String(url)).searchParams.get("versionId")).toBe("v1");
  repo.close(); repo = new LearningRepository(root, "synthetic-owner");
  expect(repo.source(pageId, materialId).paragraphs[0]).toMatchObject({ startSeconds: 0, endSeconds: 0.8 });
  await run(); expect(request).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledTimes(1);
});
it("a lost ASR receipt resumes by the original ID without a PUT or a fresh URL", async () => {
  request.mockRejectedValueOnce(Error("PRIVATE_UPSTREAM_ERROR")); await run();
  const id = request.mock.calls[0][0].requestId;
  await run();
  expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[1][0]).toMatchObject({ requestId: id, resume: true, audioUrl: "" });
  expect(methods().filter(m => m === "PUT")).toHaveLength(1);
  expect(repo.get(pageId).materials[0].audio?.transcription).toBe("completed");
});
it("a lost PUT receipt is not ASR submission, is never replayed and cannot be declared cleaned by 404", async () => {
  network.mockRejectedValueOnce(Error("lost_upload_receipt_with_secret"));
  await run(); expect(request).not.toHaveBeenCalled();
  expect(new LearningAudioRepository(repo).chunks(pageId, materialId)[0]).toMatchObject({ state: "pending", request_id: null });
  expect(rows()[0]).toMatchObject({ upload_state: "unknown", cleanup: "unknown" });
  await run(); expect(request).not.toHaveBeenCalled(); expect(methods().filter(m => m === "PUT")).toHaveLength(1);
  expect(rows()[0].cleanup).toBe("unknown");
});
it.each(["material", "page", "cancel"])("%s during PUT fences ASR and cleans a late acknowledged object", async kind => {
  let release!: () => void;
  const original = network.getMockImplementation()!;
  network.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); });
  const pending = run(); await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
  const other = new LearningRepository(root, "synthetic-owner");
  if (kind === "page") other.deletePage(pageId);
  else if (kind === "material") other.deleteMaterial(pageId, materialId);
  else new LearningAudioRepository(other).fail(pageId, rows()[0].run_id, "audio_interrupted");
  await cleanupLearningCos(other, config, network); other.close();
  expect(rows()[0].cleanup).toBe("unknown");
  release();
  if (kind === "page") await expect(pending).rejects.toThrow("page_deleted"); else await pending;
  expect(request).not.toHaveBeenCalled(); expect(objects.size).toBe(0);
  expect(rows()[0]).toMatchObject({ upload_state: "ready", cleanup: "confirmed" });
  expect(repo.database.prepare("SELECT count(*) n FROM learning_audio_transcripts").get()).toEqual({ n: 0 });
});
it("a delete during ASR aborts the local request and rejects late publication", async () => {
  let release!: () => void;
  request.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return result; });
  const pending = run(); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  repo.deleteMaterial(pageId, materialId); await cleanupLearningCos(repo, config, network);
  await vi.waitFor(() => expect(request.mock.calls[0][0].signal?.aborted).toBe(true));
  expect(objects.size).toBe(0); release(); await pending;
  expect(repo.database.prepare("SELECT count(*) n FROM learning_audio_transcripts").get()).toEqual({ n: 0 });
});
it("retains failed cleanup across deleted page and restart, with no ASR or upload replay", async () => {
  request.mockImplementationOnce(async () => {
    network.mockRejectedValueOnce(Error("delete_unavailable")); return result;
  });
  await run(); expect(rows()[0].cleanup).toBe("unknown"); expect(objects.size).toBe(1);
  repo.deletePage(pageId); repo.close(); repo = new LearningRepository(root, "synthetic-owner");
  await cleanupLearningCos(repo, config, network);
  expect(objects.size).toBe(0); expect(rows()[0].cleanup).toBe("confirmed"); expect(request).toHaveBeenCalledTimes(1);
});
it("an acknowledged upload orphan after a crash is cleaned after its run expires, never submitted", async () => {
  const audio = new LearningAudioRepository(repo), id = randomUUID();
  audio.begin(pageId, { id, materialIds: [materialId] }); audio.savePlan(pageId, id, materialId, plan);
  await uploadLearningCosChunk(repo, { pageId, runId: id, materialId, index: 0 }, config, new AbortController().signal, network);
  expect(audio.chunks(pageId, materialId)[0].state).toBe("pending");
  repo.database.prepare("UPDATE learning_audio_runs SET deadline=0").run();
  repo.close(); repo = new LearningRepository(root, "synthetic-owner");
  await cleanupLearningCos(repo, config, network); await run();
  expect(rows()[0].cleanup).toBe("confirmed"); expect(request).not.toHaveBeenCalled(); expect(methods().filter(m => m === "PUT")).toHaveLength(1);
});
it("cross-account access cannot upload, enumerate for cleanup or delete another account's object", async () => {
  request.mockImplementationOnce(async () => { network.mockRejectedValueOnce(Error("offline")); return result; }); await run();
  repo.database.prepare("UPDATE learning_audio_cos_objects SET next_cleanup_at=0").run(); network.mockClear();
  const other = new LearningRepository(root, "other-synthetic");
  await cleanupLearningCos(other, config, network);
  await expect(uploadLearningCosChunk(other, { pageId, runId: randomUUID(), materialId, index: 0 }, config, new AbortController().signal, network)).rejects.toThrow("page_not_found");
  other.close(); expect(network).not.toHaveBeenCalled(); expect(objects.size).toBe(1);
});
it("configuration changes cannot send today's credential to a saved different bucket", async () => {
  request.mockImplementationOnce(async () => { network.mockRejectedValueOnce(Error("offline")); return result; }); await run();
  repo.database.prepare("UPDATE learning_audio_cos_objects SET next_cleanup_at=0").run(); network.mockClear();
  await cleanupLearningCos(repo, { ...config, bucket: "changed-123456" }, network);
  expect(network).not.toHaveBeenCalled(); expect(rows()[0].cleanup).toBe("unknown");
});
it("recovery is bounded to three objects per pass and retained failures do not starve newer cleanup", async () => {
  for (let i = 0; i < 4; i++) {
    if (i) {
      materialId = randomUUID(); repo.saveMaterials(pageId, [{ id: materialId, kind: "audio", title: "[合成]", filename: "s.wav", bytes, audio: metadata }]);
    }
    request.mockImplementationOnce(async () => { network.mockRejectedValueOnce(Error("offline")); return result; });
    await run();
  }
  repo.database.prepare("UPDATE learning_audio_cos_objects SET next_cleanup_at=0").run(); network.mockClear();
  await cleanupLearningCos(repo, config, network);
  expect(methods().filter(m => m === "DELETE")).toHaveLength(3); expect(objects.size).toBe(1);
  await cleanupLearningCos(repo, config, network); expect(objects.size).toBe(0);
});
it("foreign metadata after PUT prevents ASR, without leaking upstream response content", async () => {
  const original = network.getMockImplementation()!;
  network.mockImplementationOnce(original).mockResolvedValueOnce(new Response(null, { status: 200, headers: { "x-cos-meta-binding": "another-account" } }));
  const response = await run(); expect(request).not.toHaveBeenCalled(); expect(response.page.materials[0].audio?.failure).toBe("audio_cos_upload_unresolved");
  expect(rows()[0].cleanup).toBe("confirmed");
});
