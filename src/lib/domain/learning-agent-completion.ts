import { z } from "zod";
import { LearningId } from "./learning";

const short = z.string().trim().min(1).max(600);
const objectiveId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const LearningGoalKind = z.enum(["explanation", "diagnosis", "targeted_review", "chapter_check"]);
export const LearningCheckRole = z.enum(["concept", "application", "boundary", "followup"]);
export const LearningCompletionSource = z.object({ materialId: LearningId, paragraph: z.number().int().positive() }).strict();
export const LearningEvidenceRef = z.object({ quizId: LearningId, attemptId: LearningId, questionIndex: z.number().int().nonnegative().max(49) }).strict();
export type LearningEvidenceRef = z.infer<typeof LearningEvidenceRef>;
export const LearningReviewPlanInput = z.object({
  kind: LearningGoalKind.describe("explanation允许requirements为空；diagnosis、targeted_review、chapter_check的每个目标至少有一个requirement。targeted_review每个目标必须包含role=followup；targeted_review和chapter_check的所有requirement必须independent=true。"),
  objectives: z.array(z.object({ id: objectiveId.describe("本计划内唯一的目标ID；不能与另一个objective.id重复。"), label: short,
    sources: z.array(LearningCompletionSource).min(1).max(20),
    requirements: z.array(z.object({
      role: LearningCheckRole.describe("同一目标内role必须唯一，不能重复；targeted_review的每个目标必须包含followup。"),
      description: short,
      independent: z.boolean().describe("targeted_review和chapter_check必须为true；explanation和diagnosis按约定检查要求明确填写。")
    }).strict()).max(4).describe("同目标内role唯一。仅explanation可以为空；其他kind至少一个。targeted_review必须含followup，且与chapter_check一样全部independent=true。")
  }).strict()).min(1).max(12).describe("1至12个目标，所有objective.id在本计划内唯一。")
}).strict().superRefine((value, ctx) => {
  const duplicateObjective = value.objectives.findIndex((item, index) => value.objectives.findIndex(other => other.id === item.id) !== index);
  if (duplicateObjective !== -1) ctx.addIssue({ code: "custom", message: "duplicate_objective", path: ["objectives", duplicateObjective, "id"] });
  for (const [index, item] of value.objectives.entries()) {
    const requirementsPath = ["objectives", index, "requirements"];
    if (value.kind !== "explanation" && !item.requirements.length) ctx.addIssue({ code: "custom", message: "check_requirements_required", path: requirementsPath });
    const duplicateRole = item.requirements.findIndex((requirement, i) => item.requirements.findIndex(other => other.role === requirement.role) !== i);
    if (duplicateRole !== -1) ctx.addIssue({ code: "custom", message: "duplicate_requirement", path: [...requirementsPath, duplicateRole, "role"] });
    if (value.kind === "targeted_review" && !item.requirements.some(r => r.role === "followup")) ctx.addIssue({ code: "custom", message: "targeted_followup_required", path: requirementsPath });
    const assisted = item.requirements.findIndex(r => !r.independent);
    if ((value.kind === "targeted_review" || value.kind === "chapter_check") && assisted !== -1) ctx.addIssue({ code: "custom", message: "independent_check_required", path: [...requirementsPath, assisted, "independent"] });
  }
// The locked toJsonSchema converter cannot encode superRefine. Keep the exact
// validator and expose these cross-field requirements in the parameter schema
// itself, so every formal caller receives the contract without a prompt fork.
}).describe("计划参数的强制约束：1. objectives中的id全部唯一；2. kind不是explanation时，每个目标的requirements至少一项；3. 同一目标的requirements中role唯一；4. kind=targeted_review时，每个目标必须包含role=followup；5. kind=targeted_review或chapter_check时，所有requirements的independent必须为true。违反任一项均拒绝整个行动，不会自动修正或重试。来源必须由当前授权原文支持，参数通过不等于来源语义或学习结论已核实。");
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
  ref: LearningEvidenceRef, objectiveId, role: LearningCheckRole, rationale: short,
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
  technicalBlocker?: { kind: "plan_source_mismatch"; objectiveIds: string[]; explanationIds?: string[]; message: string };
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
