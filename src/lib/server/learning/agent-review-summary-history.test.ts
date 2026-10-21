// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@/lib/domain/agent";
import type { LearningAgentScope } from "@/lib/domain/learning-agent";
import type { LearningEvidenceProposal, LearningReviewPlan } from "@/lib/domain/learning-agent-completion";
import type { QuizAttemptView } from "@/lib/domain/learning-quiz";
import type { AgentContext } from "@/lib/server/agent/types";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningAgentRepository } from "./agent-repository";
import { freezeLearningAgentScope } from "./agent-scope";
import { assessLearningCompletion, establishLearningReviewPlan } from "./agent-completion";
import { materializeLearningPlanSourceAdjustment, prepareLearningPlanSourceAdjustment } from "./agent-plan-sources";
import { quizReviewQuestionKey } from "./quiz-review-purpose";
import { completePreContractQuizFixture } from "./testing/pre-contract-quiz.fixture";
import { createLearningAgentScenario } from "./agent-scenario";
import { projectLearningAgentTask } from "./agent-api-service";
import { projectLearningAgentReviewSummary, saveLearningAgentReviewSummary } from "./agent-review-summary";

let directory: string, learning: LearningRepository, quizzes: LearningQuizRepository, pageId: string, materialId: string, ctx: AgentContext, plan: LearningReviewPlan;
const selection = (includeHistory = false) => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, includeHistory });
const settings = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" });
const purpose = { objectiveIds: ["rule"], role: "boundary" as const, method: "boundary" as const, purpose: "判断前提不成立时能否应用规则", priorEvidenceRefs: [] };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "review-summary-history-"));
  learning = new LearningRepository(directory, "owner"); quizzes = new LearningQuizRepository(learning);
  pageId = randomUUID(); materialId = randomUUID(); learning.create({ id: pageId, title: "[合成] 历史回顾" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 条件", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 章节概览。\n\n[合成] 只有前提满足才可应用规则。前提未满足时不能直接应用规则。") }]);
  const task: AgentTask = { id: randomUUID(), accountId: "owner", scenario: "learning.adaptive-review.v1", resourceId: pageId,
    version: 1, goal: "[合成] 判断规则前提", scope: { ...freezeLearningAgentScope(learning, pageId, selection()), completionVersion: 1 }, status: "running", actions: [],
    budget: { maxCalls: 16, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 100000, maxSteps: 16, maxNoProgress: 3 },
    usage: { calls: 5, inputTokens: 100, outputTokens: 20, unknownUsageCalls: 0, computeMs: 100, steps: 5 }, createdAt: "synthetic", updatedAt: "synthetic" };
  ctx = { task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {}, call: async (_request, invoke) => (await invoke()).value };
  plan = establishLearningReviewPlan(learning, ctx, { kind: "chapter_check", objectives: [{ id: "rule", label: "判断规则前提", sources: [{ materialId, paragraph: 1 }],
    requirements: [{ role: "boundary", description: "判断前提不成立时不能应用规则", independent: true }] }] });
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("network_forbidden"); }));
});
afterEach(async () => { learning.close(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

function group(answer: "wrong" | "hint" | "correct" = "wrong", count = 1) {
  const id = randomUUID(), input = quizzes.begin(pageId, { id, settings: { ...settings(), count } }, 24000)!;
  const reference = input.materials[0].paragraphs[1].referenceId;
  const questions = Array.from({ length: count }, (_, index) => ({ stem: `[合成] 情形${index + 1}中前提未满足时能直接应用规则吗？`, kind: "concept" as const,
    options: [{ id: "A" as const, text: "不能应用", reason: "只有前提满足才可应用规则。", evidenceIds: [reference] },
      { id: "B" as const, text: "能够应用", reason: "前提未满足时不能直接应用规则。", evidenceIds: [reference] }],
    correctOptionId: "A" as const, hint: "先检查前提。", explanation: "只有前提满足才可应用规则。", stemEvidenceIds: [reference], explanationEvidenceIds: [reference] }));
  completePreContractQuizFixture(learning, pageId, id, { contractVersion: "references-v2", title: "[合成] 规则检查", reason: null, items: questions }, {
    context: { planId: plan.id, taskVersion: ctx.task.version ?? 1, objectives: plan.objectives, purpose },
    candidates: questions.map(question => ({ questionKey: quizReviewQuestionKey(question), check: { objectiveIds: ["rule"], role: "boundary", rationale: "[离线提案] 检查必要条件。" } })) });
  let attempt = quizzes.startAttempt(pageId, { id: randomUUID(), quizId: id, mode: "practice" });
  for (let question = 0; question < count; question++) {
    const act = (action: "hint" | "choose" | "submit", optionId: string | null = null) => {
      attempt = quizzes.act(pageId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action, question, optionId });
    };
    if (answer === "hint") act("hint");
    act("choose", answer === "wrong" ? "B" : "A"); act("submit");
  }
  const artifacts = new LearningAgentRepository(learning);
  artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: ctx.task.version ?? 1, pageId, kind: "quiz", actionId: randomUUID(), binding: (ctx.task.scope as LearningAgentScope).fingerprint, materialIds: [materialId] });
  artifacts.complete(pageId, ctx.task.id, id, { attemptId: attempt.id });
  return attempt;
}
async function adjust(includeHistory = true) {
  const scope = { ...freezeLearningAgentScope(learning, pageId, selection(includeHistory)), completionVersion: 1 as const };
  const snapshot = prepareLearningPlanSourceAdjustment(learning, ctx.task, { goal: ctx.task.goal, scope }, [{ objectiveId: "rule", sources: [{ materialId, paragraph: 2 }] }]);
  ctx.task = { ...ctx.task, version: 2, scope: { ...scope, planSourceAdjustment: snapshot } };
  await materializeLearningPlanSourceAdjustment(learning, ctx);
  plan = JSON.parse(new LearningAgentRepository(learning).list(pageId, ctx.task.id).find(row => row.kind === "review_plan" && row.task_version === 2)!.body_json!);
}
const proposal = (attempt: QuizAttemptView, questionIndex = 0): LearningEvidenceProposal => ({ ref: { quizId: attempt.quizId, attemptId: attempt.id, questionIndex },
  objectiveId: "rule", role: "boundary", rationale: "[离线提案] 原题实际检查前提不成立的情况。", relevance: "supported", relation: "initial", priorEvidenceRefs: [], contentStatus: "no_known_issue" });
async function readAndAssociate(attempt: QuizAttemptView, questionIndex = 0) {
  const scene = createLearningAgentScenario(learning);
  ctx.actionId = randomUUID();
  const read = await scene.tools["learning.read_answers"].execute({ attemptId: attempt.id }, ctx);
  const action = { id: ctx.actionId, version: ctx.task.version, tool: "learning.read_answers", status: "succeeded" as const,
    reason: "读取原作答", summary: read.summary, resultRef: read.ref, createdAt: "synthetic" };
  ctx.task.actions.push(action);
  await scene.tools["learning.read_answers"].readResult!(action, ctx);
  ctx.actionId = randomUUID();
  await scene.tools["learning.associate_evidence"].execute(proposal(attempt, questionIndex), ctx);
}
function failedGroup(state: "failed" | "unknown", insufficient = false) {
  const id = randomUUID(); quizzes.begin(pageId, { id, settings: settings() }, 24000);
  if (insufficient) quizzes.complete(pageId, id, { title: "[合成] 没有可发布题", reason: "候选未通过发布检查", items: [] });
  else quizzes.fail(pageId, id, "quiz_invalid_result");
  const artifacts = new LearningAgentRepository(learning);
  artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: ctx.task.version, pageId, kind: "quiz", actionId: randomUUID(), binding: (ctx.task.scope as LearningAgentScope).fingerprint, materialIds: [materialId] });
  artifacts.fail(pageId, ctx.task.id, id, state === "unknown");
}

it("includes explicitly reread/reassociated old wrong answers and current hints without rewriting scores", async () => {
  const original = group("wrong"); await adjust(); await readAndAssociate(original);
  const hinted = group("hint"); failedGroup("failed", true); failedGroup("failed"); failedGroup("failed"); failedGroup("failed");
  const ended = { ...ctx.task, status: "budget_exhausted" as const };
  const assessment = assessLearningCompletion(learning, ended);
  expect(assessment.objectives[0].unresolvedErrors).toEqual([proposal(original).ref]);
  const view = projectLearningAgentTask(learning, ended);
  expect(view.reviewSummary?.stats).toMatchObject({ groups: 2, total: 2, wrong: 1, correct: 1, hinted: 1, unassistedCorrect: 0, excludedGroups: 4 });
  expect(view.reviewSummary?.headline).not.toContain("没有错题");
  expect(view.reviewSummary?.topics[0].questionRefs).toEqual([{ quizId: original.quizId, attemptId: original.id, index: 0 }]);
  expect(view.reviewSummary?.notices.join()).toContain("4 组练习未成功发布");
  expect(view.reviewSummary?.notices.join()).not.toContain("因用户疑问");
  expect(view.quizLinks).toContainEqual(expect.objectContaining({ quizId: original.quizId, attemptId: original.id, historical: true }));
  expect(quizzes.attempt(pageId, original.id)).toEqual(original); expect(quizzes.attempt(pageId, hinted.id)).toEqual(hinted);
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect(ctx.task.usage.calls).toBe(5);
});

it("authorization and a read without association do not silently import the old group", async () => {
  const original = group("wrong"); await adjust();
  const scene = createLearningAgentScenario(learning), read = await scene.tools["learning.read_answers"].execute({ attemptId: original.id }, ctx);
  ctx.task.actions.push({ id: randomUUID(), version: 2, tool: "learning.read_answers", status: "succeeded", reason: "read", summary: read.summary, resultRef: read.ref, createdAt: "synthetic" });
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.stats.wrong).toBe(0); expect(view.topics).toEqual([]);
  expect(view.notices.join()).toContain("仍有已授权历史作答需要读取或重新关联");
  expect(view.notices.join()).toContain("不能据此认定此前没有困难");
});

it("only includes the exact reassociated historical question, not its entire group", async () => {
  const original = group("wrong", 2); await adjust(); await readAndAssociate(original, 1);
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.stats).toMatchObject({ groups: 1, total: 1, wrong: 1 });
  expect(view.topics[0].questionRefs).toEqual([{ quizId: original.quizId, attemptId: original.id, index: 1 }]);
  expect(quizzes.attempt(pageId, original.id).score).toMatchObject({ total: 2, correct: 0 });
});

it("does not accept an old or failed read receipt after a version change", async () => {
  const original = group(); await adjust(); await readAndAssociate(original);
  ctx.task.actions = ctx.task.actions.map(action => ({ ...action, version: 1 }));
  let view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.stats.wrong).toBe(0);
  ctx.task.actions = ctx.task.actions.map(action => ({ ...action, version: 2, status: "failed" }));
  view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.stats.wrong).toBe(0);
});

it("reopens the persisted summary from facts without a provider call", async () => {
  const original = group(); await adjust(); await readAndAssociate(original); group("hint");
  const saved = await saveLearningAgentReviewSummary(learning, ctx);
  learning.close(); learning = new LearningRepository(directory, "owner"); quizzes = new LearningQuizRepository(learning);
  expect(projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })).toEqual(saved);
  expect(saved.stats).toMatchObject({ wrong: 1, hinted: 1 }); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("revoking history removes old details from the summary, including previously cached text", async () => {
  const original = group(); await adjust(); await readAndAssociate(original);
  await saveLearningAgentReviewSummary(learning, ctx);
  ctx.task.scope = { ...freezeLearningAgentScope(learning, pageId, selection(false)), completionVersion: 1 };
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.stats.wrong).toBe(0); expect(view.topics).toEqual([]);
  expect(JSON.stringify(view)).not.toContain(original.id); expect(JSON.stringify(view)).not.toContain(original.questions[0].stem);
  expect(quizzes.attempt(pageId, original.id).score?.correct).toBe(0);
});

it("excludes newly disputed history and source deletion, while keeping original scores", async () => {
  const original = group(); await adjust(); await readAndAssociate(original);
  const artifacts = new LearningAgentRepository(learning);
  artifacts.dispute(pageId, ctx.task.id, original.id);
  let view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.stats.wrong).toBe(0); expect(view.topics).toEqual([]);
  expect(quizzes.attempt(pageId, original.id).score?.correct).toBe(0);
  learning.deleteMaterial(pageId, materialId);
  view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.headline).toContain("授权已变化"); expect(view.topics).toEqual([]);
});

it("does not promote a historical known content problem into a learner difficulty", async () => {
  const original = group(); await adjust(); await readAndAssociate(original);
  const scene = createLearningAgentScenario(learning); ctx.actionId = randomUUID();
  await scene.tools["learning.associate_evidence"].execute({ ...proposal(original), contentStatus: "known_issue" }, ctx);
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.stats.wrong).toBe(0); expect(view.topics).toEqual([]);
  expect(assessLearningCompletion(learning, ctx.task).objectives[0].evidence[0]).toMatchObject({ quality: "known_issue", eligible: false });
  expect(quizzes.attempt(pageId, original.id).score?.correct).toBe(0);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("distinguishes confirmed generation failure from unknown results without inventing disputes", async () => {
  failedGroup("failed", true); failedGroup("unknown");
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "budget_exhausted" })!;
  expect(view.stats.excludedGroups).toBe(2);
  expect(view.notices.join()).toContain("1 组练习未成功发布"); expect(view.notices.join()).toContain("1 组练习的生成结果尚未确认");
  expect(view.notices.join()).not.toContain("存在用户疑问"); expect(view.notices.join()).not.toContain("来源或记录不可用");
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("rejects cross-account and cross-page projection instead of leaking historical evidence", async () => {
  const original = group(); await adjust(); await readAndAssociate(original);
  expect(() => projectLearningAgentReviewSummary(learning, { ...ctx.task, accountId: "intruder", status: "ended" })).toThrow("agent_not_found");
  const otherPage = randomUUID(); learning.create({ id: otherPage, title: "[合成] 其他页面" });
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, resourceId: otherPage, status: "ended" })!;
  expect(view.topics).toEqual([]); expect(JSON.stringify(view)).not.toContain(original.id);
});
