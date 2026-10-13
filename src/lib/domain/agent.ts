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
  /** A crashed execution is conservatively charged; its exact end time is unknown. */
  computeEstimated?: boolean;
}
export interface AgentAction {
  version?: number;
  id: string; tool: string; status: "prepared" | "running" | "succeeded" | "failed" | "unknown";
  resultRef?: AgentResultRef; summary: string; reason?: string; createdAt: string;
}
export interface AgentConfirmation {
  title: string; summary: string; target: string; content: string; sourceFingerprint: string;
}
export interface AgentApproval extends AgentConfirmation {
  id: string; actionId: string; taskVersion: number; tool: string; fingerprint: string;
  status: "pending" | "approved" | "rejected" | "invalidated"; createdAt: string;
}
export type AgentRecoveryKind = "not_started" | "known_failed" | "unknown" | "succeeded" | "source_invalid" | "version_changed" | "interrupted";
export interface AgentRecovery {
  kind: AgentRecoveryKind; message: string; actionId?: string;
  allowedControls: Array<"inspect" | "retry" | "adjust" | "cancel">;
}
export interface AgentTask {
  /** A1 rows migrate to version 1. Budgets accumulate across all versions. */
  version?: number;
  id: string; accountId: string; scenario: string; resourceId: string; goal: string;
  scope: unknown; status: AgentTaskStatus; wait?: AgentWait; endReason?: string;
  currentAction?: string; actions: AgentAction[]; usage: AgentUsage; budget: AgentBudget;
  createdAt: string; updatedAt: string;
  approval?: AgentApproval; recovery?: AgentRecovery;
}
export interface AgentEvent {
  id: string; kind: string; refId?: string; message?: string; version?: number;
  decision?: "approve" | "reject"; fingerprint?: string;
}
