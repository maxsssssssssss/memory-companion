// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningApiError, learningErrorMessage } from "@/lib/client/learning-api";
import { AgentRuntime } from "../agent/runtime";
import { AgentStore } from "../agent/store";
import { AgentFailure, type AgentDecision, type AgentDecisionProvider } from "../agent/types";
import { withLearningCompletionDecision } from "./agent-context";
import { createLearningAgentScenario } from "./agent-scenario";
import { freezeLearningAgentScope } from "./agent-scope";
import type { generateStudyJson } from "./framework-generator";
import { GenerationParts, generationProgress } from "./generation-parts";
import { LearningError, LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { generateLearningQuiz } from "./quiz-service";

let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
const config = { baseURL: "https://tokenhub.vision-intelligence.tech/v1", apiKey: "SYNTHETIC_NEVER_SENT", model: "deepseek-v4-pro", maxInputChars: 48000, maxOutputTokens: 8000 };
const selection = () => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false });
const settings = () => ({ ...selection(), count: 1, difficulty: "basic" as const });
type PartRow = { state: string; attempts: number; failure: string | null; diagnostics_json: string | null };
const savedParts = () => learning.database.prepare("SELECT part_id,state,attempts,failure,diagnostics_json FROM learning_generation_parts ORDER BY part_id").all() as PartRow[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-agent-budget-synthetic-"));
  learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID();
  learning.create({ id: page, title: "[合成] Agent 生成预算边界" });
  learning.saveMaterials(page, [{ id: material, title: "[合成] 集合", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 交集包含同时属于两个集合的元素，并集包含至少属于一个集合的元素。") }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(async () => {
  if (learning.database.open) learning.close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function runtimeFixture(generate: typeof generateStudyJson, maxCalls: number, maxComputeMs = 100000,
  count = 1, generationConfig = config) {
  const store = AgentStore.open(join(root, "agent.sqlite"));
  const scenario = createLearningAgentScenario(learning, { configure: () => generationConfig, generate });
  const choices: AgentDecision[] = [
    { tool: "learning.establish_review_plan", args: { kind: "chapter_check", objectives: [{ id: "membership", label: "交集元素归属",
      sources: [{ materialId: material, paragraph: 1 }],
      requirements: [{ role: "concept", description: "区分同时属于与至少属于一个集合的归属条件", independent: true }] }] } },
    { tool: "learning.create_quiz", args: { count, difficulty: "basic", purpose: {
      objectiveIds: ["membership"], role: "concept", method: "retrieval", purpose: "检查交集元素归属", priorEvidenceRefs: [] } } },
  ];
  let decisions = 0;
  const decision: AgentDecisionProvider = (_input, ctx) => ctx.call({ kind: "decision", inputChars: 1, maxOutputTokens: 1 }, async () => {
    if (!choices[decisions]) throw Error("Unexpected extra decision");
    return { value: choices[decisions++], usage: { inputTokens: 0, outputTokens: 0 } };
  });
  const checkpointPath = join(root, "checkpoint.sqlite");
  const runtime = new AgentRuntime({ store, checkpointPath, scenario, decision: withLearningCompletionDecision(learning, decision) });
  const task = store.createTask({ accountId: learning.accountId, scenario: scenario.id, resourceId: page, goal: "[合成] 检查交集元素归属",
    scope: { ...freezeLearningAgentScope(learning, page, { ...selection(), includeHistory: false }), completionVersion: 1 },
    budget: { maxCalls, maxComputeMs } });
  return { store, runtime, task, checkpointPath, scenario, decision, decisions: () => decisions };
}

it("persists a known pre-request call-limit refusal through Runtime → Scenario → Quiz, and cannot resume it outside the task", async () => {
  const generate = vi.fn(async () => { throw Error("Must not invoke generation"); });
  const f = await runtimeFixture(generate, 2);
  let runtime = f.runtime, store = f.store;
  const calls = () => store.database.prepare("SELECT kind,status FROM agent_calls WHERE task_id=? ORDER BY rowid").all(f.task.id);
  const state = () => JSON.stringify({ calls: calls(), parts: savedParts(), quizzes: quiz.list(page) });
  try {
    const stopped = await runtime.advance(learning.accountId, f.task.id);
    expect(stopped).toMatchObject({ status: "budget_exhausted", usage: { calls: 2, unknownUsageCalls: 0 } });
    expect(stopped.recovery).toBeUndefined();
    expect(stopped.actions.map(a => a.tool)).toEqual(["learning.establish_review_plan", "learning.create_quiz"]);
    expect(generate).not.toHaveBeenCalled(); expect(f.decisions()).toBe(2); expect(fetch).not.toHaveBeenCalled();
    expect(calls()).toEqual([{ kind: "decision", status: "succeeded" }, { kind: "decision", status: "succeeded" }]);
    const run = quiz.list(page)[0];
    expect(run).toMatchObject({ status: "failed", count: 0, failure: "agent_call_limit", progress: { uncertain: false, canResume: false } });
    expect(savedParts()).toEqual([{ part_id: "questions-0", state: "failed", attempts: 1, failure: "agent_call_limit", diagnostics_json: null }]);
    const before = state();
    expect(quiz.begin(page, { id: run.id, settings: settings(), resume: true }, config.maxInputChars)).toBeNull();
    await runtime.advance(learning.accountId, f.task.id);
    await runtime.recover(learning.accountId, f.task.id, { expectedVersion: 1, mode: "retry" });
    expect(state()).toBe(before);
    runtime.close(); store.close();
    store = AgentStore.open(join(root, "agent.sqlite"));
    runtime = new AgentRuntime({ store, checkpointPath: f.checkpointPath, scenario: f.scenario, decision: withLearningCompletionDecision(learning, f.decision) });
    await runtime.advance(learning.accountId, f.task.id);
    await runtime.recover(learning.accountId, f.task.id, { expectedVersion: 1, mode: "retry" });
    expect(state()).toBe(before); expect(generate).not.toHaveBeenCalled(); expect(f.decisions()).toBe(2);
    expect(store.database.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(learning.database.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally { runtime.close(); store.close(); }
});

it("keeps a formally published prefix answerable when a later complete response fails schema inside the Agent generator", async () => {
  let generations = 0;
  const generate = vi.fn(async (_config, _name, _prompt, input, schema, _signal, diagnostics) => {
    const wire = input as { materials: Array<{ paragraphs: Array<{ referenceId: string }> }> };
    const refs = [wire.materials[0].paragraphs[0].referenceId];
    if (++generations === 2) {
      diagnostics?.({ responseStatus: "completed", responseTextLength: 100, parseResult: "success",
        validationResult: "failed", validationIssueCount: 1,
        validationIssues: [{ path: "referenceScope", code: "invalid_string" }], inputTokens: 30, outputTokens: 10 });
      // The actual provider wrapper validates before returning. Exercise that
      // same failure boundary, not only a later standalone codec rejection.
      return schema.parse({ contractVersion: "references-v2", referenceScope: "synthetic-invalid",
        title: "坏格式", reason: null, items: [] });
    }
    diagnostics?.({ responseStatus: "completed", responseTextLength: 300, parseResult: "success",
      validationResult: "success", inputTokens: 30, outputTokens: 20 });
    return schema.parse({ contractVersion: "references-v2", title: "[合成] 部分可用", reason: null,
      materialPlan: [{ material: 1, contribution: "交集定义", references: refs }],
      items: [{ stem: "[合成] 交集中的元素需要满足什么条件？", scenario: null, kind: "concept", stemEvidenceIds: refs,
        options: [{ id: "F", text: "同时属于两个集合", reasonParts: [{ text: "交集需要两个归属条件都成立。", evidenceIds: refs }] },
          { id: "A", text: "只属于其中一个集合", reasonParts: [{ text: "只满足一个归属条件不足以属于交集。", evidenceIds: refs }] }],
        correctOptionId: "F", reviewCheck: undefined }] });
  }) as unknown as typeof generateStudyJson;
  // Three planned parts, each one question, without changing the task budget.
  const f = await runtimeFixture(generate, 16, 100000, 3, { ...config, maxOutputTokens: 1000 });
  try {
    const waiting = await f.runtime.advance("owner", f.task.id);
    expect(waiting).toMatchObject({ status: "waiting", wait: { kind: "quiz_submission" }, usage: { calls: 4 } });
    expect(waiting.actions.at(-1)?.status).toBe("succeeded");
    expect(generations).toBe(2); expect(f.decisions()).toBe(2);
    expect(quiz.list(page)[0]).toMatchObject({ status: "completed", count: 1, delivery: {
      requested: 3, published: 1, candidates: null, rejected: [{ code: "format", count: 1 }]
    } });
    const attempt = quiz.attempt(page, waiting.wait!.refId!);
    expect(attempt.questions).toHaveLength(1); expect(JSON.stringify(attempt)).not.toContain("correctOptionId");
    expect(savedParts()).toMatchObject([{ state: "completed" }, { state: "failed" }, { state: "pending" }]);
    await f.runtime.advance("owner", f.task.id);
    expect(generations).toBe(2); expect(fetch).not.toHaveBeenCalled();
    const calls = f.store.database.prepare("SELECT kind,status FROM agent_calls WHERE task_id=? ORDER BY rowid").all(f.task.id);
    expect(calls).toMatchObject([{ status: "succeeded" }, { status: "succeeded" }, { status: "succeeded" }, { status: "failed" }]);
  } finally { f.runtime.close(); f.store.close(); }
});

it("keeps a completed call billable when compute expires after its response, without marking the child outcome unknown or unsent", async () => {
  const base = Date.now(), clock = vi.spyOn(Date, "now");
  const generate = vi.fn(async () => { clock.mockReturnValue(base + 20000); return {}; }) as unknown as typeof generateStudyJson;
  const f = await runtimeFixture(generate, 4, 10000);
  try {
    const stopped = await f.runtime.advance(learning.accountId, f.task.id);
    expect(stopped).toMatchObject({ status: "budget_exhausted", usage: { calls: 3 } });
    expect(f.store.database.prepare("SELECT kind,status FROM agent_calls WHERE task_id=? ORDER BY rowid").all(f.task.id))
      .toEqual([{ kind: "decision", status: "succeeded" }, { kind: "decision", status: "succeeded" }, { kind: "learning_quiz", status: "succeeded" }]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(quiz.list(page)[0]).toMatchObject({ status: "failed", failure: "agent_compute_limit", progress: { uncertain: false, canResume: false } });
    expect(savedParts()[0]).toMatchObject({ state: "failed", failure: "agent_compute_limit" });
    const message = learningErrorMessage(new LearningApiError(409, "agent_compute_limit"));
    expect(message).toContain("处理时限"); expect(message).not.toMatch(/尚未发送|未知|未确认/); expect(fetch).not.toHaveBeenCalled();
  } finally { f.runtime.close(); f.store.close(); }
});

it.each([
  ["agent_call_limit", "agent_call_limit"],
  ["agent_request_input_limit", "agent_request_input_limit"],
  ["agent_request_output_limit", "agent_request_output_limit"],
  ["agent_compute_limit", "agent_compute_limit"],
  ["PRIVATE_RAW_FAILURE_BODY", "agent_generation_budget_exhausted"],
] as const)("persists only safe budget reason %s and keeps both part and Quiz non-resumable", async (message, failure) => {
  const id = randomUUID(), error = new AgentFailure("budget", message);
  const generate = vi.fn(async () => { throw error; });
  await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  expect(generate).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  expect(savedParts()[0]).toMatchObject({ state: "failed", failure });
  expect(quiz.list(page)[0]).toMatchObject({ status: "failed", failure, progress: { uncertain: false, canResume: false } });
  expect(quiz.begin(page, { id, settings: settings(), resume: true }, config.maxInputChars)).toBeNull();
  expect(JSON.stringify({ parts: savedParts(), quizzes: quiz.list(page) })).not.toContain("PRIVATE_RAW");
  expect(learningErrorMessage(new LearningApiError(409, failure))).not.toMatch(/未知|网络后重试|结果未能确认/);
});

it.each([
  [new AgentFailure("known_failure", "PRIVATE_PROVIDER_BODY"), "generation_part_failed"],
  [new AgentFailure("forbidden", "PRIVATE_SCOPE_DETAIL"), "generation_request_rejected"],
  [new AgentFailure("invalid_action", "PRIVATE_ARGUMENT_VALUE"), "generation_request_rejected"],
  [new LearningError(409, "source_changed"), "source_changed"],
] as const)("retains explicitly known failed outcomes without treating them as unknown: %s", async (error, failure) => {
  const id = randomUUID(), generate = vi.fn(async () => { throw error; });
  await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(savedParts()[0]).toMatchObject({ state: "failed", failure });
  expect(quiz.list(page)[0]).toMatchObject({ status: "failed", failure, progress: { uncertain: false } });
  expect(JSON.stringify({ parts: savedParts(), quizzes: quiz.list(page) })).not.toContain("PRIVATE");
  expect(fetch).not.toHaveBeenCalled();
});

it.each([new AgentFailure("unknown", "PRIVATE_LOST_RESPONSE"), new Error("PRIVATE_UNCLASSIFIED_ERROR")])(
  "preserves real unknown outcomes across restart and refuses any second operation: %s", async error => {
    const id = randomUUID(), generate = vi.fn(async () => { throw error; });
    await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
    expect(savedParts()[0]).toMatchObject({ state: "unknown", failure: "generation_result_unknown" });
    expect(quiz.list(page)[0]).toMatchObject({ status: "failed", progress: { uncertain: true, canResume: false } });
    const before = JSON.stringify(savedParts());
    learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
    await generateLearningQuiz(learning, page, { id, settings: settings(), resume: true }, { configure: () => config, generate });
    expect(generate).toHaveBeenCalledTimes(1); expect(JSON.stringify(savedParts())).toBe(before);
    expect(quiz.list(page)[0].progress).toMatchObject({ uncertain: true, canResume: false });
    expect(JSON.stringify(savedParts())).not.toContain("PRIVATE"); expect(fetch).not.toHaveBeenCalled();
  });

it("keeps the original thrown Agent failure and distinguishes known local failures from unknown in the direct part contract", async () => {
  const id = randomUUID();
  quiz.begin(page, { id, settings: settings() }, config.maxInputChars);
  const parts = new GenerationParts(learning, page, "quiz", id, [material], () => quiz.assertSources(page, id), 120000);
  parts.plan([{ id: "questions-0", input: "[合成] 预算拒绝" }]);
  const failure = new AgentFailure("budget", "agent_call_limit");
  const operation = vi.fn(async () => { throw failure; });
  await expect(parts.execute("questions-0", operation, value => value)).rejects.toBe(failure);
  expect(generationProgress(learning, page, "quiz", id)).toMatchObject({ uncertain: false, canResume: false });
  const before = JSON.stringify(savedParts());
  await expect(parts.execute("questions-0", operation, value => value)).rejects.toThrow("agent_call_limit");
  expect(operation).toHaveBeenCalledTimes(1); expect(JSON.stringify(savedParts())).toBe(before);
});
