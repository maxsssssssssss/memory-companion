// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/domain/agent";
import type { LearningAgentSelection } from "@/lib/domain/learning-agent";

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
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { AgentFailure, type AgentDecision, type AgentDecisionProvider } from "@/lib/server/agent/types";
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningFrameworkRepository } from "@/lib/server/learning/framework-repository";
import { LearningQuizRepository } from "@/lib/server/learning/quiz-repository";
import { LearningAgentRepository } from "@/lib/server/learning/agent-repository";
import { freezeLearningAgentScope } from "@/lib/server/learning/agent-scope";
import { createLearningAgentScenario } from "@/lib/server/learning/agent-scenario";
import type { generateStudyJson } from "@/lib/server/learning/framework-generator";
import { GET, POST, PATCH } from "./pages/[pageId]/agent/route";
import { PATCH as quizPatch } from "./pages/[pageId]/quiz/route";

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
function seedTask(scope: LearningAgentSelection = selection()) {
  return stores((learning, store) => store.createTask({ accountId: "owner", scenario: "learning.adaptive-review.v1",
    resourceId: pageId, goal: "[合成] 复习前提", scope: freezeLearningAgentScope(learning, pageId, scope) }));
}
async function runOffline(taskId: string, decision: AgentDecisionProvider, generate?: typeof generateStudyJson) {
  const learning = new LearningRepository(join(root, "owner"), "owner");
  const store = AgentStore.open(join(root, "owner", "agent-tasks.sqlite"));
  const runtime = new AgentRuntime({ store, checkpointPath: join(root, "owner", "agent-checkpoints.sqlite"),
    scenario: createLearningAgentScenario(learning, { configure: generationConfig,
      generate: generate ?? (async () => { throw Error("Unexpected generation in offline route test"); }) }), decision });
  try { return await runtime.advance("owner", taskId); }
  finally { runtime.close(); store.close(); learning.close(); }
}
function seedFramework() {
  return stores(learning => {
    const framework = new LearningFrameworkRepository(learning), id = randomUUID();
    framework.begin(pageId, { id, materialIds: [materialId] }, 24000); framework.validating(pageId, id);
    framework.complete(pageId, id, { overview: "[合成固定框架] 前提", chapters: [{ title: "[合成] 条件", explanation: "[合成] 规则适用条件", nodes: [
      { title: "[合成] 前提", explanation: "[合成] 先核对前提", supplement: null, sources: [{ materialId, paragraph: 1 }] }
    ] }] });
    return framework.view(pageId).chapters.find(chapter => chapter.runId === id)!;
  });
}
async function pendingNoteApproval() {
  const chapter = seedFramework(), task = seedTask();
  const generate = vi.fn(async () => ({ materialAnswer: "[离线生成fixture] 先核对前提才能应用规则。", supplements: [],
    items: [{ materialId, paragraph: 1 }] })) as unknown as typeof generateStudyJson;
  const decision = vi.fn<AgentDecisionProvider>(async (input, ctx) => ctx.call({ kind: "offline_decision_fixture", inputChars: 100, maxOutputTokens: 100 }, async () => {
    const explanation = input.task.actions.find(action => action.tool === "learning.explain")?.resultRef;
    return { value: explanation
      ? { tool: "learning.append_note", args: { explanationId: explanation.id, chapterId: chapter.id, nodeId: chapter.nodes[0].id } }
      : { tool: "learning.explain", args: { question: "[合成] 为什么要先核对前提？", sources: [{ materialId, paragraph: 1 }] } },
      usage: { inputTokens: 10, outputTokens: 5 } };
  }));
  const waiting = await runOffline(task.id, decision, generate);
  expect(waiting.status, JSON.stringify({ reason: waiting.endReason, actions: waiting.actions, recovery: waiting.recovery })).toBe("waiting");
  expect(waiting.approval?.status).toBe("pending");
  expect(stores(learning => new LearningFrameworkRepository(learning).view(pageId).chapters[0].nodes[0].note)).toBeFalsy();
  return { task: waiting, approval: waiting.approval!, chapter, decision, generate };
}
function waitForFeedback(taskId: string, event?: AgentEvent, consumed = false) {
  stores((_learning, store) => {
    const lease = store.claim("owner", taskId)!;
    store.setState("owner", taskId, lease.token, "waiting", { wait: { kind: "feedback", message: "[合成] 还有哪里不明白？" } });
    if (event) { store.acceptEvent("owner", taskId, lease.token, event); if (consumed) store.consumeEvent("owner", taskId, lease.token, event.id); }
    store.release("owner", taskId, lease);
  });
}
function seedWaitingQuiz(taskId: string, mode: "practice" | "test" = "test") {
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
    quiz.startAttempt(pageId, { id: attemptId, quizId, mode });
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
  // Default after() callbacks never run. Selected cases advance the real runtime
  // explicitly through runOffline with a fixture decision and generation only.
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

describe("versioned Learning Agent controls with offline decisions and real business services", () => {
  it("uses version CAS for competing adjustments and rejects controls missing the new version", async () => {
    const task = seedTask(); waitForFeedback(task.id);
    const body = { id: task.id, action: "adjust", expectedVersion: 1, scope: selection() };
    const responses = await Promise.all(["[合成] 新目标甲", "[合成] 新目标乙"].map(goal =>
      PATCH(request("PATCH", { ...body, goal, eventId: randomUUID() }), context())));
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    const updated = stores((_learning, store) => store.getTask("owner", task.id));
    expect(updated.version).toBe(2); expect(["[合成] 新目标甲", "[合成] 新目标乙"]).toContain(updated.goal);
    const before = deferred.length;
    for (const expectedVersion of [undefined, 1]) {
      const response = await PATCH(request("PATCH", { id: task.id, action: "pause", eventId: randomUUID(), expectedVersion }), context());
      expect(response.status).toBe(409);
    }
    expect(deferred).toHaveLength(before); expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an adjustment that imports another page's source even for the same account", async () => {
    const task = seedTask(), foreignPage = randomUUID(), foreignMaterial = randomUUID(); waitForFeedback(task.id);
    stores(learning => { learning.create({ id: foreignPage, title: "[合成] 未授权页面" });
      learning.saveMaterials(foreignPage, [{ id: foreignMaterial, title: "[合成] 页面外材料", kind: "text", filename: null, bytes: Buffer.from("OUTSIDE_CURRENT_PAGE") }]); });
    const response = await PATCH(request("PATCH", { id: task.id, action: "adjust", expectedVersion: 1, eventId: randomUUID(),
      goal: task.goal, scope: { ...selection(), materialIds: [foreignMaterial] } }), context());
    expect([403, 404]).toContain(response.status);
    expect(stores((_learning, store) => store.getTask("owner", task.id))).toMatchObject({ version: 1, goal: task.goal, status: "waiting" });
    expect(deferred).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes old artifacts and feedback after changing consent and keeps historical business results saved", async () => {
    const task = seedTask({ ...selection(), includeHistory: true, includeNotes: true, includeSupplements: true });
    const links = seedWaitingQuiz(task.id), explanationId = randomUUID();
    stores((learning) => { const artifacts = new LearningAgentRepository(learning);
      artifacts.reserve({ id: explanationId, taskId: task.id, taskVersion: 1, pageId, kind: "explanation", actionId: `${task.id}:explanation`,
        binding: freezeLearningAgentScope(learning, pageId, selection()).fingerprint, materialIds: [materialId] });
      artifacts.complete(pageId, task.id, explanationId, { id: explanationId, taskId: task.id, taskVersion: 1, question: "[合成] 原问题",
        materialAnswer: "REVOKED_EXPLANATION", supplements: [], items: [{ materialId, paragraph: 1 }] }); });
    expect(JSON.stringify(await (await GET(request(), context())).json())).toContain("REVOKED_EXPLANATION");
    const response = await PATCH(request("PATCH", { id: task.id, action: "adjust", expectedVersion: 1, eventId: randomUUID(),
      goal: "[合成] 仅依据本次材料", scope: selection() }), context());
    expect(response.status).toBe(202);
    const view = (await (await GET(request(), context())).json()).tasks[0];
    expect(view).toMatchObject({ version: 2, explanations: [], quizLinks: [], scope: selection() });
    expect(JSON.stringify(view)).not.toMatch(/REVOKED_EXPLANATION|SECRET_|correctOptionId/);
    const scheduled = deferred.length;
    for (const expectedVersion of [1, 2]) {
      const stale = await PATCH(request("PATCH", { id: task.id, action: "feedback", expectedVersion,
        attemptId: links.attemptId, eventId: randomUUID() }), context());
      expect(stale.status).toBe(409);
    }
    expect(deferred).toHaveLength(scheduled);
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId).some(quiz => quiz.id === links.quizId))).toBe(true);
    expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves accumulated budgets across pause, resume, adjustment and explicit end", async () => {
    const task = seedTask();
    const waiting = await runOffline(task.id, async (_input, ctx) => ctx.call({ kind: "offline_decision_fixture", inputChars: 200, maxOutputTokens: 100 }, async () => ({
      value: { tool: "learning.request_feedback", args: { question: "[合成] 请补充目标" } }, usage: { inputTokens: 21, outputTokens: 9 }
    })));
    expect(waiting.status).toBe("waiting"); expect(waiting.usage.calls).toBe(1);
    for (const action of ["pause", "resume"] as const) {
      const response = await PATCH(request("PATCH", { id: task.id, action, expectedVersion: 1, eventId: randomUUID() }), context());
      expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ task: { usage: waiting.usage, budget: waiting.budget }, scheduled: false });
    }
    const adjusted = await PATCH(request("PATCH", { id: task.id, action: "adjust", expectedVersion: 1, eventId: randomUUID(), goal: "[合成] 只核对材料", scope: selection() }), context());
    expect(adjusted.status).toBe(202); expect(await adjusted.json()).toMatchObject({ task: { version: 2, usage: waiting.usage, budget: waiting.budget } });
    const ended = await PATCH(request("PATCH", { id: task.id, action: "end", expectedVersion: 2, eventId: randomUUID() }), context());
    expect(ended.status).toBe(202); expect(await ended.json()).toMatchObject({ task: { status: "ended", version: 2, usage: waiting.usage, budget: waiting.budget }, scheduled: false });
    expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("inspects an unknown decision outcome without model calls or automatic retries", async () => {
    const task = seedTask();
    const decision = vi.fn<AgentDecisionProvider>(async (_input, ctx) => ctx.call({ kind: "offline_transport_failure_fixture", inputChars: 100, maxOutputTokens: 100 }, async () => {
      throw new AgentFailure("unknown", "[合成] 响应丢失");
    }));
    const stopped = await runOffline(task.id, decision);
    expect(stopped.status).toBe("needs_attention"); expect(stopped.usage.calls).toBe(1);
    const inspected = await PATCH(request("PATCH", { id: task.id, action: "recover", expectedVersion: 1, mode: "inspect", eventId: randomUUID() }), context());
    expect(inspected.status).toBe(202);
    const inspectedBody = await inspected.json();
    expect(inspectedBody).toMatchObject({ task: { status: "needs_attention", recovery: { kind: "unknown" }, usage: {
      calls: stopped.usage.calls, inputTokens: null, outputTokens: null, unknownUsageCalls: 1, steps: stopped.usage.steps
    } }, scheduled: false });
    expect(inspectedBody.task.usage.computeMs).toBeGreaterThanOrEqual(stopped.usage.computeMs);
    const retried = await PATCH(request("PATCH", { id: task.id, action: "recover", expectedVersion: 1, mode: "retry", eventId: randomUUID() }), context());
    expect(retried.status).toBe(409);
    expect(decision).toHaveBeenCalledOnce(); expect(deferred).toHaveLength(0); expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an exact approval and appends the saved proposal once without new generation", async () => {
    const h = await pendingNoteApproval(), body = { id: h.task.id, action: "approval", expectedVersion: 1, approvalId: h.approval.id,
      fingerprint: h.approval.fingerprint, decision: "approve", eventId: randomUUID() };
    const before = (await (await GET(request(), context())).json()).tasks[0];
    expect(before.approval).toMatchObject({ id: h.approval.id, status: "pending" });
    const previewContent = before.approval.content;
    expect(previewContent).toContain("[离线生成fixture] 先核对前提才能应用规则。");
    expect(h.approval.content).toBe(""); // Shared storage keeps the hash, not another copy of private text.
    expect(JSON.stringify(before.approval)).not.toMatch(/apiKey|args_json|paragraphSha256/);
    const changed = await PATCH(request("PATCH", { ...body, fingerprint: "changed-fingerprint" }), context());
    expect(changed.status).toBe(409); expect(deferred).toHaveLength(0);
    const accepted = await PATCH(request("PATCH", body), context());
    expect(accepted.status).toBe(202); expect((await accepted.json()).scheduled).toBe(true);
    expect(deferred).toHaveLength(1); expect(advance).not.toHaveBeenCalled();
    // Execute the queued work with an explicit offline decision fixture. Approval
    // must commit the prepared business proposal without another model decision.
    const forbiddenDecision = vi.fn<AgentDecisionProvider>(async () => { throw Error("Approval must not regenerate the approved content"); });
    const ended = await runOffline(h.task.id, forbiddenDecision);
    expect(ended.status).toBe("ended"); expect(forbiddenDecision).not.toHaveBeenCalled();
    const note = stores(learning => new LearningFrameworkRepository(learning).view(pageId).chapters[0].nodes[0].note);
    expect(note).toBe(previewContent);
    const scheduled = deferred.length;
    const replay = await PATCH(request("PATCH", { ...body, eventId: randomUUID() }), context());
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ task: { status: "ended", version: ended.version, budget: ended.budget, usage: ended.usage }, scheduled: false });
    for (const altered of [{ fingerprint: "changed-fingerprint" }, { decision: "reject" }]) {
      const conflict = await PATCH(request("PATCH", { ...body, ...altered, eventId: randomUUID() }), context());
      expect(conflict.status).toBe(409);
    }
    expect(deferred).toHaveLength(scheduled);
    expect(stores(learning => new LearningFrameworkRepository(learning).view(pageId).chapters[0].nodes[0].note)).toBe(note);
    expect(h.decision).toHaveBeenCalledTimes(2); expect(h.generate).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a bad note address recoverable and approves one real append after navigation and reopen", async () => {
    const chapter = seedFramework(), body = start();
    expect((await POST(request("POST", body), context())).status).toBe(202);
    const originalScope = stores((_learning, store) => store.getTask("owner", body.id).scope);
    const generate = vi.fn(async () => ({ materialAnswer: "[离线生成fixture] 先核对前提，再应用材料中的规则。", supplements: [],
      items: [{ materialId, paragraph: 1 }] })) as unknown as typeof generateStudyJson;
    // Only decisions/generation are fixtures. The bad address is the same
    // relationship as the Windows reproduction: material ID used as both IDs.
    const initialDecision = vi.fn<AgentDecisionProvider>(async (input, ctx) => ctx.call<AgentDecision>({ kind: "offline_decision_fixture", inputChars: 100, maxOutputTokens: 100 }, async () => {
      const explanation = input.task.actions.find(action => action.tool === "learning.explain")?.resultRef;
      const failed = input.results.find(result => result.tool === "learning.append_note" && result.status === "failed");
      if (failed) {
        expect(failed.value).toMatchObject({ status: "failed", summary: expect.stringContaining("agent_note_target_invalid") });
        expect(JSON.stringify(failed.value)).toContain("learning.read_navigation");
        return { value: { wait: { kind: "feedback", message: "[离线决策fixture] 目标地址无效，请确认是否从授权导航重选。" } }, usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return { value: explanation
        ? { tool: "learning.append_note", args: { explanationId: explanation.id, chapterId: materialId, nodeId: materialId } }
        : { tool: "learning.explain", args: { question: "[合成] 为什么要先核对前提？", sources: [{ materialId, paragraph: 1 }] } },
        usage: { inputTokens: 10, outputTokens: 5 } };
    }));
    const waiting = await runOffline(body.id, initialDecision, generate);
    expect(waiting.status).toBe("waiting"); expect(waiting.wait?.kind).toBe("feedback");
    expect(waiting.recovery).toBeUndefined(); expect(waiting.approval).toBeUndefined();
    expect(waiting.usage.calls).toBe(4); expect(initialDecision).toHaveBeenCalledTimes(3); expect(generate).toHaveBeenCalledOnce();
    const failedAction = waiting.actions.find(action => action.tool === "learning.append_note")!;
    expect(failedAction).toMatchObject({ status: "failed", resultRef: undefined });
    stores((learning, store) => {
      expect(store.getTask("owner", body.id).scope).toEqual(originalScope);
      expect(new LearningAgentRepository(learning).list(pageId, body.id).map(artifact => artifact.kind)).toEqual(["explanation"]);
      expect(new LearningFrameworkRepository(learning).view(pageId).chapters[0].nodes[0].note).toBe("");
    });
    const projection = (await (await GET(request(), context())).json()).tasks[0];
    expect(projection).toMatchObject({ status: "waiting", version: 1, scope: selection(), usage: waiting.usage });
    expect(projection.approval).toBeUndefined(); expect(projection.recovery).toBeUndefined();
    expect(JSON.stringify(projection)).not.toMatch(/source_invalid|授权来源无效|apiKey|args_json|paragraphSha256/);

    // runOffline closes all three stores. Reopening an unfulfilled wait must not
    // ask the model again; a real authenticated feedback event authorizes resume.
    const noDecision = vi.fn<AgentDecisionProvider>(async () => { throw Error("A persisted wait or approval must not call the model"); });
    const reopened = await runOffline(body.id, noDecision);
    expect(reopened.usage).toEqual(waiting.usage); expect(noDecision).not.toHaveBeenCalled();
    const feedback = { id: body.id, action: "feedback", expectedVersion: 1, eventId: randomUUID(), feedback: "[合成用户] 请读取当前授权导航后选择正确节点，先给我预览。" };
    expect((await PATCH(request("PATCH", feedback), context())).status).toBe(202);
    const recoveredDecision = vi.fn<AgentDecisionProvider>(async (input, ctx) => ctx.call<AgentDecision>({ kind: "offline_decision_fixture", inputChars: 100, maxOutputTokens: 100 }, async () => {
      const navigation = input.results.find(result => result.tool === "learning.read_navigation" && result.status === "succeeded");
      if (!navigation) return { value: { tool: "learning.read_navigation", args: {} }, usage: { inputTokens: 10, outputTokens: 5 } };
      const actual = navigation.value as { chapters: Array<{ id: string; nodes: Array<{ id: string }> }> };
      expect(actual.chapters[0]).toMatchObject({ id: chapter.id, nodes: [{ id: chapter.nodes[0].id }] });
      const explanation = input.task.actions.find(action => action.tool === "learning.explain")!.resultRef!;
      return { value: { tool: "learning.append_note", args: { explanationId: explanation.id,
        chapterId: actual.chapters[0].id, nodeId: actual.chapters[0].nodes[0].id } }, usage: { inputTokens: 10, outputTokens: 5 } };
    }));
    const proposed = await runOffline(body.id, recoveredDecision);
    expect(proposed.status).toBe("waiting"); expect(proposed.approval?.status).toBe("pending");
    expect(proposed.version).toBe(1); expect(proposed.scope).toEqual(originalScope); expect(proposed.usage.calls).toBe(6);
    expect(recoveredDecision).toHaveBeenCalledTimes(2); expect(generate).toHaveBeenCalledOnce();
    expect(proposed.actions.filter(action => action.tool === "learning.append_note").map(action => action.status)).toEqual(["failed", "prepared"]);
    const preview = (await (await GET(request(), context())).json()).tasks[0].approval;
    expect(preview.content).toContain("[离线生成fixture] 先核对前提，再应用材料中的规则。");
    const approve = { id: body.id, action: "approval", expectedVersion: 1, approvalId: proposed.approval!.id,
      fingerprint: proposed.approval!.fingerprint, decision: "approve", eventId: randomUUID() };
    expect((await PATCH(request("PATCH", approve), context())).status).toBe(202);
    const ended = await runOffline(body.id, noDecision);
    expect(ended.status).toBe("ended"); expect(ended.usage.calls).toBe(6); expect(noDecision).not.toHaveBeenCalled();
    const note = stores(learning => new LearningFrameworkRepository(learning).view(pageId).chapters[0].nodes[0].note);
    expect(note).toBe(preview.content);
    const schedules = deferred.length;
    const repeated = await PATCH(request("PATCH", { ...approve, eventId: randomUUID() }), context());
    expect(repeated.status).toBe(202); expect(await repeated.json()).toMatchObject({ scheduled: false, task: { status: "ended", usage: ended.usage } });
    expect(deferred).toHaveLength(schedules);
    stores(learning => {
      expect(new LearningFrameworkRepository(learning).view(pageId).chapters[0].nodes[0].note).toBe(note);
      expect(new LearningAgentRepository(learning).list(pageId, body.id).filter(artifact => artifact.kind === "note_proposal")).toHaveLength(1);
    });
    expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects obsolete approvals after scope adjustment without writing notes", async () => {
    const h = await pendingNoteApproval();
    const adjusted = await PATCH(request("PATCH", { id: h.task.id, action: "adjust", expectedVersion: 1, eventId: randomUUID(), goal: "[合成] 暂不保存笔记", scope: selection() }), context());
    expect(adjusted.status).toBe(202);
    const view = (await (await GET(request(), context())).json()).tasks[0];
    expect(view.version).toBe(2); expect(view.approval).toBeUndefined(); expect(view.explanations).toEqual([]);
    const scheduled = deferred.length;
    for (const expectedVersion of [1, 2]) {
      const response = await PATCH(request("PATCH", { id: h.task.id, action: "approval", expectedVersion, eventId: randomUUID(),
        approvalId: h.approval.id, fingerprint: h.approval.fingerprint, decision: "approve" }), context());
      expect(response.status).toBe(409);
    }
    expect(deferred).toHaveLength(scheduled);
    expect(stores(learning => new LearningFrameworkRepository(learning).view(pageId).chapters[0].nodes[0].note)).toBeFalsy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a completed task terminal when its approved note target moves to another chapter", async () => {
    const h = await pendingNoteApproval();
    const approved = await PATCH(request("PATCH", { id: h.task.id, action: "approval", expectedVersion: 1, eventId: randomUUID(),
      approvalId: h.approval.id, fingerprint: h.approval.fingerprint, decision: "approve" }), context());
    expect(approved.status).toBe(202);
    const forbiddenDecision = vi.fn<AgentDecisionProvider>(async () => { throw Error("No new decision after approved note write"); });
    const ended = await runOffline(h.task.id, forbiddenDecision);
    expect(ended.status).toBe("ended");
    const destination = seedFramework();
    stores(learning => {
      const framework = new LearningFrameworkRepository(learning), chapters = framework.view(pageId).chapters;
      const from = chapters.find(chapter => chapter.id === h.chapter.id)!, to = chapters.find(chapter => chapter.id === destination.id)!;
      const moved = framework.edit(pageId, { kind: "move", chapterId: from.id, revision: from.revision, nodeId: h.chapter.nodes[0].id,
        targetChapterId: to.id, targetRevision: to.revision, position: 0 });
      expect(moved.chapters.find(chapter => chapter.id === to.id)!.nodes[0].note).toContain("[离线生成fixture]");
    });
    const scheduled = deferred.length, response = await GET(request(), context());
    expect(response.status).toBe(200);
    const view = (await response.json()).tasks[0];
    expect(view).toMatchObject({ status: "ended", endReason: ended.endReason, version: ended.version, wait: null });
    expect(view.approval).toBeUndefined(); expect(view.recovery).toBeUndefined();
    expect(stores((_learning, store) => store.getTask("owner", h.task.id).status)).toBe("ended");
    expect(deferred).toHaveLength(scheduled); expect(forbiddenDecision).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("persists approval rejection and never writes the proposed note", async () => {
    const h = await pendingNoteApproval();
    const response = await PATCH(request("PATCH", { id: h.task.id, action: "approval", expectedVersion: 1, eventId: randomUUID(),
      approvalId: h.approval.id, fingerprint: h.approval.fingerprint, decision: "reject" }), context());
    expect(response.status).toBe(202);
    const saved = stores((_learning, store) => store.getTask("owner", h.task.id));
    expect(saved.approval?.status).toBe("rejected");
    expect(stores(learning => new LearningFrameworkRepository(learning).view(pageId).chapters[0].nodes[0].note)).toBeFalsy();
    expect(advance).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});


async function saveQuizAction(attemptId: string, action: "choose" | "submit" | "finish", optionId: string | null = null) {
  const attempt = stores(learning => new LearningQuizRepository(learning).attempt(pageId, attemptId));
  return quizPatch(request("PATCH", { kind: "act", value: { id: randomUUID(), attemptId, revision: attempt.revision, action, question: 0, optionId } }), context());
}
const syncBody = (id: string, attemptId: string, expectedVersion = 1) => ({ id, action: "sync_quiz", expectedVersion, attemptId, eventId: randomUUID() });
const disputeBody = (id: string, attemptId: string, expectedVersion = 1) => ({ id, action: "dispute_quiz", expectedVersion, attemptId, eventId: randomUUID(), feedback: "[合成] 这道题的条件有疑问" });

it("automatically accepts only persisted whole-Quiz completion and deduplicates transport/event IDs", async () => {
  const task = seedTask(), links = seedWaitingQuiz(task.id);
  expect((await saveQuizAction(links.attemptId, "choose", "A")).status).toBe(200);
  expect(deferred).toHaveLength(0);
  expect(await (await PATCH(request("PATCH", syncBody(task.id, links.attemptId)), context())).json()).toMatchObject({ scheduled: false });
  const completed = await saveQuizAction(links.attemptId, "finish"); expect(completed.status).toBe(200);
  expect(await completed.json()).toMatchObject({ attempt: { completed: true } }); expect(deferred).toHaveLength(1);
  const accepted = stores((_learning, store) => store.pendingEvent("owner", task.id)); expect(accepted).toMatchObject({ kind: "quiz_submission", refId: links.attemptId, version: 1 });
  // Simulate the durable event transition, not a fabricated quiz score.
  stores((_learning, store) => { const lease = store.claim("owner", task.id)!; store.continueEvent("owner", task.id, lease.token, accepted!.id); store.setState("owner", task.id, lease.token, "waiting", { wait: { kind: "feedback", message: "[合成] 下一步" } }); store.release("owner", task.id, lease); });
  for (let i = 0; i < 3; i++) expect(await (await PATCH(request("PATCH", syncBody(task.id, links.attemptId)), context())).json()).toMatchObject({ scheduled: false });
  expect(deferred).toHaveLength(1);
  expect(stores((_learning, store) => store.database.prepare("SELECT count(*) AS n FROM agent_events WHERE task_id=?").get(task.id))).toEqual({ n: 1 });
  expect((await (await GET(request(), context())).json()).tasks[0].quizLinks[0]).toMatchObject({ ...links, completed: true, disputed: false });
  expect(fetch).not.toHaveBeenCalled();
});

it("recovers lost completion notification and a paused completed Quiz only on explicit sync or resume", async () => {
  const task = seedTask(), { attemptId } = seedWaitingQuiz(task.id);
  await PATCH(request("PATCH", { id: task.id, action: "pause", expectedVersion: 1, eventId: randomUUID() }), context());
  expect((await saveQuizAction(attemptId, "finish")).status).toBe(200); expect(deferred).toHaveLength(0);
  expect(await (await PATCH(request("PATCH", syncBody(task.id, attemptId)), context())).json()).toMatchObject({ task: { status: "paused" }, scheduled: false });
  const resumed = await PATCH(request("PATCH", { id: task.id, action: "resume", expectedVersion: 1, eventId: randomUUID() }), context());
  expect(await resumed.json()).toMatchObject({ scheduled: true }); expect(deferred).toHaveLength(1);
  // after() was not run: a restarted client can schedule the same saved receipt.
  deferred.length = 0;
  expect(await (await PATCH(request("PATCH", syncBody(task.id, attemptId)), context())).json()).toMatchObject({ scheduled: true });
  expect(stores((_learning, store) => store.database.prepare("SELECT count(*) AS n FROM agent_events WHERE task_id=?").get(task.id))).toEqual({ n: 1 });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["cancel", "adjust"] as const)("does not advance completed old Quiz after %s", async action => {
  const task = seedTask(), { attemptId } = seedWaitingQuiz(task.id);
  await PATCH(request("PATCH", action === "cancel" ? { id: task.id, action, expectedVersion: 1, eventId: randomUUID() }
    : { id: task.id, action, expectedVersion: 1, eventId: randomUUID(), goal: "[合成] 新目标", scope: selection() }), context());
  deferred.length = 0;
  expect((await saveQuizAction(attemptId, "finish")).status).toBe(200); expect(deferred).toHaveLength(0);
  const response = await PATCH(request("PATCH", syncBody(task.id, attemptId)), context()); expect(response.status).toBe(action === "adjust" ? 409 : 202);
  expect(deferred).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});

it("retains successful Quiz save if Agent notification fails and exposes source/account/version checks", async () => {
  const task = seedTask(), { attemptId } = seedWaitingQuiz(task.id);
  const original = AgentRuntime.prototype.submitEvent;
  vi.spyOn(AgentRuntime.prototype, "submitEvent").mockRejectedValueOnce(Error("synthetic notification interruption"));
  expect((await saveQuizAction(attemptId, "finish")).status).toBe(200); expect(deferred).toHaveLength(0);
  expect(stores(learning => new LearningQuizRepository(learning).attempt(pageId, attemptId).completed)).toBe(true);
  AgentRuntime.prototype.submitEvent = original;
  expect((await PATCH(request("PATCH", syncBody(task.id, attemptId), "other"), context())).status).toBe(404);
  expect((await PATCH(request("PATCH", syncBody(task.id, attemptId, 2)), context())).status).toBe(409);
  stores(learning => learning.deleteMaterial(pageId, materialId));
  expect((await PATCH(request("PATCH", syncBody(task.id, attemptId)), context())).status).toBeGreaterThanOrEqual(400);
  expect(deferred).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});

it("accepts dispute after automatic completion moved to another wait, pauses and invalidates old approvals", async () => {
  const task = seedTask(), links = seedWaitingQuiz(task.id);
  await saveQuizAction(links.attemptId, "finish"); deferred.length = 0;
  stores((_learning, store) => { const lease = store.claim("owner", task.id)!, event = store.pendingEvent("owner", task.id)!;
    store.continueEvent("owner", task.id, lease.token, event.id);
    const actionId = store.prepareAction("owner", task.id, lease.token, { step: store.step("owner", task.id, lease.token), tool: "learning.append_note", args: {} });
    store.saveApproval("owner", task.id, lease.token, { id: actionId, actionId, taskVersion: 1, tool: "learning.append_note", title: "[合成] 旧提案", summary: "", target: "", content: "[合成] 旧正文", fingerprint: "synthetic", sourceFingerprint: "synthetic", status: "pending", createdAt: "synthetic" });
    store.setState("owner", task.id, lease.token, "waiting", { wait: { kind: "confirmation", refId: actionId, message: "[合成] 笔记" } }); store.release("owner", task.id, lease);
  });
  const body = disputeBody(task.id, links.attemptId), response = await PATCH(request("PATCH", body), context());
  expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ scheduled: false, task: { status: "paused", recovery: { kind: "feedback_received" }, quizLinks: [{ ...links, completed: true, disputed: true }] } });
  expect(stores((_learning, store) => store.getTask("owner", task.id).approval?.status)).toBe("invalidated");
  expect(stores((_learning, store) => store.latestEvent("owner", task.id))).toMatchObject({ kind: "quiz_dispute", message: body.feedback });
  const saved = stores(learning => new LearningQuizRepository(learning).attempt(pageId, links.attemptId)); expect(saved.completed).toBe(true);
  expect(await (await PATCH(request("PATCH", { ...body, eventId: randomUUID() }), context())).json()).toMatchObject({ task: { status: "paused" }, scheduled: false });
  expect(deferred).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});

it("fences an in-flight decision on dispute and never resends its unknown request on resume", async () => {
  const task = seedTask(), { attemptId } = seedWaitingQuiz(task.id), second = seedWaitingQuiz(task.id);
  const active = stores((_learning, store) => { const lease = store.claim("owner", task.id)!; store.setState("owner", task.id, lease.token, "running");
    const callId = store.reserveCall("owner", task.id, lease.token, "decision:2", { kind: "synthetic-inflight", inputChars: 20, maxOutputTokens: 20 }, 0); return { lease, callId }; });
  expect(await (await PATCH(request("PATCH", disputeBody(task.id, attemptId)), context())).json()).toMatchObject({ task: { status: "paused", recovery: { kind: "unknown" } } });
  stores((_learning, store) => { expect(() => store.assertLease("owner", task.id, active.lease.token)).toThrow(); store.finishCall(active.callId, "succeeded", { inputTokens: 3, outputTokens: 2 }); });
  // Another dispute must not clear the unresolved prior decision merely because its billing response arrived.
  expect(await (await PATCH(request("PATCH", disputeBody(task.id, second.attemptId)), context())).json()).toMatchObject({ task: { status: "paused", recovery: { kind: "unknown" } } });
  const resumed = await PATCH(request("PATCH", { id: task.id, action: "resume", expectedVersion: 1, eventId: randomUUID() }), context());
  expect(await resumed.json()).toMatchObject({ task: { status: "needs_attention", usage: { calls: 1 } }, scheduled: false });
  expect(deferred).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});

it("marks a finished Quiz disputed without reopening the task and rejects foreign attempts", async () => {
  const task = seedTask(), { attemptId } = seedWaitingQuiz(task.id), other = seedTask(), otherQuiz = seedWaitingQuiz(other.id);
  expect((await PATCH(request("PATCH", disputeBody(task.id, otherQuiz.attemptId)), context())).status).toBe(404);
  stores((_learning, store) => store.end("owner", task.id, { expectedVersion: 1, eventId: randomUUID() }));
  expect(await (await PATCH(request("PATCH", disputeBody(task.id, attemptId)), context())).json()).toMatchObject({ task: { status: "ended", quizLinks: [{ disputed: true }] }, scheduled: false });
  expect(deferred).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});


it("notifies on the final saved practice answer without requiring a separate submit-to-Agent action", async () => {
  const task = seedTask(), { attemptId } = seedWaitingQuiz(task.id, "practice");
  await saveQuizAction(attemptId, "choose", "A"); expect(deferred).toHaveLength(0);
  const response = await saveQuizAction(attemptId, "submit");
  expect(await response.json()).toMatchObject({ attempt: { mode: "practice", completed: true, score: { correct: 1 } } });
  expect(deferred).toHaveLength(1); expect(stores((_learning, store) => store.pendingEvent("owner", task.id))).toMatchObject({ kind: "quiz_submission", refId: attemptId });
  expect(fetch).not.toHaveBeenCalled();
});

it("repairs a terminal dispute artifact write after a lost notification without reopening or repeating approval invalidation", async () => {
  const task = seedTask(), links = seedWaitingQuiz(task.id), body = disputeBody(task.id, links.attemptId);
  stores((_learning, store) => store.end("owner", task.id, { expectedVersion: 1, eventId: randomUUID() }));
  const fail = vi.spyOn(LearningAgentRepository.prototype, "dispute").mockImplementationOnce(() => { throw Error("[synthetic] artifact connection lost"); });
  expect((await PATCH(request("PATCH", body), context())).status).toBe(503); fail.mockRestore();
  expect(stores((_learning, store) => store.latestEvent("owner", task.id))).toMatchObject({ kind: "quiz_dispute" });
  const retry = await PATCH(request("PATCH", body), context());
  expect(await retry.json()).toMatchObject({ task: { status: "ended", quizLinks: [{ disputed: true }] }, scheduled: false });
  expect(stores((_learning, store) => store.database.prepare("SELECT count(*) AS n FROM agent_events WHERE task_id=?").get(task.id))).toEqual({ n: 1 });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects disputes after version change, source deletion, account changes or cancellation", async () => {
  const task = seedTask(), { attemptId } = seedWaitingQuiz(task.id);
  expect((await PATCH(request("PATCH", disputeBody(task.id, attemptId, 2)), context())).status).toBe(409);
  expect((await PATCH(request("PATCH", disputeBody(task.id, attemptId), "other"), context())).status).toBe(404);
  stores((_learning, store) => store.control("owner", task.id, "cancel", 1));
  expect((await PATCH(request("PATCH", disputeBody(task.id, attemptId)), context())).status).toBe(409);
  const active = seedTask(), second = seedWaitingQuiz(active.id);
  stores(learning => learning.deleteMaterial(pageId, materialId));
  expect((await PATCH(request("PATCH", disputeBody(active.id, second.attemptId)), context())).status).toBe(409);
  expect(deferred).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});

it("continues the real saved Quiz/Agent checkpoint after completion and reads persisted answers before deciding", async () => {
  const task = seedTask();
  const generate = vi.fn(async (_config: unknown, _purpose: unknown, _system: unknown, wire: unknown) => {
    const input = wire as { materials: Array<{ paragraphs: Array<{ referenceId: string }> }>; taskContext: { referenceScope: string } };
    const refs = input.materials[0].paragraphs.map(paragraph => paragraph.referenceId);
    return { contractVersion: "references-v2", referenceScope: input.taskContext.referenceScope, title: "[合成] 自动衔接", reason: null,
      materialPlan: [{ material: 1, contribution: "[合成] 规则与前提", references: refs }],
      items: [{ focus: "[合成] 前提", scenario: null, stem: "[合成] 应用规则前要做什么？", kind: "concept", stemEvidenceIds: refs,
        options: [{ id: "A", text: "先核对前提", reasonParts: [{ text: "前提满足后才可应用", evidenceIds: refs }] }, { id: "B", text: "直接应用", reasonParts: [{ text: "遗漏了前提条件", evidenceIds: refs }] }],
        correctOptionId: "A", explanationParts: [{ text: "规则应用依赖前提", evidenceIds: refs }], hint: "[合成] 先看条件" }] };
  }) as unknown as typeof generateStudyJson;
  const begin = vi.fn<AgentDecisionProvider>(async (_input, ctx) => ctx.call({ kind: "offline-decision", inputChars: 100, maxOutputTokens: 100 }, async () => ({ value: { tool: "learning.create_quiz", args: { count: 1, difficulty: "basic" } } })));
  const waiting = await runOffline(task.id, begin, generate); expect(waiting.status, waiting.endReason).toBe("waiting");
  const attemptId = waiting.wait!.refId!;
  await saveQuizAction(attemptId, "choose", "A"); await saveQuizAction(attemptId, "finish");
  const next = vi.fn<AgentDecisionProvider>(async (input, ctx) => ctx.call({ kind: "offline-decision", inputChars: 100, maxOutputTokens: 100 }, async () => ({ value:
    input.results.some(result => result.tool === "learning.read_answers") ? { wait: { kind: "feedback", message: "[合成] 根据作答继续核对理解" } }
      : { tool: "learning.read_answers", args: { attemptId } } })));
  const advanced = await runOffline(task.id, next);
  expect(advanced).toMatchObject({ status: "waiting", wait: { kind: "feedback" } });
  expect(next.mock.calls[0][0].event).toMatchObject({ kind: "quiz_submission", refId: attemptId });
  expect(next.mock.calls[1][0].results.find(result => result.tool === "learning.read_answers")?.value).toMatchObject({ attemptId, score: { correct: 1 } });
  for (let i = 0; i < 2; i++) { await PATCH(request("PATCH", syncBody(task.id, attemptId)), context()); await runOffline(task.id, next); }
  expect(next).toHaveBeenCalledTimes(2); expect(generate).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});
