// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@/lib/domain/agent";
import type { QuizActionInput, QuizAttemptView } from "@/lib/domain/learning-quiz";
import { AgentFailure, type AgentContext } from "@/lib/server/agent/types";
import { AgentStore } from "@/lib/server/agent/store";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningAgentRepository } from "./agent-repository";
import { freezeLearningAgentScope } from "./agent-scope";
import { projectLearningAgentReviewSummary, saveLearningAgentReviewSummary } from "./agent-review-summary";
import { createLearningAgentScenario } from "./agent-scenario";
import { projectLearningAgentTask } from "./agent-api-service";
import type { generateStudyJson } from "./framework-generator";

let directory: string, learning: LearningRepository, quizzes: LearningQuizRepository, pageId: string, materialId: string, ctx: AgentContext;
const settings = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" });
const config = { baseURL: "https://tokenhub.vision-intelligence.tech/v1", apiKey: "SYNTHETIC", model: "deepseek-v4-pro", maxInputChars: 24000, maxOutputTokens: 6000 };
function act(attempt: QuizAttemptView, action: QuizActionInput["action"], optionId: string | null = null, question = 0) {
  return quizzes.act(pageId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action, question, optionId });
}
function group(answer: "correct" | "wrong" | "hint" | "reveal" | "skip" | "incomplete" = "wrong", paragraph = 1, task = ctx.task) {
  const id = randomUUID(); quizzes.begin(pageId, { id, settings: settings() }, 24000);
  quizzes.complete(pageId, id, { title: "[合成] 条件判断", reason: null, items: [{ stem: `[合成] 前提${paragraph}未满足时，能应用规则吗？`, kind: "concept",
    options: [{ id: "A", text: "不能应用", reason: "前提未满足时不能应用规则。" }, { id: "B", text: "能够应用", reason: "先检查规则前提，不要把前提不成立当成规则结果。" }], correctOptionId: "A", hint: "先看条件。", explanation: "只有前提满足时才可应用规则。", sources: [{ kind: "material", materialId, paragraph }] }] });
  let attempt = quizzes.startAttempt(pageId, { id: randomUUID(), quizId: id, mode: "practice" });
  if (answer === "reveal" || answer === "skip") attempt = act(attempt, answer);
  else if (answer !== "incomplete") {
    if (answer === "hint") attempt = act(attempt, "hint");
    attempt = act(attempt, "choose", answer === "wrong" ? "B" : "A"); attempt = act(attempt, "submit");
  }
  const artifacts = new LearningAgentRepository(learning);
  artifacts.reserve({ id, taskId: task.id, taskVersion: task.version ?? 1, pageId, kind: "quiz", actionId: randomUUID(), binding: (task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] });
  artifacts.complete(pageId, task.id, id, { attemptId: attempt.id });
  return attempt;
}
const enrich = () => vi.fn(async (topics: Array<{ id: string }>) => ({ items: topics.map(topic => ({ id: topic.id, explanation: "[模拟归纳] 先区分适用条件与应用后的结论，未满足条件时不能直接判定结果。", reminder: "作答前先圈出规则的适用条件。" })) }));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-review-summary-")); learning = new LearningRepository(directory, "owner"); quizzes = new LearningQuizRepository(learning);
  pageId = randomUUID(); materialId = randomUUID(); learning.create({ id: pageId, title: "[合成] 总结" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 条件", kind: "text", filename: null, bytes: Buffer.from("[合成] 前提一成立才可应用规则。\n\n[合成] 前提二不成立时不可推导结果。\n\n[合成] 前提三需要独立检查。\n\n[合成] 前提四也必须成立。") }]);
  const task: AgentTask = { id: randomUUID(), accountId: "owner", scenario: "learning.adaptive-review.v1", resourceId: pageId, version: 1, goal: "[合成] 复习条件", scope: freezeLearningAgentScope(learning, pageId, { materialIds: [materialId], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, includeHistory: false }), status: "running", actions: [],
    budget: { maxCalls: 10, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 100000, maxSteps: 10, maxNoProgress: 3 },
    usage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0, computeMs: 0, steps: 0 }, createdAt: "synthetic", updatedAt: "synthetic" };
  ctx = { task, actionId: "decision:4", signal: new AbortController().signal, assertActive: async () => {}, call: async (_request, invoke) => { task.usage.calls++; return (await invoke()).value; } };
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(async () => { if (learning.database.open) learning.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it("aggregates earlier wrong and later correct groups, groups shared sources and enriches only once across reopen", async () => {
  const earlier = group("wrong"), sameTopic = group("wrong"), later = group("correct"), generate = enrich();
  const summary = await saveLearningAgentReviewSummary(learning, ctx, generate);
  expect(summary.stats).toMatchObject({ groups: 3, total: 3, answered: 3, correct: 1, wrong: 2, unassistedCorrect: 1 });
  expect(summary.kind).toBe("completed"); expect(summary.headline).not.toContain("全部"); expect(summary.topics).toHaveLength(1);
  expect(summary.topics[0].questionRefs).toEqual([{ quizId: earlier.quizId, attemptId: earlier.id, index: 0 }, { quizId: sameTopic.quizId, attemptId: sameTopic.id, index: 0 }]);
  expect(summary.topics[0].sources).toEqual([{ materialId, paragraph: 1 }]); expect(summary.topics[0].explanation).toContain("模拟归纳");
  expect(summary.reminders[0]).toBe("作答前先圈出规则的适用条件。"); expect(summary.reminders.length).toBeLessThanOrEqual(3);
  learning.close(); learning = new LearningRepository(directory, "owner");
  expect(await saveLearningAgentReviewSummary(learning, ctx, generate)).toEqual(summary); expect(generate).toHaveBeenCalledTimes(1);
  expect(projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })).toEqual(summary);
  expect(new LearningQuizRepository(learning).attempt(pageId, later.id)).toEqual(later);
});
it("independent all-correct produces short praise without generation", async () => {
  group("correct"); group("correct"); const generate = enrich(), summary = await saveLearningAgentReviewSummary(learning, ctx, generate);
  expect(summary.headline).toBe("本轮 2 题均答对，应用内未记录提示或提前查看答案。"); expect(summary.topics).toEqual([]); expect(summary.reminders).toEqual([]); expect(generate).not.toHaveBeenCalled();
});
it("separates hints, skipped and revealed questions from actual wrong submissions", async () => {
  group("hint"); group("skip"); group("reveal"); const generate = enrich(), summary = await saveLearningAgentReviewSummary(learning, ctx, generate);
  expect(summary.stats).toMatchObject({ total: 3, answered: 1, correct: 1, wrong: 0, unassistedCorrect: 0, hinted: 1, skipped: 1, revealed: 1 });
  expect(summary.headline).not.toContain("独立"); expect(summary.topics).toEqual([]); expect(generate).not.toHaveBeenCalled(); expect(summary.notices.join()).toContain("不作为知识错误");
});
it("preserves unfinished progress and does not call skipped items knowledge errors", async () => {
  group("incomplete"); group("skip"); const summary = await saveLearningAgentReviewSummary(learning, ctx, enrich());
  expect(summary.kind).toBe("partial"); expect(summary.stats).toMatchObject({ wrong: 0, unanswered: 1, skipped: 1 }); expect(summary.headline).toContain("未完成学习检查");
});
it("reuses a saved explanation when it covers the grouped sources", async () => {
  group("wrong"); const artifacts = new LearningAgentRepository(learning), id = randomUUID();
  artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: 1, pageId, kind: "explanation", actionId: randomUUID(), binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] });
  artifacts.complete(pageId, ctx.task.id, id, { id, taskId: ctx.task.id, taskVersion: 1, question: "[合成] 前提1未满足时，能应用规则吗？", materialAnswer: "[已有讲解] 先确认前提，再判断结论。", supplements: [], items: [{ materialId, paragraph: 1 }] });
  const generate = enrich(), summary = await saveLearningAgentReviewSummary(learning, ctx, generate);
  expect(summary.topics[0].explanation).toContain("已有讲解"); expect(generate).not.toHaveBeenCalled();
});
it("keeps prior versions and other tasks out of current statistics", async () => {
  group("wrong", 1, { ...ctx.task, version: 2 }); group("wrong", 1, { ...ctx.task, id: randomUUID() }); group("correct");
  const summary = await saveLearningAgentReviewSummary(learning, ctx, enrich()); expect(summary.stats).toMatchObject({ groups: 1, correct: 1, wrong: 0 });
});
it("excludes disputed groups and invalidates a saved all-correct summary after completion", async () => {
  const a = group("correct"), b = group("correct"); await saveLearningAgentReviewSummary(learning, ctx, enrich());
  new LearningAgentRepository(learning).dispute(pageId, ctx.task.id, a.id);
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.kind).toBe("partial"); expect(view.stats).toMatchObject({ total: 1, excludedGroups: 1 }); expect(view.headline).not.toContain("全部"); expect(view.topics).toEqual([]);
  expect(quizzes.attempt(pageId, a.id).score?.correct).toBe(1); expect(quizzes.attempt(pageId, b.id).score?.correct).toBe(1);
});
it("excludes a persisted dispute event even if Learning artifact update was lost", async () => {
  const a = group("wrong"), store = AgentStore.open(join(directory, "summary-events.sqlite"));
  try {
    store.createTask(ctx.task);
    store.pauseForFeedback("owner", ctx.task.id, { id: randomUUID(), kind: "quiz_dispute", refId: a.id, message: "[合成] 质疑此题", version: 1 }, 1);
    const projected = projectLearningAgentTask(learning, { ...ctx.task, status: "ended" }, store);
    expect(projected.reviewSummary?.stats).toMatchObject({ wrong: 0, excludedGroups: 1 }); expect(projected.reviewSummary?.topics).toEqual([]);
  } finally { store.close(); }
});
it("hides cached diagnosis when source is deleted or authorization changes", async () => {
  group("wrong"); await saveLearningAgentReviewSummary(learning, ctx, enrich()); learning.deleteMaterial(pageId, materialId);
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.kind).toBe("partial"); expect(view.topics).toEqual([]); expect(view.stats.wrong).toBe(0); expect(view.headline).toContain("授权已变化");
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id).filter(r => r.kind === "review_summary")[0]).toMatchObject({ state: "invalidated", body_json: null });
});
it("does not show stale diagnosis after a quiz is deleted", async () => {
  const attempt = group("wrong"); await saveLearningAgentReviewSummary(learning, ctx, enrich()); quizzes.delete(pageId, attempt.quizId);
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(view.stats).toMatchObject({ wrong: 0, excludedGroups: 1 }); expect(view.topics).toEqual([]);
});
it.each(["cancelled", "budget_exhausted", "ended"] as const)("renders %s historical/handoff tasks as read-only partial progress", status => {
  group("correct"); const before = new LearningAgentRepository(learning).list(pageId, ctx.task.id);
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status })!;
  expect(view.kind).toBe("partial"); expect(view.headline).not.toContain("全部独立答对"); expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id)).toEqual(before); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each(["known_failure", "budget"] as const)("keeps local facts and concrete reminders after %s without retry", async code => {
  group("wrong"); const generate = vi.fn(async () => { throw new AgentFailure(code, "synthetic"); });
  const summary = await saveLearningAgentReviewSummary(learning, ctx, generate);
  expect(summary.stats.wrong).toBe(1); expect(summary.topics[0].explanation).toContain("前提"); expect(summary.reminders[0]).toContain("规则前提"); expect(summary.notices.join()).toContain("专项归纳暂未完成");
  await saveLearningAgentReviewSummary(learning, ctx, generate); expect(generate).toHaveBeenCalledTimes(1);
});
it("rejects fabricated topic ids and mastery claims while retaining factual fallback", async () => {
  group("wrong"); const summary = await saveLearningAgentReviewSummary(learning, ctx, async () => ({ items: [{ id: "invented", explanation: "用户已经完全掌握", reminder: "通过核验" }] }));
  expect(JSON.stringify(summary)).not.toContain("已经完全掌握"); expect(summary.stats.wrong).toBe(1); expect(summary.notices.join()).toContain("暂未完成");
});
it("retains unknown outcome and never automatically regenerates", async () => {
  group("wrong"); const generate = vi.fn(async () => { throw new AgentFailure("unknown", "synthetic_unknown"); });
  await expect(saveLearningAgentReviewSummary(learning, ctx, generate)).rejects.toMatchObject({ code: "unknown" });
  await expect(saveLearningAgentReviewSummary(learning, ctx, generate)).rejects.toMatchObject({ code: "unknown" }); expect(generate).toHaveBeenCalledTimes(1);
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "needs_attention", recovery: { kind: "unknown", message: "unknown", allowedControls: ["inspect"] } })!;
  expect(view.kind).toBe("partial"); expect(view.stats.wrong).toBe(1); expect(view.notices.join()).toContain("不会自动重新生成");
});
it("fences a late summary after cancellation", async () => {
  group("wrong"); let active = true; ctx.assertActive = async () => { if (!active) throw new AgentFailure("inactive", "cancelled"); };
  const generate = enrich();
  await expect(saveLearningAgentReviewSummary(learning, ctx, async input => { active = false; return generate(input); })).rejects.toMatchObject({ code: "inactive" });
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id).filter(r => r.kind === "review_summary")[0]).toMatchObject({ state: "failed", body_json: null });
});
it("fences a late summary after source deletion or a new dispute", async () => {
  const a = group("wrong"); const generate = enrich();
  await expect(saveLearningAgentReviewSummary(learning, ctx, async input => { new LearningAgentRepository(learning).dispute(pageId, ctx.task.id, a.id); return generate(input); })).rejects.toMatchObject({ code: "source_changed" });
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id).filter(r => r.kind === "review_summary")[0].body_json).toBeNull();
});
it("finishes with persisted facts without depending on an optional summary model call", async () => {
  group("wrong");
  const generate = vi.fn(async () => { throw new AgentFailure("unknown", "optional_summary_unavailable"); }) as unknown as typeof generateStudyJson;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const reason = await scene.finish!("已经掌握", ctx);
  expect(reason).toContain("已保存本轮复习总结"); expect(reason).not.toContain("检查通过");
  expect(generate).not.toHaveBeenCalled(); expect(ctx.task.usage.calls).toBe(0);
  const summary = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(summary.stats).toMatchObject({ wrong: 1, correct: 0 });
  expect(summary.topics[0].explanation).toContain("先检查规则前提");
  await scene.finish!("已经掌握", ctx); expect(ctx.task.usage.calls).toBe(0); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("does not reuse an unrelated explanation merely because it cites the same paragraph", async () => {
  group("wrong"); const artifacts = new LearningAgentRepository(learning), id = randomUUID();
  artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: 1, pageId, kind: "explanation", actionId: randomUUID(), binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] });
  artifacts.complete(pageId, ctx.task.id, id, { id, taskId: ctx.task.id, question: "[合成] 另一个概念", materialAnswer: "UNRELATED_EXPLANATION", supplements: [], items: [{ materialId, paragraph: 1 }] });
  const generate = enrich(), summary = await saveLearningAgentReviewSummary(learning, ctx, generate);
  expect(generate).toHaveBeenCalledTimes(1); expect(JSON.stringify(summary)).not.toContain("UNRELATED_EXPLANATION");
});
it("keeps source rejection visible after deletion during summary generation", async () => {
  group("wrong"); const generate = enrich();
  await expect(saveLearningAgentReviewSummary(learning, ctx, async input => { learning.deleteMaterial(pageId, materialId); return generate(input); })).rejects.toThrow("material_deleted");
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id).filter(r => r.kind === "review_summary")[0]).toMatchObject({ state: "invalidated", body_json: null });
});
it("cannot access another account's summary", async () => {
  group("wrong"); await saveLearningAgentReviewSummary(learning, ctx, enrich());
  expect(() => projectLearningAgentReviewSummary(learning, { ...ctx.task, accountId: "intruder", status: "ended" })).toThrow("agent_not_found");
});
it("preserves a valid new summary after a disputed group is excluded on both event and artifact paths", async () => {
  const a = group("wrong"); group("wrong", 2); new LearningAgentRepository(learning).dispute(pageId, ctx.task.id, a.id);
  const summary = await saveLearningAgentReviewSummary(learning, ctx, enrich());
  const projected = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" }, [a.id]);
  expect(projected).toEqual(summary); expect(projected?.stats).toMatchObject({ wrong: 1, excludedGroups: 1 });
  expect(projected?.topics[0].explanation).toContain("模拟归纳");
});
it("does not arbitrarily choose a knowledge node when two nodes share the same source", async () => {
  const framework = new LearningFrameworkRepository(learning), runId = randomUUID();
  framework.begin(pageId, { id: runId, materialIds: [materialId] }, 24000); framework.validating(pageId, runId);
  framework.complete(pageId, runId, { overview: "[合成] 两个概念", chapters: [{ title: "[合成] 章节", explanation: "[合成]", nodes: ["概念甲", "概念乙"].map(title => ({ title, explanation: "[合成]", supplement: null, sources: [{ materialId, paragraph: 1 }] })) }] });
  group("wrong"); const summary = await saveLearningAgentReviewSummary(learning, ctx, enrich());
  expect(summary.topics[0].title).not.toMatch(/概念甲|概念乙/); expect(summary.topics[0].title).toContain("错题回顾");
});
it("retains authorized note-only feedback without asking the model to invent unsupported knowledge", async () => {
  const framework = new LearningFrameworkRepository(learning), runId = randomUUID();
  framework.begin(pageId, { id: runId, materialIds: [materialId] }, 24000); framework.validating(pageId, runId);
  framework.complete(pageId, runId, { overview: "[合成]", chapters: [{ title: "[合成]", explanation: "[合成]", nodes: [{ title: "前提", explanation: "[合成]", supplement: null, sources: [{ materialId, paragraph: 1 }] }] }] });
  const chapter = framework.view(pageId).chapters[0], node = chapter.nodes[0];
  framework.edit(pageId, { kind: "node", chapterId: chapter.id, nodeId: node.id, revision: chapter.revision, title: node.title, explanation: node.explanation, note: "[合成笔记] 先检查前提。" });
  const selection = { materialIds: [], chapterIds: [], nodeIds: [node.id], includeNotes: true, includeSupplements: false, includeHistory: false };
  ctx.task.scope = freezeLearningAgentScope(learning, pageId, selection);
  const id = randomUUID(), input = quizzes.begin(pageId, { id, settings: { materialIds: [], chapterIds: [], nodeIds: [node.id], includeNotes: true, includeSupplements: false, count: 1, difficulty: "standard" } }, 24000)!;
  quizzes.complete(pageId, id, { title: "[合成] 笔记", reason: null, items: [{ stem: "[合成] 先检查什么？", kind: "concept", options: [{ id: "A", text: "前提", reason: "笔记强调先检查前提。" }, { id: "B", text: "结果", reason: "不能跳过前提直接看结果。" }], correctOptionId: "A", hint: null, explanation: "先检查前提。", sources: [{ kind: "note", id: input.extras[0].id }] }] });
  let attempt = quizzes.startAttempt(pageId, { id: randomUUID(), quizId: id, mode: "practice" }); attempt = act(attempt, "choose", "B"); attempt = act(attempt, "submit");
  const artifacts = new LearningAgentRepository(learning); artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: 1, pageId, kind: "quiz", actionId: randomUUID(), binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] }); artifacts.complete(pageId, ctx.task.id, id, { attemptId: attempt.id });
  const generate = enrich(), summary = await saveLearningAgentReviewSummary(learning, ctx, generate);
  expect(generate).not.toHaveBeenCalled(); expect(summary.stats.wrong).toBe(1); expect(summary.topics[0].sources).toEqual([]); expect(summary.topics[0].explanation).toContain("不能跳过前提");
});
it("caps distinct specific reminders at three while retaining every wrong-topic reference", async () => {
  for (let paragraph = 1; paragraph <= 4; paragraph++) group("wrong", paragraph);
  const summary = await saveLearningAgentReviewSummary(learning, ctx, async topics => ({ items: topics.map((t, index) => ({ id: t.id, explanation: `[模拟] 针对第${index + 1}个前提。`, reminder: `检查第${index + 1}个前提。` })) }));
  expect(summary.topics).toHaveLength(4); expect(summary.reminders).toHaveLength(3); expect(summary.topics.flatMap(t => t.questionRefs)).toHaveLength(4);
});
it.each(["cancelled", "budget_exhausted"] as const)("projects current %s notices even when a finish artifact was saved just before interruption", async status => {
  group("wrong"); await saveLearningAgentReviewSummary(learning, ctx, enrich());
  const view = projectLearningAgentReviewSummary(learning, { ...ctx.task, status })!;
  expect(view.kind).toBe("partial"); expect(view.notices.join()).toContain(status === "cancelled" ? "提前取消" : "单次上限");
});
it("finishes from facts even when optional summary generation configuration cannot fit", async () => {
  group("wrong"); const generate = vi.fn() as unknown as typeof generateStudyJson;
  const scene = createLearningAgentScenario(learning, { configure: () => ({ ...config, maxInputChars: 1 }), generate });
  await scene.finish!("结束", ctx); expect(generate).not.toHaveBeenCalled(); expect(ctx.task.usage.calls).toBe(0);
  const summary = projectLearningAgentReviewSummary(learning, { ...ctx.task, status: "ended" })!;
  expect(summary.stats.wrong).toBe(1); expect(summary.notices.join()).toContain("未额外");
});
