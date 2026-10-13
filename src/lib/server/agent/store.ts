import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentAction, AgentBudget, AgentEvent, AgentTask, AgentTaskStatus, AgentWait } from "@/lib/domain/agent";
import { AgentFailure, type AgentCallRequest, type AgentCallUsage, type AgentToolResult } from "./types";

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxCalls: 16, maxInputChars: 48_000, maxOutputTokens: 8_000,
  maxComputeMs: 10 * 60_000, maxSteps: 16, maxNoProgress: 3,
};
type TaskRow = {
  id: string; account_id: string; scenario: string; resource_id: string; goal: string; scope_json: string;
  status: AgentTaskStatus; wait_json: string | null; end_reason: string | null; budget_json: string;
  compute_ms: number; steps: number; lease: string | null; lease_until: number; lease_started_at: number; created_at: string; updated_at: string;
};
type ActionRow = {
  id: string; task_id: string; step: number; tool: string; args_json: string; status: AgentAction["status"];
  ref_json: string | null; wait_json: string | null; summary: string; reason: string | null; created_at: string;
};
export interface AgentLease { token: string; startedAt: number }
function now() { return new Date().toISOString(); }
function actionDto(row: ActionRow): AgentAction {
  return { id: row.id, tool: row.tool, status: row.status, resultRef: row.ref_json ? JSON.parse(row.ref_json) : undefined,
    summary: row.summary, reason: row.reason ?? undefined, createdAt: row.created_at };
}

/** Business lifecycle/authorization/receipts authority. SDK stores only execution references. */
export class AgentStore {
  constructor(public readonly database: Database.Database) {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scenario TEXT NOT NULL, resource_id TEXT NOT NULL,
        goal TEXT NOT NULL, scope_json TEXT NOT NULL, status TEXT NOT NULL, wait_json TEXT, end_reason TEXT,
        budget_json TEXT NOT NULL, compute_ms INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0,
        lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, lease_started_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_task_account ON agent_tasks(account_id, resource_id, created_at);
      CREATE TABLE IF NOT EXISTS agent_actions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id), step INTEGER NOT NULL,
        tool TEXT NOT NULL, args_json TEXT NOT NULL, status TEXT NOT NULL,
        ref_json TEXT, wait_json TEXT, summary TEXT NOT NULL DEFAULT '', reason TEXT, created_at TEXT NOT NULL,
        UNIQUE(task_id, step)
      );
      CREATE TABLE IF NOT EXISTS agent_calls (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id), action_id TEXT NOT NULL,
        kind TEXT NOT NULL, model TEXT, input_chars INTEGER NOT NULL, output_limit INTEGER NOT NULL,
        status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_events (
        task_id TEXT NOT NULL REFERENCES agent_tasks(id), id TEXT NOT NULL,
        event_json TEXT NOT NULL, event_kind TEXT NOT NULL, ref_id TEXT, consumed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        PRIMARY KEY(task_id,id)
      );
    `);
    const taskColumns = database.prepare("PRAGMA table_info(agent_tasks)").all() as { name: string }[];
    if (!taskColumns.some((column) => column.name === "lease_started_at")) database.exec("ALTER TABLE agent_tasks ADD COLUMN lease_started_at INTEGER NOT NULL DEFAULT 0");
    const eventColumns = database.prepare("PRAGMA table_info(agent_events)").all() as { name: string }[];
    if (!eventColumns.some((column) => column.name === "event_kind")) database.exec("ALTER TABLE agent_events ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'legacy'");
    if (!eventColumns.some((column) => column.name === "ref_id")) database.exec("ALTER TABLE agent_events ADD COLUMN ref_id TEXT");
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_event_business_identity ON agent_events(task_id,event_kind,ref_id) WHERE ref_id IS NOT NULL");
  }
  static open(filePath: string) {
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    const db = new Database(filePath);
    if (filePath !== ":memory:") db.pragma("journal_mode = WAL");
    return new AgentStore(db);
  }
  close() { this.database.close(); }
  private row(accountId: string, taskId: string): TaskRow {
    const row = this.database.prepare("SELECT * FROM agent_tasks WHERE id = ? AND account_id = ?").get(taskId, accountId) as TaskRow | undefined;
    if (!row) throw new AgentFailure("forbidden", "任务不存在或无权访问。");
    return row;
  }
  createTask(input: { id?: string; accountId: string; scenario: string; resourceId: string; goal: string; scope: unknown; budget?: Partial<AgentBudget> }): AgentTask {
    const budget = { ...DEFAULT_AGENT_BUDGET, ...input.budget };
    for (const value of Object.values(budget)) if (!Number.isSafeInteger(value) || value <= 0) throw new AgentFailure("invalid_action", "预算必须为正整数。");
    if (!input.goal.trim() || input.goal.length > 2_000) throw new AgentFailure("invalid_action", "任务目标长度无效。");
    const id = input.id ?? randomUUID(), time = now();
    if (!/^[a-zA-Z0-9-]{12,100}$/.test(id)) throw new AgentFailure("invalid_action", "任务标识格式无效。");
    return this.database.transaction(() => {
    const existing = this.database.prepare("SELECT * FROM agent_tasks WHERE id=?").get(id) as TaskRow | undefined;
    if (existing) {
      if (existing.account_id !== input.accountId) throw new AgentFailure("forbidden", "任务标识不可用。");
      if (existing.scenario !== input.scenario || existing.resource_id !== input.resourceId || existing.goal !== input.goal.trim()
        || existing.scope_json !== JSON.stringify(input.scope)) throw new AgentFailure("invalid_action", "相同任务标识的目标或范围不一致。");
      return this.getTask(input.accountId, id);
    }
    this.database.prepare(`INSERT INTO agent_tasks
      (id,account_id,scenario,resource_id,goal,scope_json,status,budget_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'ready',?,?,?)`).run(id, input.accountId, input.scenario, input.resourceId, input.goal.trim(), JSON.stringify(input.scope), JSON.stringify(budget), time, time);
    return this.getTask(input.accountId, id);
    }).immediate();
  }
  getTask(accountId: string, taskId: string): AgentTask {
    const row = this.row(accountId, taskId);
    const actions = (this.database.prepare("SELECT * FROM agent_actions WHERE task_id = ? ORDER BY step").all(taskId) as ActionRow[]).map(actionDto);
    const usage = this.database.prepare(`SELECT COUNT(*) AS calls,
      SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_calls,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM agent_calls WHERE task_id = ?`).get(taskId) as { calls: number; unknown_calls: number | null; input_tokens: number | null; output_tokens: number | null };
    return { id: row.id, accountId: row.account_id, scenario: row.scenario, resourceId: row.resource_id, goal: row.goal,
      scope: JSON.parse(row.scope_json), status: row.status, wait: row.wait_json ? JSON.parse(row.wait_json) : undefined,
      endReason: row.end_reason ?? undefined, currentAction: [...actions].reverse().find((a) => a.status === "running")?.tool,
      actions, budget: JSON.parse(row.budget_json), usage: { calls: usage.calls, inputTokens: usage.unknown_calls ? null : usage.input_tokens,
        outputTokens: usage.unknown_calls ? null : usage.output_tokens, unknownUsageCalls: usage.unknown_calls ?? 0, computeMs: row.compute_ms, steps: row.steps },
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  listTasks(accountId: string, resourceId?: string) {
    const rows = (resourceId
      ? this.database.prepare("SELECT id FROM agent_tasks WHERE account_id=? AND resource_id=? ORDER BY created_at DESC LIMIT 50").all(accountId, resourceId)
      : this.database.prepare("SELECT id FROM agent_tasks WHERE account_id=? ORDER BY created_at DESC LIMIT 50").all(accountId)) as { id: string }[];
    return rows.map(({ id }) => this.getTask(accountId, id));
  }
  claim(accountId: string, taskId: string): AgentLease | null {
    return this.database.transaction(() => {
      const row = this.row(accountId, taskId);
      if (["paused", "cancelled", "ended", "budget_exhausted", "needs_attention"].includes(row.status)) return null;
      if (row.lease && row.lease_until > Date.now()) return null;
      if (row.status === "running" && row.lease) {
        // A crashed external request may have succeeded. Explicit reconciliation is required.
        this.database.prepare("UPDATE agent_tasks SET status='needs_attention', lease=NULL, end_reason=?, updated_at=? WHERE id=?")
          .run("运行进程中断，外部结果可能未知；请检查已有业务结果后新建任务，系统不会自动重发。", now(), taskId);
        return null;
      }
      const token = randomUUID(), startedAt = Date.now();
      const budget = JSON.parse(row.budget_json) as AgentBudget;
      this.database.prepare("UPDATE agent_tasks SET lease=?, lease_until=?, lease_started_at=?, updated_at=? WHERE id=?")
        .run(token, startedAt + budget.maxComputeMs + 30_000, startedAt, now(), taskId);
      return { token, startedAt };
    }).immediate();
  }
  assertLease(accountId: string, taskId: string, token: string) {
    const row = this.row(accountId, taskId);
    if (row.lease !== token || ["paused", "cancelled", "ended", "budget_exhausted", "needs_attention"].includes(row.status)) throw new AgentFailure("inactive", "任务已暂停、取消或不再允许推进。");
    return this.getTask(accountId, taskId);
  }
  setState(accountId: string, taskId: string, token: string, status: AgentTaskStatus, extra: { wait?: AgentWait; endReason?: string } = {}) {
    return this.database.transaction(() => {
    this.assertLease(accountId, taskId, token);
    this.database.prepare("UPDATE agent_tasks SET status=?,wait_json=?,end_reason=?,updated_at=? WHERE id=? AND lease=?")
      .run(status, extra.wait ? JSON.stringify(extra.wait) : null, extra.endReason ?? null, now(), taskId, token);
    }).immediate();
  }
  release(accountId: string, taskId: string, lease: AgentLease) {
    this.row(accountId, taskId);
    this.database.prepare("UPDATE agent_tasks SET compute_ms=compute_ms+?,lease=NULL,lease_until=0,lease_started_at=0,updated_at=? WHERE id=? AND lease=?")
      .run(Math.max(0, Date.now() - lease.startedAt), now(), taskId, lease.token);
  }
  control(accountId: string, taskId: string, operation: "pause" | "resume" | "cancel") {
    return this.database.transaction(() => {
    const row = this.row(accountId, taskId);
    if (["cancelled", "ended", "budget_exhausted", "needs_attention"].includes(row.status)) return this.getTask(accountId, taskId);
    if (operation === "resume" && row.status !== "paused") return this.getTask(accountId, taskId);
    let status: AgentTaskStatus = row.status;
    let reason: string | null = row.end_reason;
    if (operation === "cancel") { status = "cancelled"; reason = "用户取消；已完成的业务记录保留。"; }
    if (operation === "pause") status = "paused";
    if (operation === "resume" && row.status === "paused") {
      const active = this.database.prepare("SELECT id FROM agent_calls WHERE task_id=? AND status IN ('running','unknown') LIMIT 1").get(taskId);
      const action = this.database.prepare("SELECT id FROM agent_actions WHERE task_id=? AND status IN ('running','unknown') LIMIT 1").get(taskId);
      if (active || action) { status = "needs_attention"; reason = "暂停前的动作结果未确认；请检查已有业务结果，系统不会自动重发。"; }
      else status = row.wait_json ? "waiting" : "ready";
    }
    const elapsed = row.lease && row.lease_started_at ? Math.max(0, Date.now() - row.lease_started_at) : 0;
    this.database.prepare("UPDATE agent_tasks SET status=?,end_reason=?,compute_ms=compute_ms+?,lease=NULL,lease_until=0,lease_started_at=0,updated_at=? WHERE id=?")
      .run(status, reason, elapsed, now(), taskId);
    return this.getTask(accountId, taskId);
    }).immediate();
  }
  step(accountId: string, taskId: string, token: string) {
    return this.database.transaction(() => {
    const task = this.assertLease(accountId, taskId, token);
    if (task.usage.steps >= task.budget.maxSteps) throw new AgentFailure("budget", "已达到本任务决策步数上限。");
    this.database.prepare("UPDATE agent_tasks SET steps=steps+1 WHERE id=?").run(taskId);
    return task.usage.steps + 1;
    }).immediate();
  }
  prepareAction(accountId: string, taskId: string, token: string, input: { step: number; tool: string; args: unknown; reason?: string }) {
    return this.database.transaction(() => {
    const task = this.assertLease(accountId, taskId, token);
    const args = JSON.stringify(input.args);
    if (args.length > 8_000) throw new AgentFailure("invalid_action", "工具参数超出上限。");
    const previous = this.database.prepare("SELECT tool,args_json,ref_json FROM agent_actions WHERE task_id=? ORDER BY step DESC LIMIT ?").all(taskId, task.budget.maxNoProgress) as { tool: string; args_json: string; ref_json: string | null }[];
    if (previous.length >= task.budget.maxNoProgress && previous.every((p) => p.tool === input.tool && p.args_json === args && p.ref_json === previous[0].ref_json)) throw new AgentFailure("budget", "连续重复相同行动且未取得进展，已停止。");
    const id = `${taskId}:${input.step}`;
    this.database.prepare("INSERT INTO agent_actions(id,task_id,step,tool,args_json,status,reason,created_at) VALUES(?,?,?,?,?,'prepared',?,?)")
      .run(id, taskId, input.step, input.tool, args, input.reason?.slice(0, 240) ?? null, now());
    return id;
    }).immediate();
  }
  action(accountId: string, taskId: string, actionId: string) {
    this.row(accountId, taskId);
    const row = this.database.prepare("SELECT * FROM agent_actions WHERE task_id=? AND id=?").get(taskId, actionId) as ActionRow | undefined;
    if (!row) throw new AgentFailure("invalid_action", "行动记录不存在。");
    return { ...actionDto(row), args: JSON.parse(row.args_json) as unknown, wait: row.wait_json ? JSON.parse(row.wait_json) as AgentWait : undefined };
  }
  markAction(accountId: string, taskId: string, token: string, actionId: string, status: AgentAction["status"], result?: AgentToolResult) {
    return this.database.transaction(() => {
    this.assertLease(accountId, taskId, token);
    this.database.prepare("UPDATE agent_actions SET status=?,ref_json=?,wait_json=?,summary=? WHERE id=? AND task_id=?")
      .run(status, result?.ref ? JSON.stringify(result.ref) : null, result?.wait ? JSON.stringify(result.wait) : null,
        result?.summary.slice(0, 400) ?? "", actionId, taskId);
    }).immediate();
  }
  reserveCall(accountId: string, taskId: string, token: string, actionId: string, request: AgentCallRequest, elapsedMs: number) {
    return this.database.transaction(() => {
      const task = this.assertLease(accountId, taskId, token);
      if (!Number.isSafeInteger(request.inputChars) || request.inputChars < 0 || request.inputChars > task.budget.maxInputChars
        || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > task.budget.maxOutputTokens
        || task.usage.calls >= task.budget.maxCalls || task.usage.computeMs + elapsedMs >= task.budget.maxComputeMs) throw new AgentFailure("budget", "已达到任务调用、输入、输出或运行时间预算。");
      const id = randomUUID();
      this.database.prepare("INSERT INTO agent_calls(id,task_id,action_id,kind,model,input_chars,output_limit,status,created_at) VALUES(?,?,?,?,?,?,?,'running',?)")
        .run(id, taskId, actionId, request.kind.slice(0, 80), request.model?.slice(0, 120) ?? null, request.inputChars, request.maxOutputTokens, now());
      return id;
    }).immediate();
  }
  finishCall(id: string, status: "succeeded" | "failed" | "unknown", usage?: AgentCallUsage) {
    const valid = (v: number | null | undefined) => Number.isFinite(v) && (v ?? -1) >= 0 ? v! : null;
    this.database.prepare("UPDATE agent_calls SET status=?,input_tokens=?,output_tokens=? WHERE id=? AND status='running'")
      .run(status, valid(usage?.inputTokens), valid(usage?.outputTokens), id);
  }
  hasUnknownCall(taskId: string, actionId: string) {
    return !!this.database.prepare("SELECT id FROM agent_calls WHERE task_id=? AND action_id=? AND status IN ('running','unknown') LIMIT 1").get(taskId, actionId);
  }
  reconcileCalls(taskId: string, actionId: string) {
    this.database.prepare("UPDATE agent_calls SET status='reconciled' WHERE task_id=? AND action_id=? AND status IN ('running','unknown')").run(taskId, actionId);
  }
  acceptedEvent(accountId: string, taskId: string, event: AgentEvent) {
    this.row(accountId, taskId);
    const row = this.database.prepare(`SELECT event_json,consumed FROM agent_events
      WHERE task_id=? AND (id=? OR (event_kind=? AND ref_id=?)) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`)
      .get(taskId, event.id, event.kind, event.refId ?? null, event.id) as { event_json: string; consumed: number } | undefined;
    if (!row) return undefined;
    const previous = JSON.parse(row.event_json) as AgentEvent;
    if (previous.id === event.id && JSON.stringify(previous) !== JSON.stringify(event)) throw new AgentFailure("invalid_action", "反馈标识与原有内容不一致。");
    return { event: previous, consumed: !!row.consumed };
  }
  acceptEvent(accountId: string, taskId: string, token: string, event: AgentEvent) {
    return this.database.transaction(() => {
    this.assertLease(accountId, taskId, token);
    if (!event.id || event.id.length > 180 || (event.message?.length ?? 0) > 2_000) throw new AgentFailure("invalid_action", "反馈事件格式无效。");
    return this.database.prepare("INSERT OR IGNORE INTO agent_events(task_id,id,event_json,event_kind,ref_id,created_at) VALUES(?,?,?,?,?,?)")
      .run(taskId, event.id, JSON.stringify(event), event.kind, event.refId ?? null, now()).changes > 0;
    }).immediate();
  }
  getEvent(accountId: string, taskId: string, eventId: string) {
    this.row(accountId, taskId);
    const row = this.database.prepare("SELECT event_json FROM agent_events WHERE task_id=? AND id=?").get(taskId, eventId) as { event_json: string } | undefined;
    return row ? JSON.parse(row.event_json) as AgentEvent : undefined;
  }
  latestEvent(accountId: string, taskId: string) {
    this.row(accountId, taskId);
    const row = this.database.prepare("SELECT event_json FROM agent_events WHERE task_id=? AND consumed=1 ORDER BY created_at DESC LIMIT 1").get(taskId) as { event_json: string } | undefined;
    return row ? JSON.parse(row.event_json) as AgentEvent : undefined;
  }
  consumeEvent(taskId: string, eventId: string) {
    this.database.prepare("UPDATE agent_events SET consumed=1 WHERE task_id=? AND id=?").run(taskId, eventId);
  }
}
