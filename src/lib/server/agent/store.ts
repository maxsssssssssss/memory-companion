import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentAction, AgentApproval, AgentBudget, AgentEvent, AgentRecovery, AgentTask, AgentTaskStatus, AgentWait } from "@/lib/domain/agent";
import { AgentFailure, type AgentCallRequest, type AgentCallUsage, type AgentDecisionDiagnostic, type AgentToolResult } from "./types";

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxCalls: 16, maxInputChars: 48_000, maxOutputTokens: 8_000,
  maxComputeMs: 10 * 60_000, maxSteps: 16, maxNoProgress: 3,
};
type TaskRow = {
  version: number; recovery_json: string | null; compute_estimated: number;
  id: string; account_id: string; scenario: string; resource_id: string; goal: string; scope_json: string;
  status: AgentTaskStatus; wait_json: string | null; end_reason: string | null; budget_json: string;
  compute_ms: number; steps: number; lease: string | null; lease_until: number; lease_started_at: number; created_at: string; updated_at: string;
};
type ActionRow = {
  version: number; handoff: string | null;
  id: string; task_id: string; step: number; tool: string; args_json: string; status: AgentAction["status"];
  ref_json: string | null; wait_json: string | null; summary: string; reason: string | null; created_at: string;
};
export interface AgentLease { token: string; startedAt: number }
function now() { return new Date().toISOString(); }
function actionDto(row: ActionRow): AgentAction {
  return { id: row.id, version: row.version, tool: row.tool, status: row.status, resultRef: row.ref_json ? JSON.parse(row.ref_json) : undefined,
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
      CREATE TABLE IF NOT EXISTS agent_approvals (
        id TEXT PRIMARY KEY REFERENCES agent_actions(id), task_id TEXT NOT NULL REFERENCES agent_tasks(id),
        version INTEGER NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL, body_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_controls (
        task_id TEXT NOT NULL REFERENCES agent_tasks(id), id TEXT NOT NULL, kind TEXT NOT NULL,
        request_hash TEXT NOT NULL, PRIMARY KEY(task_id,id)
      );
    `);
    database.transaction(() => {
    const taskColumns = database.prepare("PRAGMA table_info(agent_tasks)").all() as { name: string }[];
    if (!taskColumns.some((column) => column.name === "lease_started_at")) database.exec("ALTER TABLE agent_tasks ADD COLUMN lease_started_at INTEGER NOT NULL DEFAULT 0");
    const eventColumns = database.prepare("PRAGMA table_info(agent_events)").all() as { name: string }[];
    if (!eventColumns.some((column) => column.name === "event_kind")) database.exec("ALTER TABLE agent_events ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'legacy'");
    if (!eventColumns.some((column) => column.name === "ref_id")) database.exec("ALTER TABLE agent_events ADD COLUMN ref_id TEXT");
    for (const table of ["agent_tasks", "agent_actions", "agent_events", "agent_calls"]) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some(column => column.name === "version")) database.exec(`ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
    }
    if (!taskColumns.some(column => column.name === "recovery_json")) database.exec("ALTER TABLE agent_tasks ADD COLUMN recovery_json TEXT");
    if (!taskColumns.some(column => column.name === "compute_estimated")) database.exec("ALTER TABLE agent_tasks ADD COLUMN compute_estimated INTEGER NOT NULL DEFAULT 0");
    const actionColumns = database.prepare("PRAGMA table_info(agent_actions)").all() as { name: string }[];
    if (!actionColumns.some(column => column.name === "handoff")) database.exec("ALTER TABLE agent_actions ADD COLUMN handoff TEXT");
    const callColumns = database.prepare("PRAGMA table_info(agent_calls)").all() as { name: string }[];
    if (!callColumns.some(column => column.name === "diagnostics_json")) database.exec("ALTER TABLE agent_calls ADD COLUMN diagnostics_json TEXT");
    database.exec("DROP INDEX IF EXISTS agent_event_business_identity; CREATE UNIQUE INDEX IF NOT EXISTS agent_event_version_identity ON agent_events(task_id,version,event_kind,ref_id) WHERE ref_id IS NOT NULL");
    }).immediate();
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
    const approval = this.database.prepare("SELECT body_json,status FROM agent_approvals WHERE task_id=? AND version=? ORDER BY rowid DESC LIMIT 1").get(taskId, row.version) as { body_json: string; status: AgentApproval["status"] } | undefined;
    let recovery: AgentRecovery | undefined = row.recovery_json ? JSON.parse(row.recovery_json) : undefined;
    if (!recovery && row.status === "paused") {
      const latest = [...actions].reverse().find(action => action.version === row.version);
      const confirmation = latest ? this.database.prepare("SELECT status FROM agent_approvals WHERE id=?").get(latest.id) as { status: AgentApproval["status"] } | undefined : undefined;
      const unresolved = latest && ["prepared", "running", "unknown", "failed"].includes(latest.status) && confirmation?.status !== "rejected" ? latest : undefined;
      const unknownCall = this.database.prepare("SELECT id FROM agent_calls WHERE task_id=? AND version=? AND status IN ('running','unknown') LIMIT 1").get(taskId, row.version);
      if (unresolved || unknownCall) recovery = {
        kind: !unknownCall && unresolved?.status === "prepared" ? "not_started" : !unknownCall && unresolved?.status === "failed" ? "known_failed" : "unknown", actionId: unresolved?.id,
        message: "任务已暂停。请先核对原操作收据；结果未知时不会重发。", allowedControls: ["inspect", "adjust", "cancel"],
      };
    }
    return { id: row.id, version: row.version, accountId: row.account_id, scenario: row.scenario, resourceId: row.resource_id, goal: row.goal,
      scope: JSON.parse(row.scope_json), status: row.status, wait: row.wait_json ? JSON.parse(row.wait_json) : undefined,
      endReason: row.end_reason ?? undefined, currentAction: [...actions].reverse().find((a) => a.version === row.version && a.status === "running")?.tool,
      actions, budget: JSON.parse(row.budget_json), usage: { calls: usage.calls, inputTokens: usage.unknown_calls ? null : usage.input_tokens,
        outputTokens: usage.unknown_calls ? null : usage.output_tokens, unknownUsageCalls: usage.unknown_calls ?? 0, computeMs: row.compute_ms,
        ...(row.compute_estimated ? { computeEstimated: true } : {}), steps: row.steps },
      approval: approval ? { ...JSON.parse(approval.body_json), status: approval.status } : undefined,
      recovery,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  listTasks(accountId: string, resourceId?: string) {
    const rows = (resourceId
      ? this.database.prepare("SELECT id FROM agent_tasks WHERE account_id=? AND resource_id=? ORDER BY created_at DESC LIMIT 50").all(accountId, resourceId)
      : this.database.prepare("SELECT id FROM agent_tasks WHERE account_id=? ORDER BY created_at DESC LIMIT 50").all(accountId)) as { id: string }[];
    return rows.map(({ id }) => this.getTask(accountId, id));
  }
  claim(accountId: string, taskId: string, expectedVersion?: number): AgentLease | null {
    return this.database.transaction(() => {
      const row = this.row(accountId, taskId);
      if (expectedVersion !== undefined && row.version !== expectedVersion) return null;
      if (["paused", "cancelled", "ended", "budget_exhausted", "needs_attention"].includes(row.status)) return null;
      if (row.lease && row.lease_until > Date.now()) return null;
      if (row.status === "running" && row.lease) {
        // A crashed external request may have succeeded. Explicit reconciliation is required.
        const budget = JSON.parse(row.budget_json) as AgentBudget;
        const remaining = Math.max(0, budget.maxComputeMs - row.compute_ms);
        const elapsed = row.lease_started_at > 0 ? Math.max(0, Date.now() - row.lease_started_at) : remaining;
        const charged = Math.min(remaining, elapsed);
        const recovery: AgentRecovery = { kind: "interrupted", message: "运行租约已过期，计算时间已保守结算；请先检查原操作结果，系统不会自动重发。", allowedControls: ["inspect", "adjust", "cancel"] };
        this.database.prepare("UPDATE agent_tasks SET status='needs_attention', lease=NULL, lease_until=0,lease_started_at=0,compute_ms=compute_ms+?,compute_estimated=1,recovery_json=?, end_reason=?, updated_at=? WHERE id=?")
          .run(charged, JSON.stringify(recovery), recovery.message, now(), taskId);
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
  setState(accountId: string, taskId: string, token: string, status: AgentTaskStatus, extra: { wait?: AgentWait; endReason?: string; recovery?: AgentRecovery } = {}) {
    return this.database.transaction(() => {
    this.assertLease(accountId, taskId, token);
    this.database.prepare("UPDATE agent_tasks SET status=?,wait_json=?,end_reason=?,recovery_json=?,updated_at=? WHERE id=? AND lease=?")
      .run(status, extra.wait ? JSON.stringify(extra.wait) : null, extra.endReason ?? null, extra.recovery ? JSON.stringify(extra.recovery) : null, now(), taskId, token);
    }).immediate();
  }
  release(accountId: string, taskId: string, lease: AgentLease) {
    this.row(accountId, taskId);
    this.database.prepare("UPDATE agent_tasks SET compute_ms=compute_ms+?,lease=NULL,lease_until=0,lease_started_at=0,updated_at=? WHERE id=? AND lease=?")
      .run(Math.max(0, Date.now() - lease.startedAt), now(), taskId, lease.token);
  }
  control(accountId: string, taskId: string, operation: "pause" | "resume" | "cancel", expectedVersion?: number) {
    return this.database.transaction(() => {
    const row = this.row(accountId, taskId);
    if (expectedVersion !== undefined) this.assertVersion(accountId, taskId, expectedVersion);
    if (["cancelled", "ended"].includes(row.status) || (operation !== "cancel" && ["budget_exhausted", "needs_attention"].includes(row.status))) return this.getTask(accountId, taskId);
    if (operation === "resume" && row.status !== "paused") return this.getTask(accountId, taskId);
    let status: AgentTaskStatus = row.status;
    let reason: string | null = row.end_reason;
    if (operation === "cancel") { status = "cancelled"; reason = "用户取消；已完成的业务记录保留。"; }
    if (operation === "pause") status = "paused";
    if (operation === "resume" && row.status === "paused") {
      const active = this.database.prepare("SELECT id FROM agent_calls WHERE task_id=? AND version=? AND status IN ('running','unknown') LIMIT 1").get(taskId, row.version);
      const action = this.database.prepare("SELECT id FROM agent_actions WHERE task_id=? AND version=? AND status IN ('running','unknown') LIMIT 1").get(taskId, row.version);
      const feedbackUnknown = row.recovery_json && (JSON.parse(row.recovery_json) as AgentRecovery).kind === "unknown";
      if (active || action || feedbackUnknown) { status = "needs_attention"; reason = "暂停前的动作结果未确认；请检查已有业务结果，系统不会自动重发。"; }
      else status = row.wait_json ? "waiting" : "ready";
    }
    const elapsed = row.lease && row.lease_started_at ? Math.max(0, Date.now() - row.lease_started_at) : 0;
    if (operation === "cancel") this.invalidateApprovals(taskId);
    this.database.prepare("UPDATE agent_tasks SET status=?,end_reason=?,compute_ms=compute_ms+?,lease=NULL,lease_until=0,lease_started_at=0,updated_at=? WHERE id=?")
      .run(status, reason, elapsed, now(), taskId);
    return this.getTask(accountId, taskId);
    }).immediate();
  }
  /** Authenticated scenario feedback can invalidate an in-flight decision. Its
   * receipt and lease fence are atomic; external calls remain billable facts. */
  pauseForFeedback(accountId: string, taskId: string, event: AgentEvent, expectedVersion: number) {
    return this.database.transaction(() => {
      const task = this.assertVersion(accountId, taskId, expectedVersion), row = this.row(accountId, taskId);
      if (this.acceptedEvent(accountId, taskId, event)) return task;
      if (row.status === "cancelled") throw new AgentFailure("inactive", "已取消任务不能接收新反馈。");
      if (!event.id || event.id.length > 180 || !event.message?.trim() || event.message.length > 2000) throw new AgentFailure("invalid_action", "反馈事件格式无效。");
      const unresolvedFeedback = row.recovery_json && (JSON.parse(row.recovery_json) as AgentRecovery).kind === "unknown";
      const unknown = unresolvedFeedback || this.database.prepare("SELECT id FROM agent_calls WHERE task_id=? AND version=? AND status IN ('running','unknown') LIMIT 1").get(taskId, row.version)
        || this.database.prepare("SELECT id FROM agent_actions WHERE task_id=? AND version=? AND status IN ('running','unknown') LIMIT 1").get(taskId, row.version);
      this.database.prepare("UPDATE agent_events SET consumed=1 WHERE task_id=? AND version=?").run(taskId, row.version);
      this.database.prepare("INSERT INTO agent_events(task_id,id,event_json,event_kind,ref_id,created_at,version,consumed) VALUES(?,?,?,?,?,?,?,1)")
        .run(taskId, event.id, JSON.stringify(event), event.kind, event.refId ?? null, now(), row.version);
      this.invalidateApprovals(taskId);
      this.database.prepare("UPDATE agent_actions SET status='failed',summary=? WHERE task_id=? AND version=? AND status='prepared'")
        .run("用户补充反馈，原未执行行动已失效。", taskId, row.version);
      const terminal = ["ended", "budget_exhausted"].includes(row.status);
      const message = terminal ? "已记录题组疑问；原作答保留，本轮结束说明不能作为该题组的学习诊断。"
        : unknown ? "已记录疑问并暂停；暂停前的结果尚未确认，请先检查原结果，不会自动重发。" : "已记录疑问并暂停。继续后将依据新反馈重新判断，不再使用该题组成绩诊断。";
      const recovery: AgentRecovery = { kind: unknown ? "unknown" : "feedback_received", message, allowedControls: unknown ? ["inspect", "adjust", "cancel"] : [] };
      const elapsed = row.lease && row.lease_started_at ? Math.max(0, Date.now() - row.lease_started_at) : 0;
      this.database.prepare("UPDATE agent_tasks SET status=?,wait_json=NULL,end_reason=?,recovery_json=?,compute_ms=compute_ms+?,lease=NULL,lease_until=0,lease_started_at=0,updated_at=? WHERE id=?")
        .run(terminal ? row.status : "paused", message, terminal ? null : JSON.stringify(recovery), elapsed, now(), taskId);
      return this.getTask(accountId, taskId);
    }).immediate();
  }
  step(accountId: string, taskId: string, token: string) {
    return this.database.transaction(() => {
    const task = this.assertLease(accountId, taskId, token);
    if (task.usage.steps >= task.budget.maxSteps) throw new AgentFailure("budget", "agent_step_limit");
    this.database.prepare("UPDATE agent_tasks SET steps=steps+1 WHERE id=?").run(taskId);
    return task.usage.steps + 1;
    }).immediate();
  }
  prepareAction(accountId: string, taskId: string, token: string, input: { step: number; tool: string; args: unknown; reason?: string }) {
    return this.database.transaction(() => {
    const task = this.assertLease(accountId, taskId, token);
    const args = JSON.stringify(input.args);
    if (args.length > 8_000) throw new AgentFailure("invalid_action", "工具参数超出上限。");
    const previous = this.database.prepare("SELECT tool,args_json,ref_json FROM agent_actions WHERE task_id=? AND version=? ORDER BY step DESC LIMIT ?").all(taskId, task.version ?? 1, task.budget.maxNoProgress) as { tool: string; args_json: string; ref_json: string | null }[];
    if (previous.length >= task.budget.maxNoProgress && previous.every((p) => p.tool === input.tool && p.args_json === args && p.ref_json === previous[0].ref_json)) throw new AgentFailure("budget", "agent_no_progress_limit");
    const id = `${taskId}:${input.step}`;
    this.database.prepare("INSERT INTO agent_actions(id,task_id,step,tool,args_json,status,reason,created_at,version) VALUES(?,?,?,?,?,'prepared',?,?,?)")
      .run(id, taskId, input.step, input.tool, args, input.reason?.slice(0, 240) ?? null, now(), task.version ?? 1);
    return id;
    }).immediate();
  }
  action(accountId: string, taskId: string, actionId: string) {
    this.row(accountId, taskId);
    const row = this.database.prepare("SELECT * FROM agent_actions WHERE task_id=? AND id=?").get(taskId, actionId) as ActionRow | undefined;
    if (!row) throw new AgentFailure("invalid_action", "行动记录不存在。");
    return { ...actionDto(row), args: JSON.parse(row.args_json) as unknown, wait: row.wait_json ? JSON.parse(row.wait_json) as AgentWait : undefined, handoff: row.handoff ?? undefined };
  }
  markAction(accountId: string, taskId: string, token: string, actionId: string, status: AgentAction["status"], result?: AgentToolResult) {
    return this.database.transaction(() => {
    const task = this.assertLease(accountId, taskId, token);
    this.database.prepare("UPDATE agent_actions SET status=?,ref_json=?,wait_json=?,summary=?,handoff=? WHERE id=? AND task_id=? AND version=?")
      .run(status, result?.ref ? JSON.stringify(result.ref) : null, result?.wait ? JSON.stringify(result.wait) : null,
        result?.summary.slice(0, 400) ?? "", result?.handoff?.slice(0, 1_000) ?? null, actionId, taskId, task.version ?? 1);
    if (status === "succeeded") this.clearApprovalContent(actionId);
    }).immediate();
  }
  reserveCall(accountId: string, taskId: string, token: string, actionId: string, request: AgentCallRequest, elapsedMs: number) {
    return this.database.transaction(() => {
      const task = this.assertLease(accountId, taskId, token);
      if (!Number.isSafeInteger(request.inputChars) || request.inputChars < 0 || request.inputChars > task.budget.maxInputChars)
        throw new AgentFailure("budget", "agent_request_input_limit");
      if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > task.budget.maxOutputTokens)
        throw new AgentFailure("budget", "agent_request_output_limit");
      if (task.usage.calls >= task.budget.maxCalls) throw new AgentFailure("budget", "agent_call_limit");
      if (task.usage.computeMs + elapsedMs >= task.budget.maxComputeMs) throw new AgentFailure("budget", "agent_compute_limit");
      const id = randomUUID();
      this.database.prepare("INSERT INTO agent_calls(id,task_id,action_id,kind,model,input_chars,output_limit,status,created_at,version) VALUES(?,?,?,?,?,?,?,'running',?,?)")
        .run(id, taskId, actionId, request.kind.slice(0, 80), request.model?.slice(0, 120) ?? null, request.inputChars, request.maxOutputTokens, now(), task.version ?? 1);
      return id;
    }).immediate();
  }
  finishCall(id: string, status: "succeeded" | "failed" | "unknown", usage?: AgentCallUsage, diagnostic?: AgentDecisionDiagnostic) {
    const valid = (v: number | null | undefined) => Number.isFinite(v) && (v ?? -1) >= 0 ? v! : null;
    this.database.prepare("UPDATE agent_calls SET status=?,input_tokens=?,output_tokens=?,diagnostics_json=? WHERE id=? AND status='running'")
      .run(status, valid(usage?.inputTokens), valid(usage?.outputTokens), diagnostic ? JSON.stringify(diagnostic) : null, id);
  }
  recordDecisionRejection(accountId: string, taskId: string, token: string, decisionId: string, diagnostic: AgentDecisionDiagnostic) {
    const task = this.assertLease(accountId, taskId, token);
    // A successful response is still a billing fact when its tool arguments fail.
    // Associate the rejection with its last actual call, not a new action/usage row.
    this.database.prepare(`UPDATE agent_calls SET diagnostics_json=? WHERE id=(
      SELECT id FROM agent_calls WHERE task_id=? AND version=? AND action_id=? ORDER BY rowid DESC LIMIT 1
    ) AND diagnostics_json IS NULL`).run(JSON.stringify(diagnostic), taskId, task.version ?? 1, decisionId);
  }
  decisionDiagnostics(accountId: string, taskId: string) {
    this.row(accountId, taskId);
    const rows = this.database.prepare(`SELECT id,task_id,version,action_id,status,diagnostics_json FROM agent_calls
      WHERE task_id=? AND diagnostics_json IS NOT NULL ORDER BY rowid`).all(taskId) as Array<{
        id: string; task_id: string; version: number; action_id: string; status: string; diagnostics_json: string;
      }>;
    return rows.map(row => ({ requestId: row.id, callId: row.id, taskId: row.task_id, taskVersion: row.version,
      decisionId: row.action_id, callStatus: row.status, diagnostic: JSON.parse(row.diagnostics_json) as AgentDecisionDiagnostic }));
  }
  hasUnknownCall(taskId: string, actionId: string) {
    return !!this.database.prepare("SELECT id FROM agent_calls WHERE task_id=? AND action_id=? AND status IN ('running','unknown') LIMIT 1").get(taskId, actionId);
  }
  reconcileCalls(taskId: string, actionId: string) {
    this.database.prepare("UPDATE agent_calls SET status='reconciled' WHERE task_id=? AND action_id=? AND status IN ('running','unknown')").run(taskId, actionId);
  }
  acceptedEvent(accountId: string, taskId: string, event: AgentEvent) {
    const task = this.row(accountId, taskId);
    this.assertEventVersion(task.version, event);
    const row = this.database.prepare(`SELECT event_json,consumed FROM agent_events
      WHERE task_id=? AND version=? AND (id=? OR (event_kind=? AND ref_id=?)) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`)
      .get(taskId, task.version, event.id, event.kind, event.refId ?? null, event.id) as { event_json: string; consumed: number } | undefined;
    if (!row) return undefined;
    const previous = JSON.parse(row.event_json) as AgentEvent;
    if (previous.id === event.id && JSON.stringify(previous) !== JSON.stringify(event)) throw new AgentFailure("invalid_action", "反馈标识与原有内容不一致。");
    if (event.kind === "approval" && (previous.decision !== event.decision || previous.fingerprint !== event.fingerprint || (previous.version ?? 1) !== (event.version ?? 1))) throw new AgentFailure("conflict", "同一提案的确认内容或决定不一致。");
    return { event: previous, consumed: !!row.consumed };
  }
  acceptEvent(accountId: string, taskId: string, token: string, event: AgentEvent) {
    return this.database.transaction(() => {
    const task = this.assertLease(accountId, taskId, token);
    this.assertEventVersion(task.version ?? 1, event);
    if (!event.id || event.id.length > 180 || (event.message?.length ?? 0) > 2_000) throw new AgentFailure("invalid_action", "反馈事件格式无效。");
    return this.database.prepare("INSERT OR IGNORE INTO agent_events(task_id,id,event_json,event_kind,ref_id,created_at,version) VALUES(?,?,?,?,?,?,?)")
      .run(taskId, event.id, JSON.stringify(event), event.kind, event.refId ?? null, now(), task.version ?? 1).changes > 0;
    }).immediate();
  }
  getEvent(accountId: string, taskId: string, eventId: string) {
    const task = this.row(accountId, taskId);
    const row = this.database.prepare("SELECT event_json FROM agent_events WHERE task_id=? AND id=? AND version=?").get(taskId, eventId, task.version) as { event_json: string } | undefined;
    return row ? JSON.parse(row.event_json) as AgentEvent : undefined;
  }
  latestEvent(accountId: string, taskId: string) {
    const task = this.row(accountId, taskId);
    const row = this.database.prepare("SELECT event_json FROM agent_events WHERE task_id=? AND version=? AND consumed=1 ORDER BY created_at DESC,rowid DESC LIMIT 1").get(taskId, task.version) as { event_json: string } | undefined;
    return row ? JSON.parse(row.event_json) as AgentEvent : undefined;
  }
  consumeEvent(accountId: string, taskId: string, token: string, eventId: string) {
    return this.database.transaction(() => {
      const task = this.assertLease(accountId, taskId, token);
      const updated = this.database.prepare("UPDATE agent_events SET consumed=1 WHERE task_id=? AND id=? AND version=?")
        .run(taskId, eventId, task.version ?? 1);
      if (!updated.changes) throw new AgentFailure("forbidden", "当前版本的恢复事件不存在。");
    }).immediate();
  }
  continueEvent(accountId: string, taskId: string, token: string, eventId: string) {
    return this.database.transaction(() => {
      this.consumeEvent(accountId, taskId, token, eventId);
      const event = this.getEvent(accountId, taskId, eventId)!;
      if (event.kind === "approval" && event.decision === "reject") {
        this.markAction(accountId, taskId, token, event.refId!, "failed", { summary: "用户拒绝了这项提案，未执行。" });
      }
      // Consumption and leaving the wait form one transition. A concurrent pause
      // must see either the pending event or a task that no longer awaits it.
      this.setState(accountId, taskId, token, "running");
    }).immediate();
  }
  pendingEvent(accountId: string, taskId: string) {
    const task = this.row(accountId, taskId);
    const row = this.database.prepare("SELECT event_json FROM agent_events WHERE task_id=? AND version=? AND consumed=0 ORDER BY created_at LIMIT 1").get(taskId, task.version) as { event_json: string } | undefined;
    return row ? JSON.parse(row.event_json) as AgentEvent : undefined;
  }
  assertVersion(accountId: string, taskId: string, expectedVersion: number) {
    const row = this.row(accountId, taskId);
    if (row.version !== expectedVersion) throw new AgentFailure("conflict", "任务版本已变化，请刷新后重新确认。");
    return this.getTask(accountId, taskId);
  }
  assertEventVersion(version: number, event: AgentEvent) {
    if ((event.version ?? 1) !== version) throw new AgentFailure("conflict", "旧任务版本的反馈不能推进当前任务。");
  }
  private controlSeen(taskId: string, id: string | undefined, kind: string, payload: unknown) {
    if (!id) return false;
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const old = this.database.prepare("SELECT kind,request_hash FROM agent_controls WHERE task_id=? AND id=?").get(taskId, id) as { kind: string; request_hash: string } | undefined;
    if (!old) return false;
    if (old.kind !== kind || old.request_hash !== hash) throw new AgentFailure("conflict", "操作标识已经用于另一项请求。");
    return true;
  }
  private recordControl(taskId: string, id: string | undefined, kind: string, payload: unknown) {
    if (id) this.database.prepare("INSERT INTO agent_controls(task_id,id,kind,request_hash) VALUES(?,?,?,?)")
      .run(taskId, id, kind, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
  }
  adjust(accountId: string, taskId: string, input: { expectedVersion: number; goal: string; scope: unknown; eventId?: string }) {
    return this.database.transaction(() => {
      const row = this.row(accountId, taskId);
      if (this.controlSeen(taskId, input.eventId, "adjust", input)) return this.getTask(accountId, taskId);
      this.assertVersion(accountId, taskId, input.expectedVersion);
      if (["cancelled", "ended"].includes(row.status)) throw new AgentFailure("inactive", "已结束任务不能调整。");
      if (!input.goal.trim() || input.goal.length > 2_000) throw new AgentFailure("invalid_action", "任务目标长度无效。");
      const elapsed = row.lease && row.lease_started_at ? Math.max(0, Date.now() - row.lease_started_at) : 0;
      this.invalidateApprovals(taskId);
      // Old references remain auditable, but arguments/feedback do not become a
      // second source archive after their authorization version is revoked.
      this.database.prepare("UPDATE agent_actions SET args_json='{}',reason=NULL WHERE task_id=? AND version=?").run(taskId, row.version);
      this.database.prepare("UPDATE agent_events SET consumed=1,event_json='{}' WHERE task_id=? AND version=?").run(taskId, row.version);
      this.database.prepare("UPDATE agent_tasks SET version=version+1,goal=?,scope_json=?,status='ready',wait_json=NULL,end_reason=NULL,recovery_json=NULL,compute_ms=compute_ms+?,lease=NULL,lease_until=0,lease_started_at=0,updated_at=? WHERE id=? AND version=?")
        .run(input.goal.trim(), JSON.stringify(input.scope), elapsed, now(), taskId, row.version);
      this.recordControl(taskId, input.eventId, "adjust", input);
      return this.getTask(accountId, taskId);
    }).immediate();
  }
  end(accountId: string, taskId: string, input: { expectedVersion: number; eventId?: string }) {
    return this.database.transaction(() => {
      const row = this.row(accountId, taskId);
      if (this.controlSeen(taskId, input.eventId, "end", input)) return this.getTask(accountId, taskId);
      this.assertVersion(accountId, taskId, input.expectedVersion);
      if (row.status === "cancelled" || row.status === "ended") return this.getTask(accountId, taskId);
      this.invalidateApprovals(taskId);
      const elapsed = row.lease && row.lease_started_at ? Math.max(0, Date.now() - row.lease_started_at) : 0;
      this.database.prepare("UPDATE agent_tasks SET status='ended',end_reason=?,wait_json=NULL,recovery_json=NULL,compute_ms=compute_ms+?,lease=NULL,lease_until=0,lease_started_at=0,updated_at=? WHERE id=?")
        .run("用户交回任务；已完成记录保留，不代表业务目标已经验证完成。", elapsed, now(), taskId);
      this.recordControl(taskId, input.eventId, "end", input);
      return this.getTask(accountId, taskId);
    }).immediate();
  }
  saveApproval(accountId: string, taskId: string, token: string, approval: AgentApproval) {
    return this.database.transaction(() => {
      const task = this.assertLease(accountId, taskId, token);
      if (approval.taskVersion !== task.version) throw new AgentFailure("conflict", "提案属于旧任务版本。");
      this.database.prepare("INSERT OR IGNORE INTO agent_approvals(id,task_id,version,status,fingerprint,body_json) VALUES(?,?,?,?,?,?)")
        .run(approval.id, taskId, task.version, approval.status, approval.fingerprint, JSON.stringify({ ...approval, content: "" }));
    }).immediate();
  }
  approval(accountId: string, taskId: string, approvalId: string) {
    const task = this.row(accountId, taskId);
    const row = this.database.prepare("SELECT body_json,status FROM agent_approvals WHERE id=? AND task_id=? AND version=?").get(approvalId, taskId, task.version) as { body_json: string; status: AgentApproval["status"] } | undefined;
    return row ? { ...JSON.parse(row.body_json), status: row.status } as AgentApproval : undefined;
  }
  resolveApproval(accountId: string, taskId: string, token: string, event: AgentEvent) {
    return this.database.transaction(() => {
      const task = this.assertLease(accountId, taskId, token);
      this.assertEventVersion(task.version ?? 1, event);
      const approval = this.approval(accountId, taskId, event.refId ?? "");
      if (!approval || approval.fingerprint !== event.fingerprint || approval.status === "invalidated") throw new AgentFailure("conflict", "确认内容或授权已经变化。");
      const status = event.decision === "approve" ? "approved" : event.decision === "reject" ? "rejected" : undefined;
      if (!status || !["pending", status].includes(approval.status)) throw new AgentFailure("conflict", "该确认已经处理，不能更改决定。");
      this.acceptEvent(accountId, taskId, token, event);
      this.database.prepare("UPDATE agent_approvals SET status=? WHERE id=? AND task_id=? AND version=?").run(status, approval.id, taskId, task.version);
      if (status === "rejected") this.clearApprovalContent(approval.id);
    }).immediate();
  }
  clearApprovalContent(actionId: string) {
    const row = this.database.prepare("SELECT body_json FROM agent_approvals WHERE id=?").get(actionId) as { body_json: string } | undefined;
    if (row) {
      const body = JSON.parse(row.body_json) as AgentApproval;
      body.content = "";
      this.database.prepare("UPDATE agent_approvals SET body_json=? WHERE id=?").run(JSON.stringify(body), actionId);
    }
  }
  invalidateApprovals(taskId: string) {
    const rows = this.database.prepare("SELECT id FROM agent_approvals WHERE task_id=?").all(taskId) as { id: string }[];
    for (const row of rows) this.clearApprovalContent(row.id);
    this.database.prepare("UPDATE agent_approvals SET status='invalidated' WHERE task_id=? AND status IN ('pending','approved')").run(taskId);
  }
  claimRecovery(accountId: string, taskId: string, expectedVersion: number): AgentLease | null {
    return this.database.transaction(() => {
      const row = this.row(accountId, taskId);
      this.assertVersion(accountId, taskId, expectedVersion);
      if (row.lease && row.lease_until > Date.now()) return null;
      if (!["needs_attention", "paused"].includes(row.status)) return null;
      const token = randomUUID(), startedAt = Date.now(), budget = JSON.parse(row.budget_json) as AgentBudget;
      this.database.prepare("UPDATE agent_tasks SET status='running',lease=?,lease_until=?,lease_started_at=? WHERE id=?")
        .run(token, startedAt + budget.maxComputeMs + 30_000, startedAt, taskId);
      return { token, startedAt };
    }).immediate();
  }
  callsForVersion(accountId: string, taskId: string) {
    const task = this.row(accountId, taskId);
    return this.database.prepare("SELECT action_id,status FROM agent_calls WHERE task_id=? AND version=? ORDER BY rowid").all(taskId, task.version) as { action_id: string; status: string }[];
  }
  recoverySeen(accountId: string, taskId: string, input: { expectedVersion: number; mode: "inspect" | "retry"; eventId?: string }) {
    this.row(accountId, taskId);
    return this.controlSeen(taskId, input.eventId, "recover", { expectedVersion: input.expectedVersion, mode: input.mode, eventId: input.eventId });
  }
  recordRecovery(accountId: string, taskId: string, token: string, input: { expectedVersion: number; mode: "inspect" | "retry"; eventId?: string }) {
    this.assertLease(accountId, taskId, token);
    if (!this.recoverySeen(accountId, taskId, input)) this.recordControl(taskId, input.eventId, "recover", { expectedVersion: input.expectedVersion, mode: input.mode, eventId: input.eventId });
  }
}
