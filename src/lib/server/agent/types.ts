import type { z } from "zod";
import type { AgentAction, AgentConfirmation, AgentEvent, AgentResultRef, AgentTask, AgentWait } from "@/lib/domain/agent";

export interface AgentCallRequest { kind: string; inputChars: number; maxOutputTokens: number; model?: string }
export interface AgentCallUsage { inputTokens?: number | null; outputTokens?: number | null }
export interface AgentContext {
  task: AgentTask;
  actionId: string;
  event?: AgentEvent;
  signal: AbortSignal;
  assertActive(): Promise<void>;
  call<T>(request: AgentCallRequest, invoke: () => Promise<{ value: T; usage?: AgentCallUsage }>): Promise<T>;
}
export interface AgentToolResult { ref?: AgentResultRef; summary: string; wait?: AgentWait; handoff?: string }
export interface AgentTool {
  description: string;
  parameters: z.ZodType;
  execute(args: unknown, context: AgentContext): Promise<AgentToolResult>;
  /** Re-read or prepare a stable proposal; must not re-generate content on approval. */
  confirmation?(args: unknown, context: AgentContext): Promise<AgentConfirmation | null>;
  /** Verify an authorized write's exact postcondition before ending this scope. */
  validateResult?(result: AgentToolResult, context: AgentContext): Promise<void>;
  /** Re-read authorized business records; receipt/checkpoint is never source evidence. */
  readResult?(receipt: AgentAction, context: AgentContext): Promise<unknown>;
  /** Resolve an interrupted operation by stable identity without issuing another external request. */
  recover?(actionId: string, context: AgentContext): Promise<AgentToolResult | null>;
}
export interface AgentScenario {
  id: string;
  instructions?: string;
  validate(context: AgentContext): Promise<void>;
  observe(context: AgentContext): Promise<unknown>;
  tools: Record<string, AgentTool>;
  /** Authenticated events must be checked against saved business state. */
  validateEvent?(event: AgentEvent, context: AgentContext): Promise<void>;
  /** Scene-owned end semantics. A model completion assertion is only a request. */
  finish?(requestedReason: string, context: AgentContext): Promise<string>;
}
export type AgentDecision = { tool: string; args: unknown; reason?: string } | { finish: string } | { wait: AgentWait };
export interface AgentDecisionInput {
  instructions?: string;
  task: AgentTask; observation: unknown;
  results: Array<{ actionId: string; tool: string; status: AgentAction["status"]; value: unknown }>;
  tools: Array<{ name: string; description: string; parameters: z.ZodType }>;
  event?: AgentEvent;
}
export type AgentDecisionProvider = (input: AgentDecisionInput, context: AgentContext) => Promise<AgentDecision>;

export class AgentFailure extends Error {
  constructor(public readonly code: "forbidden" | "invalid_action" | "known_failure" | "unknown" | "budget" | "inactive" | "source_changed" | "conflict", message: string,
    /** Reported usage remains a billing fact even when the result is unusable. */
    public readonly usage?: AgentCallUsage) {
    super(message); this.name = "AgentFailure";
  }
}
