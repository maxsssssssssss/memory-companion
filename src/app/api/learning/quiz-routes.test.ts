// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
const { auth, generate, configure, deferred } = vi.hoisted(() => ({ auth: vi.fn(), generate: vi.fn(), configure: vi.fn(), deferred:[] as Array<()=>Promise<void>> }));
vi.mock("next/server",async original=>({...await original<typeof import("next/server")>(),after:(work:()=>Promise<void>)=>deferred.push(work)}));
vi.mock("@/lib/server/auth/request-context", async original => ({ ...await original<typeof import("@/lib/server/auth/request-context")>(), requireAuthContext: auth }));
vi.mock("@/lib/server/learning/framework-generator", async original => ({ ...await original<typeof import("@/lib/server/learning/framework-generator")>(), generateStudyJson: generate, learningGenerationConfig: configure }));
import { LearningRepository } from "@/lib/server/learning/repository";
import { GET, POST, PATCH, DELETE } from "./pages/[pageId]/quiz/route";
let root: string, pageId: string, materialId: string;
const ctx = () => ({ params: Promise.resolve({ pageId }) });
const req = (method = "GET", body?: unknown, user = "owner", suffix = "", origin = "http://localhost") => new Request(`http://localhost/api/learning/pages/${pageId}/quiz${suffix}`, { method, headers: { origin, "x-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const gen = () => ({ id: randomUUID(), settings: { materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 2, difficulty: "standard" } });
const model = () => {
  // The production path now requests request-bound compact references. Keep the
  // API fixture on that contract instead of returning obsolete legacy sources.
  const wire = generate.mock.calls.at(-1)![3];
  const refs = wire.materials[0].paragraphs.map((p: { referenceId: string }) => p.referenceId);
  return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope, title: "[模拟]", reason: null,
    materialPlan: [{ material: 1, contribution: "[模拟] 规则与前提", references: refs }],
    items: [0,1].map(i => ({ focus: `[模拟] 考点${i}`, scenario: null, stem: `[模拟] ${i}题`, kind: "concept", stemEvidenceIds: refs,
      options: [{ id: "A", text: "第一项", reasonParts: [{ text: "SECRET_CORRECT", evidenceIds: refs }] }, { id: "B", text: "第二项", reasonParts: [{ text: "SECRET_WRONG", evidenceIds: refs }] }],
      correctOptionId: "A", explanationParts: [{ text: "SECRET_EXPLANATION", evidenceIds: refs }], hint: "模拟提示" })) };
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-quiz-api-")); pageId = randomUUID(); materialId = randomUUID(); const repo = new LearningRepository(join(root, "owner"), "owner");
  repo.create({ id: pageId, title: "[合成]" }); repo.saveMaterials(pageId, [{ id: materialId, title: "[合成]", kind: "txt", filename: "synthetic.txt", bytes: Buffer.from("[合成测试] 规则及其前提。") }]); repo.close();
  auth.mockImplementation(async (r: Request) => { const id = r.headers.get("x-user"); if (!id) throw Error("unauthenticated"); return { user: { id }, dataRootDir: join(root, id) }; });
  configure.mockReturnValue({ baseURL: "https://synthetic.invalid", apiKey: "SYNTHETIC", model: "mock", maxInputChars: 24000, maxOutputTokens: 6000 }); generate.mockImplementation(async () => model());
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(async () => { for(const work of deferred.splice(0))await work(); vi.clearAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
it("acknowledges background generation before completion, polls safely and does not duplicate the active call",async()=>{
  let finish!:(value:unknown)=>void;generate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const g=gen(),r=req("POST",g);r.headers.set("prefer","respond-async");
  const response=await POST(r,ctx());expect(response.status).toBe(200);
  const pending=await response.json();expect(pending.quizzes[0].status).toBe("generating");expect(JSON.stringify(pending)).not.toContain("correctOptionId");
  const duplicate=req("POST",g);duplicate.headers.set("prefer","respond-async");await POST(duplicate,ctx());expect(generate).toHaveBeenCalledTimes(1);
  expect((await (await GET(req(),ctx())).json()).quizzes[0].progress).toMatchObject({completed:0,total:1});
  finish(model());for(const work of deferred.splice(0))await work();
  const saved=await (await GET(req(),ctx())).json();expect(saved.quizzes[0]).toMatchObject({status:"completed",count:2});expect(JSON.stringify(saved)).not.toContain("SECRET");
});
it("authenticates every path and rejects cross-origin mutations without calls", async () => {
  for (const user of ["", "other"]) { const status = user ? 404 : 401;
    expect((await GET(req("GET", undefined, user), ctx())).status).toBe(status);
    expect((await POST(req("POST", gen(), user), ctx())).status).toBe(status);
    expect((await PATCH(req("PATCH", { kind: "start", value: { id: randomUUID(), quizId: randomUUID(), mode: "test" } }, user), ctx())).status).toBe(status);
    expect((await DELETE(req("DELETE", { id: randomUUID() }, user), ctx())).status).toBe(status);
    expect((await GET(req("GET", undefined, user, `?attempt=${randomUUID()}&question=0&source=0`), ctx())).status).toBe(status);
  }
  expect((await POST(req("POST", gen(), "owner", "", "https://foreign.invalid"), ctx())).status).toBe(403); expect(generate).not.toHaveBeenCalled();
  expect((await DELETE(req("DELETE", { id: randomUUID() }, "owner", "", "https://foreign.invalid"), ctx())).status).toBe(403);
});
it("deletes a group and its progress through the authenticated API, preserving other groups and materials", async () => {
  const g = gen(), other = gen(); await POST(req("POST", g), ctx()); await POST(req("POST", other), ctx());
  const attempt = (await (await PATCH(req("PATCH", { kind: "start", value: { id: randomUUID(), quizId: g.id, mode: "practice" } }), ctx())).json()).attempt;
  expect((await DELETE(req("DELETE", { id: "invalid" }), ctx())).status).toBe(400);
  expect((await DELETE(req("DELETE", { id: g.id, extra: true }), ctx())).status).toBe(400);
  const deleted = await DELETE(req("DELETE", { id: g.id }), ctx());
  expect(deleted.status).toBe(200); expect(deleted.headers.get("cache-control")).toContain("no-store");
  expect((await deleted.json()).quizzes.map((q: { id: string }) => q.id)).toEqual([other.id]);
  expect((await DELETE(req("DELETE", { id: g.id }), ctx())).status).toBe(200);
  expect((await GET(req("GET", undefined, "owner", `?attempt=${attempt.id}`), ctx())).status).toBe(404);
  expect((await PATCH(req("PATCH", { kind: "act", value: { id: randomUUID(), attemptId: attempt.id, revision: 0, action: "hint", question: 0, optionId: null } }), ctx())).status).toBe(404);
  expect((await POST(req("POST", g), ctx())).status).toBe(410);
  expect(generate).toHaveBeenCalledTimes(2);
  const repo = new LearningRepository(join(root, "owner"), "owner");
  try { expect(repo.source(pageId, materialId).paragraphs).toHaveLength(1); } finally { repo.close(); }
});
it("deleting a pending group fences its late API response without stopping another group", async () => {
  let done!: (value: unknown) => void; generate.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  const g = gen(), pending = POST(req("POST", g), ctx()); await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  const lateResponse = model();
  expect((await DELETE(req("DELETE", { id: g.id }), ctx())).status).toBe(200);
  const other = gen(); expect((await POST(req("POST", other), ctx())).status).toBe(200);
  done(lateResponse);
  expect((await pending).status).toBe(200);
  const result = await (await GET(req(), ctx())).json(); expect(result.quizzes.map((q: { id: string }) => q.id)).toEqual([other.id]);
  expect((await POST(req("POST", g), ctx())).status).toBe(410); expect(generate).toHaveBeenCalledTimes(2);
});
it("uses actual API save/reopen, reveals server-side only and consumes zero calls while answering", async () => {
  const g = gen(); const published = await POST(req("POST", g), ctx()); expect(published.status).toBe(200); expect(published.headers.get("cache-control")).toContain("no-store"); expect(JSON.stringify(await published.json())).not.toContain("SECRET");
  await POST(req("POST", g), ctx()); expect(generate).toHaveBeenCalledTimes(1);
  let a = (await (await PATCH(req("PATCH", { kind: "start", value: { id: randomUUID(), quizId: g.id, mode: "test" } }), ctx())).json()).attempt;
  async function act(action: string, question = 0, optionId: string | null = null) { const response = await PATCH(req("PATCH", { kind: "act", value: { id: randomUUID(), attemptId: a.id, revision: a.revision, action, question, optionId } }), ctx()); expect(response.status).toBe(200); a = (await response.json()).attempt; }
  await act("choose", 0, "A"); await act("submit"); expect(JSON.stringify(a)).not.toContain("SECRET"); expect(a.questions[0]).not.toHaveProperty("feedback");
  expect((await GET(req("GET", undefined, "owner", `?attempt=${a.id}&question=0&source=0`), ctx())).status).toBe(403);
  expect((await (await GET(req("GET", undefined, "owner", `?attempt=${a.id}`), ctx())).json()).attempt).toEqual(a);
  await act("finish"); expect(a.score.correct).toBe(1); expect(a.questions[0].feedback.explanation).toBe("SECRET_EXPLANATION");
  expect((await GET(req("GET", undefined, "owner", `?attempt=${a.id}&question=0&source=0`), ctx())).status).toBe(200); expect(generate).toHaveBeenCalledTimes(1);
});
it("delete during a real API pending mock fences the late result and retains no question rows", async () => {
  let done!: (v: unknown) => void; generate.mockImplementationOnce(() => new Promise(r => { done = r; }));
  const pending = POST(req("POST", gen()), ctx()); await vi.waitFor(() => expect(generate).toHaveBeenCalled());
  const repo = new LearningRepository(join(root, "owner"), "owner"); repo.deletePage(pageId); repo.close(); done(model());
  expect((await pending).status).toBe(410); expect((await GET(req(), ctx())).status).toBe(410);
});
