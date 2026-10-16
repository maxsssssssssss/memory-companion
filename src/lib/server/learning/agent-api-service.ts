import { join } from "node:path";
import type { AgentEvent, AgentTask } from "@/lib/domain/agent";
import type { LearningAgentScope } from "@/lib/domain/learning-agent";
import type { LearningAgentTaskView } from "@/lib/client/learning-agent-api";
import { AgentStore } from "@/lib/server/agent/store";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { createLearningAgentDecisionProvider, withLearningCompletionDecision } from "./agent-context";
import { AgentFailure } from "@/lib/server/agent/types";
import { LearningError, LearningRepository } from "./repository";
import { createLearningAgentScenario, readLearningAgentExplanation } from "./agent-scenario";
import { readLearningAgentScope } from "./agent-scope";
import { LearningAgentRepository, learningAgentOperationId } from "./agent-repository";
import { readLearningAgentNotePreview } from "./agent-notes";
import { LearningQuizRepository } from "./quiz-repository";
import { projectLearningAgentReviewSummary, unavailableLearningAgentReviewSummary } from "./agent-review-summary";
import { assessLearningCompletion } from "./agent-completion";
import { LearningExplanationFeedback } from "@/lib/domain/learning-agent-completion";

export function openLearningAgentStore(learning: LearningRepository) {
  return AgentStore.open(join(learning.accountDataRoot, "agent-tasks.sqlite"));
}
export function openLearningAgentRuntime(learning: LearningRepository, store: AgentStore) {
  return new AgentRuntime({ store, checkpointPath: join(learning.accountDataRoot, "agent-checkpoints.sqlite"),
    scenario: createLearningAgentScenario(learning), decision: withLearningCompletionDecision(learning, createLearningAgentDecisionProvider()) });
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
export function projectLearningAgentTask(learning: LearningRepository, task: AgentTask, store?: AgentStore): LearningAgentTaskView {
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
    explanations: [], quizLinks: [], completion: assessLearningCompletion(learning, task, store?.latestEvent(learning.accountId, task.id))
  };
  let current: ReturnType<typeof readLearningAgentScope>;
  try { current = readLearningAgentScope(learning, task.resourceId, task.scope); }
  catch {
    return { ...base, status: terminal ? base.status : "needs_attention",
      wait: null, currentAction: null, approval: undefined,
      recovery: terminal ? undefined : { kind: "source_invalid", message: "授权来源已变化或不可用，请重新确认当前学习页中的范围。", allowedControls: ["adjust", "cancel"] },
      reviewSummary: terminal ? unavailableLearningAgentReviewSummary() : undefined,
      endReason: terminal
        ? scope.completionVersion === 1 ? "本轮已停止，已有记录保留；当前来源或授权已变化，原目标判断不再有效。" : task.endReason
        : "授权来源已变化或不可用；旧解释不再作为证据，请调整本轮复习范围。",
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
      const ref = JSON.parse(artifact.body_json!) as { attemptId: string; disputed?: boolean };
      try { const attempt = quizzes.attempt(task.resourceId, ref.attemptId); quizzes.assertSources(task.resourceId, artifact.id);
        base.quizLinks!.push({ quizId: artifact.id, attemptId: ref.attemptId, completed: attempt.completed, disputed: ref.disputed === true }); }
      catch { /* Deleted quiz links are not restored from Agent receipts. */ }
    }
  }
  // Re-associated, explicitly authorized history is navigable without making it
  // a current-task artifact or granting this task authority to alter its score.
  for (const evidence of base.completion?.objectives.flatMap(objective => objective.evidence) ?? []) {
    if (!evidence.submitted || evidence.quality === "invalid" || base.quizLinks!.some(link => link.quizId === evidence.ref.quizId)) continue;
    try {
      const attempt = quizzes.attempt(task.resourceId, evidence.ref.attemptId);
      quizzes.assertSources(task.resourceId, evidence.ref.quizId);
      if (attempt.quizId !== evidence.ref.quizId || !attempt.completed) continue;
      base.quizLinks!.push({ quizId: attempt.quizId, attemptId: attempt.id, completed: true,
        disputed: evidence.quality === "disputed", historical: true });
    } catch { /* A current permission/source check never restores an old link. */ }
  }
  const disputedAttempts = store ? (store.database.prepare("SELECT ref_id FROM agent_events WHERE task_id=? AND version=? AND event_kind='quiz_dispute'").all(task.id, task.version ?? 1) as Array<{ ref_id: string }>).map(row => row.ref_id) : [];
  base.reviewSummary = projectLearningAgentReviewSummary(learning, task, disputedAttempts);
  return base;
}

/** An explicit user response to a saved explanation at the current feedback
 * wait. A later wait can receive new feedback; an old receipt stays immutable. */
export async function submitLearningExplanationFeedback(learning: LearningRepository, store: AgentStore, taskId: string,
  input: { expectedVersion: number; eventId: string; explanationId: string; outcome: "resolved" | "needs_clarification"; message?: string }) {
  let task = store.assertVersion(learning.accountId, taskId, input.expectedVersion);
  const body = LearningExplanationFeedback.parse({ explanationId: input.explanationId, outcome: input.outcome,
    ...(input.message === undefined ? {} : { message: input.message }) });
  const message = JSON.stringify(body), byId = store.getEvent(learning.accountId, taskId, input.eventId);
  if (byId && (byId.kind !== "explanation_feedback" || byId.message !== message)) throw new AgentFailure("conflict", "agent_explanation_feedback_conflict");
  // A repeated successful click after the wait ended is a read-only receipt,
  // including when the transport supplied another event ID for the same body.
  if (!byId && (task.status !== "waiting" || task.wait?.kind !== "feedback")) {
    const old = store.database.prepare("SELECT event_json FROM agent_events WHERE task_id=? AND version=? AND event_kind='explanation_feedback' AND consumed=1 AND json_extract(event_json,'$.message')=? ORDER BY rowid DESC LIMIT 1")
      .get(task.id, input.expectedVersion, message) as { event_json: string } | undefined;
    if (old) return { task, scheduled: false };
  }
  const event: AgentEvent = byId ?? { id: input.eventId, kind: "explanation_feedback", refId: task.wait?.refId ?? body.explanationId,
    version: input.expectedVersion, message };
  const previous = store.acceptedEvent(learning.accountId, taskId, event);
  if (previous && previous.event.message !== event.message) throw new AgentFailure("conflict", "agent_explanation_feedback_conflict");
  if (previous?.consumed) return { task, scheduled: false };
  const runtime = openLearningAgentRuntime(learning, store);
  try { task = await runtime.submitEvent(learning.accountId, taskId, event, { expectedVersion: input.expectedVersion, defer: true }); }
  finally { runtime.close(); }
  const receipt = store.acceptedEvent(learning.accountId, taskId, event);
  if (!receipt) throw new AgentFailure("conflict", "agent_feedback_not_ready");
  return { task, scheduled: !receipt.consumed };
}

/** A request only schedules work. Waiting uses SQLite, not an open HTTP request. */
export async function advanceLearningAgent(accountDataRoot: string, accountId: string, taskId: string, event?: AgentEvent) {
  const learning = new LearningRepository(accountDataRoot, accountId);
  const store = openLearningAgentStore(learning);
  const runtime = openLearningAgentRuntime(learning, store);
  try { return await runtime.advance(accountId, taskId, event); }
  finally { runtime.close(); store.close(); learning.close(); }
}

/** One saved attempt has one business completion event, regardless of tabs or
 * transport retries. No model request is made while accepting this receipt. */
export async function syncLearningAgentQuiz(learning: LearningRepository, store: AgentStore, taskId: string,
  input: { expectedVersion: number; attemptId: string }) {
  let task = store.assertVersion(learning.accountId, taskId, input.expectedVersion);
  const event: AgentEvent = { id: learningAgentOperationId(task.id + ":" + input.expectedVersion + ":" + input.attemptId, "quiz_submission"),
    kind: "quiz_submission", refId: input.attemptId, version: input.expectedVersion };
  const receipt = store.acceptedEvent(learning.accountId, taskId, event);
  if (receipt) return { task, scheduled: !receipt.consumed };
  if (task.status !== "waiting" || task.wait?.kind !== "quiz_submission" || task.wait.refId !== input.attemptId) return { task, scheduled: false };
  const quiz = new LearningQuizRepository(learning), attempt = quiz.attempt(task.resourceId, input.attemptId);
  const artifact = new LearningAgentRepository(learning).get(task.resourceId, task.id, attempt.quizId);
  if (!artifact || artifact.task_version !== input.expectedVersion || artifact.kind !== "quiz" || artifact.state !== "completed"
    || JSON.parse(artifact.body_json!).attemptId !== input.attemptId) throw new AgentFailure("forbidden", "agent_event_forbidden");
  if (!attempt.completed || JSON.parse(artifact.body_json!).disputed) return { task, scheduled: false };
  const runtime = openLearningAgentRuntime(learning, store);
  try { task = await runtime.submitEvent(learning.accountId, taskId, event, { expectedVersion: input.expectedVersion, defer: true }); }
  finally { runtime.close(); }
  return { task, scheduled: !store.acceptedEvent(learning.accountId, taskId, event)?.consumed };
}

/** Quiz persistence succeeds independently of notification. A later explicit
 * sync/resume can recover a lost after() callback from the same saved attempt. */
export async function syncSavedLearningAgentQuiz(learning: LearningRepository, pageId: string, attemptId: string) {
  // Independent Quiz use must not create Agent task/checkpoint databases.
  if (!learning.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_agent_artifacts'").get()) return [];
  const owners = new LearningAgentRepository(learning).quizOwners(pageId, attemptId);
  if (!owners.length) return [];
  const store = openLearningAgentStore(learning);
  const scheduled: string[] = [];
  try {
    for (const owner of owners) {
      try {
        const task = store.getTask(learning.accountId, owner.task_id);
        if (task.scenario !== "learning.adaptive-review.v1" || task.version !== owner.task_version || task.resourceId !== pageId) continue;
        if ((await syncLearningAgentQuiz(learning, store, task.id, { expectedVersion: owner.task_version, attemptId })).scheduled) scheduled.push(task.id);
      } catch { /* Preserve the saved answer; authenticated task sync exposes recovery errors. */ }
    }
    return scheduled;
  } finally { store.close(); }
}

export async function disputeLearningAgentQuiz(learning: LearningRepository, store: AgentStore, taskId: string,
  input: { expectedVersion: number; attemptId: string; eventId: string; feedback: string }) {
  const event: AgentEvent = { id: input.eventId, kind: "quiz_dispute", refId: input.attemptId, version: input.expectedVersion, message: input.feedback };
  const accepted = store.acceptedEvent(learning.accountId, taskId, event);
  const runtime = openLearningAgentRuntime(learning, store);
  try {
    const task = await runtime.pauseForFeedback(learning.accountId, taskId, event, input.expectedVersion);
    const artifacts = new LearningAgentRepository(learning);
    artifacts.dispute(task.resourceId, task.id, input.attemptId);
    if (!accepted) artifacts.invalidateNotePreviews(task.resourceId, task.id);
    return task;
  } finally { runtime.close(); }
}
