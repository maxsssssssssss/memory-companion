// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAction, AgentTask } from "@/lib/domain/agent";
import { AgentFailure, type AgentContext, type AgentDecisionProvider, type AgentScenario } from "@/lib/server/agent/types";
import { AgentStore } from "@/lib/server/agent/store";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import type { StructuredJsonDiagnostics } from "@/lib/server/openai/structured-json";
import { LearningRepository } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningQuizRepository } from "./quiz-repository";
import { freezeLearningAgentScope, readLearningAgentScope } from "./agent-scope";
import { createLearningAgentScenario, readLearningAgentExplanation } from "./agent-scenario";
import { LearningAgentRepository, learningAgentOperationId } from "./agent-repository";
import type { generateStudyJson } from "./framework-generator";

let root: string, learning: LearningRepository, pageId: string, materialId: string, otherId: string;
const config = { baseURL: "https://tokenhub.vision-intelligence.tech/v1", apiKey: "SYNTHETIC", model: "deepseek-v4-pro", maxInputChars: 24000, maxOutputTokens: 900 };
const selection = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false });
function context(overrides: Partial<AgentTask> = {}): AgentContext {
  const task = { id: randomUUID(), accountId: "owner", scenario: "learning.adaptive-review.v1", resourceId: pageId, goal: "[合成] 区分前提与结论",
    scope: freezeLearningAgentScope(learning, pageId, selection()), status: "running", actions: [],
    budget: { maxCalls: 10, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 100000, maxSteps: 10, maxNoProgress: 3 },
    usage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0, computeMs: 0, steps: 0 }, createdAt: "synthetic", updatedAt: "synthetic", ...overrides } as AgentTask;
  return { task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {},
    call: async (_request, invoke) => { task.usage.calls++; return (await invoke()).value; } };
}
async function run(scene: AgentScenario, name: string, args: unknown, ctx: AgentContext) {
  const result = await scene.tools[name].execute(args, ctx);
  const receipt = { id: ctx.actionId, tool: name, status: "succeeded", summary: result.summary, createdAt: "synthetic", resultRef: result.ref } as AgentAction;
  const value = await scene.tools[name].readResult?.(receipt, ctx);
  return { result, receipt, value };
}
function framework() {
  const repository = new LearningFrameworkRepository(learning), id = randomUUID();
  repository.begin(pageId, { id, materialIds: [materialId] }, 24000); repository.validating(pageId, id);
  repository.complete(pageId, id, { overview: "[合成]", chapters: [{ title: "前提与结论", explanation: "NOT_EVIDENCE", nodes: [
    { title: "前提", explanation: "NOT_EVIDENCE", supplement: "PRIVATE_SUPPLEMENT", sources: [{ materialId, paragraph: 1 }] },
    { title: "结论", explanation: "NOT_EVIDENCE", supplement: null, sources: [{ materialId, paragraph: 2 }] }
  ] }] });
  const chapter = repository.view(pageId).chapters[0];
  repository.edit(pageId, { kind: "node", chapterId: chapter.id, nodeId: chapter.nodes[0].id, revision: chapter.revision,
    title: chapter.nodes[0].title, explanation: "NOT_EVIDENCE", note: "PRIVATE_NOTE" });
  return repository.view(pageId).chapters[0];
}
function quizGenerator() {
  let sequence = 0;
  return vi.fn(async (_config, _name, _prompt, input) => {
    const wire = input as { taskContext: { referenceScope: string }; materials: Array<{ paragraphs: Array<{ referenceId: string }> }> };
    const refs = wire.materials[0].paragraphs.map(p => p.referenceId); sequence++;
    return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope, title: "[模拟生成] 条件判断", reason: null,
      materialPlan: [{ material: 1, contribution: "规则与前提", references: refs }], items: [{ focus: `考点${sequence}`, stem: `[模拟生成] 第${sequence}题：未满足前提可以应用规则吗？`,
        scenario: null, kind: "concept", stemEvidenceIds: refs, correctOptionId: "A", hint: null,
        explanationParts: [{ text: "SECRET_EXPLANATION", evidenceIds: refs }], options: [
          { id: "A", text: "不能应用", reasonParts: [{ text: "SECRET_REASON", evidenceIds: refs }] },
          { id: "B", text: "可以应用", reasonParts: [{ text: "前提未满足", evidenceIds: refs }] }
        ] }] };
  }) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-agent-synthetic-")); learning = new LearningRepository(root, "owner");
  pageId = randomUUID(); materialId = randomUUID(); otherId = randomUUID(); learning.create({ id: pageId, title: "[合成] Agent" });
  learning.saveMaterials(pageId, [
    { id: materialId, title: "[合成] 条件", kind: "text", filename: null, bytes: Buffer.from("[合成] 只有前提成立才可以应用规则。\n\n[合成] 前提未成立与应用后判为未通过不同。") },
    { id: otherId, title: "[合成] 未授权", kind: "text", filename: null, bytes: Buffer.from("OUTSIDE_SCOPE") }
  ]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(async () => { if (learning.database.open) learning.close(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it("freezes node-only source positions and excludes notes, supplements, other material and old summaries", async () => {
  const chapter = framework(), ctx = context({ scope: freezeLearningAgentScope(learning, pageId, { ...selection(), materialIds: [], nodeIds: [chapter.nodes[0].id] }) });
  const scene = createLearningAgentScenario(learning);
  const navigation = await run(scene, "learning.read_navigation", {}, ctx);
  expect(JSON.stringify(navigation.value)).not.toMatch(/PRIVATE|NOT_EVIDENCE|OUTSIDE_SCOPE/);
  expect((navigation.value as { chapters: Array<{ nodes: unknown[] }> }).chapters[0].nodes).toHaveLength(1);
  await expect(run(scene, "learning.read_source", { materialId, paragraph: 2 }, ctx)).rejects.toThrow("agent_source_forbidden");
  await expect(run(scene, "learning.read_source", { materialId: otherId, paragraph: 1 }, ctx)).rejects.toThrow("agent_source_forbidden");
  const source = await run(scene, "learning.read_source", { materialId, paragraph: 1 }, ctx);
  expect(JSON.stringify(source.result)).not.toContain("前提成立");
  expect(JSON.stringify(source.value)).toContain("前提成立");
});

it("checks accounts and source deletion on every read and invalidates saved explanation text", async () => {
  const generate = vi.fn(async () => ({ materialAnswer: "[模拟解释] 未满足前提不能应用。", supplements: [], items: [{ materialId, paragraph: 1 }] })) as unknown as typeof generateStudyJson;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate }), ctx = context();
  const saved = await run(scene, "learning.explain", { question: "为何不能应用？", sources: [{ materialId, paragraph: 1 }] }, ctx);
  expect(readLearningAgentExplanation(learning, ctx.task, saved.result.ref!.id).materialAnswer).toContain("未满足");
  await expect(scene.validate({ ...ctx, task: { ...ctx.task, accountId: "intruder" } })).rejects.toThrow("agent_account_forbidden");
  learning.deleteMaterial(pageId, materialId);
  expect(new LearningAgentRepository(learning).get(pageId, ctx.task.id, saved.result.ref!.id)).toMatchObject({ state: "invalidated", body_json: null });
  await expect(scene.tools["learning.explain"].readResult!(saved.receipt, ctx)).rejects.toThrow("material_deleted");
  expect(() => readLearningAgentScope(learning, pageId, ctx.task.scope)).toThrow("material_deleted");
});

it("uses real Quiz business services, counts each generation part, hides answers and reads only actual submitted grades", async () => {
  const generate = quizGenerator(), scene = createLearningAgentScenario(learning, { configure: () => config, generate }), ctx = context();
  const created = await run(scene, "learning.create_quiz", { count: 2, difficulty: "basic" }, ctx);
  expect(generate).toHaveBeenCalledTimes(2); expect(ctx.task.usage.calls).toBe(2);
  expect(JSON.stringify(created.value)).not.toMatch(/SECRET_|correctOptionId|score/);
  expect(created.result.wait?.kind).toBe("quiz_submission");
  const attemptId = created.result.wait!.refId!;
  await expect(run(scene, "learning.read_answers", { attemptId }, ctx)).rejects.toThrow("agent_answers_not_submitted");
  const duplicate = await run(scene, "learning.create_quiz", { count: 2, difficulty: "basic" }, ctx);
  expect(duplicate.result.ref).toEqual(created.result.ref); expect(generate).toHaveBeenCalledTimes(2);
  const quiz = new LearningQuizRepository(learning); let attempt = quiz.attempt(pageId, attemptId);
  attempt = quiz.act(pageId, { id: randomUUID(), attemptId, revision: attempt.revision, action: "choose", question: 0, optionId: "A" });
  attempt = quiz.act(pageId, { id: randomUUID(), attemptId, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  const result = await run(scene, "learning.read_answers", { attemptId }, { ...ctx, actionId: randomUUID() });
  expect(result.value).toMatchObject({ score: { correct: 1, total: 2, skipped: 1 } });
  await scene.validateEvent!({ id: randomUUID(), kind: "quiz_submission", refId: attemptId }, { ...ctx, task: { ...ctx.task, wait: created.result.wait } });
  const otherTask = context();
  await expect(run(scene, "learning.read_answers", { attemptId }, otherTask)).rejects.toThrow("agent_history_forbidden");
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("persists operation receipts across connection loss and never retries unknown generations", async () => {
  const generate = vi.fn(async () => { throw new Error("SYNTHETIC transport lost"); }) as unknown as typeof generateStudyJson;
  const ctx = context(), scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  await expect(run(scene, "learning.explain", { question: "解释前提", sources: [{ materialId, paragraph: 1 }] }, ctx)).rejects.toMatchObject({ code: "unknown" });
  learning.close(); learning = new LearningRepository(root, "owner");
  const reopened = createLearningAgentScenario(learning, { configure: () => config, generate });
  await expect(run(reopened, "learning.explain", { question: "解释前提", sources: [{ materialId, paragraph: 1 }] }, ctx)).rejects.toMatchObject({ code: "unknown" });
  expect(generate).toHaveBeenCalledTimes(1);
});

it("rejects unauthorized explanation supplements and model's false completion claim", async () => {
  const generate = vi.fn(async () => ({ materialAnswer: "原文解释", supplements: [{ kind: "example", text: "NOT_AUTHORIZED" }], items: [{ materialId, paragraph: 1 }] })) as unknown as typeof generateStudyJson;
  const ctx = context(), scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  await expect(run(scene, "learning.explain", { question: "解释", sources: [{ materialId, paragraph: 1 }] }, ctx)).rejects.toMatchObject({ code: "known_failure" });
  expect(await scene.finish!("用户已经完全掌握，检查通过", ctx)).toContain("未完成学习检查");
  expect(await scene.finish!("用户已经完全掌握，检查通过", ctx)).not.toContain("检查通过");
});

it("does not publish late generation after cancellation", async () => {
  let active = true;
  const generate = vi.fn(async () => { active = false; return { materialAnswer: "迟到结果", supplements: [], items: [{ materialId, paragraph: 1 }] }; }) as unknown as typeof generateStudyJson;
  const ctx = context(); ctx.assertActive = async () => { if (!active) throw new AgentFailure("inactive", "agent_inactive"); };
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  await expect(run(scene, "learning.explain", { question: "解释", sources: [{ materialId, paragraph: 1 }] }, ctx)).rejects.toMatchObject({ code: "inactive" });
  expect(new LearningAgentRepository(learning).list(pageId, ctx.task.id)[0]).toMatchObject({ state: "failed", body_json: null });
});

it.each(["cancel", "source_deleted"] as const)("retains completed response usage when %s fences Learning publication", async (change) => {
  const store = AgentStore.open(join(root, "agent-usage.sqlite"));
  let runtime: AgentRuntime | undefined, taskId = "";
  // Explicitly mocked generation/decision; the runtime, billing persistence and
  // Learning publication fences are the real implementations under test.
  const generate = vi.fn(async (_config: unknown, _name: unknown, _prompt: unknown, _input: unknown, _schema: unknown, _signal: AbortSignal,
    diagnostics?: (value: StructuredJsonDiagnostics) => void) => {
    diagnostics?.({ responseStatus: "completed", responseTextLength: 100, parseResult: "success", validationResult: "success", inputTokens: 31, outputTokens: 17 });
    if (change === "cancel") runtime!.control("owner", taskId, "cancel");
    else learning.deleteMaterial(pageId, materialId);
    return { materialAnswer: "[模拟] 完整迟到解释", supplements: [], items: [{ materialId, paragraph: 1 }] };
  }) as unknown as typeof generateStudyJson;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const task = store.createTask({ accountId: "owner", scenario: scene.id, resourceId: pageId, goal: "[合成] 用量与发布边界", scope: freezeLearningAgentScope(learning, pageId, selection()) });
  taskId = task.id;
  runtime = new AgentRuntime({ store, checkpointPath: join(root, "usage-checkpoints.sqlite"), scenario: scene,
    decision: vi.fn(async () => ({ tool: "learning.explain", args: { question: "[模拟] 解释前提", sources: [{ materialId, paragraph: 1 }] } })) });
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result.status).toBe(change === "cancel" ? "cancelled" : "needs_attention");
    expect(result.usage).toMatchObject({ calls: 1, inputTokens: 31, outputTokens: 17, unknownUsageCalls: 0 });
    expect(store.database.prepare("SELECT status,input_tokens,output_tokens FROM agent_calls WHERE task_id=?").all(task.id))
      .toEqual([{ status: "succeeded", input_tokens: 31, output_tokens: 17 }]);
    expect(new LearningAgentRepository(learning).list(pageId, task.id)[0]).toMatchObject({ state: change === "cancel" ? "failed" : "invalidated", body_json: null });
    expect(result.actions.every(action => action.status !== "succeeded")).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  } finally { runtime.close(); store.close(); }
});

it("recovers a published Quiz whose Agent receipt was lost without another generation", async () => {
  const generate = quizGenerator(), ctx = context(), scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const created = await run(scene, "learning.create_quiz", { count: 1, difficulty: "basic" }, ctx);
  learning.database.prepare("UPDATE learning_agent_artifacts SET state='reserved',body_json=NULL WHERE id=?").run(created.result.ref!.id);
  learning.close(); learning = new LearningRepository(root, "owner");
  const reopened = createLearningAgentScenario(learning, { configure: () => config, generate });
  const recovered = await reopened.tools["learning.create_quiz"].recover!(ctx.actionId, ctx);
  expect(recovered?.ref).toEqual(created.result.ref); expect(recovered?.wait).toEqual(created.result.wait);
  expect(generate).toHaveBeenCalledTimes(1); expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(1);
});

it("revalidates opted-in note hashes without treating unselected notes as authorization", async () => {
  const chapter = framework(), frameworkRepo = new LearningFrameworkRepository(learning);
  const opted = context({ scope: freezeLearningAgentScope(learning, pageId, { ...selection(), includeNotes: true }) });
  const excluded = context();
  const current = frameworkRepo.view(pageId).chapters[0];
  frameworkRepo.edit(pageId, { kind: "node", chapterId: current.id, nodeId: current.nodes[0].id, revision: current.revision,
    title: current.nodes[0].title, explanation: current.nodes[0].explanation, note: "CHANGED_PRIVATE_NOTE" });
  const scene = createLearningAgentScenario(learning);
  await expect(scene.validate(opted)).rejects.toMatchObject({ code: "source_changed" });
  await expect(scene.validate(excluded)).resolves.toBeUndefined();
  const nav = await run(scene, "learning.read_navigation", {}, excluded);
  expect(JSON.stringify(nav.value)).not.toContain("CHANGED_PRIVATE_NOTE");
  const nodeOnly = context({ scope: freezeLearningAgentScope(learning, pageId, { ...selection(), materialIds: [], nodeIds: [chapter.nodes[0].id] }) });
  await expect(run(scene, "learning.create_quiz", { count: 1, difficulty: "basic", nodeId: chapter.nodes[1].id }, nodeOnly)).rejects.toMatchObject({ code: "forbidden" });
});

it("rejects stale, unsubmitted and cross-task feedback events without generating", async () => {
  const generate = quizGenerator(), ctx = context(), scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const created = await run(scene, "learning.create_quiz", { count: 1, difficulty: "basic" }, ctx);
  ctx.task.wait = created.result.wait;
  await expect(scene.validateEvent!({ id: randomUUID(), kind: "quiz_submission", refId: created.result.wait!.refId }, ctx)).rejects.toThrow("agent_answers_not_submitted");
  await expect(scene.validateEvent!({ id: randomUUID(), kind: "quiz_submission", refId: randomUUID() }, ctx)).rejects.toMatchObject({ code: "forbidden" });
  await expect(scene.validateEvent!({ id: randomUUID(), kind: "feedback", message: "已经提交" }, ctx)).rejects.toMatchObject({ code: "forbidden" });
  expect(generate).toHaveBeenCalledTimes(1);
});

it("classifies current Learning source deletion as source invalidation in the shared runtime", async () => {
  const scene = createLearningAgentScenario(learning), store = AgentStore.open(join(root, "agent.sqlite"));
  const task = store.createTask({ accountId: "owner", scenario: scene.id, resourceId: pageId, goal: "[合成] 来源失效", scope: freezeLearningAgentScope(learning, pageId, selection()) });
  const decision = vi.fn(async () => { learning.deleteMaterial(pageId, materialId); return { tool: "learning.read_scope", args: {} }; });
  const runtime = new AgentRuntime({ store, checkpointPath: join(root, "checkpoints.sqlite"), scenario: scene, decision });
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result.status).toBe("needs_attention"); expect(result.endReason).toContain("授权来源已变化");
    expect(result.endReason).not.toContain("未确认"); expect(result.actions).toEqual([]);
  } finally { runtime.close(); store.close(); }
});

it("distinguishes a nonexistent business attempt from an unknown Provider outcome", async () => {
  const scene = createLearningAgentScenario(learning), ctx = context();
  await expect(run(scene, "learning.read_answers", { attemptId: randomUUID() }, ctx)).rejects.toMatchObject({ code: "known_failure", message: "quiz_not_found" });
});

it("accepts an authenticated quiz dispute before submission, persists exclusion and preserves original scores", async () => {
  const generate = quizGenerator(), ctx = context(), scene = createLearningAgentScenario(learning, { configure: () => config, generate });
  const created = await run(scene, "learning.create_quiz", { count: 1, difficulty: "basic" }, ctx);
  ctx.task.wait = created.result.wait;
  const attemptId = created.result.wait!.refId!, event = { id: randomUUID(), kind: "quiz_dispute", refId: attemptId, message: "[模拟学生] 题干条件是否缺失？" };
  await scene.validateEvent!(event, ctx);
  expect(JSON.parse(new LearningAgentRepository(learning).list(pageId, ctx.task.id)[0].body_json!).disputed).toBeUndefined();
  ctx.event = event; await scene.observe(ctx); await scene.observe(ctx);
  const disputed = await scene.tools["learning.create_quiz"].readResult!(created.receipt, ctx);
  expect(disputed).toMatchObject({ submitted: false, disputed: true, result: { disputed: true } });
  expect(JSON.stringify(disputed)).not.toMatch(/SECRET_|correctOptionId|score/);
  await expect(scene.validateEvent!({ ...event, id: randomUUID(), kind: "quiz_submission" }, ctx)).rejects.toThrow("agent_answers_not_submitted");
  const quiz = new LearningQuizRepository(learning); let attempt = quiz.attempt(pageId, attemptId);
  attempt = quiz.act(pageId, { id: randomUUID(), attemptId, revision: attempt.revision, action: "choose", question: 0, optionId: "A" });
  attempt = quiz.act(pageId, { id: randomUUID(), attemptId, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  expect(attempt.score?.correct).toBe(1);
  learning.close(); learning = new LearningRepository(root, "owner");
  const reopened = createLearningAgentScenario(learning, { configure: () => config, generate });
  const result = await run(reopened, "learning.read_answers", { attemptId }, ctx);
  expect(result.value).toMatchObject({ disputed: true, submitted: true });
  expect(JSON.stringify(result.value)).not.toMatch(/SECRET_|correctOptionId|score/);
  expect(new LearningQuizRepository(learning).attempt(pageId, attemptId).score?.correct).toBe(1);
  expect(await reopened.finish!("已掌握", ctx)).toContain("未完成学习检查");
  expect(generate).toHaveBeenCalledTimes(1);
});

it.each(["quiz", "explanation"] as const)("explicitly retries a known failed %s through the same real business operation", async (kind) => {
  let calls = 0;
  const quiz = quizGenerator();
  const generate = vi.fn(async (...args: Parameters<typeof generateStudyJson>) => {
    calls++;
    args[6]?.({ responseStatus: "completed", responseTextLength: 100, parseResult: calls === 1 ? "failed" : "success", validationResult: calls === 1 ? "failed" : "success", inputTokens: 31, outputTokens: 17 });
    if (calls === 1) throw Error("[模拟] 收到完整但无效的生成结果");
    return kind === "quiz" ? quiz(...args) : { materialAnswer: "[模拟] 重试后解释", supplements: [], items: [{ materialId, paragraph: 1 }] };
  }) as unknown as typeof generateStudyJson;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate }), store = AgentStore.open(join(root, "retry-agent.sqlite"));
  const task = store.createTask({ accountId: "owner", scenario: scene.id, resourceId: pageId, goal: "[合成] 明确失败重试", scope: freezeLearningAgentScope(learning, pageId, selection()) });
  const chosen = kind === "quiz" ? { tool: "learning.create_quiz", args: { count: 1, difficulty: "basic" } }
    : { tool: "learning.explain", args: { question: "解释前提", sources: [{ materialId, paragraph: 1 }] } };
  let decisions = 0;
  const decision = vi.fn(async () => {
    decisions++;
    if (decisions === 1) return chosen;
    return { wait: { kind: "feedback", message: "[模拟决策] 本次生成明确失败，请检查后决定是否重试。" } };
  });
  const runtime = new AgentRuntime({ store, checkpointPath: join(root, "retry-checkpoints.sqlite"), scenario: scene, decision });
  try {
    const failed = await runtime.advance("owner", task.id), originalAction = failed.actions[0];
    expect(originalAction.status).toBe("failed"); expect(failed.status).toBe("waiting");
    const originalArtifact = new LearningAgentRepository(learning).list(pageId, task.id)[0];
    expect(originalArtifact.state).toBe("failed");
    if (kind === "quiz") expect(new LearningQuizRepository(learning).list(pageId)[0]).toMatchObject({ id: originalArtifact.id, status: "failed", progress: { canResume: true, uncertain: false } });
    await expect(run(scene, chosen.tool, chosen.args, { ...context(failed), actionId: originalAction.id })).rejects.toThrow("agent_explicit_retry_required");
    expect(calls).toBe(1);
    runtime.control("owner", task.id, "pause");
    const inspected = await runtime.recover("owner", task.id, { expectedVersion: 1, mode: "inspect", eventId: randomUUID() });
    expect(inspected.recovery?.kind).toBe("known_failed"); expect(calls).toBe(1);
    const retried = await runtime.recover("owner", task.id, { expectedVersion: 1, mode: "retry", eventId: randomUUID() });
    expect(retried.status).toBe("waiting");
    expect(retried.actions[0]).toMatchObject({ id: originalAction.id, status: "succeeded" });
    expect(retried.actions).toHaveLength(1); expect(calls).toBe(2); expect(retried.usage.calls).toBe(2);
    expect(retried.usage).toMatchObject({ inputTokens: 62, outputTokens: 34, unknownUsageCalls: 0 });
    expect(decision).toHaveBeenCalledTimes(kind === "quiz" ? 2 : 3);
    const records = new LearningAgentRepository(learning).list(pageId, task.id);
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ id: originalArtifact.id, state: "completed" });
    if (kind === "quiz") expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(1);
    else expect(readLearningAgentExplanation(learning, retried, originalArtifact.id).materialAnswer).toBe("[模拟] 重试后解释");
  } finally { runtime.close(); store.close(); }
});

it.each([4, 3])("treats a new model Quiz choice after insufficient as a new charged operation within the same %i-call budget", async (maxCalls) => {
  const candidate = quizGenerator();
  const generate = vi.fn(async (...args: Parameters<typeof generateStudyJson>) => {
    args[6]?.({ responseStatus: "completed", responseTextLength: 100, parseResult: "success", validationResult: "success", inputTokens: 31, outputTokens: 17 });
    const output = await candidate(...args) as { items: unknown[]; [key: string]: unknown };
    // A valid, complete response can contain no publishable questions. This is
    // synthetic generation, not a transport exception or unknown outcome.
    return candidate.mock.calls.length === 1
      ? { ...output, items: [], reason: "[合成] 本次没有满足唯一答案与来源条件的候选。" }
      : { ...output, reason: "[合成] 当前只提供一题，不以重复改写凑足五题。" };
  }) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
  const scene = createLearningAgentScenario(learning, { configure: () => ({ ...config, maxOutputTokens: 8000 }), generate });
  const store = AgentStore.open(join(root, "new-choice-agent.sqlite"));
  const task = store.createTask({ accountId: "owner", scenario: scene.id, resourceId: pageId, goal: "[合成] 明确不足后重新选择行动",
    scope: freezeLearningAgentScope(learning, pageId, selection()), budget: { maxCalls } });
  const decision = vi.fn<AgentDecisionProvider>(async (input, ctx) => {
    // Count the controlled decision response in the same ledger as real tool
    // generation. The choice depends on the actual previous business result.
    return ctx.call({ kind: "decision", inputChars: 100, maxOutputTokens: 100 }, async () => {
      const previous = input.results.at(-1);
      if (previous) {
        expect(previous).toMatchObject({ tool: "learning.create_quiz", status: "failed",
          value: { status: "failed", summary: expect.stringContaining("agent_quiz_insufficient") } });
        expect(input.task.usage.calls).toBe(2);
        expect(input.task.usage).toMatchObject({ inputTokens: 41, outputTokens: 21 });
      }
      return { value: { tool: "learning.create_quiz", args: { count: previous ? 5 : 4, difficulty: "basic" } }, usage: { inputTokens: 10, outputTokens: 4 } };
    });
  });
  const runtime = new AgentRuntime({ store, checkpointPath: join(root, "new-choice-checkpoints.sqlite"), scenario: scene, decision });
  try {
    const result = await runtime.advance("owner", task.id);
    expect(decision).toHaveBeenCalledTimes(2);
    expect(result.actions).toHaveLength(2);
    const [first, second] = result.actions;
    expect(first).toMatchObject({ tool: "learning.create_quiz", status: "failed", summary: expect.stringContaining("agent_quiz_insufficient") });
    expect(second.id).not.toBe(first.id);
    const firstId = learningAgentOperationId(first.id, "quiz"), secondId = learningAgentOperationId(second.id, "quiz");
    expect(secondId).not.toBe(firstId);
    const quizzes = new LearningQuizRepository(learning).list(pageId);
    expect(quizzes).toHaveLength(2);
    expect(quizzes.find(row => row.id === firstId)).toMatchObject({ status: "insufficient", count: 0, settings: { count: 4 } });
    const artifacts = new LearningAgentRepository(learning).list(pageId, task.id);
    expect(artifacts.map(row => row.action_id)).toEqual([first.id, second.id]);
    expect(artifacts[0]).toMatchObject({ id: firstId, state: "failed" });
    const calls = store.database.prepare("SELECT action_id,kind,status FROM agent_calls WHERE task_id=? ORDER BY rowid").all(task.id);
    expect(calls).toEqual([
      { action_id: "decision:1", kind: "decision", status: "succeeded" },
      { action_id: first.id, kind: "learning_quiz", status: "succeeded" },
      { action_id: "decision:2", kind: "decision", status: "succeeded" },
      ...(maxCalls === 4 ? [{ action_id: second.id, kind: "learning_quiz", status: "succeeded" }] : [])
    ]);
    expect(result.usage.calls).toBe(maxCalls);
    expect(result.usage.steps).toBe(2);
    if (maxCalls === 4) {
      expect(generate).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ status: "waiting", wait: { kind: "quiz_submission" }, usage: { inputTokens: 82, outputTokens: 42, unknownUsageCalls: 0 } });
      expect(second.status).toBe("succeeded");
      expect(quizzes.find(row => row.id === secondId)).toMatchObject({ status: "completed", count: 1, settings: { count: 5 } });
      expect(artifacts[1]).toMatchObject({ id: secondId, state: "completed" });
      await runtime.advance("owner", task.id);
      expect(decision).toHaveBeenCalledTimes(2); expect(generate).toHaveBeenCalledTimes(2);
    } else {
      expect(generate).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "budget_exhausted", usage: { inputTokens: 51, outputTokens: 25, unknownUsageCalls: 0 } });
      expect(second.status).toBe("failed");
    }
  } finally { runtime.close(); store.close(); }
});

it("does not reinterpret an insufficient Quiz as a resumable failed operation", async () => {
  const candidate = quizGenerator();
  const generate = vi.fn(async (...args: Parameters<typeof generateStudyJson>) => ({ ...await candidate(...args) as object,
    items: [], reason: "[合成] 没有满足当前发布门槛的候选。" })) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate }), ctx = context();
  const args = { count: 1, difficulty: "basic" };
  await expect(run(scene, "learning.create_quiz", args, ctx)).rejects.toMatchObject({ code: "known_failure", message: "agent_quiz_insufficient" });
  const original = new LearningQuizRepository(learning).list(pageId)[0];
  ctx.task.recovery = { kind: "known_failed", actionId: ctx.actionId, message: "[合成] 用户明确要求重试", allowedControls: ["retry"] };
  await expect(run(scene, "learning.create_quiz", args, ctx)).rejects.toMatchObject({ code: "known_failure", message: "agent_quiz_retry_unavailable" });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(1);
  expect(new LearningQuizRepository(learning).list(pageId)[0]).toMatchObject({ id: original.id, status: "insufficient" });
});

it("never sends another Learning generation for an unknown result even when retry is requested", async () => {
  const generate = vi.fn(async () => { throw Error("[模拟] 不知道网络请求是否已完成"); }) as unknown as typeof generateStudyJson;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate }), store = AgentStore.open(join(root, "unknown-agent.sqlite"));
  const task = store.createTask({ accountId: "owner", scenario: scene.id, resourceId: pageId, goal: "[合成] unknown禁止重发", scope: freezeLearningAgentScope(learning, pageId, selection()) });
  const decision = vi.fn(async () => ({ tool: "learning.create_quiz", args: { count: 1, difficulty: "basic" } }));
  const runtime = new AgentRuntime({ store, checkpointPath: join(root, "unknown-checkpoints.sqlite"), scenario: scene,
    decision });
  try {
    const unknown = await runtime.advance("owner", task.id);
    expect(unknown.status).toBe("needs_attention"); expect(unknown.actions[0].status).toBe("unknown");
    await runtime.recover("owner", task.id, { expectedVersion: 1, mode: "inspect", eventId: randomUUID() });
    const retried = await runtime.recover("owner", task.id, { expectedVersion: 1, mode: "retry", eventId: randomUUID() });
    expect(retried.status).toBe("needs_attention"); expect(retried.recovery?.kind).toBe("unknown");
    expect(generate).toHaveBeenCalledTimes(1); expect(retried.usage.calls).toBe(1);
    await runtime.advance("owner", task.id);
    expect(decision).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
    expect(new LearningQuizRepository(learning).list(pageId)).toHaveLength(1);
  } finally { runtime.close(); store.close(); }
});

it.each(["failed", "incomplete", "completed"])("retains reported usage but does not retry an uncompleted %s generation envelope", async (responseStatus) => {
  const generate = vi.fn(async (...args: Parameters<typeof generateStudyJson>) => {
    args[6]?.({ responseStatus, responseTextLength: 0, parseResult: "not_started", validationResult: "not_started", inputTokens: 31, outputTokens: 17 });
    throw Error("[模拟] 未收到合法完成事件");
  }) as unknown as typeof generateStudyJson;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate }), store = AgentStore.open(join(root, "terminal-agent.sqlite"));
  const task = store.createTask({ accountId: "owner", scenario: scene.id, resourceId: pageId, goal: "[合成] 完成与计费事实分离", scope: freezeLearningAgentScope(learning, pageId, selection()) });
  const runtime = new AgentRuntime({ store, checkpointPath: join(root, "terminal-checkpoints.sqlite"), scenario: scene,
    decision: async () => ({ tool: "learning.explain", args: { question: "[模拟] 解释前提", sources: [{ materialId, paragraph: 1 }] } }) });
  try {
    const result = await runtime.advance("owner", task.id);
    expect(result.status).toBe("needs_attention"); expect(result.actions[0].status).toBe("unknown");
    expect(result.usage).toMatchObject({ calls: 1, inputTokens: 31, outputTokens: 17, unknownUsageCalls: 0 });
    expect(store.database.prepare("SELECT status,input_tokens,output_tokens FROM agent_calls WHERE task_id=?").all(task.id))
      .toEqual([{ status: "unknown", input_tokens: 31, output_tokens: 17 }]);
    expect(new LearningAgentRepository(learning).list(pageId, task.id)[0]).toMatchObject({ state: "unknown", body_json: null });
    const retried = await runtime.recover("owner", task.id, { expectedVersion: 1, mode: "retry", eventId: randomUUID() });
    expect(retried.recovery?.kind).toBe("unknown"); expect(generate).toHaveBeenCalledTimes(1);
  } finally { runtime.close(); store.close(); }
});
