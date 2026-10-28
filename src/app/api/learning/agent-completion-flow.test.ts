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
import type { AgentDecision, AgentDecisionInput, AgentDecisionProvider } from "@/lib/server/agent/types";

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
import { assessLearningCompletion } from "@/lib/server/learning/agent-completion";
import type { generateStudyJson } from "@/lib/server/learning/framework-generator";
import { offlineQuizSemanticResponse } from "@/lib/server/learning/testing/quiz-semantic-fixture";
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
const explainAction = (check = purpose("concept", { method: "explain" })): AgentDecision => ({ tool: "learning.explain", args: { question: "为什么先检查前提？", sources: [{ materialId, paragraph: 1 }], purpose: check } });
const association = (ref: LearningEvidenceRef, overrides: object = {}): AgentDecision => ({ tool: "learning.associate_evidence", args: {
  ref, objectiveId: "concept", role: "concept", rationale: "[离线语义提案] 此检查针对前提判断，不声称心理原因已经核验。", relevance: "supported",
  relation: "initial", priorEvidenceRefs: [], contentStatus: "no_known_issue", ...overrides,
} });
const waitAction: AgentDecision = { wait: { kind: "feedback", message: "请提供下一条明确反馈。" } };
async function create(goal = "[合成] 检查规则前提") {
  const response = await POST(request("POST", { id: randomUUID(), goal, scope: selection() }), routeContext());
  expect(response.status).toBe(202); return (await response.json()).task.id as string;
}
async function run(id: string, pauseAfterPrepare = false) {
  const learning = new LearningRepository(join(directory, "owner"), "owner"), store = AgentStore.open(join(directory, "owner", "agent-tasks.sqlite"));
  const runtime = new AgentRuntime({ store, checkpointPath: join(directory, "owner", "agent-checkpoints.sqlite"),
    scenario: createLearningAgentScenario(learning, { configure: generationConfig, generate: generation }), decision: withLearningCompletionDecision(learning, decision) });
  const prepare = store.prepareAction.bind(store);
  if (pauseAfterPrepare) vi.spyOn(store, "prepareAction").mockImplementationOnce((...args) => {
    const actionId = prepare(...args);
    // Fault injection after the real action transaction, using the supported
    // pause control; never write task status, score or completion data directly.
    runtime.control("owner", id, "pause", task(id).version);
    return actionId;
  });
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
  directory = await mkdtemp(join(tmpdir(), "learning-completion-flow-")); pageId = randomUUID(); materialId = randomUUID();
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
    const refs = input.materials[0].paragraphs.map(p => p.referenceId);
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

describe("Learning completion: frozen offline scenarios through formal API and SQLite", () => {
  it("one explicit disputed replacement survives checkpoint restart, preserves grades, and is never learning progress", async () => {
    const waiting = await firstQuiz(plan("practice")), id = waiting.id;
    const original = await answer(waiting, false);
    candidates.push({ tool: "learning.read_answers", args: { attemptId: original.id } }, association(reference(original)), waitAction);
    await run(id);
    await control(id, { action: "dispute_quiz", attemptId: original.id, feedback: "这道题有两个合理答案。" });
    await control(id, { action: "resume" }); candidates.push(waitAction); await run(id);
    expect(assessment(id).objectives[0].evidence[0]).toMatchObject({ eligible: false, quality: "disputed" });
    const feedback = { action: "feedback", eventId: randomUUID(), feedback: "换一组继续吧。" };
    await control(id, feedback); generatedStems.push("[离线替换题] 未满足前提的另一个对象，能否直接使用规则？");
    candidates.push(quizAction()); const replaced = await run(id);
    expect(replaced.wait?.kind, JSON.stringify(replaced)).toBe("quiz_submission");
    expect(replaced.wait?.refId).not.toBe(original.id);
    expect(attempt(original.id)).toEqual(original);
    expect(assessment(id).canAutoFinish).toBe(false);
    const claims = () => stores(learning => learning.database.prepare("SELECT body_json FROM learning_agent_artifacts WHERE task_id=? AND action_id='disputed-quiz-replacement'").all(id)) as Array<{ body_json: string }>;
    expect(claims()).toHaveLength(1); expect(JSON.parse(claims()[0].body_json)).toMatchObject({ recordType: "disputed_quiz_replacement", replacement: { quizId: original.quizId, eventId: feedback.eventId } });
    const before = generation.mock.calls.length;
    await control(id, feedback); await GET(request(), routeContext()); await run(id); await run(id);
    expect(generation).toHaveBeenCalledTimes(before); expect(claims()).toHaveLength(1);
    const second = await answer(task(id), false);
    candidates.push({ tool: "learning.read_answers", args: { attemptId: second.id } }, association(reference(second)), waitAction); await run(id);
    await control(id, { action: "dispute_quiz", attemptId: second.id, feedback: "这组也有疑问，先停一下。" });
    await control(id, { action: "resume" }); candidates.push(waitAction); await run(id);
    await control(id, { action: "feedback", feedback: "换一组继续吧。" }); candidates.push(quizAction());
    const stopped = await run(id);
    expect(stopped.status).toBe("ended"); expect(generation).toHaveBeenCalledTimes(before);
    expect(assessment(id).outcome).not.toBe("check_passed"); expect(attempt(original.id)).toEqual(original);
  // This whole persisted multi-restart flow takes over the default 5 seconds
  // on Windows. Keep a finite integration-test bound; product budgets are unchanged.
  }, 15_000);
  it("replacement words without a real dispute do not bypass the same-method gate", async () => {
    const waiting = await firstQuiz(plan("practice")), a = await answer(waiting, false);
    candidates.push({ tool: "learning.read_answers", args: { attemptId: a.id } }, association(reference(a)), waitAction); await run(waiting.id);
    // First use of the actual new wrong observation is allowed. After that,
    // repeating the same method without another observation remains blocked.
    await control(waiting.id, { action: "feedback", feedback: "换一组继续吧。" }); candidates.push(quizAction());
    const next = await run(waiting.id);
    if (next.wait?.kind === "quiz_submission") {
      await control(waiting.id, { action: "pause" }); await control(waiting.id, { action: "resume" });
      await run(waiting.id);
    }
    expect(stores(learning => learning.database.prepare("SELECT id FROM learning_agent_artifacts WHERE task_id=? AND action_id='disputed-quiz-replacement'").all(waiting.id))).toEqual([]);
  });
  it("practice: wrong answer, explanation and a related new check finish from evidence without rewriting the old score", async () => {
    candidates.push(planAction(plan("practice")), quizAction());
    const id = await create("我想练练这部分。"); const firstWait = await run(id);
    expect(firstWait.wait?.kind).toBe("quiz_submission");
    const first = await answer(firstWait, false);
    expect(assessment(id)).toMatchObject({ plan: { kind: "practice" }, outcome: "partial", canAutoFinish: false });
    candidates.push({ tool: "learning.read_answers", args: { attemptId: first.id } }, input => {
      expect(input.results.find(r => r.tool === "learning.read_answers")?.value).toMatchObject({ score: { correct: 0, total: 1 } });
      return association(reference(first));
    }, explainAction(), waitAction);
    const explained = await run(id);
    expect(explained).toMatchObject({ status: "waiting", wait: { kind: "feedback" } });
    expect(explained.actions.find(a => a.tool === "learning.explain")?.status).toBe("succeeded");
    expect(assessment(id).objectives[0].unresolvedErrors).toEqual([reference(first)]);
    await control(id, { action: "feedback", feedback: "明白一些了，再试试。" });
    generatedStems.push("[离线题目] 新案例中必要前提不成立，还能直接使用该规则得出结论吗？");
    candidates.push(quizAction(purpose("concept", { method: "application", priorEvidenceRefs: [reference(first)] })));
    const secondWait = await run(id); expect(secondWait.wait?.kind).toBe("quiz_submission");
    const chosen = await act(attempt(secondWait.wait!.refId!), "choose", "A");
    const finalAction = { id: randomUUID(), attemptId: chosen.id, revision: chosen.revision, action: "finish", question: 0, optionId: null };
    const submitted = await quizPatch(request("PATCH", { kind: "act", value: finalAction }, "quiz"), routeContext());
    expect(submitted.status).toBe(200); const second = (await submitted.json()).attempt as QuizAttemptView;
    // A correct new question ID alone does not resolve the old counterevidence.
    expect(assessment(id).canAutoFinish).toBe(false);
    const beforeAssociation = decision.mock.calls.length;
    candidates.push({ tool: "learning.read_answers", args: { attemptId: second.id } },
      association(reference(second), { relation: "new_context", priorEvidenceRefs: [reference(first)] }), quizAction());
    const ended = await run(id);
    expect(ended.status).toBe("ended");
    expect(assessment(id)).toMatchObject({ outcome: "check_passed", canAutoFinish: true, objectives: [{ unresolvedErrors: [] }] });
    expect(decision).toHaveBeenCalledTimes(beforeAssociation + 2); // actual answer read + explicit association, no finish decision
    expect(generation).toHaveBeenCalledTimes(5); // two Quizzes + two reviews + one explanation, no model summary
    expect(candidates).toHaveLength(1); // extra Quiz was never requested
    expect(attempt(first.id).score?.correct).toBe(0); expect(attempt(second.id).score?.correct).toBe(1);
    const before = { calls: ended.usage.calls, decisions: decision.mock.calls.length, generations: generation.mock.calls.length };
    const refreshed = await GET(request(), routeContext()); expect(refreshed.status).toBe(200);
    const repeated = await quizPatch(request("PATCH", { kind: "act", value: finalAction }, "quiz"), routeContext());
    expect(repeated.status).toBe(200); expect((await repeated.json()).attempt).toEqual(second);
    expect((await run(id)).status).toBe("ended"); // reopens business SQLite + checkpoint
    expect(task(id).usage.calls).toBe(before.calls); expect(decision).toHaveBeenCalledTimes(before.decisions); expect(generation).toHaveBeenCalledTimes(before.generations);
  });

  it("practice can honestly hand back partial instead of requiring every historical mistake to be answered again", async () => {
    candidates.push(planAction(plan("practice", ["concept", "boundary"])), quizAction());
    const id = await create("帮我练练规则的前提和适用边界。");
    const firstWait = await run(id), first = await answer(firstWait, false);
    candidates.push({ tool: "learning.read_answers", args: { attemptId: first.id } }, association(reference(first)),
      quizAction(purpose("boundary", { method: "boundary" })));
    generatedStems.push("[离线题目] 当适用前提不满足时，可以直接采用规则吗？");
    const secondWait = await run(id); await answer(secondWait, true);
    candidates.push({ finish: "本轮先到这里，不再反复出题。" });
    const ended = await run(id), result = assessment(id);
    expect(ended.status).toBe("ended"); expect(result.outcome).toBe("partial");
    expect(result.objectives.find(o => o.id === "concept")?.unresolvedErrors).toEqual([reference(first)]);
    expect(result.objectives.find(o => o.id === "boundary")?.status).toBe("supported");
    expect(ended.endReason).not.toContain("检查通过"); expect(ended.endReason).not.toContain("诊断已完成");
    expect(attempt(first.id).score?.correct).toBe(0); expect(generation).toHaveBeenCalledTimes(4);
  });

  it("C01/C10 stops after sufficient saved first-answer evidence without another decision or generation", async () => {
    const waiting = await firstQuiz(); const before = decision.mock.calls.length;
    const hidden = await quizGet(new Request(`${origin}/api/learning/pages/${pageId}/quiz?attempt=${waiting.wait!.refId}`, { headers: { "x-synthetic-user": "owner" } }), routeContext());
    expect(JSON.stringify(await hidden.json())).not.toMatch(/correctOptionId|explanation|score":\{/);
    const hiddenTask = await GET(request(), routeContext()); expect(JSON.stringify(await hiddenTask.json())).not.toContain("SECRET_MAPPING_ANSWER");
    expect(waiting.usage.calls).toBe(4); // two controlled decisions + one generation + one independent review
    const a = await answer(waiting); expect(a.score).toMatchObject({ correct: 1, total: 1 });
    candidates.push(quizAction());
    const ended = await run(waiting.id);
    expect(ended.status).toBe("ended"); expect(assessment(waiting.id).outcome).toBe("check_passed");
    expect(generation).toHaveBeenCalledTimes(2); expect(decision).toHaveBeenCalledTimes(before);
    expect(candidates).toHaveLength(1); expect(assessment(waiting.id).longTermMastery).toBe("unverified");
    // History was not authorized; current first response is unassisted in-app, while uninspected past answer exposure remains unknown.
    expect(assessment(waiting.id).objectives[0].evidence[0]).toMatchObject({ answerAvailability: "unknown", independentInApp: true, quality: "tentative" });
    // Normal post-submit feedback exists, but does not retroactively turn the first answer into an exposed correction.
    expect(attempt(a.id).questions[0].feedback?.explanation).toBeTruthy();
  });

  it("C02 retains the unchecked core goal despite a perfect saved total", async () => {
    const waiting = await firstQuiz(plan("chapter_check", ["concept", "boundary"])); const a = await answer(waiting);
    candidates.push({ tool: "learning.read_answers", args: { attemptId: a.id } }, input => {
      const actual = input.results.find(r => r.tool === "learning.read_answers")?.value;
      expect(actual).toMatchObject({ attemptId: a.id, score: { correct: 1, total: 1 }, questions: [{ selectedOptionId: "A", progress: { submitted: true } }] });
      return waitAction;
    }); await run(waiting.id);
    const result = assessment(waiting.id);
    expect(result.outcome).toBe("partial"); expect(result.objectives.find(o => o.id === "concept")?.status).toBe("supported");
    expect(result.objectives.find(o => o.id === "boundary")?.status).toBe("unobserved"); expect(result.canAutoFinish).toBe(false);
  });

  it("C03 preserves hinted correctness but never treats it as independent support", async () => {
    const waiting = await firstQuiz(); const a = await answer(waiting, true, true);
    candidates.push({ finish: "已经完全掌握，通过" }); await run(waiting.id);
    expect(a.score).toMatchObject({ correct: 1, hinted: 1, unassistedCorrect: 0 });
    const result = assessment(waiting.id); expect(result.outcome).not.toBe("check_passed");
    expect(result.objectives[0].evidence[0]).toMatchObject({ correct: true, hintedBeforeSubmission: true, independentInApp: false });
  });

  it("C04 keeps a prior error unresolved after exact-repeat correction and a later distinct wrong answer", async () => {
    const waiting = await firstQuiz(plan("targeted_review")); const original = await answer(waiting, false);
    candidates.push(quizAction(purpose("concept", { method: "contrast", priorEvidenceRefs: [reference(original)],
      methodChange: { previousResultId: original.quizId, difference: "先对比原先错误选择与保存解析，观察原题订正是否只是记住答案", expectedObservation: "重复题订正不作为新情境支持" } })));
    const repeatWait = await run(waiting.id); expect(repeatWait.wait?.kind).toBe("quiz_submission");
    const repeated = await answer(repeatWait, true);
    generatedStems.push("[离线题目] 假设一个新案例：条件未成立时，可以直接应用此规则吗？");
    candidates.push(association(reference(repeated), { relation: "followup", priorEvidenceRefs: [reference(original)] }),
      quizAction(purpose("concept", { role: "followup", method: "application", priorEvidenceRefs: [reference(original)] })));
    const followupWait = await run(waiting.id); expect(followupWait.wait?.kind).toBe("quiz_submission");
    const followup = await answer(followupWait, false);
    candidates.push(association(reference(followup), { role: "followup", relation: "new_context", priorEvidenceRefs: [reference(original)] }), { finish: "结束本轮" });
    expect((await run(waiting.id)).status).toBe("ended");
    const result = assessment(waiting.id);
    expect(result.outcome).not.toBe("check_passed");
    expect(result.objectives[0].evidence.find(e => e.ref.quizId === repeated.quizId)?.repetition).toBe("known_repeat");
    expect(result.objectives[0].unresolvedErrors).toContainEqual(reference(original));
    expect(attempt(original.id).score?.correct).toBe(0); expect(attempt(repeated.id).score?.correct).toBe(1); expect(attempt(followup.id).score?.correct).toBe(0);
  });

  it("C05 does not let a correct concept answer erase a wrong boundary observation", async () => {
    const waiting = await firstQuiz(plan("chapter_check", ["concept", "boundary"])); await answer(waiting);
    generatedStems.push("[离线题目] 对没有满足前提的情况，直接应用规则是否合理？");
    candidates.push(quizAction(purpose("boundary", { method: "boundary" })));
    const boundaryWait = await run(waiting.id); await answer(boundaryWait, false);
    candidates.push({ finish: "结束" }); await run(waiting.id);
    const result = assessment(waiting.id);
    expect(result.outcome).toBe("partial"); expect(result.objectives.find(o => o.id === "concept")?.status).toBe("supported");
    expect(result.objectives.find(o => o.id === "boundary")?.requirements[0].supported).toBe(false);
    expect(result.objectives.find(o => o.id === "boundary")?.unresolvedErrors).toHaveLength(1);
  });

  it("C06 excludes a newly disputed saved score without changing it or calling the model on GET", async () => {
    const waiting = await firstQuiz(); const a = await answer(waiting); await run(waiting.id);
    expect(assessment(waiting.id).outcome).toBe("check_passed");
    await control(waiting.id, { action: "dispute_quiz", attemptId: a.id, feedback: "[合成] 本题条件有疑问，请先暂停判断。" });
    const before = decision.mock.calls.length; const response = await GET(request(), routeContext()); expect(response.status).toBe(200);
    expect(assessment(waiting.id).outcome).not.toBe("check_passed"); expect(attempt(a.id).score?.correct).toBe(1);
    expect(decision).toHaveBeenCalledTimes(before);
  });

  it("C06 excludes an explicit known content issue without pretending it was independently verified", async () => {
    const waiting = await firstQuiz(plan("chapter_check", ["concept", "boundary"])); const a = await answer(waiting);
    // Formal association now requires a successful read in this task version;
    // the provider fixture must observe the actual saved answer before judging it.
    candidates.push({ tool: "learning.read_answers", args: { attemptId: a.id } }, association(reference(a), { contentStatus: "known_issue" }), { finish: "停止判断" }); await run(waiting.id);
    expect(task(waiting.id).actions).toContainEqual(expect.objectContaining({ tool: "learning.read_answers", status: "succeeded" }));
    const evidence = assessment(waiting.id).objectives[0].evidence[0];
    expect(evidence).toMatchObject({ quality: "known_issue", eligible: false, semanticProvenance: "model_proposal" });
    expect(assessment(waiting.id).outcome).not.toBe("check_passed"); expect(attempt(a.id).score?.correct).toBe(1);
  });

  it("C06 invalidates the old conclusion and source bodies after formal material deletion", async () => {
    const waiting = await firstQuiz(); await answer(waiting); await run(waiting.id);
    stores(learning => learning.deleteMaterial(pageId, materialId));
    const response = await GET(request(), routeContext()); expect(response.status).toBe(200);
    const body = await response.json(); expect(JSON.stringify(body)).not.toContain("只有前提成立");
    expect(body.tasks.find((t: { id: string }) => t.id === waiting.id).endReason).not.toMatch(/^本轮约定目标检查通过/);
    expect(assessment(waiting.id).outcome).toBe("stale");
  });

  it("C08 requires explicit resolution, persists it across reopen, and needs no Quiz", async () => {
    candidates.push(planAction(plan("explanation")), explainAction(), waitAction); const id = await create("[合成] 请解释前提为什么重要");
    const waiting = await run(id); expect(waiting.status).toBe("waiting");
    const explanationId = waiting.actions.find(a => a.tool === "learning.explain")!.resultRef!.id;
    const thanks = { action: "feedback", feedback: "谢谢", eventId: randomUUID() };
    await control(id, thanks); candidates.push(waitAction); await run(id);
    expect(assessment(id).outcome).toBe("insufficient"); const calls = decision.mock.calls.length;
    const nextWait = task(id).wait?.refId;
    await control(id, thanks); expect((await run(id)).wait?.refId).toBe(nextWait); expect(decision).toHaveBeenCalledTimes(calls);
    await control(id, { action: "explanation_feedback", explanationId, outcome: "resolved" });
    // Every run opens new Learning/task/checkpoint connections; feedback is not memory-only.
    expect((await run(id)).status).toBe("ended"); expect(assessment(id).outcome).toBe("explanation_resolved");
    expect(decision).toHaveBeenCalledTimes(calls); expect(generation).toHaveBeenCalledTimes(1);
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId))).toEqual([]);
    const usage = task(id).usage;
    await control(id, { action: "explanation_feedback", explanationId, outcome: "resolved" });
    expect(task(id).usage).toEqual(usage); expect((await run(id)).status).toBe("ended"); expect(decision).toHaveBeenCalledTimes(calls);
    const changed = await PATCH(request("PATCH", { id, eventId: randomUUID(), expectedVersion: 1, action: "explanation_feedback", explanationId, outcome: "needs_clarification" }), routeContext());
    expect(changed.status).toBe(409);
  });

  it("C08 preserves each feedback round and accepts later resolution of the same explanation without a new explanation or Quiz", async () => {
    const ask: AgentDecision = { tool: "learning.request_feedback", args: { question: "请确认目前的解释是否解决了疑问。" } };
    candidates.push(planAction(plan("explanation")), explainAction(), ask); const id = await create("[合成] 请解释规则的前提");
    const firstWait = await run(id), explanationId = firstWait.actions.find(a => a.tool === "learning.explain")!.resultRef!.id;
    expect(firstWait.wait?.refId).toMatch(/^feedback:/);
    const firstFeedback = { id, eventId: randomUUID(), expectedVersion: 1, action: "explanation_feedback", explanationId, outcome: "needs_clarification" };
    const firstResponse = await PATCH(request("PATCH", firstFeedback), routeContext()); expect(firstResponse.status).toBe(202);
    // A queued response is immutable. A changed answer cannot replace that event before processing.
    const conflicting = await PATCH(request("PATCH", { ...firstFeedback, outcome: "resolved" }), routeContext()); expect(conflicting.status).toBe(409);
    candidates.push({ tool: "learning.request_feedback", args: { question: "请再看已有解释的前提区分；现在是否解决了疑问？" } });
    const secondWait = await run(id); expect(secondWait.status).toBe("waiting"); expect(secondWait.wait?.refId).not.toBe(firstWait.wait?.refId);
    expect(assessment(id).outcome).toBe("insufficient");
    const calls = decision.mock.calls.length, before = task(id).usage;
    const replay = await PATCH(request("PATCH", firstFeedback), routeContext());
    expect(replay.status).toBe(202); expect((await replay.json()).scheduled).toBe(false);
    expect(task(id).wait?.refId).toBe(secondWait.wait?.refId); expect(task(id).usage).toEqual(before);
    expect((await run(id)).status).toBe("waiting"); expect(decision).toHaveBeenCalledTimes(calls);
    const resolved = { ...firstFeedback, eventId: randomUUID(), outcome: "resolved" };
    expect((await PATCH(request("PATCH", resolved), routeContext())).status).toBe(202);
    expect((await run(id)).status).toBe("ended"); expect(assessment(id).outcome).toBe("explanation_resolved");
    expect(decision).toHaveBeenCalledTimes(calls); expect(generation).toHaveBeenCalledTimes(1);
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId))).toEqual([]);
    const records = stores(learning => learning.database.prepare("SELECT body_json FROM learning_agent_artifacts WHERE task_id=? AND kind='explanation_feedback' ORDER BY rowid").all(id)) as Array<{ body_json: string }>;
    expect(records.map(row => JSON.parse(row.body_json).outcome)).toEqual(["needs_clarification", "resolved"]);
    const after = task(id).usage;
    const duplicate = await PATCH(request("PATCH", { ...resolved, eventId: randomUUID() }), routeContext());
    expect(duplicate.status).toBe(202); expect((await duplicate.json()).scheduled).toBe(false);
    expect(task(id).usage).toEqual(after); expect(decision).toHaveBeenCalledTimes(calls);
  });

  it("C07 blocks repeated explanation generation while retaining a feedback opportunity for the same unresolved gap", async () => {
    candidates.push(planAction(), explainAction(), waitAction); const id = await create(); await run(id);
    await control(id, { action: "feedback", feedback: "[合成] 还是不能区分前提，请再说明。" }); candidates.push(explainAction());
    const waiting = await run(id); expect(waiting.status, JSON.stringify(waiting)).toBe("waiting");
    expect(waiting.wait).toMatchObject({ kind: "feedback", message: expect.stringContaining("进一步说明") });
    expect(waiting.endReason).toBeUndefined();
    expect(generation).toHaveBeenCalledTimes(1); expect(assessment(id).outcome).toBe("insufficient");
  });

  it("NQ-S2 preserves the first explicit explanation response through a repeated action, restart and thanks", async () => {
    candidates.push(planAction(plan("explanation")), explainAction(), explainAction());
    const id = await create("我不理解具体的定义 帮帮我");
    const first = await run(id), explanationId = first.actions.find(action => action.tool === "learning.explain")!.resultRef!.id;
    expect(first.status).toBe("waiting"); expect(first.wait?.kind).toBe("feedback");
    expect(first.actions.filter(action => action.tool === "learning.explain")).toHaveLength(2);
    expect(generation).toHaveBeenCalledTimes(1);
    const calls = first.usage.calls;
    // run() closes and reopens the actual repository, task store and checkpoint.
    expect((await run(id)).usage.calls).toBe(calls);
    await control(id, { action: "feedback", feedback: "谢谢" });
    candidates.push(explainAction());
    const thanks = await run(id);
    expect(thanks.status).toBe("waiting"); expect(assessment(id).outcome).toBe("insufficient");
    expect(generation).toHaveBeenCalledTimes(1);
    const before = thanks.usage.calls, decisions = decision.mock.calls.length;
    const response = { action: "explanation_feedback", explanationId, outcome: "resolved" };
    await control(id, response);
    expect((await run(id)).status).toBe("ended"); expect(assessment(id).outcome).toBe("explanation_resolved");
    expect(task(id).usage.calls).toBe(before); expect(decision).toHaveBeenCalledTimes(decisions);
    await control(id, response);
    expect(task(id).usage.calls).toBe(before); expect(generation).toHaveBeenCalledTimes(1);
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId))).toEqual([]);
  });

  it("NQ-S2 handles one concrete clarification with the same method, then waits instead of reusing that feedback", async () => {
    candidates.push(planAction(plan("explanation")), explainAction(), explainAction());
    const id = await create("我不理解具体的定义，帮帮我"), first = await run(id);
    const originalId = first.actions.find(action => action.tool === "learning.explain")!.resultRef!.id;
    const message = "仍不清楚为什么前提不成立与结论不成立不同，请举例说明。";
    const feedback = { action: "explanation_feedback", explanationId: originalId, outcome: "needs_clarification", message, eventId: randomUUID() };
    await control(id, feedback);
    candidates.push(explainAction(), explainAction());
    const waiting = await run(id);
    expect(waiting.status).toBe("waiting"); expect(generation).toHaveBeenCalledTimes(2);
    expect(generation.mock.calls[1][3]).toMatchObject({ followupFeedback: { explanationId: originalId, message } });
    expect(assessment(id).outcome).toBe("insufficient");
    const explained = waiting.actions.filter(action => action.tool === "learning.explain");
    const latestId = explained.at(-1)!.resultRef!.id;
    expect(latestId).not.toBe(originalId); expect(explained.at(-2)!.resultRef?.id).toBe(latestId);
    const calls = waiting.usage.calls;
    await control(id, feedback);
    expect((await run(id)).usage.calls).toBe(calls); expect(generation).toHaveBeenCalledTimes(2);
    await control(id, { action: "explanation_feedback", explanationId: latestId, outcome: "resolved" });
    expect((await run(id)).status).toBe("ended"); expect(assessment(id).outcome).toBe("explanation_resolved");
    expect(task(id).usage.calls).toBe(calls);
  });

  it("C07 permits a concretely different method while retaining the same unmet objective", async () => {
    candidates.push(planAction(), explainAction(), waitAction); const id = await create(); await run(id);
    await control(id, { action: "feedback", feedback: "[合成] 我需要对比两个情况。" });
    const explanationId = task(id).actions.find(a => a.tool === "learning.explain")!.resultRef!.id;
    candidates.push(explainAction(purpose("concept", { method: "contrast", purpose: "对比前提不成立与规则应用后未通过这两种情形",
      methodChange: { previousResultId: explanationId, difference: "把只有一个定义的说明改为并列两个前提不同的案例", expectedObservation: "请用户指出两例分别应先检查的条件" } })), waitAction);
    expect((await run(id)).status).toBe("waiting"); expect(generation).toHaveBeenCalledTimes(2);
    expect(assessment(id).outcome).toBe("insufficient");
  });

  it("C07 does not count a new quiz ID with another same-method wrong observation as progress", async () => {
    const waiting = await firstQuiz(); await answer(waiting, false);
    generatedStems.push("[离线题目] 假设条件仍未成立，规则能否直接应用？");
    candidates.push(quizAction()); const secondWait = await run(waiting.id);
    if (secondWait.status === "waiting") {
      await answer(secondWait, false); candidates.push(quizAction());
    }
    const stopped = secondWait.status === "ended" ? secondWait : await run(waiting.id);
    expect(stopped.status, JSON.stringify(stopped)).toBe("ended"); expect(stopped.endReason).toContain("同类方法");
    expect(generation.mock.calls.length).toBeLessThanOrEqual(4); expect(assessment(waiting.id).outcome).not.toBe("check_passed");
  });

  it("completes diagnosis from actual wrong observations without forcing remediation to all-correct", async () => {
    const waiting = await firstQuiz(plan("diagnosis")); const a = await answer(waiting, false); const calls = decision.mock.calls.length;
    expect((await run(waiting.id)).status).toBe("ended"); expect(assessment(waiting.id).outcome).toBe("diagnosis_complete");
    expect(attempt(a.id).score?.correct).toBe(0); expect(generation).toHaveBeenCalledTimes(2); expect(decision).toHaveBeenCalledTimes(calls);
    expect(assessment(waiting.id).longTermMastery).toBe("unverified");
  });

  it("deduplicates actual submission and concurrent reopened resumes without new generation", async () => {
    const waiting = await firstQuiz(); const a = await answer(waiting); const count = decision.mock.calls.length;
    await Promise.all([control(waiting.id, { action: "sync_quiz", attemptId: a.id }), control(waiting.id, { action: "sync_quiz", attemptId: a.id })]);
    await Promise.all([run(waiting.id), run(waiting.id)]);
    expect(task(waiting.id).status).toBe("ended"); expect(generation).toHaveBeenCalledTimes(2); expect(decision).toHaveBeenCalledTimes(count);
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId))).toHaveLength(1);
    expect(attempt(a.id).score?.correct).toBe(1);
  });

  it("rechecks a genuinely persisted prepared action after pause and checkpoint reopen before any generation", async () => {
    const waiting = await firstQuiz(plan("chapter_check", ["concept", "boundary"])); const a = await answer(waiting);
    // The offline model wrongly proposes another check of an already-supported
    // objective. The still-unchecked boundary prevents decision-level auto-finish.
    candidates.push(quizAction()); const paused = await run(waiting.id, true);
    expect(paused.status).toBe("paused");
    const prepared = paused.actions.at(-1)!;
    expect(prepared).toMatchObject({ tool: "learning.create_quiz", status: "prepared", version: 1 });
    expect(generation).toHaveBeenCalledTimes(2);
    // run() has closed all databases. Resume must use the saved action identity;
    // it must not ask the fixture for another action before checking this one.
    await control(waiting.id, { action: "resume" });
    candidates.push(input => {
      expect(input.results.find(result => result.actionId === prepared.id)).toMatchObject({ tool: "learning.create_quiz", status: "failed" });
      return { finish: "当前核心边界仍未覆盖，本轮交回。" };
    });
    const ended = await run(waiting.id);
    expect(ended.status).toBe("ended"); expect(ended.actions.find(action => action.id === prepared.id)?.status).toBe("failed");
    expect(assessment(waiting.id).outcome).toBe("partial"); expect(generation).toHaveBeenCalledTimes(2);
    expect(stores(learning => new LearningQuizRepository(learning).list(pageId))).toHaveLength(1);
    expect(attempt(a.id).score?.correct).toBe(1); expect(candidates).toHaveLength(0);
  });

  it("waits across reopened SQLite/checkpoint connections and GETs with zero extra calls", async () => {
    const waiting = await firstQuiz(); const calls = decision.mock.calls.length, usage = waiting.usage.calls;
    expect((await run(waiting.id)).status).toBe("waiting");
    for (let index = 0; index < 2; index++) expect((await GET(request(), routeContext())).status).toBe(200);
    await control(waiting.id, { action: "pause" }); await run(waiting.id); await control(waiting.id, { action: "resume" }); await run(waiting.id);
    expect(task(waiting.id).status).toBe("waiting"); expect(task(waiting.id).usage.calls).toBe(usage); expect(decision).toHaveBeenCalledTimes(calls);
    await control(waiting.id, { action: "cancel" }); await run(waiting.id); expect(task(waiting.id).status).toBe("cancelled");
    expect(assessment(waiting.id).outcome).not.toBe("check_passed"); expect(generation).toHaveBeenCalledTimes(2);
  });

  it("rejects missing-plan, stale-version and model-supplied objective feedback without writes", async () => {
    const id = await create(), explanationId = randomUUID();
    const missing = await PATCH(request("PATCH", { id, eventId: randomUUID(), expectedVersion: 1, action: "explanation_feedback", explanationId, outcome: "resolved" }), routeContext());
    expect(missing.status).toBe(409);
    const extra = await PATCH(request("PATCH", { id, eventId: randomUUID(), expectedVersion: 1, action: "explanation_feedback", explanationId, outcome: "resolved", objectiveIds: ["made-up"] }), routeContext());
    expect(extra.status).toBe(400);
    const stale = await PATCH(request("PATCH", { id, eventId: randomUUID(), expectedVersion: 2, action: "explanation_feedback", explanationId, outcome: "resolved" }), routeContext());
    expect(stale.status).toBe(409); expect(task(id).usage.calls).toBe(0); expect(generation).not.toHaveBeenCalled();
    expect(assessment(id).plan).toBeNull();
  });

  it("C08 preserves old grades and cumulative calls but never carries a pass into an adjusted goal", async () => {
    const waiting = await firstQuiz(plan("chapter_check", ["concept", "boundary"])); const a = await answer(waiting);
    candidates.push(waitAction); await run(waiting.id); const previous = task(waiting.id);
    await control(waiting.id, { action: "adjust", goal: "[合成] 只检查边界", scope: selection() });
    const current = task(waiting.id); expect(current.version).toBe((previous.version ?? 1) + 1); expect(current.usage.calls).toBe(previous.usage.calls);
    expect(assessment(waiting.id).outcome).not.toBe("check_passed"); expect(attempt(a.id).score?.correct).toBe(1);
    const stale = await PATCH(request("PATCH", { id: waiting.id, eventId: randomUUID(), action: "feedback", expectedVersion: previous.version, attemptId: a.id }), routeContext());
    expect(stale.status).toBe(409);
    await control(waiting.id, { action: "end" }); expect(task(waiting.id).status).toBe("ended"); expect(assessment(waiting.id).outcome).not.toBe("check_passed");
  });

  it("explicitly re-associates authorized prior-version evidence and exposes its original clickable Quiz without rewriting the grade", async () => {
    const waiting = await firstQuiz(plan("chapter_check", ["concept", "boundary"])); const a = await answer(waiting);
    candidates.push(waitAction); await run(waiting.id);
    await control(waiting.id, { action: "adjust", goal: "[合成] 在新范围核对前提，允许使用相关历史", scope: { ...selection(), includeHistory: true } });
    expect(assessment(waiting.id).plan).toBeNull();
    // History authorization permits reading; it does not carry a prior-version
    // read receipt forward or replace a fresh read before explicit association.
    const callsBefore = task(waiting.id).usage.calls;
    candidates.push(planAction(), { tool: "learning.read_answers", args: { attemptId: a.id } }, association(reference(a))); const ended = await run(waiting.id);
    expect(ended.actions).toContainEqual(expect.objectContaining({ tool: "learning.read_answers", status: "succeeded", version: ended.version }));
    expect(ended.usage.calls).toBe(callsBefore + 3); // plan, actual answer read and explicit association decisions
    expect(ended.status).toBe("ended"); expect(assessment(waiting.id).outcome).toBe("check_passed");
    const response = await GET(request(), routeContext()), body = await response.json();
    expect(body.tasks.find((t: { id: string }) => t.id === waiting.id).quizLinks).toContainEqual({ quizId: a.quizId, attemptId: a.id, completed: true, disputed: false, historical: true });
    expect(attempt(a.id).score).toEqual(a.score); expect(generation).toHaveBeenCalledTimes(2);
  });

  it("C09 permits early finish without manufacturing a passed learning result", async () => {
    candidates.push(planAction(), { finish: "用户已经掌握所有目标，本轮检查通过。" }); const id = await create();
    expect((await run(id)).status).toBe("ended"); const result = assessment(id);
    expect(result.outcome).toBe("insufficient"); expect(result.support).toBe("insufficient"); expect(result.headline).toContain("证据不足");
    expect(result.headline).not.toMatch(/^本轮约定目标检查通过/); expect(generation).not.toHaveBeenCalled();
  });
});
