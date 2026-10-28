import { z } from "zod";
import { LearningId } from "./learning";
import { findUnobservableLearningRequirements } from "./learning-review-requirements";

const short = z.string().trim().min(1).max(600);
const objectiveId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const LearningGoalKind = z.enum(["explanation", "diagnosis", "practice", "targeted_review", "chapter_check"]);
export const LearningCheckRole = z.enum(["concept", "application", "boundary", "followup"]);
export const LearningCompletionSource = z.object({ materialId: LearningId, paragraph: z.number().int().positive() }).strict();
export const LearningEvidenceRef = z.object({ quizId: LearningId, attemptId: LearningId, questionIndex: z.number().int().nonnegative().max(49) }).strict();
export type LearningEvidenceRef = z.infer<typeof LearningEvidenceRef>;
const reviewPlanShape = z.object({
  kind: LearningGoalKind.describe("普通练习、练练、复习或出题用practice：可以先观察薄弱点，但不能以诊断观察完成代替练习目标获得支持。diagnosis仅用于用户要了解薄弱点或摸底而非继续练习。explanation允许requirements为空；其他kind每个目标至少有一个requirement。practice、targeted_review和chapter_check的所有requirement必须independent=true；只有targeted_review每个目标必须包含role=followup，practice不预设followup或轮数。"),
  objectives: z.array(z.object({ id: objectiveId.describe("本计划内唯一的目标ID；不能与另一个objective.id重复。"), label: short,
    sources: z.array(LearningCompletionSource).min(1).max(20),
    requirements: z.array(z.object({
      role: LearningCheckRole.describe("同一目标内role必须唯一，不能重复；targeted_review的每个目标必须包含followup。"),
      description: short.describe("描述学生可观察的具体知识表现，并与用户目标和所引原文有关；不能只写检查是否充分、先答题再检查等执行流程。followup须说明要复查哪一种知识表现或区别，不仅安排前序/后序步骤。选择正确解释只是选择作答，不能写成学生用自己的话解释。"),
      independent: z.boolean().describe("practice、targeted_review和chapter_check必须为true；提示后正确可用于后续行动，不能代替独立作答支持。explanation和diagnosis按约定检查要求明确填写。")
    }).strict()).max(4).describe("同目标内role唯一。仅explanation可以为空；其他kind至少一个。practice不预设followup；targeted_review必须含followup。practice、targeted_review和chapter_check全部independent=true。")
  }).strict()).min(1).max(12).describe("1至12个目标，所有objective.id在本计划内唯一。")
}).strict();
function validatePlanContract(value: z.infer<typeof reviewPlanShape>, ctx: z.RefinementCtx) {
  const duplicateObjective = value.objectives.findIndex((item, index) => value.objectives.findIndex(other => other.id === item.id) !== index);
  if (duplicateObjective !== -1) ctx.addIssue({ code: "custom", message: "duplicate_objective", path: ["objectives", duplicateObjective, "id"] });
  for (const [index, item] of value.objectives.entries()) {
    const requirementsPath = ["objectives", index, "requirements"];
    if (value.kind !== "explanation" && !item.requirements.length) ctx.addIssue({ code: "custom", message: "check_requirements_required", path: requirementsPath });
    const duplicateRole = item.requirements.findIndex((requirement, i) => item.requirements.findIndex(other => other.role === requirement.role) !== i);
    if (duplicateRole !== -1) ctx.addIssue({ code: "custom", message: "duplicate_requirement", path: [...requirementsPath, duplicateRole, "role"] });
    if (value.kind === "targeted_review" && !item.requirements.some(r => r.role === "followup")) ctx.addIssue({ code: "custom", message: "targeted_followup_required", path: requirementsPath });
    const assisted = item.requirements.findIndex(r => !r.independent);
    if ((value.kind === "practice" || value.kind === "targeted_review" || value.kind === "chapter_check") && assisted !== -1) ctx.addIssue({ code: "custom", message: "independent_check_required", path: [...requirementsPath, assisted, "independent"] });
  }
}
/** Frozen plans keep their original strict structural/cross-field contract.
 * New observability rules must not make old plans unreadable or silently rewrite
 * them. The assessor diagnoses these old requirements and requests an explicit
 * user adjustment; it never treats this compatibility read as approval. */
export const StoredLearningReviewPlanInput = reviewPlanShape.superRefine(validatePlanContract);
export const LearningReviewPlanInput = reviewPlanShape.superRefine((value, ctx) => {
  validatePlanContract(value, ctx);
  for (const issue of findUnobservableLearningRequirements(value)) {
    const objectiveIndex = value.objectives.findIndex(objective => objective.id === issue.objectiveId);
    ctx.addIssue({ code: "custom", message: issue.code, path: ["objectives", objectiveIndex, "requirements", issue.requirementIndex, "description"] });
  }
// The locked toJsonSchema converter cannot encode superRefine. Keep the exact
// validator and expose these cross-field requirements in the parameter schema
// itself, so every formal caller receives the contract without a prompt fork.
}).describe("计划参数的强制约束：1. objectives中的id全部唯一；2. kind不是explanation时，每个目标的requirements至少一项；3. 同一目标的requirements中role唯一；4. kind=targeted_review时，每个目标必须包含role=followup；practice不要求预设followup；5. kind=practice、targeted_review或chapter_check时，所有requirements的independent必须为true；6. 每项description必须描述学生可观察的具体知识表现，不能用“根据前序作答表现，检查该小点是否已经充分验证”或“先完成两道了解性题目，再针对实际困难继续检查”这类流程代替知识要求；followup也要说明具体复查内容。违反任一项均拒绝整个行动，不会自动修正或重试。选择正确解释不等于学生用自己的话解释。来源必须由当前授权原文支持，参数通过不等于来源语义或学习结论已核实。practice的检查通过依赖约定目标的有效独立作答与相关反证处理；可以证据不足时partial交回，不要求每道旧题重答正确或固定练习轮数。");
export type LearningReviewPlanInput = z.infer<typeof LearningReviewPlanInput>;
export type LearningReviewPlan = LearningReviewPlanInput & { schemaVersion: 1; taskVersion: number; sourceFingerprint: string; goal: string; proposedBy: "model"; id: string };
export const LearningCheckPurpose = z.object({
  objectiveIds: z.array(objectiveId).min(1).max(12).refine(ids => new Set(ids).size === ids.length)
    .describe("本次目的关联的当前计划目标ID；只能选择当前计划中的目标，数组内不得重复。"),
  role: LearningCheckRole,
  method: z.enum(["explain", "worked_example", "contrast", "retrieval", "application", "boundary", "clarify", "evidence_review"]),
  purpose: short,
  priorEvidenceRefs: z.array(LearningEvidenceRef).max(20).default([]).describe("复查已有表现时引用当前版本已读回并关联的具体作答；followup不是仅改role标签，必须说明与前序表现或当前疑问的关系。"),
  methodChange: z.object({ previousResultId: LearningId, difference: short, expectedObservation: short }).strict().optional()
}).strict();
export type LearningCheckPurpose = z.infer<typeof LearningCheckPurpose>;
export const LearningEvidenceProposal = z.object({
  ref: LearningEvidenceRef, objectiveId, role: LearningCheckRole,
  rationale: short.describe("只能按已保存的实际作答方式说明关联。单选题选中一个正确解释不是学生用自己的话解释、口述或独立书写；模型关联说明不改变实际作答事实。"),
  relevance: z.enum(["supported", "uncertain"]).describe("按该role的具体requirement核对题干及全部选项实际要求的作答。主题相近/来源相交不等于覆盖；成员归属选择不支持计算元素个数。不能确认则uncertain。"),
  relation: z.enum(["initial", "repeat", "followup", "new_context", "unknown"]).describe("initial不满足followup要求。后续检查须根据实际前序作答/解释声明followup或new_context及依据；不同题组ID或数值不自动证明迁移。"),
  priorEvidenceRefs: z.array(LearningEvidenceRef).max(20).default([]).describe("复查已有表现时引用当前版本已读回并关联的具体作答；followup不是仅改role标签，必须说明与前序表现或当前疑问的关系。"),
  contentStatus: z.enum(["no_known_issue", "uncertain", "known_issue"])
}).strict();
export type LearningEvidenceProposal = z.infer<typeof LearningEvidenceProposal>;
export const LearningExplanationFeedback = z.object({
  explanationId: LearningId, outcome: z.enum(["resolved", "needs_clarification"]),
  message: z.string().trim().max(1000).optional()
}).strict();
export type LearningExplanationFeedback = z.infer<typeof LearningExplanationFeedback>;
export type LearningCompletionEvidence = {
  ref: LearningEvidenceRef; objectiveId: string; role: z.infer<typeof LearningCheckRole>;
  submitted: boolean; correct: boolean | null; firstSubmittedAt: string | null;
  hintedBeforeSubmission: boolean; revealedBeforeSubmission: boolean; skipped: boolean;
  answerAvailability: "not_observed_before_submission" | "available_before_submission" | "unknown";
  repetition: "known_repeat" | "not_known_repeat" | "unknown";
  historical: boolean; quality: "pending" | "tentative" | "disputed" | "known_issue" | "uncertain" | "historical_unknown" | "invalid";
  eligible: boolean; independentInApp: boolean; reasons: string[]; rationale: string;
  relation: LearningEvidenceProposal["relation"]; semanticProvenance: "model_proposal";
  responseMode?: "single_choice";
  diagnosticCode?: "record_unavailable" | "history_forbidden" | "source_changed" | "source_forbidden" | "objective_missing" | "plan_source_mismatch" | "requirement_mismatch";
  priorEvidenceRefs: LearningEvidenceRef[]; sources: Array<z.infer<typeof LearningCompletionSource> & { parsed?: import("./learning-pdf-study").ParsedTextBinding }>;
};
export type LearningObjectiveAssessment = {
  id: string; label: string; status: "supported" | "partial" | "unobserved" | "uncertain";
  requirements: Array<{ role: z.infer<typeof LearningCheckRole>; description: string; supported: boolean }>;
  evidence: LearningCompletionEvidence[]; gaps: string[]; unresolvedErrors: LearningEvidenceRef[];
  explanationResolved: boolean;
  explanationState?: "missing" | "available" | "needs_review" | "resolved";
};
export type LearningCompletionAssessment = {
  schemaVersion: 1; taskVersion: number; planId: string | null; sourceFingerprint: string | null;
  evidenceFingerprint: string; progressFingerprint: string; plan: LearningReviewPlan | null;
  outcome: "check_passed" | "explanation_resolved" | "diagnosis_complete" | "partial" | "insufficient" | "legacy" | "stale";
  support: "sufficient" | "partial" | "insufficient" | "not_assessed";
  objectives: LearningObjectiveAssessment[]; canAutoFinish: boolean; pending: string[];
  technicalBlocker?: { kind: "plan_source_mismatch" | "plan_requirement_unobservable"; objectiveIds: string[]; explanationIds?: string[]; message: string };
  contentIssues?: Array<{ explanationId: string; objectiveIds: string[]; codes: string[]; message: string; active?: boolean }>;
  historyReview?: { pending: Array<{ ref: LearningEvidenceRef; objectiveIds: string[]; read: boolean; unassociatedObjectiveIds: string[] }>; blocked: boolean; notice: string };
  headline: string; stopReason: string | null; limitations: string[]; longTermMastery: "unverified";
};

/** Persist only a conclusion and immutable business references. Current scores,
 * answers and assistance facts are always projected from the Quiz authority. */
export const SavedLearningCompletionAssessment = z.object({
  schemaVersion: z.literal(1), taskVersion: z.number().int().positive(), planId: LearningId,
  sourceFingerprint: z.string().min(1), evidenceFingerprint: z.string().min(1), progressFingerprint: z.string().min(1),
  outcome: z.enum(["check_passed", "explanation_resolved", "diagnosis_complete", "partial", "insufficient"]),
  support: z.enum(["sufficient", "partial", "insufficient", "not_assessed"]),
  objectives: z.array(z.object({ id: objectiveId, status: z.enum(["supported", "partial", "unobserved", "uncertain"]),
    gaps: z.array(z.string()), evidenceRefs: z.array(LearningEvidenceRef), unresolvedErrors: z.array(LearningEvidenceRef),
    explanationResolved: z.boolean() }).strict()).max(12),
  stopReason: z.string().nullable(), longTermMastery: z.literal("unverified")
}).strict();
