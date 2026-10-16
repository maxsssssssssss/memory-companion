import { createHash } from "node:crypto";
import type { AgentTask, AgentEvent } from "@/lib/domain/agent";
import { LearningCheckPurpose, LearningEvidenceProposal, LearningExplanationFeedback, LearningReviewPlanInput, SavedLearningCompletionAssessment,
  type LearningCompletionAssessment, type LearningReviewPlan, type LearningObjectiveAssessment } from "@/lib/domain/learning-agent-completion";
import { AgentFailure, type AgentContext } from "@/lib/server/agent/types";
import { LearningError, type LearningRepository } from "./repository";
import { LearningAgentRepository, learningAgentOperationId, type LearningAgentArtifact } from "./agent-repository";
import { readLearningAgentScope } from "./agent-scope";
import { LearningQuizRepository } from "./quiz-repository";
import { evidenceRefKey, loadLearningCompletionEvidence } from "./agent-completion-evidence";

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
  LearningReviewPlanInput.parse({ kind: plan.kind, objectives: plan.objectives });
  return plan;
}
export function establishLearningReviewPlan(learning: LearningRepository, ctx: AgentContext, input: unknown): LearningReviewPlan {
  const scope = scoped(learning, ctx.task), value = LearningReviewPlanInput.parse(input);
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
        const proposal: LearningEvidenceProposal = { ref: { quizId: row.id, attemptId: body.attemptId, questionIndex: check.questionIndex }, objectiveId,
          role: check.role, rationale: check.rationale, relevance: "supported", relation: "initial", priorEvidenceRefs: [], contentStatus: "no_known_issue" };
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
  if (proof.quality === "invalid" || proof.quality === "pending") throw new AgentFailure("known_failure", "agent_completion_evidence_invalid", undefined, "没有可用的已提交作答或当前授权来源，请先读取实际已完成题组；不可凭猜测关联。");
  // Prior references must exist in this goal's recorded evidence, not guessed IDs.
  const existing = collectProposals(learning, ctx.task, plan, rows(learning, ctx.task));
  for (const prior of proposal.priorEvidenceRefs) if (!existing.some(p => p.objectiveId === proposal.objectiveId && evidenceRefKey(p.ref) === evidenceRefKey(prior))) throw new AgentFailure("known_failure", "agent_completion_prior_evidence_invalid", undefined, "前序引用不是当前目标下已记录的实际证据，请先读取并关联已有作答。");
  save(learning, ctx.task, "evidence_proposal", ctx.actionId, proposal);
  return proposal;
}
type PurposeRecord = { kind: "quiz" | "explanation"; resultId: string; purpose: LearningCheckPurpose; progressFingerprint: string; actionId: string };
export function recordLearningPurpose(learning: LearningRepository, ctx: AgentContext, kind: "quiz" | "explanation", purpose: LearningCheckPurpose | undefined, resultId: string) {
  if (!enabled(ctx.task) || !purpose) return;
  const checkedPurpose = LearningCheckPurpose.parse(purpose);
  const existing = rows(learning, ctx.task).filter(r => r.kind === "check_purpose").map(r => parse<PurposeRecord>(r)).find(r => r?.actionId === ctx.actionId);
  if (existing) {
    if (existing.kind !== kind || existing.resultId !== resultId || JSON.stringify(existing.purpose) !== JSON.stringify(checkedPurpose)) throw new LearningError(409, "agent_completion_conflict");
    return;
  }
  const assessment = assessLearningCompletion(learning, ctx.task);
  const record: PurposeRecord = { kind, resultId, purpose: LearningCheckPurpose.parse(purpose), progressFingerprint: assessment.progressFingerprint, actionId: ctx.actionId };
  save(learning, ctx.task, "check_purpose", ctx.actionId, record);
}
export function recordLearningExplanationContext(learning: LearningRepository, ctx: AgentContext, explanationId: string, purpose: LearningCheckPurpose | undefined) {
  recordLearningPurpose(learning, ctx, "explanation", purpose, explanationId);
}
type FeedbackRecord = { eventId: string; roundId: string; explanationId: string; outcome: "resolved" | "needs_clarification"; message?: string; objectiveIds: string[] };
export function validateLearningExplanationFeedback(learning: LearningRepository, task: AgentTask, input: LearningExplanationFeedback, roundId = task.wait?.refId ?? input.explanationId) {
  const parsed = LearningExplanationFeedback.parse(input), scope = scoped(learning, task), currentRows = rows(learning, task), plan = readLearningReviewPlan(learning, task);
  const explanation = currentRows.find(r => r.id === parsed.explanationId && r.kind === "explanation" && r.state === "completed" && r.binding_hash === scope.fingerprint);
  const saved = explanation ? parse<{ materialAnswer?: string | null; supplements?: unknown[]; items?: Array<{ materialId: string; paragraph: number }>; reviewContext?: { planId: string; taskVersion: number; purpose: LearningCheckPurpose } }>(explanation) : null;
  const purpose = saved?.reviewContext?.planId === plan?.id && saved?.reviewContext?.taskVersion === version(task) ? saved.reviewContext.purpose
    : currentRows.filter(r => r.kind === "check_purpose").map(r => parse<PurposeRecord>(r)).find(p => p?.kind === "explanation" && p.resultId === parsed.explanationId)?.purpose;
  if (!plan || !explanation || !purpose || !(saved?.materialAnswer?.trim() || saved?.supplements?.length) || !purpose.objectiveIds.every(id => plan.objectives.some(o => o.id === id && o.sources.some(s => saved?.items?.some(ref => ref.materialId === s.materialId && ref.paragraph === s.paragraph))))) throw new LearningError(409, "agent_completion_feedback_invalid");
  const old = currentRows.filter(r => r.kind === "explanation_feedback").map(r => parse<FeedbackRecord>(r)).find(f => f && (f.roundId ?? f.explanationId) === roundId);
  if (old && (old.explanationId !== parsed.explanationId || old.outcome !== parsed.outcome || (old.message ?? "") !== (parsed.message ?? ""))) throw new LearningError(409, "agent_completion_feedback_conflict");
  return { parsed, objectiveIds: purpose.objectiveIds, old, roundId };
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
  const currentRows = rows(learning, task), proposals = collectProposals(learning, task, plan, currentRows), evidence = loadLearningCompletionEvidence(learning, task, plan, proposals, scope);
  const feedback = currentRows.filter(r => r.kind === "explanation_feedback").map(r => parse<FeedbackRecord>(r)).filter((r): r is FeedbackRecord => Boolean(r));
  const objectives: LearningObjectiveAssessment[] = plan.objectives.map(objective => {
    const relevant = evidence.filter(e => e.objectiveId === objective.id), valid = relevant.filter(e => e.eligible);
    const explanationResolved = feedback.filter(f => f.objectiveIds.includes(objective.id)).at(-1)?.outcome === "resolved";
    const errors = valid.filter(e => e.correct === false);
    const unresolvedErrors = errors.filter(error => !valid.some(later => later.correct === true && later.independentInApp && later.role === error.role && ["followup", "new_context"].includes(later.relation)
      && later.priorEvidenceRefs.some(ref => evidenceRefKey(ref) === evidenceRefKey(error.ref)) && later.firstSubmittedAt && error.firstSubmittedAt && later.firstSubmittedAt >= error.firstSubmittedAt
      && evidenceRefKey(later.ref) !== evidenceRefKey(error.ref))).map(e => e.ref);
    const requirements = objective.requirements.map(requirement => ({ role: requirement.role, description: requirement.description,
      supported: valid.some(e => e.role === requirement.role && (plan.kind === "diagnosis" || e.correct === true)
        && (!requirement.independent || e.independentInApp)
        && (requirement.role !== "followup" || ["followup", "new_context"].includes(e.relation))) }));
    const badEvidence = relevant.some(e => ["disputed", "known_issue", "uncertain", "invalid", "historical_unknown"].includes(e.quality));
    const associationMismatch = relevant.some(e => e.diagnosticCode === "plan_source_mismatch");
    const supported = !associationMismatch && (plan.kind === "explanation" ? explanationResolved : requirements.every(r => r.supported) && (plan.kind === "diagnosis" || unresolvedErrors.length === 0) && !badEvidence);
    const gaps = requirements.filter(r => !r.supported).map(r => `尚缺：${r.description}`);
    if (plan.kind === "explanation" && !explanationResolved) gaps.push("还没有收到对相关解释的明确解决确认");
    if (unresolvedErrors.length && plan.kind !== "diagnosis") gaps.push("仍有反向表现尚未得到相关的新检查支持；不推定具体心理原因");
    if (associationMismatch) gaps.push("题目与计划来源的关联需要核对；这是资料关联问题，不能当作学习困难继续补题");
    if (relevant.some(e => ["disputed", "known_issue", "uncertain", "historical_unknown"].includes(e.quality) || (e.quality === "invalid" && e.diagnosticCode !== "plan_source_mismatch"))) gaps.push("有来源、争议或语义问题尚不能用于当前判断");
    return { id: objective.id, label: objective.label, status: supported ? "supported" : badEvidence ? "uncertain" : valid.length ? "partial" : "unobserved",
      requirements, evidence: relevant, gaps, unresolvedErrors, explanationResolved };
  });
  const pending: string[] = [];
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
  const sufficient = objectives.every(o => o.status === "supported") && !pending.some(p => p === "题组记录不可用" || p === "题组疑问尚未处理"), partial = objectives.some(o => o.status === "supported" || o.status === "partial");
  const outcome = sufficient ? plan.kind === "explanation" ? "explanation_resolved" : plan.kind === "diagnosis" ? "diagnosis_complete" : "check_passed" : partial ? "partial" : "insufficient";
  const mismatchIds = objectives.filter(o => o.evidence.some(e => e.diagnosticCode === "plan_source_mismatch")).map(o => o.id);
  const technicalBlocker: LearningCompletionAssessment["technicalBlocker"] = mismatchIds.length ? {
    kind: "plan_source_mismatch", objectiveIds: mismatchIds,
    message: "题目来源与本轮计划的来源关联需要核对，已停止继续出题。这不代表你未学会；已有作答、其他待检查项与题目疑问均保留。请使用“调整本轮复习”核对目标和范围，在新版本重新读取原文并建立计划；本版本目标与检查要求不自动改写。"
  } : undefined;
  const headline = technicalBlocker ? "本轮资料关联需要核对，暂不判断通过，也不据此要求补题。" : plan.kind === "explanation" && outcome !== "explanation_resolved" ? partial ? "部分疑问已明确解决，仍有疑问需要你的确认或进一步说明。" : "等待你确认本轮疑问是否已解决，或指出仍需说明的部分。" : outcome === "check_passed" ? "本轮约定目标检查通过（基于当前暂定证据）。" : outcome === "explanation_resolved" ? "你已明确确认本轮疑问得到解决。" : outcome === "diagnosis_complete" ? "本轮约定诊断已完成；诊断完成不代表所有目标都会。" : outcome === "partial" ? "部分目标已有表现支持，仍有未覆盖或需要巩固的部分。" : "当前证据不足或存在问题，无法可靠给出本轮检查通过。";
  const progressFingerprint = hash(objectives.map(o => ({ id: o.id, requirements: o.requirements.map(r => [r.role, r.supported]), resolved: o.explanationResolved,
    // New question IDs/wrong scores do not count as progress. Only follow-up
    // support changes this signal; unresolved mistakes themselves are retained.
    corrected: errorsCorrected(o) })));
  return { schemaVersion: 1, taskVersion: version(task), planId: plan.id, sourceFingerprint: scope.fingerprint, plan,
    evidenceFingerprint: hash({ plan, evidence, feedback, pending }), progressFingerprint, outcome, support: sufficient ? "sufficient" : partial ? "partial" : "insufficient",
    objectives, canAutoFinish: sufficient && pending.length === 0 && !["cancelled", "paused", "budget_exhausted", "needs_attention"].includes(task.status), pending,
    headline, ...(technicalBlocker ? { technicalBlocker } : {}), stopReason: task.endReason ?? null, limitations, longTermMastery: "unverified" };
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
  const parsed = LearningCheckPurpose.safeParse(input);
  if (!parsed.success) throw new AgentFailure("known_failure", "agent_check_purpose_required", undefined, "请补充purpose，明确本次目标ID、检查角度、方法及目的；不能无目的出题或解释。");
  const purpose = parsed.data;
  for (const id of purpose.objectiveIds) {
    const objective = assessment.objectives.find(o => o.id === id);
    if (!objective) throw new AgentFailure("known_failure", "agent_completion_objective_invalid", undefined, "目的或证据引用了当前计划之外的目标，请读取当前计划并选择实际目标ID。");
    if (objective.status === "supported" && purpose.method !== "evidence_review" && !(kind === "explanation" && purpose.method === "clarify" && hasPendingLearningFeedback(learning, ctx.task, ctx.event))) throw new AgentFailure("known_failure", "agent_objective_already_supported", undefined, "这一目标已有当前证据支持，请处理其他缺口或结束；有新疑问可先澄清，不能机械重复出题。");
  }
  for (const ref of purpose.priorEvidenceRefs) if (!assessment.objectives.some(o => purpose.objectiveIds.includes(o.id) && o.evidence.some(e => evidenceRefKey(e.ref) === evidenceRefKey(ref)))) throw new AgentFailure("known_failure", "agent_completion_prior_evidence_invalid", undefined, "前序引用不是当前目标下已记录的实际证据，请先读取并关联已有作答。");
  const previous = rows(learning, ctx.task).filter(r => r.kind === "check_purpose").map(r => parse<PurposeRecord>(r)).filter((r): r is PurposeRecord => Boolean(r));
  const same = previous.find(p => p.actionId !== ctx.actionId && p.kind === kind && p.purpose.role === purpose.role && p.purpose.method === purpose.method
    && [...p.purpose.objectiveIds].sort().join(",") === [...purpose.objectiveIds].sort().join(",") && p.progressFingerprint === assessment.progressFingerprint);
  if (same) return { assessment, purpose, stop: "同一目标使用同类方法后尚无新的有效进展，本轮先交回；可调整目标或选择有明确区别的检查方法。" };
  const noProgress = previous.filter(p => p.actionId !== ctx.actionId && p.kind === kind && p.purpose.role === purpose.role
    && [...p.purpose.objectiveIds].sort().join(",") === [...purpose.objectiveIds].sort().join(",") && p.progressFingerprint === assessment.progressFingerprint).at(-1);
  if (noProgress && noProgress.purpose.method !== purpose.method && (!purpose.methodChange || purpose.methodChange.previousResultId !== noProgress.resultId))
    return { assessment, purpose, stop: "尚无新的有效进展；仅更换方法名称不足以继续，需要说明与前次的具体区别和希望观察到什么，或先交回。" };
  return { assessment, purpose };
}

/** An accepted free-text feedback event gets one meaningful turn before a
 * previous assessment can automatically stop. Tool acknowledgement occurs only
 * after success, so a crash/prepared replay cannot silently consume it. */
export function hasPendingLearningFeedback(learning: LearningRepository, task: AgentTask, event?: AgentEvent) {
  if (!enabled(task) || event?.kind !== "feedback" || (event.version ?? 1) !== version(task)) return false;
  scoped(learning, task);
  return !rows(learning, task).some(r => r.kind === "completion_feedback" && parse<{ eventId: string }>(r)?.eventId === event.id);
}
export function acknowledgeLearningFeedback(learning: LearningRepository, ctx: AgentContext) {
  if (!hasPendingLearningFeedback(learning, ctx.task, ctx.event)) return;
  save(learning, ctx.task, "completion_feedback", ctx.event!.id, { eventId: ctx.event!.id });
}
