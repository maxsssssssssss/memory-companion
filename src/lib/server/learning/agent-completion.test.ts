// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@/lib/domain/agent";
import { LearningReviewPlanInput, type LearningCheckPurpose, type LearningEvidenceProposal, type LearningReviewPlanInput as PlanInput } from "@/lib/domain/learning-agent-completion";
import type { QuizAttemptView, QuizActionInput } from "@/lib/domain/learning-quiz";
import type { AgentContext } from "@/lib/server/agent/types";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningAgentRepository } from "./agent-repository";
import { freezeLearningAgentScope, readLearningAgentScope } from "./agent-scope";
import { assessLearningCompletion, establishLearningReviewPlan, recordLearningEvidenceProposal, persistLearningCompletion, recordLearningPurpose,
  recordExplanationFeedback, guardLearningCompletionAction, hasPendingLearningFeedback, acknowledgeLearningFeedback } from "./agent-completion";
import { quizReviewQuestionKey } from "./quiz-review-purpose";
import { firstSubmissionFacts, learningQuestionIdentity, loadLearningCompletionEvidence } from "./agent-completion-evidence";

let directory: string, learning: LearningRepository, quizzes: LearningQuizRepository, pageId: string, materialId: string, ctx: AgentContext;
const settings = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" });
const source = () => [{ materialId, paragraph: 1 }];
const purpose = (extra: Partial<LearningCheckPurpose> = {}): LearningCheckPurpose => ({ objectiveIds: ["rule"], role: "concept", method: "explain", purpose: "澄清前提与结论", priorEvidenceRefs: [], ...extra });
function plan(kind: PlanInput["kind"] = "chapter_check", roles: Array<"concept" | "application" | "boundary" | "followup"> = ["concept"]) {
  return establishLearningReviewPlan(learning, ctx, { kind, objectives: [{ id: "rule", label: "规则适用条件", sources: source(), requirements: kind === "explanation" ? [] : roles.map(role => ({ role, description: `检查${role}`, independent: kind !== "diagnosis" })) }] });
}
function act(attempt: QuizAttemptView, action: QuizActionInput["action"], optionId: string | null = null, question = 0) {
  vi.setSystemTime(Date.now() + 10);
  return quizzes.act(pageId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action, question, optionId });
}
function group(answer: "correct" | "wrong" | "hint" | "reveal" | "skip" | "incomplete" = "correct", stem = "[合成] 前提未满足时能应用规则吗？", own = true) {
  vi.setSystemTime(Date.now() + 10);
  const id = randomUUID(); quizzes.begin(pageId, { id, settings: settings() }, 24000);
  quizzes.complete(pageId, id, { title: "[合成] 条件检查", reason: null, items: [{ stem, kind: "concept",
    options: [{ id: "A", text: "不能应用", reason: "前提未满足时不能应用规则。" }, { id: "B", text: "能够应用", reason: "只有前提满足才可应用规则。" }], correctOptionId: "A", hint: "先看适用条件。", explanation: "只有前提满足才可应用规则。", sources: [{ kind: "material", materialId, paragraph: 1 }] }] });
  let attempt = quizzes.startAttempt(pageId, { id: randomUUID(), quizId: id, mode: "practice" });
  if (answer === "reveal" || answer === "skip") attempt = act(attempt, answer);
  else if (answer !== "incomplete") {
    if (answer === "hint") attempt = act(attempt, "hint");
    attempt = act(attempt, "choose", answer === "wrong" ? "B" : "A"); attempt = act(attempt, "submit");
  }
  if (own) {
    const artifacts = new LearningAgentRepository(learning);
    artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: ctx.task.version, pageId, kind: "quiz", actionId: randomUUID(), binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] });
    artifacts.complete(pageId, ctx.task.id, id, { attemptId: attempt.id });
  }
  return attempt;
}
function associate(attempt: QuizAttemptView, extra: Partial<LearningEvidenceProposal> = {}) {
  ctx.actionId = randomUUID();
  return recordLearningEvidenceProposal(learning, ctx, { ref: { quizId: attempt.quizId, attemptId: attempt.id, questionIndex: 0 }, objectiveId: "rule", role: "concept", rationale: "[模拟语义提案] 本题询问规则前提", relevance: "supported", relation: "initial", contentStatus: "no_known_issue", priorEvidenceRefs: [], ...extra });
}
function explanation() {
  const id = randomUUID(), artifacts = new LearningAgentRepository(learning), p = plan("explanation");
  artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: 1, pageId, kind: "explanation", actionId: randomUUID(), binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] });
  artifacts.complete(pageId, ctx.task.id, id, { id, question: "为什么先判断条件", materialAnswer: "[合成] 先确认前提再推结论。", items: source(), supplements: [], reviewContext: { planId: p.id, taskVersion: 1, purpose: purpose() } });
  return id;
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
  directory = await mkdtemp(join(tmpdir(), "agent-completion-")); learning = new LearningRepository(directory, "owner"); quizzes = new LearningQuizRepository(learning);
  pageId = randomUUID(); materialId = randomUUID(); learning.create({ id: pageId, title: "[合成] 完成依据" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 条件", kind: "text", filename: null, bytes: Buffer.from("[合成] 只有前提满足才可应用规则。前提不成立时不可直接推导结论。") }]);
  const task: AgentTask = { id: randomUUID(), accountId: "owner", scenario: "learning.adaptive-review.v1", resourceId: pageId, version: 1, goal: "[合成] 检查条件", scope: { ...freezeLearningAgentScope(learning, pageId, { materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, includeHistory: false }), completionVersion: 1 }, status: "running", actions: [], budget: { maxCalls: 16, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 100000, maxSteps: 16, maxNoProgress: 3 }, usage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0, computeMs: 0, steps: 0 }, createdAt: "synthetic", updatedAt: "synthetic" };
  ctx = { task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {}, call: async (_r, invoke) => (await invoke()).value };
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(async () => { learning.close(); vi.unstubAllGlobals(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

it("keeps the first submitted response unassisted after normal answer reveal and stops from facts", () => {
  plan(); const attempt = group(); associate(attempt);
  const result = assessLearningCompletion(learning, ctx.task);
  expect(attempt.questions[0].feedback).toBeDefined(); expect(result.outcome).toBe("check_passed"); expect(result.canAutoFinish).toBe(true);
  expect(result.objectives[0].evidence[0]).toMatchObject({ independentInApp: true, answerAvailability: "unknown", quality: "tentative" });
  expect(result.longTermMastery).toBe("unverified"); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("keeps hints distinct from independent support", () => {
  plan(); associate(group("hint")); const result = assessLearningCompletion(learning, ctx.task);
  expect(result.outcome).not.toBe("check_passed"); expect(result.objectives[0].evidence[0]).toMatchObject({ correct: true, hintedBeforeSubmission: true, independentInApp: false });
});
it("retains an uncovered boundary even when every observed answer is correct", () => {
  plan("chapter_check", ["concept", "boundary"]); associate(group());
  expect(assessLearningCompletion(learning, ctx.task).objectives[0].requirements).toMatchObject([{ supported: true }, { supported: false }]);
});
it("detects known repeats across group IDs without contaminating the earlier first answer", () => {
  plan(); const first = group(); associate(first); const repeat = group(); associate(repeat);
  const evidence = assessLearningCompletion(learning, ctx.task).objectives[0].evidence;
  expect(evidence[0]).toMatchObject({ independentInApp: true, repetition: "not_known_repeat" });
  expect(evidence[1]).toMatchObject({ independentInApp: false, repetition: "known_repeat", answerAvailability: "available_before_submission" });
});
it("retains wrong boundary counterevidence after an easy correct concept followup", () => {
  plan("chapter_check", ["concept", "boundary"]); const wrong = group("wrong", "[合成] 条件未满足怎么办？"); const prior = associate(wrong, { role: "boundary" });
  associate(group("correct", "[合成] 请识别规则概念。"), { relation: "followup", priorEvidenceRefs: [prior.ref] });
  const result = assessLearningCompletion(learning, ctx.task);
  expect(result.outcome).not.toBe("check_passed"); expect(result.objectives[0].unresolvedErrors).toEqual([prior.ref]);
});
it("only accepts later nonrepeat same-purpose checking against recorded counterevidence", () => {
  plan(); const wrong = group("wrong"), first = associate(wrong);
  const next = group("correct", "[合成] 前提不存在时，新案例是否可用该规则？"); associate(next, { relation: "new_context", priorEvidenceRefs: [first.ref] });
  const result = assessLearningCompletion(learning, ctx.task);
  expect(result.outcome).toBe("check_passed"); expect(result.objectives[0].unresolvedErrors).toEqual([]);
  expect(result.objectives[0].evidence[1].semanticProvenance).toBe("model_proposal");
});
it("diagnosis can complete with wrong observations without remediating to all correct", () => {
  plan("diagnosis"); associate(group("wrong")); const result = assessLearningCompletion(learning, ctx.task);
  expect(result.outcome).toBe("diagnosis_complete"); expect(result.headline).toContain("不代表");
});
it("cannot erase a known content problem with a later model no-known-issue claim", () => {
  plan(); const attempt = group(); associate(attempt, { contentStatus: "known_issue" }); associate(attempt);
  expect(assessLearningCompletion(learning, ctx.task).objectives[0].evidence[0].quality).toBe("known_issue");
  expect(assessLearningCompletion(learning, ctx.task).outcome).not.toBe("check_passed");
});
it("excludes disputes without changing the original saved score", () => {
  plan(); const attempt = group(); associate(attempt); new LearningAgentRepository(learning).dispute(pageId, ctx.task.id, attempt.id);
  const result = assessLearningCompletion(learning, ctx.task);
  expect(result.objectives[0].evidence[0].quality).toBe("disputed"); expect(result.canAutoFinish).toBe(false); expect(quizzes.attempt(pageId, attempt.id).score?.correct).toBe(1);
});
it("projects stale with no old rationale or evidence after source deletion", () => {
  plan(); associate(group()); persistLearningCompletion(learning, ctx.task); learning.deleteMaterial(pageId, materialId);
  const result = assessLearningCompletion(learning, ctx.task);
  expect(result.outcome).toBe("stale"); expect(result.objectives).toEqual([]); expect(result.plan).toBeNull(); expect(JSON.stringify(result)).not.toContain("模拟语义提案");
});
it("makes the plan immutable and refuses unselected sources and another account", () => {
  plan(); expect(() => establishLearningReviewPlan(learning, ctx, { kind: "explanation", objectives: [{ id: "easy", label: "降低要求", sources: source(), requirements: [] }] })).toThrow("immutable");
  expect(() => assessLearningCompletion(learning, { ...ctx.task, accountId: "intruder" })).toThrow("agent_not_found");
});
it("does not inherit a prior conclusion across a goal version change", () => {
  plan(); associate(group()); expect(assessLearningCompletion(learning, ctx.task).outcome).toBe("check_passed");
  expect(assessLearningCompletion(learning, { ...ctx.task, version: 2, goal: "新增核心目标" })).toMatchObject({ plan: null, outcome: "insufficient", canAutoFinish: false });
});
it("uses explicit resolution only, with atomic explanation context surviving reopen", () => {
  const id = explanation(); expect(assessLearningCompletion(learning, ctx.task).outcome).toBe("insufficient");
  learning.close(); learning = new LearningRepository(directory, "owner");
  recordExplanationFeedback(learning, ctx.task, { eventId: randomUUID(), explanationId: id, outcome: "resolved" });
  expect(assessLearningCompletion(learning, ctx.task).outcome).toBe("explanation_resolved"); expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(0);
  const rows = new LearningAgentRepository(learning).list(pageId, ctx.task.id);
  recordExplanationFeedback(learning, ctx.task, { eventId: randomUUID(), explanationId: id, outcome: "resolved" });
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id)).toEqual(rows);
  expect(() => recordExplanationFeedback(learning, ctx.task, { eventId: randomUUID(), explanationId: id, outcome: "needs_clarification" })).toThrow("feedback_conflict");
});
it("keeps declined resolution open and never treats free-text thanks as explicit confirmation", () => {
  const id = explanation(); recordExplanationFeedback(learning, ctx.task, { eventId: randomUUID(), explanationId: id, outcome: "needs_clarification", message: "谢谢，但仍不明白" });
  expect(assessLearningCompletion(learning, ctx.task).outcome).toBe("insufficient");
});
it("holds automatic finish for pending or approved-unexecuted confirmation", () => {
  plan(); associate(group());
  for (const status of ["pending", "approved"] as const) expect(assessLearningCompletion(learning, { ...ctx.task, approval: { id: "a", actionId: "b", taskVersion: 1, tool: "learning.append_note", fingerprint: "c", status, createdAt: "synthetic", title: "预览", summary: "笔记", target: "节点", content: "合成", sourceFingerprint: "scope" } }).canAutoFinish).toBe(false);
});
it("checks before new generation and preserves purpose replay identity after progress", () => {
  plan(); const p = purpose(), actionId = ctx.actionId, resultId = randomUUID(); recordLearningPurpose(learning, ctx, "explanation", p, resultId);
  ctx.actionId = randomUUID(); expect(guardLearningCompletionAction(learning, ctx, "explanation", p).stop).toContain("尚无新的有效进展");
  associate(group()); ctx.actionId = actionId; expect(() => recordLearningPurpose(learning, ctx, "explanation", p, resultId)).not.toThrow();
  expect(guardLearningCompletionAction(learning, ctx, "quiz", purpose({ method: "retrieval" })).stop).toContain("检查通过");
});
it("keeps new feedback pending until an acknowledged handling action", () => {
  plan(); associate(group()); const event = { id: randomUUID(), kind: "feedback", version: 1, message: "请先处理我的新问题" }; ctx.event = event;
  expect(hasPendingLearningFeedback(learning, ctx.task, event)).toBe(true);
  expect(() => guardLearningCompletionAction(learning, ctx, "quiz", purpose())).toThrow("already_supported");
  acknowledgeLearningFeedback(learning, ctx); expect(hasPendingLearningFeedback(learning, ctx.task, event)).toBe(false);
});
it("GET projection performs no completion writes and legacy tasks never acquire a verdict", () => {
  plan(); associate(group()); const repository = new LearningAgentRepository(learning), before = repository.list(pageId, ctx.task.id);
  assessLearningCompletion(learning, ctx.task); assessLearningCompletion(learning, ctx.task); expect(repository.list(pageId, ctx.task.id)).toEqual(before);
  const scope = { ...ctx.task.scope as object, completionVersion: undefined }; expect(assessLearningCompletion(learning, { ...ctx.task, scope }).outcome).toBe("legacy");
});
it("does not read unrelated history when closed and keeps missing historical quality unknown when open", () => {
  plan(); const previous = group("correct", "[合成] 历史条件检查", false);
  expect(() => associate(previous)).toThrow("evidence_invalid");
  ctx.task.scope = { ...ctx.task.scope as object, selection: { ...(ctx.task.scope as { selection: object }).selection, includeHistory: true } };
  associate(previous); const result = assessLearningCompletion(learning, ctx.task);
  expect(result.objectives[0].evidence[0]).toMatchObject({ historical: true, quality: "historical_unknown", eligible: false });
});
it("requires followup requirements for targeted review and rejects duplicate goal identities", () => {
  expect(() => plan("targeted_review", ["concept"])).toThrow("targeted_followup_required");
  const objective = { id: "same", label: "目标", sources: source(), requirements: [] };
  expect(LearningReviewPlanInput.safeParse({ kind: "explanation", objectives: [objective, objective] }).success).toBe(false);
});
it("normalization detects exact option permutations but never proves changed numbers are transfer", () => {
  const first = group(), question = first.questions[0];
  expect(learningQuestionIdentity(question)).toBe(learningQuestionIdentity({ ...question, options: [...question.options].reverse() }));
  expect(learningQuestionIdentity(question)).not.toBe(learningQuestionIdentity({ ...question, stem: question.stem + "条件2" }));
  expect(firstSubmissionFacts(first, 0, [{ action: "choose", question: 0, at: "1" }, { action: "submit", question: 0, at: "2" }, { action: "hint", question: 0, at: "3" }])).toMatchObject({ hinted: false, firstSubmittedAt: "2" });
});

it("quarantines a known issue for the actual question across all goal and role mappings", () => {
  plan("chapter_check", ["concept", "boundary"]); const attempt = group();
  associate(attempt, { role: "boundary", contentStatus: "known_issue" }); associate(attempt, { role: "concept" });
  const result = assessLearningCompletion(learning, ctx.task);
  expect(result.objectives[0].evidence.every(e => e.quality === "known_issue" && !e.eligible)).toBe(true);
});
it("new wrong group IDs and unfinished artifacts never create progress", () => {
  plan(); const initial = assessLearningCompletion(learning, ctx.task).progressFingerprint;
  const first = group("wrong", "[合成] 第一种条件不满足？"); associate(first); const p = purpose({ method: "retrieval" });
  const originalAction = ctx.actionId; recordLearningPurpose(learning, ctx, "quiz", p, first.quizId);
  const second = group("wrong", "[合成] 第二种条件不满足？"); associate(second); group("incomplete", "[合成] 第三种条件不满足？");
  const current = assessLearningCompletion(learning, ctx.task);
  expect(current.progressFingerprint).toBe(initial); expect(ctx.actionId).not.toBe(originalAction);
  expect(guardLearningCompletionAction(learning, ctx, "quiz", p).stop).toContain("尚无新的有效进展");
});
it("requires a concrete method difference and expected observation instead of a renamed method", () => {
  plan(); const id = randomUUID(); recordLearningPurpose(learning, ctx, "explanation", purpose(), id); ctx.actionId = randomUUID();
  expect(guardLearningCompletionAction(learning, ctx, "explanation", purpose({ method: "contrast" })).stop).toContain("仅更换方法名称");
  expect(guardLearningCompletionAction(learning, ctx, "explanation", purpose({ method: "contrast", methodChange: { previousResultId: id, difference: "并列比较适用与不适用的两个条件", expectedObservation: "请用户指出两例条件差异" } })).stop).toBeUndefined();
});
it("stale projections never serialize an old passing end reason", () => {
  plan(); associate(group()); learning.deleteMaterial(pageId, materialId);
  const result = assessLearningCompletion(learning, { ...ctx.task, status: "ended", endReason: "本轮约定目标检查通过" });
  expect(result.stopReason).toBeNull(); expect(JSON.stringify(result)).not.toContain("检查通过");
});

it("does not inspect a whole-material historical attempt through a narrower node authorization", () => {
  const previous = group("correct", "[合成] 整份材料的历史问题", false), f = new LearningFrameworkRepository(learning), id = randomUUID();
  f.begin(pageId, { id, materialIds: [materialId] }, 24000); f.validating(pageId, id);
  f.complete(pageId, id, { overview: "[合成]", chapters: [{ title: "[合成]", explanation: "[合成]", nodes: [{ title: "前提", explanation: "[合成]", supplement: null, sources: source() }] }] });
  const node = f.view(pageId).chapters[0].nodes[0];
  ctx.task.scope = { ...freezeLearningAgentScope(learning, pageId, { materialIds: [], chapterIds: [], nodeIds: [node.id], includeNotes: false, includeSupplements: false, includeHistory: true }), completionVersion: 1 };
  plan(); const spy = vi.spyOn(LearningQuizRepository.prototype, "attempt");
  expect(() => associate(previous)).toThrow("evidence_invalid"); expect(spy).not.toHaveBeenCalledWith(pageId, previous.id); spy.mockRestore();
});

it("rolls back a plan reservation if the local completion write fails, then safely replays", () => {
  const spy = vi.spyOn(LearningAgentRepository.prototype, "complete").mockImplementationOnce(() => { throw new Error("synthetic-local-interruption"); });
  expect(() => plan()).toThrow("synthetic-local-interruption"); spy.mockRestore();
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id).filter(r => r.kind === "review_plan")).toEqual([]);
  expect(plan().kind).toBe("chapter_check"); expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id).filter(r => r.kind === "review_plan")).toHaveLength(1);
});
it("rolls back assessment metadata as one local transaction and reuses exact facts on retry", () => {
  plan(); associate(group()); const spy = vi.spyOn(LearningAgentRepository.prototype, "complete").mockImplementationOnce(() => { throw new Error("synthetic-assessment-interruption"); });
  expect(() => persistLearningCompletion(learning, ctx.task)).toThrow("synthetic-assessment-interruption"); spy.mockRestore();
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id).filter(r => r.kind === "completion_assessment")).toEqual([]);
  const result = persistLearningCompletion(learning, ctx.task); expect(result.outcome).toBe("check_passed");
  const record = new LearningAgentRepository(learning).list(pageId, ctx.task.id).find(r => r.kind === "completion_assessment")!;
  expect(record.body_json).not.toMatch(/"(?:correct|score|optionId|stem|materialAnswer)"/u);
  expect(persistLearningCompletion(learning, { ...ctx.task, status: "ended", endReason: "已结束" }).outcome).toBe("check_passed");
});

it("permits a later explicit resolution of the same explanation in a new feedback round", () => {
  const id = explanation(), firstRound = `feedback:${randomUUID()}`, secondRound = `feedback:${randomUUID()}`;
  recordExplanationFeedback(learning, ctx.task, { eventId: randomUUID(), roundId: firstRound, explanationId: id, outcome: "needs_clarification" });
  expect(assessLearningCompletion(learning, ctx.task).outcome).toBe("insufficient");
  expect(() => recordExplanationFeedback(learning, ctx.task, { eventId: randomUUID(), roundId: firstRound, explanationId: id, outcome: "resolved" })).toThrow("feedback_conflict");
  recordExplanationFeedback(learning, ctx.task, { eventId: randomUUID(), roundId: secondRound, explanationId: id, outcome: "resolved" });
  expect(assessLearningCompletion(learning, ctx.task).outcome).toBe("explanation_resolved");
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id).filter(r => r.kind === "explanation_feedback")).toHaveLength(2);
});

function pendingReviewedGroup(count = 1) {
  const savedPlan = plan(), id = randomUUID(), input = quizzes.begin(pageId, { id, settings: { ...settings(), count } }, 24000);
  if (!input) throw new Error("synthetic_pending_quiz_request_required");
  const reference = input.materials[0].paragraphs[0].referenceId;
  const questions = Array.from({ length: count }, (_, index) => ({ stem: `[合成] 前提未满足时，第${index + 1}个案例能够应用规则吗？`, kind: "concept" as const,
    options: [{ id: "A" as const, text: "不能应用", reason: "只有前提满足才可应用规则。", evidenceIds: [reference] }, { id: "B" as const, text: "能够应用", reason: "前提不成立时不可直接推导结论。", evidenceIds: [reference] }],
    correctOptionId: "A" as const, hint: null, explanation: "只有前提满足才可应用规则。", stemEvidenceIds: [reference], explanationEvidenceIds: [reference] }));
  quizzes.complete(pageId, id, { contractVersion: "references-v2", title: "[合成] 等待提交检查", reason: null, items: questions }, {
    context: { planId: savedPlan.id, taskVersion: 1, objectives: savedPlan.objectives, purpose: purpose({ method: "retrieval" }) },
    candidates: questions.map(question => ({ questionKey: quizReviewQuestionKey(question), check: { objectiveIds: ["rule"], role: "concept", rationale: "SECRET_PENDING_ANSWER：不能应用规则。" } })) });
  const attempt = quizzes.startAttempt(pageId, { id: randomUUID(), quizId: id, mode: "test" });
  const artifacts = new LearningAgentRepository(learning);
  artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: 1, pageId, kind: "quiz", actionId: randomUUID(), binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] });
  artifacts.complete(pageId, ctx.task.id, id, { attemptId: attempt.id });
  expect(quizzes.review(pageId, id)?.checks).toHaveLength(count);
  return { attempt, savedPlan };
}
it("keeps published but unsubmitted review checks unobserved, then supports the actual submitted answer", () => {
  let { attempt } = pendingReviewedGroup();
  const before = assessLearningCompletion(learning, ctx.task);
  expect(before.objectives[0]).toMatchObject({ status: "unobserved", unresolvedErrors: [], evidence: [{ quality: "pending", eligible: false, correct: null, rationale: "" }] });
  expect(before.objectives[0].gaps.join()).not.toContain("争议"); expect(before.canAutoFinish).toBe(false); expect(before.pending).toContain("等待实际作答");
  expect(JSON.stringify(before)).not.toContain("SECRET_PENDING_ANSWER"); expect(() => associate(attempt)).toThrow("evidence_invalid");
  attempt = act(attempt, "choose", "A"); attempt = act(attempt, "finish");
  const after = assessLearningCompletion(learning, ctx.task);
  expect(after.objectives[0]).toMatchObject({ status: "supported", evidence: [{ quality: "tentative", eligible: true, correct: true }] });
  expect(after.outcome).toBe("check_passed"); expect(after.canAutoFinish).toBe(true);
});
it("does not release a partially submitted test group's answers or call its pending checks invalid", () => {
  let { attempt } = pendingReviewedGroup(2);
  attempt = act(attempt, "choose", "A", 0); attempt = act(attempt, "submit", null, 0);
  const beforeFinish = assessLearningCompletion(learning, ctx.task);
  expect(beforeFinish.objectives[0].status).toBe("unobserved");
  expect(beforeFinish.objectives[0].evidence.every(e => e.quality === "pending" && !e.eligible && e.correct === null && e.rationale === "")).toBe(true);
  expect(JSON.stringify(beforeFinish)).not.toContain("SECRET_PENDING_ANSWER");
  attempt = act(attempt, "choose", "A", 1); act(attempt, "finish");
  expect(assessLearningCompletion(learning, ctx.task).outcome).toBe("check_passed");
});
it("preserves real invalid-record, dispute and source failures instead of masking them as ordinary waiting", () => {
  const { attempt, savedPlan } = pendingReviewedGroup();
  const proposal: LearningEvidenceProposal = { ref: { quizId: attempt.quizId, attemptId: randomUUID(), questionIndex: 0 }, objectiveId: "rule", role: "concept", rationale: "SECRET_PENDING_ANSWER", relevance: "supported", relation: "initial", contentStatus: "no_known_issue", priorEvidenceRefs: [] };
  const invalid = loadLearningCompletionEvidence(learning, ctx.task, savedPlan, [proposal], readLearningAgentScope(learning, pageId, ctx.task.scope))[0];
  expect(invalid).toMatchObject({ quality: "invalid", eligible: false, correct: null, rationale: "" });
  new LearningAgentRepository(learning).dispute(pageId, ctx.task.id, attempt.id);
  expect(assessLearningCompletion(learning, ctx.task).objectives[0]).toMatchObject({ status: "uncertain", evidence: [{ quality: "disputed", eligible: false, rationale: "" }] });
  learning.deleteMaterial(pageId, materialId); expect(assessLearningCompletion(learning, ctx.task)).toMatchObject({ outcome: "stale", plan: null, objectives: [] });
});
it("describes unresolved explanation goals without presenting them as an unsuccessful exam", () => {
  explanation(); const result = assessLearningCompletion(learning, ctx.task);
  expect(result.outcome).toBe("insufficient"); expect(result.headline).toContain("等待你确认"); expect(result.headline).not.toContain("检查通过");
  expect(result.limitations.join()).not.toContain("verified"); expect(result.limitations.join()).toContain("尚未经独立核验");
});
