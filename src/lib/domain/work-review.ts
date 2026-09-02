import { z } from "zod";

import { TranscriptSegmentSchema } from "@/lib/domain/types";

export const WORK_REVIEW_CONTRACT_VERSION = 1 as const;
export const WORK_REVIEW_PRODUCT_ID = "office_review" as const;

export const WorkReviewIdSchema = z.string().trim().min(1).max(512);
export const WorkReviewVersionSchema = z.number().int().nonnegative();
export const WorkReviewIsoDateTimeSchema = z.string().datetime();
export const WorkReviewDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month! - 1
      && parsed.getUTCDate() === day;
  }, "Meeting date must be a real calendar date");

export const WorkMeetingIngestionStatusSchema = z.enum([
  "created",
  "queued",
  "transcribing",
  "transcript_ready",
  "failed",
  "deleted"
]);

export const WorkMeetingAnalysisStatusSchema = z.enum([
  "not_started",
  "queued",
  "extracting",
  "verifying",
  "review_ready",
  "failed",
  "deleted"
]);

export const WorkMeetingReviewStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "completed"
]);

export const WorkMeetingProcessingStageSchema = z.enum([
  "transcription",
  "meeting_analysis"
]);

export const WorkMeetingAttemptStateSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
  "superseded",
  "deleted"
]);

export const WorkMeetingReceiptStateSchema = z.enum([
  "reserved",
  "accepted",
  "processing",
  "completed",
  "failed",
  "deleted"
]);

export const WorkMeetingCandidateKindSchema = z.enum([
  "discussion_topic",
  "proposal",
  "decision",
  "commitment",
  "open_question",
  "plan_change",
  "action_item"
]);

export const WorkMeetingCandidateStatusSchema = z.enum([
  "pending_review",
  "accepted",
  "edited_and_accepted",
  "retyped_and_accepted",
  "ignored",
  "invalidated"
]);

export const WorkMeetingDecisionFinalitySchema = z.enum([
  "final",
  "tentative",
  "unclear"
]);

export const WorkMeetingActionBasisSchema = z.enum([
  "explicit_commitment",
  "assignment_without_acceptance",
  "suggested_action",
  "unowned_follow_up"
]);

export const WorkAtomicClaimTypeSchema = z.enum([
  "topic",
  "proposal",
  "decision_existence",
  "decision_finality",
  "speaker_attribution",
  "commitment_existence",
  "commitment_owner",
  "deadline",
  "open_question",
  "question_resolution",
  "plan_change",
  "action_item"
]);

export const WorkClaimSupportVerdictSchema = z.enum([
  "entailed",
  "partially_entailed",
  "unsupported",
  "contradicted",
  "unverifiable"
]);

export const WorkClaimRiskLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical"
]);

export const WorkClaimPublicationActionSchema = z.enum([
  "show_as_candidate",
  "show_as_question",
  "suppress"
]);

export const WorkEvidenceTimestampQualitySchema = z.enum([
  "provider_exact",
  "provider_estimated",
  "synthetic",
  "unknown"
]);

export const WorkReviewEventTypeSchema = z.enum([
  "candidate_confirmed",
  "candidate_edited_and_confirmed",
  "candidate_retyped_and_confirmed",
  "candidate_ignored",
  "finding_edited",
  "review_completed"
]);

export const WorkCandidateReviewActionSchema = z.enum([
  "accept",
  "edit_and_accept",
  "retype_and_accept",
  "ignore"
]);

const WorkEvidenceReferenceBaseSchema = z.object({
  publicationId: WorkReviewIdSchema,
  segmentId: WorkReviewIdSchema,
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
  rawSpeakerLabel: z.string().trim().min(1).max(512).nullable(),
  timestampQuality: WorkEvidenceTimestampQualitySchema
}).strict();

export const WorkEvidenceReferenceSchema = WorkEvidenceReferenceBaseSchema.superRefine((evidence, context) => {
  if (evidence.endSeconds <= evidence.startSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endSeconds"],
      message: "Evidence endSeconds must be greater than startSeconds"
    });
  }
});

export const WorkMaterializedEvidenceSchema = WorkEvidenceReferenceBaseSchema.extend({
  text: z.string().trim().min(1).max(50_000)
}).strict().superRefine((evidence, context) => {
  if (evidence.endSeconds <= evidence.startSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endSeconds"],
      message: "Evidence endSeconds must be greater than startSeconds"
    });
  }
});

export const WorkPlanChangeStageSchema = z.object({
  id: WorkReviewIdSchema,
  content: z.string().trim().min(1).max(20_000),
  status: z.enum(["proposed", "revised", "current", "withdrawn", "unclear"]),
  rawSpeakerLabel: z.string().trim().min(1).max(512).nullable(),
  evidenceRefs: z.array(WorkEvidenceReferenceSchema).min(1).max(64)
}).strict();

export const WorkMeetingCandidateStructuredDataSchema = z.object({
  decisionFinality: WorkMeetingDecisionFinalitySchema.nullable().default(null),
  rawActorLabel: z.string().trim().min(1).max(512).nullable().default(null),
  candidateOwner: z.string().trim().min(1).max(512).nullable().default(null),
  dueAt: WorkReviewIsoDateTimeSchema.nullable().default(null),
  originalDueExpression: z.string().trim().min(1).max(2_000).nullable().default(null),
  actionBasis: WorkMeetingActionBasisSchema.nullable().default(null),
  relatedCommitmentCandidateId: WorkReviewIdSchema.nullable().default(null),
  planStages: z.array(WorkPlanChangeStageSchema).max(32).default([])
}).strict();

export const WorkAtomicClaimSchema = z.object({
  id: WorkReviewIdSchema,
  candidateId: WorkReviewIdSchema,
  claimType: WorkAtomicClaimTypeSchema,
  text: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(WorkReviewIdSchema).min(1).max(64),
  createdAt: WorkReviewIsoDateTimeSchema.nullable().default(null)
}).strict().superRefine((claim, context) => {
  if (new Set(claim.evidenceIds).size !== claim.evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "Claim evidenceIds must be unique"
    });
  }
});

export const WorkClaimEvaluationSchema = z.object({
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  meetingId: WorkReviewIdSchema,
  claimId: WorkReviewIdSchema,
  supportVerdict: WorkClaimSupportVerdictSchema,
  issueCodes: z.array(z.string().trim().min(1).max(256)).max(64),
  riskLevel: WorkClaimRiskLevelSchema,
  publicationAction: WorkClaimPublicationActionSchema,
  confirmationRequired: z.boolean(),
  supportedEvidenceIds: z.array(WorkReviewIdSchema).max(64),
  generatorProfile: z.string().trim().min(1).max(512),
  verifierProfile: z.string().trim().min(1).max(512),
  verifierPromptVersion: z.string().trim().min(1).max(256),
  policyVersion: z.string().trim().min(1).max(256),
  verifiedAt: WorkReviewIsoDateTimeSchema
}).strict().superRefine((evaluation, context) => {
  if (new Set(evaluation.supportedEvidenceIds).size !== evaluation.supportedEvidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supportedEvidenceIds"],
      message: "supportedEvidenceIds must be unique"
    });
  }
});

export const WorkMeetingCandidateSchema = z.object({
  contractVersion: z.literal(WORK_REVIEW_CONTRACT_VERSION),
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  meetingId: WorkReviewIdSchema,
  publicationId: WorkReviewIdSchema,
  kind: WorkMeetingCandidateKindSchema,
  title: z.string().trim().min(1).max(2_000),
  body: z.string().trim().min(1).max(20_000),
  structuredData: WorkMeetingCandidateStructuredDataSchema,
  evidenceRefs: z.array(WorkEvidenceReferenceSchema).min(1).max(64),
  status: WorkMeetingCandidateStatusSchema,
  version: WorkReviewVersionSchema,
  generatorProfile: z.string().trim().min(1).max(512),
  generatorPromptVersion: z.string().trim().min(1).max(256),
  createdAt: WorkReviewIsoDateTimeSchema,
  updatedAt: WorkReviewIsoDateTimeSchema
}).strict().superRefine((candidate, context) => {
  const evidenceIds = candidate.evidenceRefs.map((evidence) => evidence.segmentId);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceRefs"],
      message: "Candidate evidence segment IDs must be unique"
    });
  }
  if (candidate.evidenceRefs.some((evidence) => evidence.publicationId !== candidate.publicationId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceRefs"],
      message: "Candidate Evidence must belong to its canonical publication"
    });
  }
});

export const WorkMeetingFindingSchema = z.object({
  contractVersion: z.literal(WORK_REVIEW_CONTRACT_VERSION),
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  meetingId: WorkReviewIdSchema,
  sourceCandidateId: WorkReviewIdSchema,
  kind: WorkMeetingCandidateKindSchema,
  title: z.string().trim().min(1).max(2_000),
  body: z.string().trim().min(1).max(20_000),
  structuredData: WorkMeetingCandidateStructuredDataSchema,
  evidenceRefs: z.array(WorkEvidenceReferenceSchema).min(1).max(64),
  userConfirmedAt: WorkReviewIsoDateTimeSchema,
  userEditedAt: WorkReviewIsoDateTimeSchema.nullable(),
  version: WorkReviewVersionSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  updatedAt: WorkReviewIsoDateTimeSchema
}).strict();

export const WorkMeetingSchema = z.object({
  contractVersion: z.literal(WORK_REVIEW_CONTRACT_VERSION),
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  productId: z.literal(WORK_REVIEW_PRODUCT_ID),
  title: z.string().trim().min(1).max(2_000),
  meetingDate: WorkReviewDateSchema,
  sourceUploadId: WorkReviewIdSchema,
  audioDurationSeconds: z.number().finite().positive().nullable(),
  ingestionStatus: WorkMeetingIngestionStatusSchema,
  analysisStatus: WorkMeetingAnalysisStatusSchema,
  reviewStatus: WorkMeetingReviewStatusSchema,
  canonicalPublicationId: WorkReviewIdSchema.nullable(),
  canonicalContentDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  canonicalSegmentCount: z.number().int().nonnegative(),
  currentTranscriptionAttempt: z.number().int().nonnegative(),
  currentAnalysisAttempt: z.number().int().nonnegative(),
  version: WorkReviewVersionSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  updatedAt: WorkReviewIsoDateTimeSchema,
  transcriptReadyAt: WorkReviewIsoDateTimeSchema.nullable(),
  reviewReadyAt: WorkReviewIsoDateTimeSchema.nullable(),
  reviewCompletedAt: WorkReviewIsoDateTimeSchema.nullable(),
  failedAt: WorkReviewIsoDateTimeSchema.nullable(),
  deletedAt: WorkReviewIsoDateTimeSchema.nullable(),
  errorStage: WorkMeetingProcessingStageSchema.nullable(),
  errorCode: z.string().trim().min(1).max(256).nullable()
}).strict().superRefine((meeting, context) => {
  const hasCanonicalAuthority = meeting.canonicalPublicationId !== null
    && meeting.canonicalContentDigest !== null
    && meeting.canonicalSegmentCount > 0;
  if (meeting.ingestionStatus === "transcript_ready" && !hasCanonicalAuthority) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["canonicalPublicationId"],
      message: "transcript_ready requires a complete canonical authority"
    });
  }
  if (meeting.ingestionStatus !== "transcript_ready" && meeting.analysisStatus !== "not_started"
    && meeting.analysisStatus !== "deleted") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["analysisStatus"],
      message: "Meeting analysis requires transcript_ready ingestion"
    });
  }
  if (meeting.reviewStatus === "completed" && meeting.reviewCompletedAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewCompletedAt"],
      message: "completed review requires reviewCompletedAt"
    });
  }
});

export const WorkMeetingInputReceiptSchema = z.object({
  receiptId: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  operationKey: WorkReviewIdSchema,
  idempotencyKey: WorkReviewIdSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  meetingId: WorkReviewIdSchema,
  state: WorkMeetingReceiptStateSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  completedAt: WorkReviewIsoDateTimeSchema.nullable(),
  errorCode: z.string().trim().min(1).max(256).nullable()
}).strict();

export const WorkMeetingProcessingAttemptSchema = z.object({
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  meetingId: WorkReviewIdSchema,
  stage: WorkMeetingProcessingStageSchema,
  attemptVersion: z.number().int().positive(),
  leaseOwner: WorkReviewIdSchema.nullable(),
  leaseExpiresAt: WorkReviewIsoDateTimeSchema.nullable(),
  pipelineVersion: z.string().trim().min(1).max(256),
  providerProfile: z.string().trim().min(1).max(512),
  promptVersion: z.string().trim().min(1).max(256).nullable(),
  state: WorkMeetingAttemptStateSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  completedAt: WorkReviewIsoDateTimeSchema.nullable(),
  errorCode: z.string().trim().min(1).max(256).nullable()
}).strict();

export const WorkCanonicalSegmentsSchema = z.array(TranscriptSegmentSchema).min(1).superRefine(
  (segments, context) => {
    const ids = segments.map((segment) => segment.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Canonical Transcript segment IDs must be unique"
      });
    }
    const uploadIds = new Set(segments.map((segment) => segment.uploadId));
    if (uploadIds.size !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Canonical Transcript segments must share one sourceUploadId"
      });
    }
  }
);

export const WorkCanonicalPublicationSchema = z.object({
  publicationId: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  meetingId: WorkReviewIdSchema,
  sourceUploadId: WorkReviewIdSchema,
  assetKind: z.literal("segments"),
  attemptVersion: z.number().int().positive(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  segmentCount: z.number().int().positive(),
  segments: WorkCanonicalSegmentsSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  tombstonedAt: WorkReviewIsoDateTimeSchema.nullable()
}).strict().superRefine((publication, context) => {
  if (publication.segmentCount !== publication.segments.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["segmentCount"],
      message: "segmentCount must match canonical segments"
    });
  }
  if (publication.segments.some((segment) => segment.uploadId !== publication.sourceUploadId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["segments"],
      message: "Canonical Transcript sourceUploadId mismatch"
    });
  }
});

export const WorkReviewEventSchema = z.object({
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  meetingId: WorkReviewIdSchema,
  candidateId: WorkReviewIdSchema.nullable(),
  findingId: WorkReviewIdSchema.nullable(),
  operationKey: WorkReviewIdSchema,
  eventType: WorkReviewEventTypeSchema,
  createdAt: WorkReviewIsoDateTimeSchema
}).strict();

export const WorkMeetingSpeakerAliasSchema = z.object({
  accountId: WorkReviewIdSchema,
  meetingId: WorkReviewIdSchema,
  rawLabel: z.string().trim().min(1).max(512),
  displayName: z.string().trim().min(1).max(512),
  version: WorkReviewVersionSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  updatedAt: WorkReviewIsoDateTimeSchema
}).strict();

export const WorkExtractorPlanChangeStageDraftSchema = z.object({
  clientStageKey: WorkReviewIdSchema,
  content: z.string().trim().min(1).max(20_000),
  status: z.enum(["proposed", "revised", "current", "withdrawn", "unclear"]),
  rawSpeakerLabel: z.string().trim().min(1).max(512).nullable(),
  evidenceIds: z.array(WorkReviewIdSchema).min(1).max(64)
}).strict();

export const WorkExtractorCandidateStructuredDataSchema = z.object({
  decisionFinality: WorkMeetingDecisionFinalitySchema.nullable().default(null),
  rawActorLabel: z.string().trim().min(1).max(512).nullable().default(null),
  candidateOwner: z.string().trim().min(1).max(512).nullable().default(null),
  dueAt: WorkReviewIsoDateTimeSchema.nullable().default(null),
  originalDueExpression: z.string().trim().min(1).max(2_000).nullable().default(null),
  actionBasis: WorkMeetingActionBasisSchema.nullable().default(null),
  relatedCommitmentCandidateId: WorkReviewIdSchema.nullable().default(null),
  planStages: z.array(WorkExtractorPlanChangeStageDraftSchema).max(32).default([])
}).strict();

export const WorkExtractorAtomicClaimDraftSchema = z.object({
  clientClaimKey: WorkReviewIdSchema,
  claimType: WorkAtomicClaimTypeSchema,
  text: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(WorkReviewIdSchema).min(1).max(64)
}).strict();

export const WorkExtractorCandidateDraftSchema = z.object({
  clientCandidateKey: WorkReviewIdSchema,
  kind: WorkMeetingCandidateKindSchema,
  title: z.string().trim().min(1).max(2_000),
  body: z.string().trim().min(1).max(20_000),
  structuredData: WorkExtractorCandidateStructuredDataSchema,
  evidenceIds: z.array(WorkReviewIdSchema).min(1).max(64),
  claims: z.array(WorkExtractorAtomicClaimDraftSchema).min(1).max(64)
}).strict();

export const WorkExtractorResponseSchema = z.object({
  items: z.array(WorkExtractorCandidateDraftSchema).max(128)
}).strict();

export const WorkVerifierClaimDraftSchema = z.object({
  claimId: WorkReviewIdSchema,
  supportVerdict: WorkClaimSupportVerdictSchema,
  issueCodes: z.array(z.string().trim().min(1).max(256)).max(64),
  supportedEvidenceIds: z.array(WorkReviewIdSchema).max(64)
}).strict();

export const WorkVerifierResponseSchema = z.object({
  items: z.array(WorkVerifierClaimDraftSchema).max(256)
}).strict();

export const CreateWorkMeetingFieldsSchema = z.object({
  title: z.string().trim().max(2_000).transform((value) => value || null),
  meetingDate: WorkReviewDateSchema
}).strict();

const CandidateReviewBaseSchema = z.object({
  expectedVersion: WorkReviewVersionSchema,
  operationKey: WorkReviewIdSchema
}).strict();

export const ReviewWorkCandidateRequestSchema = z.discriminatedUnion("action", [
  CandidateReviewBaseSchema.extend({ action: z.literal("accept") }).strict(),
  CandidateReviewBaseSchema.extend({
    action: z.literal("edit_and_accept"),
    title: z.string().trim().min(1).max(2_000),
    body: z.string().trim().min(1).max(20_000),
    structuredData: WorkMeetingCandidateStructuredDataSchema
  }).strict(),
  CandidateReviewBaseSchema.extend({
    action: z.literal("retype_and_accept"),
    kind: WorkMeetingCandidateKindSchema,
    title: z.string().trim().min(1).max(2_000),
    body: z.string().trim().min(1).max(20_000),
    structuredData: WorkMeetingCandidateStructuredDataSchema
  }).strict(),
  CandidateReviewBaseSchema.extend({ action: z.literal("ignore") }).strict()
]);

export const CompleteWorkMeetingReviewRequestSchema = z.object({
  expectedVersion: WorkReviewVersionSchema,
  operationKey: WorkReviewIdSchema
}).strict();

export const UpdateWorkMeetingSpeakerAliasRequestSchema = z.object({
  expectedVersion: WorkReviewVersionSchema,
  operationKey: WorkReviewIdSchema,
  displayName: z.string().trim().min(1).max(512)
}).strict();

// Internal aggregate contract. Public API views are intentionally narrower and
// are validated at the client boundary in work-review-api.ts.
export const WorkMeetingInternalAggregateSchema = z.object({
  meeting: WorkMeetingSchema,
  transcript: WorkCanonicalPublicationSchema.nullable(),
  candidates: z.array(WorkMeetingCandidateSchema),
  evaluations: z.array(WorkClaimEvaluationSchema),
  findings: z.array(WorkMeetingFindingSchema),
  speakerAliases: z.array(WorkMeetingSpeakerAliasSchema)
}).strict();

export type WorkMeetingIngestionStatus = z.infer<typeof WorkMeetingIngestionStatusSchema>;
export type WorkMeetingAnalysisStatus = z.infer<typeof WorkMeetingAnalysisStatusSchema>;
export type WorkMeetingReviewStatus = z.infer<typeof WorkMeetingReviewStatusSchema>;
export type WorkMeetingCandidateKind = z.infer<typeof WorkMeetingCandidateKindSchema>;
export type WorkMeetingCandidateStatus = z.infer<typeof WorkMeetingCandidateStatusSchema>;
export type WorkMeetingDecisionFinality = z.infer<typeof WorkMeetingDecisionFinalitySchema>;
export type WorkMeetingActionBasis = z.infer<typeof WorkMeetingActionBasisSchema>;
export type WorkAtomicClaimType = z.infer<typeof WorkAtomicClaimTypeSchema>;
export type WorkClaimSupportVerdict = z.infer<typeof WorkClaimSupportVerdictSchema>;
export type WorkClaimRiskLevel = z.infer<typeof WorkClaimRiskLevelSchema>;
export type WorkClaimPublicationAction = z.infer<typeof WorkClaimPublicationActionSchema>;
export type WorkEvidenceTimestampQuality = z.infer<typeof WorkEvidenceTimestampQualitySchema>;
export type WorkEvidenceReference = z.infer<typeof WorkEvidenceReferenceSchema>;
export type WorkMaterializedEvidence = z.infer<typeof WorkMaterializedEvidenceSchema>;
export type WorkMeetingCandidateStructuredData = z.infer<typeof WorkMeetingCandidateStructuredDataSchema>;
export type WorkAtomicClaim = z.infer<typeof WorkAtomicClaimSchema>;
export type WorkClaimEvaluation = z.infer<typeof WorkClaimEvaluationSchema>;
export type WorkMeetingCandidate = z.infer<typeof WorkMeetingCandidateSchema>;
export type WorkMeetingFinding = z.infer<typeof WorkMeetingFindingSchema>;
export type WorkMeeting = z.infer<typeof WorkMeetingSchema>;
export type WorkMeetingInputReceipt = z.infer<typeof WorkMeetingInputReceiptSchema>;
export type WorkMeetingProcessingAttempt = z.infer<typeof WorkMeetingProcessingAttemptSchema>;
export type WorkCanonicalPublication = z.infer<typeof WorkCanonicalPublicationSchema>;
export type WorkReviewEvent = z.infer<typeof WorkReviewEventSchema>;
export type WorkMeetingSpeakerAlias = z.infer<typeof WorkMeetingSpeakerAliasSchema>;
export type WorkExtractorPlanChangeStageDraft = z.infer<typeof WorkExtractorPlanChangeStageDraftSchema>;
export type WorkExtractorCandidateStructuredData = z.infer<typeof WorkExtractorCandidateStructuredDataSchema>;
export type WorkExtractorAtomicClaimDraft = z.infer<typeof WorkExtractorAtomicClaimDraftSchema>;
export type WorkExtractorCandidateDraft = z.infer<typeof WorkExtractorCandidateDraftSchema>;
export type WorkExtractorResponse = z.infer<typeof WorkExtractorResponseSchema>;
export type WorkVerifierClaimDraft = z.infer<typeof WorkVerifierClaimDraftSchema>;
export type WorkVerifierResponse = z.infer<typeof WorkVerifierResponseSchema>;
export type ReviewWorkCandidateRequest = z.infer<typeof ReviewWorkCandidateRequestSchema>;
export type WorkMeetingInternalAggregate = z.infer<typeof WorkMeetingInternalAggregateSchema>;
