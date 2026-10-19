import { createHash } from "node:crypto";
import type { AgentTask } from "@/lib/domain/agent";
import type { LearningAgentScope } from "@/lib/domain/learning-agent";
import { LearningReviewPlanInput, type LearningEvidenceProposal, type LearningEvidenceRef, type LearningReviewPlan } from "@/lib/domain/learning-agent-completion";
import type { QuizConfig } from "@/lib/domain/learning-quiz";
import { LearningError, type LearningRepository } from "./repository";
import { LearningAgentRepository, type LearningAgentArtifact } from "./agent-repository";
import { LearningQuizRepository } from "./quiz-repository";
import { readLearningAgentScope } from "./agent-scope";
import { SavedQuizReview } from "./quiz-review-purpose";

export type PendingLearningHistory = {
  enabled: boolean;
  pending: Array<{ ref: LearningEvidenceRef; objectiveIds: string[]; read: boolean; unassociatedObjectiveIds: string[] }>;
  blocked: boolean;
  reason?: "source_unavailable" | "historical_record_unavailable" | "plan_mismatch" | "history_limit";
  message?: string;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unchangedObjectives = (plan: LearningReviewPlan) => plan.objectives.map(({ sources: _sources, ...objective }) => objective);
const none = (enabled = false): PendingLearningHistory => ({ enabled, pending: [], blocked: false });
const blocked = (reason: NonNullable<PendingLearningHistory["reason"]>): PendingLearningHistory => ({ enabled: true, pending: [], blocked: true, reason,
  message: "来源调整前的相关作答目前不能在本轮安全读取或重新关联，不能将缺少旧反证视为已纠正。请核对当前授权与来源，或诚实交回；不要据此继续补题。" });

/** Only an explicit source-only adjustment with history consent opens this
 * bounded queue. It carries business references, never copied scores, answer
 * text or inherited support. A real read receipt and a new semantic proposal
 * are both required; the normal evidence assessor still decides eligibility. */
export function projectPendingLearningHistory(learning: LearningRepository, task: AgentTask, plan: LearningReviewPlan,
  currentProposals: LearningEvidenceProposal[]): PendingLearningHistory {
  if (task.accountId !== learning.accountId) throw new LearningError(404, "agent_not_found");
  const rawScope = task.scope as LearningAgentScope, adjustment = rawScope.planSourceAdjustment;
  // Do not enumerate historical records before explicit current authorization.
  if (!rawScope.selection?.includeHistory || !adjustment) return none();
  let scope: ReturnType<typeof readLearningAgentScope>;
  try { scope = readLearningAgentScope(learning, task.resourceId, task.scope); }
  catch (error) { if (!(error instanceof LearningError)) throw error; return blocked("source_unavailable"); }
  const version = task.version ?? 1;
  if (adjustment.reason !== "user_confirmed_sources" || adjustment.previousVersion + 1 !== version
    || plan.taskVersion !== version || plan.goal !== task.goal || plan.sourceFingerprint !== scope.fingerprint) return blocked("plan_mismatch");
  const artifacts = new LearningAgentRepository(learning), previousRow = artifacts.get(task.resourceId, task.id, adjustment.previousPlanId);
  if (!previousRow || previousRow.kind !== "review_plan" || previousRow.state !== "completed"
    || previousRow.task_version !== adjustment.previousVersion || !previousRow.body_json) return blocked("plan_mismatch");
  const previous = JSON.parse(previousRow.body_json) as LearningReviewPlan;
  const shape = LearningReviewPlanInput.safeParse({ kind: previous.kind, objectives: previous.objectives });
  if (!shape.success || hash(previous) !== adjustment.previousPlanHash || previous.id !== adjustment.previousPlanId
    || previous.taskVersion !== adjustment.previousVersion || previous.goal !== task.goal || previous.kind !== plan.kind
    || JSON.stringify(unchangedObjectives(previous)) !== JSON.stringify(unchangedObjectives(plan))) return blocked("plan_mismatch");

  // Same-task earlier versions only. Repeating source correction must not hide
  // an unread earlier error. Each saved plan is checked before reading answers;
  // changed goals/standards are not silently promoted into the current plan.
  const oldRows = learning.database.prepare(`SELECT * FROM learning_agent_artifacts WHERE task_id=? AND page_id=? AND account_id=?
    AND task_version<=? AND kind='quiz' ORDER BY rowid LIMIT 51`).all(task.id, task.resourceId, learning.accountId, adjustment.previousVersion) as LearningAgentArtifact[];
  if (oldRows.length > 50) return blocked("history_limit");
  const quizzes = new LearningQuizRepository(learning), result = none(true);
  for (const row of oldRows) {
    if (row.state === "failed" || row.state === "reserved" || row.state === "unknown") continue;
    if (row.state !== "completed" || !row.body_json) return blocked("historical_record_unavailable");
    const body = JSON.parse(row.body_json) as { attemptId?: string };
    if (!body.attemptId) return blocked("historical_record_unavailable");
    try {
      const run = learning.database.prepare("SELECT settings_json,json_extract(result_json,'$.review') AS review_json FROM learning_quiz_runs WHERE page_id=? AND id=? AND status='completed'")
        .get(task.resourceId, row.id) as { settings_json: string; review_json: string | null } | undefined;
      if (!run) return blocked("historical_record_unavailable");
      const parsedReview = run.review_json ? SavedQuizReview.safeParse(JSON.parse(run.review_json)) : null;
      if (!parsedReview?.success) return blocked("historical_record_unavailable");
      const review = parsedReview.data;
      const historicalRow = artifacts.get(task.resourceId, task.id, review.context.planId);
      if (!historicalRow || historicalRow.kind !== "review_plan" || historicalRow.state !== "completed"
        || historicalRow.task_version !== row.task_version || !historicalRow.body_json || review.context.taskVersion !== row.task_version)
        return blocked("historical_record_unavailable");
      const historicalPlan = JSON.parse(historicalRow.body_json) as LearningReviewPlan;
      if (!LearningReviewPlanInput.safeParse({ kind: historicalPlan.kind, objectives: historicalPlan.objectives }).success
        || historicalPlan.id !== historicalRow.id || historicalPlan.taskVersion !== row.task_version) return blocked("historical_record_unavailable");
      if (review.context.objectives.some(objective => !historicalPlan.objectives.some(saved => JSON.stringify(saved) === JSON.stringify(objective)))
        || review.checks.some(check => check.role !== review.context.purpose.role || check.objectiveIds.some(id => !review.context.purpose.objectiveIds.includes(id))))
        return blocked("historical_record_unavailable");
      if (historicalPlan.goal !== plan.goal || historicalPlan.kind !== plan.kind
        || JSON.stringify(unchangedObjectives(historicalPlan)) !== JSON.stringify(unchangedObjectives(plan))) continue;
      const settings = JSON.parse(run.settings_json) as QuizConfig, allowed = scope.scope.selection;
      if ((settings.includeNotes && !allowed.includeNotes) || (settings.includeSupplements && !allowed.includeSupplements)
        || settings.materialIds.some(id => !allowed.materialIds.includes(id)) || settings.chapterIds.some(id => !allowed.chapterIds.includes(id))
        || settings.nodeIds.some(id => !scope.navigation.some(chapter => chapter.nodes.some(node => node.id === id)))) return blocked("source_unavailable");
      quizzes.assertSources(task.resourceId, row.id);
      const attempt = quizzes.attempt(task.resourceId, body.attemptId);
      if (attempt.quizId !== row.id) return blocked("historical_record_unavailable");
      // No pending answer, partial-test answer or its mapping is exposed here.
      if (!attempt.completed) continue;
      if (attempt.questions.some(question => question.progress.submitted && !review.checks.some(check => check.questionIndex === question.index)))
        return blocked("historical_record_unavailable");
      const read = task.actions.some(action => (action.version ?? 1) === version && action.status === "succeeded"
        && action.tool === "learning.read_answers" && action.resultRef?.kind === "learning.answers" && action.resultRef.id === attempt.id);
      for (const check of review.checks) {
        const question = attempt.questions[check.questionIndex];
        if (!question || !question.progress.submitted) continue;
        const sources = question.feedback?.sources ?? [];
        if (!sources.length || !sources.every(source => source.state === "available" && (source.kind === "material"
          ? scope.materials.some(material => material.materialId === source.materialId && material.paragraphs.some(paragraph => paragraph.number === source.paragraph && JSON.stringify(paragraph.parsed) === JSON.stringify(source.parsed)))
          : source.kind === "note" ? allowed.includeNotes : allowed.includeSupplements))) return blocked("source_unavailable");
        const objectiveIds = check.objectiveIds.filter(id => plan.objectives.some(objective => objective.id === id));
        if (objectiveIds.length !== check.objectiveIds.length) return blocked("historical_record_unavailable");
        const ref = { quizId: row.id, attemptId: attempt.id, questionIndex: check.questionIndex };
        const unassociatedObjectiveIds = objectiveIds.filter(id => !currentProposals.some(proposal => proposal.objectiveId === id
          && proposal.ref.quizId === ref.quizId && proposal.ref.attemptId === ref.attemptId && proposal.ref.questionIndex === ref.questionIndex));
        if (!read || unassociatedObjectiveIds.length) result.pending.push({ ref, objectiveIds, read, unassociatedObjectiveIds });
        if (result.pending.length > 200) return blocked("history_limit");
      }
    } catch (error) { if (!(error instanceof LearningError)) throw error; return blocked("historical_record_unavailable"); }
  }
  return result;
}
