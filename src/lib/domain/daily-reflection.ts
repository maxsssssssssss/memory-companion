import { z } from "zod";

export const DAILY_REFLECTION_PROCESSING_PLAN_VERSION = 1 as const;

export const DailyReflectionIdSchema = z.string().trim().min(1).max(512);
export const DailyReflectionVersionSchema = z.number().int().nonnegative();

export const InputMethodSchema = z.enum([
  "file_upload",
  "browser_recording"
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

export const ProcessingPlanSchema = z.object({
  planVersion: z.literal(DAILY_REFLECTION_PROCESSING_PLAN_VERSION),
  reflectionId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema,
  inputMethod: InputMethodSchema,
  sourceOrigin: SourceOriginSchema,
  processingProfile: ProcessingProfileSchema,
  ingestionContext: IngestionContextSchema,
  reviewPolicy: ReviewPolicySchema
}).strict();

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

export const CandidateSchema = z.object({
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

export const ReflectionConfirmationCandidateSnapshotSchema = z.object({
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

export const ReflectionConfirmationSchema = z.object({
  id: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().trim().min(1).max(512),
  sourceOrigin: SourceOriginSchema,
  inputMethod: InputMethodSchema,
  processingProfile: ProcessingProfileSchema,
  candidateSnapshots: z.array(ReflectionConfirmationCandidateSnapshotSchema),
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
export type Candidate = z.infer<typeof CandidateSchema>;
export type ReflectionConfirmationCandidateSnapshot = z.infer<
  typeof ReflectionConfirmationCandidateSnapshotSchema
>;
export type ReflectionConfirmationEvidenceSnapshot = z.infer<
  typeof ReflectionConfirmationEvidenceSnapshotSchema
>;
export type ReflectionConfirmation = z.infer<typeof ReflectionConfirmationSchema>;
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
export type PendingCandidateInput = z.infer<typeof PendingCandidateInputSchema>;
