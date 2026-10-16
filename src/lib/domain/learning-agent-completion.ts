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
  kind: LearningGoalKind,
  objectives: z.array(z.object({ id: objectiveId, label: short, sources: z.array(LearningCompletionSource).min(1).max(20),
    requirements: z.array(z.object({ role: LearningCheckRole, description: short, independent: z.boolean() }).strict()).max(4)
  }).strict()).min(1).max(12)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.objectives.map(o => o.id)).size !== value.objectives.length) ctx.addIssue({ code: "custom", message: "duplicate_objective" });
  for (const item of value.objectives) {
    if (value.kind !== "explanation" && !item.requirements.length) ctx.addIssue({ code: "custom", message: "check_requirements_required" });
    if (new Set(item.requirements.map(r => r.role)).size !== item.requirements.length) ctx.addIssue({ code: "custom", message: "duplicate_requirement" });
    if (value.kind === "targeted_review" && !item.requirements.some(r => r.role === "followup")) ctx.addIssue({ code: "custom", message: "targeted_followup_required" });
    if ((value.kind === "targeted_review" || value.kind === "chapter_check") && item.requirements.some(r => !r.independent)) ctx.addIssue({ code: "custom", message: "independent_check_required" });
  }
});
export type LearningReviewPlanInput = z.infer<typeof LearningReviewPlanInput>;
export type LearningReviewPlan = LearningReviewPlanInput & { schemaVersion: 1; taskVersion: number; sourceFingerprint: string; goal: string; proposedBy: "model"; id: string };
export const LearningCheckPurpose = z.object({
  objectiveIds: z.array(objectiveId).min(1).max(12).refine(ids => new Set(ids).size === ids.length),
  role: LearningCheckRole,
  method: z.enum(["explain", "worked_example", "contrast", "retrieval", "application", "boundary", "clarify", "evidence_review"]),
  purpose: short,
  priorEvidenceRefs: z.array(LearningEvidenceRef).max(20).default([]),
  methodChange: z.object({ previousResultId: LearningId, difference: short, expectedObservation: short }).strict().optional()
}).strict();
export type LearningCheckPurpose = z.infer<typeof LearningCheckPurpose>;
export const LearningEvidenceProposal = z.object({
  ref: LearningEvidenceRef, objectiveId, role: LearningCheckRole, rationale: short,
  relevance: z.enum(["supported", "uncertain"]),
  relation: z.enum(["initial", "repeat", "followup", "new_context", "unknown"]),
  priorEvidenceRefs: z.array(LearningEvidenceRef).max(20).default([]),
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
  priorEvidenceRefs: LearningEvidenceRef[]; sources: Array<z.infer<typeof LearningCompletionSource> & { parsed?: import("./learning-pdf-study").ParsedTextBinding }>;
};
export type LearningObjectiveAssessment = {
  id: string; label: string; status: "supported" | "partial" | "unobserved" | "uncertain";
  requirements: Array<{ role: z.infer<typeof LearningCheckRole>; description: string; supported: boolean }>;
  evidence: LearningCompletionEvidence[]; gaps: string[]; unresolvedErrors: LearningEvidenceRef[];
  explanationResolved: boolean;
};
export type LearningCompletionAssessment = {
  schemaVersion: 1; taskVersion: number; planId: string | null; sourceFingerprint: string | null;
  evidenceFingerprint: string; progressFingerprint: string; plan: LearningReviewPlan | null;
  outcome: "check_passed" | "explanation_resolved" | "diagnosis_complete" | "partial" | "insufficient" | "legacy" | "stale";
  support: "sufficient" | "partial" | "insufficient" | "not_assessed";
  objectives: LearningObjectiveAssessment[]; canAutoFinish: boolean; pending: string[];
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
