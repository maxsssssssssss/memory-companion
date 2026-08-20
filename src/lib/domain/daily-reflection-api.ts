import { z } from "zod";

import {
  CandidateKindSchema,
  CandidateAdmissionResultSchema,
  CandidateSchema,
  CandidateStatusSchema,
  CandidateUserTextInputSchema,
  DailyReflectionAdmissionOperationSchema,
  DailyReflectionIdSchema,
  DailyReflectionSchema,
  DailyReflectionStatusSchema,
  DailyReflectionVersionSchema,
  ProcessingPlanSchema,
  ReflectionConfirmationSchema,
  SourceOriginSchema
} from "./daily-reflection";
import {
  AudioUploadSchema,
  PipelineExecutionModeSchema,
  SceneLabelSchema,
  TranscriptSpeakerIdentitySchema,
  ValueLabelSchema
} from "./types";

export const DailyReflectionUploadViewSchema = AudioUploadSchema.strict();

export const DailyReflectionUploadSourceSchema = SourceOriginSchema.extract([
  "user_reflection",
  "direct_conversation",
  "unknown"
]);

export const DailyReflectionTranscriptSegmentViewSchema = z.object({
  id: z.string().min(1),
  uploadId: z.string().min(1),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  speaker: z.string().optional(),
  identity: TranscriptSpeakerIdentitySchema.optional(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sceneLabels: z.array(SceneLabelSchema),
  valueLabels: z.array(ValueLabelSchema)
}).strict().refine((segment) => segment.endSeconds > segment.startSeconds, {
  message: "segment endSeconds must be greater than startSeconds"
});

export const DailyReflectionJobViewSchema = z.object({
  id: z.string().min(1),
  reflectionId: z.string().min(1),
  uploadId: z.string().min(1),
  status: z.enum(["waiting", "processing", "completed", "failed", "cancelled"]),
  progress: z.number().min(0).max(100),
  executionMode: PipelineExecutionModeSchema,
  queueJobId: z.string().min(1).optional(),
  queuedAt: z.string().datetime().optional(),
  workerStartedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  errorCode: z.string().min(1).max(256).optional(),
  errorMessage: z.string().min(1).max(4_000).optional()
}).strict();

export const DailyReflectionCandidateEvidenceSchema = z.object({
  sourceSegmentId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema,
  effectiveOrigin: SourceOriginSchema,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  text: z.string().min(1)
}).strict().refine((evidence) => evidence.endSeconds > evidence.startSeconds, {
  message: "evidence endSeconds must be greater than startSeconds"
});

export const DailyReflectionCandidateViewSchema = z.object({
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
  updatedAt: z.string().datetime(),
  evidence: z.array(DailyReflectionCandidateEvidenceSchema).min(1)
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
    addIssue(
      context,
      ["subjectPersonId"],
      "only kept candidates may retain a Subject association"
    );
  }
});

export const DailyReflectionCandidateDecisionSchema = z.object({
  candidateId: DailyReflectionIdSchema,
  status: CandidateStatusSchema,
  userText: CandidateUserTextInputSchema,
  subjectPersonId: DailyReflectionIdSchema.nullable()
}).strict().superRefine((candidate, context) => {
  if (candidate.status !== "kept" && candidate.subjectPersonId !== null) {
    addIssue(context, ["subjectPersonId"], "only kept candidates may select a Subject");
  }
});

export const DailyReflectionCandidateUpdateRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  candidates: z.array(DailyReflectionCandidateDecisionSchema).min(1)
}).strict().superRefine((input, context) => {
  const ids = input.candidates.map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length) {
    addIssue(context, ["candidates"], "candidate ids must be unique");
  }
});

export const DailyReflectionFinalizeRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  idempotencyKey: z.string().trim().min(1).max(512)
}).strict();

export const DailyReflectionCandidateRevocationRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  idempotencyKey: z.string().trim().min(1).max(512)
}).strict();

export const DailyReflectionCandidateRevocationResponseSchema = z.object({
  reflectionId: DailyReflectionIdSchema,
  candidateId: DailyReflectionIdSchema,
  reflectionStatus: DailyReflectionStatusSchema,
  reflectionVersion: DailyReflectionVersionSchema,
  revocationStatus: z.literal("completed"),
  outcome: z.enum(["revoked", "no_long_term_object"]),
  rememberedCount: z.number().int().nonnegative(),
  reused: z.boolean()
}).strict();

export const DailyReflectionHistoryItemSchema = z.object({
  id: DailyReflectionIdSchema,
  status: DailyReflectionStatusSchema.exclude(["deleted"]),
  inputMethod: z.enum(["file_upload", "browser_recording"]),
  sourceOrigin: DailyReflectionUploadSourceSchema,
  recordingDate: z.string().date().nullable(),
  sourceStatement: z.string().trim().min(1).max(200),
  candidateCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  keptCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  rememberedCount: z.number().int().nonnegative(),
  notSavedCount: z.number().int().nonnegative(),
  subjectPersonIds: z.array(DailyReflectionIdSchema),
  transcriptAvailable: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine((item, context) => {
  if (new Set(item.subjectPersonIds).size !== item.subjectPersonIds.length) {
    addIssue(context, ["subjectPersonIds"], "subjectPersonIds must be unique");
  }
  if (item.pendingCount + item.keptCount + item.excludedCount !== item.candidateCount) {
    addIssue(context, ["candidateCount"], "candidate counts must cover every candidate");
  }
});

export const DailyReflectionHistoryResponseSchema = z.object({
  reflections: z.array(DailyReflectionHistoryItemSchema).max(24)
}).strict();

function addIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string
) {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

export const DailyReflectionDetailResponseSchema = z.object({
  reflection: DailyReflectionSchema,
  processingPlan: ProcessingPlanSchema.nullable(),
  job: DailyReflectionJobViewSchema.nullable(),
  upload: DailyReflectionUploadViewSchema.nullable(),
  segments: z.array(DailyReflectionTranscriptSegmentViewSchema),
  effectiveOrigin: SourceOriginSchema.nullable(),
  candidates: z.array(DailyReflectionCandidateViewSchema),
  confirmation: ReflectionConfirmationSchema.nullable().default(null),
  admissionOperation: DailyReflectionAdmissionOperationSchema.nullable().default(null),
  admissionResults: z.array(CandidateAdmissionResultSchema).default([]),
  rememberedCount: z.number().int().nonnegative().optional(),
  revokedCandidateIds: z.array(DailyReflectionIdSchema).optional()
}).strict().superRefine((detail, context) => {
  const plan = detail.processingPlan;
  const segmentById = new Map(detail.segments.map((segment) => [segment.id, segment]));

  if (segmentById.size !== detail.segments.length) {
    addIssue(context, ["segments"], "segment ids must be unique");
  }

  if (!plan) {
    if (detail.effectiveOrigin !== null) {
      addIssue(context, ["effectiveOrigin"], "effectiveOrigin requires a processing plan");
    }
    if (detail.upload !== null) {
      addIssue(context, ["upload"], "upload requires a processing plan");
    }
    if (detail.segments.length > 0) {
      addIssue(context, ["segments"], "segments require a processing plan");
    }
    if (detail.job !== null) {
      addIssue(context, ["job"], "job requires a processing plan");
    }
  } else {
    if (plan.reflectionId !== detail.reflection.id) {
      addIssue(context, ["processingPlan", "reflectionId"], "processing plan reflection mismatch");
    }
    if (detail.reflection.uploadId !== plan.uploadId) {
      addIssue(context, ["reflection", "uploadId"], "reflection upload mismatch");
    }
    if (detail.effectiveOrigin !== plan.sourceOrigin) {
      addIssue(context, ["effectiveOrigin"], "effectiveOrigin must come from the processing plan");
    }
    if (detail.upload && detail.upload.id !== plan.uploadId) {
      addIssue(context, ["upload", "id"], "upload does not match the processing plan");
    }
    detail.segments.forEach((segment, index) => {
      if (segment.uploadId !== plan.uploadId) {
        addIssue(context, ["segments", index, "uploadId"], "segment upload mismatch");
      }
    });
    if (detail.job) {
      if (detail.job.reflectionId !== detail.reflection.id) {
        addIssue(context, ["job", "reflectionId"], "job reflection mismatch");
      }
      if (detail.job.uploadId !== plan.uploadId) {
        addIssue(context, ["job", "uploadId"], "job upload mismatch");
      }
    }
  }

  if (
    (
      detail.reflection.status === "review_pending"
      || detail.reflection.status === "confirmation_ready"
      || detail.reflection.status === "admitting"
      || detail.reflection.status === "completed"
      || detail.reflection.status === "admission_failed"
    )
    && (!plan || detail.upload === null || detail.segments.length === 0)
  ) {
    addIssue(
      context,
      ["reflection", "status"],
      "review_pending detail requires a plan, upload, and canonical transcript"
    );
  }

  detail.candidates.forEach((candidate, candidateIndex) => {
    if (candidate.reflectionId !== detail.reflection.id) {
      addIssue(
        context,
        ["candidates", candidateIndex, "reflectionId"],
        "candidate reflection mismatch"
      );
    }
    if (candidate.evidence.length !== candidate.sourceSegmentIds.length) {
      addIssue(
        context,
        ["candidates", candidateIndex, "evidence"],
        "candidate evidence must cover every source segment"
      );
    }
    candidate.sourceSegmentIds.forEach((sourceSegmentId, evidenceIndex) => {
      const evidence = candidate.evidence[evidenceIndex];
      const segment = segmentById.get(sourceSegmentId);
      if (!evidence || evidence.sourceSegmentId !== sourceSegmentId) {
        addIssue(
          context,
          ["candidates", candidateIndex, "evidence", evidenceIndex],
          "candidate evidence order must match sourceSegmentIds"
        );
        return;
      }
      if (!segment) {
        addIssue(
          context,
          ["candidates", candidateIndex, "sourceSegmentIds", evidenceIndex],
          "candidate source segment is unavailable"
        );
        return;
      }
      if (
        evidence.uploadId !== segment.uploadId
        || evidence.startSeconds !== segment.startSeconds
        || evidence.endSeconds !== segment.endSeconds
        || evidence.text !== segment.text
      ) {
        addIssue(
          context,
          ["candidates", candidateIndex, "evidence", evidenceIndex],
          "candidate evidence must match the canonical transcript"
        );
      }
      if (!plan || evidence.effectiveOrigin !== plan.sourceOrigin) {
        addIssue(
          context,
          ["candidates", candidateIndex, "evidence", evidenceIndex, "effectiveOrigin"],
          "candidate effectiveOrigin must come from the processing plan"
        );
      }
    });
  });

  if (detail.confirmation) {
    if (
      detail.confirmation.reflectionId !== detail.reflection.id
      || detail.confirmation.accountId !== detail.reflection.accountId
    ) {
      addIssue(context, ["confirmation"], "confirmation does not belong to this Reflection");
    }
  }
  if (detail.admissionOperation) {
    if (
      detail.admissionOperation.reflectionId !== detail.reflection.id
      || detail.admissionOperation.accountId !== detail.reflection.accountId
      || detail.admissionOperation.confirmationId !== detail.confirmation?.id
    ) {
      addIssue(context, ["admissionOperation"], "admission operation does not match confirmation");
    }
  } else if (detail.admissionResults.length > 0) {
    addIssue(context, ["admissionResults"], "admission results require an operation");
  }

  if ((detail.rememberedCount === undefined) !== (detail.revokedCandidateIds === undefined)) {
    addIssue(
      context,
      ["rememberedCount"],
      "rememberedCount and revokedCandidateIds must be provided together"
    );
  }
  if (detail.rememberedCount !== undefined && detail.revokedCandidateIds !== undefined) {
    const revoked = new Set(detail.revokedCandidateIds);
    if (revoked.size !== detail.revokedCandidateIds.length) {
      addIssue(context, ["revokedCandidateIds"], "revoked candidate ids must be unique");
    }
    const candidateIds = new Set(detail.candidates.map((candidate) => candidate.id));
    const admittedIds = new Set(detail.admissionResults
      .filter((result) => result.status === "admitted" || result.status === "already_admitted")
      .map((result) => result.candidateId));
    detail.revokedCandidateIds.forEach((candidateId, index) => {
      if (!candidateIds.has(candidateId) || !admittedIds.has(candidateId)) {
        addIssue(
          context,
          ["revokedCandidateIds", index],
          "revoked candidates must belong to persisted admission results"
        );
      }
    });
    const expectedRememberedCount = [...admittedIds]
      .filter((candidateId) => !revoked.has(candidateId)).length;
    if (detail.rememberedCount !== expectedRememberedCount) {
      addIssue(
        context,
        ["rememberedCount"],
        "rememberedCount must match active persisted admission results"
      );
    }
  }
});

export const DailyReflectionFinalizeResponseSchema = z.object({
  reflection: DailyReflectionSchema,
  confirmation: ReflectionConfirmationSchema,
  admissionOperation: DailyReflectionAdmissionOperationSchema,
  admissionResults: z.array(CandidateAdmissionResultSchema),
  reused: z.boolean()
}).strict();

export const DailyReflectionCandidateUpdateResponseSchema = z.object({
  reflection: DailyReflectionSchema,
  candidates: z.array(CandidateSchema)
}).strict();

export type DailyReflectionUploadView = z.infer<typeof DailyReflectionUploadViewSchema>;
export type DailyReflectionUploadSource = z.infer<
  typeof DailyReflectionUploadSourceSchema
>;
export type DailyReflectionTranscriptSegmentView = z.infer<
  typeof DailyReflectionTranscriptSegmentViewSchema
>;
export type DailyReflectionJobView = z.infer<typeof DailyReflectionJobViewSchema>;
export type DailyReflectionCandidateEvidence = z.infer<
  typeof DailyReflectionCandidateEvidenceSchema
>;
export type DailyReflectionCandidateView = z.infer<typeof DailyReflectionCandidateViewSchema>;
export type DailyReflectionCandidateDecision = z.infer<
  typeof DailyReflectionCandidateDecisionSchema
>;
export type DailyReflectionCandidateUpdateRequest = z.infer<
  typeof DailyReflectionCandidateUpdateRequestSchema
>;
export type DailyReflectionFinalizeRequest = z.infer<
  typeof DailyReflectionFinalizeRequestSchema
>;
export type DailyReflectionCandidateRevocationRequest = z.infer<
  typeof DailyReflectionCandidateRevocationRequestSchema
>;
export type DailyReflectionCandidateRevocationResponse = z.infer<
  typeof DailyReflectionCandidateRevocationResponseSchema
>;
export type DailyReflectionDetailResponse = z.infer<
  typeof DailyReflectionDetailResponseSchema
>;
export type DailyReflectionFinalizeResponse = z.infer<
  typeof DailyReflectionFinalizeResponseSchema
>;
export type DailyReflectionCandidateUpdateResponse = z.infer<
  typeof DailyReflectionCandidateUpdateResponseSchema
>;
export type DailyReflectionHistoryItem = z.infer<
  typeof DailyReflectionHistoryItemSchema
>;
export type DailyReflectionHistoryResponse = z.infer<
  typeof DailyReflectionHistoryResponseSchema
>;
