import { LearningApiError, learningErrorMessage } from "./learning-api";
import type { AgentApproval, AgentBudget, AgentRecovery, AgentResultRef, AgentUsage } from "@/lib/domain/agent";

export type LearningAgentScope = {
  materialIds: string[]; chapterIds: string[]; nodeIds: string[];
  includeHistory: boolean; includeNotes: boolean; includeSupplements: boolean;
};
export type LearningAgentTaskView = {
  id: string; goal: string; scope: LearningAgentScope; version?: number;
  status: "ready" | "running" | "waiting" | "paused" | "cancelled" | "ended" | "budget_exhausted" | "needs_attention";
  currentAction?: string | null;
  wait: { kind: string; refId?: string; message: string } | null;
  endReason?: string | null;
  actions: Array<{ id: string; version?: number; tool: string; status: string; resultRef?: AgentResultRef | null; summary: string; reason?: string }>;
  usage?: AgentUsage;
  budget?: AgentBudget;
  approval?: AgentApproval & { sources?: LearningAgentSource[]; includesSupplement?: boolean };
  recovery?: AgentRecovery;
  explanations?: Array<{ id: string; text: string; sources?: Array<{ materialId: string; paragraph: number; parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding }> }>;
  quizLinks?: Array<{ quizId: string; attemptId?: string | null }>;
};
export type LearningAgentSource = { materialId: string; paragraph: number; parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding };
export type StartLearningAgent = { id: string; goal: string; scope: LearningAgentScope };
export type LearningAgentControl = { id: string; action: "pause" | "resume" | "cancel" | "feedback"; eventId: string; expectedVersion?: number; feedback?: string; attemptId?: string };
export type LearningAgentAdjustment = { goal: string; scope: LearningAgentScope; expectedVersion: number };
export type LearningAgentMutation = LearningAgentControl
  | ({ id: string; action: "adjust"; eventId: string } & LearningAgentAdjustment)
  | { id: string; action: "approval"; eventId: string; expectedVersion: number; approvalId: string; fingerprint: string; decision: "approve" | "reject" }
  | { id: string; action: "recover"; eventId: string; expectedVersion: number; mode: "inspect" | "retry" }
  | { id: string; action: "end"; eventId: string; expectedVersion: number };

async function request<T>(pageId: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/learning/pages/${encodeURIComponent(pageId)}/agent`, {
    method, credentials: "same-origin", cache: "no-store",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new LearningApiError(response.status, typeof result.error === "string" ? result.error : "request_failed");
  return result as T;
}

export const learningAgentApi = {
  list: (pageId: string) => request<{ tasks: LearningAgentTaskView[] }>(pageId, "GET"),
  start: (pageId: string, value: StartLearningAgent) => request<{ task: LearningAgentTaskView }>(pageId, "POST", value),
  control: (pageId: string, value: LearningAgentMutation) => request<{ task: LearningAgentTaskView; scheduled?: boolean }>(pageId, "PATCH", value),
};

export function learningAgentErrorMessage(error: unknown) {
  const messages: Record<string, string> = {
    agent_not_configured: "复习向导暂时不可用，你仍可阅读材料或自行练习。",
    agent_decision_not_configured: "复习向导暂时不可用，你仍可阅读材料或自行练习。",
    agent_scope_changed: "本任务的来源或授权范围已变化，请重新确认本轮范围。",
    agent_source_changed: "本任务的来源已变化，请重新确认本轮范围。",
    agent_not_found: "找不到这个复习任务，或它不属于当前学习页。",
    agent_busy: "任务正在处理，请稍后查看进度。",
    agent_attempt_incomplete: "请先完成并保存整组作答，再继续复习。",
    agent_feedback_not_ready: "请先完成并保存整组作答，再继续复习。",
    agent_event_conflict: "这次操作已发生变化，请重新载入任务后核对。",
    agent_unknown_outcome: "本次生成结果尚未确认，任务已停止自动推进，请先核对已有练习或解释。",
    agent_scope_forbidden: "所选内容不在本任务授权范围，请重新核对本次选择。",
    agent_sources_changed: "所选来源已变化，请重新核对范围后开始新任务。",
    agent_event_forbidden: "这条反馈与任务正在等待的内容不一致，请刷新任务后核对。",
    agent_answers_unavailable: "本次作答尚未完成或已不可用，请先核对原题组。",
    agent_version_conflict: "本轮复习已在另一窗口更新。你的调整草稿已保留，请刷新并比对最新目标和范围后再提交。",
    agent_approval_stale: "这项待确认内容或目标已变化，旧确认不能继续使用。请刷新任务核对。",
    agent_approval_invalid: "这项待确认内容已失效，请刷新任务核对。",
    agent_note_changed: "目标个人笔记已变化，尚未追加。请核对原笔记和新的提议。",
    agent_recovery_not_allowed: "当前结果不允许这样恢复，请按任务显示的处理方式核对。",
    agent_retry_unavailable: "当前结果不能重发，请先核对原操作；未知结果不等于明确失败。",
    agent_budget_exhausted: "本轮复习已达到单次上限，已有内容已保留。你可以开始新的复习。",
    agent_known_failure: "上次操作未完成，请按页面提示检查结果或重试。",
  };
  return error instanceof LearningApiError && messages[error.code] ? messages[error.code] : learningErrorMessage(error);
}
