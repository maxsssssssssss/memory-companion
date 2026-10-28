import { createHash } from "node:crypto";
import type { AgentTask, AgentEvent } from "@/lib/domain/agent";
import { LearningCheckPurpose, LearningEvidenceProposal, LearningExplanationFeedback, LearningReviewPlanInput, StoredLearningReviewPlanInput, SavedLearningCompletionAssessment,
  type LearningCompletionAssessment, type LearningReviewPlan, type LearningObjectiveAssessment } from "@/lib/domain/learning-agent-completion";
import { findUnobservableLearningRequirements } from "@/lib/domain/learning-review-requirements";
import { AgentFailure, type AgentContext } from "@/lib/server/agent/types";
import { LearningError, type LearningRepository } from "./repository";
import { LearningAgentRepository, learningAgentOperationId, type LearningAgentArtifact } from "./agent-repository";
import { readLearningAgentScope } from "./agent-scope";
import { LearningQuizRepository } from "./quiz-repository";
import { inspectLearningExplanationContent } from "./agent-explanation-content";
import { projectPendingLearningHistory } from "./agent-completion-history";
import { evidenceRefKey, loadLearningCompletionEvidence } from "./agent-completion-evidence";
import type { QuizRepairContext } from "./quiz-review-purpose";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const version = (task: AgentTask) => task.version ?? 1;
const enabled = (task: AgentTask) => (task.scope as { completionVersion?: number })?.completionVersion === 1;
const planId = (task: AgentTask) => learningAgentOperationId(`${task.id}:${version(task)}`, "review_plan");
const parse = <T>(row: LearningAgentArtifact): T | null => row.state === "completed" && row.body_json ? JSON.parse(row.body_json) as T : null;
const limitations = ["作答与来源已按当前授权核对；目标与题目的关联包含模型判断，题目内容尚未经独立核验。", "当前表现只是本轮的暂定依据；没有记录应用内帮助，不证明现实中没有外部帮助。", "仅针对本轮约定目标，长期掌握未验证。"];
function scoped(learning: LearningRepository, task: AgentTask) {
  if (learning.accountId !== task.accountId) throw new LearningError(404, "agent_not_found");
  return readLearningAgentScope(learning, task.resourceId, task.scope);
}
function rows(learning: LearningRepository, task: AgentTask) {
  return new LearningAgentRepository(learning).list(task.resourceId, task.id).filter(r => r.task_version === version(task));
}
function save(learning: LearningRepository, task: AgentTask, kind: LearningAgentArtifact["kind"], key: string, body: unknown) {
  return learning.database.transaction(() => {
    const scope = scoped(learning, task), repository = new LearningAgentRepository(learning), id = learningAgentOperationId(`${task.id}:${version(task)}:${key}`, kind);
    const old = repository.reserve({ id, taskId: task.id, taskVersion: version(task), pageId: task.resourceId, kind,
      actionId: `completion:${kind}:${key}`, binding: scope.fingerprint, materialIds: scope.materials.map(m => m.materialId) });
    if (old) {
      if (old.state !== "completed" || old.body_json !== JSON.stringify(body)) throw new LearningError(409, "agent_completion_conflict");
      return id;
    }
    repository.complete(task.resourceId, task.id, id, body);
    return id;
  }).immediate();
}
export function readLearningReviewPlan(learning: LearningRepository, task: AgentTask): LearningReviewPlan | null {
  if (!enabled(task)) return null;
  const scope = scoped(learning, task), row = new LearningAgentRepository(learning).get(task.resourceId, task.id, planId(task));
  if (!row) return null;
  const plan = parse<LearningReviewPlan>(row);
  if (!plan || row.binding_hash !== scope.fingerprint || plan.taskVersion !== version(task) || plan.goal !== task.goal) throw new LearningError(409, "agent_completion_plan_stale");
  StoredLearningReviewPlanInput.parse({ kind: plan.kind, objectives: plan.objectives });
  return plan;
}
export function establishLearningReviewPlan(learning: LearningRepository, ctx: AgentContext, input: unknown,
  options?: { frozenSourcePlan?: LearningReviewPlan }): LearningReviewPlan {
  const scope = scoped(learning, ctx.task);
  const frozen = options?.frozenSourcePlan;
  const value = frozen ? StoredLearningReviewPlanInput.parse(input) : LearningReviewPlanInput.parse(input);
  if (frozen) {
    const withoutSources = (objectives: LearningReviewPlan["objectives"]) => objectives.map(({ sources: _sources, ...objective }) => objective);
    if (frozen.taskVersion !== version(ctx.task) - 1 || frozen.goal !== ctx.task.goal || frozen.kind !== value.kind
      || JSON.stringify(withoutSources(frozen.objectives)) !== JSON.stringify(withoutSources(value.objectives))) {
      throw new AgentFailure("known_failure", "agent_completion_source_adjustment_plan_changed");
    }
  }
  if (!enabled(ctx.task)) throw new AgentFailure("known_failure", "agent_completion_legacy_task", undefined, "此历史任务没有本轮完成计划；保留历史回顾，需要新的目标检查请开始新任务。");
  for (const objective of value.objectives) for (const ref of objective.sources) {
    if (!scope.materials.some(m => m.materialId === ref.materialId && m.paragraphs.some(p => p.number === ref.paragraph))) throw new AgentFailure("forbidden", "agent_completion_source_forbidden");
  }
  const plan: LearningReviewPlan = { ...value, schemaVersion: 1, taskVersion: version(ctx.task), sourceFingerprint: scope.fingerprint,
    goal: ctx.task.goal, proposedBy: "model", id: planId(ctx.task) };
  const repository = new LearningAgentRepository(learning), previous = readLearningReviewPlan(learning, ctx.task);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(plan)) throw new AgentFailure("known_failure", "agent_completion_plan_immutable_adjust_required", undefined, "本版本目标和检查要求已固定，不能降低或删除；请让用户调整本轮复习建立新版本。");
    return previous;
  }
  return learning.database.transaction(() => {
    const old = repository.reserve({ id: plan.id, taskId: ctx.task.id, taskVersion: version(ctx.task), pageId: ctx.task.resourceId, kind: "review_plan",
      actionId: `review-plan:${version(ctx.task)}`, binding: scope.fingerprint, materialIds: scope.materials.map(m => m.materialId) });
    if (old) throw new LearningError(409, "agent_completion_conflict");
    repository.complete(ctx.task.resourceId, ctx.task.id, plan.id, plan);
    return plan;
  }).immediate();
}
function collectProposals(learning: LearningRepository, task: AgentTask, plan: LearningReviewPlan, currentRows: LearningAgentArtifact[]) {
  const proposals = new Map<string, LearningEvidenceProposal>();
  const key = (p: LearningEvidenceProposal) => `${evidenceRefKey(p.ref)}:${p.objectiveId}:${p.role}`;
  const quizzes = new LearningQuizRepository(learning);
  for (const row of currentRows.filter(r => r.kind === "quiz" && r.state === "completed")) {
    const body = parse<{ attemptId: string }>(row);
    if (!body) continue;
    try {
      const review = quizzes.review(task.resourceId, row.id);
      if (!review || review.context.planId !== plan.id || review.context.taskVersion !== version(task)) continue;
      for (const check of review.checks) for (const objectiveId of check.objectiveIds) {
        const priorCandidates = [...proposals.values(), ...currentRows.filter(r => r.kind === "evidence_proposal").flatMap(r => {
          const proposal = parse<LearningEvidenceProposal>(r); return proposal ? [proposal] : [];
        })];
        const priorEvidenceRefs = review.context.purpose.priorEvidenceRefs.filter(ref => priorCandidates.some(p => p.objectiveId === objectiveId && evidenceRefKey(p.ref) === evidenceRefKey(ref)));
        const proposal: LearningEvidenceProposal = { ref: { quizId: row.id, attemptId: body.attemptId, questionIndex: check.questionIndex }, objectiveId,
          role: check.role, rationale: check.rationale, relevance: "supported",
          // Carry the actual declared predecessor through publication/filtering.
          // This remains a semantic proposal, never proof of transfer/correction.
          relation: check.role === "followup" && priorEvidenceRefs.length ? "followup" : "initial",
          priorEvidenceRefs: check.role === "followup" ? priorEvidenceRefs : [], contentStatus: "no_known_issue" };
        proposals.set(key(proposal), proposal);
      }
    } catch (error) { if (!(error instanceof LearningError)) throw error; }
  }
  for (const row of currentRows.filter(r => r.kind === "evidence_proposal")) {
    const value = parse<LearningEvidenceProposal>(row);
    if (!value) continue;
    const proposal = LearningEvidenceProposal.parse(value), previous = proposals.get(key(proposal));
    // A known substantive content problem cannot be erased by another model tag.
    proposals.set(key(proposal), previous?.contentStatus === "known_issue" ? { ...proposal, contentStatus: "known_issue" } : proposal);
  }
  const knownIssues = new Set([...proposals.values()].filter(p => p.contentStatus === "known_issue").map(p => evidenceRefKey(p.ref)));
  return [...proposals.values()].map(p => knownIssues.has(evidenceRefKey(p.ref)) ? { ...p, contentStatus: "known_issue" as const } : p);
}
export function recordLearningEvidenceProposal(learning: LearningRepository, ctx: AgentContext, input: unknown) {
  const proposal = LearningEvidenceProposal.parse(input), plan = readLearningReviewPlan(learning, ctx.task);
  if (!plan || !plan.objectives.some(o => o.id === proposal.objectiveId)) throw new AgentFailure("known_failure", "agent_completion_objective_invalid", undefined, "目的或证据引用了当前计划之外的目标，请读取当前计划并选择实际目标ID。");
  const scope = scoped(learning, ctx.task), proof = loadLearningCompletionEvidence(learning, ctx.task, plan, [proposal], scope)[0];
  if (proof.diagnosticCode === "plan_source_mismatch") throw new AgentFailure("known_failure", "agent_completion_plan_source_mismatch", undefined,
    "该作答已经保存，题目来源也在当前授权内，但与此目标已固定的来源段落不相交。这是目标与来源关联问题，不是未读取作答或学习困难；不能通过继续出题修复。请使用“调整本轮复习”核对目标和范围，在新版本读取原文后重新建立计划，保留原题、成绩及旧记录。");
  if (proof.diagnosticCode === "requirement_mismatch") throw new AgentFailure("known_failure", "agent_completion_requirement_mismatch", undefined,
    "本题实际作答要求不匹配该目标的具体检查要求。成员归属题不能作为元素个数计算证据；请回读题目与requirements，改为有依据的关联或保留不确定，不能靠主题相近计作覆盖。");
  if (proof.quality === "invalid" || proof.quality === "pending") throw new AgentFailure("known_failure", "agent_completion_evidence_invalid", undefined, "没有可用的已提交作答或当前授权来源，请先读取实际已完成题组；不可凭猜测关联。");
  // Prior references must exist in this goal's recorded evidence, not guessed IDs.
  const existing = collectProposals(learning, ctx.task, plan, rows(learning, ctx.task));
  for (const prior of proposal.priorEvidenceRefs) if (!existing.some(p => p.objectiveId === proposal.objectiveId && evidenceRefKey(p.ref) === evidenceRefKey(prior))) throw new AgentFailure("known_failure", "agent_completion_prior_evidence_invalid", undefined, "前序引用不是当前目标下已记录的实际证据，请先读取并关联已有作答。");
  save(learning, ctx.task, "evidence_proposal", ctx.actionId, proposal);
  return proposal;
}

/** Re-read this operation's authorized evidence, not another copy of the whole
 * current assessment. The decision observation owns that single current view. */
export function readLearningEvidenceReceipt(learning: LearningRepository, task: AgentTask, actionId: string) {
  const scope = scoped(learning, task), plan = readLearningReviewPlan(learning, task);
  const id = learningAgentOperationId(`${task.id}:${version(task)}:${actionId}`, "evidence_proposal");
  const row = new LearningAgentRepository(learning).get(task.resourceId, task.id, id);
  const proposal = row && parse<LearningEvidenceProposal>(row);
  if (!plan || !row || !proposal || row.task_version !== version(task) || row.binding_hash !== scope.fingerprint)
    throw new AgentFailure("forbidden", "agent_result_forbidden");
  const proof = loadLearningCompletionEvidence(learning, task, plan, [LearningEvidenceProposal.parse(proposal)], scope)[0];
  return { actionId, recorded: true, proposal,
    currentEvidence: { quality: proof.quality, eligible: proof.eligible, diagnosticCode: proof.diagnosticCode, reasons: proof.reasons },
    assessmentPath: "observation.completion" };
}
type PurposeRecord = { kind: "quiz" | "explanation"; resultId: string; purpose: LearningCheckPurpose; progressFingerprint: string; observationFingerprint?: string; actionId: string;
  failure?: { code: string; objectiveProgressFingerprint?: string; repair?: QuizRepairContext } };
type QuizRepairClaim = { recordType: "quiz_repair"; actionId: string; repair: QuizRepairContext };
export type DisputedQuizReplacement = { quizId: string; attemptId: string; eventId: string; purpose: LearningCheckPurpose };
type DisputedQuizReplacementClaim = { recordType: "disputed_quiz_replacement"; actionId: string;
  replacement: Omit<DisputedQuizReplacement, "purpose"> & { purposeKey: string } };
const purposeRecord = (row: LearningAgentArtifact) => {
  const value = parse<PurposeRecord | QuizRepairClaim | DisputedQuizReplacementClaim>(row);
  return value && !("recordType" in value) ? value : null;
};
// Method names, requested quantity, run IDs and feedback IDs cannot buy another
// correction. A genuinely different frozen check role retains its own purpose.
const quizRepairKey = (purpose: LearningCheckPurpose) => hash({ objectives: [...purpose.objectiveIds].sort(), role: purpose.role });
const replacementId = (task: AgentTask) => learningAgentOperationId(`${task.id}:disputed-quiz-replacement`, "check_purpose");
function replacementClaim(learning: LearningRepository, task: AgentTask) {
  return new LearningAgentRepository(learning).get(task.resourceId, task.id, replacementId(task));
}
/** A conservative explicit request, not an inference from dissatisfaction.
 * Negated/conditional/quoted requests do not authorize paid replacement. */
export function explicitlyRequestsQuizReplacement(message: string) {
  if (/不要|不用|不想|别|不需要|如果|假如|是否|要不要|[“”‘’「」"']/u.test(message)) return false;
  return /(?:换|更换|替换|重新出)(?:一|这|另|套|组|些|几|道|新的|新|个|题|目|练习|测试|\s){0,12}(?:题|练习)|换(?:一|另)组(?:继续|吧|题|练习|[。！!]|$)/u.test(message.trim());
}
function pendingDisputedReplacement(learning: LearningRepository, ctx: AgentContext, purpose: LearningCheckPurpose) {
  const event = ctx.event;
  if (!event || !["feedback", "quiz_dispute"].includes(event.kind) || (event.version ?? 1) !== version(ctx.task)
    || !explicitlyRequestsQuizReplacement(event.message ?? "") || replacementClaim(learning, ctx.task)) return;
  const scope = scoped(learning, ctx.task), artifacts = rows(learning, ctx.task);
  const purposes = artifacts.filter(row => row.kind === "check_purpose").map(purposeRecord);
  for (const row of [...artifacts].reverse()) {
    const body = row.kind === "quiz" && row.binding_hash === scope.fingerprint ? parse<{ attemptId: string; disputed?: boolean; disputeEventId?: string }>(row) : null;
    if (!body?.disputed || (event.kind === "quiz_dispute" && event.id !== body.disputeEventId)) continue;
    const record = purposes.find(p => p?.kind === "quiz" && !p.failure && p.resultId === row.id && quizRepairKey(p.purpose) === quizRepairKey(purpose));
    if (!record) continue;
    const quizzes = new LearningQuizRepository(learning);
    quizzes.assertSources(ctx.task.resourceId, row.id);
    const run = quizzes.list(ctx.task.resourceId).find(run => run.id === row.id), attempt = quizzes.attempt(ctx.task.resourceId, body.attemptId);
    if (run?.status !== "completed" || run.progress?.uncertain || attempt.quizId !== row.id) continue;
    return { quizId: row.id, attemptId: body.attemptId, eventId: event.id, purpose: record.purpose } satisfies DisputedQuizReplacement;
  }
}
/** Atomic task-wide allowance; no new version, event, or method name resets it.
 * This receipt contains only operation IDs, so source deletion cannot erase the
 * consumed allowance. Original disputed artifacts/grades remain untouched. */
export function claimLearningDisputedReplacement(learning: LearningRepository, ctx: AgentContext, replacement: DisputedQuizReplacement) {
  learning.database.transaction(() => {
    const current = pendingDisputedReplacement(learning, ctx, replacement.purpose);
    if (!current || JSON.stringify(current) !== JSON.stringify(replacement)) throw new AgentFailure("known_failure", "agent_disputed_replacement_unavailable");
    const repository = new LearningAgentRepository(learning), scope = scoped(learning, ctx.task), id = replacementId(ctx.task);
    repository.reserve({ id, taskId: ctx.task.id, taskVersion: version(ctx.task), pageId: ctx.task.resourceId, kind: "check_purpose",
      actionId: "disputed-quiz-replacement", binding: scope.fingerprint, materialIds: [] });
    const { purpose, ...identity } = replacement;
    repository.complete(ctx.task.resourceId, ctx.task.id, id, { recordType: "disputed_quiz_replacement", actionId: ctx.actionId,
      replacement: { ...identity, purposeKey: quizRepairKey(purpose) } } satisfies DisputedQuizReplacementClaim);
  }).immediate();
}
function repairClaim(learning: LearningRepository, task: AgentTask, purpose: LearningCheckPurpose) {
  const id = learningAgentOperationId(`${task.id}:${version(task)}:quiz-repair:${quizRepairKey(purpose)}`, "check_purpose");
  const row = new LearningAgentRepository(learning).get(task.resourceId, task.id, id);
  return row ? parse<QuizRepairClaim>(row) : null;
}
function repairableQuizFailure(learning: LearningRepository, ctx: AgentContext, purpose: LearningCheckPurpose, quizId: string, code: string): QuizRepairContext | undefined {
  const run = new LearningQuizRepository(learning).list(ctx.task.resourceId).find(run => run.id === quizId);
  if (!run || run.count !== 0 || run.progress?.uncertain || !["insufficient", "failed"].includes(run.status)) return;
  const rejected = run.delivery?.rejected ?? [];
  // Live-source/authorization failures and uncertain or budget outcomes are not
  // candidate corrections. Re-reading an invalid scope cannot authorize one.
  if (rejected.some(issue => ["unknown", "budget", "source_binding", "review_source_mismatch"].includes(issue.code))) return;
  const safe = rejected.filter(issue => issue.code !== "known_failure");
  if (!safe.length && code === "agent_generation_invalid_result") safe.push({ code: "format", count: 1 });
  if (!safe.length) return; // Empty output alone is not proof of a format defect.
  // A disputed replacement is itself the one recovery opportunity. Failure
  // cannot buy another automatic candidate-repair generation.
  const replacement = replacementClaim(learning, ctx.task);
  if (replacement && parse<DisputedQuizReplacementClaim>(replacement)?.actionId === ctx.actionId) return;
  return { attempt: 1, previousQuizId: quizId, purpose, rejected: safe };
}
/** Called once immediately before the repair's first generation request. The
 * immutable SQLite receipt is shared by automatic, feedback and explicit-retry
 * paths. A consumed action cannot resend by reusing its operation identity. */
export function claimLearningQuizRepair(learning: LearningRepository, ctx: AgentContext, repair: QuizRepairContext) {
  return learning.database.transaction(() => {
    scoped(learning, ctx.task);
    if (repairClaim(learning, ctx.task, repair.purpose)) throw new AgentFailure("known_failure", "agent_quiz_repair_already_used");
    save(learning, ctx.task, "check_purpose", `quiz-repair:${quizRepairKey(repair.purpose)}`,
      { recordType: "quiz_repair", actionId: ctx.actionId, repair } satisfies QuizRepairClaim);
  }).immediate();
}
// New usable feedback can justify one further purposeful action without being
// labelled learning success. Only this purpose's goals participate: unrelated
// feedback and repeated IDs with the same observation cannot unlock repetition.
const observationFingerprint = (assessment: LearningCompletionAssessment, objectiveIds: string[]) => hash(assessment.objectives.filter(o => objectiveIds.includes(o.id)).map(o => ({ id: o.id,
  observations: [...new Set(o.evidence.filter(e => e.eligible).map(e => `${e.role}:${e.correct}:${e.independentInApp}`))].sort() })));
const objectiveProgressFingerprint = (assessment: LearningCompletionAssessment, objectiveIds: string[]) => hash(assessment.objectives.filter(o => objectiveIds.includes(o.id))
  .map(o => ({ id: o.id, requirements: o.requirements.map(r => [r.role, r.supported]), resolved: o.explanationResolved, corrected: errorsCorrected(o) })));
export function recordLearningPurpose(learning: LearningRepository, ctx: AgentContext, kind: "quiz" | "explanation", purpose: LearningCheckPurpose | undefined, resultId: string,
  failure?: { code: string }) {
  if (!enabled(ctx.task) || !purpose) return;
  // A completed purpose and an explicitly retried failure keep separate immutable
  // receipts. This is an execution observation, never evidence of learning.
  const failed = failure ? { code: /^[a-z][a-z0-9_]{0,79}$/.test(failure.code) ? failure.code : "agent_generation_failed" } : undefined;
  const checkedPurpose = LearningCheckPurpose.parse(purpose);
  const existing = rows(learning, ctx.task).filter(r => r.kind === "check_purpose").map(purposeRecord)
    .find(r => r?.actionId === ctx.actionId && Boolean(r.failure) === Boolean(failed));
  if (existing) {
    if (existing.kind !== kind || existing.resultId !== resultId || JSON.stringify(existing.purpose) !== JSON.stringify(checkedPurpose)) throw new LearningError(409, "agent_completion_conflict");
    return existing.failure?.repair;
  }
  const assessment = assessLearningCompletion(learning, ctx.task);
  const record: PurposeRecord = { kind, resultId, purpose: checkedPurpose, progressFingerprint: assessment.progressFingerprint,
    observationFingerprint: observationFingerprint(assessment, checkedPurpose.objectiveIds), actionId: ctx.actionId,
    ...(failed ? { failure: { ...failed, objectiveProgressFingerprint: objectiveProgressFingerprint(assessment, checkedPurpose.objectiveIds),
      ...(kind === "quiz" ? { repair: repairableQuizFailure(learning, ctx, checkedPurpose, resultId, failed.code) } : {}) } } : {}) };
  save(learning, ctx.task, "check_purpose", `${ctx.actionId}${failed ? ":failed" : ""}`, record);
  return record.failure?.repair;
}
export function recordLearningExplanationContext(learning: LearningRepository, ctx: AgentContext, explanationId: string, purpose: LearningCheckPurpose | undefined) {
  recordLearningPurpose(learning, ctx, "explanation", purpose, explanationId);
}
type FeedbackRecord = { eventId: string; roundId: string; explanationId: string; outcome: "resolved" | "needs_clarification"; message?: string; objectiveIds: string[] };
/** Read explanation identity and source association from the saved business
 * result. The same check governs feedback acceptance and its GET projection;
 * an explanation's presence is not evidence that it belongs to this goal. */
function explanationAssociation(task: AgentTask, plan: LearningReviewPlan, scope: ReturnType<typeof scoped>, currentRows: LearningAgentArtifact[], explanationId: string) {
  const explanation = currentRows.find(r => r.id === explanationId && r.kind === "explanation" && r.state === "completed" && r.binding_hash === scope.fingerprint);
  const saved = explanation ? parse<{ materialAnswer?: string | null; supplements?: unknown[]; items?: Array<{ materialId: string; paragraph: number }>; reviewContext?: { planId: string; taskVersion: number; purpose: LearningCheckPurpose } }>(explanation) : null;
  if (!saved || !(saved.materialAnswer?.trim() || saved.supplements?.length)) return null;
  // An explicit stale context must not fall back to a separate purpose record.
  if (saved.reviewContext && (saved.reviewContext.planId !== plan.id || saved.reviewContext.taskVersion !== version(task))) return null;
  const rawPurpose = saved.reviewContext?.purpose ?? currentRows.filter(r => r.kind === "check_purpose")
    .map(purposeRecord).find(p => p?.kind === "explanation" && p.resultId === explanationId)?.purpose;
  const checked = LearningCheckPurpose.safeParse(rawPurpose);
  if (!checked.success || !saved.items?.length || !saved.items.every(ref => scope.materials.some(m => m.materialId === ref.materialId && m.paragraphs.some(p => p.number === ref.paragraph)))) return null;
  const purpose = checked.data;
  if (!purpose.objectiveIds.every(id => plan.objectives.some(o => o.id === id))) return null;
  const mismatchIds = purpose.objectiveIds.filter(id => !plan.objectives.find(o => o.id === id)!.sources.some(source => saved.items!.some(ref => ref.materialId === source.materialId && ref.paragraph === source.paragraph)));
  const sources = saved.items.map(ref => ({ ...ref, text: scope.materials.find(m => m.materialId === ref.materialId)!.paragraphs.find(p => p.number === ref.paragraph)!.text }));
  const content = inspectLearningExplanationContent(saved.materialAnswer, sources);
  return { explanationId, purpose, mismatchIds, content };
}
export function validateLearningExplanationFeedback(learning: LearningRepository, task: AgentTask, input: LearningExplanationFeedback, roundId = task.wait?.refId ?? input.explanationId) {
  const parsed = LearningExplanationFeedback.parse(input), scope = scoped(learning, task), currentRows = rows(learning, task), plan = readLearningReviewPlan(learning, task);
  const association = plan ? explanationAssociation(task, plan, scope, currentRows, parsed.explanationId) : null;
  if (!association || association.mismatchIds.length || (parsed.outcome === "resolved" && association.content.status === "known_issue")) throw new LearningError(409, "agent_completion_feedback_invalid");
  const old = currentRows.filter(r => r.kind === "explanation_feedback").map(r => parse<FeedbackRecord>(r)).find(f => f && (f.roundId ?? f.explanationId) === roundId);
  if (old && (old.explanationId !== parsed.explanationId || old.outcome !== parsed.outcome || (old.message ?? "") !== (parsed.message ?? ""))) throw new LearningError(409, "agent_completion_feedback_conflict");
  return { parsed, objectiveIds: association.purpose.objectiveIds, old, roundId };
}
export function recordExplanationFeedback(learning: LearningRepository, task: AgentTask, input: { eventId: string; roundId?: string; explanationId: string; outcome: "resolved" | "needs_clarification"; message?: string }) {
  const { parsed, objectiveIds, old, roundId } = validateLearningExplanationFeedback(learning, task, { explanationId: input.explanationId, outcome: input.outcome, ...(input.message !== undefined ? { message: input.message } : {}) }, input.roundId);
  if (old) return old;
  const record: FeedbackRecord = { eventId: input.eventId, roundId, ...parsed, objectiveIds };
  save(learning, task, "explanation_feedback", roundId, record);
  return record;
}
export function recordLearningExplanationFeedback(learning: LearningRepository, ctx: AgentContext, input: LearningExplanationFeedback) {
  if (ctx.event?.kind !== "explanation_feedback" || (ctx.event.version ?? 1) !== version(ctx.task) || !ctx.event.refId) throw new AgentFailure("forbidden", "agent_event_forbidden");
  return recordExplanationFeedback(learning, ctx.task, { eventId: ctx.event.id, roundId: ctx.event.refId, ...input });
}
function emptyAssessment(task: AgentTask, outcome: "legacy" | "stale" | "insufficient", headline: string): LearningCompletionAssessment {
  return { schemaVersion: 1, taskVersion: version(task), planId: null, sourceFingerprint: null, evidenceFingerprint: hash([version(task), outcome]), progressFingerprint: hash(outcome), plan: null,
    outcome, support: "not_assessed", objectives: [], canAutoFinish: false, pending: [], headline, stopReason: outcome === "stale" ? null : task.endReason ?? null, limitations, longTermMastery: "unverified" };
}
export function assessLearningCompletion(learning: LearningRepository, task: AgentTask, event?: AgentEvent): LearningCompletionAssessment {
  if (task.accountId !== learning.accountId) throw new LearningError(404, "agent_not_found");
  if (!enabled(task)) return emptyAssessment(task, "legacy", "这是此前的复习记录，未建立本轮目标检查计划，不补造通过结论。");
  let scope: ReturnType<typeof scoped>, plan: LearningReviewPlan | null;
  try { scope = scoped(learning, task); plan = readLearningReviewPlan(learning, task); }
  catch (error) { if (!(error instanceof LearningError)) throw error; return emptyAssessment(task, "stale", "当前目标、来源或授权已变化，完成依据需要更新。"); }
  if (!plan) return emptyAssessment(task, "insufficient", "正在明确本轮要检查的目标。");
  // Existing plans are immutable historical records. Detect the known planning
  // defect without dropping a requirement or converting it into a learner gap.
  const unobservableRequirements = findUnobservableLearningRequirements(plan);
  const currentRows = rows(learning, task), proposals = collectProposals(learning, task, plan, currentRows), evidence = loadLearningCompletionEvidence(learning, task, plan, proposals, scope);
  const explanations = currentRows.filter(r => r.kind === "explanation").map(r => explanationAssociation(task, plan, scope, currentRows, r.id)).filter((association): association is NonNullable<typeof association> => Boolean(association));
  const feedback = currentRows.filter(r => r.kind === "explanation_feedback").map(r => parse<FeedbackRecord>(r)).filter((r): r is FeedbackRecord => Boolean(r))
    .filter(record => explanations.some(explanation => explanation.explanationId === record.explanationId && explanation.mismatchIds.length === 0 && explanation.content.status !== "known_issue"
      && record.objectiveIds.length === explanation.purpose.objectiveIds.length && record.objectiveIds.every(id => explanation.purpose.objectiveIds.includes(id))));
  const objectives: LearningObjectiveAssessment[] = plan.objectives.map(objective => {
    const relevant = evidence.filter(e => e.objectiveId === objective.id), valid = relevant.filter(e => e.eligible);
    const relatedExplanations = explanations.filter(e => e.purpose.objectiveIds.includes(objective.id));
    const hasUsableExplanation = relatedExplanations.some(e => !e.mismatchIds.length && e.content.status !== "known_issue");
    const explanationResolved = feedback.filter(f => f.objectiveIds.includes(objective.id)).at(-1)?.outcome === "resolved";
    const errors = valid.filter(e => e.correct === false);
    const unresolvedErrors = errors.filter(error => !valid.some(later => later.correct === true && later.independentInApp && later.role === error.role && ["followup", "new_context"].includes(later.relation)
      && later.priorEvidenceRefs.some(ref => evidenceRefKey(ref) === evidenceRefKey(error.ref)) && later.firstSubmittedAt && error.firstSubmittedAt && later.firstSubmittedAt >= error.firstSubmittedAt
      && evidenceRefKey(later.ref) !== evidenceRefKey(error.ref))).map(e => e.ref);
    const unobservable = unobservableRequirements.filter(requirement => requirement.objectiveId === objective.id);
    // Only an explicit diagnosis can finish from observations regardless of
    // correctness. Practice uses the same evidence gate as other learning checks:
    // related independent support, not scores or a fixed number of rounds. A new
    // related check can resolve counterevidence without rewriting the old answer.
    const requirements = objective.requirements.map((requirement, index) => ({ role: requirement.role, description: requirement.description,
      supported: !unobservable.some(item => item.requirementIndex === index) && valid.some(e => e.role === requirement.role && (plan.kind === "diagnosis" || e.correct === true)
        && (!requirement.independent || e.independentInApp)
        && (requirement.role !== "followup" || ["followup", "new_context"].includes(e.relation))) }));
    const badEvidence = relevant.some(e => ["disputed", "known_issue", "uncertain", "invalid", "historical_unknown"].includes(e.quality)
      && !(e.quality === "invalid" && e.diagnosticCode === "requirement_mismatch"));
    const contentProblem = relatedExplanations.at(-1)?.content.status === "known_issue";
    const associationMismatch = relevant.some(e => e.diagnosticCode === "plan_source_mismatch") || explanations.some(explanation => explanation.mismatchIds.includes(objective.id));
    const supported = !associationMismatch && !contentProblem && !unobservable.length && (plan.kind === "explanation" ? explanationResolved : requirements.every(r => r.supported) && (plan.kind === "diagnosis" || unresolvedErrors.length === 0) && !badEvidence);
    const gaps = requirements.filter((r, index) => !r.supported && !unobservable.some(item => item.requirementIndex === index)).map(r => `尚缺：${r.description}`);
    if (unobservable.length) gaps.push("计划包含无法对应具体学习表现的流程要求，需要明确调整；这不是学生知识缺口，不能靠补题满足");
    if (plan.kind === "explanation" && !explanationResolved) gaps.push(hasUsableExplanation ? "还没有收到对相关解释的明确解决确认" : relatedExplanations.length ? "当前讲解存在关联或内容问题，需要先核对；不能确认解决" : "尚未生成当前版本的相关讲解；可先澄清必要信息或结合原文解释");
    if (contentProblem) gaps.push("讲解存在已识别的明确矛盾，不能作为解决依据；原文与讲解保留供核对");
    if (relevant.some(e => e.diagnosticCode === "requirement_mismatch")) gaps.push("有题目未覆盖所关联的具体检查要求，已排除该关联；这不是学生错答");
    if (unresolvedErrors.length && plan.kind !== "diagnosis") gaps.push("仍有反向表现尚未得到相关的新检查支持；不推定具体心理原因");
    if (associationMismatch) gaps.push("题目或解释与计划来源的关联需要核对；这是资料关联问题，不能当作学习困难继续补题");
    if (relevant.some(e => ["disputed", "known_issue", "uncertain", "historical_unknown"].includes(e.quality) || (e.quality === "invalid" && e.diagnosticCode !== "plan_source_mismatch"))) gaps.push("有来源、争议或语义问题尚不能用于当前判断");
    return { id: objective.id, label: objective.label, status: supported ? "supported" : badEvidence || associationMismatch || contentProblem || unobservable.length ? "uncertain" : valid.length ? "partial" : "unobserved",
      requirements, evidence: relevant, gaps, unresolvedErrors, explanationResolved,
      ...(plan.kind === "explanation" ? { explanationState: explanationResolved ? "resolved" as const : contentProblem || associationMismatch ? "needs_review" as const : hasUsableExplanation ? "available" as const : "missing" as const } : {}) };
  });
  // Only a source-only user correction with explicit history permission requires
  // prior same-task checks to be read and reassociated. No scores are inherited.
  const explicitProposals = currentRows.filter(r => r.kind === "evidence_proposal").map(r => parse<LearningEvidenceProposal>(r)).filter((p): p is LearningEvidenceProposal => Boolean(p));
  const historical = projectPendingLearningHistory(learning, task, plan, explicitProposals);
  const historyReview = historical.enabled ? { pending: historical.pending, blocked: historical.blocked,
    notice: historical.message ?? "来源更正后，需要先核对已授权的原作答，并重新确认它们与本轮目标的关联；此前的提示和错答不会自动清除。" } : undefined;
  const pending: string[] = [];
  if (historyReview && (historyReview.pending.length || historyReview.blocked)) pending.push("需要核对已授权的原作答与当前目标关联");
  if (hasPendingLearningFeedback(learning, task, event)) pending.push("有新的用户反馈需要处理");
  if (task.approval && ["pending", "approved"].includes(task.approval.status)) pending.push("等待处理笔记提案");
  if (task.recovery?.kind === "unknown") pending.push("有请求结果尚未确认");
  const quizzes = new LearningQuizRepository(learning);
  for (const row of currentRows.filter(r => r.kind === "quiz" && r.state === "completed")) {
    const body = parse<{ attemptId: string; disputed?: boolean }>(row);
    if (body?.disputed) { pending.push("题组疑问尚未处理"); continue; }
    try { if (body && !quizzes.attempt(task.resourceId, body.attemptId).completed) pending.push("等待实际作答"); }
    catch (error) { if (!(error instanceof LearningError)) throw error; pending.push("题组记录不可用"); }
  }
  if (task.wait?.kind === "feedback" && !(task.wait.refId ? feedback.some(f => (f.roundId ?? f.explanationId) === task.wait?.refId) : feedback.length > 0)) pending.push("等待新的用户反馈");
  const sufficient = !pending.includes("需要核对已授权的原作答与当前目标关联") && objectives.every(o => o.status === "supported") && !pending.some(p => p === "题组记录不可用" || p === "题组疑问尚未处理"), partial = objectives.some(o => o.status === "supported" || o.status === "partial");
  const outcome = sufficient ? plan.kind === "explanation" ? "explanation_resolved" : plan.kind === "diagnosis" ? "diagnosis_complete" : "check_passed" : partial ? "partial" : "insufficient";
  const mismatchIds = objectives.filter(o => o.evidence.some(e => e.diagnosticCode === "plan_source_mismatch") || explanations.some(explanation => explanation.mismatchIds.includes(o.id))).map(o => o.id);
  const technicalBlocker: LearningCompletionAssessment["technicalBlocker"] = mismatchIds.length ? {
    kind: "plan_source_mismatch", objectiveIds: mismatchIds,
    ...(explanations.some(explanation => explanation.mismatchIds.length) ? { explanationIds: explanations.filter(explanation => explanation.mismatchIds.length).map(explanation => explanation.explanationId) } : {}),
    message: "题目或解释来源与本轮计划的来源关联需要核对，已停止继续生成。这不代表你未学会；已有解释、作答、其他待检查项与题目疑问均保留。请使用“调整本轮复习”核对目标和范围，在新版本重新读取原文并建立计划；本版本目标与检查要求不自动改写。"
  } : unobservableRequirements.length ? {
    kind: "plan_requirement_unobservable", objectiveIds: [...new Set(unobservableRequirements.map(item => item.objectiveId))],
    message: "本轮计划包含无法对应具体学习表现的流程要求，已停止继续生成；这不代表你未学会。已有目标、要求、作答与反证保持原样，请使用“调整本轮复习”明确本轮要检查的知识表现，在新版本重新建立计划。不能仅更正来源、自动删除要求或降低标准来宣布通过。"
  } : undefined;
  const contentIssues = explanations.filter(e => e.content.status === "known_issue").map(e => ({ explanationId: e.explanationId,
    objectiveIds: e.purpose.objectiveIds, active: e.purpose.objectiveIds.some(id => explanations.filter(item => item.purpose.objectiveIds.includes(id)).at(-1)?.explanationId === e.explanationId), codes: e.content.issues.map(i => i.code), message: "这段讲解存在已识别的内容矛盾，暂不能确认疑问解决或保存为笔记。原文本保留，请结合所引原文核对。" }));
  const activeContentIssue = contentIssues.some(issue => issue.active);
  const headline = activeContentIssue ? "本轮讲解有明确矛盾，需要先核对，不能据此判断疑问已经解决。" : technicalBlocker?.kind === "plan_requirement_unobservable" ? "本轮检查要求需要明确，暂不判断通过，也不据此要求补题。" : technicalBlocker ? "本轮资料关联需要核对，暂不判断通过，也不据此要求补题。" : plan.kind === "explanation" && outcome !== "explanation_resolved" ? partial ? "部分疑问已明确解决，仍有疑问需要你的确认或进一步说明。" : objectives.some(o => o.explanationState === "available") ? "等待你确认本轮疑问是否已解决，或指出仍需说明的部分。" : "尚未生成当前版本的相关讲解；先明确疑问或结合原文说明。" : outcome === "check_passed" ? "本轮约定目标检查通过（基于当前暂定证据）。" : outcome === "explanation_resolved" ? "你已明确确认本轮疑问得到解决。" : outcome === "diagnosis_complete" ? "本轮约定诊断已完成；诊断完成不代表所有目标都会。" : outcome === "partial" ? "部分目标已有表现支持，仍有未覆盖或需要巩固的部分。" : "当前证据不足或存在问题，无法可靠给出本轮检查通过。";
  const progressFingerprint = hash(objectives.map(o => ({ id: o.id, requirements: o.requirements.map(r => [r.role, r.supported]), resolved: o.explanationResolved,
    // New question IDs/wrong scores do not count as progress. Only follow-up
    // support changes this signal; unresolved mistakes themselves are retained.
    corrected: errorsCorrected(o) })));
  return { schemaVersion: 1, taskVersion: version(task), planId: plan.id, sourceFingerprint: scope.fingerprint, plan,
    evidenceFingerprint: hash({ plan, evidence, explanations, feedback, pending }), progressFingerprint, outcome, support: sufficient ? "sufficient" : partial ? "partial" : "insufficient",
    objectives, canAutoFinish: sufficient && pending.length === 0 && !["cancelled", "paused", "budget_exhausted", "needs_attention"].includes(task.status), pending,
    headline, ...(historyReview ? { historyReview } : {}), ...(contentIssues.length ? { contentIssues } : {}), ...(technicalBlocker ? { technicalBlocker } : {}), stopReason: task.endReason ?? null, limitations, longTermMastery: "unverified" };
}
function errorsCorrected(objective: LearningObjectiveAssessment) {
  return objective.evidence.filter(e => e.eligible && e.correct === false && !objective.unresolvedErrors.some(ref => evidenceRefKey(ref) === evidenceRefKey(e.ref))).length;
}
export function persistLearningCompletion(learning: LearningRepository, task: AgentTask) {
  const assessment = assessLearningCompletion(learning, task);
  if (assessment.plan && assessment.outcome !== "stale") {
    const record = SavedLearningCompletionAssessment.parse({ schemaVersion: assessment.schemaVersion, taskVersion: assessment.taskVersion,
      planId: assessment.planId, sourceFingerprint: assessment.sourceFingerprint, evidenceFingerprint: assessment.evidenceFingerprint,
      progressFingerprint: assessment.progressFingerprint, outcome: assessment.outcome, support: assessment.support,
      objectives: assessment.objectives.map(o => ({ id: o.id, status: o.status, gaps: o.gaps, evidenceRefs: o.evidence.map(e => e.ref),
        unresolvedErrors: o.unresolvedErrors, explanationResolved: o.explanationResolved })), stopReason: assessment.stopReason, longTermMastery: assessment.longTermMastery });
    save(learning, task, "completion_assessment", hash(record), record);
  }
  return assessment;
}
export function guardLearningCompletionAction(learning: LearningRepository, ctx: AgentContext, kind: "quiz" | "explanation", input?: LearningCheckPurpose) {
  const assessment = assessLearningCompletion(learning, ctx.task);
  if (!enabled(ctx.task)) return { assessment, purpose: undefined };
  if (assessment.outcome === "stale") throw new AgentFailure("source_changed", "agent_completion_source_changed");
  if (!assessment.plan) throw new AgentFailure("known_failure", "agent_review_plan_required", undefined, "请先使用learning.establish_review_plan明确本轮目标；此前可以读取范围、导航、原文或请求澄清。");
  if (assessment.technicalBlocker) return { assessment, purpose: input, wait: assessment.technicalBlocker.message };
  if (assessment.canAutoFinish && !hasPendingLearningFeedback(learning, ctx.task, ctx.event)) return { assessment, purpose: input, stop: assessment.headline };
  if (kind === "quiz" && assessment.contentIssues?.some(issue => issue.active)) return { assessment, purpose: input, stop: "当前讲解有已知内容问题，本轮先交回核对；不能用继续出题掩盖该问题。" };
  if (kind === "quiz" && assessment.historyReview && (assessment.historyReview.blocked || assessment.historyReview.pending.length)) {
    if (assessment.historyReview.blocked) return { assessment, purpose: input, stop: assessment.historyReview.notice };
    throw new AgentFailure("known_failure", "agent_history_review_required", undefined,
      `${assessment.historyReview.notice} 先使用learning.read_answers读取已提交作答，再使用learning.associate_evidence逐题核对当前检查要求。`);
  }
  const parsed = LearningCheckPurpose.safeParse(input);
  if (!parsed.success) throw new AgentFailure("known_failure", "agent_check_purpose_required", undefined, "请补充purpose，明确本次目标ID、检查角度、方法及目的；不能无目的出题或解释。");
  const purpose = parsed.data;
  for (const id of purpose.objectiveIds) {
    const objective = assessment.objectives.find(o => o.id === id);
    if (!objective) throw new AgentFailure("known_failure", "agent_completion_objective_invalid", undefined, "目的或证据引用了当前计划之外的目标，请读取当前计划并选择实际目标ID。");
    if (objective.status === "supported" && purpose.method !== "evidence_review" && !(kind === "explanation" && purpose.method === "clarify" && hasPendingLearningFeedback(learning, ctx.task, ctx.event))) throw new AgentFailure("known_failure", "agent_objective_already_supported", undefined, "这一目标已有当前证据支持，请处理其他缺口或结束；有新疑问可先澄清，不能机械重复出题。");
  }
  for (const ref of purpose.priorEvidenceRefs) if (!assessment.objectives.some(o => purpose.objectiveIds.includes(o.id) && o.evidence.some(e => evidenceRefKey(e.ref) === evidenceRefKey(ref)))) throw new AgentFailure("known_failure", "agent_completion_prior_evidence_invalid", undefined, "前序引用不是当前目标下已记录的实际证据，请先读取并关联已有作答。");
  const recorded = rows(learning, ctx.task).filter(r => r.kind === "check_purpose").map(purposeRecord).filter((r): r is PurposeRecord => Boolean(r));
  const recoveredActions = new Set(recorded.filter(record => !record.failure).map(record => record.actionId));
  const previous = recorded.filter(record => !record.failure || !recoveredActions.has(record.actionId));
  const replacement = kind === "quiz" ? pendingDisputedReplacement(learning, ctx, purpose) : undefined;
  if (replacement) return { assessment, purpose: replacement.purpose, replacement };
  const currentObservations = observationFingerprint(assessment, purpose.objectiveIds);
  const currentProgress = objectiveProgressFingerprint(assessment, purpose.objectiveIds);
  const unchanged = (p: PurposeRecord) => (p.failure
    ? !p.failure.objectiveProgressFingerprint || p.failure.objectiveProgressFingerprint === currentProgress
    : p.progressFingerprint === assessment.progressFingerprint) && (!p.observationFingerprint || p.observationFingerprint === currentObservations);
  const correction = kind === "quiz" ? [...previous].reverse().find(record => record.kind === "quiz" && record.failure?.repair
    && quizRepairKey(record.purpose) === quizRepairKey(purpose) && unchanged(record)) : undefined;
  if (correction?.failure?.repair) {
    const claimed = repairClaim(learning, ctx.task, correction.purpose);
    if (!claimed) return { assessment, purpose: correction.purpose, repair: correction.failure.repair };
    // A saved success is read back by the normal artifact/recovery path. A spent
    // repair with no new observation never enables another Provider request,
    // including an explicit retry of that same failed operation.
    const completed = recorded.some(record => !record.failure && record.actionId === ctx.actionId);
    if (!completed) return { assessment, purpose, stop: "这次修正后仍未取得可靠的练习题，已经用过本轮这一检查目的的一次修复机会；这不是你的作答错误。已有内容与作答会保留，本轮先交回，不再重复生成。" };
  }
  // Failed generation produced no learner observation. Relabeling its role or
  // improving an unrelated objective must not unlock another identical method.
  const same = [...previous].reverse().find(p => p.actionId !== ctx.actionId && p.kind === kind && (p.failure || p.purpose.role === purpose.role) && p.purpose.method === purpose.method
    && [...p.purpose.objectiveIds].sort().join(",") === [...purpose.objectiveIds].sort().join(",") && unchanged(p));
  const clarification = pendingLearningExplanationClarification(learning, ctx.task, ctx.event);
  // One accepted, concrete explanation response can justify another explanation
  // even when the high-level method name is unchanged. It never unlocks Quiz
  // retries or declares learning progress. A completed handling action consumes
  // this event, so the next decision cannot spend it again.
  if (kind === "explanation" && clarification && previous.some(record => record.kind === "explanation"
    && !record.failure && record.resultId === clarification.explanationId
    && [...record.purpose.objectiveIds].sort().join(",") === [...purpose.objectiveIds].sort().join(","))) {
    validateLearningExplanationFeedback(learning, ctx.task, clarification, ctx.event!.refId);
    return { assessment, purpose };
  }
  // A repeated explanation is not a learner response. Preserve the first
  // opportunity to respond to the actual saved explanation instead of turning
  // the generation guard into terminal completion. Quiz failure protection and
  // the evidence/authorization checks above remain unchanged.
  const existingExplanationFeedback = (previous: PurposeRecord) => {
    if (kind !== "explanation" || previous.failure) return undefined;
    const scope = scoped(learning, ctx.task), currentRows = rows(learning, ctx.task);
    const association = explanationAssociation(ctx.task, assessment.plan!, scope, currentRows, previous.resultId);
    if (!association || association.mismatchIds.length || association.content.status === "known_issue") return undefined;
    return { explanationId: previous.resultId,
      message: "这段说明已经保存。还有哪里不清楚？你可以确认疑问已解决，或指出希望换个例子、进一步说明的地方。" };
  };
  const feedback = same ? existingExplanationFeedback(same) : undefined;
  if (feedback) return { assessment, purpose, feedback };
  if (same) return { assessment, purpose, stop: same.failure
    ? `${same.failure.code === "agent_quiz_insufficient" ? "上次生成未能提供满足发布条件的题目" : "上次生成明确失败，未取得可用结果"}，当前没有新的有效观察；这不是你的作答错误。已停止同类重复生成，本轮先交回核对生成问题，也可换用有明确区别的方法。`
    : "同一目标使用同类方法后尚无新的有效进展，本轮先交回；可调整目标或选择有明确区别的检查方法。" };
  const noProgress = previous.filter(p => p.actionId !== ctx.actionId && p.kind === kind && (p.failure || p.purpose.role === purpose.role)
    && [...p.purpose.objectiveIds].sort().join(",") === [...purpose.objectiveIds].sort().join(",") && unchanged(p)).at(-1);
  if (noProgress && noProgress.purpose.method !== purpose.method && (!purpose.methodChange || purpose.methodChange.previousResultId !== noProgress.resultId)) {
    const feedback = existingExplanationFeedback(noProgress);
    if (feedback) return { assessment, purpose, feedback };
    return { assessment, purpose, stop: noProgress.failure
      ? "上次未能生成可用的练习内容，这不是你的作答错误。仅更换方法名称不足以继续，因此没有再次出题；本轮先交回，已有学习内容与作答会保留。后续可以结合原文说明，或采用有明确区别的方法。"
      : "尚无新的有效进展；仅更换方法名称不足以继续，需要说明与前次的具体区别和希望观察到什么，或先交回。" };
  }
  return { assessment, purpose };
}

/** Accepted feedback gets one meaningful turn before a previous assessment can
 * stop. Explicit resolution uses its own fact gate; further clarification is
 * acknowledged after handling (including a completed unusable generation), so
 * one event cannot unlock repeated generation. */
export function hasPendingLearningFeedback(learning: LearningRepository, task: AgentTask, event?: AgentEvent) {
  if (!enabled(task) || !event || (event.version ?? 1) !== version(task)) return false;
  if (event.kind !== "feedback") {
    if (event.kind !== "explanation_feedback" || !event.message) return false;
    let input: unknown;
    try { input = JSON.parse(event.message); } catch { return false; }
    const parsed = LearningExplanationFeedback.safeParse(input);
    if (!parsed.success || parsed.data.outcome !== "needs_clarification") return false;
  }
  scoped(learning, task);
  return !rows(learning, task).some(r => r.kind === "completion_feedback" && parse<{ eventId: string }>(r)?.eventId === event.id);
}
export function pendingLearningExplanationClarification(learning: LearningRepository, task: AgentTask, event?: AgentEvent) {
  if (event?.kind !== "explanation_feedback" || !event.message || !hasPendingLearningFeedback(learning, task, event)) return undefined;
  let input: unknown;
  try { input = JSON.parse(event.message); } catch { return undefined; }
  const parsed = LearningExplanationFeedback.safeParse(input);
  return parsed.success && parsed.data.outcome === "needs_clarification" && parsed.data.message?.trim() ? parsed.data : undefined;
}
export function acknowledgeLearningFeedback(learning: LearningRepository, ctx: AgentContext) {
  if (!hasPendingLearningFeedback(learning, ctx.task, ctx.event)) return;
  save(learning, ctx.task, "completion_feedback", ctx.event!.id, { eventId: ctx.event!.id });
}
