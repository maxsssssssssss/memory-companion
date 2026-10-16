// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "@/lib/domain/agent";
import type { LearningAgentScope } from "@/lib/domain/learning-agent";
import type { LearningCheckPurpose, LearningReviewPlanInput } from "@/lib/domain/learning-agent-completion";
import type { AgentContext } from "@/lib/server/agent/types";
import { AgentStore } from "@/lib/server/agent/store";
import { LearningRepository } from "./repository";
import { freezeLearningAgentScope } from "./agent-scope";
import { establishLearningReviewPlan, readLearningReviewPlan } from "./agent-completion";
import { LearningAgentRepository } from "./agent-repository";
import { createLearningAgentScenario } from "./agent-scenario";
import type { generateStudyJson } from "./framework-generator";
import { assertLearningPlanSourcesPresented, learningPlanSourceContext, materializeLearningPlanSourceAdjustment,
  prepareLearningPlanSourceAdjustment, projectLearningPlanSourceAdjustment } from "./agent-plan-sources";

let dir: string, learning: LearningRepository, store: AgentStore, task: AgentTask, materialId: string;
const context = (value = task): AgentContext => ({ task: value, actionId: "source-contract", signal: new AbortController().signal,
  assertActive: async () => {}, call: async () => { throw Error("No Provider"); } });
const plan = (): LearningReviewPlanInput => ({ kind: "explanation", objectives: [{ id: "intersection", label: "交集包含什么元素", sources: [{ materialId, paragraph: 1 }], requirements: [] }] });
const corrections = () => [{ objectiveId: "intersection", sources: [{ materialId, paragraph: 2 }] }];
const selection = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "learning-plan-sources-")); learning = new LearningRepository(dir, "owner"); store = AgentStore.open(join(dir, "tasks.sqlite"));
  const pageId = randomUUID(); materialId = randomUUID(); learning.create({ id: pageId, title: "[合成] 资料关联" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 教材", kind: "text", filename: null,
    bytes: Buffer.from("这是合成教材说明。\n\n交集是两个集合中共同的元素。\n\n并集包含至少属于一个集合的元素。") }]);
  task = store.createTask({ id: randomUUID(), accountId: "owner", resourceId: pageId, scenario: "learning.adaptive-review.v1", goal: "解释交集", scope: { ...freezeLearningAgentScope(learning, pageId, selection()), completionVersion: 1 } });
});
afterEach(() => { vi.restoreAllMocks(); store.close(); learning.close(); rmSync(dir, { recursive: true, force: true }); });

describe("Learning plan sources and explicit versioned corrections", () => {
  it("presents actual authorized paragraphs before the first plan, not guessed numeric addresses", async () => {
    const scenario = createLearningAgentScenario(learning), observed = await scenario.observe(context()) as { planSourceContext: ReturnType<typeof learningPlanSourceContext> };
    expect(observed.planSourceContext.paragraphs.map(p => p.text)).toEqual(["这是合成教材说明。", "交集是两个集合中共同的元素。", "并集包含至少属于一个集合的元素。"]);
    expect(observed.planSourceContext.notice).toContain("不等于支持目标的语义已核验");
    expect(JSON.stringify(observed)).not.toContain("apiKey");
  });
  it("omits whole oversized paragraphs and requires an actual current successful source read for the formal plan", () => {
    const huge = randomUUID(); learning.saveMaterials(task.resourceId, [{ id: huge, title: "长材料", kind: "text", filename: null, bytes: Buffer.from("概念".repeat(6000)) }]);
    const scope = { ...freezeLearningAgentScope(learning, task.resourceId, { ...selection(), materialIds: [huge] }), completionVersion: 1 as const };
    task = { ...task, scope }; const input = plan(); input.objectives[0].sources = [{ materialId: huge, paragraph: 1 }];
    expect(learningPlanSourceContext(learning, task)).toMatchObject({ paragraphs: [], omitted: 1 });
    expect(() => assertLearningPlanSourcesPresented(learning, context(), input)).toThrow("agent_plan_source_read_required");
    const action = { id: "read", createdAt: "synthetic", version: 1, step: 1, tool: "learning.read_source", args: {}, status: "succeeded" as const, summary: "", resultRef: { kind: "learning.source", id: `${huge}:1` } };
    task = { ...task, actions: [action] }; expect(() => assertLearningPlanSourcesPresented(learning, context(), input)).not.toThrow();
    task = { ...task, version: 2 }; expect(() => assertLearningPlanSourcesPresented(learning, context(), input)).toThrow("agent_plan_source_read_required");
  });
  it("source preview is read-only, scoped and makes no default correction", () => {
    establishLearningReviewPlan(learning, context(), plan());
    const before = new LearningAgentRepository(learning).list(task.resourceId, task.id);
    const preview = projectLearningPlanSourceAdjustment(learning, task)!;
    expect(preview.objectives[0].currentSources).toEqual([{ materialId, paragraph: 1 }]); expect(preview.sources).toHaveLength(3);
    expect(new LearningAgentRepository(learning).list(task.resourceId, task.id)).toEqual(before);
    expect(() => learningPlanSourceContext(learning, { ...task, accountId: "other" })).toThrow("agent_not_found");
  });
  it("rejects goal changes, objective deletion, unseen refs, and withdrawn scope in a source-only correction", () => {
    establishLearningReviewPlan(learning, context(), plan());
    const scope = task.scope as LearningAgentScope;
    expect(() => prepareLearningPlanSourceAdjustment(learning, task, { goal: "改成更容易的目标", scope }, corrections())).toThrow("agent_source_adjustment_goal_changed");
    expect(() => prepareLearningPlanSourceAdjustment(learning, task, { goal: task.goal, scope }, [{ ...corrections()[0], objectiveId: "other" }])).toThrow("agent_source_adjustment_objectives_changed");
    expect(() => prepareLearningPlanSourceAdjustment(learning, task, { goal: task.goal, scope }, [{ ...corrections()[0], sources: [{ materialId: randomUUID(), paragraph: 2 }] }])).toThrow("agent_scope_forbidden");
  });
  it("explicit correction creates a new immutable plan with original goals/requirements and no budget reset", async () => {
    const input = plan(); input.kind = "targeted_review"; input.objectives[0].requirements = [{ role: "followup", description: "相关新检查", independent: true }];
    const old = establishLearningReviewPlan(learning, context(), input), originalRows = new LearningAgentRepository(learning).list(task.resourceId, task.id);
    const scope = task.scope as LearningAgentScope; const correction = prepareLearningPlanSourceAdjustment(learning, task, { goal: task.goal, scope }, corrections());
    task = store.adjust("owner", task.id, { expectedVersion: 1, eventId: randomUUID(), goal: task.goal, scope: { ...scope, planSourceAdjustment: correction } });
    const usage = task.usage; await materializeLearningPlanSourceAdjustment(learning, context()); await materializeLearningPlanSourceAdjustment(learning, context());
    const saved = readLearningReviewPlan(learning, task)!;
    expect(saved.taskVersion).toBe(2); expect(saved.objectives).toEqual([{ ...old.objectives[0], sources: corrections()[0].sources }]);
    expect(saved.kind).toBe(old.kind); expect(store.getTask("owner", task.id).usage).toEqual(usage);
    expect(new LearningAgentRepository(learning).list(task.resourceId, task.id).filter(row => row.task_version === 1)).toEqual(originalRows);
    expect(new LearningAgentRepository(learning).list(task.resourceId, task.id).filter(row => row.kind === "review_plan")).toHaveLength(2);
    expect(() => store.assertVersion("owner", task.id, 1)).toThrow();
  });
  it("finishes a consented local plan write after restart without a model or overwriting the old plan", async () => {
    establishLearningReviewPlan(learning, context(), plan()); const scope = task.scope as LearningAgentScope;
    const snapshot = prepareLearningPlanSourceAdjustment(learning, task, { goal: task.goal, scope }, corrections());
    task = store.adjust("owner", task.id, { expectedVersion: 1, goal: task.goal, scope: { ...scope, planSourceAdjustment: snapshot } });
    expect(readLearningReviewPlan(learning, task)).toBeNull();
    store.close(); learning.close(); learning = new LearningRepository(dir, "owner"); store = AgentStore.open(join(dir, "tasks.sqlite")); task = store.getTask("owner", task.id);
    const ctx = context(); const call = vi.spyOn(ctx, "call"); await createLearningAgentScenario(learning).observe(ctx);
    expect(readLearningReviewPlan(learning, task)!.objectives[0].sources).toEqual(corrections()[0].sources); expect(call).not.toHaveBeenCalled();
  });
  it("rejects stale source snapshots and does not turn a removed source into a new plan", async () => {
    establishLearningReviewPlan(learning, context(), plan()); const scope = task.scope as LearningAgentScope;
    const snapshot = prepareLearningPlanSourceAdjustment(learning, task, { goal: task.goal, scope }, corrections());
    task = store.adjust("owner", task.id, { expectedVersion: 1, goal: task.goal, scope: { ...scope, planSourceAdjustment: snapshot } });
    learning.deleteMaterial(task.resourceId, materialId);
    await expect(materializeLearningPlanSourceAdjustment(learning, context())).rejects.toThrow();
    expect(() => projectLearningPlanSourceAdjustment(learning, task)).toThrow();
  });
  it.each(["cancel", "adjust"] as const)("fences %s before a delayed correction can save an obsolete plan", async change => {
    establishLearningReviewPlan(learning, context(), plan()); const scope = task.scope as LearningAgentScope;
    const snapshot = prepareLearningPlanSourceAdjustment(learning, task, { goal: task.goal, scope }, corrections());
    task = store.adjust("owner", task.id, { expectedVersion: 1, goal: task.goal, scope: { ...scope, planSourceAdjustment: snapshot } });
    const old = task, ctx = { ...context(old), assertActive: async () => {
      const current = store.assertVersion("owner", old.id, old.version!);
      if (current.status === "cancelled") throw Error("inactive");
    } };
    if (change === "cancel") store.control("owner", task.id, "cancel", 2);
    else store.adjust("owner", task.id, { expectedVersion: 2, goal: "新的明确目标", scope });
    await expect(materializeLearningPlanSourceAdjustment(learning, ctx)).rejects.toThrow();
    expect(new LearningAgentRepository(learning).list(task.resourceId, task.id).filter(row => row.kind === "review_plan")).toHaveLength(1);
  });

});


describe("explanation source-purpose preflight", () => {
  const purpose = (objectiveIds = ["intersection"]): LearningCheckPurpose => ({ objectiveIds, role: "concept", method: "explain",
    purpose: "[合成] 说明当前目标引用的原文", priorEvidenceRefs: [] });
  const offline = () => {
    const configure = vi.fn(() => ({ baseURL: "https://offline.invalid/v1", apiKey: "SYNTHETIC", model: "offline-fixture", maxInputChars: 24000, maxOutputTokens: 900 }));
    const answer = { materialAnswer: "[合成离线响应] 这段说明教材的用途。", supplements: [], items: [{ materialId, paragraph: 1 }] };
    const generate = vi.fn(async () => answer);
    const scenario = createLearningAgentScenario(learning, { configure, generate: generate as unknown as typeof generateStudyJson });
    const ctx = context(); ctx.call = async (_request, invoke) => (await invoke()).value;
    return { configure, generate, answer, scenario, ctx, call: vi.spyOn(ctx, "call") };
  };
  it("rejects a nonintersecting requested source before reserve or generation, then saves a valid matching explanation", async () => {
    establishLearningReviewPlan(learning, context(), plan());
    const { configure, generate, answer, scenario, ctx, call } = offline(), reserve = vi.spyOn(LearningAgentRepository.prototype, "reserve");
    const tool = scenario.tools["learning.explain"], args = { question: "[合成] 说明当前目标", sources: [{ materialId, paragraph: 2 }], purpose: purpose() };
    await expect(tool.execute(args, ctx)).rejects.toMatchObject({ code: "known_failure", message: "agent_explanation_plan_source_mismatch", publicSummary: expect.stringContaining("尚未发起生成") });
    expect(configure).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(new LearningAgentRepository(learning).list(task.resourceId, task.id).filter(row => row.kind === "explanation")).toHaveLength(0);
    const result = await tool.execute({ ...args, sources: [{ materialId, paragraph: 1 }] }, ctx);
    expect(result.ref?.kind).toBe("learning.explanation"); expect(configure).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(1);
    const saved = new LearningAgentRepository(learning).get(task.resourceId, task.id, result.ref!.id)!;
    expect(saved.state).toBe("completed"); expect(JSON.parse(saved.body_json!)).toMatchObject(answer);
    expect(JSON.parse(saved.body_json!).reviewContext.purpose).toEqual(args.purpose);
  });
  it("requires a source intersection for each purpose objective instead of accepting one overlapping objective", async () => {
    const input = plan(); input.objectives.push({ id: "union", label: "并集的含义", sources: [{ materialId, paragraph: 3 }], requirements: [] });
    establishLearningReviewPlan(learning, context(), input);
    const { configure, generate, scenario, ctx, call } = offline(), reserve = vi.spyOn(LearningAgentRepository.prototype, "reserve");
    await expect(scenario.tools["learning.explain"].execute({ question: "[合成] 说明两个目标", sources: [{ materialId, paragraph: 1 }], purpose: purpose(["intersection", "union"]) }, ctx))
      .rejects.toMatchObject({ code: "known_failure", message: "agent_explanation_plan_source_mismatch" });
    expect(configure).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it("keeps unauthorized and deleted source failures separate and writes no explanation", async () => {
    establishLearningReviewPlan(learning, context(), plan());
    const { configure, generate, scenario, ctx, call } = offline(), reserve = vi.spyOn(LearningAgentRepository.prototype, "reserve");
    const args = { question: "[合成] 说明当前目标", sources: [{ materialId: randomUUID(), paragraph: 1 }], purpose: purpose() };
    await expect(scenario.tools["learning.explain"].execute(args, ctx)).rejects.toMatchObject({ code: "forbidden", message: "agent_source_forbidden" });
    learning.deleteMaterial(task.resourceId, materialId);
    await expect(scenario.tools["learning.explain"].execute({ ...args, sources: [{ materialId, paragraph: 1 }] }, ctx)).rejects.toMatchObject({ code: "source_changed" });
    expect(configure).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(new LearningAgentRepository(learning).list(task.resourceId, task.id).filter(row => row.kind === "explanation")).toHaveLength(0);
  });
});
