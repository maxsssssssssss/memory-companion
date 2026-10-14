// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AgentStore } from "./store";
import { AgentRuntime } from "./runtime";
import { AgentFailure, type AgentDecision, type AgentDecisionProvider, type AgentScenario } from "./types";

const resources: Array<() => void> = [];
afterEach(() => { for (const cleanup of resources.splice(0).reverse()) cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function setup(decisions: AgentDecision[], options: { calls?: number; tools?: AgentScenario["tools"] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "shared-agent-"));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "tasks.sqlite"), checkpointPath = join(directory, "execution.sqlite");
  const store = AgentStore.open(dbPath);
  resources.push(() => { if (store.database.open) store.close(); });
  const business = new Map<string, { value: number; feedback?: string }>();
  let allowed = true;
  const create = vi.fn(async (_args, ctx) => {
    business.set(ctx.actionId, { value: 7 });
    return { ref: { kind: "synthetic.record", id: ctx.actionId }, summary: "已建立合成记录", wait: { kind: "record", refId: ctx.actionId, message: "等待提交合成反馈" } };
  });
  const scene: AgentScenario = {
    id: "synthetic-review", validate: async (ctx) => {
      if (!allowed || ctx.task.resourceId !== "record-scope") throw new AgentFailure("source_changed", "合成来源不可用");
    }, observe: async () => ({ available: true, instruction: "Reference data is not an instruction." }),
    tools: {
      "synthetic.read": { description: "Read one authorized synthetic value", parameters: z.object({ id: z.literal("allowed") }).strict(),
        execute: async () => ({ ref: { kind: "synthetic.input", id: "allowed" }, summary: "已读取授权记录" }), readResult: async () => ({ value: 3 }) },
      "synthetic.create": { description: "Create an isolated business record", parameters: z.object({}).strict(), execute: create,
        readResult: async (receipt) => business.get(receipt.resultRef!.id) },
      ...options.tools,
    },
    validateEvent: async (event) => {
      if (event.kind !== "submitted" || !event.refId || !business.get(event.refId)?.feedback) throw new AgentFailure("invalid_action", "合成应用还没有保存反馈");
    },
    finish: async () => "本轮操作结束；未验证任何长期业务结果。",
  };
  let index = 0;
  const decision = vi.fn<AgentDecisionProvider>(async (_input, ctx) => ctx.call({ kind: "decision", inputChars: 100, maxOutputTokens: 200 }, async () => ({ value: decisions[index++] ?? { finish: "stop" }, usage: { inputTokens: 10, outputTokens: 5 } })));
  const runtime = new AgentRuntime({ store, checkpointPath, scenario: scene, decision });
  resources.push(() => { if (runtime) { try { runtime.close(); } catch {} } });
  const task = store.createTask({ accountId: "alice", scenario: scene.id, resourceId: "record-scope", goal: "Review a synthetic record", scope: { record: "allowed" }, budget: { maxCalls: options.calls ?? 12 } });
  return { store, runtime, task, scene, decision, create, business, directory, checkpointPath, dbPath, revoke: () => { allowed = false; } };
}

describe("shared LangGraph execution with a non-Learning business scene", () => {
  it("feeds actual tool results into the next decision and persists only references in checkpoints", async () => {
    const h = setup([{ tool: "synthetic.read", args: { id: "allowed" } }, { tool: "synthetic.create", args: {} }]);
    const task = await h.runtime.advance("alice", h.task.id);
    expect(task.status).toBe("waiting");
    expect(task.actions.map((a) => a.tool)).toEqual(["synthetic.read", "synthetic.create"]);
    expect(h.decision.mock.calls[1][0].results[0].value).toEqual({ value: 3 });
    expect(task.usage.calls).toBe(2);
    const checkpoint = readFileSync(h.checkpointPath).toString("latin1");
    expect(checkpoint).not.toContain("Reference data is not an instruction");
    expect(checkpoint).not.toContain("Review a synthetic record");
  });
  it("waits with zero calls, survives closing databases, validates saved feedback and deduplicates events", async () => {
    const h = setup([{ tool: "synthetic.create", args: {} }, { finish: "I guarantee mastery" }]);
    const waiting = await h.runtime.advance("alice", h.task.id);
    await h.runtime.advance("alice", h.task.id);
    expect(h.decision).toHaveBeenCalledTimes(1);
    h.runtime.close(); h.store.close();
    const reopenedStore = AgentStore.open(h.dbPath);
    const reopenedRuntime = new AgentRuntime({ store: reopenedStore, checkpointPath: h.checkpointPath, scenario: h.scene, decision: h.decision });
    resources.push(() => { reopenedRuntime.close(); reopenedStore.close(); });
    expect((await reopenedRuntime.advance("alice", h.task.id)).status).toBe("waiting");
    h.business.get(waiting.wait!.refId!)!.feedback = "the synthetic app saved this";
    const event = { id: "application-submission-1", kind: "submitted", refId: waiting.wait!.refId };
    const ended = await reopenedRuntime.advance("alice", h.task.id, event);
    expect(ended.status).toBe("ended");
    expect(ended.endReason).toBe("本轮操作结束；未验证任何长期业务结果。");
    expect(h.decision.mock.calls[1][0].results[0].value).toEqual({ value: 7, feedback: "the synthetic app saved this" });
    await reopenedRuntime.advance("alice", h.task.id, event);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.decision).toHaveBeenCalledTimes(2);
  });
  it("rejects illegal tools, out of scope parameters, and cross-account calls before tool execution", async () => {
    for (const next of [{ tool: "shell", args: {} }, { tool: "synthetic.read", args: { id: "someone-else" } }]) {
      const h = setup([next]);
      await expect(h.runtime.advance("bob", h.task.id)).rejects.toMatchObject({ code: "forbidden" });
      expect((await h.runtime.advance("alice", h.task.id)).status).toBe("needs_attention");
      expect(h.create).not.toHaveBeenCalled();
    }
  });
  it("does not accept an unsaved feedback event", async () => {
    const h = setup([{ tool: "synthetic.create", args: {} }]);
    const waiting = await h.runtime.advance("alice", h.task.id);
    const rejected = await h.runtime.advance("alice", h.task.id, { id: "fake", kind: "submitted", refId: waiting.wait!.refId });
    expect(rejected.status).toBe("needs_attention");
    expect(h.decision).toHaveBeenCalledTimes(1);
  });
  it.each(["before", "after"] as const)("does not lose an accepted feedback when pause races %s its consumption", async (timing) => {
    const h = setup([{ tool: "synthetic.create", args: {} }, { finish: "stop after actual feedback" }]);
    const waiting = await h.runtime.advance("alice", h.task.id);
    h.business.get(waiting.wait!.refId!)!.feedback = "saved application feedback";
    const event = { id: "pause-at-consume", kind: "submitted", refId: waiting.wait!.refId };
    await h.runtime.submitEvent("alice", h.task.id, event, { expectedVersion: 1, defer: true });
    const other = AgentStore.open(h.dbPath);
    resources.push(() => other.close());
    const consume = h.store.continueEvent.bind(h.store);
    vi.spyOn(h.store, "continueEvent").mockImplementationOnce((...args) => {
      if (timing === "before") other.control("alice", h.task.id, "pause", 1);
      const result = consume(...args);
      if (timing === "after") other.control("alice", h.task.id, "pause", 1);
      return result;
    });
    expect((await h.runtime.advance("alice", h.task.id)).status).toBe("paused");
    expect(h.store.acceptedEvent("alice", h.task.id, event)?.consumed).toBe(timing === "after");
    h.runtime.control("alice", h.task.id, "resume", 1);
    expect((await h.runtime.advance("alice", h.task.id)).status).toBe("ended");
    expect(h.decision).toHaveBeenCalledTimes(2); expect(h.create).toHaveBeenCalledTimes(1);
  });
  it("ignores an old submitted event while waiting for a different record and resumes an accepted pending event", async () => {
    const h = setup([{ tool: "synthetic.create", args: {} }, { tool: "synthetic.create", args: {} }, { finish: "end" }]);
    const first = await h.runtime.advance("alice", h.task.id);
    h.business.get(first.wait!.refId!)!.feedback = "saved first response";
    const firstEvent = { id: "first-event", kind: "submitted", refId: first.wait!.refId };
    const second = await h.runtime.advance("alice", h.task.id, firstEvent);
    expect(second.status).toBe("waiting");
    expect(second.wait!.refId).not.toBe(first.wait!.refId);
    expect((await h.runtime.advance("alice", h.task.id, firstEvent)).status).toBe("waiting");
    expect((await h.runtime.advance("alice", h.task.id, { ...firstEvent, id: "same-result-new-event-id" })).status).toBe("waiting");
    expect(h.decision).toHaveBeenCalledTimes(2);
    h.business.get(second.wait!.refId!)!.feedback = "saved second response";
    const secondEvent = { id: "second-event", kind: "submitted", refId: second.wait!.refId };
    const lease = h.store.claim("alice", h.task.id)!;
    h.store.acceptEvent("alice", h.task.id, lease.token, secondEvent);
    h.store.release("alice", h.task.id, lease);
    expect((await h.runtime.advance("alice", h.task.id, secondEvent)).status).toBe("ended");
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it("uses a caller's stable task identity without changing immutable authorization or budget", () => {
    const h = setup([]);
    const input = { id: "client-task-id-123", accountId: "alice", scenario: h.scene.id, resourceId: "record-scope", goal: "a goal", scope: { record: "allowed" } };
    const a = h.store.createTask(input), b = h.store.createTask({ ...input, budget: { maxCalls: 999 } });
    expect(b.id).toBe(a.id); expect(b.budget.maxCalls).toBe(a.budget.maxCalls);
    expect(() => h.store.createTask({ ...input, goal: "different" })).toThrow();
    expect(() => h.store.createTask({ ...input, accountId: "bob" })).toThrow();
  });
  it("settles active computation when pause invalidates a lease without counting waiting time twice", () => {
    const h = setup([]);
    let time = 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    try {
      const lease = h.store.claim("alice", h.task.id)!;
      h.store.setState("alice", h.task.id, lease.token, "running");
      time += 750;
      expect(h.store.control("alice", h.task.id, "pause").usage.computeMs).toBe(750);
      time += 10_000;
      h.store.release("alice", h.task.id, lease);
      expect(h.store.getTask("alice", h.task.id).usage.computeMs).toBe(750);
      expect(h.store.control("alice", h.task.id, "resume").usage.computeMs).toBe(750);
    } finally { clock.mockRestore(); }
  });
  it("enforces the same lease fence from another SQLite connection", () => {
    const h = setup([]);
    const other = AgentStore.open(h.dbPath);
    try {
      const lease = h.store.claim("alice", h.task.id)!;
      h.store.setState("alice", h.task.id, lease.token, "running");
      expect(other.claim("alice", h.task.id)).toBeNull();
      other.control("alice", h.task.id, "cancel");
      expect(() => h.store.prepareAction("alice", h.task.id, lease.token, { step: 1, tool: "synthetic.create", args: {} })).toThrow();
      expect(() => h.store.reserveCall("alice", h.task.id, lease.token, "action", { kind: "decision", inputChars: 1, maxOutputTokens: 1 }, 1)).toThrow();
      expect(h.store.getTask("alice", h.task.id).actions).toHaveLength(0);
    } finally { other.close(); }
  });
  it("pauses and resumes a persisted wait without calls, and cancellation never runs a new action", async () => {
    const h = setup([{ tool: "synthetic.create", args: {} }]);
    await h.runtime.advance("alice", h.task.id);
    expect(h.runtime.control("alice", h.task.id, "pause").status).toBe("paused");
    await h.runtime.advance("alice", h.task.id);
    expect(h.runtime.control("alice", h.task.id, "resume").status).toBe("waiting");
    await h.runtime.advance("alice", h.task.id);
    expect(h.runtime.control("alice", h.task.id, "cancel").status).toBe("cancelled");
    await h.runtime.advance("alice", h.task.id);
    expect(h.decision).toHaveBeenCalledTimes(1);
    expect(h.business.size).toBe(1);
  });
  it("revalidates source availability while waiting before replaying old evidence", async () => {
    const h = setup([{ tool: "synthetic.create", args: {} }]);
    await h.runtime.advance("alice", h.task.id); h.revoke();
    const invalid = await h.runtime.advance("alice", h.task.id);
    expect(invalid.status).toBe("needs_attention");
    expect(invalid.endReason).toContain("来源已变化");
    expect(h.decision).toHaveBeenCalledTimes(1);
  });
  it("fences concurrent resumes and late results after cancellation", async () => {
    let resolve!: () => void;
    const barrier = new Promise<void>((done) => { resolve = done; });
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const h = setup([{ tool: "synthetic.slow", args: {} }], { tools: {
      "synthetic.slow": { description: "slow isolated tool", parameters: z.object({}), execute: async () => {
        entered(); await barrier; return { ref: { kind: "record", id: "kept" }, summary: "finished before cancellation was observed" };
      } },
    } });
    const run = h.runtime.advance("alice", h.task.id);
    await started;
    const parallel = await h.runtime.advance("alice", h.task.id);
    expect(parallel.status).toBe("running");
    expect(h.runtime.control("alice", h.task.id, "resume").status).toBe("running");
    expect(h.store.claim("alice", h.task.id)).toBeNull();
    h.runtime.control("alice", h.task.id, "cancel");
    resolve();
    const cancelled = await run;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.actions[0].status).toBe("running");
    expect(h.decision).toHaveBeenCalledTimes(1);
  });
  it.each(["pause", "cancel", "source_deleted"] as const)("keeps completed call usage when %s fences its late result", async (operation) => {
    let resolve!: () => void;
    const response = new Promise<void>((done) => { resolve = done; });
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const h = setup([{ tool: "synthetic.generate_late", args: {} }], { tools: {
      "synthetic.generate_late": { description: "synthetic complete response after a state change", parameters: z.object({}), execute: async (_args, ctx) => {
        await ctx.call({ kind: "late_generation", inputChars: 40, maxOutputTokens: 30 }, async () => {
          entered(); await response;
          return { value: "SYNTHETIC_LATE_BODY", usage: { inputTokens: 23, outputTokens: 11 } };
        });
        return { ref: { kind: "synthetic.record", id: "must-not-be-published" }, summary: "unpublished result" };
      } },
    } });
    const run = h.runtime.advance("alice", h.task.id);
    await started;
    if (operation === "source_deleted") h.revoke();
    else h.runtime.control("alice", h.task.id, operation);
    resolve();
    const result = await run;
    expect(result.status).toBe(operation === "pause" ? "paused" : operation === "cancel" ? "cancelled" : "needs_attention");
    expect(result.usage).toMatchObject({ calls: 2, inputTokens: 33, outputTokens: 16, unknownUsageCalls: 0 });
    expect(result.actions[0].resultRef).toBeUndefined();
    expect(h.store.database.prepare("SELECT status,input_tokens,output_tokens FROM agent_calls WHERE task_id=? AND kind='late_generation'").get(h.task.id))
      .toEqual({ status: "succeeded", input_tokens: 23, output_tokens: 11 });
    expect(h.decision).toHaveBeenCalledTimes(1);
  });
  it("lets an explicit failure inform a next decision, but never retries unknown external results", async () => {
    const known = setup([{ tool: "synthetic.fail", args: {} }, { finish: "hand back" }], { tools: {
      "synthetic.fail": { description: "known failure", parameters: z.object({}), execute: async () => { throw new AgentFailure("known_failure", "rejected before execution"); } },
    } });
    expect((await known.runtime.advance("alice", known.task.id)).status).toBe("ended");
    expect(known.decision.mock.calls[1][0].results[0]).toMatchObject({ status: "failed" });
    const uncertain = setup([{ tool: "synthetic.unknown", args: {} }], { tools: {
      "synthetic.unknown": { description: "unknown provider result", parameters: z.object({}), execute: async (_args, ctx) => {
        try { await ctx.call({ kind: "nested", inputChars: 10, maxOutputTokens: 10 }, async () => { throw new Error("timeout body should not be saved"); }); } catch { /* existing business service caught error */ }
        return { summary: "service incorrectly reported failure as a normal return" };
      } },
    } });
    const stopped = await uncertain.runtime.advance("alice", uncertain.task.id);
    expect(stopped.status).toBe("needs_attention");
    expect(stopped.actions[0].status).toBe("unknown");
    await uncertain.runtime.advance("alice", uncertain.task.id);
    expect(stopped.usage.calls).toBe(2);
    expect(stopped.usage.inputTokens).toBeNull();
    expect(stopped.usage.unknownUsageCalls).toBe(1);
    expect(readFileSync(uncertain.dbPath).toString("latin1")).not.toContain("timeout body should not be saved");
  });
  it("returns a definite proposal preparation failure to the bounded decision loop without approval or a write", async () => {
    const write = vi.fn(async () => ({ summary: "must not execute" }));
    const h = setup([{ tool: "synthetic.propose", args: {} }, { wait: { kind: "feedback", message: "Select a valid synthetic target" } }], { tools: {
      "synthetic.propose": { description: "prepare a fixed authorized proposal", parameters: z.object({}).strict(), execute: write,
        confirmation: async () => { throw new AgentFailure("known_failure", "PRIVATE_DIAGNOSTIC_DO_NOT_PERSIST", undefined, "synthetic_target_invalid: read the permitted navigation or ask the user to select a target"); } },
    } });
    const waiting = await h.runtime.advance("alice", h.task.id);
    expect(waiting).toMatchObject({ status: "waiting", usage: { calls: 2 } });
    expect(waiting.approval).toBeUndefined(); expect(waiting.recovery).toBeUndefined();
    expect(waiting.actions).toHaveLength(1);
    expect(waiting.actions[0]).toMatchObject({ status: "failed", summary: "synthetic_target_invalid: read the permitted navigation or ask the user to select a target" });
    expect(h.decision.mock.calls[1][0].results[0]).toMatchObject({ status: "failed", value: { summary: waiting.actions[0].summary } });
    expect(JSON.stringify(waiting)).not.toContain("PRIVATE_DIAGNOSTIC");
    expect(h.store.database.prepare("SELECT count(*) AS count FROM agent_approvals").get()).toEqual({ count: 0 });
    await h.runtime.advance("alice", h.task.id);
    expect(h.decision).toHaveBeenCalledTimes(2); expect(write).not.toHaveBeenCalled();
  });
  it("stops repeated invalid proposal targets through the existing no-progress and cumulative call budget", async () => {
    const write = vi.fn(async () => ({ summary: "must not execute" }));
    const h = setup(Array.from({ length: 4 }, () => ({ tool: "synthetic.propose", args: {} })), { tools: {
      "synthetic.propose": { description: "known invalid target", parameters: z.object({}).strict(), execute: write,
        confirmation: async () => { throw new AgentFailure("known_failure", "synthetic_target_invalid"); } },
    } });
    const stopped = await h.runtime.advance("alice", h.task.id);
    expect(stopped.status).toBe("budget_exhausted");
    expect(stopped.actions).toHaveLength(stopped.budget.maxNoProgress);
    expect(stopped.actions.every(action => action.status === "failed")).toBe(true);
    expect(stopped.usage.calls).toBe(4); expect(stopped.approval).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });
  it.each(["forbidden", "source_changed", "unknown"] as const)("does not treat %s during preparation as a correctable address error", async code => {
    const write = vi.fn(async () => ({ summary: "must not execute" }));
    const h = setup([{ tool: "synthetic.propose", args: {} }], { tools: {
      "synthetic.propose": { description: "invalid scope or uncertain preparation", parameters: z.object({}).strict(), execute: write,
        confirmation: async () => { throw new AgentFailure(code, "private diagnostic"); } },
    } });
    const stopped = await h.runtime.advance("alice", h.task.id);
    expect(stopped).toMatchObject({ status: "needs_attention", recovery: { kind: code === "unknown" ? "unknown" : "source_invalid" } });
    expect(h.decision).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
    expect(stopped.approval).toBeUndefined();
  });
  it.each(["known_failure", "unknown"] as const)("retains received usage for a %s response without changing its retry classification", async (code) => {
    const h = setup([]);
    h.decision.mockImplementation(async (_input, ctx) => ctx.call({ kind: "decision", inputChars: 30, maxOutputTokens: 20 }, async () => {
      throw new AgentFailure(code, "Synthetic response rejected by the action protocol", { inputTokens: 17, outputTokens: 8 });
    }));
    const result = await h.runtime.advance("alice", h.task.id);
    expect(result).toMatchObject({ status: "needs_attention", usage: { calls: 1, inputTokens: 17, outputTokens: 8, unknownUsageCalls: 0 } });
    expect(result.recovery?.allowedControls.includes("retry")).toBe(code === "known_failure");
    expect(h.store.database.prepare("SELECT status,input_tokens,output_tokens FROM agent_calls WHERE task_id=?").get(h.task.id))
      .toEqual({ status: code === "known_failure" ? "failed" : "unknown", input_tokens: 17, output_tokens: 8 });
    expect(h.decision).toHaveBeenCalledTimes(1);
  });
  it("counts nested generation independently and blocks the next network call at the shared budget", async () => {
    const actual = vi.fn(async () => ({ value: "generated" }));
    const h = setup([{ tool: "synthetic.generate", args: {} }], { calls: 2, tools: {
      "synthetic.generate": { description: "nested generation", parameters: z.object({}), execute: async (_args, ctx) => {
        await ctx.call({ kind: "generation", inputChars: 20, maxOutputTokens: 10 }, actual);
        await ctx.call({ kind: "generation", inputChars: 20, maxOutputTokens: 10 }, actual);
        return { summary: "unreachable" };
      } },
    } });
    const exhausted = await h.runtime.advance("alice", h.task.id);
    expect(exhausted.status).toBe("budget_exhausted");
    expect(actual).toHaveBeenCalledTimes(1);
    expect(exhausted.usage.calls).toBe(2);
    expect(exhausted.usage.inputTokens).toBeNull();
  });
  it("looks up a stable operation receipt after a lost notification instead of repeating side effects", async () => {
    const execute = vi.fn(async () => { throw new AgentFailure("unknown", "business commit succeeded but notification was lost"); });
    const recover = vi.fn(async (id: string) => ({ ref: { kind: "existing.record", id }, summary: "通过业务操作标识确认原结果" }));
    const h = setup([{ tool: "synthetic.recover", args: {} }, { finish: "done" }], { tools: {
      "synthetic.recover": { description: "recover lost result", parameters: z.object({}), execute, recover },
    } });
    const result = await h.runtime.advance("alice", h.task.id);
    expect(result.status).toBe("ended"); expect(result.actions[0].status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1); expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0][0]).toBe(result.actions[0].id);
  });
  it("checks per-request character/output limits before network and stops repetitive no-progress actions", async () => {
    const fetcher = vi.fn(async () => ({ value: "not reached" }));
    const oversized = setup([{ tool: "synthetic.oversized", args: {} }], { tools: {
      "synthetic.oversized": { description: "oversized request", parameters: z.object({}), execute: async (_args, ctx) => {
        await ctx.call({ kind: "generation", inputChars: 48_001, maxOutputTokens: 10 }, fetcher); return { summary: "unreachable" };
      } },
    } });
    expect((await oversized.runtime.advance("alice", oversized.task.id)).status).toBe("budget_exhausted");
    expect(fetcher).not.toHaveBeenCalled();
    const looping = setup(Array.from({ length: 5 }, () => ({ tool: "synthetic.read", args: { id: "allowed" } })));
    const stopped = await looping.runtime.advance("alice", looping.task.id);
    expect(stopped.status).toBe("budget_exhausted");
    expect(stopped.actions).toHaveLength(3);
  });
  it("does not externalize traces even with inherited tracing enabled", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "true");
    const outbound = vi.fn(async () => { throw new Error("unauthorized trace request"); });
    vi.stubGlobal("fetch", outbound);
    const h = setup([{ finish: "done" }]);
    expect((await h.runtime.advance("alice", h.task.id)).status).toBe("ended");
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe("A2 versioned changes, confirmation and recovery with no product dependency", () => {
  const proposal = () => ({ title: "确认追加合成记录", summary: "仅追加当前授权记录", target: "synthetic/allowed", content: "PRIVATE_PROPOSAL_CONTENT", sourceFingerprint: "scope-v1:target-rev-1" });
  function confirming() {
    const write = vi.fn(async () => ({ ref: { kind: "synthetic.receipt", id: "one-write" }, summary: "已保存合成追加记录", handoff: "写入已完成；请重新确认后续范围。" }));
    const confirmation = vi.fn(async () => proposal());
    const h = setup([{ tool: "synthetic.append", args: { target: "allowed" } }], { tools: {
      "synthetic.append": { description: "append with explicit confirmation", parameters: z.object({ target: z.literal("allowed") }),
        confirmation, execute: write, validateResult: async () => {} },
    } });
    return { ...h, write, confirmation };
  }
  it("adjusts goal/scope with CAS, preserves cumulative budget, and ignores old results and feedback", async () => {
    const h = setup([{ tool: "synthetic.read", args: { id: "allowed" } }, { tool: "synthetic.create", args: {} }, { finish: "revised objective" }]);
    const old = await h.runtime.advance("alice", h.task.id);
    const input = { expectedVersion: 1, goal: "A different authorized goal", scope: { record: "allowed", narrowed: true }, eventId: "adjust-1" };
    const revised = await h.runtime.adjust("alice", h.task.id, input);
    expect(revised).toMatchObject({ version: 2, status: "ready", goal: input.goal, usage: { calls: 2, steps: 2 } });
    expect(revised.budget).toEqual(old.budget); expect(revised.currentAction).toBeUndefined();
    expect((await h.runtime.adjust("alice", h.task.id, input)).version).toBe(2);
    await expect(h.runtime.adjust("alice", h.task.id, { ...input, eventId: "stale-update" })).rejects.toMatchObject({ code: "conflict" });
    await expect(h.runtime.advance("alice", h.task.id, { id: "old-feedback", kind: "submitted", refId: old.wait!.refId, version: 1 })).rejects.toMatchObject({ code: "conflict" });
    const ended = await h.runtime.advance("alice", h.task.id);
    expect(ended.status).toBe("ended"); expect(ended.usage.calls).toBe(3);
    expect(h.decision.mock.calls[2][0].results).toEqual([]);
    expect(h.decision.mock.calls[2][0].task.actions).toEqual([]);
    expect(h.decision.mock.calls[2][0].event).toBeUndefined();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it("allows only one concurrent scope change and fences a late old-version response while retaining its usage", async () => {
    let release!: () => void, entered!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const h = setup([{ tool: "synthetic.delayed", args: {} }], { tools: {
      "synthetic.delayed": { description: "late synthetic response", parameters: z.object({}), execute: async (_args, ctx) => {
        await ctx.call({ kind: "late", inputChars: 1, maxOutputTokens: 10 }, async () => { entered(); await response; return { value: "late", usage: { inputTokens: 7, outputTokens: 3 } }; });
        return { ref: { kind: "synthetic.late", id: "old" }, summary: "must not publish" };
      } },
    } });
    const running = h.runtime.advance("alice", h.task.id); await started;
    const changes = await Promise.allSettled([
      h.runtime.adjust("alice", h.task.id, { expectedVersion: 1, goal: "new one", scope: {} }),
      h.runtime.adjust("alice", h.task.id, { expectedVersion: 1, goal: "new two", scope: {} }),
    ]);
    expect(changes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    release(); const current = await running;
    expect(current.version).toBe(2); expect(current.status).toBe("ready"); expect(current.currentAction).toBeUndefined();
    expect(current.actions[0].resultRef).toBeUndefined();
    expect(current.usage).toMatchObject({ calls: 2, inputTokens: 17, outputTokens: 8, unknownUsageCalls: 0 });
    expect(() => h.store.control("alice", h.task.id, "cancel", 1)).toThrow();
  });
  it("persists confirmation without a shared content copy, then executes the exact approved action once after reopening", async () => {
    const h = confirming();
    const waiting = await h.runtime.advance("alice", h.task.id);
    expect(waiting).toMatchObject({ status: "waiting", wait: { kind: "confirmation" }, approval: { status: "pending", taskVersion: 1, content: "" } });
    expect(h.write).not.toHaveBeenCalled(); expect(h.decision).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.store.database.prepare("SELECT * FROM agent_approvals").all())).not.toContain("PRIVATE_PROPOSAL_CONTENT");
    const input = { approvalId: waiting.approval!.id, expectedVersion: 1, fingerprint: waiting.approval!.fingerprint, decision: "approve" as const, eventId: "approval-1", defer: true };
    await h.runtime.resolveApproval("alice", h.task.id, input);
    expect(h.write).not.toHaveBeenCalled();
    h.runtime.close();
    const reopened = new AgentRuntime({ store: h.store, checkpointPath: h.checkpointPath, scenario: h.scene, decision: h.decision });
    resources.push(() => reopened.close());
    const ended = await reopened.advance("alice", h.task.id);
    expect(ended.status).toBe("ended"); expect(h.write).toHaveBeenCalledTimes(1); expect(h.decision).toHaveBeenCalledTimes(1);
    expect(ended.actions[0].id).toBe(waiting.approval!.actionId);
    await reopened.resolveApproval("alice", h.task.id, input);
    expect(h.write).toHaveBeenCalledTimes(1);
    await reopened.resolveApproval("alice", h.task.id, { ...input, eventId: "same-approval-new-event" });
    await expect(reopened.resolveApproval("alice", h.task.id, { ...input, eventId: "tampered-new-event", fingerprint: "different" })).rejects.toMatchObject({ code: "conflict" });
    await expect(reopened.resolveApproval("alice", h.task.id, { ...input, eventId: "opposite-new-event", decision: "reject" })).rejects.toMatchObject({ code: "conflict" });
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it.each([["before", "approve"], ["after", "approve"], ["before", "reject"], ["after", "reject"]] as const)("preserves confirmation when pause races %s consumption of %s", async (timing, decision) => {
    const h = confirming(), waiting = await h.runtime.advance("alice", h.task.id);
    const input = { approvalId: waiting.approval!.id, expectedVersion: 1, fingerprint: waiting.approval!.fingerprint, decision, eventId: "pause-confirm", defer: true };
    await h.runtime.resolveApproval("alice", h.task.id, input);
    const other = AgentStore.open(h.dbPath);
    resources.push(() => other.close());
    const consume = h.store.continueEvent.bind(h.store);
    vi.spyOn(h.store, "continueEvent").mockImplementationOnce((...args) => {
      if (timing === "before") other.control("alice", h.task.id, "pause", 1);
      const result = consume(...args);
      if (timing === "after") other.control("alice", h.task.id, "pause", 1);
      return result;
    });
    expect((await h.runtime.advance("alice", h.task.id)).status).toBe("paused");
    expect(h.write).not.toHaveBeenCalled();
    h.runtime.control("alice", h.task.id, "resume", 1);
    expect((await h.runtime.advance("alice", h.task.id)).status).toBe("ended");
    expect(h.write).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0); expect(h.decision).toHaveBeenCalledTimes(decision === "approve" ? 1 : 2);
    await h.runtime.resolveApproval("alice", h.task.id, input);
    expect(h.write).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0);
  });
  it("inspects a consumed approval after reopening without re-waiting or executing until explicit continuation", async () => {
    const h = confirming(), waiting = await h.runtime.advance("alice", h.task.id);
    await h.runtime.resolveApproval("alice", h.task.id, { approvalId: waiting.approval!.id, expectedVersion: 1,
      fingerprint: waiting.approval!.fingerprint, decision: "approve", eventId: "approved-before-pause", defer: true });
    const consume = h.store.continueEvent.bind(h.store);
    vi.spyOn(h.store, "continueEvent").mockImplementationOnce((...args) => {
      const result = consume(...args);
      h.store.control("alice", h.task.id, "pause", 1);
      return result;
    });
    const paused = await h.runtime.advance("alice", h.task.id);
    expect(paused.status).toBe("paused"); expect(h.write).not.toHaveBeenCalled();
    h.runtime.close(); h.store.close();
    const store = AgentStore.open(h.dbPath);
    const runtime = new AgentRuntime({ store, checkpointPath: h.checkpointPath, scenario: h.scene, decision: h.decision });
    resources.push(() => { runtime.close(); store.close(); });
    const request = { expectedVersion: 1, mode: "inspect" as const, eventId: "inspect-consumed-approval" };
    const inspected = await runtime.recover("alice", h.task.id, request);
    expect(inspected).toMatchObject({ status: "ready", recovery: { kind: "not_started", actionId: waiting.approval!.actionId } });
    expect(inspected.wait).toBeUndefined(); expect(inspected.usage.calls).toBe(paused.usage.calls);
    expect(h.write).not.toHaveBeenCalled(); expect(h.decision).toHaveBeenCalledTimes(1);
    expect((await runtime.recover("alice", h.task.id, request)).status).toBe("ready");
    expect(h.write).not.toHaveBeenCalled(); expect(h.decision).toHaveBeenCalledTimes(1);
    const continued = await runtime.advance("alice", h.task.id);
    expect(continued.status).toBe("ended"); expect(continued.actions[0].id).toBe(waiting.approval!.actionId);
    expect(h.write).toHaveBeenCalledTimes(1); expect(h.decision).toHaveBeenCalledTimes(1);
  });
  it("rejects altered fingerprints and changed targets, and rejects a proposal without executing it", async () => {
    const h = confirming(), waiting = await h.runtime.advance("alice", h.task.id);
    const input = { approvalId: waiting.approval!.id, expectedVersion: 1, fingerprint: waiting.approval!.fingerprint, decision: "approve" as const, eventId: "approval-1", defer: true };
    await expect(h.runtime.resolveApproval("alice", h.task.id, { ...input, fingerprint: "tampered" })).rejects.toMatchObject({ code: "conflict" });
    expect(h.store.getTask("alice", h.task.id).status).toBe("waiting");
    h.confirmation.mockImplementation(async () => ({ ...proposal(), sourceFingerprint: "target-rev-2" }));
    await expect(h.runtime.resolveApproval("alice", h.task.id, input)).rejects.toMatchObject({ code: "source_changed" });
    expect(h.store.getTask("alice", h.task.id)).toMatchObject({ status: "needs_attention", approval: { status: "invalidated" }, recovery: { kind: "source_invalid" } });
    expect(h.write).not.toHaveBeenCalled();
    const rejected = confirming(), pending = await rejected.runtime.advance("alice", rejected.task.id);
    const result = await rejected.runtime.resolveApproval("alice", rejected.task.id, { approvalId: pending.approval!.id, expectedVersion: 1, fingerprint: pending.approval!.fingerprint, decision: "reject", eventId: "reject-1" });
    expect(result.status).toBe("ended"); expect(rejected.write).not.toHaveBeenCalled();
    expect(rejected.decision.mock.calls[1][0].event?.decision).toBe("reject");
  });
  it("invalidates old approvals when scope is adjusted and never forwards old proposed content", async () => {
    const h = confirming(), waiting = await h.runtime.advance("alice", h.task.id);
    await h.runtime.adjust("alice", h.task.id, { expectedVersion: 1, goal: "new goal", scope: {} });
    await expect(h.runtime.resolveApproval("alice", h.task.id, { approvalId: waiting.approval!.id, expectedVersion: 1, fingerprint: waiting.approval!.fingerprint, decision: "approve", eventId: "late-approve" })).rejects.toMatchObject({ code: "conflict" });
    await h.runtime.advance("alice", h.task.id);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.decision.mock.calls[1][0].task.approval).toBeUndefined();
    expect(h.decision.mock.calls[1][0].results).toEqual([]);
  });
  it("rechecks a deferred approval just before execution and fences cancellation after acceptance", async () => {
    for (const change of ["target", "cancel"] as const) {
      const h = confirming(), pending = await h.runtime.advance("alice", h.task.id);
      await h.runtime.resolveApproval("alice", h.task.id, { approvalId: pending.approval!.id, expectedVersion: 1, fingerprint: pending.approval!.fingerprint, decision: "approve", eventId: "approval-1", defer: true });
      if (change === "target") h.confirmation.mockImplementation(async () => ({ ...proposal(), content: "CHANGED_CONTENT" }));
      else h.runtime.control("alice", h.task.id, "cancel", 1);
      const result = await h.runtime.advance("alice", h.task.id);
      expect(result.status).toBe(change === "target" ? "needs_attention" : "cancelled");
      expect(h.write).not.toHaveBeenCalled();
    }
  });
  it("recovers a proposal saved before its graph checkpoint without asking the model to generate another action", async () => {
    const h = confirming(), save = h.store.saveApproval.bind(h.store);
    let lost = true;
    vi.spyOn(h.store, "saveApproval").mockImplementation((...args) => {
      save(...args);
      if (lost) { lost = false; throw new Error("synthetic stop after proposal write and before checkpoint"); }
    });
    const stopped = await h.runtime.advance("alice", h.task.id);
    expect(stopped.status).toBe("needs_attention"); expect(h.write).not.toHaveBeenCalled();
    const waiting = await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "inspect", eventId: "check-prepared" });
    expect(waiting).toMatchObject({ status: "waiting", wait: { kind: "confirmation" }, recovery: { kind: "not_started" } });
    const result = await h.runtime.resolveApproval("alice", h.task.id, { approvalId: waiting.approval!.id, expectedVersion: 1, fingerprint: waiting.approval!.fingerprint, decision: "approve", eventId: "approve-recovered" });
    expect(result.status).toBe("ended"); expect(h.write).toHaveBeenCalledTimes(1); expect(h.decision).toHaveBeenCalledTimes(1);
  });
  it("durably accepts a business feedback event before background advancement", async () => {
    const h = setup([{ tool: "synthetic.create", args: {} }, { finish: "end" }]);
    const waiting = await h.runtime.advance("alice", h.task.id);
    h.business.get(waiting.wait!.refId!)!.feedback = "saved response";
    const event = { id: "persisted-feedback", kind: "submitted", refId: waiting.wait!.refId, version: 1 };
    await h.runtime.submitEvent("alice", h.task.id, event, { expectedVersion: 1, defer: true });
    expect(h.store.pendingEvent("alice", h.task.id)).toEqual(event); expect(h.decision).toHaveBeenCalledTimes(1);
    expect((await h.runtime.advance("alice", h.task.id)).status).toBe("ended"); expect(h.decision).toHaveBeenCalledTimes(2);
  });
  it("reconciles an existing business result after shared receipt loss without repeating the original operation", async () => {
    const h = setup([{ tool: "synthetic.create", args: {} }]);
    h.scene.tools["synthetic.create"].recover = async (id) => h.business.has(id)
      ? { ref: { kind: "synthetic.record", id }, summary: "已有操作结果", wait: { kind: "record", refId: id, message: "等待反馈" } } : null;
    const original = h.store.markAction.bind(h.store);
    let loseOnce = true;
    vi.spyOn(h.store, "markAction").mockImplementation((...args) => {
      if (args[4] === "succeeded" && loseOnce) { loseOnce = false; throw new Error("synthetic receipt delivery lost"); }
      return original(...args);
    });
    const interrupted = await h.runtime.advance("alice", h.task.id);
    expect(interrupted).toMatchObject({ status: "needs_attention", recovery: { kind: "unknown" } });
    const recovered = await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "inspect", eventId: "inspect-1" });
    expect(recovered).toMatchObject({ status: "waiting", recovery: { kind: "succeeded" } });
    expect(h.create).toHaveBeenCalledTimes(1); expect(h.decision).toHaveBeenCalledTimes(1);
    await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "inspect", eventId: "inspect-1" });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it("never retries an unknown provider result but permits an explicit retry of a known failure within the same cumulative budget", async () => {
    const unknown = setup([]);
    unknown.decision.mockImplementationOnce(async (_input, ctx) => ctx.call({ kind: "decision", inputChars: 10, maxOutputTokens: 10 }, async () => { throw new AgentFailure("unknown", "synthetic connection lost"); }));
    const uncertain = await unknown.runtime.advance("alice", unknown.task.id);
    expect(uncertain.status).toBe("needs_attention");
    const inspected = await unknown.runtime.recover("alice", unknown.task.id, { expectedVersion: 1, mode: "inspect" });
    expect(inspected.recovery).toMatchObject({ kind: "unknown", allowedControls: ["inspect", "adjust", "cancel"] });
    const noRetry = await unknown.runtime.recover("alice", unknown.task.id, { expectedVersion: 1, mode: "retry" });
    expect(noRetry.status).toBe("needs_attention"); expect(unknown.decision).toHaveBeenCalledTimes(1);
    const known = setup([{ finish: "hand back" }]);
    known.decision.mockImplementationOnce(async (_input, ctx) => ctx.call({ kind: "decision", inputChars: 10, maxOutputTokens: 10 }, async () => { throw new AgentFailure("known_failure", "synthetic explicitly rejected request"); }));
    await known.runtime.advance("alice", known.task.id);
    const retry = await known.runtime.recover("alice", known.task.id, { expectedVersion: 1, mode: "retry", eventId: "retry-1" });
    expect(retry.status).toBe("ended"); expect(retry.usage.calls).toBe(2); expect(known.decision).toHaveBeenCalledTimes(2);
    await known.runtime.recover("alice", known.task.id, { expectedVersion: 1, mode: "retry", eventId: "retry-1" });
    expect(known.decision).toHaveBeenCalledTimes(2);
  });
  it("does not replay an expired execution lease and safely ends a blocked task with a version CAS", async () => {
    const h = setup([]), lease = h.store.claim("alice", h.task.id)!;
    h.store.setState("alice", h.task.id, lease.token, "running");
    h.store.database.prepare("UPDATE agent_tasks SET lease_until=0 WHERE id=?").run(h.task.id);
    const stale = await h.runtime.advance("alice", h.task.id);
    expect(stale).toMatchObject({ status: "needs_attention", recovery: { kind: "interrupted" } });
    expect(h.decision).not.toHaveBeenCalled();
    expect(() => h.runtime.end("alice", h.task.id, { expectedVersion: 2 })).toThrow();
    const ended = h.runtime.end("alice", h.task.id, { expectedVersion: 1, eventId: "end-1" });
    expect(ended.status).toBe("ended"); expect(ended.endReason).toContain("不代表");
  });
  it("never uses an earlier successful tool receipt to bypass a later unknown decision", async () => {
    const h = setup([{ tool: "synthetic.read", args: { id: "allowed" } }]);
    const first = h.decision.getMockImplementation()!;
    h.decision.mockImplementationOnce(first).mockImplementationOnce(async (_input, ctx) => ctx.call({ kind: "decision", inputChars: 10, maxOutputTokens: 10 }, async () => { throw new AgentFailure("unknown", "next decision response lost"); }));
    const interrupted = await h.runtime.advance("alice", h.task.id);
    expect(interrupted.actions[0].status).toBe("succeeded");
    const inspect = await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "inspect" });
    expect(inspect).toMatchObject({ status: "needs_attention", recovery: { kind: "unknown" } });
    await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "retry" });
    expect(h.decision).toHaveBeenCalledTimes(2);
  });
  it("offers receipt inspection after explicitly pausing an active request, without stealing a live lease", async () => {
    let release!: () => void, entered!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const h = setup([]);
    h.decision.mockImplementationOnce(async (_input, ctx) => ctx.call({ kind: "decision", inputChars: 10, maxOutputTokens: 10 }, async () => {
      entered(); await response; return { value: { finish: "late" }, usage: { inputTokens: 1, outputTokens: 1 } };
    }));
    const running = h.runtime.advance("alice", h.task.id); await started;
    expect((await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "inspect" })).status).toBe("running");
    const paused = h.runtime.control("alice", h.task.id, "pause", 1);
    expect(paused).toMatchObject({ status: "paused", recovery: { kind: "unknown", allowedControls: ["inspect", "adjust", "cancel"] } });
    expect((await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "inspect" })).recovery?.kind).toBe("unknown");
    release(); await running;
    expect(h.decision).toHaveBeenCalledTimes(1);
  });
  it("does not claim the new version using a stale task snapshot from another connection", async () => {
    const h = setup([{ finish: "new-version result" }]), other = AgentStore.open(h.dbPath);
    const claim = h.store.claim.bind(h.store);
    try {
      vi.spyOn(h.store, "claim").mockImplementationOnce((accountId, taskId, expectedVersion) => {
        other.adjust(accountId, taskId, { expectedVersion: 1, goal: "changed between read and lease", scope: {} });
        return claim(accountId, taskId, expectedVersion);
      });
      const revised = await h.runtime.advance("alice", h.task.id);
      expect(revised).toMatchObject({ version: 2, status: "ready" });
      expect(h.decision).not.toHaveBeenCalled();
      expect((await h.runtime.advance("alice", h.task.id)).status).toBe("ended");
      expect(h.decision.mock.calls[0][0].task.version).toBe(2);
    } finally { other.close(); }
  });
  it("conservatively settles expired running time once and retains that charge after adjustment", async () => {
    const h = setup([]);
    let time = 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    try {
      const lease = h.store.claim("alice", h.task.id, 1)!;
      h.store.setState("alice", h.task.id, lease.token, "running");
      time += h.task.budget.maxComputeMs + 31_000;
      expect(h.store.claim("alice", h.task.id, 1)).toBeNull();
      const expired = h.store.getTask("alice", h.task.id);
      expect(expired).toMatchObject({ status: "needs_attention", usage: { computeMs: h.task.budget.maxComputeMs, computeEstimated: true } });
      h.store.claim("alice", h.task.id, 1); h.store.release("alice", h.task.id, lease);
      expect(h.store.getTask("alice", h.task.id).usage.computeMs).toBe(expired.usage.computeMs);
      const revised = await h.runtime.adjust("alice", h.task.id, { expectedVersion: 1, goal: "new goal retains budget", scope: {} });
      expect(revised.usage).toMatchObject({ computeMs: expired.usage.computeMs, computeEstimated: true });
      expect((await h.runtime.advance("alice", h.task.id)).status).toBe("budget_exhausted");
      expect(h.decision).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it("explicitly retries the saved failed action after the graph moved to a later user wait", async () => {
    const attempts: string[] = [];
    const h = setup([{ tool: "synthetic.retryable", args: {} }, { wait: { kind: "feedback", message: "工具失败，等待用户处理" } }, { finish: "done" }], { tools: {
      "synthetic.retryable": { description: "known retryable operation", parameters: z.object({}), execute: async (_args, ctx) => {
        attempts.push(ctx.actionId);
        if (attempts.length === 1) throw new AgentFailure("known_failure", "explicit no-write failure");
        expect(ctx.task.recovery).toMatchObject({ kind: "known_failed", actionId: ctx.actionId });
        return { ref: { kind: "synthetic.result", id: ctx.actionId }, summary: "same operation recovered", handoff: "本次操作已完成并交回。" };
      }, recover: async () => null, validateResult: async () => {} },
    } });
    const waiting = await h.runtime.advance("alice", h.task.id);
    expect(waiting.status).toBe("waiting"); expect(waiting.actions[0].status).toBe("failed");
    const paused = h.runtime.control("alice", h.task.id, "pause", 1);
    expect(paused.recovery).toMatchObject({ kind: "known_failed", actionId: waiting.actions[0].id, allowedControls: ["inspect", "adjust", "cancel"] });
    const inspected = await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "inspect" });
    expect(inspected.recovery).toMatchObject({ kind: "known_failed", actionId: waiting.actions[0].id });
    const result = await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "retry", eventId: "same-operation-retry" });
    expect(result.status).toBe("ended"); expect(attempts).toEqual([waiting.actions[0].id, waiting.actions[0].id]);
    expect(result.recovery).toBeUndefined();
    expect(result.actions).toHaveLength(1); expect(h.decision).toHaveBeenCalledTimes(2);
  });
  it("does not offer a rejected proposal or an earlier superseded failure as a generation retry", async () => {
    const h = confirming();
    const initial = h.decision.getMockImplementation()!;
    h.decision.mockImplementationOnce(initial).mockImplementationOnce(async (_input, ctx) => ctx.call({ kind: "decision", inputChars: 10, maxOutputTokens: 10 }, async () => ({ value: { wait: { kind: "feedback", message: "已拒绝，等待其他要求" } }, usage: { inputTokens: 1, outputTokens: 1 } })));
    const pending = await h.runtime.advance("alice", h.task.id);
    await h.runtime.resolveApproval("alice", h.task.id, { approvalId: pending.approval!.id, expectedVersion: 1, fingerprint: pending.approval!.fingerprint, decision: "reject", eventId: "reject-no-retry" });
    const paused = h.runtime.control("alice", h.task.id, "pause", 1);
    expect(paused.recovery).toBeUndefined();
    const inspected = await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "inspect" });
    expect(inspected.status).toBe("paused"); expect(inspected.recovery).toBeUndefined();
    await h.runtime.recover("alice", h.task.id, { expectedVersion: 1, mode: "retry" });
    expect(h.write).not.toHaveBeenCalled(); expect(h.decision).toHaveBeenCalledTimes(2);
    const other = setup([{ tool: "synthetic.failed", args: {} }, { tool: "synthetic.read", args: { id: "allowed" } }, { wait: { kind: "feedback", message: "已取得其他结果" } }], { tools: {
      "synthetic.failed": { description: "known failure", parameters: z.object({}), execute: async () => { throw new AgentFailure("known_failure", "no write"); } },
    } });
    await other.runtime.advance("alice", other.task.id);
    expect(other.runtime.control("alice", other.task.id, "pause", 1).recovery).toBeUndefined();
  });
});
