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
