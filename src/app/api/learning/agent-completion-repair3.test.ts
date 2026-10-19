// @vitest-environment node
/** Real API, artifact repository and SQLite; only model responses are controlled
 * offline fixtures. This is not a real-DS or human-learning acceptance test. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAgentTaskView } from "@/lib/client/learning-agent-api";
import type { LearningReviewPlanInput } from "@/lib/domain/learning-agent-completion";
import type { AgentDecision, AgentDecisionProvider } from "@/lib/server/agent/types";
const { auth, decisionConfig, generationConfig, advance, deferred } = vi.hoisted(() => ({
  auth: vi.fn(), decisionConfig: vi.fn(), generationConfig: vi.fn(), advance: vi.fn(), deferred: [] as Array<() => Promise<void>>,
}));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: (work: () => Promise<void>) => deferred.push(work) }));
vi.mock("@/lib/server/auth/request-context", async original => ({ ...await original<typeof import("@/lib/server/auth/request-context")>(), requireAuthContext: auth }));
vi.mock("@/lib/server/learning/agent-decision-config", async original => ({ ...await original<typeof import("@/lib/server/learning/agent-decision-config")>(), agentModelConfig: decisionConfig }));
vi.mock("@/lib/server/learning/agent-scenario", async original => ({ ...await original<typeof import("@/lib/server/learning/agent-scenario")>(), learningAgentGenerationConfig: generationConfig }));
vi.mock("@/lib/server/learning/agent-api-service", async original => ({ ...await original<typeof import("@/lib/server/learning/agent-api-service")>(), advanceLearningAgent: advance }));
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { AgentStore } from "@/lib/server/agent/store";
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningAgentRepository } from "@/lib/server/learning/agent-repository";
import { createLearningAgentScenario } from "@/lib/server/learning/agent-scenario";
import { withLearningCompletionDecision } from "@/lib/server/learning/agent-context";
import { readLearningAgentScope } from "@/lib/server/learning/agent-scope";
import type { generateStudyJson } from "@/lib/server/learning/framework-generator";
import { GET, POST, PATCH } from "./pages/[pageId]/agent/route";

// Exact public saved W1 explanation 353c8481-42d4-443f-8033-6a70a3c0f9c3.
// Fixture uses a new local material ID; the separate attachment replay retains original IDs.
const originalContradiction = "材料第3段说明交集 A∩B 使用“同时”条件，要求元素同时属于 A 和 B；第4段说明并集 A∪B 使用“或”，并明确这个“或允许同时属于二者”。因此交集对应的是“且”的严格同时归属，而并集中的“或”是包含式“或”：只要元素属于 A、属于 B 或同时属于二者，都满足条件。材料以 A={1,2,3}，B={3,4} 为例：交集为 {3}，并集为 {1,2,3,4}。元素 3 同时属于两个集合，所以不满足交集的双条件，但满足并集的“或”条件，且只出现一次。";
const source3 = "交集 A∩B 包含同时属于 A 和 B 的元素。判断一个元素是否在交集中，需要两个归属条件同时成立。若 A={1,2,3}，B={3,4}，则 A∩B={3}。没有共同元素时交集为空集。";
const source4 = "并集 A∪B 包含属于 A 或属于 B 的元素，这里的或允许同时属于二者。一个元素只出现一次。若 A={1,2,3}，B={3,4}，则 A∪B={1,2,3,4}。把元素 3 写两次不构成两个不同元素。";
const validExplanation = "[离线讲解] 交集需要同时属于 A 与 B，并集允许属于其中一个或同时属于二者。A={1,2,3}，B={3,4} 时，元素3同时属于两个集合，因此在交集和并集中，且各只列一次。";
let directory: string, pageId: string, materialId: string;
let candidates: AgentDecision[], generatedText: string;
let decision: ReturnType<typeof vi.fn<AgentDecisionProvider>>, generation: ReturnType<typeof vi.fn<typeof generateStudyJson>>;
const routeContext = () => ({ params: Promise.resolve({ pageId }) });
const selection = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false });
const request = (method = "GET", body?: unknown, account = "owner") => new Request(`http://localhost/api/learning/pages/${pageId}/agent`, {
  method, headers: { origin: "http://localhost", "x-synthetic-user": account, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
function stores<T>(work: (learning: LearningRepository, store: AgentStore) => T) {
  const learning = new LearningRepository(join(directory, "owner"), "owner"), store = AgentStore.open(join(directory, "owner", "agent-tasks.sqlite"));
  try { return work(learning, store); } finally { store.close(); learning.close(); }
}
const task = (id: string) => stores((_learning, store) => store.getTask("owner", id));
const artifacts = (id: string) => stores(learning => new LearningAgentRepository(learning).list(pageId, id));
const plan = (paragraphs = [3, 4]): LearningReviewPlanInput => ({ kind: "explanation", objectives: [{ id: "membership", label: "区分交集与并集的归属条件",
  sources: paragraphs.map(paragraph => ({ materialId, paragraph })), requirements: [] }] });
const purpose = () => ({ objectiveIds: ["membership"], role: "concept", method: "explain", purpose: "说明交集与并集的归属条件", priorEvidenceRefs: [] });
const wait: AgentDecision = { tool: "learning.request_feedback", args: { question: "请说明需要继续澄清的部分。" } };
const explain = (): AgentDecision => ({ tool: "learning.explain", args: { question: "并集的或为何允许同时属于两个集合？", sources: [3, 4].map(paragraph => ({ materialId, paragraph })), purpose: purpose() } });
async function create(value = plan()) {
  candidates.push({ tool: "learning.establish_review_plan", args: value }, wait);
  const response = await POST(request("POST", { id: randomUUID(), goal: "[合成] 解释交集与并集的归属区别", scope: selection() }), routeContext());
  expect(response.status).toBe(202); const id = (await response.json()).task.id as string; await run(id); return id;
}
async function run(id: string) {
  const learning = new LearningRepository(join(directory, "owner"), "owner"), store = AgentStore.open(join(directory, "owner", "agent-tasks.sqlite"));
  const runtime = new AgentRuntime({ store, checkpointPath: join(directory, "owner", "agent-checkpoints.sqlite"),
    scenario: createLearningAgentScenario(learning, { configure: generationConfig, generate: generation }), decision: withLearningCompletionDecision(learning, decision) });
  try { return await runtime.advance("owner", id); } finally { runtime.close(); store.close(); learning.close(); }
}
async function patch(id: string, value: object) {
  return PATCH(request("PATCH", { id, expectedVersion: task(id).version, eventId: randomUUID(), ...value }), routeContext());
}
async function view(id: string) {
  const response = await GET(request(), routeContext()); expect(response.status).toBe(200);
  return (await response.json()).tasks.find((item: LearningAgentTaskView) => item.id === id) as LearningAgentTaskView;
}
async function generated(id: string) {
  expect((await patch(id, { action: "feedback", feedback: "请结合原文说明。" })).status).toBe(202);
  candidates.push(explain()); await run(id);
  return artifacts(id).find(row => row.kind === "explanation")!.id;
}
beforeEach(async () => {
  vi.clearAllMocks(); deferred.length = 0; candidates = []; generatedText = validExplanation;
  directory = await mkdtemp(join(tmpdir(), "learning-completion-repair3-")); pageId = randomUUID(); materialId = randomUUID();
  stores(learning => { learning.create({ id: pageId, title: "[合成] 解释核对" }); learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 集合教材", kind: "text", filename: null,
    bytes: Buffer.from(`[合成] 集合学习导引。\n\n[合成] 本轮要区分不同归属条件。\n\n${source3}\n\n${source4}`) }]); });
  auth.mockImplementation(async (req: Request) => ({ user: { id: req.headers.get("x-synthetic-user") }, dataRootDir: join(directory, req.headers.get("x-synthetic-user")!) }));
  const config = { baseURL: "https://synthetic.invalid", apiKey: "SYNTHETIC_NOT_A_CREDENTIAL", model: "mock", maxInputChars: 47000, maxOutputTokens: 8000, requestTimeoutMs: 1000 };
  decisionConfig.mockReturnValue(config); generationConfig.mockReturnValue(config); advance.mockResolvedValue(undefined);
  decision = vi.fn<AgentDecisionProvider>(async (_input, ctx) => ctx.call({ kind: "offline_decision_fixture", inputChars: 200, maxOutputTokens: 300 }, async () => ({ value: candidates.shift() ?? wait, usage: { inputTokens: 20, outputTokens: 10 } })));
  generation = vi.fn(async () => ({ materialAnswer: generatedText, supplements: [], items: [3, 4].map(paragraph => ({ materialId, paragraph })) })) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Provider/network disabled in offline completion repair test"); }));
});
afterEach(async () => { deferred.length = 0; expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it("shows missing current explanation after explicit source adjustment while allowing necessary clarification", async () => {
  const id = await create(plan([1])), original = task(id), oldPlan = artifacts(id).find(row => row.kind === "review_plan")!;
  const adjustment = await patch(id, { action: "adjust", goal: original.goal, scope: selection(), sourceCorrections: [{ objectiveId: "membership", sources: [3, 4].map(paragraph => ({ materialId, paragraph })) }] });
  expect(adjustment.status).toBe(202); expect(task(id)).toMatchObject({ version: 2, status: "ready", wait: undefined });
  const projected = await view(id);
  expect(projected.explanations).toEqual([]); expect(projected.completion?.objectives[0].explanationState).toBe("missing");
  expect(projected.completion?.headline).not.toMatch(/等待.*确认.*解决/);
  expect(projected.completion?.plan?.objectives[0]).toEqual(plan().objectives[0]);
  expect(artifacts(id).find(row => row.id === oldPlan.id)).toEqual(oldPlan); expect(task(id).usage).toEqual(original.usage);
  const noExplanation = await patch(id, { action: "explanation_feedback", explanationId: randomUUID(), outcome: "resolved" });
  expect(noExplanation.status).toBe(409); expect(artifacts(id).filter(row => row.kind === "explanation_feedback")).toHaveLength(0);
  const oldEvent = await patch(id, { expectedVersion: 1, action: "feedback", feedback: "旧窗口的反馈" }); expect(oldEvent.status).toBe(409);
  candidates.push({ tool: "learning.request_feedback", args: { question: "请说明你最想澄清的归属条件。" } });
  await run(id); expect(task(id).status).toBe("waiting");
  expect((await patch(id, { action: "feedback", feedback: "我想先知道为什么并集允许同时属于两个集合。" })).status).toBe(202);
  expect(artifacts(id).filter(row => row.kind === "explanation_feedback")).toHaveLength(0);
});

it("keeps thanks unresolved, then finishes a valid current explanation with no extra decision or generation and idempotent confirmation", async () => {
  const id = await create(), explanationId = await generated(id);
  expect((await view(id)).completion?.objectives[0].explanationState).toBe("available");
  expect((await patch(id, { action: "feedback", feedback: "谢谢" })).status).toBe(202); candidates.push(wait); await run(id);
  expect((await view(id)).completion?.outcome).toBe("insufficient"); expect(task(id).status).toBe("waiting");
  const before = task(id).usage.calls, calls = decision.mock.calls.length, generatedCalls = generation.mock.calls.length;
  const confirmation = { action: "explanation_feedback", explanationId, outcome: "resolved", eventId: randomUUID() };
  expect((await patch(id, confirmation)).status).toBe(202); await Promise.all([run(id), run(id)]);
  expect(task(id).status).toBe("ended"); expect((await view(id)).completion?.outcome).toBe("explanation_resolved");
  expect(task(id).usage.calls).toBe(before); expect(decision).toHaveBeenCalledTimes(calls); expect(generation).toHaveBeenCalledTimes(generatedCalls);
  expect((await patch(id, confirmation)).status).toBe(202); await run(id);
  expect(artifacts(id).filter(row => row.kind === "explanation_feedback")).toHaveLength(1);
  expect(task(id).usage.calls).toBe(before); expect(decision).toHaveBeenCalledTimes(calls); expect(generation).toHaveBeenCalledTimes(generatedCalls);
});

it.each(["generated", "saved_before_fix"] as const)("retains the complete W1 contradiction in %s, rejects resolution and permits explicit clarification", async mode => {
  const id = await create(); let explanationId: string;
  if (mode === "generated") { generatedText = originalContradiction; explanationId = await generated(id); }
  else {
    explanationId = randomUUID(); const current = task(id), currentPlan = (await view(id)).completion!.plan!;
    stores(learning => {
      const repository = new LearningAgentRepository(learning), scope = readLearningAgentScope(learning, pageId, current.scope);
      repository.reserve({ id: explanationId, taskId: id, taskVersion: 1, pageId, kind: "explanation", actionId: `pre-repair:${explanationId}`, binding: scope.fingerprint, materialIds: [materialId] });
      repository.complete(pageId, id, explanationId, { id: explanationId, materialAnswer: originalContradiction, supplements: [], items: [3, 4].map(paragraph => ({ materialId, paragraph })),
        reviewContext: { planId: currentPlan.id, taskVersion: 1, purpose: purpose() } });
    });
  }
  const before = task(id).usage.calls, publicView = await view(id), saved = artifacts(id).find(row => row.id === explanationId)!;
  expect(publicView.explanations?.find(row => row.id === explanationId)).toMatchObject({ text: originalContradiction, contentIssue: { status: "known_issue" } });
  expect(publicView.completion?.objectives[0].explanationState).toBe("needs_review");
  expect(publicView.completion?.contentIssues).toContainEqual(expect.objectContaining({ explanationId, objectiveIds: ["membership"] }));
  const refused = await patch(id, { action: "explanation_feedback", explanationId, outcome: "resolved" });
  expect(refused.status).toBe(409); expect((await refused.json()).error).toBe("agent_completion_feedback_invalid");
  expect(artifacts(id).filter(row => row.kind === "explanation_feedback")).toHaveLength(0); expect(task(id).usage.calls).toBe(before);
  expect((await patch(id, { action: "explanation_feedback", explanationId, outcome: "needs_clarification", message: "同时属于两个集合为何又不满足交集条件？请核对矛盾。" })).status).toBe(202);
  expect(artifacts(id).find(row => row.id === saved.id)).toEqual(saved); expect(task(id).usage.calls).toBe(before);
  expect((await view(id)).completion?.canAutoFinish).toBe(false);
});

it("does not reveal explanation or accept resolution after source deletion or through another account", async () => {
  const id = await create(), explanationId = await generated(id), before = task(id).usage.calls;
  const foreign = await PATCH(request("PATCH", { id, expectedVersion: 1, eventId: randomUUID(), action: "explanation_feedback", explanationId, outcome: "resolved" }, "other"), routeContext());
  expect(foreign.status).toBe(404);
  stores(learning => learning.deleteMaterial(pageId, materialId));
  const projected = await view(id); expect(projected.explanations ?? []).toEqual([]); expect(JSON.stringify(projected)).not.toContain(validExplanation);
  expect(projected.completion?.outcome).toBe("stale");
  const response = await patch(id, { action: "explanation_feedback", explanationId, outcome: "resolved" });
  expect(response.status).toBe(409); expect(task(id).usage.calls).toBe(before);
  expect(artifacts(id).filter(row => row.kind === "explanation_feedback")).toHaveLength(0);
});


it.each([
  { question: "请确认：结合当前材料第3、4段，关于交集与并集在或上的区别，现在是否已经讲清？" },
  { question: "请确认本轮结果。", intent: "explanation_resolution", explanationId: "00000000-0000-4000-8000-000000000001" },
])("rejects an unsupported resolution premise but still accepts bounded source clarification: $question", async args => {
  const id = await create(), originalActionCount = task(id).actions.length;
  expect((await patch(id, { action: "feedback", feedback: "请先说明。" })).status).toBe(202);
  candidates.push({ tool: "learning.request_feedback", args }, { tool: "learning.request_feedback", args: {
    question: "请核对你想了解的材料是否是第3和第4段。", intent: "source_review",
  } });
  await run(id);
  const actions = task(id).actions.slice(originalActionCount);
  expect(actions).toHaveLength(2);
  expect(actions[0]).toMatchObject({ tool: "learning.request_feedback", status: "failed" });
  expect(actions[0].summary).toMatch(/当前|讲解/);
  expect(actions[1]).toMatchObject({ tool: "learning.request_feedback", status: "succeeded" });
  expect(task(id).wait?.message).toBe("请核对你想了解的材料是否是第3和第4段。");
  expect((await view(id)).completion?.objectives[0].explanationState).toBe("missing");
  expect(artifacts(id).filter(row => row.kind === "explanation_feedback")).toHaveLength(0);
  expect(generation).not.toHaveBeenCalled();
});

it("recovers from a known contradictory explanation via a distinct source-checking clarification without deleting it or extra resolution calls", async () => {
  const id = await create(); generatedText = originalContradiction;
  const badId = await generated(id), badRow = artifacts(id).find(row => row.id === badId)!;
  expect((await patch(id, { action: "explanation_feedback", explanationId: badId, outcome: "needs_clarification", message: "请逐个核对元素3的归属条件，纠正前后矛盾。" })).status).toBe(202);
  generatedText = validExplanation;
  candidates.push({ tool: "learning.explain", args: { question: "结合原文逐项核对元素3的两个归属条件，说明上一解释中的矛盾。", sources: [3, 4].map(paragraph => ({ materialId, paragraph })), purpose: {
    ...purpose(), method: "clarify", methodChange: { previousResultId: badId, difference: "将原先概括定义改为逐项对照原文核对元素3的两个归属条件。", expectedObservation: "用户能指出同时归属为何满足交集，并明确反馈矛盾是否得到解释。" },
  } } }, wait);
  await run(id);
  const current = await view(id), good = current.explanations!.find(row => row.id !== badId)!;
  expect(good, JSON.stringify({ status: current.status, wait: current.wait, actions: current.actions })).toMatchObject({ text: validExplanation, contentIssue: { status: "no_known_issue" } });
  expect(current.explanations!.find(row => row.id === badId)?.text).toBe(originalContradiction);
  expect(current.completion?.objectives[0].explanationState).toBe("available");
  expect(current.completion?.contentIssues).toContainEqual(expect.objectContaining({ explanationId: badId, active: false }));
  expect(artifacts(id).find(row => row.id === badId)).toEqual(badRow);
  expect((await patch(id, { action: "explanation_feedback", explanationId: badId, outcome: "resolved" })).status).toBe(409);
  const calls = task(id).usage.calls, decisions = decision.mock.calls.length, generations = generation.mock.calls.length;
  expect((await patch(id, { action: "explanation_feedback", explanationId: good.id, outcome: "resolved" })).status).toBe(202);
  await run(id);
  expect(task(id).status).toBe("ended"); expect((await view(id)).completion?.outcome).toBe("explanation_resolved");
  expect(task(id).usage.calls).toBe(calls); expect(decision).toHaveBeenCalledTimes(decisions); expect(generation).toHaveBeenCalledTimes(generations);
  expect(artifacts(id).find(row => row.id === badId)).toEqual(badRow);
});
