// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/domain/agent";

const { auth, decisionConfig, generationConfig, advance, deferred } = vi.hoisted(() => ({
  auth: vi.fn(), decisionConfig: vi.fn(), generationConfig: vi.fn(), advance: vi.fn(),
  deferred: [] as Array<() => Promise<void>>,
}));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(),
  after: (work: () => Promise<void>) => deferred.push(work) }));
vi.mock("@/lib/server/auth/request-context", async original => ({
  ...await original<typeof import("@/lib/server/auth/request-context")>(), requireAuthContext: auth,
}));
vi.mock("@/lib/server/learning/agent-decision-config", async original => ({
  ...await original<typeof import("@/lib/server/learning/agent-decision-config")>(), agentModelConfig: decisionConfig,
}));
vi.mock("@/lib/server/learning/agent-scenario", async original => ({
  ...await original<typeof import("@/lib/server/learning/agent-scenario")>(), learningAgentGenerationConfig: generationConfig,
}));
vi.mock("@/lib/server/learning/agent-api-service", async original => ({
  ...await original<typeof import("@/lib/server/learning/agent-api-service")>(), advanceLearningAgent: advance,
}));

import { AgentStore } from "@/lib/server/agent/store";
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningQuizRepository } from "@/lib/server/learning/quiz-repository";
import { LearningAgentRepository } from "@/lib/server/learning/agent-repository";
import { freezeLearningAgentScope } from "@/lib/server/learning/agent-scope";
import { GET, POST, PATCH } from "./pages/[pageId]/agent/route";

let root: string, pageId: string, materialId: string;
const origin = "http://localhost";
const context = (page = pageId) => ({ params: Promise.resolve({ pageId: page }) });
const selection = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [],
  includeHistory: false, includeNotes: false, includeSupplements: false });
const start = () => ({ id: randomUUID(), goal: "[合成] 理解适用前提", scope: selection() });
function request(method = "GET", body?: unknown, user = "owner", page = pageId) {
  return new Request(`${origin}/api/learning/pages/${page}/agent`, { method,
    headers: { origin, "x-synthetic-user": user, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function stores<T>(work: (learning: LearningRepository, store: AgentStore) => T): T {
  const learning = new LearningRepository(join(root, "owner"), "owner");
  const store = AgentStore.open(join(root, "owner", "agent-tasks.sqlite"));
  try { return work(learning, store); } finally { store.close(); learning.close(); }
}
function seedTask() {
  return stores((learning, store) => store.createTask({ accountId: "owner", scenario: "learning.adaptive-review.v1",
    resourceId: pageId, goal: "[合成] 复习前提", scope: freezeLearningAgentScope(learning, pageId, selection()) }));
}
function waitForFeedback(taskId: string, event?: AgentEvent, consumed = false) {
  stores((_learning, store) => {
    const lease = store.claim("owner", taskId)!;
    store.setState("owner", taskId, lease.token, "waiting", { wait: { kind: "feedback", message: "[合成] 还有哪里不明白？" } });
    if (event) { store.acceptEvent("owner", taskId, lease.token, event); if (consumed) store.consumeEvent(taskId, event.id); }
    store.release("owner", taskId, lease);
  });
}
function seedWaitingQuiz(taskId: string) {
  return stores((learning, store) => {
    const quiz = new LearningQuizRepository(learning), quizId = randomUUID(), attemptId = randomUUID();
    quiz.begin(pageId, { id: quizId, settings: { materialIds: [materialId], chapterIds: [], nodeIds: [],
      includeNotes: false, includeSupplements: false, count: 1, difficulty: "basic" } }, 24000);
    // Historical repository fixture: no mock model output is described as real generation.
    quiz.complete(pageId, quizId, { title: "[合成固定题] 适用前提", reason: null, items: [{
      stem: "[合成] 前提不成立时能否应用规则？", kind: "concept", correctOptionId: "A",
      options: [{ id: "A", text: "不能", reason: "SECRET_CORRECT_REASON" }, { id: "B", text: "能", reason: "SECRET_WRONG_REASON" }],
      explanation: "SECRET_QUIZ_EXPLANATION", hint: null, sources: [{ kind: "material", materialId, paragraph: 1 }],
    }] });
    quiz.startAttempt(pageId, { id: attemptId, quizId, mode: "test" });
    const task = store.getTask("owner", taskId), scope = freezeLearningAgentScope(learning, pageId, selection());
    const lease = store.claim("owner", taskId)!;
    const actionId = store.prepareAction("owner", taskId, lease.token, { step: store.step("owner", taskId, lease.token),
      tool: "learning.create_quiz", args: { count: 1, difficulty: "basic" }, reason: "[合成] 诊断当前理解" });
    const artifacts = new LearningAgentRepository(learning);
    artifacts.reserve({ id: quizId, taskId, pageId, kind: "quiz", actionId, binding: scope.fingerprint, materialIds: [materialId] });
    artifacts.complete(pageId, taskId, quizId, { attemptId });
    const wait = { kind: "quiz_submission", refId: attemptId, message: "[合成] 请提交作答" };
    store.markAction("owner", taskId, lease.token, actionId, "succeeded", { ref: { kind: "learning.quiz", id: quizId }, summary: "已保存题组。", wait });
    store.setState("owner", task.id, lease.token, "waiting", { wait }); store.release("owner", taskId, lease);
    return { quizId, attemptId };
  });
}

beforeEach(async () => {
  vi.clearAllMocks(); deferred.length = 0;
  root = await mkdtemp(join(tmpdir(), "learning-agent-api-synthetic-")); pageId = randomUUID(); materialId = randomUUID();
  const learning = new LearningRepository(join(root, "owner"), "owner");
  try {
    learning.create({ id: pageId, title: "[合成] Agent API 课程" });
    learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 适用前提", kind: "text", filename: null,
      bytes: Buffer.from("[合成] 只有满足前提才可以应用规则。\n\n[合成] 未满足前提不同于应用后未通过。") }]);
  } finally { learning.close(); }
  auth.mockImplementation(async (req: Request) => {
    const id = req.headers.get("x-synthetic-user"); if (!id) throw Error("unauthenticated");
    return { user: { id }, dataRootDir: join(root, id) };
  });
  const config = { baseURL: "https://synthetic.invalid", apiKey: "SYNTHETIC_NOT_A_CREDENTIAL", model: "mock",
    maxInputChars: 24000, maxOutputTokens: 1000, requestTimeoutMs: 1000 };
  decisionConfig.mockReturnValue(config); generationConfig.mockReturnValue(config);
  advance.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("All Provider/network calls forbidden in Agent route tests"); }));
});
afterEach(async () => {
  // Deliberately do not run after() callbacks: only API scheduling is under test.
  deferred.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("authenticated Learning Agent routes with real isolated SQLite state", () => {
  it("requires authentication for GET, POST and PATCH without scheduling work", async () => {
    const control = { id: randomUUID(), action: "cancel", eventId: randomUUID() };
    for (const response of await Promise.all([GET(request("GET", undefined, ""), context()),
      POST(request("POST", start(), ""), context()), PATCH(request("PATCH", control, ""), context())])) expect(response.status).toBe(401);
    expect(deferred).toHaveLength(0); expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-account and cross-page task access", async () => {
    const task = seedTask(), control = { id: task.id, action: "pause", eventId: randomUUID() };
    for (const response of await Promise.all([GET(request("GET", undefined, "other"), context()),
      POST(request("POST", start(), "other"), context()), PATCH(request("PATCH", control, "other"), context())])) expect(response.status).toBe(404);
    const otherPage = randomUUID(); stores(learning => learning.create({ id: otherPage, title: "[合成] 其他页" }));
    expect((await PATCH(request("PATCH", control, "owner", otherPage), context(otherPage))).status).toBe(404);
    const response = await GET(request("GET", undefined, "owner", otherPage), context(otherPage));
    expect(await response.json()).toEqual({ tasks: [] }); expect(deferred).toHaveLength(0);
  });

  it("rejects model/client-supplied ownership and cross-origin mutations", async () => {
    expect((await POST(request("POST", { ...start(), accountId: "other" }), context())).status).toBe(400);
    const foreign = request("POST", start()); foreign.headers.set("origin", "https://foreign.invalid");
    expect((await POST(foreign, context())).status).toBe(403);
    const crossSite = request("PATCH", { id: randomUUID(), action: "cancel", eventId: randomUUID() });
    crossSite.headers.set("sec-fetch-site", "cross-site"); expect((await PATCH(crossSite, context())).status).toBe(403);
    expect(deferred).toHaveLength(0); expect(decisionConfig).not.toHaveBeenCalled();
  });

  it("uses a stable task ID without creating duplicate tasks and rejects changed content", async () => {
    const body = start();
    const initial = await POST(request("POST", body), context());
    expect({ status: initial.status, body: await initial.json() }).toMatchObject({ status: 202 });
    expect((await POST(request("POST", body), context())).status).toBe(202);
    const tasks = stores((_learning, store) => store.listTasks("owner", pageId));
    expect(tasks).toHaveLength(1); expect(tasks[0].id).toBe(body.id); expect(tasks[0].accountId).toBe("owner");
    const changed = await POST(request("POST", { ...body, goal: "[合成] 改过的目标" }), context());
    expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: "agent_event_conflict" });
    expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("projects waiting Quiz metadata without unrevealed answers and polling never advances", async () => {
    const task = seedTask(), links = seedWaitingQuiz(task.id);
    for (let i = 0; i < 2; i++) {
      const response = await GET(request(), context()); expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
      const body = await response.json(), wire = JSON.stringify(body);
      expect(body.tasks[0]).toMatchObject({ status: "waiting", quizLinks: [links], wait: { kind: "quiz_submission", refId: links.attemptId } });
      expect(wire).not.toMatch(/SECRET_|correctOptionId|args_json|apiKey|paragraphSha256|accountId/);
    }
    expect(deferred).toHaveLength(0); expect(advance).not.toHaveBeenCalled(); expect(decisionConfig).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unsubmitted Quiz feedback event and schedules only after actual saved submission", async () => {
    const task = seedTask(), { attemptId } = seedWaitingQuiz(task.id);
    const body = { id: task.id, action: "feedback", eventId: randomUUID(), attemptId };
    expect((await PATCH(request("PATCH", body), context())).status).toBe(409); expect(deferred).toHaveLength(0);
    stores(learning => {
      const quiz = new LearningQuizRepository(learning), attempt = quiz.attempt(pageId, attemptId);
      quiz.act(pageId, { id: randomUUID(), attemptId, revision: attempt.revision, action: "finish", question: 0, optionId: null });
    });
    const response = await PATCH(request("PATCH", body), context()); expect(response.status).toBe(202);
    expect((await response.json()).scheduled).toBe(true); expect(deferred).toHaveLength(1);
    expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("deduplicates consumed feedback but rejects the same ID with altered content", async () => {
    const task = seedTask(), event = { id: randomUUID(), kind: "feedback", message: "[合成] 解释有帮助" };
    waitForFeedback(task.id, event, true);
    const body = { id: task.id, action: "feedback", eventId: event.id, feedback: event.message };
    const duplicate = await PATCH(request("PATCH", body), context()); expect(duplicate.status).toBe(202);
    expect((await duplicate.json()).scheduled).toBe(false); expect(deferred).toHaveLength(0);
    const altered = await PATCH(request("PATCH", { ...body, feedback: "[合成] 不同内容" }), context());
    expect(altered.status).toBe(409); expect(await altered.json()).toEqual({ error: "agent_event_conflict" });
    expect(stores((_learning, store) => store.getTask("owner", task.id).status)).toBe("waiting");
  });

  it("does not discard an accepted but unconsumed event when the caller retries", async () => {
    const task = seedTask(), event = { id: randomUUID(), kind: "feedback", message: "[合成] 请求继续解释" };
    waitForFeedback(task.id, event);
    const response = await PATCH(request("PATCH", { id: task.id, action: "feedback", eventId: event.id, feedback: event.message }), context());
    expect(response.status).toBe(202); expect((await response.json()).scheduled).toBe(true);
    expect(deferred).toHaveLength(1); expect(advance).not.toHaveBeenCalled();
  });

  it("pauses, reopens a wait and cancels through authenticated controls without scheduling", async () => {
    const task = seedTask(); waitForFeedback(task.id);
    for (const [action, status] of [["pause", "paused"], ["resume", "waiting"], ["cancel", "cancelled"]] as const) {
      const response = await PATCH(request("PATCH", { id: task.id, action, eventId: randomUUID() }), context());
      expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ task: { status }, scheduled: false });
    }
    expect(deferred).toHaveLength(0); expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("hides saved explanations after source deletion instead of serving old evidence", async () => {
    const task = seedTask(), explanationId = randomUUID(); waitForFeedback(task.id);
    stores((learning) => {
      const artifacts = new LearningAgentRepository(learning), scope = freezeLearningAgentScope(learning, pageId, selection());
      artifacts.reserve({ id: explanationId, taskId: task.id, pageId, kind: "explanation", actionId: `${task.id}:explanation`,
        binding: scope.fingerprint, materialIds: [materialId] });
      artifacts.complete(pageId, task.id, explanationId, { id: explanationId, taskId: task.id, question: "[合成] 解释前提",
        materialAnswer: "SAVED_SYNTHETIC_EXPLANATION", supplements: [], items: [{ materialId, paragraph: 1 }] });
    });
    expect(JSON.stringify(await (await GET(request(), context())).json())).toContain("SAVED_SYNTHETIC_EXPLANATION");
    stores(learning => learning.deleteMaterial(pageId, materialId));
    const body = await (await GET(request(), context())).json();
    expect(body.tasks[0]).toMatchObject({ status: "needs_attention", wait: null, explanations: [], quizLinks: [] });
    expect(JSON.stringify(body)).not.toContain("SAVED_SYNTHETIC_EXPLANATION");
    expect(deferred).toHaveLength(0); expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
