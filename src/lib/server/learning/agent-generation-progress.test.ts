// @vitest-environment node
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
import { LearningAgentRepository, learningAgentOperationId } from "./agent-repository";
import { freezeLearningAgentScope } from "./agent-scope";
import { establishLearningReviewPlan, assessLearningCompletion } from "./agent-completion";
import { createLearningAgentScenario } from "./agent-scenario";
import { withLearningCompletionDecision } from "./agent-context";
import type { generateStudyJson } from "./framework-generator";

let directory: string, learning: LearningRepository, store: AgentStore, pageId: string, materialId: string, task: AgentTask;
const config = { baseURL: "https://offline.invalid/v1", apiKey: "SYNTHETIC", model: "offline", maxInputChars: 24000, maxOutputTokens: 8000 };
const purpose = (patch: Partial<LearningCheckPurpose> = {}): LearningCheckPurpose => ({
  objectiveIds: ["condition"], role: "boundary", method: "retrieval", purpose: "[离线] 检查必要前提未满足时是否可以应用规则", priorEvidenceRefs: [], ...patch,
});
const quiz = (p = purpose(), count = 1): AgentDecision => ({ tool: "learning.create_quiz", args: { count, difficulty: "standard", purpose: p } });
const failureRecords = () => new LearningAgentRepository(learning).list(pageId, task.id)
  .filter(row => row.kind === "check_purpose" && row.state === "completed").map(row => JSON.parse(row.body_json!));
function decision(choose: (input: AgentDecisionInput) => AgentDecision): AgentDecisionProvider {
  return vi.fn(async (input, ctx) => ctx.call({ kind: "offline_decision", inputChars: 100, maxOutputTokens: 100 }, async () => ({
    value: choose(input), usage: { inputTokens: 10, outputTokens: 4 },
  })));
}
function runtime(generate: typeof generateStudyJson, choose: AgentDecisionProvider) {
  return new AgentRuntime({ store, checkpointPath: join(directory, "checkpoints.sqlite"),
    scenario: createLearningAgentScenario(learning, { configure: () => config, generate }),
    decision: withLearningCompletionDecision(learning, choose) });
}
const insufficient = vi.fn(async (_config, _name, _prompt, input, _schema, _signal, diagnostics) => {
  diagnostics?.({ responseStatus: "completed", responseTextLength: 100, parseResult: "success", validationResult: "success", inputTokens: 31, outputTokens: 17 });
  const wire = input as { taskContext: { referenceScope: string } };
  return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope, title: "[离线] 无可发布候选",
    materialPlan: [], items: [], reason: "[合成] 没有满足唯一答案与来源条件的候选；不提供伪造试题。" };
}) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-generation-progress-")); learning = new LearningRepository(directory, "owner");
  store = AgentStore.open(join(directory, "agents.sqlite"));
  pageId = randomUUID(); materialId = randomUUID();
  learning.create({ id: pageId, title: "[合成] 已知生成失败" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 必要条件", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 只有必要前提满足时才可应用规则。必要前提未满足时不能直接应用规则。") }]);
  task = store.createTask({ accountId: "owner", resourceId: pageId, scenario: "learning.adaptive-review.v1", goal: "[合成] 检查规则的适用条件",
    scope: { ...freezeLearningAgentScope(learning, pageId, { materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false }), completionVersion: 1 } });
  const ctx: AgentContext = { task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {},
    call: async (_request, invoke) => (await invoke()).value };
  // A formal saved plan, deliberately established without a model call in this
  // controlled runtime fixture. All later generation and failure state is real.
  establishLearningReviewPlan(learning, ctx, { kind: "chapter_check", objectives: [{
    id: "condition", label: "判断必要条件未满足的情况", sources: [{ materialId, paragraph: 1 }],
    requirements: [{ role: "boundary", description: "判断必要前提未满足时不能应用规则", independent: true }],
  }] });
  insufficient.mockClear(); vi.stubGlobal("fetch", vi.fn(() => { throw Error("network_forbidden"); }));
});
afterEach(async () => {
  store.close(); learning.close(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true });
});

it("returns a real known publication failure to the next decision and stops a count-only repeated generation before another call", async () => {
  const choose = decision(input => {
    if (input.results.length) expect(input.results.at(-1)).toMatchObject({ status: "failed", value: {
      summary: expect.stringContaining("agent_quiz_insufficient"),
    } });
    return quiz(purpose(), input.results.length ? 5 : 1);
  });
  const engine = runtime(insufficient, choose);
  try {
    const result = await engine.advance("owner", task.id);
    expect(choose).toHaveBeenCalledTimes(2); expect(insufficient).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ended", usage: { calls: 3, unknownUsageCalls: 0 } });
    expect(result.actions).toMatchObject([{ status: "failed" }, { status: "succeeded" }]);
    expect(result.endReason).toContain("未能提供满足发布条件的题目");
    expect(result.endReason).toContain("这不是你的作答错误");
    expect(new LearningQuizRepository(learning).list(pageId)).toMatchObject([{ status: "insufficient", count: 0 }]);
    expect(failureRecords()).toMatchObject([{ kind: "quiz", resultId: learningAgentOperationId(result.actions[0].id, "quiz"), failure: { code: "agent_quiz_insufficient" } }]);
    expect(assessLearningCompletion(learning, result)).toMatchObject({ outcome: "insufficient", objectives: [{ unresolvedErrors: [] }] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { engine.close(); }
});

it("allows the model to choose a real explanation after failed generation instead of imposing the same stop on all tools", async () => {
  const generate = vi.fn(async (...args: Parameters<typeof generateStudyJson>) => {
    if (args[1] === "learning_quiz") return insufficient(...args);
    expect(args[1]).toBe("learning_agent_explanation");
    return { materialAnswer: "[离线讲解] 必要前提未满足时不能直接应用规则；先核对前提再判断规则是否适用。", supplements: [], items: [{ materialId, paragraph: 1 }] };
  }) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
  const choose = decision(input => {
    if (!input.results.length) return quiz();
    if (input.results.at(-1)?.status === "failed") return { tool: "learning.explain", args: {
      question: "[合成] 改为讲解前提未满足时为什么不能应用", sources: [{ materialId, paragraph: 1 }], purpose: purpose({ method: "contrast" }),
    } };
    return { tool: "learning.request_feedback", args: { question: "需要进一步说明哪个条件？", intent: "clarification" } };
  });
  const engine = runtime(generate, choose);
  try {
    const result = await engine.advance("owner", task.id);
    expect(result).toMatchObject({ status: "waiting", wait: { kind: "feedback" }, usage: { calls: 5 } });
    expect(generate).toHaveBeenCalledTimes(2); expect(choose).toHaveBeenCalledTimes(3);
    expect(result.actions.map(action => action.tool)).toEqual(["learning.create_quiz", "learning.explain", "learning.request_feedback"]);
    expect(assessLearningCompletion(learning, result).outcome).not.toBe("check_passed");
    await engine.advance("owner", task.id);
    expect(generate).toHaveBeenCalledTimes(2); expect(choose).toHaveBeenCalledTimes(3);
  } finally { engine.close(); }
});

it("allows a specifically bound different method once, then stops a repeated failure despite another declared methodChange", async () => {
  const choose = decision(input => {
    if (!input.results.length) return quiz();
    const failedId = learningAgentOperationId(input.results.at(-1)!.actionId, "quiz");
    return quiz(purpose({ method: "contrast", methodChange: { previousResultId: failedId,
      difference: "改为对照必要前提满足和未满足的两个条件", expectedObservation: "判断哪一种情况下不能直接应用规则" } }));
  });
  const engine = runtime(insufficient, choose);
  try {
    const result = await engine.advance("owner", task.id);
    expect(result.status).toBe("ended"); expect(result.usage.calls).toBe(5);
    expect(choose).toHaveBeenCalledTimes(3); expect(insufficient).toHaveBeenCalledTimes(2);
    expect(failureRecords()).toHaveLength(2);
    expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(2);
    expect(result.endReason).toContain("同类重复生成");
  } finally { engine.close(); }
});

it("does not unlock another generation by only renaming the method or referring to an unrelated result", async () => {
  const choose = decision(input => !input.results.length ? quiz() : quiz(purpose({ method: "contrast",
    methodChange: { previousResultId: randomUUID(), difference: "换一套名称", expectedObservation: "得到题组" } })));
  const engine = runtime(insufficient, choose);
  try {
    const result = await engine.advance("owner", task.id);
    expect(result.status).toBe("ended"); expect(insufficient).toHaveBeenCalledTimes(1);
    expect(result.endReason).toContain("仅更换方法名称不足以继续");
  } finally { engine.close(); }
});

it("retains true unknown as unknown and never records it as a known failure or automatically reissues it", async () => {
  const generate = vi.fn(async () => { throw new AgentFailure("unknown", "offline_injected_connection_lost"); }) as unknown as typeof insufficient;
  const choose = decision(() => quiz()), engine = runtime(generate, choose);
  try {
    const result = await engine.advance("owner", task.id);
    expect(result).toMatchObject({ status: "needs_attention", recovery: { kind: "unknown" } });
    expect(failureRecords()).toEqual([]); expect(result.actions[0].status).toBe("unknown");
    await engine.advance("owner", task.id);
    expect(generate).toHaveBeenCalledTimes(1); expect(choose).toHaveBeenCalledTimes(1);
  } finally { engine.close(); }
});

it("allows an explicitly authorized original-operation retry after a known failed generation, preserving its failure record and stable identity", async () => {
  let generated = 0, calls = 0;
  const generate = vi.fn(async (_config, _name, _prompt, input) => {
    if (++generated === 1) throw new AgentFailure("known_failure", "agent_generation_invalid_result");
    const wire = input as { taskContext: { referenceScope: string }; materials: Array<{ paragraphs: Array<{ referenceId: string }> }> };
    const refs = wire.materials[0].paragraphs.map(p => p.referenceId);
    return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope, title: "[离线] 前提检查", reason: null,
      materialPlan: [{ material: 1, contribution: "必要前提", references: refs }], items: [{
        stem: "[合成] 必要前提未满足时能直接应用规则吗？", scenario: null, kind: "concept", correctOptionId: "A",
        stemEvidenceIds: refs, explanationParts: [{ text: "只有前提满足时才可应用规则。", evidenceIds: refs }], hint: null,
        options: [{ id: "A", text: "不能应用", reasonParts: [{ text: "必要前提尚未满足。", evidenceIds: refs }] },
          { id: "B", text: "能够应用", reasonParts: [{ text: "缺少规则的必要前提。", evidenceIds: refs }] }],
        reviewCheck: { objectiveIds: ["condition"], role: "boundary", rationale: "检查必要前提不满足时的适用边界。" },
      }] };
  }) as unknown as typeof insufficient;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const ctx: AgentContext = { task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {},
    call: async (_request, invoke) => { calls++; return (await invoke()).value; } };
  const action = quiz(); if (!("args" in action)) throw Error("fixture_action");
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ code: "known_failure" });
  const original = new LearningQuizRepository(learning).list(pageId)[0];
  expect(original).toMatchObject({ status: "failed", progress: { canResume: true, uncertain: false } });
  expect(failureRecords()).toMatchObject([{ actionId: ctx.actionId, failure: { code: "agent_generation_invalid_result" } }]);
  // The user-controlled recovery contract must still be explicit; automatic
  // model retries of the same identity are not authorized.
  await expect(scene.tools["learning.create_quiz"].execute(action.args, ctx)).rejects.toMatchObject({ message: "agent_explicit_retry_required" });
  expect(generate).toHaveBeenCalledTimes(1);
  ctx.task.recovery = { kind: "known_failed", actionId: ctx.actionId, message: "[离线] 已知失败条件已恢复，用户明确重试", allowedControls: ["retry"] };
  const result = await scene.tools["learning.create_quiz"].execute(action.args, ctx);
  expect(result).toMatchObject({ ref: { kind: "learning.quiz", id: original.id }, wait: { kind: "quiz_submission" } });
  expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(1);
  expect(new LearningQuizRepository(learning).list(pageId)[0]).toMatchObject({ id: original.id, status: "completed", count: 1 });
  expect(calls).toBe(2); expect(generate).toHaveBeenCalledTimes(2);
  expect(failureRecords()).toHaveLength(2);
  expect(failureRecords().filter(record => record.failure)).toHaveLength(1);
});

it("retains the failed purpose across checkpoint restart and rejects the resumed repeated action with no new generation", async () => {
  const choose = decision(input => input.results.length
    ? { tool: "learning.request_feedback", args: { question: "生成未能发布，需要先核对，请补充具体困难。" } }
    : quiz());
  let engine = runtime(insufficient, choose);
  const waiting = await engine.advance("owner", task.id); engine.close();
  expect(waiting.status).toBe("waiting");
  learning.close(); learning = new LearningRepository(directory, "owner");
  const resumedChoose = decision(() => quiz());
  engine = runtime(insufficient, resumedChoose);
  try {
    const result = await engine.advance("owner", task.id, { id: randomUUID(), kind: "feedback", version: waiting.version,
      refId: waiting.wait!.refId, message: "请再生成同一种题" });
    expect(result.status).toBe("ended"); expect(result.endReason).toContain("未能提供满足发布条件的题目");
    expect(insufficient).toHaveBeenCalledTimes(1); expect(resumedChoose).toHaveBeenCalledTimes(1);
    expect(failureRecords()).toHaveLength(1);
  } finally { engine.close(); }
});

it("does not let another objective's actual support or a role relabel unlock a failed method, but accepts new observations for that objective", async () => {
  task = store.createTask({ accountId: "owner", resourceId: pageId, scenario: task.scenario, goal: "[合成] 分别检查两个条件",
    scope: task.scope });
  const ctx: AgentContext = { task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {},
    call: async (_request, invoke) => (await invoke()).value };
  establishLearningReviewPlan(learning, ctx, { kind: "chapter_check", objectives: ["condition", "other"].map(id => ({
    id, label: `[合成] ${id}的必要前提`, sources: [{ materialId, paragraph: 1 }],
    requirements: [{ role: "boundary", description: "判断必要前提不满足时不能应用规则", independent: true }],
  })) });
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate: insufficient });
  const initial = quiz(); if (!("args" in initial)) throw Error("fixture_action");
  await expect(scene.tools["learning.create_quiz"].execute(initial.args, ctx)).rejects.toMatchObject({ code: "known_failure" });
  const before = assessLearningCompletion(learning, task), failureId = learningAgentOperationId(ctx.actionId, "quiz");
  const generate = vi.fn(async (_config, _name, _prompt, input) => {
    const wire = input as { taskContext: { referenceScope: string; reviewContext: { purpose: LearningCheckPurpose } }; materials: Array<{ paragraphs: Array<{ referenceId: string }> }> };
    const refs = wire.materials[0].paragraphs.map(p => p.referenceId);
    return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope, title: "[离线] 必要条件", reason: null,
      materialPlan: [{ material: 1, contribution: "必要前提", references: refs }], items: [{
        stem: `[合成] ${wire.taskContext.reviewContext.purpose.objectiveIds[0]} 的必要前提未满足时能应用规则吗？`, scenario: null, kind: "concept", correctOptionId: "A",
        stemEvidenceIds: refs, explanationParts: [{ text: "必要前提未满足时不能应用规则。", evidenceIds: refs }], hint: null,
        options: [{ id: "A", text: "不能应用", reasonParts: [{ text: "必要前提尚未满足。", evidenceIds: refs }] },
          { id: "B", text: "能够应用", reasonParts: [{ text: "缺少必要前提。", evidenceIds: refs }] }],
        reviewCheck: { objectiveIds: wire.taskContext.reviewContext.purpose.objectiveIds, role: "boundary", rationale: "实际判断必要前提不满足时的适用边界。" },
      }] };
  }) as unknown as typeof insufficient;
  const generatedScene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const submit = async (objectiveId: string, correct: boolean) => {
    ctx.actionId = randomUUID();
    const action = quiz(purpose({ objectiveIds: [objectiveId], method: objectiveId === "other" ? "retrieval" : "contrast",
      ...(objectiveId === "condition" ? { methodChange: { previousResultId: failureId, difference: "对照满足与未满足两种前提", expectedObservation: "判断不适用条件" } } : {}) }));
    if (!("args" in action)) throw Error("fixture_action");
    const result = await generatedScene.tools["learning.create_quiz"].execute(action.args, ctx);
    const quizzes = new LearningQuizRepository(learning);
    let attempt = quizzes.attempt(pageId, result.wait!.refId!);
    attempt = quizzes.act(pageId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: correct ? "A" : "B" });
    quizzes.act(pageId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  };
  await submit("other", true);
  const after = assessLearningCompletion(learning, task);
  expect(after.objectives.find(objective => objective.id === "other")?.status).toBe("supported");
  expect(after.progressFingerprint).not.toBe(before.progressFingerprint);
  for (const role of ["boundary", "concept"] as const) {
    ctx.actionId = randomUUID(); const action = quiz(purpose({ role })); if (!("args" in action)) throw Error("fixture_action");
    const result = await scene.tools["learning.create_quiz"].execute(action.args, ctx);
    expect(result.handoff).toContain("同类重复生成");
  }
  expect(insufficient).toHaveBeenCalledTimes(1);
  await submit("condition", false);
  ctx.actionId = randomUUID();
  await expect(scene.tools["learning.create_quiz"].execute(initial.args, ctx)).rejects.toMatchObject({ code: "known_failure" });
  expect(insufficient).toHaveBeenCalledTimes(2);
  expect(assessLearningCompletion(learning, task).objectives.find(objective => objective.id === "condition")?.unresolvedErrors).toHaveLength(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
