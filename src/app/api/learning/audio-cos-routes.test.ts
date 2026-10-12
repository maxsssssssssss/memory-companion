// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getUserDataRootDir } from "@/lib/server/auth/session";
import { LearningRepository } from "@/lib/server/learning/repository";
import { syntheticLearningWav } from "../../../../scripts/fixtures/learning-audio.mjs";
const { auth, afterCallbacks } = vi.hoisted(() => ({ auth: vi.fn(), afterCallbacks: [] as Array<() => Promise<unknown>> }));
vi.mock("@/lib/server/auth/request-context", async original => ({ ...await original<typeof import("@/lib/server/auth/request-context")>(), requireAuthContext: auth }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: (callback: () => Promise<unknown>) => afterCallbacks.push(callback) }));
import { POST as upload } from "./pages/[pageId]/materials/route";
import { GET as page, DELETE as deletePage } from "./pages/[pageId]/route";
import { GET as pages } from "./pages/route";
import { GET as source } from "./pages/[pageId]/materials/[materialId]/route";
let root: string, pageId: string, materialId: string;
const bytes = syntheticLearningWav();
const context = () => ({ params: Promise.resolve({ pageId }) });
const materialContext = () => ({ params: Promise.resolve({ pageId, materialId }) });
const open = (account = "owner") => new LearningRepository(getUserDataRootDir(account, root), account);
const req = (method = "GET", account = "owner", body?: BodyInit) => new Request("http://localhost/api/learning", {
  method, headers: { origin: "http://localhost", "x-account": account }, body });
const objects = new Map<string, Headers>();
const calls: string[] = [];
let failCleanup = false;
const network = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input)), method = init?.method ?? "GET";
  if (url.hostname === "synthetic-123456.cos.ap-shanghai.myqcloud.com") {
    calls.push(`COS ${method}`);
    if (method === "PUT") {
      const body = init!.body as Uint8Array, headers = new Headers(init?.headers);
      expect(body.length).toBeGreaterThan(0); expect(Buffer.from(body).equals(bytes)).toBe(false); // actual normalized MP3, not WAV
      const receipt = new Headers({ "content-length": String(body.length),
        "x-cos-meta-binding": headers.get("x-cos-meta-binding")!, "x-cos-meta-sha256": headers.get("x-cos-meta-sha256")!,
        etag: `"${createHash("md5").update(body).digest("hex")}"` });
      objects.set(url.pathname, receipt); return new Response(null, { headers: receipt });
    }
    if (method === "DELETE") {
      if (failCleanup) throw Error("synthetic_connection_unavailable");
      objects.delete(url.pathname); return new Response(null, { status: 204 });
    }
    if (method === "HEAD") return new Response(null, { status: objects.has(url.pathname) ? 200 : 404, headers: objects.get(url.pathname) });
  }
  if (url.hostname === "asr.synthetic.invalid") {
    calls.push(`ASR ${method}`);
    if (method === "POST") {
      const body = JSON.parse(String(init?.body));
      expect(objects.has(new URL(body.audio_url).pathname)).toBe(true);
      expect(body.req_id).toBe(body.record_id);
      return Response.json({ code: 0 });
    }
    return Response.json({ code: 0, data: { asr_result: { sentences: [{ text: "[合成] 三角形面积。", timestamp: [{ start: 0, end: 800 }] }] } } });
  }
  throw Error("unexpected_destination");
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-cos-api-synthetic-")); pageId = randomUUID(); materialId = randomUUID();
  objects.clear(); calls.length = 0; afterCallbacks.length = 0; failCleanup = false; network.mockClear();
  for (const [key, value] of Object.entries({ APP_DATA_DIR: root, DAILY_BRIEF_CLOUD_LEARNING_AUDIO: "cos-synthetic",
    DAILY_BRIEF_CLOUD_ASR_HTTP_BASE_URL: "", SPEAKER_ASR_BASE_URL: "http://asr.synthetic.invalid:8790",
    DAILY_BRIEF_COS_BUCKET: "synthetic-123456", DAILY_BRIEF_COS_REGION: "ap-shanghai", DAILY_BRIEF_COS_PREFIX: "cloud-asr/",
    DAILY_BRIEF_COS_SECRET_ID: "SYNTHETIC_ONLY_ID", DAILY_BRIEF_COS_SECRET_KEY: "SYNTHETIC_ONLY_KEY" })) vi.stubEnv(key, value);
  auth.mockImplementation(async (r: Request) => {
    const id = r.headers.get("x-account"); if (!id) throw Error("unauthenticated");
    return { user: { id }, dataRootDir: getUserDataRootDir(id, root) };
  });
  const repo = open(); repo.create({ id: pageId, title: "[合成] 页面音频" }); repo.close();
  vi.stubGlobal("fetch", network);
});
async function drain() { for (const callback of afterCallbacks.splice(0)) await callback(); }
afterEach(async () => { await drain(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function save(account = "owner") {
  const form = new FormData(); form.set("materials", JSON.stringify([{ id: materialId, title: "[合成] 音调", kind: "audio" }]));
  form.append("files", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "synthetic.wav");
  form.set("intent", "prepare");
  return upload(req("POST", account, form), context());
}
it("actual upload/Next after/FFmpeg/ASR protocol/save/refresh/delete routes use COS with no real network", async () => {
  expect((await save()).status).toBe(200); await drain();
  expect(calls).toEqual(["COS PUT", "COS HEAD", "ASR POST", "ASR GET", "COS DELETE", "COS HEAD"]);
  const reloaded = await (await page(req(), context())).json();
  expect(reloaded.page.materials[0].audio.transcription).toBe("completed");
  expect((await (await source(req(), materialContext())).json()).source.text).toBe("[合成] 三角形面积。");
  const repo = open(); expect(repo.database.prepare("SELECT original FROM learning_materials WHERE id=?").get(materialId)).toEqual({ original: bytes }); repo.close();
  const before = calls.length; expect((await save()).status).toBe(200); await drain(); expect(calls).toHaveLength(before);
  expect((await deletePage(req("DELETE"), context())).status).toBe(200);
  expect((await page(req(), context())).status).toBe(410); expect(objects.size).toBe(0);
}, 30000);
it("new authenticated request after deletion/reopen resumes failed cleanup, never ASR", async () => {
  failCleanup = true; await save(); await drain(); expect(objects.size).toBe(1);
  await deletePage(req("DELETE"), context()); failCleanup = false;
  const repo = open(); repo.database.prepare("UPDATE learning_audio_cos_objects SET next_cleanup_at=0").run(); repo.close();
  const before = calls.filter(c => c.startsWith("ASR"));
  expect((await pages(req())).status).toBe(200);
  expect(objects.size).toBe(0); expect(calls.filter(c => c.startsWith("ASR"))).toEqual(before);
}, 30000);
it("foreign account cannot start an upload or clean up the owner's objects", async () => {
  expect((await save("other")).status).toBe(404); expect(calls).toEqual([]);
  failCleanup = true; await save(); await drain();
  const repo = open(); repo.deletePage(pageId); repo.close();
  failCleanup = false; const count = calls.length;
  expect((await pages(req("GET", "other"))).status).toBe(200); expect(calls).toHaveLength(count); expect(objects.size).toBe(1);
}, 30000);
