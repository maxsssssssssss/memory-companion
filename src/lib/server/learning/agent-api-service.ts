import { join } from "node:path";
import type { AgentEvent, AgentTask } from "@/lib/domain/agent";
import type { LearningAgentScope } from "@/lib/domain/learning-agent";
import type { LearningAgentTaskView } from "@/lib/client/learning-agent-api";
import { AgentStore } from "@/lib/server/agent/store";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { agentModelConfig } from "./agent-decision-config";
import { createAgentDecisionProvider } from "@/lib/server/agent/model";
import { AgentFailure } from "@/lib/server/agent/types";
import { LearningError, LearningRepository } from "./repository";
import { createLearningAgentScenario, readLearningAgentExplanation } from "./agent-scenario";
import { readLearningAgentScope } from "./agent-scope";
import { LearningAgentRepository } from "./agent-repository";
import { LearningQuizRepository } from "./quiz-repository";

export function openLearningAgentStore(learning: LearningRepository) {
  return AgentStore.open(join(learning.accountDataRoot, "agent-tasks.sqlite"));
}
export function learningAgentFailure(error: unknown): never {
  if (error instanceof AgentFailure) {
    if (error.message === "agent_answers_not_submitted") throw new LearningError(409, "agent_feedback_not_ready");
    const code = error.message === "agent_model_not_configured" ? "agent_not_configured"
      : error.code === "source_changed" ? "agent_source_changed"
      : error.code === "forbidden" ? "agent_not_found"
      : error.code === "invalid_action" ? "agent_event_conflict"
      : error.code === "unknown" ? "agent_unknown_outcome" : "agent_not_configured";
    throw new LearningError(error.code === "forbidden" ? 404 : error.code === "invalid_action" || error.code === "source_changed" ? 409 : 503, code);
  }
  throw error;
}
export function projectLearningAgentTask(learning: LearningRepository, task: AgentTask): LearningAgentTaskView {
  if (task.accountId !== learning.accountId) throw new LearningError(404, "agent_not_found");
  learning.get(task.resourceId);
  const scope = task.scope as LearningAgentScope;
  const base: LearningAgentTaskView = {
    id: task.id, goal: task.goal, scope: scope.selection, status: task.status, currentAction: task.currentAction,
    wait: task.wait ?? null, endReason: task.endReason,
    actions: task.actions.map(a => ({ id: a.id, tool: a.tool, status: a.status, resultRef: a.resultRef, summary: a.summary, reason: a.reason })),
    usage: task.usage,
    explanations: [], quizLinks: []
  };
  let current: ReturnType<typeof readLearningAgentScope>;
  try { current = readLearningAgentScope(learning, task.resourceId, task.scope); }
  catch {
    return { ...base, status: ["cancelled", "ended"].includes(base.status) ? base.status : "needs_attention",
      wait: null, currentAction: null, endReason: "授权来源已变化或不可用；旧解释不再作为证据，请重新选择范围开始任务。",
      actions: base.actions.map(a => ({ ...a, summary: "历史动作；来源已变化。", reason: undefined })) };
  }
  const quizzes = new LearningQuizRepository(learning);
  for (const artifact of new LearningAgentRepository(learning).list(task.resourceId, task.id)) {
    if (artifact.state !== "completed") continue;
    if (artifact.kind === "explanation") {
      const answer = readLearningAgentExplanation(learning, task, artifact.id);
      base.explanations!.push({ id: answer.id, text: [answer.materialAnswer,
        ...answer.supplements.map(s => `补充解释（材料外）：${s.text}`)].filter(Boolean).join("\n\n"), sources: answer.items.map(ref => ({ ...ref,
          parsed: current.materials.find(m => m.materialId === ref.materialId)?.paragraphs.find(p => p.number === ref.paragraph)?.parsed })) });
    } else {
      const ref = JSON.parse(artifact.body_json!) as { attemptId: string };
      try { quizzes.attempt(task.resourceId, ref.attemptId); base.quizLinks!.push({ quizId: artifact.id, attemptId: ref.attemptId }); }
      catch { /* Deleted quiz links are not restored from Agent receipts. */ }
    }
  }
  return base;
}

/** A request only schedules work. Waiting uses SQLite, not an open HTTP request. */
export async function advanceLearningAgent(accountDataRoot: string, accountId: string, taskId: string, event?: AgentEvent) {
  const learning = new LearningRepository(accountDataRoot, accountId);
  const store = openLearningAgentStore(learning);
  const runtime = new AgentRuntime({ store, checkpointPath: join(accountDataRoot, "agent-checkpoints.sqlite"),
    scenario: createLearningAgentScenario(learning), decision: createAgentDecisionProvider(agentModelConfig) });
  try { return await runtime.advance(accountId, taskId, event); }
  finally { runtime.close(); store.close(); learning.close(); }
}
