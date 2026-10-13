/** Shared execution facts. `ended` never means that a person mastered a topic. */
export type AgentTaskStatus = "ready" | "running" | "waiting" | "paused" | "cancelled" | "ended" | "budget_exhausted" | "needs_attention";
export interface AgentWait { kind: string; refId?: string; message: string }
export interface AgentResultRef { kind: string; id: string }
export interface AgentBudget {
  maxCalls: number; maxInputChars: number; maxOutputTokens: number;
  maxComputeMs: number; maxSteps: number; maxNoProgress: number;
}
export interface AgentUsage {
  calls: number; inputTokens: number | null; outputTokens: number | null;
  unknownUsageCalls: number; computeMs: number; steps: number;
}
export interface AgentAction {
  id: string; tool: string; status: "prepared" | "running" | "succeeded" | "failed" | "unknown";
  resultRef?: AgentResultRef; summary: string; reason?: string; createdAt: string;
}
export interface AgentTask {
  id: string; accountId: string; scenario: string; resourceId: string; goal: string;
  scope: unknown; status: AgentTaskStatus; wait?: AgentWait; endReason?: string;
  currentAction?: string; actions: AgentAction[]; usage: AgentUsage; budget: AgentBudget;
  createdAt: string; updatedAt: string;
}
export interface AgentEvent { id: string; kind: string; refId?: string; message?: string }
