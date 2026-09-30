// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getUserDataRootDir } from "@/lib/server/auth/session";
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningAudioRepository } from "@/lib/server/learning/audio-repository";
import { learningAudioUrl } from "@/lib/server/learning/audio-service";
import { learningAudioTempPath } from "@/lib/server/learning/audio-files";
import { syntheticLearningWav } from "../../../../scripts/fixtures/learning-audio.mjs";
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/server/auth/request-context", async (original) => ({ ...await original<typeof import("@/lib/server/auth/request-context")>(), requireAuthContext: auth }));
import { POST as save } from "./pages/[pageId]/materials/route";
import { POST as transcribe, GET as runs } from "./pages/[pageId]/transcriptions/route";
import { GET as source, DELETE as remove } from "./pages/[pageId]/materials/[materialId]/route";
import { DELETE as removePage } from "./pages/[pageId]/route";
import { GET as callback, HEAD as callbackHead } from "./asr-audio/[userId]/[pageId]/[runId]/[materialId]/[index]/route";
import { GET as sharedAudio } from "../internal/audio/[userId]/[uploadId]/route";
let root: string; let pageId: string; let materialId: string;
const bytes = syntheticLearningWav(); const secret = "SYNTHETIC_LEARNING_CALLBACK_SECRET_32";
const pp = () => ({ params: Promise.resolve({ pageId }) }); const mp = () => ({ params: Promise.resolve({ pageId, materialId }) });
function request(method = "GET", body?: BodyInit, user = "owner") { return new Request("http://localhost/api/learning", { method, headers: { "x-account": user, origin: "http://localhost" }, body }); }
function form() {
  const f = new FormData(); f.set("materials", JSON.stringify([{ id: materialId, title: "[合成测试] 音调", kind: "audio" }]));
  f.append("files", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "synthetic.wav"); return f;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-audio-api-synthetic-")); pageId = randomUUID(); materialId = randomUUID();
  vi.stubEnv("APP_DATA_DIR", root); vi.stubEnv("LEARNING_ASR_AUDIO_CAPABILITY_SECRET", secret); vi.stubEnv("SPEAKER_ASR_BASE_URL", "");
  auth.mockImplementation(async (r: Request) => { const id = r.headers.get("x-account"); if (!id) throw new Error("unauthenticated"); return { user: { id }, dataRootDir: getUserDataRootDir(id, root) }; });
  const repository = new LearningRepository(getUserDataRootDir("owner", root), "owner"); repository.create({ id: pageId, title: "[合成测试] 录音" }); repository.close();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No external network in synthetic API tests"); }));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });
it("saves actual WAV bytes without ASR, replays one material, denies cross-account and unconfigured processing", async () => {
  expect((await save(request("POST", form()), pp())).status).toBe(200);
  expect((await (await save(request("POST", form()), pp())).json()).page.materialCount).toBe(1);
  expect((await source(request(), mp())).status).toBe(409);
  expect((await runs(request(), pp())).status).toBe(200);
  expect((await runs(request("GET", undefined, "other"), pp())).status).toBe(404);
  expect((await save(request("POST", form(), "other"), pp())).status).toBe(404);
  const response = await transcribe(request("POST", JSON.stringify({ id: randomUUID(), materialIds: [materialId] })), pp());
  expect(response.status).toBe(503); expect((await response.json()).error).toBe("learning_asr_not_configured");
  expect(fetch).not.toHaveBeenCalled();
  expect((await sharedAudio(new Request("http://localhost/api/internal/audio/owner/x"), { params: Promise.resolve({ userId: "owner", uploadId: materialId }) })).status).toBe(401);
}, 30000);
it("signed GET/HEAD binds account/page/run/material/chunk; no general original playback, Range cannot bypass auth", async () => {
  await save(request("POST", form()), pp());
  const repository = new LearningRepository(getUserDataRootDir("owner", root), "owner"); const audio = new LearningAudioRepository(repository); const runId = randomUUID();
  audio.begin(pageId, { id: runId, materialIds: [materialId] }); audio.savePlan(pageId, runId, materialId, [{ index: 0, start: 0, end: 1, bytes: Buffer.from("SYNTHETIC_NORMALIZED_AUDIO") }]);
  audio.claimChunk(pageId, runId, materialId, 0);
  const address = { userId: "owner", pageId, runId, materialId, index: 0 };
  const url = learningAudioUrl({ secret, origin: "http://localhost" }, address);
  const cp = (patch = {}) => ({ params: Promise.resolve({ ...address, index: "0", ...patch }) });
  expect(await (await callback(new Request(url), cp())).text()).toBe("SYNTHETIC_NORMALIZED_AUDIO");
  expect((await callbackHead(new Request(url, { method: "HEAD" }), cp())).status).toBe(200);
  expect((await callback(new Request(url, { headers: { range: "bytes=0-5" } }), cp())).status).toBe(416);
  expect((await callback(new Request(url.split("?")[0]), cp())).status).toBe(401);
  for (const patch of [{ userId: "other" }, { pageId: randomUUID() }, { materialId: randomUUID() }, { runId: randomUUID() }, { index: "1" }]) expect((await callback(new Request(url), cp(patch))).status).toBe(401);
  repository.deleteMaterial(pageId, materialId); repository.close();
  expect((await callback(new Request(url), cp())).status).toBe(404);
}, 30000);
it.each(["material", "page"])("%s deletion also removes scoped processing remnants after a prior process exit", async (kind) => {
  await save(request("POST", form()), pp());
  const temp = learningAudioTempPath(getUserDataRootDir("owner", root), pageId, materialId);
  await mkdir(temp, { recursive: true }); await writeFile(join(temp, "SYNTHETIC_ABANDONED_COPY"), bytes);
  const response = await (kind === "page" ? removePage(request("DELETE"), pp()) : remove(request("DELETE"), mp()));
  expect(response.status).toBe(200); await expect(access(temp)).rejects.toThrow();
  expect((await source(request(), mp())).status).toBe(410);
  const repository = new LearningRepository(getUserDataRootDir("owner", root), "owner");
  expect(repository.database.prepare("SELECT original FROM learning_materials WHERE id=?").get(materialId)).toEqual(kind === "page" ? undefined : { original: null }); repository.close();
}, 30000);
