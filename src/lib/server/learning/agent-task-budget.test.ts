// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "@/lib/server/agent/store";
import { learningAgentTaskBudget } from "./agent-task-budget";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

describe("Learning server-owned task budgets", () => {
  it("defaults to a longer finite task while retaining per-request and no-progress guards", () => {
    expect(learningAgentTaskBudget({})).toEqual({ maxCalls: 64, maxSteps: 128, maxComputeMs: 1_800_000,
      maxInputChars: 200_000, maxOutputTokens: 8_000, maxNoProgress: 3 });
  });

  it("uses server settings and derives enough steps when only calls are changed", () => {
    expect(learningAgentTaskBudget({ LEARNING_AGENT_TASK_MAX_CALLS: "100" })).toMatchObject({ maxCalls: 100, maxSteps: 200 });
    expect(learningAgentTaskBudget({ LEARNING_AGENT_TASK_MAX_CALLS: "100", LEARNING_AGENT_TASK_MAX_STEPS: "250",
      LEARNING_AGENT_TASK_MAX_COMPUTE_MS: "3600000" })).toMatchObject({ maxCalls: 100, maxSteps: 250, maxComputeMs: 3_600_000 });
  });

  it.each(["", " ", "0", "-1", "1.5", "Infinity", "NaN", "1e3", "32x", "9007199254740992"])("rejects invalid call configuration %j", value => {
    expect(() => learningAgentTaskBudget({ LEARNING_AGENT_TASK_MAX_CALLS: value })).toThrowError(expect.objectContaining({ status: 503, code: "agent_not_configured" }));
  });

  it.each([
    { LEARNING_AGENT_TASK_MAX_STEPS: "0" },
    { LEARNING_AGENT_TASK_MAX_STEPS: "2251799813685248" },
    { LEARNING_AGENT_TASK_MAX_CALLS: "9007199254740991" },
    { LEARNING_AGENT_TASK_MAX_COMPUTE_MS: "-1" },
    { LEARNING_AGENT_TASK_MAX_COMPUTE_MS: "2147483648" },
  ])("rejects invalid or overflowing execution guards %j", env => {
    expect(() => learningAgentTaskBudget(env)).toThrowError(expect.objectContaining({ status: 503, code: "agent_not_configured" }));
  });

  it("allows more than 16 calls, preserves usage after reopening, and stops before the configured next call", () => {
    const root = mkdtempSync(join(tmpdir(), "learning-task-budget-synthetic-")), db = join(root, "tasks.sqlite");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    let store = AgentStore.open(db);
    cleanup.push(() => { if (store.database.open) store.close(); });
    const input = { accountId: "synthetic", scenario: "learning.adaptive-review.v1", resourceId: "synthetic-page", goal: "Synthetic budget verification", scope: {} };
    const budget = learningAgentTaskBudget({ LEARNING_AGENT_TASK_MAX_CALLS: "20" });
    const task = store.createTask({ ...input, budget });
    let lease = store.claim("synthetic", task.id)!;
    const request = { kind: "synthetic_decision", inputChars: 48_000, maxOutputTokens: 8_000 };
    const complete = (index: number) => {
      const id = store.reserveCall("synthetic", task.id, lease.token, `synthetic:${index}`, request, 0);
      // Deliberately large fixture usage proves reporting is not an aggregate token quota.
      store.finishCall(id, "succeeded", { inputTokens: 1_000_000, outputTokens: 8_000 });
    };
    for (let i = 0; i < 10; i++) complete(i);
    store.release("synthetic", task.id, lease); store.close();
    store = AgentStore.open(db);
    const duplicate = store.createTask({ ...input, id: task.id, budget: learningAgentTaskBudget({ LEARNING_AGENT_TASK_MAX_CALLS: "200" }) });
    expect(duplicate.budget).toEqual(budget); expect(duplicate.usage.calls).toBe(10);
    lease = store.claim("synthetic", task.id)!;
    for (let i = 10; i < 20; i++) complete(i);
    expect(store.getTask("synthetic", task.id).usage).toMatchObject({ calls: 20, inputTokens: 20_000_000, outputTokens: 160_000 });
    expect(() => complete(20)).toThrow("agent_call_limit");
    expect(store.getTask("synthetic", task.id).usage.calls).toBe(20);
  });

  it("keeps per-request input and output checks even with a higher task limit", () => {
    const store = AgentStore.open(":memory:"); cleanup.push(() => store.close());
    const task = store.createTask({ accountId: "synthetic", scenario: "learning.adaptive-review.v1", resourceId: "synthetic-page",
      goal: "Synthetic request limits", scope: {}, budget: learningAgentTaskBudget({ LEARNING_AGENT_TASK_MAX_CALLS: "100" }) });
    const lease = store.claim("synthetic", task.id)!;
    const accepted = store.reserveCall("synthetic", task.id, lease.token, "large", { kind: "synthetic", inputChars: 200_000, maxOutputTokens: 8000 }, 0);
    store.finishCall(accepted, "succeeded", { inputTokens: 90_000, outputTokens: 10 });
    expect(() => store.reserveCall("synthetic", task.id, lease.token, "input", { kind: "synthetic", inputChars: 200_001, maxOutputTokens: 1 }, 0)).toThrow("agent_request_input_limit");
    expect(() => store.reserveCall("synthetic", task.id, lease.token, "output", { kind: "synthetic", inputChars: 1, maxOutputTokens: 8_001 }, 0)).toThrow("agent_request_output_limit");
    expect(store.getTask("synthetic", task.id).usage.calls).toBe(1);
  });
});
