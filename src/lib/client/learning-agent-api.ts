import { LearningApiError, learningErrorMessage } from "./learning-api";
import type { AgentResultRef, AgentUsage } from "@/lib/domain/agent";

export type LearningAgentScope = {
  materialIds: string[]; chapterIds: string[]; nodeIds: string[];
  includeHistory: boolean; includeNotes: boolean; includeSupplements: boolean;
};
export type LearningAgentTaskView = {
  id: string; goal: string; scope: LearningAgentScope;
  status: "ready" | "running" | "waiting" | "paused" | "cancelled" | "ended" | "budget_exhausted" | "needs_attention";
  currentAction?: string | null;
  wait: { kind: string; refId?: string; message: string } | null;
  endReason?: string | null;
  actions: Array<{ id: string; tool: string; status: string; resultRef?: AgentResultRef | null; summary: string; reason?: string }>;
  usage?: AgentUsage;
  explanations?: Array<{ id: string; text: string; sources?: Array<{ materialId: string; paragraph: number; parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding }> }>;
  quizLinks?: Array<{ quizId: string; attemptId?: string | null }>;
};
export type StartLearningAgent = { id: string; goal: string; scope: LearningAgentScope };
export type LearningAgentControl = { id: string; action: "pause" | "resume" | "cancel" | "feedback"; eventId: string; feedback?: string; attemptId?: string };

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
  control: (pageId: string, value: LearningAgentControl) => request<{ task: LearningAgentTaskView; scheduled?: boolean }>(pageId, "PATCH", value),
};

export function learningAgentErrorMessage(error: unknown) {
  const messages: Record<string, string> = {
    agent_not_configured: "复习决策模型尚未配置。已保存材料与手动学习仍可使用。",
    agent_decision_not_configured: "复习决策模型尚未配置。已保存材料与手动学习仍可使用。",
    agent_scope_changed: "本任务的来源或授权范围已变化，请核对材料后开始新任务。",
    agent_source_changed: "本任务的来源已变化，请核对材料后开始新任务。",
    agent_not_found: "找不到这个复习任务，或它不属于当前学习页。",
    agent_busy: "任务正在处理，请稍后查看进度。",
    agent_attempt_incomplete: "请先完成并保存整组作答，再继续复习。",
    agent_feedback_not_ready: "请先完成并保存整组作答，再继续复习。",
    agent_event_conflict: "这次操作已发生变化，请重新载入任务后核对。",
    agent_unknown_outcome: "本次生成结果尚未确认，任务已停止自动推进，请核对任务记录。",
    agent_scope_forbidden: "所选内容不在本任务授权范围，请重新核对本次选择。",
    agent_sources_changed: "所选来源已变化，请重新核对范围后开始新任务。",
    agent_event_forbidden: "这条反馈与任务正在等待的内容不一致，请刷新任务后核对。",
    agent_answers_unavailable: "本次作答尚未完成或已不可用，请先核对原题组。",
  };
  return error instanceof LearningApiError && messages[error.code] ? messages[error.code] : learningErrorMessage(error);
}
