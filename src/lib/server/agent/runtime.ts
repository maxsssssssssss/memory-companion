import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createHash } from "node:crypto";
import type { AgentApproval, AgentConfirmation, AgentEvent, AgentRecovery, AgentTask } from "@/lib/domain/agent";
import { AgentStore, type AgentLease } from "./store";
import { agentBudgetEndReason } from "./budget-reason";
import { decisionSchemaIssues, decisionToolName } from "./decision-diagnostics";
import { AgentFailure, type AgentContext, type AgentDecisionProvider, type AgentScenario, type AgentToolResult } from "./types";

// LangGraph owns routing, durable execution position and interrupt/resume. These
// are references only: source text, tool bodies and model messages never enter it.
const Execution = Annotation.Root({
  taskId: Annotation<string>(),
  actionId: Annotation<string>(),
  next: Annotation<"prepare" | "execute" | "wait" | "confirm" | "decide" | "end">(),
});
function confirmationFingerprint(task: AgentTask, tool: string, args: unknown, confirmation: AgentConfirmation) {
  return createHash("sha256").update(JSON.stringify({ version: task.version ?? 1, taskId: task.id, tool, args, confirmation })).digest("hex");
}

/** Disable both LangChain and LangSmith auto-tracing, including inherited flags. */
export function disableAgentCloudTracing() {
  for (const name of ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"]) process.env[name] = "false";
}

export class AgentRuntime {
  private readonly checkpointer: SqliteSaver;
  private readonly running = new Map<string, AbortController>();
  constructor(private readonly options: { store: AgentStore; checkpointPath: string; scenario: AgentScenario; decision: AgentDecisionProvider }) {
    disableAgentCloudTracing();
    this.checkpointer = SqliteSaver.fromConnString(options.checkpointPath);
  }
  close() { this.checkpointer.db.close(); }
  control(accountId: string, taskId: string, operation: "pause" | "resume" | "cancel", expectedVersion?: number) {
    const task = this.options.store.control(accountId, taskId, operation, expectedVersion);
    if (operation !== "resume") this.running.get(taskId)?.abort();
    return task;
  }
  private localContext(accountId: string, taskId: string, lease?: AgentLease, actionId = "control", taskOverride?: AgentTask): AgentContext {
    const store = this.options.store, task = taskOverride ?? store.getTask(accountId, taskId);
    return { task, actionId, signal: new AbortController().signal,
      assertActive: async () => {
        const current = store.assertVersion(accountId, taskId, task.version ?? 1);
        if (lease) store.assertLease(accountId, taskId, lease.token);
        else if (["cancelled", "ended"].includes(current.status)) throw new AgentFailure("inactive", "任务已结束。");
      },
      call: async () => { throw new AgentFailure("forbidden", "确认与恢复检查不能发起模型生成。"); },
    };
  }
  async adjust(accountId: string, taskId: string, input: { expectedVersion: number; goal: string; scope: unknown; eventId?: string }) {
    const current = this.options.store.getTask(accountId, taskId);
    if (current.scenario !== this.options.scenario.id) throw new AgentFailure("forbidden", "任务场景不匹配。");
    if (current.version !== input.expectedVersion) return this.options.store.adjust(accountId, taskId, input);
    const proposed = { ...current, goal: input.goal, scope: input.scope };
    const ctx = this.localContext(accountId, taskId, undefined, "adjust", proposed);
    await this.options.scenario.validate(ctx);
    const result = this.options.store.adjust(accountId, taskId, input);
    this.running.get(taskId)?.abort();
    return result;
  }
  end(accountId: string, taskId: string, input: { expectedVersion: number; eventId?: string }) {
    const result = this.options.store.end(accountId, taskId, input);
    this.running.get(taskId)?.abort();
    return result;
  }
  async submitEvent(accountId: string, taskId: string, event: AgentEvent, input: { expectedVersion: number; defer?: boolean }) {
    const { store, scenario } = this.options;
    const task = store.assertVersion(accountId, taskId, input.expectedVersion);
    if (task.scenario !== scenario.id) throw new AgentFailure("forbidden", "任务场景不匹配。");
    if (event.kind === "approval") throw new AgentFailure("invalid_action", "确认提案请使用确认入口。");
    const accepted = store.acceptedEvent(accountId, taskId, event);
    if (accepted?.consumed) return task;
    if (task.status !== "waiting" || task.wait?.kind === "confirmation") throw new AgentFailure("inactive", "任务当前不接受该反馈。");
    const lease = store.claim(accountId, taskId, input.expectedVersion);
    if (!lease) throw new AgentFailure("conflict", "另一项操作正在处理此任务，反馈尚未接收，请稍后核对。");
    try {
      const ctx = this.localContext(accountId, taskId, lease, "event");
      await scenario.validate(ctx);
      if (task.wait?.refId && event.refId !== task.wait.refId) throw new AgentFailure("invalid_action", "反馈与当前等待记录不一致。");
      await scenario.validateEvent?.(event, ctx);
      await ctx.assertActive();
      if (!accepted) store.acceptEvent(accountId, taskId, lease.token, event);
    } finally { store.release(accountId, taskId, lease); }
    return input.defer ? store.getTask(accountId, taskId) : this.advance(accountId, taskId);
  }
  async pauseForFeedback(accountId: string, taskId: string, event: AgentEvent, expectedVersion: number) {
    const { store, scenario } = this.options;
    const task = store.assertVersion(accountId, taskId, expectedVersion);
    if (task.scenario !== scenario.id) throw new AgentFailure("forbidden", "任务场景不匹配。");
    if (store.acceptedEvent(accountId, taskId, event)) return task;
    const ctx = this.localContext(accountId, taskId);
    await scenario.validate(ctx);
    await scenario.validateEvent?.(event, ctx);
    const result = store.pauseForFeedback(accountId, taskId, event, expectedVersion);
    this.running.get(taskId)?.abort();
    return result;
  }
  async resolveApproval(accountId: string, taskId: string, input: { approvalId: string; expectedVersion: number; fingerprint: string; decision: "approve" | "reject"; eventId: string; defer?: boolean }) {
    const { store, scenario } = this.options;
    const task = store.assertVersion(accountId, taskId, input.expectedVersion);
    if (task.scenario !== scenario.id) throw new AgentFailure("forbidden", "任务场景不匹配。");
    const event: AgentEvent = { id: input.eventId, kind: "approval", refId: input.approvalId, version: input.expectedVersion, fingerprint: input.fingerprint, decision: input.decision };
    if (store.acceptedEvent(accountId, taskId, event)?.consumed) return task;
    if (task.status !== "waiting" || task.wait?.kind !== "confirmation" || task.wait.refId !== input.approvalId) throw new AgentFailure("inactive", "该提案当前不可确认。");
    const lease = store.claim(accountId, taskId, input.expectedVersion);
    if (!lease) throw new AgentFailure("conflict", "另一项操作正在处理此任务，确认尚未接收，请稍后核对。");
    try {
      const ctx = this.localContext(accountId, taskId, lease, input.approvalId);
      await scenario.validate(ctx);
      if (input.decision === "approve") await this.verifyApproval(accountId, taskId, input.approvalId, ctx, false);
      store.resolveApproval(accountId, taskId, lease.token, event);
    } catch (error) {
      if (error instanceof AgentFailure && error.code === "source_changed") this.recordFailure(accountId, taskId, lease, error);
      throw error;
    } finally { store.release(accountId, taskId, lease); }
    return input.defer ? store.getTask(accountId, taskId) : this.advance(accountId, taskId);
  }
  private async verifyApproval(accountId: string, taskId: string, actionId: string, ctx: AgentContext, requireApproved = true) {
    const { store, scenario } = this.options;
    const action = store.action(accountId, taskId, actionId), tool = scenario.tools[action.tool];
    const approval = store.approval(accountId, taskId, actionId);
    if (!tool?.confirmation || !approval || (requireApproved && approval.status !== "approved") || ["rejected", "invalidated"].includes(approval.status)) throw new AgentFailure("conflict", "行动尚未获得当前版本的确认。");
    const confirmation = await tool.confirmation(action.args, ctx);
    await ctx.assertActive();
    if (!confirmation || approval.fingerprint !== confirmationFingerprint(ctx.task, action.tool, action.args, confirmation)) throw new AgentFailure("source_changed", "提案内容、目标或来源已经变化，请重新确认。");
  }
  async recover(accountId: string, taskId: string, input: { expectedVersion: number; mode: "inspect" | "retry"; eventId?: string; defer?: boolean }) {
    const { store, scenario } = this.options;
    let task = store.assertVersion(accountId, taskId, input.expectedVersion);
    if (task.scenario !== scenario.id) throw new AgentFailure("forbidden", "任务场景不匹配。");
    if (store.recoverySeen(accountId, taskId, input)) return task;
    // Merely observing an expired lease never replays its checkpoint.
    if (task.status === "running") { const active = store.claim(accountId, taskId, input.expectedVersion); if (active) store.release(accountId, taskId, active); task = store.getTask(accountId, taskId); }
    const lease = store.claimRecovery(accountId, taskId, input.expectedVersion);
    if (!lease) return store.getTask(accountId, taskId);
    let retry = false;
    try {
      const calls = store.callsForVersion(accountId, taskId);
      const latestCall = calls[calls.length - 1];
      const latestReceipt = [...task.actions].reverse().find(action => (action.version ?? 1) === input.expectedVersion);
      // A later failed/unknown decision cannot be reconciled by an earlier
      // successful tool receipt: that would silently issue another decision.
      const pendingDecision = latestCall?.action_id.startsWith("decision:") && (!latestReceipt ||
        (Number(latestCall.action_id.slice(9)) > Number(latestReceipt.id.split(":").pop()) && (latestCall.status !== "succeeded" || latestReceipt.status === "succeeded")));
      const latest = pendingDecision ? undefined : latestReceipt;
      const action = latest ? store.action(accountId, taskId, latest.id) : undefined;
      const tool = action ? scenario.tools[action.tool] : undefined;
      const ctx = this.localContext(accountId, taskId, lease, action?.id ?? "recovery");
      await ctx.assertActive();
      if (action && store.approval(accountId, taskId, action.id)?.status === "rejected") {
        store.setState(accountId, taskId, lease.token, "paused", { wait: task.wait, endReason: "用户已拒绝这项提案；原行动不会作为生成失败重试。" });
        return store.getTask(accountId, taskId);
      }
      // Receipt lookup precedes source validation: a confirmed write can itself
      // legitimately have changed the source binding. Its postcondition must pass.
      const recovered = action?.status === "succeeded" ? { ref: action.resultRef, summary: action.summary, wait: action.wait, handoff: action.handoff }
        : action && tool?.recover ? await tool.recover(action.id, ctx) : null;
      if (recovered) {
        await this.validateToolResult(recovered, tool, ctx);
        store.recordRecovery(accountId, taskId, lease.token, input);
        store.reconcileCalls(taskId, action!.id);
        store.markAction(accountId, taskId, lease.token, action!.id, "succeeded", recovered);
        store.setState(accountId, taskId, lease.token, recovered.handoff ? "ended" : recovered.wait ? "waiting" : "ready", {
          wait: recovered.wait, endReason: recovered.handoff,
          recovery: { kind: "succeeded", actionId: action!.id, message: "已找到原操作结果并复用，没有重复执行。", allowedControls: [] },
        });
      } else {
        await scenario.validate(ctx); await ctx.assertActive();
        const unknown = (action && ["running", "unknown"].includes(action.status)) || calls.some(call => ["running", "unknown"].includes(call.status));
        const kind = unknown ? "unknown" : action?.status === "prepared" ? "not_started" : "known_failed";
        const recovery: AgentRecovery = { kind, actionId: action?.id, message: unknown ? "尚未找到原操作结果，结果仍未知；不会自动重发。" : "已确认没有成功结果，可以在当前授权范围内明确重试。", allowedControls: unknown ? ["inspect", "adjust", "cancel"] : ["inspect", "retry", "adjust", "cancel"] };
        if (!unknown && action?.status === "prepared" && tool?.confirmation) {
          const confirmation = await tool.confirmation(action.args, ctx);
          await ctx.assertActive();
          if (confirmation) {
            const fingerprint = confirmationFingerprint(ctx.task, action.tool, action.args, confirmation);
            const previous = store.approval(accountId, taskId, action.id);
            if (previous && (previous.status === "invalidated" || previous.status === "rejected" || previous.fingerprint !== fingerprint)) throw new AgentFailure("source_changed", "原确认已经失效，请调整任务后重新提案。");
            if (!previous) store.saveApproval(accountId, taskId, lease.token, { ...confirmation, id: action.id, actionId: action.id, taskVersion: input.expectedVersion,
              tool: action.tool, fingerprint, status: "pending", createdAt: new Date().toISOString() });
            store.recordRecovery(accountId, taskId, lease.token, input);
            const consumed = store.latestEvent(accountId, taskId);
            if (previous?.status === "approved" && consumed?.kind === "approval" && consumed.refId === previous.id &&
              consumed.decision === "approve" && consumed.fingerprint === fingerprint) {
              // Inspection must not wait for an approval already consumed before
              // pause/crash, nor execute it. Explicit continuation uses the same
              // prepared action and revalidates this binding at execution time.
              store.setState(accountId, taskId, lease.token, "ready", { recovery: { kind: "not_started", actionId: action.id,
                message: "原提案已获批准且尚未执行，可以继续原行动，无需再次批准。", allowedControls: ["adjust", "cancel"] } });
              return store.getTask(accountId, taskId);
            }
            store.setState(accountId, taskId, lease.token, "waiting", { wait: { kind: "confirmation", refId: action.id, message: confirmation.title.slice(0, 200) },
              recovery: { kind: "not_started", actionId: action.id, message: "提案尚未执行，已恢复原提案的确认等待。", allowedControls: ["adjust", "cancel"] } });
            return store.getTask(accountId, taskId);
          }
        }
        store.recordRecovery(accountId, taskId, lease.token, input);
        if (input.mode === "retry" && !unknown) {
          if (action && tool?.confirmation) await this.verifyApproval(accountId, taskId, action.id, ctx);
          if (action) store.markAction(accountId, taskId, lease.token, action.id, "prepared");
          store.setState(accountId, taskId, lease.token, "ready", { recovery }); retry = true;
        } else store.setState(accountId, taskId, lease.token, "needs_attention", { endReason: recovery.message, recovery });
      }
    } catch (error) { this.recordFailure(accountId, taskId, lease, error); }
    finally { store.release(accountId, taskId, lease); }
    return retry && !input.defer ? this.advance(accountId, taskId) : store.getTask(accountId, taskId);
  }
  private async validateToolResult(result: AgentToolResult, tool: AgentScenario["tools"][string] | undefined, ctx: AgentContext) {
    await ctx.assertActive();
    if (result.handoff) {
      if (!tool?.validateResult) throw new AgentFailure("forbidden", "交回结果缺少业务后置条件校验。");
      await tool.validateResult(result, ctx);
    } else await this.options.scenario.validate(ctx);
    await ctx.assertActive();
  }
  async advance(accountId: string, taskId: string, event?: AgentEvent) {
    const { store, scenario } = this.options;
    const original = store.getTask(accountId, taskId);
    if (original.scenario !== scenario.id) throw new AgentFailure("forbidden", "任务场景不匹配。");
    if (event) store.assertEventVersion(original.version ?? 1, event);
    const lease = store.claim(accountId, taskId, original.version ?? 1);
    if (!lease) return store.getTask(accountId, taskId);
    const controller = new AbortController();
    this.running.set(taskId, controller);
    let remaining = original.budget.maxComputeMs - original.usage.computeMs;
    if (remaining < 1) remaining = 1;
    const timer = setTimeout(() => controller.abort(), remaining);
    const context = (actionId = "decision", currentEvent = store.latestEvent(accountId, taskId)): AgentContext => ({
      task: store.getTask(accountId, taskId), actionId, event: currentEvent, signal: controller.signal,
      assertActive: async () => {
        store.assertLease(accountId, taskId, lease.token);
        if (controller.signal.aborted || original.usage.computeMs + Date.now() - lease.startedAt >= original.budget.maxComputeMs) throw new AgentFailure("budget", "agent_compute_limit");
      },
      call: async (request, invoke) => {
        await context(actionId).assertActive();
        const callId = store.reserveCall(accountId, taskId, lease.token, actionId, request, Date.now() - lease.startedAt);
        let result: Awaited<ReturnType<typeof invoke>>;
        try {
          result = await invoke({ requestId: callId });
        } catch (error) {
          // A thrown network/parse error is not evidence the provider did nothing.
          const known = error instanceof AgentFailure && ["known_failure", "forbidden", "invalid_action", "budget"].includes(error.code);
          store.finishCall(callId, known ? "failed" : "unknown", error instanceof AgentFailure ? error.usage : undefined,
            error instanceof AgentFailure ? error.decisionDiagnostic : undefined);
          throw error;
        }
        // A complete response remains a known billing fact even when pause,
        // cancellation or the compute deadline prevents publishing its value.
        store.finishCall(callId, "succeeded", result.usage);
        await context(actionId).assertActive();
        return result.value;
      },
    });
    const validate = async (ctx: AgentContext) => { await ctx.assertActive(); await scenario.validate(ctx); await ctx.assertActive(); };
    const route = (state: typeof Execution.State) => state.next === "end" ? END : state.next;
    const graph = new StateGraph(Execution)
      .addNode("decide", async () => {
        let ctx = context();
        await validate(ctx);
        // If the process stopped after saving an action but before the graph's
        // next checkpoint, reuse that prepared decision rather than call again.
        const pending = [...ctx.task.actions].reverse().find(action => (action.version ?? 1) === (ctx.task.version ?? 1) && action.status === "prepared");
        if (pending) return { actionId: pending.id, next: "prepare" as const };
        const step = store.step(accountId, taskId, lease.token);
        const decisionId = `decision:${step}`;
        ctx = context(decisionId);
        const observation = await scenario.observe(ctx);
        const results = [];
        const receipts = ctx.task.actions.filter(action => (action.version ?? 1) === (ctx.task.version ?? 1)).slice(-12);
        // Re-read each current business result once. Historical actions remain
        // visible, but identical successful references point to their latest read.
        const identity = (receipt: typeof receipts[number]) => receipt.status === "succeeded" && receipt.resultRef
          ? JSON.stringify([receipt.tool, receipt.resultRef.kind, receipt.resultRef.id]) : null;
        const latest = new Map<string, string>();
        for (const receipt of receipts) { const key = identity(receipt); if (key) latest.set(key, receipt.id); }
        for (const receipt of receipts) {
          await validate(ctx);
          const key = identity(receipt), newer = key ? latest.get(key) : undefined;
          if (newer && newer !== receipt.id) {
            results.push({ actionId: receipt.id, tool: receipt.tool, status: receipt.status,
              value: { ref: receipt.resultRef, supersededBy: newer, notice: "相同业务结果在后续行动中重新读取；详情仅提供一次。" } });
            continue;
          }
          const tool = scenario.tools[receipt.tool];
          const value = receipt.status === "succeeded" && tool?.readResult
            ? await tool.readResult(receipt, ctx)
            : { status: receipt.status, summary: receipt.summary, ref: receipt.resultRef };
          await validate(ctx);
          results.push({ actionId: receipt.id, tool: receipt.tool, status: receipt.status, value });
        }
        const visibleTask = { ...ctx.task, actions: ctx.task.actions.filter(action => (action.version ?? 1) === (ctx.task.version ?? 1)) };
        const decision = await this.options.decision({ task: visibleTask, observation, results, instructions: scenario.instructions,
          tools: Object.entries(scenario.tools).map(([name, tool]) => ({ name, description: tool.description, parameters: tool.parameters })), event: ctx.event }, ctx);
        if (store.hasUnknownCall(taskId, decisionId)) throw new AgentFailure("unknown", "决策请求结果未知，已停止自动推进。");
        await validate(context(decisionId));
        if ("finish" in decision) {
          const explanation = scenario.finish ? await scenario.finish(decision.finish, context(decisionId)) : "任务已交回。该状态不代表业务目标已验证完成。";
          if (store.hasUnknownCall(taskId, decisionId)) throw new AgentFailure("unknown", "结束整理请求结果未知，已停止自动推进。");
          await validate(context(decisionId));
          store.setState(accountId, taskId, lease.token, "ended", { endReason: explanation.slice(0, 1_000) });
          return { next: "end" as const };
        }
        if ("wait" in decision) {
          if (decision.wait.kind !== "feedback" || decision.wait.refId) throw new AgentFailure("invalid_action", "模型只能请求用户反馈，业务等待必须来自实际工具结果。");
          store.setState(accountId, taskId, lease.token, "waiting", { wait: { kind: "feedback", message: decision.wait.message.slice(0, 400) } });
          return { next: "wait" as const };
        }
        const tool = scenario.tools[decision.tool];
        if (!tool || !Object.hasOwn(scenario.tools, decision.tool)) {
          store.recordDecisionRejection(accountId, taskId, lease.token, decisionId, {
            layer: "tool_selection", reasonCode: "tool_not_registered", tool: decisionToolName(decision.tool, Object.keys(scenario.tools)), issues: [], issuesTruncated: false,
          });
          throw new AgentFailure("invalid_action", "模型选择了未授权工具。");
        }
        const parsed = tool.parameters.safeParse(decision.args);
        if (!parsed.success) {
          store.recordDecisionRejection(accountId, taskId, lease.token, decisionId, {
            layer: "tool_parameters", reasonCode: "tool_arguments_invalid", tool: decisionToolName(decision.tool, Object.keys(scenario.tools)),
            ...decisionSchemaIssues(tool.parameters, parsed.error),
          });
          throw new AgentFailure("invalid_action", "模型工具参数未通过校验。");
        }
        const actionId = store.prepareAction(accountId, taskId, lease.token, { step, tool: decision.tool, args: parsed.data, reason: decision.reason });
        return { actionId, next: "prepare" as const };
      }, { retryPolicy: { maxAttempts: 1 } })
      .addNode("prepare", async (state) => {
        const ctx = context(state.actionId);
        await validate(ctx);
        const action = store.action(accountId, taskId, state.actionId), actionId = action.id;
        const tool = scenario.tools[action.tool];
        if (!tool || (action.version ?? 1) !== (ctx.task.version ?? 1)) throw new AgentFailure("forbidden", "当前行动授权已变化。");
        if (tool.confirmation) {
          let confirmation: AgentConfirmation | null;
          try {
            confirmation = await tool.confirmation(action.args, context(actionId));
          } catch (error) {
            if (!(error instanceof AgentFailure) || error.code !== "known_failure") throw error;
            if (store.hasUnknownCall(taskId, actionId)) throw new AgentFailure("unknown", "提案准备中的请求结果未知，已停止自动推进。");
            await validate(context(actionId));
            // An invalid address/content can fail before there is anything to
            // approve. Feed that definite failure back through the same bounded
            // decision loop; never turn it into authorization to execute a write.
            store.markAction(accountId, taskId, lease.token, actionId, "failed", { summary: error.publicSummary ?? "提案准备明确失败，未取得可批准的操作。" });
            store.setState(accountId, taskId, lease.token, "running");
            return { actionId, next: "decide" as const };
          }
          await validate(context(actionId));
          if (confirmation) {
            if (confirmation.content.length > 16_000 || confirmation.sourceFingerprint.length > 500) throw new AgentFailure("invalid_action", "确认提案超出内容上限。");
            const approval: AgentApproval = { ...confirmation, id: actionId, actionId, taskVersion: ctx.task.version ?? 1, tool: action.tool,
              fingerprint: confirmationFingerprint(ctx.task, action.tool, action.args, confirmation), status: "pending", createdAt: new Date().toISOString() };
            store.saveApproval(accountId, taskId, lease.token, approval);
            store.setState(accountId, taskId, lease.token, "waiting", { wait: { kind: "confirmation", refId: actionId, message: confirmation.title.slice(0, 200) } });
            return { actionId, next: "confirm" as const };
          }
        }
        return { actionId, next: "execute" as const };
      }, { retryPolicy: { maxAttempts: 1 } })
      .addNode("execute", async (state) => {
        const ctx = context(state.actionId);
        await validate(ctx);
        const action = store.action(accountId, taskId, state.actionId);
        if ((action.version ?? 1) !== (ctx.task.version ?? 1)) throw new AgentFailure("conflict", "旧版本行动不能继续执行。");
        const tool = scenario.tools[action.tool];
        if (!tool) throw new AgentFailure("forbidden", "工具授权已失效。");
        if (action.status === "succeeded") {
          if (action.handoff) { store.setState(accountId, taskId, lease.token, "ended", { endReason: action.handoff }); return { next: "end" as const }; }
          if (action.wait) store.setState(accountId, taskId, lease.token, "waiting", { wait: action.wait });
          return { next: action.wait ? "wait" as const : "decide" as const };
        }
        let result: AgentToolResult | null = null;
        if (action.status === "running" || action.status === "unknown") {
          result = await tool.recover?.(state.actionId, ctx) ?? null;
          if (!result) throw new AgentFailure("unknown", "上次工具结果尚未确认；不会自动重复执行。");
          store.reconcileCalls(taskId, state.actionId);
        } else {
          if (tool.confirmation) {
            if (store.approval(accountId, taskId, state.actionId)) await this.verifyApproval(accountId, taskId, state.actionId, context(state.actionId));
            else if (await tool.confirmation(action.args, context(state.actionId))) throw new AgentFailure("conflict", "该行动现在需要用户确认。");
          }
          store.markAction(accountId, taskId, lease.token, state.actionId, "running");
          try {
            result = await tool.execute(action.args, ctx);
            if (store.hasUnknownCall(taskId, state.actionId)) throw new AgentFailure("unknown", "工具内生成请求结果未知，已停止自动推进。");
          } catch (error) {
            // Service layers may catch provider failures; persisted call facts still win.
            const unknown = store.hasUnknownCall(taskId, state.actionId) || !(error instanceof AgentFailure) || error.code === "unknown";
            if (unknown) {
              await context(state.actionId).assertActive();
              const recovered = await tool.recover?.(state.actionId, context(state.actionId));
              if (recovered) {
                await this.validateToolResult(recovered, tool, context(state.actionId));
                store.reconcileCalls(taskId, state.actionId);
                store.markAction(accountId, taskId, lease.token, state.actionId, "succeeded", recovered);
                if (recovered.handoff) store.setState(accountId, taskId, lease.token, "ended", { endReason: recovered.handoff });
                else if (recovered.wait) store.setState(accountId, taskId, lease.token, "waiting", { wait: recovered.wait });
                return { next: recovered.handoff ? "end" as const : recovered.wait ? "wait" as const : "decide" as const };
              }
              store.markAction(accountId, taskId, lease.token, state.actionId, "unknown", { summary: "工具结果未知；请检查原操作，系统不会自动重发。" });
              throw new AgentFailure("unknown", "工具结果未知，已停止自动推进。");
            }
            store.markAction(accountId, taskId, lease.token, state.actionId, "failed", { summary: error instanceof AgentFailure && error.code === "known_failure" ? error.publicSummary ?? "工具明确失败，未取得业务结果。" : "工具未通过执行检查。" });
            if (error instanceof AgentFailure && error.code === "known_failure") {
              store.setState(accountId, taskId, lease.token, "running");
              return { next: "decide" as const };
            }
            throw error;
          }
        }
        await this.validateToolResult(result, tool, context(state.actionId));
        store.markAction(accountId, taskId, lease.token, state.actionId, "succeeded", result);
        if (result.handoff) store.setState(accountId, taskId, lease.token, "ended", { endReason: result.handoff });
        else if (result.wait) store.setState(accountId, taskId, lease.token, "waiting", { wait: result.wait });
        else store.setState(accountId, taskId, lease.token, "running");
        return { next: result.handoff ? "end" as const : result.wait ? "wait" as const : "decide" as const };
      }, { retryPolicy: { maxAttempts: 1 } })
      .addNode("confirm", async (state) => {
        const eventId = interrupt<{ taskId: string; actionId: string }, string>({ taskId, actionId: state.actionId });
        const accepted = store.getEvent(accountId, taskId, eventId);
        if (!accepted || accepted.kind !== "approval" || accepted.refId !== state.actionId) throw new AgentFailure("forbidden", "缺少当前提案的确认事件。");
        const ctx = context(state.actionId, accepted);
        await validate(ctx);
        const approval = store.approval(accountId, taskId, state.actionId);
        if (!approval || !["approved", "rejected"].includes(approval.status) || approval.fingerprint !== accepted.fingerprint) throw new AgentFailure("conflict", "确认已经失效。");
        store.continueEvent(accountId, taskId, lease.token, eventId);
        if (approval.status === "rejected") {
          return { next: "decide" as const };
        }
        await this.verifyApproval(accountId, taskId, state.actionId, context(state.actionId));
        return { next: "execute" as const };
      }, { retryPolicy: { maxAttempts: 1 } })
      .addNode("wait", async () => {
        // This node has no effects before interrupt: SDK replay cannot repeat a write.
        const eventId = interrupt<{ taskId: string }, string>({ taskId });
        const accepted = store.getEvent(accountId, taskId, eventId);
        if (!accepted) throw new AgentFailure("forbidden", "恢复事件尚未通过认证。");
        const ctx = context("resume", accepted);
        await validate(ctx);
        await scenario.validateEvent?.(accepted, ctx);
        await validate(ctx);
        store.continueEvent(accountId, taskId, lease.token, eventId);
        return { next: "decide" as const };
      }, { retryPolicy: { maxAttempts: 1 } })
      .addEdge(START, "decide")
      .addConditionalEdges("decide", route, ["prepare", "execute", "wait", "confirm", "decide", END])
      .addConditionalEdges("prepare", route, ["execute", "confirm", "decide", END])
      .addConditionalEdges("execute", route, ["execute", "wait", "confirm", "decide", END])
      .addConditionalEdges("confirm", route, ["execute", "decide", END])
      .addEdge("wait", "decide")
      .compile({ checkpointer: this.checkpointer });
    try {
      disableAgentCloudTracing();
      await validate(context());
      const version = original.version ?? 1;
      const config = { configurable: { thread_id: version === 1 ? taskId : `${taskId}:v${version}` }, callbacks: [], recursionLimit: original.budget.maxSteps * 4 + 5, durability: "sync" as const, signal: controller.signal };
      if (original.status === "ready" && original.approval) {
        const approval = original.approval;
        const consumed = store.latestEvent(accountId, taskId);
        const action = store.action(accountId, taskId, approval.actionId);
        if (consumed?.kind === "approval" && consumed.refId === approval.id && consumed.fingerprint === approval.fingerprint &&
          ((approval.status === "approved" && action.status === "prepared") || (approval.status === "rejected" && action.status === "failed"))) {
          // Pause can fence the confirm node after its durable event transition
          // but before its checkpoint. Continue that exact decision; approved
          // execution still rechecks the proposal and never replays unknown work.
          await graph.updateState(config, { taskId, actionId: action.id, next: approval.status === "approved" ? "execute" : "decide" }, "confirm");
        }
      }
      if (original.status === "ready" && original.recovery?.actionId && ["not_started", "known_failed"].includes(original.recovery.kind)) {
        const retry = store.action(accountId, taskId, original.recovery.actionId);
        if (retry.status === "prepared" && (retry.version ?? 1) === version) {
          await validate(context(retry.id));
          // Explicit retry resumes the same saved action even when the model
          // subsequently waited. LangGraph remains execution-position authority.
          await graph.updateState(config, { taskId, actionId: retry.id, next: "execute" }, "prepare");
        }
      }
      if (original.status === "ready" && original.recovery?.kind === "feedback_received") {
        // New authenticated feedback supersedes the old wait/prepared action.
        // Unknown operations cannot reach ready through the resume control.
        await graph.updateState(config, { taskId, actionId: "", next: "decide" }, "wait");
      }
      const snapshot = await graph.getState(config);
      if (original.status === "waiting") {
        event ??= store.pendingEvent(accountId, taskId);
        if (!event) return store.getTask(accountId, taskId);
        const previous = store.acceptedEvent(accountId, taskId, event);
        if (previous?.consumed) return store.getTask(accountId, taskId);
        if (previous) event = previous.event;
        if (original.wait?.refId && event.refId !== original.wait.refId) throw new AgentFailure("invalid_action", "反馈与当前等待的业务记录不匹配。");
        if (original.wait?.kind === "confirmation") {
          if (event.kind !== "approval" || !store.approval(accountId, taskId, event.refId ?? "") || !previous) throw new AgentFailure("forbidden", "提案必须通过明确确认入口接收。");
        } else await scenario.validateEvent?.(event, context("resume", event));
        await validate(context());
        if (!previous) store.acceptEvent(accountId, taskId, lease.token, event);
        store.setState(accountId, taskId, lease.token, "running", { wait: original.wait });
        // A crash after persisting a tool receipt but before interrupt checkpoint is
        // safely replayed through the receipt, then resumed on a later request.
        if (!snapshot.tasks.some((task) => task.interrupts?.length)) {
          await graph.invoke(snapshot.next.length ? null : { taskId, actionId: "", next: "decide" }, config);
        }
        await graph.invoke(new Command({ resume: event.id }), config);
      } else {
        if (event) throw new AgentFailure("invalid_action", "任务当前不在等待反馈。");
        // Explicit recovery authorization must reach the saved business action.
        // Its success/failure transition consumes this marker before another decision.
        store.setState(accountId, taskId, lease.token, "running", { recovery: original.recovery });
        await graph.invoke(snapshot.next.length ? null : { taskId, actionId: "", next: "decide" }, config);
      }
    } catch (error) {
      this.recordFailure(accountId, taskId, lease, error);
    } finally {
      clearTimeout(timer);
      if (this.running.get(taskId) === controller) this.running.delete(taskId);
      store.release(accountId, taskId, lease);
    }
    return store.getTask(accountId, taskId);
  }
  private recordFailure(accountId: string, taskId: string, lease: AgentLease, error: unknown) {
    const { store } = this.options;
    try {
      store.assertLease(accountId, taskId, lease.token);
      const failure = error instanceof AgentFailure ? error : new AgentFailure("unknown", "执行结果未确认，已停止自动推进。");
      const current = store.getTask(accountId, taskId);
      const action = [...current.actions].reverse().find(item => (item.version ?? 1) === (current.version ?? 1));
      const invalidSource = ["source_changed", "forbidden"].includes(failure.code);
      if (invalidSource) store.invalidateApprovals(taskId);
      const recovery: AgentRecovery = invalidSource
        ? { kind: "source_invalid", message: "授权来源无效，请重新选择范围；旧提案不能继续执行。", actionId: action?.id, allowedControls: ["adjust", "cancel"] }
        : failure.code === "conflict" ? { kind: "version_changed", message: "版本或确认内容已变化，请刷新后重新确认。", actionId: action?.id, allowedControls: ["adjust", "cancel"] }
        : failure.code === "known_failure" || failure.code === "invalid_action" ? { kind: action?.status === "prepared" ? "not_started" : "known_failed", message: "本次行动未完成，可以检查原结果后明确重试。", actionId: action?.id, allowedControls: ["inspect", "retry", "adjust", "cancel"] }
        : { kind: "unknown", message: "结果尚未确认，请先检查原操作结果；不会自动重发。", actionId: action?.id, allowedControls: ["inspect", "adjust", "cancel"] };
      store.setState(accountId, taskId, lease.token, failure.code === "budget" ? "budget_exhausted" : "needs_attention", {
        recovery,
        endReason: failure.code === "source_changed" ? "授权来源已变化或不可用，请重新选择范围后开始任务。"
          : failure.code === "forbidden" ? "当前任务或来源已无访问权限。"
          : failure.code === "invalid_action" ? "行动或反馈未通过受限协议检查，已交回用户。"
          : failure.code === "budget" ? agentBudgetEndReason(failure.message)
          : "执行结果未确认，已停止自动推进；系统不会自动重发外部请求。",
      });
    } catch { /* pause/cancel fenced this invocation; never publish a late result */ }
  }
}
