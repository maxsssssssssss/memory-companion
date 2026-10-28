import { offlineQuizSemanticResponse } from "@/lib/server/learning/testing/quiz-semantic-fixture";
// @vitest-environment node
/** Controlled offline candidate actions, real API/business writes and checkpoints.
 * These tests are not evidence of autonomous model quality or human learning. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "@/lib/domain/agent";
import type { LearningCheckPurpose, LearningEvidenceRef, LearningReviewPlanInput } from "@/lib/domain/learning-agent-completion";
import type { QuizActionInput, QuizAttemptView } from "@/lib/domain/learning-quiz";
import type { AgentContext, AgentDecision, AgentDecisionInput, AgentDecisionProvider } from "@/lib/server/agent/types";

const { auth, decisionConfig, generationConfig, advance, deferred } = vi.hoisted(() => ({
  auth: vi.fn(), decisionConfig: vi.fn(), generationConfig: vi.fn(), advance: vi.fn(),
  deferred: [] as Array<() => Promise<void>>,
}));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: (work: () => Promise<void>) => deferred.push(work) }));
vi.mock("@/lib/server/auth/request-context", async original => ({ ...await original<typeof import("@/lib/server/auth/request-context")>(), requireAuthContext: auth }));
vi.mock("@/lib/server/learning/agent-decision-config", async original => ({ ...await original<typeof import("@/lib/server/learning/agent-decision-config")>(), agentModelConfig: decisionConfig }));
vi.mock("@/lib/server/learning/agent-scenario", async original => ({ ...await original<typeof import("@/lib/server/learning/agent-scenario")>(), learningAgentGenerationConfig: generationConfig }));
vi.mock("@/lib/server/learning/agent-api-service", async original => ({ ...await original<typeof import("@/lib/server/learning/agent-api-service")>(), advanceLearningAgent: advance }));

import { AgentRuntime } from "@/lib/server/agent/runtime";
import { AgentStore } from "@/lib/server/agent/store";
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningQuizRepository } from "@/lib/server/learning/quiz-repository";
import { createLearningAgentScenario } from "@/lib/server/learning/agent-scenario";
import { withLearningCompletionDecision } from "@/lib/server/learning/agent-context";
import { LearningAgentRepository } from "@/lib/server/learning/agent-repository";
import { assessLearningCompletion } from "@/lib/server/learning/agent-completion";
import { SavedQuizReview } from "@/lib/server/learning/quiz-review-purpose";
import { readLearningAgentScope } from "@/lib/server/learning/agent-scope";
import type { generateStudyJson } from "@/lib/server/learning/framework-generator";
import { GET, POST, PATCH } from "./pages/[pageId]/agent/route";
import { GET as quizGet, PATCH as quizPatch } from "./pages/[pageId]/quiz/route";

let directory: string, pageId: string, materialId: string;
let candidates: Array<AgentDecision | ((input: AgentDecisionInput) => AgentDecision)>;
let decision: ReturnType<typeof vi.fn<AgentDecisionProvider>>;
let generation: ReturnType<typeof vi.fn<typeof generateStudyJson>>;
let generatedStems: string[];
const origin = "http://localhost";
const routeContext = () => ({ params: Promise.resolve({ pageId }) });
const selection = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false });
const request = (method = "GET", body?: unknown, resource = "agent", account = "owner") => new Request(`${origin}/api/learning/pages/${pageId}/${resource}`, {
  method, headers: { origin, "x-synthetic-user": account, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
function stores<T>(work: (learning: LearningRepository, store: AgentStore) => T): T {
  const learning = new LearningRepository(join(directory, "owner"), "owner"), store = AgentStore.open(join(directory, "owner", "agent-tasks.sqlite"));
  try { return work(learning, store); } finally { store.close(); learning.close(); }
}
const task = (id: string) => stores((_learning, store) => store.getTask("owner", id));
const assessment = (id: string) => stores((learning, store) => assessLearningCompletion(learning, store.getTask("owner", id)));
const attempt = (id: string) => stores(learning => new LearningQuizRepository(learning).attempt(pageId, id));
const reference = (a: QuizAttemptView, questionIndex = 0): LearningEvidenceRef => ({ quizId: a.quizId, attemptId: a.id, questionIndex });
function plan(kind: LearningReviewPlanInput["kind"] = "chapter_check", objectives = ["concept"]): LearningReviewPlanInput {
  return { kind, objectives: objectives.map(id => ({ id, label: id === "boundary" ? "区分适用边界" : "理解规则前提", sources: [{ materialId, paragraph: id === "boundary" ? 2 : 1 }],
    requirements: kind === "explanation" ? [] : [{ role: id === "boundary" ? "boundary" : "concept", description: "提供与此目标相关的实际作答", independent: kind !== "diagnosis" },
      ...(kind === "targeted_review" ? [{ role: "followup" as const, description: "通过相关的后续检查观察关键困难是否仍存在", independent: true }] : [])] })) };
}
function purpose(objectiveId = "concept", overrides: Partial<LearningCheckPurpose> = {}): LearningCheckPurpose {
  return { objectiveIds: [objectiveId], role: objectiveId === "boundary" ? "boundary" : "concept", method: "retrieval", purpose: `检查 ${objectiveId} 的未覆盖部分`, priorEvidenceRefs: [], ...overrides };
}
const planAction = (value = plan()): AgentDecision => ({ tool: "learning.establish_review_plan", args: value });
const quizAction = (check = purpose()): AgentDecision => ({ tool: "learning.create_quiz", args: { count: 1, difficulty: "basic", purpose: check } });
const association = (ref: LearningEvidenceRef, overrides: object = {}): AgentDecision => ({ tool: "learning.associate_evidence", args: {
  ref, objectiveId: "concept", role: "concept", rationale: "[离线语义提案] 此检查针对前提判断，不声称心理原因已经核验。", relevance: "supported",
  relation: "initial", priorEvidenceRefs: [], contentStatus: "no_known_issue", ...overrides,
} });
const waitAction: AgentDecision = { wait: { kind: "feedback", message: "请提供下一条明确反馈。" } };
async function create(goal = "[合成] 检查规则前提") {
  const response = await POST(request("POST", { id: randomUUID(), goal, scope: selection() }), routeContext());
  expect(response.status).toBe(202); return (await response.json()).task.id as string;
}
async function run(id: string) {
  const learning = new LearningRepository(join(directory, "owner"), "owner"), store = AgentStore.open(join(directory, "owner", "agent-tasks.sqlite"));
  const runtime = new AgentRuntime({ store, checkpointPath: join(directory, "owner", "agent-checkpoints.sqlite"),
    scenario: createLearningAgentScenario(learning, { configure: generationConfig, generate: generation }), decision: withLearningCompletionDecision(learning, decision) });
  try { return await runtime.advance("owner", id); } finally { runtime.close(); store.close(); learning.close(); }
}
async function control(id: string, value: object) {
  const response = await PATCH(request("PATCH", { id, eventId: randomUUID(), expectedVersion: task(id).version, ...value }), routeContext());
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(202); return (await response.json()).task as AgentTask;
}
async function act(a: QuizAttemptView, action: QuizActionInput["action"], optionId: string | null = null) {
  const response = await quizPatch(request("PATCH", { kind: "act", value: { id: randomUUID(), attemptId: a.id, revision: a.revision, action, question: 0, optionId } }, "quiz"), routeContext());
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200); return (await response.json()).attempt as QuizAttemptView;
}
async function answer(waiting: AgentTask, correct = true, hint = false) {
  let a = attempt(waiting.wait!.refId!);
  if (hint) a = await act(a, "hint");
  a = await act(a, "choose", correct ? "A" : "B");
  return act(a, "finish");
}
async function firstQuiz(value = plan(), check = purpose()) {
  candidates.push(planAction(value), quizAction(check)); const id = await create(); const waiting = await run(id);
  expect(waiting.status, JSON.stringify(waiting)).toBe("waiting"); expect(waiting.wait?.kind).toBe("quiz_submission");
  return waiting;
}

beforeEach(async () => {
  vi.clearAllMocks(); deferred.length = 0; candidates = []; generatedStems = [];
  directory = await mkdtemp(join(tmpdir(), "learning-completion-repair-")); pageId = randomUUID(); materialId = randomUUID();
  const learning = new LearningRepository(join(directory, "owner"), "owner");
  learning.create({ id: pageId, title: "[合成] 完成判定验收" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 前提与边界", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 只有前提成立时才可应用规则。\n\n[合成] 未满足前提不能应用规则，不等于应用后未通过。") }]); learning.close();
  auth.mockImplementation(async (req: Request) => ({ user: { id: req.headers.get("x-synthetic-user") }, dataRootDir: join(directory, req.headers.get("x-synthetic-user")!) }));
  const config = { baseURL: "https://synthetic.invalid", apiKey: "SYNTHETIC_NOT_A_CREDENTIAL", model: "mock", maxInputChars: 47000, maxOutputTokens: 8000, requestTimeoutMs: 1000 };
  decisionConfig.mockReturnValue(config); generationConfig.mockReturnValue(config); advance.mockResolvedValue(undefined);
  decision = vi.fn<AgentDecisionProvider>(async (input, ctx) => ctx.call({ kind: "offline_decision_fixture", inputChars: 200, maxOutputTokens: 300 }, async () => {
    const next = candidates.shift() ?? waitAction; return { value: typeof next === "function" ? next(input) : next, usage: { inputTokens: 20, outputTokens: 10 } };
  }));
  generation = vi.fn(async (_config, name, _prompt, raw) => {
    if (name === "learning_quiz_semantic_review") return offlineQuizSemanticResponse(raw);
    if (name === "learning_agent_explanation") return { materialAnswer: "[离线解释] 应先核对前提，再判断能否应用规则。", supplements: [], items: [{ materialId, paragraph: 1 }] };
    const input = raw as { taskContext: { referenceScope: string; reviewContext?: { purpose: LearningCheckPurpose } }; materials: Array<{ paragraphs: Array<{ referenceId: string }> }> };
    const refs = [input.materials[0].paragraphs[0].referenceId];
    const stem = generatedStems.shift() ?? "[离线题目] 未满足前提时能否应用规则？";
    return { contractVersion: "references-v2", referenceScope: input.taskContext.referenceScope, title: "[离线题组] 前提检查", reason: null,
      materialPlan: [{ material: 1, contribution: "前提与适用条件", references: refs }], items: [{ focus: stem, scenario: null, stem, kind: "concept", stemEvidenceIds: refs,
        ...(input.taskContext.reviewContext ? { reviewCheck: { objectiveIds: input.taskContext.reviewContext.purpose.objectiveIds,
          role: input.taskContext.reviewContext.purpose.role, rationale: "SECRET_MAPPING_ANSWER：不能应用规则。[离线语义提案] 本题检查所指规则前提或边界，仍需真实模型语义验收。" } } : {}),
        correctOptionId: "A", hint: null, explanationParts: [{ text: "前提未满足，不能直接应用规则。", evidenceIds: refs }], options: [
          { id: "A", text: "不能应用规则", reasonParts: [{ text: "应用规则需要满足前提。", evidenceIds: refs }] },
          { id: "B", text: "可以应用规则", reasonParts: [{ text: "前提未满足，无法据此应用规则。", evidenceIds: refs }] }
        ] }] };
  }) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("No Provider/network request allowed in completion acceptance"); }));
});
afterEach(async () => { deferred.length = 0; expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });


function mismatchedPlan() {
  const value = plan();
  // Synthetic semantic mistake: the objective is about paragraph 1, but the
  // model's frozen association points to a different still-authorized paragraph.
  value.objectives[0].sources = [{ materialId, paragraph: 2 }];
  return value;
}
/** Reopen a synthetic pre-contract association snapshot, not a new generation
 * acceptance test. Current generation correctly uses P1 and creates the unchanged
 * question, answer, source and empty attempt through the real Runtime/services.
 * Restore ONLY the historical plan/quiz-review metadata pointing to P2. The
 * newer source publication fence is covered separately by G3 contract tests.
 * All subsequent submissions, recovery, authorization and assessment are real. */
async function savedMismatchedQuiz() {
  const waiting = await firstQuiz(), originalTask = task(waiting.id);
  stores(learning => {
    const quiz = new LearningQuizRepository(learning), a = quiz.attempt(pageId, waiting.wait!.refId!);
    const oldAttempt = JSON.stringify(a);
    const row = new LearningAgentRepository(learning).list(pageId, waiting.id).find(item => item.kind === "review_plan")!;
    const originalPlan = JSON.parse(row.body_json!), objectives = mismatchedPlan().objectives;
    const run = learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE page_id=? AND id=?")
      .get(pageId, a.quizId) as { result_json: string };
    const originalQuiz = JSON.parse(run.result_json), originalReview = SavedQuizReview.parse(originalQuiz.review);
    const review = SavedQuizReview.parse({ ...originalReview, context: { ...originalReview.context, objectives } });
    learning.database.transaction(() => {
      learning.database.prepare("UPDATE learning_agent_artifacts SET body_json=? WHERE page_id=? AND task_id=? AND id=? AND kind='review_plan'")
        .run(JSON.stringify({ ...originalPlan, objectives }), pageId, waiting.id, row.id);
      learning.database.prepare("UPDATE learning_quiz_runs SET result_json=? WHERE page_id=? AND id=?")
        .run(JSON.stringify({ ...originalQuiz, review }), pageId, a.quizId);
    }).immediate();
    const restored = JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE page_id=? AND id=?")
      .get(pageId, a.quizId) as { result_json: string }).result_json);
    expect({ ...restored, review: originalQuiz.review }).toEqual(originalQuiz);
    expect(JSON.stringify(quiz.attempt(pageId, a.id))).toBe(oldAttempt);
  });
  expect(task(waiting.id)).toEqual(originalTask);
  return waiting;
}

const artifacts = (id: string) => stores(learning => new LearningAgentRepository(learning).list(pageId, id));
function expectNoNewCalls(actual: AgentTask["usage"], before: AgentTask["usage"]) {
  const { computeMs, ...counters } = before;
  expect(actual).toMatchObject(counters);
  // Local permission/feedback processing is compute; it must not reset the
  // accumulated duration, but it does not create a Provider or generation call.
  expect(actual.computeMs).toBeGreaterThanOrEqual(computeMs);
}

async function savedMismatchedExplanation() {
  const value = plan("explanation"); value.objectives[0].sources = [{ materialId, paragraph: 2 }];
  candidates.push(planAction(value), waitAction);
  const id = await create("[合成] 请解释应用规则前为何先核对前提");
  const waiting = await run(id), explanationId = randomUUID();
  // Reconstruct an already saved pre-fix explanation through the artifact
  // repository. New generation must not create this invalid association.
  stores(learning => {
    const scope = readLearningAgentScope(learning, pageId, waiting.scope);
    const repository = new LearningAgentRepository(learning), fixedPlan = assessment(id).plan!;
    repository.reserve({ id: explanationId, taskId: id, taskVersion: 1, pageId, kind: "explanation", actionId: `pre-repair:${explanationId}`,
      binding: scope.fingerprint, materialIds: [materialId] });
    repository.complete(pageId, id, explanationId, { id: explanationId,
      materialAnswer: "[合成历史讲解] 先核对规则的前提，只有前提满足时才能使用规则。", supplements: [], items: [{ materialId, paragraph: 1 }],
      reviewContext: { planId: fixedPlan.id, taskVersion: 1, purpose: purpose("concept", { method: "explain" }) } });
  });
  return { id, explanationId };
}

describe("R1/R2 explicit source recovery through formal API and SQLite", () => {
  it("rejects the existing mismatched explanation, then accepts explicit resolution only after versioned source correction and a new related explanation", async () => {
    const { id, explanationId } = await savedMismatchedExplanation(), before = task(id), oldArtifacts = artifacts(id);
    expect(assessment(id).technicalBlocker?.kind).toBe("plan_source_mismatch");
    const refused = await PATCH(request("PATCH", { id, expectedVersion: 1, eventId: randomUUID(), action: "explanation_feedback", explanationId, outcome: "resolved" }), routeContext());
    expect(refused.status).toBe(409);
    expect(artifacts(id).filter(row => row.kind === "explanation_feedback")).toHaveLength(0);
    expectNoNewCalls(task(id).usage, before.usage);
    const projected = await GET(request(), routeContext());
    const view = (await projected.json()).tasks.find((item: { id: string }) => item.id === id);
    expect(view.sourceAdjustment.objectives).toContainEqual({ id: "concept", label: "理解规则前提", currentSources: [{ materialId, paragraph: 2 }] });
    expect(view.sourceAdjustment.sources).toContainEqual(expect.objectContaining({ materialId, paragraph: 1, text: "[合成] 只有前提成立时才可应用规则。" }));

    const correction = { action: "adjust", eventId: randomUUID(), goal: before.goal, scope: selection(),
      sourceCorrections: [{ objectiveId: "concept", sources: [{ materialId, paragraph: 1 }] }] };
    await control(id, correction);
    expect(task(id)).toMatchObject({ version: 2, goal: before.goal }); expectNoNewCalls(task(id).usage, before.usage);
    const duplicateCorrection = await PATCH(request("PATCH", { id, expectedVersion: 1, ...correction }), routeContext());
    expect(duplicateCorrection.status).toBe(202); expect(task(id).version).toBe(2); expectNoNewCalls(task(id).usage, before.usage);
    expect(assessment(id).plan?.objectives).toEqual(plan("explanation").objectives);
    expect(artifacts(id).filter(row => oldArtifacts.some(old => old.id === row.id))).toEqual(oldArtifacts);
    const stale = await PATCH(request("PATCH", { id, expectedVersion: 1, eventId: randomUUID(), action: "explanation_feedback", explanationId, outcome: "resolved" }), routeContext());
    expect(stale.status).toBe(409);
    const wrongVersionExplanation = await PATCH(request("PATCH", { id, expectedVersion: 2, eventId: randomUUID(), action: "explanation_feedback", explanationId, outcome: "resolved" }), routeContext());
    expect(wrongVersionExplanation.status).toBe(409);
    candidates.push({ tool: "learning.read_source", args: { materialId, paragraph: 1 } }, { tool: "learning.explain", args: {
      question: "为什么使用规则前先核对前提？", sources: [{ materialId, paragraph: 1 }], purpose: purpose("concept", { method: "explain" }) } }, waitAction);
    const waiting = await run(id);
    expect(waiting.status).toBe("waiting");
    const freshExplanation = artifacts(id).find(row => row.kind === "explanation" && row.task_version === 2)!;
    expect(freshExplanation.id).not.toBe(explanationId); expect(assessment(id).technicalBlocker).toBeUndefined();
    await control(id, { action: "feedback", feedback: "谢谢" }); candidates.push(waitAction); await run(id);
    expect(assessment(id).outcome).toBe("insufficient");
    const calls = decision.mock.calls.length, usage = task(id).usage;
    const feedback = { action: "explanation_feedback", explanationId: freshExplanation.id, outcome: "resolved" };
    await control(id, feedback); await Promise.all([run(id), run(id)]);
    expect(task(id).status).toBe("ended"); expect(assessment(id).outcome).toBe("explanation_resolved");
    const finishedUsage = { ...usage, steps: usage.steps + 1 }; // deterministic local finish is still an accounted step
    expectNoNewCalls(task(id).usage, finishedUsage); expect(decision).toHaveBeenCalledTimes(calls); expect(generation).toHaveBeenCalledTimes(1);
    await control(id, feedback); await run(id);
    expect(artifacts(id).filter(row => row.kind === "explanation_feedback")).toHaveLength(1);
    expect(decision).toHaveBeenCalledTimes(calls); expectNoNewCalls(task(id).usage, finishedUsage);
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId))).toHaveLength(0);
  });

  it("rejects source repair that changes the goal or references an unowned source without changing version, history or usage", async () => {
    const { id } = await savedMismatchedExplanation(), before = task(id), prior = artifacts(id);
    for (const invalid of [
      { goal: "[合成] 换成简单目标", sourceCorrections: [{ objectiveId: "concept", sources: [{ materialId, paragraph: 1 }] }] },
      { goal: before.goal, sourceCorrections: [{ objectiveId: "concept", sources: [{ materialId: randomUUID(), paragraph: 1 }] }] },
    ]) {
      const response = await PATCH(request("PATCH", { id, action: "adjust", eventId: randomUUID(), expectedVersion: 1, scope: selection(), ...invalid }), routeContext());
      expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500);
      expect(task(id).version).toBe(1); expect(task(id).usage).toEqual(before.usage); expect(artifacts(id)).toEqual(prior);
    }
  });

  it.each(["wrong", "hinted"] as const)("reassociates %s responses only with explicit history and resumes relevant explanation without erasing the learning gap", async problem => {
    const waiting = await savedMismatchedQuiz(), a = await answer(waiting, problem !== "wrong", problem === "hinted");
    await run(waiting.id);
    const before = task(waiting.id), oldPlan = artifacts(waiting.id).find(row => row.kind === "review_plan")!;
    await control(waiting.id, { action: "adjust", goal: before.goal, scope: { ...selection(), includeHistory: true },
      sourceCorrections: [{ objectiveId: "concept", sources: [{ materialId, paragraph: 1 }] }] });
    expect(task(waiting.id).usage).toEqual(before.usage); expect(task(waiting.id).version).toBe(2);
    candidates.push({ tool: "learning.read_answers", args: { attemptId: a.id } }, association(reference(a)), input => {
      const actual = input.results.find(result => result.tool === "learning.read_answers")?.value;
      expect(actual).toMatchObject({ attemptId: a.id, score: problem === "wrong" ? { correct: 0, total: 1 } : { correct: 1, hinted: 1, unassistedCorrect: 0 } });
      return { tool: "learning.explain", args: { question: "[合成] 重新说明保存作答中尚需区分的规则前提", sources: [{ materialId, paragraph: 1 }],
        purpose: purpose("concept", { method: "explain", priorEvidenceRefs: [reference(a)] }) } };
    }, waitAction);
    const continued = await run(waiting.id);
    expect(continued.status).toBe("waiting"); expect(continued.wait?.kind).toBe("feedback");
    const result = assessment(waiting.id), objective = result.objectives[0];
    expect(result.technicalBlocker).toBeUndefined(); expect(result.canAutoFinish).toBe(false); expect(result.outcome).not.toBe("check_passed");
    expect(objective.requirements[0].supported).toBe(false);
    if (problem === "wrong") expect(objective.unresolvedErrors).toContainEqual(reference(a));
    else expect(objective.evidence[0]).toMatchObject({ correct: true, hintedBeforeSubmission: true, independentInApp: false });
    expect(artifacts(waiting.id).filter(row => row.kind === "explanation" && row.task_version === 2)).toHaveLength(1);
    expect(generation).toHaveBeenCalledTimes(3); // one original Quiz + one gap-directed explanation
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId))).toHaveLength(1);
    expect(artifacts(waiting.id).find(row => row.id === oldPlan.id)).toEqual(oldPlan);
    expect(attempt(a.id).score).toEqual(a.score);
    const calls = decision.mock.calls.length, usage = task(waiting.id).usage;
    await Promise.all([run(waiting.id), run(waiting.id)]);
    expect(decision).toHaveBeenCalledTimes(calls); expectNoNewCalls(task(waiting.id).usage, usage);
  });

  it("removes source repair previews and rejects source correction after material deletion", async () => {
    const { id } = await savedMismatchedExplanation(), before = task(id);
    stores(learning => learning.deleteMaterial(pageId, materialId));
    const response = await GET(request(), routeContext()), view = (await response.json()).tasks.find((item: { id: string }) => item.id === id);
    expect(view.sourceAdjustment).toBeUndefined(); expect(view.explanations).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("只有前提成立时才可应用规则");
    const denied = await PATCH(request("PATCH", { id, action: "adjust", expectedVersion: 1, eventId: randomUUID(), goal: before.goal, scope: selection(),
      sourceCorrections: [{ objectiveId: "concept", sources: [{ materialId, paragraph: 1 }] }] }), routeContext());
    expect(denied.status).toBeGreaterThanOrEqual(400); expect(task(id).version).toBe(1); expect(task(id).usage).toEqual(before.usage);
  });
});

describe("F3 synthetic repair: actual API, business SQLite and checkpoint", () => {
  it("hands an authorized plan/source mismatch back without treating it as a learning gap or calling the model again", async () => {
    const waiting = await savedMismatchedQuiz();
    const hidden = await quizGet(new Request(`${origin}/api/learning/pages/${pageId}/quiz?attempt=${waiting.wait!.refId}`, { headers: { "x-synthetic-user": "owner" } }), routeContext());
    expect(JSON.stringify(await hidden.json())).not.toMatch(/correctOptionId|explanation|score":\{/);
    const a = await answer(waiting);
    expect(a.score).toMatchObject({ correct: 1, total: 1 });
    const calls = decision.mock.calls.length, usage = task(waiting.id).usage.calls;
    candidates.push(quizAction()); // Must remain unconsumed: this is a system association problem.
    const handedBack = await run(waiting.id);
    expect(handedBack).toMatchObject({ status: "waiting", wait: { kind: "feedback" } });
    expect(handedBack.wait?.message).toContain("调整本轮复习");
    const result = assessment(waiting.id);
    expect(result.technicalBlocker).toMatchObject({ kind: "plan_source_mismatch", objectiveIds: ["concept"] });
    expect(result.objectives[0].evidence[0]).toMatchObject({ quality: "invalid", eligible: false, diagnosticCode: "plan_source_mismatch" });
    expect(result.objectives[0].unresolvedErrors).toEqual([]);
    expect(result.canAutoFinish).toBe(false); expect(result.outcome).not.toBe("check_passed");
    expect(generation).toHaveBeenCalledTimes(2); expect(decision).toHaveBeenCalledTimes(calls); expect(candidates).toHaveLength(1);
    expect(task(waiting.id).usage.calls).toBe(usage);

    // run() closes all three database/checkpoint handles. Refresh/reopen and an
    // ordinary new feedback cannot erase the fixed association or spend calls.
    const ref = handedBack.wait!.refId;
    expect((await run(waiting.id)).wait?.refId).toBe(ref);
    const refreshed = await GET(request(), routeContext()); expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).tasks.find((t: AgentTask) => t.id === waiting.id).completion.technicalBlocker.kind).toBe("plan_source_mismatch");
    const feedback = { action: "feedback", eventId: randomUUID(), feedback: "[合成] 请继续检查，但我还没有调整目标来源。" };
    await control(waiting.id, feedback); await Promise.all([run(waiting.id), run(waiting.id)]);
    await control(waiting.id, feedback); await run(waiting.id);
    expect(task(waiting.id).status).toBe("waiting");
    expect(assessment(waiting.id).technicalBlocker?.kind).toBe("plan_source_mismatch");
    expect(task(waiting.id).usage.calls).toBe(usage); expect(decision).toHaveBeenCalledTimes(calls); expect(generation).toHaveBeenCalledTimes(2);
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId))).toHaveLength(1);
    expect(attempt(a.id).score).toEqual(a.score);
  });

  it("requires an explicit new version, keeps prior records and budget, and rechecks an authorized old response under the corrected source plan", async () => {
    const waiting = await savedMismatchedQuiz(), a = await answer(waiting);
    await run(waiting.id);
    const before = task(waiting.id), oldPlan = artifacts(waiting.id).find(row => row.kind === "review_plan")!;
    const goal = before.goal;
    await control(waiting.id, { action: "adjust", goal, scope: { ...selection(), includeHistory: true } });
    const adjusted = task(waiting.id);
    expect(adjusted.version).toBe(2); expect(adjusted.usage).toEqual(before.usage);
    expect(assessment(waiting.id).plan).toBeNull(); expect(assessment(waiting.id).outcome).not.toBe("check_passed");
    expect(artifacts(waiting.id).find(row => row.id === oldPlan.id)).toEqual(oldPlan);
    const stale = await PATCH(request("PATCH", { id: waiting.id, eventId: randomUUID(), expectedVersion: 1, action: "sync_quiz", attemptId: a.id }), routeContext());
    expect(stale.status).toBe(409);
    candidates.push({ tool: "learning.read_source", args: { materialId, paragraph: 1 } }, planAction(),
      { tool: "learning.read_answers", args: { attemptId: a.id } }, association(reference(a)));
    const ended = await run(waiting.id), corrected = assessment(waiting.id);
    expect(ended.status).toBe("ended"); expect(corrected.outcome).toBe("check_passed");
    expect(corrected.technicalBlocker).toBeUndefined(); expect(corrected.taskVersion).toBe(2);
    expect(corrected.plan?.objectives[0]).toEqual(plan().objectives[0]);
    expect(corrected.plan?.objectives[0].requirements).toEqual(JSON.parse(oldPlan.body_json!).objectives[0].requirements);
    const savedPlans = artifacts(waiting.id).filter(row => row.kind === "review_plan");
    expect(savedPlans).toHaveLength(2); expect(savedPlans.find(row => row.id === oldPlan.id)).toEqual(oldPlan);
    expect(generation).toHaveBeenCalledTimes(2); expect(attempt(a.id).score).toEqual(a.score);
    expect(task(waiting.id).usage.calls).toBe(before.usage.calls + 4);
    const historical = await GET(request(), routeContext());
    expect((await historical.json()).tasks.find((t: AgentTask) => t.id === waiting.id).quizLinks).toContainEqual({ quizId: a.quizId, attemptId: a.id, completed: true, disputed: false, historical: true });
  });

  it.each(["wrong", "hinted", "disputed"] as const)("does not erase %s evidence when the user explicitly corrects the source association in a new version", async problem => {
    const waiting = await savedMismatchedQuiz(), a = await answer(waiting, problem !== "wrong", problem === "hinted");
    await run(waiting.id);
    if (problem === "disputed") await control(waiting.id, { action: "dispute_quiz", attemptId: a.id, feedback: "[合成] 本题条件有疑问，请保留原记录并暂停判断。" });
    const before = task(waiting.id), oldPlan = artifacts(waiting.id).find(row => row.kind === "review_plan")!;
    await control(waiting.id, { action: "adjust", goal: before.goal, scope: { ...selection(), includeHistory: true } });
    candidates.push({ tool: "learning.read_source", args: { materialId, paragraph: 1 } }, planAction(),
      { tool: "learning.read_answers", args: { attemptId: a.id } }, association(reference(a)), { finish: "[离线] 本轮先交回，现有记录不能支持检查通过。" });
    expect((await run(waiting.id)).status).toBe("ended");
    const result = assessment(waiting.id), objective = result.objectives[0];
    expect(result.outcome).not.toBe("check_passed"); expect(result.canAutoFinish).toBe(false);
    expect(objective.requirements[0].supported).toBe(false);
    if (problem === "wrong") expect(objective.unresolvedErrors).toContainEqual(reference(a));
    if (problem === "hinted") expect(objective.evidence[0]).toMatchObject({ hintedBeforeSubmission: true, independentInApp: false });
    if (problem === "disputed") expect(objective.evidence[0]).toMatchObject({ quality: "disputed", eligible: false });
    expect(artifacts(waiting.id).find(row => row.id === oldPlan.id)).toEqual(oldPlan);
    expect(attempt(a.id).score).toEqual(a.score); expect(generation).toHaveBeenCalledTimes(2);
  });

  it.each(["learning.create_quiz", "learning.explain"] as const)("rechecks %s at its real tool boundary before reserving or generating after reopen", async toolName => {
    const waiting = await savedMismatchedQuiz(), a = await answer(waiting);
    const learning = new LearningRepository(join(directory, "owner"), "owner");
    const beforeArtifacts = artifacts(waiting.id), beforeCalls = task(waiting.id).usage.calls;
    const invoke = vi.fn(async () => { throw Error("A technical source mismatch must not start a generation"); });
    const ctx: AgentContext = { task: task(waiting.id), actionId: randomUUID(), signal: new AbortController().signal,
      assertActive: async () => undefined, call: invoke };
    try {
      const scenario = createLearningAgentScenario(learning, { configure: generationConfig, generate: generation });
      const args = toolName === "learning.create_quiz" ? { count: 1, difficulty: "basic", purpose: purpose() }
        : { question: "为什么先检查前提？", sources: [{ materialId, paragraph: 1 }], purpose: purpose("concept", { method: "explain" }) };
      const result = await scenario.tools[toolName].execute(args, ctx);
      expect(result.wait).toMatchObject({ kind: "feedback", refId: `feedback:${ctx.actionId}` });
      expect(result.wait?.message).toContain("调整本轮复习"); expect(result.handoff).toBeUndefined();
      expect(result.ref?.kind).toBe("learning.completion_assessment"); expect(invoke).not.toHaveBeenCalled();
    } finally { learning.close(); }
    expect(generation).toHaveBeenCalledTimes(2); expect(task(waiting.id).usage.calls).toBe(beforeCalls);
    expect(artifacts(waiting.id).filter(row => ["quiz", "explanation"].includes(row.kind))).toEqual(beforeArtifacts.filter(row => ["quiz", "explanation"].includes(row.kind)));
    expect(attempt(a.id).score).toEqual(a.score);
  });
});
