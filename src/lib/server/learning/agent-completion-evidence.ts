import { createHash } from "node:crypto";
import type { AgentTask } from "@/lib/domain/agent";
import type { LearningCompletionEvidence, LearningEvidenceProposal, LearningEvidenceRef, LearningReviewPlan } from "@/lib/domain/learning-agent-completion";
import type { QuizAttemptView, QuizRunSummary, QuizConfig } from "@/lib/domain/learning-quiz";
import { LearningError, type LearningRepository } from "./repository";
import { LearningAgentRepository } from "./agent-repository";
import { LearningQuizRepository } from "./quiz-repository";
import { readLearningAgentScope } from "./agent-scope";

type Scope = ReturnType<typeof readLearningAgentScope>;
type QuizEvent = { action: string; question: number; at: string };
export const evidenceRefKey = (ref: LearningEvidenceRef) => `${ref.quizId}:${ref.attemptId}:${ref.questionIndex}`;
const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
/** Only exact normalized wording/options prove a known repeat. Changed numbers,
 * objects or wording never prove transfer; that remains a semantic proposal. */
export function learningQuestionIdentity(question: QuizAttemptView["questions"][number]) {
  return createHash("sha256").update(JSON.stringify([normalized(question.stem), question.options.map(o => normalized(o.text)).sort()])).digest("hex");
}
export function firstSubmissionFacts(attempt: QuizAttemptView, questionIndex: number, events: QuizEvent[]) {
  const question = attempt.questions[questionIndex];
  const first = events.findIndex(e => (e.action === "submit" && e.question === questionIndex) || (e.action === "finish" && question?.progress.submitted));
  const before = first < 0 ? events : events.slice(0, first);
  const timestamp = first < 0 ? null : events[first].at;
  const terminal = events.find(e => (e.question === questionIndex && ["submit", "skip", "reveal"].includes(e.action)) || e.action === "finish");
  return { firstSubmittedAt: timestamp, eventKnown: first >= 0,
    hinted: before.some(e => e.question === questionIndex && e.action === "hint") || Boolean(question?.progress.hinted),
    revealed: before.some(e => e.question === questionIndex && e.action === "reveal") || Boolean(question?.progress.revealed),
    // Post-submit feedback becomes available for FUTURE attempts only. It never
    // retroactively contaminates this attempt's first response.
    answerAvailableAt: attempt.mode === "practice" ? terminal?.at ?? null : attempt.completedAt };
}
function events(learning: LearningRepository, pageId: string, attemptId: string): QuizEvent[] {
  learning.get(pageId);
  const row = learning.database.prepare("SELECT events_json FROM learning_quiz_attempts WHERE page_id=? AND id=?").get(pageId, attemptId) as { events_json: string } | undefined;
  if (!row) return [];
  const value: unknown = JSON.parse(row.events_json);
  return Array.isArray(value) ? value.filter((e): e is QuizEvent => Boolean(e && typeof e === "object" && "action" in e && "question" in e && "at" in e)) : [];
}
function runAllowed(run: Pick<QuizRunSummary, "settings">, scope: Scope) {
  const settings = run.settings, allowed = scope.scope.selection;
  return !(settings.includeNotes && !allowed.includeNotes) && !(settings.includeSupplements && !allowed.includeSupplements)
    && settings.materialIds.every(id => allowed.materialIds.includes(id))
    && settings.chapterIds.every(id => allowed.chapterIds.includes(id))
    && settings.nodeIds.every(id => scope.navigation.some(c => c.nodes.some(n => n.id === id)));
}
export function loadLearningCompletionEvidence(learning: LearningRepository, task: AgentTask, plan: LearningReviewPlan, proposals: LearningEvidenceProposal[], scope: Scope): LearningCompletionEvidence[] {
  const quizzes = new LearningQuizRepository(learning), artifacts = new LearningAgentRepository(learning), rows = artifacts.list(task.resourceId, task.id);
  const currentOwnIds = new Set(rows.filter(r => r.kind === "quiz" && r.task_version === (task.version ?? 1)).map(r => r.id));
  const ownIds = new Set(rows.filter(r => r.kind === "quiz").map(r => r.id));
  // Do not even enumerate unrelated history without its explicit authorization.
  const allowedIds = [...currentOwnIds];
  const rawRuns = learning.database.prepare(`SELECT r.id,r.settings_json,r.status,a.id AS attemptId FROM learning_quiz_runs r LEFT JOIN learning_quiz_attempts a ON a.quiz_id=r.id
    WHERE r.page_id=? AND r.status='completed' ${scope.scope.selection.includeHistory ? "" : `AND r.id IN (${allowedIds.map(() => "?").join(",") || "NULL"})`}`)
    .all(task.resourceId, ...(scope.scope.selection.includeHistory ? [] : allowedIds)) as Array<{ id: string; settings_json: string; status: "completed"; attemptId: string | null }>;
  const runs = rawRuns.map(r => ({ ...r, settings: JSON.parse(r.settings_json) as QuizConfig })).filter(r => currentOwnIds.has(r.id) || runAllowed(r, scope));
  const snapshots = new Map<string, { run: { id: string; attemptId: string | null; settings: QuizConfig }; attempt: QuizAttemptView; events: QuizEvent[]; order: number }>();
  for (const run of runs) {
    if (!run.attemptId || run.status !== "completed") continue;
    try { quizzes.assertSources(task.resourceId, run.id); snapshots.set(run.id, { run, attempt: quizzes.attempt(task.resourceId, run.attemptId), events: events(learning, task.resourceId, run.attemptId), order: (learning.database.prepare("SELECT rowid AS n FROM learning_quiz_attempts WHERE id=? AND page_id=?").get(run.attemptId, task.resourceId) as { n: number }).n }); }
    catch (error) { if (!(error instanceof LearningError)) throw error; }
  }
  return proposals.map(proposal => {
    const { ref } = proposal, snapshot = snapshots.get(ref.quizId), question = snapshot?.attempt.questions[ref.questionIndex];
    const own = currentOwnIds.has(ref.quizId), historical = !own;
    const facts = snapshot ? firstSubmissionFacts(snapshot.attempt, ref.questionIndex, snapshot.events) : null;
    const reasons: string[] = [];
    const base: LearningCompletionEvidence = { ref, objectiveId: proposal.objectiveId, role: proposal.role,
      submitted: Boolean(question?.progress.submitted), correct: snapshot?.attempt.completed && question?.progress.submitted && question.feedback ? question.feedback.correct : null,
      firstSubmittedAt: facts?.firstSubmittedAt ?? null, hintedBeforeSubmission: facts?.hinted ?? false, revealedBeforeSubmission: facts?.revealed ?? false,
      skipped: question?.progress.skipped ?? false, answerAvailability: "unknown", repetition: "unknown", historical, quality: "invalid", eligible: false, independentInApp: false,
      reasons, rationale: "", relation: proposal.relation, semanticProvenance: "model_proposal", priorEvidenceRefs: proposal.priorEvidenceRefs, sources: [] };
    if (!snapshot || !question || snapshot.attempt.id !== ref.attemptId) { reasons.push("缺少当前授权内的完整作答记录"); return base; }
    if (!own && !scope.scope.selection.includeHistory) { reasons.push("未授权读取相关历史"); return base; }
    const ownRow = rows.find(r => r.id === ref.quizId && r.kind === "quiz");
    if (own && (ownRow?.state !== "completed" || ownRow.binding_hash !== scope.fingerprint)) { reasons.push("题组来源或版本已变化"); return base; }
    // All task-local disputes are authoritative. Authorized historical artifacts
    // can reveal a dispute; absence of a historical record is not a clean bill.
    const knownRows = learning.database.prepare("SELECT body_json FROM learning_agent_artifacts WHERE page_id=? AND account_id=? AND kind='quiz' AND id=? AND state='completed'")
      .all(task.resourceId, learning.accountId, ref.quizId) as Array<{ body_json: string | null }>;
    const disputed = knownRows.some(r => r.body_json && JSON.parse(r.body_json).disputed === true);
    const knownIssue = Boolean(learning.database.prepare(`SELECT 1 FROM learning_agent_artifacts WHERE page_id=? AND account_id=? AND kind='evidence_proposal' AND state='completed'
      AND json_extract(body_json,'$.ref.quizId')=? AND json_extract(body_json,'$.ref.attemptId')=? AND json_extract(body_json,'$.ref.questionIndex')=?
      AND json_extract(body_json,'$.contentStatus')='known_issue' ${scope.scope.selection.includeHistory ? "" : "AND task_id=?"} LIMIT 1`)
      .get(task.resourceId, learning.accountId, ref.quizId, ref.attemptId, ref.questionIndex, ...(scope.scope.selection.includeHistory ? [] : [task.id])));
    if (!snapshot.attempt.completed) {
      // A published, authorized question awaiting submission is not invalid
      // evidence. Keep it unobserved; neither answers nor mapping rationale are
      // released until the existing full-attempt reveal boundary is reached.
      base.quality = disputed ? "disputed" : knownIssue || proposal.contentStatus === "known_issue" ? "known_issue"
        : proposal.contentStatus === "uncertain" || proposal.relevance === "uncertain" ? "uncertain" : "pending";
      reasons.push(base.quality === "pending" ? "等待提交题组，尚不据此判断目标表现" : "题组存在需要处理的问题，暂不据此判断");
      return base;
    }
    const sources = question.feedback?.sources ?? [];
    const allowed = sources.length > 0 && sources.every(s => s.state === "available" && (s.kind === "material"
      ? scope.materials.some(m => m.materialId === s.materialId && m.paragraphs.some(p => p.number === s.paragraph && JSON.stringify(p.parsed) === JSON.stringify(s.parsed)))
      : s.kind === "note" ? scope.scope.selection.includeNotes : scope.scope.selection.includeSupplements));
    base.sources = sources.flatMap(s => s.kind === "material" ? [{ materialId: s.materialId, paragraph: s.paragraph, ...(s.parsed ? { parsed: s.parsed } : {}) }] : []);
    const objective = plan.objectives.find(o => o.id === proposal.objectiveId);
    if (!allowed || !objective || !base.sources.some(s => objective.sources.some(r => r.materialId === s.materialId && r.paragraph === s.paragraph))) { reasons.push("来源不支持当前授权中的目标关联"); return base; }
    base.rationale = proposal.rationale;
    base.quality = disputed ? "disputed" : (proposal.contentStatus === "known_issue" || knownIssue) ? "known_issue" : proposal.contentStatus === "uncertain" || proposal.relevance === "uncertain" ? "uncertain"
      : historical && !ownIds.has(ref.quizId) && !knownRows.length ? "historical_unknown" : "tentative";
    if (base.quality !== "tentative") reasons.push(base.quality === "disputed" ? "题组存在尚未解决的疑问" : base.quality === "known_issue" ? "已记录影响判断的题目问题" : "内容或语义关联尚不能可靠判断");
    const identity = learningQuestionIdentity(question);
    let repeated = proposal.relation === "repeat", exposed = facts?.revealed ?? false;
    for (const other of snapshots.values()) for (const old of other.attempt.questions) {
      if (other.attempt.id === ref.attemptId && old.index === ref.questionIndex) continue;
      if (learningQuestionIdentity(old) !== identity) continue;
      const oldFacts = firstSubmissionFacts(other.attempt, old.index, other.events);
      if (facts?.firstSubmittedAt && oldFacts.firstSubmittedAt && oldFacts.firstSubmittedAt < facts.firstSubmittedAt) repeated = true;
      // Equal millisecond timestamps are uncertain, and conservatively treat a
      // separate completed attempt as already available before this response.
      if (facts?.firstSubmittedAt && oldFacts.answerAvailableAt && (oldFacts.answerAvailableAt < facts.firstSubmittedAt || (oldFacts.answerAvailableAt === facts.firstSubmittedAt && other.order < snapshot.order))) { exposed = true; repeated = true; }
    }
    base.repetition = repeated ? "known_repeat" : facts?.eventKnown ? "not_known_repeat" : "unknown";
    base.answerAvailability = exposed ? "available_before_submission" : scope.scope.selection.includeHistory && facts?.eventKnown ? "not_observed_before_submission" : "unknown";
    base.independentInApp = Boolean(facts?.eventKnown && question.progress.submitted && !facts.hinted && !facts.revealed && !question.progress.skipped && !exposed && !repeated);
    if (facts?.hinted) reasons.push("首次提交前使用了提示");
    if (exposed) reasons.push("首次提交前相同题目的答案已可获得，不等于确认实际阅读");
    if (repeated) reasons.push("已知重复或订正，不能单独证明新检查或误解修正");
    if (!facts?.eventKnown) reasons.push("历史提交时序信息不足");
    if (!scope.scope.selection.includeHistory) reasons.push("未读取未授权历史，无法排除其他历史或应用外帮助");
    base.eligible = base.quality === "tentative" && Boolean(question.progress.submitted && !question.progress.skipped && !facts?.revealed);
    return base;
  });
}
