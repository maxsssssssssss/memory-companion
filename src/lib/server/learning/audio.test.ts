// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { syntheticLearningWav } from "../../../../scripts/fixtures/learning-audio.mjs";
import { LearningRepository } from "./repository";
import { LearningAudioRepository } from "./audio-repository";
import type { requestCompanyAsr } from "@/lib/server/transcription/speaker-asr-provider";
import { companyTimedText, learningAsrConfig, learningAudioUrl, verifyLearningAudioUrl, transcribeLearningAudio } from "./audio-service";
import { inspectLearningAudio, prepareLearningAudio, learningAudioTempPath, cleanupLearningAudioTemp } from "./audio-files";
import { LearningFrameworkRepository } from "./framework-repository";
const bytes = syntheticLearningWav();
const metadata = { sha256: createHash("sha256").update(bytes).digest("hex"), originalVersion: 1 as const, mimeType: "audio/wav", durationSeconds: 1,
  transcription: "not_transcribed" as const, completedChunks: 0, totalChunks: 0 };
const config = { origin: "https://synthetic.invalid", secret: "SYNTHETIC_ONLY_CAPABILITY_32_CHARACTERS" };
const asr = { asr_result: { sentences: [{ text: "[合成测试] 不是所有金属都有磁性。", timestamp: [{ start: 0, end: 400 }] }] } };
let root: string; let repo: LearningRepository; let audio: LearningAudioRepository; let pageId: string; let materialId: string;
function save() { const id = randomUUID(); repo.saveMaterials(pageId, [{ id, title: "[合成测试] 音调", kind: "audio", filename: "synthetic.wav", bytes, audio: metadata }]); return id; }
const prepare = vi.fn(async () => [{ index: 0, start: 0, end: 0.5, bytes: Buffer.from("SYNTHETIC CHUNK 1") }, { index: 1, start: 0.5, end: 1, bytes: Buffer.from("SYNTHETIC CHUNK 2") }]);
const request = vi.fn(async (_input: Parameters<typeof requestCompanyAsr>[0]): Promise<Awaited<ReturnType<typeof requestCompanyAsr>>> => asr);
const dependencies = { configure: () => config, prepare, request };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-audio-synthetic-")); repo = new LearningRepository(root, "synthetic-owner"); audio = new LearningAudioRepository(repo);
  pageId = randomUUID(); repo.create({ id: pageId, title: "[合成测试] 录音" }); materialId = save();
  prepare.mockClear(); request.mockReset().mockResolvedValue(asr); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No real network"); }));
});
afterEach(async () => { if (repo.database.open) repo.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("learning audio isolated persistence/recovery, synthetic mock ASR only", () => {
  it("uses a learning-only signed audio origin without changing other product origins",()=>{
    expect(learningAsrConfig({LEARNING_ASR_AUDIO_CAPABILITY_SECRET:config.secret,SPEAKER_ASR_BASE_URL:"https://company.synthetic.invalid",SPEAKER_ASR_AUDIO_BASE_URL:"https://other-product.synthetic.invalid",LEARNING_ASR_AUDIO_BASE_URL:"https://learning.synthetic.invalid"}).origin).toBe("https://learning.synthetic.invalid");
  });
  it("only saves, preserves exact original, allows duplicate submit and has no ASR or generic product files", async () => {
    expect(audio.original(pageId, materialId).bytes).toEqual(bytes); expect(fetch).not.toHaveBeenCalled();
    repo.saveMaterials(pageId, [{ id: materialId, title: "[合成测试] 音调", kind: "audio", filename: "synthetic.wav", bytes, audio: metadata }]);
    expect(repo.get(pageId).materialCount).toBe(1); expect(() => repo.source(pageId, materialId)).toThrow("audio_not_transcribed");
    expect(await readdir(root)).toEqual(["learning-organizer.sqlite"]);
  });
  it("transcribes selected originals, preserves times, reopens, and uses completed transcript for bound framework sources", async () => {
    const ignored = save(); const id = randomUUID();
    await transcribeLearningAudio(repo, pageId, { id, materialIds: [materialId] }, dependencies);
    expect(request).toHaveBeenCalledTimes(2); expect(prepare).toHaveBeenCalledTimes(1);
    expect(audio.original(pageId, ignored).audio.transcription).toBe("not_transcribed");
    expect(repo.source(pageId, materialId).paragraphs.map((p) => [p.startSeconds, p.endSeconds])).toEqual([[0, 0.4], [0.5, 0.9]]);
    expect(audio.original(pageId, materialId).bytes).toEqual(bytes); expect(audio.chunks(pageId, materialId).every((c) => c.bytes === null)).toBe(true);
    const framework = new LearningFrameworkRepository(repo); const fid = randomUUID();
    framework.begin(pageId, { id: fid, materialIds: [materialId] }, 10000); framework.validating(pageId, fid);
    framework.complete(pageId, fid, { overview: "[模拟] 总览", chapters: [{ title: "磁性", explanation: "说明", nodes: [{ title: "边界", explanation: "[模拟] 解释", supplement: null, sources: [{ materialId, paragraph: 2 }] }] }] });
    const node = framework.view(pageId).chapters[0].nodes[0]; expect(node.sources[0]).toMatchObject({ startSeconds: 0.5, endSeconds: 0.9 });
    repo.close(); repo = new LearningRepository(root, "synthetic-owner"); audio = new LearningAudioRepository(repo);
    expect(repo.source(pageId, materialId).paragraphs).toHaveLength(2);
    await transcribeLearningAudio(repo, pageId, { id, materialIds: [materialId] }, dependencies); expect(request).toHaveBeenCalledTimes(2);
  });
  it("resumes unknown request by query and skips saved chunks, without re-normalization or submission", async () => {
    request.mockResolvedValueOnce(asr).mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_FAILURE"));
    const first = await transcribeLearningAudio(repo, pageId, { id: randomUUID(), materialIds: [materialId] }, dependencies);
    expect(first.page.materials[0].audio).toMatchObject({ transcription: "failed", completedChunks: 1, totalChunks: 2 });
    const requestId = audio.chunks(pageId, materialId)[1].request_id;
    await transcribeLearningAudio(repo, pageId, { id: randomUUID(), materialIds: [materialId] }, dependencies);
    expect(prepare).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][0]).toMatchObject({ requestId, resume: true });
    expect(audio.original(pageId, materialId).audio.transcription).toBe("completed");
  });
  it("continues other selected originals after one ASR failure, and fails closed on invented timestamps", async () => {
    const second = save(); request.mockResolvedValueOnce({ speaker_result: [{ text: "[合成测试] 无时间戳" }] });
    await transcribeLearningAudio(repo, pageId, { id: randomUUID(), materialIds: [materialId, second] }, dependencies);
    expect(repo.get(pageId).materials.map((m) => m.audio?.transcription).sort()).toEqual(["completed", "failed"]);
    expect(() => companyTimedText({ asr_result: { sentences: [{ text: "合成" }] } }, 0, 1)).toThrow("audio_invalid_timestamps");
    expect(() => companyTimedText(asr, 0, 0.2)).toThrow("audio_invalid_timestamps");
  });
  it("fences duplicate concurrent requests and changed scopes", async () => {
    let release!: (value: typeof asr) => void; request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const scope = { id: randomUUID(), materialIds: [materialId] }; const pending = transcribeLearningAudio(repo, pageId, scope, dependencies);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await transcribeLearningAudio(repo, pageId, scope, dependencies); expect(request).toHaveBeenCalledTimes(1);
    await expect(transcribeLearningAudio(repo, pageId, { ...scope, materialIds: [save()] }, dependencies)).rejects.toThrow("submission_conflict");
    await expect(transcribeLearningAudio(repo, pageId, { ...scope, id: randomUUID() }, dependencies)).rejects.toThrow("audio_busy");
    release(asr); await pending;
  });
  it.each(["material", "page"])("deleting %s removes originals/checkpoints and fences late results across connections", async (kind) => {
    let release!: (value: typeof asr) => void; request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = transcribeLearningAudio(repo, pageId, { id: randomUUID(), materialIds: [materialId] }, dependencies);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const other = new LearningRepository(root, "synthetic-owner");
    try { if (kind === "page") other.deletePage(pageId); else other.deleteMaterial(pageId, materialId); } finally { other.close(); }
    release(asr); if (kind === "page") await expect(pending).rejects.toThrow("page_deleted"); else await pending;
    expect(repo.database.prepare("SELECT count(*) n FROM learning_audio_chunks").get()).toEqual({ n: 0 });
    expect(repo.database.prepare("SELECT count(*) n FROM learning_audio_transcripts").get()).toEqual({ n: 0 });
    expect(() => audio.original(pageId, materialId)).toThrow();
  });
  it("rejects cross-account access even with same database and valid-shaped IDs", () => {
    const other = new LearningRepository(root, "other-synthetic");
    try { expect(() => new LearningAudioRepository(other).original(pageId, materialId)).toThrow("page_not_found"); expect(() => new LearningAudioRepository(other).begin(pageId, { id: randomUUID(), materialIds: [materialId] })).toThrow(); }
    finally { other.close(); }
  });
  it("requires own capability secret, binds every locator, and expires signed callback", () => {
    expect(() => learningAsrConfig({})).toThrow("learning_asr_not_configured");
    const address = { userId: "synthetic-owner", pageId, runId: randomUUID(), materialId, index: 0 };
    const query = new URL(learningAudioUrl(config, address)).searchParams;
    expect(verifyLearningAudioUrl(config.secret, address, query)).toBe(true);
    for (const patch of [{ userId: "other" }, { pageId: randomUUID() }, { runId: randomUUID() }, { materialId: randomUUID() }, { index: 1 }]) expect(verifyLearningAudioUrl(config.secret, { ...address, ...patch }, query)).toBe(false);
    query.set("expires", "1"); expect(verifyLearningAudioUrl(config.secret, address, query)).toBe(false);
  });
  it("expires abandoned runs, keeps completed checkpoints and never replays the same run ID", async () => {
    const scope = { id: randomUUID(), materialIds: [materialId] }; audio.begin(pageId, scope);
    repo.database.prepare("UPDATE learning_audio_runs SET deadline=0").run();
    await transcribeLearningAudio(repo, pageId, scope, dependencies);
    expect(audio.list(pageId)[0].failure).toBe("audio_interrupted"); expect(request).not.toHaveBeenCalled();
    expect(repo.get(pageId).materials[0].audio?.transcription).toBe("failed");
  });
  it("migrates schema 4 without changing prior PDF/TXT foreign keys or bytes", () => {
    const txt = randomUUID(); repo.saveMaterials(pageId, [{ id: txt, kind: "text", title: "合成", filename: null, bytes: Buffer.from("合成原文") }]);
    repo.deleteMaterial(pageId, materialId); repo.close();
    const db = new Database(join(root, "learning-organizer.sqlite"));
    db.pragma("foreign_keys=OFF"); db.exec(`CREATE TABLE old_materials (id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES learning_pages(id),title TEXT NOT NULL,kind TEXT CHECK(kind IN ('text','txt','pdf')),filename TEXT,original BLOB,fingerprint TEXT,created_at TEXT,selected INTEGER,deleted_at TEXT,pdf_metadata TEXT);
      INSERT INTO old_materials SELECT id,page_id,title,kind,filename,original,fingerprint,created_at,selected,deleted_at,pdf_metadata FROM learning_materials WHERE kind<>'audio';
      DROP TABLE learning_materials; ALTER TABLE old_materials RENAME TO learning_materials; PRAGMA user_version=4;`); db.close();
    repo = new LearningRepository(root, "synthetic-owner"); expect(repo.source(pageId, txt).text).toBe("合成原文"); expect(repo.database.pragma("foreign_key_check")).toEqual([]);
    expect(repo.database.pragma("foreign_keys", { simple: true })).toBe(1); expect(save()).toBeTruthy();
  });
  it("actually validates and normalizes a synthetic WAV locally, rejects disguised/oversized files, no ASR", async () => {
    const inspected = await inspectLearningAudio(bytes, "synthetic.wav", "audio/wav"); expect(inspected).toMatchObject(metadata);
    const chunks = await prepareLearningAudio(bytes, inspected, materialId); expect(chunks).toHaveLength(1); expect(chunks[0].bytes.length).toBeGreaterThan(0);
    await expect(inspectLearningAudio(Buffer.from("not audio"), "pretend.mp3", "audio/mpeg")).rejects.toThrow("invalid_audio");
    await expect(inspectLearningAudio(Buffer.alloc(64 * 1024 * 1024 + 1), "large.wav", "audio/wav")).rejects.toThrow("audio_too_large");
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it("uses the existing real FFmpeg 5-minute split with upload-global positions, no ASR", async () => {
    const long = syntheticLearningWav(301); const inspected = await inspectLearningAudio(long, "synthetic-long.wav", "audio/wav");
    const chunks = await prepareLearningAudio(long, inspected, materialId);
    expect(chunks.map((c) => [c.index, c.start, c.end])).toEqual([[0, 0, 300], [1, 300, 301]]);
    expect(chunks.every((c) => c.bytes.length > 0 && c.bytes.length < 3 * 1024 * 1024)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it("handles long account/material paths in mkdtemp, FFmpeg and deletion", async () => {
    const account = join(root, "synthetic-long-path-" + "x".repeat(100));
    const scope = { directory: learningAudioTempPath(account, pageId, materialId), assertWritable: () => undefined };
    expect(scope.directory.length).toBeGreaterThan(260);
    const inspected = await inspectLearningAudio(bytes, "synthetic.wav", "audio/wav", undefined, scope);
    expect(await prepareLearningAudio(bytes, inspected, materialId, undefined, scope)).toHaveLength(1);
    await cleanupLearningAudioTemp(account, pageId); await expect(readdir(scope.directory)).rejects.toThrow();
  }, 30000);
});
