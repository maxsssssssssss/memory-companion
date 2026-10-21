// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@/lib/domain/agent";
import type { LearningAgentScope } from "@/lib/domain/learning-agent";
import type { LearningCompletionAssessment, LearningEvidenceProposal, LearningReviewPlan } from "@/lib/domain/learning-agent-completion";
import type { QuizAttemptView } from "@/lib/domain/learning-quiz";
import type { AgentContext, AgentDecision, AgentDecisionProvider } from "@/lib/server/agent/types";
import { AgentStore } from "@/lib/server/agent/store";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningAgentRepository } from "./agent-repository";
import { freezeLearningAgentScope, readLearningAgentScope } from "./agent-scope";
import { assessLearningCompletion, establishLearningReviewPlan } from "./agent-completion";
import { loadLearningCompletionEvidence } from "./agent-completion-evidence";
import { materializeLearningPlanSourceAdjustment, prepareLearningPlanSourceAdjustment } from "./agent-plan-sources";
import { quizReviewQuestionKey } from "./quiz-review-purpose";
import { completePreContractQuizFixture } from "./testing/pre-contract-quiz.fixture";
import { projectPendingLearningHistory } from "./agent-completion-history";
import { createLearningAgentScenario } from "./agent-scenario";
import { withLearningCompletionDecision } from "./agent-context";
import type { generateStudyJson } from "./framework-generator";

let directory: string, learning: LearningRepository, quizzes: LearningQuizRepository, pageId: string, materialId: string, ctx: AgentContext;
let originalPlan: LearningReviewPlan;
const selection = (includeHistory = false) => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, includeHistory });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "completion-history-")); learning = new LearningRepository(directory, "owner"); quizzes = new LearningQuizRepository(learning);
  pageId = randomUUID(); materialId = randomUUID(); learning.create({ id: pageId, title: "[合成] 历史恢复" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 条件", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 章节概览。\n\n[合成] 只有前提满足才可应用规则。前提未满足时不能直接应用规则。") }]);
  const task: AgentTask = { id: randomUUID(), accountId: "owner", scenario: "learning.adaptive-review.v1", resourceId: pageId,
    version: 1, goal: "[合成] 检查规则前提", scope: { ...freezeLearningAgentScope(learning, pageId, selection()), completionVersion: 1 }, status: "running", actions: [],
    budget: { maxCalls: 16, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 100000, maxSteps: 16, maxNoProgress: 3 },
    usage: { calls: 5, inputTokens: 100, outputTokens: 20, unknownUsageCalls: 0, computeMs: 100, steps: 5 }, createdAt: "synthetic", updatedAt: "synthetic" };
  ctx = { task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {}, call: async (_request, invoke) => (await invoke()).value };
  originalPlan = establishLearningReviewPlan(learning, ctx, { kind: "chapter_check", objectives: [{ id: "rule", label: "判断规则前提", sources: [{ materialId, paragraph: 1 }],
    requirements: [{ role: "boundary", description: "判断前提不成立的情况", independent: true }] }] });
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("network_forbidden"); }));
});
afterEach(async () => { learning.close(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

function group(answer: "wrong" | "hint" | "pending" = "wrong", ownTaskId = ctx.task.id, includeReview = true, includeChecks = true, reviewVersion = 1) {
  const id = randomUUID(), input = quizzes.begin(pageId, { id, settings: { materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" } }, 24000)!;
  const reference = input.materials[0].paragraphs[1].referenceId;
  const question = { stem: "[合成] 前提未满足时能直接应用规则吗？", kind: "concept" as const,
    options: [{ id: "A" as const, text: "不能应用", reason: "只有前提满足才可应用规则。", evidenceIds: [reference] },
      { id: "B" as const, text: "能够应用", reason: "前提未满足时不能直接应用规则。", evidenceIds: [reference] }],
    correctOptionId: "A" as const, hint: null, explanation: "只有前提满足才可应用规则。", stemEvidenceIds: [reference], explanationEvidenceIds: [reference] };
  completePreContractQuizFixture(learning, pageId, id, { contractVersion: "references-v2", title: "[合成] 规则检查", reason: null, items: [question] }, includeReview ? {
    context: { planId: originalPlan.id, taskVersion: reviewVersion, objectives: originalPlan.objectives,
      purpose: { objectiveIds: ["rule"], role: "boundary", method: "boundary", purpose: "检查前提", priorEvidenceRefs: [] } },
    candidates: includeChecks ? [{ questionKey: quizReviewQuestionKey(question), check: { objectiveIds: ["rule"], role: "boundary", rationale: "PRIVATE_RATIONALE：前提不满足时不能使用。" } }] : [] } : undefined);
  let attempt = quizzes.startAttempt(pageId, { id: randomUUID(), quizId: id, mode: "practice" });
  const act = (action: "hint" | "choose" | "submit", optionId: string | null = null) => {
    attempt = quizzes.act(pageId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action, question: 0, optionId });
  };
  if (answer !== "pending") { if (answer === "hint") act("hint"); act("choose", answer === "hint" ? "A" : "B"); act("submit"); }
  const artifacts = new LearningAgentRepository(learning);
  artifacts.reserve({ id, taskId: ownTaskId, taskVersion: 1, pageId, kind: "quiz", actionId: randomUUID(), binding: (ctx.task.scope as LearningAgentScope).fingerprint, materialIds: [materialId] });
  artifacts.complete(pageId, ownTaskId, id, { attemptId: attempt.id });
  return attempt;
}
async function adjust(includeHistory = true) {
  const scope = { ...freezeLearningAgentScope(learning, pageId, selection(includeHistory)), completionVersion: 1 as const };
  const snapshot = prepareLearningPlanSourceAdjustment(learning, ctx.task, { goal: ctx.task.goal, scope }, [{ objectiveId: "rule", sources: [{ materialId, paragraph: 2 }] }]);
  ctx.task = { ...ctx.task, version: 2, scope: { ...scope, planSourceAdjustment: snapshot } };
  await materializeLearningPlanSourceAdjustment(learning, ctx);
  const row = new LearningAgentRepository(learning).list(pageId, ctx.task.id).find(r => r.kind === "review_plan" && r.task_version === 2)!;
  return JSON.parse(row.body_json!) as LearningReviewPlan;
}
const proposal = (attempt: QuizAttemptView): LearningEvidenceProposal => ({ ref: { quizId: attempt.quizId, attemptId: attempt.id, questionIndex: 0 },
  objectiveId: "rule", role: "boundary", rationale: "[离线语义提案] 原题实际检查规则的必要条件。", relevance: "supported", relation: "initial", priorEvidenceRefs: [], contentStatus: "no_known_issue" });
function read(attempt: QuizAttemptView, version = 2, status: "succeeded" | "failed" = "succeeded") {
  ctx.task.actions.push({ id: randomUUID(), version, tool: "learning.read_answers", summary: "读取旧作答", status,
    reason: "读取旧作答", resultRef: { kind: "learning.answers", id: attempt.id }, createdAt: "synthetic" });
}

it("returns same-task old references until both current read and explicit association exist, without carrying scores or answers", async () => {
  const attempt = group(), other = group("wrong", randomUUID()), plan = await adjust();
  const before = projectPendingLearningHistory(learning, ctx.task, plan, []);
  expect(before).toMatchObject({ enabled: true, blocked: false, pending: [{ ref: proposal(attempt).ref, read: false, unassociatedObjectiveIds: ["rule"] }] });
  expect(before.pending).toHaveLength(1); expect(JSON.stringify(before)).not.toContain(other.id);
  expect(JSON.stringify(before)).not.toContain("PRIVATE_RATIONALE"); expect(JSON.stringify(before)).not.toContain("correct");
  expect(projectPendingLearningHistory(learning, ctx.task, plan, [proposal(attempt)]).pending[0].read).toBe(false);
  read(attempt); expect(projectPendingLearningHistory(learning, ctx.task, plan, []).pending[0].unassociatedObjectiveIds).toEqual(["rule"]);
  expect(projectPendingLearningHistory(learning, ctx.task, plan, [proposal(attempt)])).toEqual({ enabled: true, blocked: false, pending: [] });
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect(ctx.task.usage.calls).toBe(5);
});

it("does not enumerate historical quizzes without explicit history permission or source-only adjustment", async () => {
  const attempt = group(), plan = await adjust(false);
  expect(projectPendingLearningHistory(learning, ctx.task, plan, [])).toEqual({ enabled: false, blocked: false, pending: [] });
  ctx.task.scope = { ...ctx.task.scope as LearningAgentScope, selection: selection(true), planSourceAdjustment: undefined };
  expect(projectPendingLearningHistory(learning, ctx.task, plan, [proposal(attempt)]).enabled).toBe(false);
});

it("does not let old-version, failed or different-attempt read receipts clear the read prerequisite", async () => {
  const attempt = group(), plan = await adjust(); read(attempt, 1); read(attempt, 2, "failed"); read({ ...attempt, id: randomUUID() });
  expect(projectPendingLearningHistory(learning, ctx.task, plan, [proposal(attempt)]).pending[0].read).toBe(false);
});

it("preserves real wrong and assisted answer facts after current authorized reassociation", async () => {
  const wrong = group(), hinted = group("hint"), plan = await adjust(); read(wrong); read(hinted);
  const proposals = [proposal(wrong), proposal(hinted)];
  expect(projectPendingLearningHistory(learning, ctx.task, plan, proposals).pending).toEqual([]);
  const evidence = loadLearningCompletionEvidence(learning, ctx.task, plan, proposals, readLearningAgentScope(learning, pageId, ctx.task.scope));
  expect(evidence[0]).toMatchObject({ historical: true, eligible: true, correct: false, independentInApp: true });
  expect(evidence[1]).toMatchObject({ historical: true, eligible: true, correct: true, hintedBeforeSubmission: true, independentInApp: false });
  expect(quizzes.attempt(pageId, wrong.id).score?.correct).toBe(0); expect(quizzes.attempt(pageId, hinted.id).score?.correct).toBe(1);
});

it("does not reveal pending test answers or their mapping through the history queue", async () => {
  const attempt = group("pending"), plan = await adjust();
  expect(projectPendingLearningHistory(learning, ctx.task, plan, []).pending).toEqual([]);
  expect(quizzes.attempt(pageId, attempt.id).questions[0].feedback).toBeUndefined();
});

it("returns only generic blocked metadata after deletion, and denies another account", async () => {
  const attempt = group(), plan = await adjust(); learning.deleteMaterial(pageId, materialId);
  const result = projectPendingLearningHistory(learning, ctx.task, plan, []);
  expect(result).toMatchObject({ enabled: true, blocked: true, pending: [], reason: "source_unavailable" });
  expect(JSON.stringify(result)).not.toContain(attempt.id); expect(JSON.stringify(result)).not.toContain("前提未满足");
  expect(() => projectPendingLearningHistory(learning, { ...ctx.task, accountId: "other" }, plan, [])).toThrow("agent_not_found");
});

it("rejects changed objectives, requirements or adjustment version rather than silently reusing old conclusions", async () => {
  group(); const plan = await adjust();
  expect(projectPendingLearningHistory(learning, ctx.task, { ...plan, objectives: [{ ...plan.objectives[0], requirements: [] }] }, []).reason).toBe("plan_mismatch");
  expect(projectPendingLearningHistory(learning, { ...ctx.task, version: 3 }, plan, []).reason).toBe("plan_mismatch");
  expect(projectPendingLearningHistory(learning, ctx.task, { ...plan, goal: "改变目标" }, []).reason).toBe("plan_mismatch");
});

it("reopens the same durable queue without a model call or score mutation", async () => {
  const attempt = group(), plan = await adjust(), before = projectPendingLearningHistory(learning, ctx.task, plan, []);
  learning.close(); learning = new LearningRepository(directory, "owner"); quizzes = new LearningQuizRepository(learning);
  expect(projectPendingLearningHistory(learning, ctx.task, plan, [])).toEqual(before);
  expect(quizzes.attempt(pageId, attempt.id).score?.correct).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([[false, false], [true, false]])("hands back missing original review or question mapping instead of inventing a clean history (%s, %s)", async (includeReview, includeChecks) => {
  const attempt = group("wrong", ctx.task.id, includeReview, includeChecks), plan = await adjust();
  const result = projectPendingLearningHistory(learning, ctx.task, plan, []);
  expect(result).toMatchObject({ enabled: true, pending: [], blocked: true, reason: "historical_record_unavailable" });
  expect(JSON.stringify(result)).not.toContain(attempt.id); expect(quizzes.attempt(pageId, attempt.id).score?.correct).toBe(0);
});

it("does not hide unread v1 counterevidence behind a second source-only correction to v3", async () => {
  const attempt = group(); await adjust();
  const scope = { ...freezeLearningAgentScope(learning, pageId, selection(true)), completionVersion: 1 as const };
  const snapshot = prepareLearningPlanSourceAdjustment(learning, ctx.task, { goal: ctx.task.goal, scope }, [{ objectiveId: "rule", sources: [{ materialId, paragraph: 2 }] }]);
  ctx.task = { ...ctx.task, version: 3, scope: { ...scope, planSourceAdjustment: snapshot } };
  await materializeLearningPlanSourceAdjustment(learning, ctx);
  const row = new LearningAgentRepository(learning).list(pageId, ctx.task.id).find(r => r.kind === "review_plan" && r.task_version === 3)!;
  const plan = JSON.parse(row.body_json!) as LearningReviewPlan;
  expect(projectPendingLearningHistory(learning, ctx.task, plan, []).pending).toMatchObject([{ ref: proposal(attempt).ref, read: false }]);
  read(attempt, 2); expect(projectPendingLearningHistory(learning, ctx.task, plan, [proposal(attempt)]).pending).toHaveLength(1);
  read(attempt, 3); expect(projectPendingLearningHistory(learning, ctx.task, plan, [proposal(attempt)]).pending).toEqual([]);
});

it("does not read old answers from a different earlier goal when repairing the current unchanged goal", async () => {
  const attempt = group();
  ctx.task = { ...ctx.task, version: 2, goal: "[合成] 不同目标", scope: { ...freezeLearningAgentScope(learning, pageId, selection(true)), completionVersion: 1 } };
  establishLearningReviewPlan(learning, ctx, { kind: "chapter_check", objectives: [{ id: "different", label: "另一个目标", sources: [{ materialId, paragraph: 1 }],
    requirements: [{ role: "concept", description: "概念辨认", independent: true }] }] });
  const scope = { ...freezeLearningAgentScope(learning, pageId, selection(true)), completionVersion: 1 as const };
  const snapshot = prepareLearningPlanSourceAdjustment(learning, ctx.task, { goal: ctx.task.goal, scope }, [{ objectiveId: "different", sources: [{ materialId, paragraph: 2 }] }]);
  ctx.task = { ...ctx.task, version: 3, scope: { ...scope, planSourceAdjustment: snapshot } };
  await materializeLearningPlanSourceAdjustment(learning, ctx);
  const row = new LearningAgentRepository(learning).list(pageId, ctx.task.id).find(r => r.kind === "review_plan" && r.task_version === 3)!;
  const spy = vi.spyOn(LearningQuizRepository.prototype, "attempt");
  expect(projectPendingLearningHistory(learning, ctx.task, JSON.parse(row.body_json!), []).pending).toEqual([]);
  expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); expect(quizzes.attempt(pageId, attempt.id).score?.correct).toBe(0);
});

it("rejects mismatched saved review identity instead of trusting a structurally valid context", async () => {
  const attempt = group("wrong", ctx.task.id, true, true, 2), plan = await adjust();
  const spy = vi.spyOn(LearningQuizRepository.prototype, "attempt");
  const result = projectPendingLearningHistory(learning, ctx.task, plan, []);
  expect(result).toMatchObject({ blocked: true, pending: [], reason: "historical_record_unavailable" });
  expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); expect(quizzes.attempt(pageId, attempt.id).score?.correct).toBe(0);
});

it("executes real reads and new associations before continuing after source adjustment, preserving hint and wrong counterevidence", async () => {
  const wrong = group(), hinted = group("hint"), store = AgentStore.open(join(directory, "history-runtime.sqlite"));
  const persisted = store.createTask({ id: ctx.task.id, accountId: "owner", scenario: ctx.task.scenario, resourceId: pageId,
    goal: ctx.task.goal, scope: ctx.task.scope });
  const generate = vi.fn(async (_config, name) => {
    expect(name).toBe("learning_agent_explanation");
    return { materialAnswer: "[离线讲解] 先判断必要前提是否满足；未满足时不能直接应用规则。", supplements: [], items: [{ materialId, paragraph: 2 }] };
  }) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
  const scene = createLearningAgentScenario(learning, { configure: () => ({ baseURL: "https://offline.invalid/v1", apiKey: "SYNTHETIC", model: "offline", maxInputChars: 24000, maxOutputTokens: 900 }), generate });
  const quizExecute = vi.spyOn(scene.tools["learning.create_quiz"], "execute");
  const decision = vi.fn<AgentDecisionProvider>(async (input, current) => current.call<AgentDecision>({ kind: "offline_history_decision", inputChars: 100, maxOutputTokens: 100 }, async () => {
    const completion = (input.observation as { completion: LearningCompletionAssessment }).completion;
    if (!input.task.actions.some(action => action.tool === "learning.create_quiz")) return { value: { tool: "learning.create_quiz", args: {
      count: 1, difficulty: "standard", purpose: { objectiveIds: ["rule"], role: "boundary", method: "boundary", purpose: "检查尚未解决的条件问题", priorEvidenceRefs: [] } } } };
    const pending = completion.historyReview?.pending;
    if (pending?.some(item => !item.read)) return { value: { tool: "learning.read_answers", args: { attemptId: pending.find(item => !item.read)!.ref.attemptId } } };
    if (pending?.length) {
      const next = pending[0], readResult = input.results.find(result => result.tool === "learning.read_answers"
        && result.status === "succeeded" && (result.value as { attemptId?: string }).attemptId === next.ref.attemptId);
      expect(readResult).toBeDefined();
      const saved = readResult!.value as { score: { total: number }; questions: Array<{ feedback?: { correct: boolean } }> };
      expect(saved.score.total).toBe(1); expect(saved.questions[0].feedback).toBeDefined();
      return { value: { tool: "learning.associate_evidence", args: { ...proposal(wrong), ref: next.ref, objectiveId: next.unassociatedObjectiveIds[0] } } };
    }
    expect(completion.outcome).not.toBe("check_passed"); expect(completion.objectives[0].unresolvedErrors).toEqual([proposal(wrong).ref]);
    expect(completion.objectives[0].evidence.find(item => item.ref.attemptId === hinted.id)).toMatchObject({ correct: true, hintedBeforeSubmission: true, independentInApp: false });
    if (!input.task.actions.some(action => action.tool === "learning.explain")) return { value: { tool: "learning.explain", args: {
      question: "前提未满足时应该怎样判断？", sources: [{ materialId, paragraph: 2 }],
      purpose: { objectiveIds: ["rule"], role: "boundary", method: "contrast", purpose: "针对真实错答解释必要条件", priorEvidenceRefs: [proposal(wrong).ref] } } } };
    return { value: { finish: "[离线选择] 已回读原错答并解释，尚无相关的新独立表现，本轮诚实交回。" } };
  }));
  const runtime = new AgentRuntime({ store, checkpointPath: join(directory, "history-checkpoints.sqlite"), scenario: scene, decision: withLearningCompletionDecision(learning, decision) });
  try {
    const scope = { ...freezeLearningAgentScope(learning, pageId, selection(true)), completionVersion: 1 as const };
    const snapshot = prepareLearningPlanSourceAdjustment(learning, persisted, { goal: persisted.goal, scope }, [{ objectiveId: "rule", sources: [{ materialId, paragraph: 2 }] }]);
    const adjusted = await runtime.adjust("owner", persisted.id, { expectedVersion: 1, goal: persisted.goal, scope: { ...scope, planSourceAdjustment: snapshot }, eventId: randomUUID() });
    expect(adjusted.usage.calls).toBe(persisted.usage.calls);
    const result = await runtime.advance("owner", persisted.id), completion = assessLearningCompletion(learning, result);
    expect(result.status).toBe("ended"); expect(completion.outcome).not.toBe("check_passed"); expect(completion.canAutoFinish).toBe(false);
    expect(result.actions[0]).toMatchObject({ tool: "learning.create_quiz", status: "failed", summary: expect.stringContaining("learning.read_answers") });
    await expect(quizExecute.mock.results[0].value).rejects.toMatchObject({ code: "known_failure", message: "agent_history_review_required" });
    expect(result.actions.filter(action => action.tool === "learning.read_answers")).toHaveLength(2);
    expect(result.actions.filter(action => action.tool === "learning.associate_evidence")).toHaveLength(2);
    expect(result.actions.filter(action => action.tool === "learning.read_answers" || action.tool === "learning.associate_evidence").every(action => action.status === "succeeded" && action.version === 2)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1); expect(quizzes.list(pageId)).toHaveLength(2);
    expect(completion.historyReview?.pending).toEqual([]); expect(completion.objectives[0].unresolvedErrors).toEqual([proposal(wrong).ref]);
    expect(quizzes.attempt(pageId, wrong.id).score?.correct).toBe(0); expect(quizzes.attempt(pageId, hinted.id).score?.correct).toBe(1);
    expect(result.usage.calls).toBe(decision.mock.calls.length + 1); expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { runtime.close(); store.close(); }
});
