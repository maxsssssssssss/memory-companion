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
import { LearningAgentRepository, learningAgentOperationId } from "./agent-repository";
import { readLearningAgentNotePreview } from "./agent-notes";
import { LearningQuizRepository } from "./quiz-repository";

export function openLearningAgentStore(learning: LearningRepository) {
  return AgentStore.open(join(learning.accountDataRoot, "agent-tasks.sqlite"));
}
export function openLearningAgentRuntime(learning: LearningRepository, store: AgentStore) {
  return new AgentRuntime({ store, checkpointPath: join(learning.accountDataRoot, "agent-checkpoints.sqlite"),
    scenario: createLearningAgentScenario(learning), decision: createAgentDecisionProvider(agentModelConfig) });
}
export function learningAgentFailure(error: unknown): never {
  if (error instanceof AgentFailure) {
    if (error.message === "agent_answers_not_submitted") throw new LearningError(409, "agent_feedback_not_ready");
    const code = error.message === "agent_model_not_configured" ? "agent_not_configured"
      : error.code === "source_changed" ? "agent_source_changed"
      : error.code === "forbidden" ? "agent_not_found"
      : error.code === "conflict" ? "agent_version_conflict"
      : error.code === "invalid_action" ? "agent_event_conflict"
      : error.code === "unknown" ? "agent_unknown_outcome"
      : error.code === "inactive" ? "agent_busy"
      : error.code === "budget" ? "agent_budget_exhausted"
      : error.code === "known_failure" ? "agent_known_failure" : "agent_not_configured";
    throw new LearningError(error.code === "forbidden" ? 404 : ["invalid_action", "source_changed", "conflict", "inactive", "budget", "known_failure", "unknown"].includes(error.code) ? 409 : 503, code);
  }
  throw error;
}
export function projectLearningAgentTask(learning: LearningRepository, task: AgentTask): LearningAgentTaskView {
  if (task.accountId !== learning.accountId) throw new LearningError(404, "agent_not_found");
  learning.get(task.resourceId);
  const scope = task.scope as LearningAgentScope;
  const terminal = ["cancelled", "ended", "budget_exhausted"].includes(task.status);
  const base: LearningAgentTaskView = {
    id: task.id, version: task.version ?? 1, goal: task.goal, scope: scope.selection, status: task.status, currentAction: task.currentAction,
    wait: task.wait ?? null, endReason: task.endReason,
    actions: task.actions.map(a => ({ id: a.id, version: a.version ?? 1, tool: a.tool, status: a.status,
      ...((a.version ?? 1) === (task.version ?? 1) ? { resultRef: a.resultRef, summary: a.summary, reason: a.reason }
        : { summary: "此前版本的历史操作；不作为当前范围的检查依据。" }) })),
    usage: task.usage, budget: task.budget, recovery: task.recovery,
    explanations: [], quizLinks: []
  };
  let current: ReturnType<typeof readLearningAgentScope>;
  try { current = readLearningAgentScope(learning, task.resourceId, task.scope); }
  catch {
    return { ...base, status: terminal ? base.status : "needs_attention",
      wait: null, currentAction: null, approval: undefined,
      recovery: terminal ? undefined : { kind: "source_invalid", message: "授权来源已变化或不可用，请重新确认当前学习页中的范围。", allowedControls: ["adjust", "cancel"] },
      endReason: terminal ? task.endReason : "授权来源已变化或不可用；旧解释不再作为证据，请调整本轮复习范围。",
      actions: base.actions.map(a => ({ ...a, summary: "历史动作；来源已变化。", reason: undefined })) };
  }
  // Finished tasks have no actionable proposal. Later edits to a former target
  // must not turn their persisted end state back into an attention request.
  if (!terminal && task.approval && task.approval.taskVersion === (task.version ?? 1)
    && ["pending", "approved"].includes(task.approval.status)) {
    try {
      const preview = readLearningAgentNotePreview(learning, task, learningAgentOperationId(task.approval.actionId, "note"));
      base.approval = { ...task.approval, target: preview.targetLabel, content: preview.content,
        sources: preview.sources, includesSupplement: preview.includesSupplement };
    } catch {
      // Never show or approve a snapshot after the target note/source changed.
      base.status = "needs_attention"; base.wait = null; base.currentAction = null;
      base.endReason = "待确认笔记的目标、正文或来源已变化；原确认不能继续使用。请重新确认本轮范围。";
      base.recovery = { kind: "source_invalid", message: base.endReason, allowedControls: ["adjust", "cancel"] };
    }
  }
  const quizzes = new LearningQuizRepository(learning);
  for (const artifact of new LearningAgentRepository(learning).list(task.resourceId, task.id)) {
    if (artifact.state !== "completed" || artifact.task_version !== (task.version ?? 1)) continue;
    if (artifact.kind === "explanation") {
      const answer = readLearningAgentExplanation(learning, task, artifact.id);
      base.explanations!.push({ id: answer.id, text: [answer.materialAnswer,
        ...answer.supplements.map(s => `补充解释（材料外）：${s.text}`)].filter(Boolean).join("\n\n"), sources: answer.items.map(ref => ({ ...ref,
          parsed: current.materials.find(m => m.materialId === ref.materialId)?.paragraphs.find(p => p.number === ref.paragraph)?.parsed })) });
    } else if (artifact.kind === "quiz") {
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
  const runtime = openLearningAgentRuntime(learning, store);
  try { return await runtime.advance(accountId, taskId, event); }
  finally { runtime.close(); store.close(); learning.close(); }
}
