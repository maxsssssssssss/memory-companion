// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { learningAgentActionPreferences } from "@/lib/domain/learning-agent-preferences";
import type { LearningCheckPurpose, LearningReviewPlanInput } from "@/lib/domain/learning-agent-completion";
import type { AgentContext, AgentDecision, AgentDecisionProvider } from "@/lib/server/agent/types";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { AgentStore } from "@/lib/server/agent/store";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { freezeLearningAgentScope } from "./agent-scope";
import { createLearningAgentScenario } from "./agent-scenario";
import { withLearningCompletionDecision } from "./agent-context";
import { assessLearningCompletion, readLearningReviewPlan } from "./agent-completion";
import type { generateStudyJson } from "./framework-generator";

let directory: string, learning: LearningRepository, store: AgentStore, pageId: string, materialId: string;
const config = { baseURL: "https://offline.invalid", apiKey: "SYNTHETIC", model: "offline", maxInputChars: 48000, maxOutputTokens: 8000 };
const selection = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false });
const purpose = (explanation: boolean): LearningCheckPurpose => ({ objectiveIds: ["membership"], role: explanation ? "concept" : "application",
  method: explanation ? "explain" : "retrieval", purpose: explanation ? "说明交集与并集的归属条件" : "初步观察交集与并集的元素归属判断", priorEvidenceRefs: [] });
function plan(kind: LearningReviewPlanInput["kind"]): LearningReviewPlanInput {
  return { kind, objectives: [{ id: "membership", label: "交集与并集的元素归属", sources: [{ materialId, paragraph: 1 }],
    requirements: kind === "explanation" ? [] : [{ role: "application", description: "判断同时或仅属于一个集合的元素是否属于交集和并集", independent: kind === "chapter_check" }] }] };
}
const generate = vi.fn(async (_config, name, _prompt, raw) => {
  if (name === "learning_agent_explanation") return { materialAnswer: "交集要求元素同时属于两个集合；并集只需属于其中至少一个集合。", supplements: [],
    items: [{ materialId, paragraph: 1 }] };
  const input = raw as { taskContext: { referenceScope: string; reviewContext: { purpose: LearningCheckPurpose } }; materials: Array<{ paragraphs: Array<{ referenceId: string }> }> };
  const refs = input.materials[0].paragraphs.map(p => p.referenceId);
  return { contractVersion: "references-v2", referenceScope: input.taskContext.referenceScope, title: "[离线] 交集与并集", reason: null,
    materialPlan: [{ material: 1, contribution: "归属条件", references: refs }],
    items: [
      { stem: "已知集合 P={1,2}，Q={2,3}。元素2同时属于两个集合，是否属于交集？", correct: "属于交集", wrong: "不属于交集",
        explanation: "元素2同时属于两个集合，满足交集条件。" },
      { stem: "已知集合 P={1,2}，Q={2,3}。元素1只属于P，是否属于并集？", correct: "属于并集", wrong: "不属于并集",
        explanation: "元素1属于至少一个集合，满足并集条件。" },
    ].map(q => ({ stem: q.stem, scenario: null, kind: "concept", hint: null, stemEvidenceIds: refs, correctOptionId: "A",
      explanationParts: [{ text: q.explanation, evidenceIds: refs }], options: [
        { id: "A", text: q.correct, reasonParts: [{ text: q.explanation, evidenceIds: refs }] },
        { id: "B", text: q.wrong, reasonParts: [{ text: q.explanation, evidenceIds: refs }] },
      ], reviewCheck: { objectiveIds: ["membership"], role: "application", rationale: "[离线关联] 题目直接检查交集或并集的成员归属条件，未声称长期掌握。" } })),
  };
}) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "learning-natural-input-")); learning = new LearningRepository(directory, "owner");
  store = AgentStore.open(join(directory, "agents.sqlite")); pageId = randomUUID(); materialId = randomUUID();
  learning.create({ id: pageId, title: "[合成] 普通输入" });
  learning.saveMaterials(pageId, [
    { id: materialId, title: "[合成] 归属条件", kind: "text", filename: null,
      bytes: Buffer.from("交集由同时属于两个集合的元素组成。并集由属于至少一个集合的元素组成。设P={1,2}，Q={2,3}，交集为{2}，并集为{1,2,3}。") },
    { id: randomUUID(), title: "[合成] 未授权", kind: "text", filename: null, bytes: Buffer.from("PRIVATE_UNSELECTED_MATERIAL") },
  ]);
  generate.mockClear(); vi.stubGlobal("fetch", vi.fn(() => { throw Error("network_forbidden"); }));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); store.close(); learning.close(); await rm(directory, { recursive: true, force: true });
});

// The action choices below are deliberately controlled. This verifies execution
// of product defaults/explicit preferences, not a real DS intent success rate.
it.each([
  { goal: "练习交集与并集", kind: "diagnosis" },
  { goal: "考考我", kind: "diagnosis" },
  { goal: "帮我复习一下", kind: "diagnosis" },
  { goal: "我想练练这部分", kind: "diagnosis" },
  { goal: "交集是什么意思？我不懂", kind: "explanation" },
  { goal: "我不理解具体的定义，帮帮我", kind: "explanation" },
  { goal: "先出两道题看看", kind: "diagnosis" },
  { goal: "只解释，不要做题", kind: "explanation" },
  { goal: "复习一下这一章", kind: "chapter_check" },
] as const)("runs a legal default from the unchanged ordinary goal: $goal", async ({ goal, kind }) => {
  const task = store.createTask({ accountId: "owner", resourceId: pageId, scenario: "learning.adaptive-review.v1", goal,
    scope: { ...freezeLearningAgentScope(learning, pageId, selection()), completionVersion: 1 } });
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  expect(scene.instructions).toContain("不要要求用户填写目标类型");
  expect(scene.instructions).toContain("不把普通练习机械设为targeted_review");
  const decision = vi.fn<AgentDecisionProvider>(async (input, ctx) => ctx.call({ kind: "offline_decision", inputChars: 100, maxOutputTokens: 200 }, async () => {
    expect(input.task.goal).toBe(goal);
    expect(input.observation).toMatchObject({ goal, preferences: learningAgentActionPreferences(goal), scope: selection() });
    expect(JSON.stringify(input.observation)).not.toContain("PRIVATE_UNSELECTED_MATERIAL");
    let value: AgentDecision;
    if (!readLearningReviewPlan(learning, ctx.task)) value = { tool: "learning.establish_review_plan", args: plan(kind) };
    else if (!input.results.some(row => row.tool === "learning.read_source")) value = { tool: "learning.read_source", args: { materialId, paragraph: 1 } };
    else if (kind !== "explanation") value = { tool: "learning.create_quiz", args: {
      count: learningAgentActionPreferences(goal).initialQuizCount ?? 2, difficulty: "basic", purpose: purpose(false) } };
    else if (!input.results.some(row => row.tool === "learning.explain")) value = { tool: "learning.explain",
      args: { question: goal, sources: [{ materialId, paragraph: 1 }], purpose: purpose(true) } };
    else value = { tool: "learning.request_feedback", args: { question: "还有哪里不清楚？", intent: "clarification" } };
    return { value, usage: { inputTokens: 10, outputTokens: 8 } };
  }));
  const runtime = new AgentRuntime({ store, checkpointPath: join(directory, "checkpoints.sqlite"), scenario: scene, decision: withLearningCompletionDecision(learning, decision) });
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result.status).toBe("waiting"); expect(result.goal).toBe(goal);
    expect(readLearningReviewPlan(learning, result)?.kind).toBe(kind);
    expect(assessLearningCompletion(learning, result).canAutoFinish).toBe(false);
    const runs = new LearningQuizRepository(learning).list(pageId);
    if (kind === "explanation") {
      expect(result.wait?.kind).toBe("feedback"); expect(runs).toHaveLength(0);
      expect(result.actions.at(-1)?.tool).toBe("learning.request_feedback");
    } else {
      expect(result.wait?.kind).toBe("quiz_submission"); expect(runs).toMatchObject([{ status: "completed", count: 2, settings: { count: 2, difficulty: "basic" } }]);
      expect(result.actions.some(action => action.tool === "learning.request_feedback")).toBe(false);
      const hidden = new LearningQuizRepository(learning).attempt(pageId, result.wait!.refId!);
      expect(hidden.questions).toHaveLength(2);
      expect(JSON.stringify(hidden)).not.toMatch(/correctOptionId|explanationParts/);
    }
    const calls = result.usage.calls;
    expect((await runtime.advance("owner", task.id)).usage.calls).toBe(calls);
    expect(generate).toHaveBeenCalledTimes(1);
  } finally { runtime.close(); }
});

it("rejects 考考我 without authorized material before creating a task or making a call", () => {
  expect(() => freezeLearningAgentScope(learning, pageId, { ...selection(), materialIds: [] })).toThrow();
  expect(generate).not.toHaveBeenCalled();
  expect(store.database.prepare("SELECT count(*) AS count FROM agent_tasks").get()).toEqual({ count: 0 });
});

it.each([
  { goal: "只解释，不要做题", count: 2, error: "agent_quiz_user_declined" },
  { goal: "先出两道题看看", count: 1, error: "agent_quiz_requested_count_mismatch" },
])("enforces explicit preference before generation: $goal", async ({ goal, count, error }) => {
  const task = store.createTask({ accountId: "owner", resourceId: pageId, scenario: "learning.adaptive-review.v1", goal,
    scope: { ...freezeLearningAgentScope(learning, pageId, selection()), completionVersion: 1 } });
  const ctx: AgentContext = { task, actionId: randomUUID(), assertActive: async () => {}, signal: new AbortController().signal,
    call: async (_request, invoke) => (await invoke()).value };
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  await expect(scene.tools["learning.create_quiz"].execute({ count, difficulty: "basic", purpose: purpose(false) }, ctx))
    .rejects.toMatchObject({ code: "known_failure", message: error });
  expect(generate).not.toHaveBeenCalled(); expect(new LearningQuizRepository(learning).list(pageId)).toEqual([]);
});

it("does not treat a negated only-explain preference or generic practice as a ban or a new task type", () => {
  expect(learningAgentActionPreferences("不要只解释，先考两道题")).toMatchObject({ quizAllowed: true, initialQuizCount: 2 });
  expect(learningAgentActionPreferences("不是不想做题，只是不理解定义")).toMatchObject({ quizAllowed: true });
  expect(learningAgentActionPreferences("先出两道题看看")).toMatchObject({ quizAllowed: true, initialQuizCount: 2 });
  expect(learningAgentActionPreferences("不要先出两道题")).not.toHaveProperty("initialQuizCount");
  expect(learningAgentActionPreferences("练习交集与并集")).toMatchObject({ quizAllowed: true });
  expect(learningAgentActionPreferences("练习交集与并集")).not.toHaveProperty("initialQuizCount");
});

it("rejects a Quiz-dependent plan for an explicit explanation-only request without rewriting it", async () => {
  const task = store.createTask({ accountId: "owner", resourceId: pageId, scenario: "learning.adaptive-review.v1", goal: "只解释，不要做题",
    scope: { ...freezeLearningAgentScope(learning, pageId, selection()), completionVersion: 1 } });
  const ctx: AgentContext = { task, actionId: randomUUID(), assertActive: async () => {}, signal: new AbortController().signal,
    call: async (_request, invoke) => (await invoke()).value };
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  await expect(scene.tools["learning.establish_review_plan"].execute(plan("diagnosis"), ctx))
    .rejects.toMatchObject({ code: "known_failure", message: "agent_plan_user_preference_mismatch" });
  expect(readLearningReviewPlan(learning, task)).toBeNull(); expect(generate).not.toHaveBeenCalled();
  await scene.tools["learning.establish_review_plan"].execute(plan("explanation"), ctx);
  expect(readLearningReviewPlan(learning, task)?.kind).toBe("explanation");
});
