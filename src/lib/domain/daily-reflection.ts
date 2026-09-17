import { z } from "zod";

export const DAILY_REFLECTION_PROCESSING_PLAN_VERSION = 1 as const;
export const DAILY_REFLECTION_PROCESSING_PLAN_V2_VERSION = 2 as const;
export const DAILY_REFLECTION_V2_CONTRACT_VERSION = 2 as const;

export const DailyReflectionIdSchema = z.string().trim().min(1).max(512);
export const DailyReflectionVersionSchema = z.number().int().nonnegative();

export const InputMethodSchema = z.enum([
  "file_upload",
  "browser_recording"
]);

export const DailyReflectionV2InputAdapterSchema = z.enum([
  "file_picker",
  "browser_recorder",
  "toy_sync"
]);

export const DailyReflectionV2SourceOriginSchema = z.enum([
  "user_reflection",
  "direct_conversation"
]);

export const DailyReflectionV2CapturePurposeSchema = z.literal("inspiration_capture");

export const DailyReflectionSaveIntentSchema = z.enum([
  "recap_only",
  "retain_selected"
]);

export const SourceOriginSchema = z.enum([
  "direct_conversation",
  "user_reflection",
  "manual_note",
  "ai_derived_observation",
  "unknown",
  "legacy_unknown"
]);

export const ProcessingProfileSchema = z.enum([
  "full_recording",
  "quick_reflection"
]);

export const IngestionContextSchema = z.enum([
  "standard_upload",
  "date_companion",
  "daily_reflection"
]);

export const ReviewPolicySchema = z.literal("required");

export const DailyReflectionStatusSchema = z.enum([
  "created",
  "uploading",
  "transcribing",
  "extracting",
  "review_pending",
  "confirmation_ready",
  "admitting",
  "completed",
  "admission_failed",
  "failed",
  "cancelled",
  "deleted"
]);

export const CandidateStatusSchema = z.enum([
  "pending",
  "kept",
  "excluded"
]);

export const CandidateUserTextInputSchema = z.union([
  z.string().max(4_000).transform((value) => value.trim() || null),
  z.null()
]);

export const CandidateKindSchema = z.enum([
  "event",
  "commitment",
  "question",
  "preference",
  "summary"
]);

export const CandidateKindV2Schema = z.enum([
  "insight",
  "open_question",
  "decision",
  "user_action"
]);

export const ReflectionCardDisplayTierSchema = z.enum(["primary", "more"]);

export const ReflectionCardReviewStatusSchema = z.enum([
  "not_proposed",
  "pending",
  "kept",
  "excluded"
]);

export const ReflectionCardEpistemicStatusSchema = z.enum([
  "explicit_user_statement",
  "reported_event",
  "ai_inference",
  "unknown"
]);

export const ReflectionCardRiskFlagSchema = z.enum([
  "ai_inference",
  "attribution_uncertain",
  "low_evidence",
  "sensitive"
]);

export function legacyCandidateKindForV2(input: {
  candidateKind: z.infer<typeof CandidateKindV2Schema>;
  actionClaimed: boolean;
}): z.infer<typeof CandidateKindSchema> {
  if (input.candidateKind === "open_question") return "question";
  if (input.candidateKind === "user_action" && input.actionClaimed) return "commitment";
  return "summary";
}

export const ProcessingPlanV1Schema = z.object({
  planVersion: z.literal(DAILY_REFLECTION_PROCESSING_PLAN_VERSION),
  reflectionId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema,
  inputMethod: InputMethodSchema,
  sourceOrigin: SourceOriginSchema,
  processingProfile: ProcessingProfileSchema,
  ingestionContext: IngestionContextSchema,
  reviewPolicy: ReviewPolicySchema
}).strict();

export const DailyReflectionDurationSourceSchema = z.enum(["server_ffprobe", "server_ffmpeg_decode"]);

export const ProcessingPlanV2Schema = ProcessingPlanV1Schema.extend({
  planVersion: z.literal(DAILY_REFLECTION_PROCESSING_PLAN_V2_VERSION),
  inputAdapter: DailyReflectionV2InputAdapterSchema,
  capturePurpose: DailyReflectionV2CapturePurposeSchema,
  effectiveDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  durationSource: DailyReflectionDurationSourceSchema,
  candidateLimit: z.number().int().min(1).max(7)
}).strict();

export const ProcessingPlanSchema = z.discriminatedUnion("planVersion", [
  ProcessingPlanV1Schema,
  ProcessingPlanV2Schema
]);

export const DailyReflectionSchema = z.object({
  id: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema.nullable(),
  inputMethod: InputMethodSchema,
  sourceOrigin: SourceOriginSchema,
  processingProfile: ProcessingProfileSchema,
  ingestionContext: z.literal("daily_reflection"),
  status: DailyReflectionStatusSchema,
  version: DailyReflectionVersionSchema,
  idempotencyKey: z.string().trim().min(1).max(512).nullable(),
  errorCode: z.string().trim().min(1).max(256).nullable(),
  errorMessage: z.string().trim().min(1).max(4_000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const LegacyDailyReflectionSchema = DailyReflectionSchema
  .omit({ sourceOrigin: true })
  .extend({ sourceOrigin: z.unknown().optional() })
  .strict()
  .transform((reflection) => DailyReflectionSchema.parse({
    ...reflection,
    sourceOrigin: normalizeLegacySourceOrigin(reflection.sourceOrigin)
  }));

export const CandidateV1Schema = z.object({
  id: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  ordinal: z.number().int().nonnegative(),
  proposedText: z.string().trim().min(1).max(20_000),
  userText: z.string().trim().min(1).max(20_000).nullable(),
  status: CandidateStatusSchema,
  candidateType: CandidateKindSchema,
  sourceSegmentIds: z.array(DailyReflectionIdSchema).min(1),
  subjectPersonId: DailyReflectionIdSchema.nullable(),
  subjectConfirmed: z.boolean(),
  version: DailyReflectionVersionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine((candidate, context) => {
  if (new Set(candidate.sourceSegmentIds).size !== candidate.sourceSegmentIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceSegmentIds"],
      message: "sourceSegmentIds must be unique"
    });
  }
  if (candidate.subjectConfirmed && candidate.subjectPersonId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectPersonId"],
      message: "subjectPersonId is required when subjectConfirmed is true"
    });
  }
  if (candidate.status !== "kept" && (
    candidate.subjectPersonId !== null || candidate.subjectConfirmed
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectPersonId"],
      message: "only kept candidates may retain a Subject association"
    });
  }
});

export const CandidateV2Schema = z.object({
  contractVersion: z.literal(DAILY_REFLECTION_V2_CONTRACT_VERSION),
  id: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  ordinal: z.number().int().nonnegative(),
  proposedText: z.string().trim().min(1).max(20_000),
  userText: z.string().trim().min(1).max(20_000).nullable(),
  status: CandidateStatusSchema,
  candidateKind: CandidateKindV2Schema,
  candidateType: CandidateKindSchema,
  evidenceIds: z.array(DailyReflectionIdSchema).max(64),
  sourceSegmentIds: z.array(DailyReflectionIdSchema).max(64),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(4_000),
  actionClaimed: z.boolean(),
  subjectPersonId: z.null(),
  subjectConfirmed: z.literal(false),
  version: DailyReflectionVersionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine((candidate, context) => {
  if (
    candidate.evidenceIds.length !== candidate.sourceSegmentIds.length
    || candidate.evidenceIds.some(
      (evidenceId, index) => evidenceId !== candidate.sourceSegmentIds[index]
    )
    || new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "V2 evidenceIds must exactly match unique sourceSegmentIds"
    });
  }
  if (candidate.candidateType !== legacyCandidateKindForV2(candidate)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidateType"],
      message: "candidateType must be the deterministic V2 compatibility projection"
    });
  }
  if (candidate.candidateKind !== "user_action" && candidate.actionClaimed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actionClaimed"],
      message: "only user_action candidates may claim an action"
    });
  }
});

export const CandidateSchema = z.union([CandidateV1Schema, CandidateV2Schema]);

export const ReflectionCardBaseSchema = z.object({
  id: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  cardKind: CandidateKindV2Schema,
  proposedTitle: z.string().trim().min(1).max(240),
  proposedText: z.string().trim().min(1).max(20_000),
  userTitle: z.string().trim().min(1).max(240).nullable(),
  userText: z.string().trim().min(1).max(20_000).nullable(),
  sourceCandidateIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  evidenceIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  clusterId: DailyReflectionIdSchema,
  clusterTitle: z.string().trim().min(1).max(240),
  displayTier: ReflectionCardDisplayTierSchema,
  rank: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  durability: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  epistemicStatus: ReflectionCardEpistemicStatusSchema,
  riskFlags: z.array(ReflectionCardRiskFlagSchema).max(8),
  actionClaimed: z.boolean(),
  reviewStatus: ReflectionCardReviewStatusSchema,
  version: DailyReflectionVersionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const ReflectionCardSchema = ReflectionCardBaseSchema.superRefine((card, context) => {
  if (new Set(card.sourceCandidateIds).size !== card.sourceCandidateIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceCandidateIds"],
      message: "sourceCandidateIds must be unique"
    });
  }
  if (new Set(card.evidenceIds).size !== card.evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "evidenceIds must be unique"
    });
  }
  if (card.displayTier === "primary" && card.reviewStatus === "not_proposed") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewStatus"],
      message: "primary cards must be proposed for review"
    });
  }
  if (card.displayTier === "more" && card.reviewStatus === "pending") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewStatus"],
      message: "More cards do not block review by default"
    });
  }
  if (card.cardKind !== "user_action" && card.actionClaimed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actionClaimed"],
      message: "only user_action cards may claim an action"
    });
  }
});

export const ReflectionConfirmationEvidenceSnapshotSchema = z.object({
  sourceSegmentId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  text: z.string().trim().min(1).max(200_000),
  effectiveOrigin: SourceOriginSchema
}).strict().refine((evidence) => evidence.endSeconds > evidence.startSeconds, {
  message: "evidence endSeconds must be greater than startSeconds"
});

export const ReflectionConfirmationCandidateSnapshotV1Schema = z.object({
  candidateId: DailyReflectionIdSchema,
  proposedText: z.string().trim().min(1).max(20_000),
  userText: z.string().trim().min(1).max(4_000).nullable(),
  finalText: z.string().trim().min(1).max(20_000),
  status: z.enum(["kept", "excluded"]),
  candidateType: CandidateKindSchema,
  sourceSegmentIds: z.array(DailyReflectionIdSchema).min(1),
  evidenceSnapshots: z.array(ReflectionConfirmationEvidenceSnapshotSchema).min(1),
  subjectPersonId: DailyReflectionIdSchema.nullable()
}).strict().superRefine((candidate, context) => {
  if (new Set(candidate.sourceSegmentIds).size !== candidate.sourceSegmentIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceSegmentIds"],
      message: "sourceSegmentIds must be unique"
    });
  }
  if (
    candidate.evidenceSnapshots.length !== candidate.sourceSegmentIds.length
    || candidate.evidenceSnapshots.some(
      (evidence, index) => evidence.sourceSegmentId !== candidate.sourceSegmentIds[index]
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceSnapshots"],
      message: "evidenceSnapshots must exactly cover sourceSegmentIds in order"
    });
  }
  if (candidate.status === "excluded" && candidate.subjectPersonId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectPersonId"],
      message: "excluded candidates cannot retain a Subject association"
    });
  }
  if (candidate.finalText !== (candidate.userText ?? candidate.proposedText)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["finalText"],
      message: "finalText must be derived from userText or proposedText"
    });
  }
});

export const ReflectionConfirmationCandidateSnapshotV2Schema = z.object({
  contractVersion: z.literal(DAILY_REFLECTION_V2_CONTRACT_VERSION),
  candidateId: DailyReflectionIdSchema,
  proposedText: z.string().trim().min(1).max(20_000),
  userText: z.string().trim().min(1).max(4_000).nullable(),
  finalText: z.string().trim().min(1).max(20_000),
  status: z.enum(["kept", "excluded"]),
  candidateKind: CandidateKindV2Schema,
  candidateType: CandidateKindSchema,
  evidenceIds: z.array(DailyReflectionIdSchema).max(64),
  sourceSegmentIds: z.array(DailyReflectionIdSchema).max(64),
  evidenceSnapshots: z.array(ReflectionConfirmationEvidenceSnapshotSchema).max(64),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(4_000),
  actionClaimed: z.boolean(),
  subjectPersonId: z.null()
}).strict().superRefine((candidate, context) => {
  if (
    candidate.evidenceIds.length !== candidate.sourceSegmentIds.length
    || candidate.evidenceIds.some(
      (evidenceId, index) => evidenceId !== candidate.sourceSegmentIds[index]
    )
    || new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "V2 evidenceIds must exactly match unique sourceSegmentIds"
    });
  }
  if (
    candidate.evidenceSnapshots.length !== candidate.evidenceIds.length
    || candidate.evidenceSnapshots.some(
      (evidence, index) => evidence.sourceSegmentId !== candidate.evidenceIds[index]
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceSnapshots"],
      message: "V2 evidenceSnapshots must exactly cover evidenceIds in order"
    });
  }
  if (candidate.candidateType !== legacyCandidateKindForV2(candidate)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidateType"],
      message: "candidateType must be the deterministic V2 compatibility projection"
    });
  }
  if (candidate.finalText !== (candidate.userText ?? candidate.proposedText)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["finalText"],
      message: "finalText must be derived from userText or proposedText"
    });
  }
  if (candidate.candidateKind !== "user_action" && candidate.actionClaimed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actionClaimed"],
      message: "only user_action candidates may claim an action"
    });
  }
});

export const ReflectionConfirmationCandidateSnapshotSchema = z.union([
  ReflectionConfirmationCandidateSnapshotV1Schema,
  ReflectionConfirmationCandidateSnapshotV2Schema
]);

export const ReflectionConfirmationV1Schema = z.object({
  id: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().trim().min(1).max(512),
  sourceOrigin: SourceOriginSchema,
  inputMethod: InputMethodSchema,
  processingProfile: ProcessingProfileSchema,
  candidateSnapshots: z.array(ReflectionConfirmationCandidateSnapshotV1Schema),
  createdAt: z.string().datetime()
}).strict().superRefine((confirmation, context) => {
  for (const [candidateIndex, candidate] of confirmation.candidateSnapshots.entries()) {
    for (const [evidenceIndex, evidence] of candidate.evidenceSnapshots.entries()) {
      if (evidence.effectiveOrigin !== confirmation.sourceOrigin) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidateSnapshots", candidateIndex, "evidenceSnapshots", evidenceIndex],
          message: "confirmation Evidence origin must match sourceOrigin"
        });
      }
    }
  }
});

export const ReflectionConfirmationV2Schema = z.object({
  contractVersion: z.literal(DAILY_REFLECTION_V2_CONTRACT_VERSION),
  id: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().trim().min(1).max(512),
  operationKey: z.string().trim().min(1).max(512),
  sourceOrigin: DailyReflectionV2SourceOriginSchema,
  inputMethod: InputMethodSchema,
  processingProfile: ProcessingProfileSchema,
  inputAdapter: DailyReflectionV2InputAdapterSchema,
  capturePurpose: DailyReflectionV2CapturePurposeSchema,
  recordingDate: z.string().date(),
  saveIntent: DailyReflectionSaveIntentSchema,
  candidateSnapshots: z.array(ReflectionConfirmationCandidateSnapshotV2Schema).min(1).max(12),
  createdAt: z.string().datetime()
}).strict().superRefine((confirmation, context) => {
  for (const [candidateIndex, candidate] of confirmation.candidateSnapshots.entries()) {
    for (const [evidenceIndex, evidence] of candidate.evidenceSnapshots.entries()) {
      if (evidence.effectiveOrigin !== confirmation.sourceOrigin) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidateSnapshots", candidateIndex, "evidenceSnapshots", evidenceIndex],
          message: "confirmation Evidence origin must match sourceOrigin"
        });
      }
    }
    if (
      confirmation.saveIntent === "retain_selected"
      && candidate.status === "kept"
      && candidate.evidenceIds.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateSnapshots", candidateIndex, "evidenceIds"],
        message: "retained V2 candidates require canonical Evidence"
      });
    }
  }
});

export const ReflectionConfirmationSchema = z.union([
  ReflectionConfirmationV1Schema,
  ReflectionConfirmationV2Schema
]);

export const CandidateAdmissionResultStatusSchema = z.enum([
  "admitted",
  "rejected",
  "already_admitted",
  "retryable_error"
]);

export const CandidateAdmissionResultSchema = z.object({
  candidateId: DailyReflectionIdSchema,
  status: CandidateAdmissionResultStatusSchema,
  memoryId: DailyReflectionIdSchema.nullable(),
  reasonCode: z.string().trim().min(1).max(256).nullable(),
  errorCode: z.string().trim().min(1).max(256).nullable(),
  operationKey: z.string().trim().min(1).max(1_024),
  updatedAt: z.string().datetime()
}).strict().superRefine((result, context) => {
  const persisted = result.status === "admitted" || result.status === "already_admitted";
  if (persisted !== (result.memoryId !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memoryId"],
      message: "persisted admission results require memoryId"
    });
  }
  if ((result.status === "rejected") !== (result.reasonCode !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasonCode"],
      message: "rejected admission results require reasonCode"
    });
  }
  if ((result.status === "retryable_error") !== (result.errorCode !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["errorCode"],
      message: "retryable admission results require errorCode"
    });
  }
});

export const DailyReflectionAdmissionOperationStatusSchema = z.enum([
  "confirmation_ready",
  "admitting",
  "completed",
  "admission_failed",
  "delete_requested"
]);

export const DailyReflectionAdmissionOperationSchema = z.object({
  id: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  confirmationId: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  status: DailyReflectionAdmissionOperationStatusSchema,
  admittedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  errorCode: z.string().trim().min(1).max(256).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable()
}).strict();

export const CreateDailyReflectionInputSchema = z.object({
  id: DailyReflectionIdSchema.optional(),
  accountId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema.nullable(),
  inputMethod: InputMethodSchema,
  sourceOrigin: SourceOriginSchema,
  processingProfile: ProcessingProfileSchema,
  ingestionContext: z.literal("daily_reflection"),
  idempotencyKey: z.string().trim().min(1).max(512).nullable().optional(),
  planVersion: z.literal(DAILY_REFLECTION_PROCESSING_PLAN_VERSION).optional(),
  reviewPolicy: ReviewPolicySchema.optional()
}).strict();

export const DailyReflectionV2InputSchema = z.object({
  operationKey: z.string().trim().min(1).max(512),
  inputAdapter: DailyReflectionV2InputAdapterSchema,
  sourceOrigin: DailyReflectionV2SourceOriginSchema,
  capturePurpose: DailyReflectionV2CapturePurposeSchema,
  recordingDate: z.string().date()
}).strict();

export const CreateDailyReflectionV2InputSchema = DailyReflectionV2InputSchema.extend({
  id: DailyReflectionIdSchema.optional(),
  accountId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema.nullable().optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();

export const PendingCandidateInputSchema = z.object({
  id: DailyReflectionIdSchema.optional(),
  ordinal: z.number().int().nonnegative(),
  proposedText: z.string().trim().min(1).max(20_000),
  candidateType: CandidateKindSchema,
  sourceSegmentIds: z.array(DailyReflectionIdSchema).min(1)
}).strict().superRefine((candidate, context) => {
  if (new Set(candidate.sourceSegmentIds).size !== candidate.sourceSegmentIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceSegmentIds"],
      message: "sourceSegmentIds must be unique"
    });
  }
});

export const PendingCandidateV2InputSchema = z.object({
  id: DailyReflectionIdSchema.optional(),
  ordinal: z.number().int().nonnegative(),
  candidateKind: CandidateKindV2Schema,
  proposedText: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(DailyReflectionIdSchema).max(64),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(4_000),
  actionClaimed: z.boolean()
}).strict().superRefine((candidate, context) => {
  if (new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "evidenceIds must be unique"
    });
  }
  if (candidate.candidateKind !== "user_action" && candidate.actionClaimed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actionClaimed"],
      message: "only user_action candidates may claim an action"
    });
  }
});

export const PendingReflectionCardInputSchema = ReflectionCardBaseSchema.pick({
  id: true,
  cardKind: true,
  proposedTitle: true,
  proposedText: true,
  sourceCandidateIds: true,
  evidenceIds: true,
  clusterId: true,
  clusterTitle: true,
  displayTier: true,
  rank: true,
  confidence: true,
  importance: true,
  durability: true,
  novelty: true,
  epistemicStatus: true,
  riskFlags: true,
  actionClaimed: true,
  reviewStatus: true
}).strict();

/**
 * Compatibility adapter for records written before source provenance existed.
 * New create inputs use SourceOriginSchema directly and therefore never infer a
 * conversation origin from missing data.
 */
export function normalizeLegacySourceOrigin(value: unknown): SourceOrigin {
  const parsed = SourceOriginSchema.safeParse(value);
  return parsed.success ? parsed.data : "legacy_unknown";
}

export type InputMethod = z.infer<typeof InputMethodSchema>;
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;
export type ProcessingProfile = z.infer<typeof ProcessingProfileSchema>;
export type IngestionContext = z.infer<typeof IngestionContextSchema>;
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;
export type ProcessingPlan = z.infer<typeof ProcessingPlanSchema>;
export type DailyReflectionStatus = z.infer<typeof DailyReflectionStatusSchema>;
export type DailyReflection = z.infer<typeof DailyReflectionSchema>;
export type LegacyDailyReflection = z.infer<typeof LegacyDailyReflectionSchema>;
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;
export type CandidateKind = z.infer<typeof CandidateKindSchema>;
export type CandidateKindV2 = z.infer<typeof CandidateKindV2Schema>;
export type DailyReflectionV2InputAdapter = z.infer<
  typeof DailyReflectionV2InputAdapterSchema
>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type CandidateV2 = z.infer<typeof CandidateV2Schema>;
export type ReflectionCard = z.infer<typeof ReflectionCardSchema>;
export type ReflectionConfirmationCandidateSnapshot = z.infer<
  typeof ReflectionConfirmationCandidateSnapshotSchema
>;
export type ReflectionConfirmationCandidateSnapshotV2 = z.infer<
  typeof ReflectionConfirmationCandidateSnapshotV2Schema
>;
export type ReflectionConfirmationEvidenceSnapshot = z.infer<
  typeof ReflectionConfirmationEvidenceSnapshotSchema
>;
export type ReflectionConfirmation = z.infer<typeof ReflectionConfirmationSchema>;
export type ReflectionConfirmationV2 = z.infer<typeof ReflectionConfirmationV2Schema>;
export type CandidateAdmissionResultStatus = z.infer<
  typeof CandidateAdmissionResultStatusSchema
>;
export type CandidateAdmissionResult = z.infer<typeof CandidateAdmissionResultSchema>;
export type DailyReflectionAdmissionOperationStatus = z.infer<
  typeof DailyReflectionAdmissionOperationStatusSchema
>;
export type DailyReflectionAdmissionOperation = z.infer<
  typeof DailyReflectionAdmissionOperationSchema
>;
export type CreateDailyReflectionInput = z.infer<typeof CreateDailyReflectionInputSchema>;
export type DailyReflectionV2Input = z.infer<typeof DailyReflectionV2InputSchema>;
export type CreateDailyReflectionV2Input = z.infer<
  typeof CreateDailyReflectionV2InputSchema
>;
export type PendingCandidateInput = z.infer<typeof PendingCandidateInputSchema>;
export type PendingCandidateV2Input = z.infer<typeof PendingCandidateV2InputSchema>;
export type PendingReflectionCardInput = z.infer<typeof PendingReflectionCardInputSchema>;
