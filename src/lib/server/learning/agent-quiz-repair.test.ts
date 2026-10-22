// @vitest-environment node
// Synthetic decisions/responses; real runtime, Quiz codec/service and SQLite.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentTask } from "@/lib/domain/agent";
import type { LearningCheckPurpose } from "@/lib/domain/learning-agent-completion";
import { AgentFailure, type AgentContext, type AgentDecision, type AgentDecisionInput, type AgentDecisionProvider } from "@/lib/server/agent/types";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { AgentStore } from "@/lib/server/agent/store";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningAgentRepository } from "./agent-repository";
import { freezeLearningAgentScope } from "./agent-scope";
import { establishLearningReviewPlan, assessLearningCompletion } from "./agent-completion";
import { createLearningAgentScenario } from "./agent-scenario";
import { withLearningCompletionDecision } from "./agent-context";
import type { generateStudyJson } from "./framework-generator";

let directory: string, learning: LearningRepository, store: AgentStore, task: AgentTask, pageId: string, materialId: string;
const config = { baseURL: "https://offline.invalid/v1", apiKey: "SYNTHETIC", model: "offline", maxInputChars: 24000, maxOutputTokens: 8000 };
const purpose: LearningCheckPurpose = { objectiveIds: ["condition"], role: "boundary", method: "retrieval", purpose: "[合成] 判断规则适用的必要前提", priorEvidenceRefs: [] };
const quiz = (patch: Partial<LearningCheckPurpose> = {}, count = 1): AgentDecision => ({ tool: "learning.create_quiz", args: { count, difficulty: "standard", purpose: { ...purpose, ...patch } } });
const rows = () => new LearningAgentRepository(learning).list(pageId, task.id).flatMap(row => row.body_json ? [JSON.parse(row.body_json)] : []);
const claims = () => rows().filter(row => row.recordType === "quiz_repair");
const decide = (choose: (input: AgentDecisionInput) => AgentDecision): AgentDecisionProvider => vi.fn(async (input, ctx) => ctx.call({ kind: "offline_decision", inputChars: 100, maxOutputTokens: 100 }, async () => ({ value: choose(input), usage: { inputTokens: 10, outputTokens: 4 } })));
const engine = (generate: typeof generateStudyJson, decision: AgentDecisionProvider) => new AgentRuntime({ store, checkpointPath: join(directory, "checkpoints.sqlite"), scenario: createLearningAgentScenario(learning, { configure: () => config, generate }), decision: withLearningCompletionDecision(learning, decision) });
const context = (): AgentContext => ({ task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {}, call: async (_request, invoke) => (await invoke()).value });
function seed(budget?: { maxCalls: number }) {
  task = store.createTask({ accountId: "owner", resourceId: pageId, scenario: "learning.adaptive-review.v1", goal: "[合成] 检查规则适用条件", budget,
    scope: { ...freezeLearningAgentScope(learning, pageId, { materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false }), completionVersion: 1 } });
  establishLearningReviewPlan(learning, context(), { kind: "chapter_check", objectives: [{ id: "condition", label: "判断必要条件",
    sources: [{ materialId, paragraph: 1 }], requirements: [{ role: "boundary", description: "必要前提未满足时不能应用规则", independent: true }] }] });
}
type Wire = { taskContext: { referenceScope: string; repairContext?: { attempt: 1; previousQuizId: string; purpose: LearningCheckPurpose; rejected: Array<{code: string; count: number}> } }; materials: Array<{ paragraphs: Array<{referenceId: string}> }> };
function response(input: unknown, mode: "valid" | "equivalent" | "partial" | "format" = "valid") {
  const wire = input as Wire, refs = wire.materials[0].paragraphs.map(p => p.referenceId);
  const item = { stem: "[合成] 必要前提未满足时能否直接应用规则？", scenario: null, kind: "concept", correctOptionId: "A", stemEvidenceIds: refs,
    explanationParts: [{ text: "必要前提满足才可以应用规则。", evidenceIds: refs }], hint: null,
    options: [{ id: "A", text: "不能直接应用", reasonParts: [{ text: "尚未满足必要前提。", evidenceIds: refs }] },
      { id: "B", text: "能够直接应用", reasonParts: [{ text: "没有核对所需前提。", evidenceIds: refs }] }],
    reviewCheck: { objectiveIds: ["condition"], role: "boundary", rationale: "判断前提未满足时的应用边界。" } };
  const invalid = { ...item, options: item.options.map(option => ({ ...option, text: "不能直接应用" })) };
  return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope, title: mode === "format" ? 42 : "[合成] 条件练习", reason: null,
    materialPlan: [{ material: 1, contribution: "必要前提", references: refs }], items: mode === "partial" ? [item, invalid] : [mode === "equivalent" ? invalid : item] };
}
function generator(choose: (wire: Wire, invocation: number) => "valid" | "equivalent" | "partial" | "format" | "unexpected-root" | AgentFailure) {
  let invocation = 0;
  return vi.fn(async (_config, name, _prompt, input, _schema, _signal, diagnostic) => {
    diagnostic?.({ responseStatus: "completed", responseTextLength: 100, parseResult: "success", validationResult: "success", inputTokens: 31, outputTokens: 17 });
    if (name === "learning_agent_explanation") return { materialAnswer: "[离线] 必要前提未满足，不能直接应用规则。先检查前提。", supplements: [], items: [{ materialId, paragraph: 1 }] };
    const mode = choose(input as Wire, ++invocation); if (mode instanceof AgentFailure) throw mode;
    // Synthetic malformed envelope: emulate the real transport's schema.parse
    // before returning to the Quiz service. This is NOT the missing DS payload.
    if (mode === "unexpected-root") return _schema.parse({ ...response(input), reviewCheck: { rationale: "PRIVATE_VALUE" } });
    return response(input, mode);
  }) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "quiz-one-repair-")); learning = new LearningRepository(directory, "owner"); store = AgentStore.open(join(directory, "agents.sqlite"));
  pageId = randomUUID(); materialId = randomUUID(); learning.create({ id: pageId, title: "[合成] 一次修复" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 必要条件", kind: "text", filename: null, bytes: Buffer.from("[合成] 只有必要前提满足时才可应用规则。必要前提未满足时不能直接应用规则。") }]);
  seed(); vi.stubGlobal("fetch", vi.fn(() => { throw Error("network_forbidden"); }));
});
afterEach(async () => { store.close(); learning.close(); vi.unstubAllGlobals(); await rm(directory, {recursive:true,force:true}); });

it("carries the actual rejection and original purpose into one automatic repair, with both requests charged", async () => {
  const generate = generator((wire, invocation) => {
    if (invocation === 1) { expect(wire.taskContext.repairContext).toBeUndefined(); return "equivalent"; }
    expect(wire.taskContext.repairContext).toMatchObject({ attempt: 1, purpose, rejected: [{ code: "equivalent_options", count: 1 }] });
    return "valid";
  });
  const choose = decide(input => quiz(input.results.length ? { method: "contrast", purpose: "换方法的文字不能改变原检查" } : {}));
  const runtime = engine(generate, choose);
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result).toMatchObject({ status: "waiting", wait: { kind: "quiz_submission" }, usage: { calls: 4, unknownUsageCalls: 0 } });
    expect(generate).toHaveBeenCalledTimes(2); expect(claims()).toHaveLength(1);
    expect(claims()[0]).toMatchObject({ repair: { purpose, previousQuizId: expect.any(String) } });
    expect(new LearningQuizRepository(learning).list(pageId).map(run => run.status).sort()).toEqual(["completed", "insufficient"]);
    expect(assessLearningCompletion(learning, result).outcome).not.toBe("check_passed");
    await runtime.advance("owner", task.id); expect(generate).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { runtime.close(); }
});

it.each([false, true])("a transport envelope rejection has precise private diagnostics and one budgeted repair (exhausted=%s)", async exhausted => {
  if (exhausted) seed({ maxCalls: 2 });
  const generate = generator((wire, invocation) => {
    if (invocation === 1) return "unexpected-root";
    expect(wire.taskContext.repairContext).toMatchObject({ attempt: 1, purpose, rejected: [{ code: "format", count: 1 }] });
    return "valid";
  });
  const choose = decide(() => quiz()), runtime = engine(generate, choose);
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result).toMatchObject({ status: exhausted ? "budget_exhausted" : "waiting", usage: { calls: exhausted ? 2 : 4, unknownUsageCalls: 0 } });
    const failed = learning.database.prepare("SELECT diagnostics_json FROM learning_generation_parts WHERE state='failed'").get() as { diagnostics_json: string };
    expect(JSON.parse(failed.diagnostics_json)).toMatchObject({ responseStatus: "completed", validationResult: "failed",
      validationIssues: [{ path: "$", code: "unrecognized_keys", unrecognizedFields: ["reviewCheck"], unrecognizedFieldCount: 1 }] });
    expect(failed.diagnostics_json).not.toContain("PRIVATE_VALUE");
    const runs = new LearningQuizRepository(learning).list(pageId);
    expect(JSON.stringify(runs)).not.toMatch(/unrecognizedFields|reviewCheck|PRIVATE_VALUE/);
    expect(generate).toHaveBeenCalledTimes(exhausted ? 1 : 2);
    expect(claims()).toHaveLength(exhausted ? 0 : 1);
    expect(learning.database.prepare("SELECT COUNT(*) n FROM learning_generation_parts WHERE state='unknown'").get()).toEqual({ n: 0 });
    await runtime.advance("owner", task.id);
    expect(generate).toHaveBeenCalledTimes(exhausted ? 1 : 2);
    expect(assessLearningCompletion(learning, result).outcome).not.toBe("check_passed");
  } finally { runtime.close(); }
});

it("hands back immediately after a second zero publication without a third decision or generation", async () => {
  const generate = generator(() => "equivalent"), choose = decide(input => quiz({}, input.results.length ? 3 : 1)), runtime = engine(generate, choose);
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result).toMatchObject({ status: "ended", usage: { calls: 4 } });
    expect(result.endReason).toContain("修正过一次"); expect(result.endReason).toContain("不是你的作答错误");
    expect(generate).toHaveBeenCalledTimes(2); expect(choose).toHaveBeenCalledTimes(2); expect(claims()).toHaveLength(1);
    expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(2);
    await runtime.advance("owner", task.id); expect(generate).toHaveBeenCalledTimes(2);
  } finally { runtime.close(); }
});

it("shares the same repair with feedback after a real explanation and checkpoint restart; duplicate and concurrent resumes do not generate again", async () => {
  const generate = generator((_wire, invocation) => invocation === 1 ? "equivalent" : "valid");
  const choose = decide(input => !input.results.length ? quiz() : input.results.at(-1)?.status === "failed"
    ? { tool: "learning.explain", args: { question: "先说明必要前提", sources: [{ materialId, paragraph: 1 }], purpose: { ...purpose, method: "contrast" } } }
    : { tool: "learning.request_feedback", args: { question: "讲解后要做题确认吗？" } });
  let runtime = engine(generate, choose);
  const waiting = await runtime.advance("owner", task.id); expect(waiting.status).toBe("waiting"); expect(claims()).toHaveLength(0);
  runtime.close(); learning.close(); store.close(); learning = new LearningRepository(directory, "owner"); store = AgentStore.open(join(directory, "agents.sqlite"));
  runtime = engine(generate, decide(() => quiz()));
  try {
    const event = { id: randomUUID(), kind: "feedback", version: waiting.version, refId: waiting.wait!.refId, message: "讲解明白了，想做题确认一下。" };
    const results = await Promise.allSettled([runtime.advance("owner", task.id, event), runtime.advance("owner", task.id, event)]);
    expect(results.some(result => result.status === "fulfilled" && result.value.wait?.kind === "quiz_submission")).toBe(true);
    const calls = generate.mock.calls.length; expect(calls).toBe(3); expect(claims()).toHaveLength(1);
    await runtime.advance("owner", task.id, event).catch(() => undefined);
    await runtime.advance("owner", task.id);
    expect(generate).toHaveBeenCalledTimes(calls); expect(claims()).toHaveLength(1);
  } finally { runtime.close(); }
});

it("delivers partial publication immediately without claiming a repair or topping up", async () => {
  const generate = generator(() => "partial"), runtime = engine(generate, decide(() => quiz({}, 2)));
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result).toMatchObject({ status: "waiting", usage: { calls: 2 } }); expect(generate).toHaveBeenCalledTimes(1); expect(claims()).toHaveLength(0);
    expect(new LearningQuizRepository(learning).list(pageId)).toMatchObject([{ status: "completed", count: 1, delivery: { requested: 2, published: 1 } }]);
  } finally { runtime.close(); }
});

it.each([false, true])("never automatically reissues a true unknown (unknown after repair=%s)", async afterRepair => {
  const generate = generator((_wire, invocation) => afterRepair && invocation === 1 ? "equivalent" : new AgentFailure("unknown", "synthetic_unknown"));
  const runtime = engine(generate, decide(() => quiz()));
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result).toMatchObject({ status: "needs_attention", recovery: { kind: "unknown" } });
    expect(generate).toHaveBeenCalledTimes(afterRepair ? 2 : 1); expect(claims()).toHaveLength(afterRepair ? 1 : 0);
    await runtime.advance("owner", task.id); expect(generate).toHaveBeenCalledTimes(afterRepair ? 2 : 1);
  } finally { runtime.close(); }
});

it.each([1, 3])("preserves the task budget at %s calls; no unknown or extra Provider call is invented", async maxCalls => {
  seed({ maxCalls }); const generate = generator(() => "equivalent"), runtime = engine(generate, decide(() => quiz()));
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result).toMatchObject({ status: "budget_exhausted", usage: { calls: maxCalls, unknownUsageCalls: 0 } });
    expect(result.recovery?.kind).not.toBe("unknown"); expect(generate).toHaveBeenCalledTimes(maxCalls === 1 ? 0 : 1);
    expect(new LearningQuizRepository(learning).list(pageId).some(run => run.progress?.uncertain)).toBe(false);
    await runtime.advance("owner", task.id); expect(generate).toHaveBeenCalledTimes(maxCalls === 1 ? 0 : 1);
  } finally { runtime.close(); }
});

it("an explicit retry of the original failed operation uses the same single repair and cannot resend a second failed repair", async () => {
  const generate = generator(() => "format");
  let scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const ctx = context(), action = quiz(); if (!("args" in action)) throw Error("fixture_action");
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ code: "known_failure" });
  const original = new LearningQuizRepository(learning).list(pageId)[0]; expect(original).toMatchObject({ status: "failed", progress: { canResume: true } });
  ctx.task.recovery = { kind: "known_failed", actionId: ctx.actionId, message: "[合成] 明确重试原操作", allowedControls: ["retry"] };
  const result = await scene.tools["learning.create_quiz"].execute(action.args, ctx);
  expect(result.handoff).toContain("修正过一次"); expect(generate).toHaveBeenCalledTimes(2); expect(claims()).toHaveLength(1);
  learning.close(); learning = new LearningRepository(directory, "owner");
  scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  expect(claims()).toHaveLength(1);
  const again = await scene.tools["learning.create_quiz"].execute(action.args, ctx);
  expect(again.handoff).toContain("一次修复机会"); expect(generate).toHaveBeenCalledTimes(2);
  ctx.actionId = randomUUID(); const relabelled = quiz({ method: "contrast", purpose: "改文字不能重置机会" }, 4);
  if (!("args" in relabelled)) throw Error("fixture_action");
  expect((await scene.tools["learning.create_quiz"].execute(relabelled.args, ctx)).handoff).toContain("一次修复机会");
  expect(generate).toHaveBeenCalledTimes(2); expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(1);
});

it("recovers an already published repair after its local receipt is lost without issuing another generation", async () => {
  const generate = generator((_wire, invocation) => invocation === 1 ? "equivalent" : "valid");
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const ctx = context(), action = quiz(); if (!("args" in action)) throw Error("fixture_action");
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ code: "known_failure" });
  ctx.actionId = randomUUID();
  const original = LearningAgentRepository.prototype.complete;
  const complete = vi.spyOn(LearningAgentRepository.prototype, "complete").mockImplementation(function(this: LearningAgentRepository, ...args) {
    const row = this.get(args[0], args[1], args[2]);
    if (row?.kind === "quiz") throw new AgentFailure("known_failure", "synthetic_receipt_lost");
    return original.apply(this, args);
  });
  try {
    await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ code: "known_failure", publicSummary: expect.stringContaining("已经通过发布并保存") });
  } finally { complete.mockRestore(); }
  const run = new LearningQuizRepository(learning).list(pageId).find(run => run.status === "completed")!;
  expect(run.count).toBe(1); expect(generate).toHaveBeenCalledTimes(2);
  const receipt = await scene.tools["learning.create_quiz"].recover!(ctx.actionId, ctx);
  expect(receipt).toMatchObject({ ref: { kind: "learning.quiz", id: run.id }, wait: { kind: "quiz_submission" } });
  const repeated = await scene.tools["learning.create_quiz"].recover!(ctx.actionId, ctx);
  expect(repeated).toEqual(receipt); expect(generate).toHaveBeenCalledTimes(2); expect(claims()).toHaveLength(1);
  expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(2);
});

it("does not turn a source failure, foreign account, cancellation or unprepared new version into a repair request", async () => {
  const generate = generator(() => "equivalent"), scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const ctx = context(), action = quiz(); if (!("args" in action)) throw Error("fixture_action");
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ code: "known_failure" });
  const originalTask = ctx.task;
  ctx.actionId = randomUUID(); ctx.task = { ...originalTask, accountId: "other" };
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ code: "forbidden" });
  ctx.task = { ...originalTask, version: 2 };
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ message: "agent_review_plan_required" });
  ctx.task = originalTask; ctx.assertActive = async () => { throw new AgentFailure("inactive", "synthetic_cancelled"); };
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ code: "inactive" });
  ctx.assertActive = async () => {};
  learning.deleteMaterial(pageId, materialId);
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ code: "source_changed" });
  expect(generate).toHaveBeenCalledTimes(1); expect(claims()).toHaveLength(0);
});
