import type { AgentBudget } from "@/lib/domain/agent";
import { DEFAULT_AGENT_BUDGET } from "@/lib/server/agent/store";
import { LearningError } from "./repository";
import { learningAgentInputChars } from "./agent-input-budget";

/** Deployment policy is frozen into a new Learning task's existing budget_json.
 * Resuming, adjusting or reopening a task continues using that saved budget. */
export function learningAgentTaskBudget(env: Readonly<Record<string, string | undefined>> = process.env): AgentBudget {
  const positiveInteger = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) throw new LearningError(503, "agent_not_configured");
    return value;
  };
  const maxCalls = positiveInteger("LEARNING_AGENT_TASK_MAX_CALLS", 64);
  // Leave room for local tools and waiting actions when only the call limit is raised.
  const maxSteps = positiveInteger("LEARNING_AGENT_TASK_MAX_STEPS", maxCalls * 2);
  const maxComputeMs = positiveInteger("LEARNING_AGENT_TASK_MAX_COMPUTE_MS", 30 * 60_000);
  // Runtime derives a graph recursion limit and uses a Node timer. Reject
  // overflow rather than silently disabling either finite execution bound.
  if (!Number.isSafeInteger(maxSteps * 4 + 5) || maxComputeMs > 2_147_483_647) throw new LearningError(503, "agent_not_configured");
  let maxInputChars: number;
  try { maxInputChars = learningAgentInputChars(env); }
  catch { throw new LearningError(503, "agent_not_configured"); }
  return { ...DEFAULT_AGENT_BUDGET, maxCalls, maxSteps, maxComputeMs, maxInputChars };
}
