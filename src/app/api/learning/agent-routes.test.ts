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
import { AgentFailure, type AgentDecisionProvider } from "@/lib/server/agent/types";
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningFrameworkRepository } from "@/lib/server/learning/framework-repository";
import { LearningQuizRepository } from "@/lib/server/learning/quiz-repository";
import { LearningAgentRepository } from "@/lib/server/learning/agent-repository";
import { freezeLearningAgentScope } from "@/lib/server/learning/agent-scope";
import { createLearningAgentScenario } from "@/lib/server/learning/agent-scenario";
import type { generateStudyJson } from "@/lib/server/learning/framework-generator";
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
