import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { AgentEvent } from "@/lib/domain/agent";
import { AgentStore, type AgentLease } from "./store";
import { AgentFailure, type AgentContext, type AgentDecisionProvider, type AgentScenario, type AgentToolResult } from "./types";

// LangGraph owns routing, durable execution position and interrupt/resume. These
// are references only: source text, tool bodies and model messages never enter it.
const Execution = Annotation.Root({
  taskId: Annotation<string>(),
  actionId: Annotation<string>(),
  next: Annotation<"execute" | "wait" | "decide" | "end">(),
});

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
  control(accountId: string, taskId: string, operation: "pause" | "resume" | "cancel") {
    const task = this.options.store.control(accountId, taskId, operation);
    if (operation !== "resume") this.running.get(taskId)?.abort();
    return task;
  }
  async advance(accountId: string, taskId: string, event?: AgentEvent) {
    const { store, scenario } = this.options;
    const original = store.getTask(accountId, taskId);
    if (original.scenario !== scenario.id) throw new AgentFailure("forbidden", "任务场景不匹配。");
    const lease = store.claim(accountId, taskId);
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
        if (controller.signal.aborted || original.usage.computeMs + Date.now() - lease.startedAt >= original.budget.maxComputeMs) throw new AgentFailure("budget", "本次计算时间预算耗尽。");
      },
      call: async (request, invoke) => {
        await context(actionId).assertActive();
        const callId = store.reserveCall(accountId, taskId, lease.token, actionId, request, Date.now() - lease.startedAt);
        let result: Awaited<ReturnType<typeof invoke>>;
        try {
          result = await invoke();
        } catch (error) {
          // A thrown network/parse error is not evidence the provider did nothing.
          const known = error instanceof AgentFailure && ["known_failure", "forbidden", "invalid_action", "budget"].includes(error.code);
          store.finishCall(callId, known ? "failed" : "unknown");
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
        const step = store.step(accountId, taskId, lease.token);
        const decisionId = `decision:${step}`;
        ctx = context(decisionId);
        const observation = await scenario.observe(ctx);
        const results = [];
        for (const receipt of ctx.task.actions.slice(-12)) {
          await validate(ctx);
          const tool = scenario.tools[receipt.tool];
          const value = receipt.status === "succeeded" && tool?.readResult
            ? await tool.readResult(receipt, ctx)
            : { status: receipt.status, summary: receipt.summary, ref: receipt.resultRef };
          await validate(ctx);
          results.push({ actionId: receipt.id, tool: receipt.tool, status: receipt.status, value });
        }
        const decision = await this.options.decision({ task: ctx.task, observation, results, instructions: scenario.instructions,
          tools: Object.entries(scenario.tools).map(([name, tool]) => ({ name, description: tool.description, parameters: tool.parameters })), event: ctx.event }, ctx);
        if (store.hasUnknownCall(taskId, decisionId)) throw new AgentFailure("unknown", "决策请求结果未知，已停止自动推进。");
        await validate(context(decisionId));
        if ("finish" in decision) {
          const explanation = scenario.finish ? await scenario.finish(decision.finish, context(decisionId)) : "任务已交回。该状态不代表业务目标已验证完成。";
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
        if (!tool || !Object.hasOwn(scenario.tools, decision.tool)) throw new AgentFailure("invalid_action", "模型选择了未授权工具。");
        const parsed = tool.parameters.safeParse(decision.args);
        if (!parsed.success) throw new AgentFailure("invalid_action", "模型工具参数未通过校验。");
        const actionId = store.prepareAction(accountId, taskId, lease.token, { step, tool: decision.tool, args: parsed.data, reason: decision.reason });
        return { actionId, next: "execute" as const };
      }, { retryPolicy: { maxAttempts: 1 } })
      .addNode("execute", async (state) => {
        const ctx = context(state.actionId);
        await validate(ctx);
        const action = store.action(accountId, taskId, state.actionId);
        const tool = scenario.tools[action.tool];
        if (!tool) throw new AgentFailure("forbidden", "工具授权已失效。");
        if (action.status === "succeeded") {
          if (action.wait) store.setState(accountId, taskId, lease.token, "waiting", { wait: action.wait });
          return { next: action.wait ? "wait" as const : "decide" as const };
        }
        let result: AgentToolResult | null = null;
        if (action.status === "running" || action.status === "unknown") {
          result = await tool.recover?.(state.actionId, ctx) ?? null;
          if (!result) throw new AgentFailure("unknown", "上次工具结果尚未确认；不会自动重复执行。");
          store.reconcileCalls(taskId, state.actionId);
        } else {
          store.markAction(accountId, taskId, lease.token, state.actionId, "running");
          try {
            result = await tool.execute(action.args, ctx);
            if (store.hasUnknownCall(taskId, state.actionId)) throw new AgentFailure("unknown", "工具内生成请求结果未知，已停止自动推进。");
          } catch (error) {
            // Service layers may catch provider failures; persisted call facts still win.
            const unknown = store.hasUnknownCall(taskId, state.actionId) || !(error instanceof AgentFailure) || error.code === "unknown";
            if (unknown) {
              await validate(context(state.actionId));
              const recovered = await tool.recover?.(state.actionId, context(state.actionId));
              if (recovered) {
                await validate(context(state.actionId));
                store.reconcileCalls(taskId, state.actionId);
                store.markAction(accountId, taskId, lease.token, state.actionId, "succeeded", recovered);
                if (recovered.wait) store.setState(accountId, taskId, lease.token, "waiting", { wait: recovered.wait });
                return { next: recovered.wait ? "wait" as const : "decide" as const };
              }
              store.markAction(accountId, taskId, lease.token, state.actionId, "unknown", { summary: "工具结果未知；请检查原操作，系统不会自动重发。" });
              throw new AgentFailure("unknown", "工具结果未知，已停止自动推进。");
            }
            store.markAction(accountId, taskId, lease.token, state.actionId, "failed", { summary: error instanceof AgentFailure && error.code === "known_failure" ? "工具明确失败，未取得业务结果。" : "工具未通过执行检查。" });
            if (error instanceof AgentFailure && error.code === "known_failure") return { next: "decide" as const };
            throw error;
          }
        }
        await validate(context(state.actionId));
        store.markAction(accountId, taskId, lease.token, state.actionId, "succeeded", result);
        if (result.wait) store.setState(accountId, taskId, lease.token, "waiting", { wait: result.wait });
        return { next: result.wait ? "wait" as const : "decide" as const };
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
        store.consumeEvent(taskId, eventId);
        store.setState(accountId, taskId, lease.token, "running");
        return { next: "decide" as const };
      }, { retryPolicy: { maxAttempts: 1 } })
      .addEdge(START, "decide")
      .addConditionalEdges("decide", route, ["execute", "wait", "decide", END])
      .addConditionalEdges("execute", route, ["execute", "wait", "decide", END])
      .addEdge("wait", "decide")
      .compile({ checkpointer: this.checkpointer });
    try {
      disableAgentCloudTracing();
      await validate(context());
      const config = { configurable: { thread_id: taskId }, callbacks: [], recursionLimit: original.budget.maxSteps * 3 + 5, durability: "sync" as const, signal: controller.signal };
      const snapshot = await graph.getState(config);
      if (original.status === "waiting") {
        if (!event) return store.getTask(accountId, taskId);
        const previous = store.acceptedEvent(accountId, taskId, event);
        if (previous?.consumed) return store.getTask(accountId, taskId);
        if (previous) event = previous.event;
        if (original.wait?.refId && event.refId !== original.wait.refId) throw new AgentFailure("invalid_action", "反馈与当前等待的业务记录不匹配。");
        await scenario.validateEvent?.(event, context("resume", event));
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
        store.setState(accountId, taskId, lease.token, "running");
        await graph.invoke(snapshot.next.length ? null : { taskId, actionId: "", next: "decide" }, config);
      }
    } catch (error) {
      this.recordFailure(accountId, taskId, lease, error);
    } finally {
      clearTimeout(timer);
      this.running.delete(taskId);
      store.release(accountId, taskId, lease);
    }
    return store.getTask(accountId, taskId);
  }
  private recordFailure(accountId: string, taskId: string, lease: AgentLease, error: unknown) {
    const { store } = this.options;
    try {
      store.assertLease(accountId, taskId, lease.token);
      const failure = error instanceof AgentFailure ? error : new AgentFailure("unknown", "执行结果未确认，已停止自动推进。");
      store.setState(accountId, taskId, lease.token, failure.code === "budget" ? "budget_exhausted" : "needs_attention", {
        endReason: failure.code === "source_changed" ? "授权来源已变化或不可用，请重新选择范围后开始任务。"
          : failure.code === "forbidden" ? "当前任务或来源已无访问权限。"
          : failure.code === "invalid_action" ? "行动或反馈未通过受限协议检查，已交回用户。"
          : failure.code === "budget" ? "本任务预算耗尽，已停止；等待用户的时间不计入计算预算。"
          : "执行结果未确认，已停止自动推进；系统不会自动重发外部请求。",
      });
    } catch { /* pause/cancel fenced this invocation; never publish a late result */ }
  }
}
