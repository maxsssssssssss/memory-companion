import { z } from "zod";

import {
  CandidateKindSchema,
  CandidateKindV2Schema,
  CandidateAdmissionResultSchema,
  CandidateSchema,
  CandidateStatusSchema,
  CandidateUserTextInputSchema,
  DailyReflectionAdmissionOperationSchema,
  DailyReflectionIdSchema,
  DailyReflectionSchema,
  DailyReflectionStatusSchema,
  DailyReflectionVersionSchema,
  DailyReflectionV2InputSchema,
  DailyReflectionSaveIntentSchema,
  DAILY_REFLECTION_V2_CONTRACT_VERSION,
  ProcessingPlanSchema,
  ReflectionConfirmationSchema,
  ReflectionConfirmationV2Schema,
  ReflectionCardBaseSchema,
  ReflectionCardSchema,
  SourceOriginSchema
} from "./daily-reflection";
import {
  DailyReflectionWorkingCardKindSchema,
  DailyReflectionWorkingCardBaseSchema,
  DailyReflectionWorkingCardMemoryLifecycleStatusSchema,
  DailyReflectionWorkingCardStatusSchema
} from "./daily-reflection-working-card";
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

export const DailyReflectionCandidateV1ViewSchema = z.object({
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

export const DailyReflectionCandidateV2ViewSchema = z.object({
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
  updatedAt: z.string().datetime(),
  evidence: z.array(DailyReflectionCandidateEvidenceSchema).max(64)
}).strict().superRefine((candidate, context) => {
  if (
    candidate.evidenceIds.length !== candidate.sourceSegmentIds.length
    || candidate.evidenceIds.some(
      (evidenceId, index) => evidenceId !== candidate.sourceSegmentIds[index]
    )
  ) {
    addIssue(context, ["evidenceIds"], "V2 evidenceIds must match sourceSegmentIds");
  }
});

export const DailyReflectionCandidateViewSchema = z.union([
  DailyReflectionCandidateV1ViewSchema,
  DailyReflectionCandidateV2ViewSchema
]);

export const DailyReflectionCardViewSchema = ReflectionCardBaseSchema.extend({
  evidence: z.array(DailyReflectionCandidateEvidenceSchema).min(1).max(64)
}).strict().superRefine((card, context) => {
  if (new Set(card.sourceCandidateIds).size !== card.sourceCandidateIds.length) {
    addIssue(context, ["sourceCandidateIds"], "sourceCandidateIds must be unique");
  }
  if (new Set(card.evidenceIds).size !== card.evidenceIds.length) {
    addIssue(context, ["evidenceIds"], "evidenceIds must be unique");
  }
  if (card.displayTier === "primary" && card.reviewStatus === "not_proposed") {
    addIssue(context, ["reviewStatus"], "primary cards must be proposed for review");
  }
  if (card.displayTier === "more" && card.reviewStatus === "pending") {
    addIssue(context, ["reviewStatus"], "More cards do not block review by default");
  }
  if (card.cardKind !== "user_action" && card.actionClaimed) {
    addIssue(context, ["actionClaimed"], "only user_action cards may claim an action");
  }
  if (
    card.evidence.length !== card.evidenceIds.length
    || card.evidence.some(
      (evidence, index) => evidence.sourceSegmentId !== card.evidenceIds[index]
    )
  ) {
    addIssue(context, ["evidence"], "Card Evidence must exactly cover evidenceIds");
  }
});

export const DailyReflectionCardDecisionSchema = z.object({
  cardId: DailyReflectionIdSchema,
  reviewStatus: z.enum(["not_proposed", "pending", "kept", "excluded"]),
  userTitle: z.union([
    z.string().max(240).transform((value) => value.trim() || null),
    z.null()
  ]),
  userText: z.union([
    z.string().max(4_000).transform((value) => value.trim() || null),
    z.null()
  ]),
  actionClaimed: z.boolean().optional(),
  promoteToPrimary: z.literal(true).optional()
}).strict();

export const DailyReflectionCardUpdateRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  cards: z.array(DailyReflectionCardDecisionSchema).min(1)
}).strict().superRefine((input, context) => {
  const ids = input.cards.map((card) => card.cardId);
  if (new Set(ids).size !== ids.length) {
    addIssue(context, ["cards"], "card ids must be unique");
  }
});

export const DailyReflectionCardUpdateResponseSchema = z.object({
  reflection: DailyReflectionSchema,
  cards: z.array(ReflectionCardSchema)
}).strict();

export const DailyReflectionWorkingCardViewSchema = DailyReflectionWorkingCardBaseSchema
  .omit({ accountId: true })
  .strict();

export const DailyReflectionWorkingCardDetailViewSchema = DailyReflectionWorkingCardViewSchema
  .extend({
    evidence: z.array(DailyReflectionCandidateEvidenceSchema).max(64)
  })
  .strict()
  .superRefine((card, context) => {
    if (card.sourceUnavailable) {
      if (card.evidence.length > 0) {
        addIssue(context, ["evidence"], "source-unavailable Cards cannot expose Evidence");
      }
      return;
    }
    if (
      card.evidence.length !== card.evidenceIds.length
      || card.evidence.some(
        (evidence, index) => evidence.sourceSegmentId !== card.evidenceIds[index]
      )
    ) {
      addIssue(context, ["evidence"], "Working Card Evidence must exactly cover evidenceIds");
    }
  });

export const DailyReflectionWorkingCardListQuerySchema = z.object({
  reflectionId: DailyReflectionIdSchema.optional(),
  cardKind: DailyReflectionWorkingCardKindSchema.optional(),
  status: DailyReflectionWorkingCardStatusSchema.optional(),
  query: z.string().trim().max(200).optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  sort: z.enum(["updated_desc", "created_desc", "created_asc", "title_asc"])
    .default("updated_desc"),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().nonnegative().default(0)
}).strict().superRefine((input, context) => {
  if (input.createdFrom && input.createdTo && input.createdFrom > input.createdTo) {
    addIssue(context, ["createdTo"], "createdTo must not precede createdFrom");
  }
});

export const DailyReflectionWorkingCardListResponseSchema = z.object({
  cards: z.array(DailyReflectionWorkingCardViewSchema).max(100),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative()
}).strict();

export const DailyReflectionWorkingCardDetailResponseSchema = z.object({
  card: DailyReflectionWorkingCardDetailViewSchema
}).strict();

export const DailyReflectionWorkingCardStateViewSchema = z.object({
  id: DailyReflectionIdSchema,
  status: DailyReflectionWorkingCardStatusSchema,
  memoryLifecycleStatus: DailyReflectionWorkingCardMemoryLifecycleStatusSchema.optional(),
  version: DailyReflectionVersionSchema
}).strict();

export const DailyReflectionWorkingCardSaveRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema
}).strict();

export const DailyReflectionWorkingCardUpdateRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  title: z.string().trim().min(1).max(240).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  cardKind: DailyReflectionWorkingCardKindSchema.optional(),
  relatedCardIds: z.array(DailyReflectionIdSchema).max(64).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(24).optional(),
  visibility: z.literal("private").optional()
}).strict().superRefine((input, context) => {
  if (
    input.title === undefined
    && input.content === undefined
    && input.cardKind === undefined
    && input.relatedCardIds === undefined
    && input.tags === undefined
    && input.visibility === undefined
  ) {
    addIssue(context, [], "an update is required");
  }
  for (const field of ["relatedCardIds", "tags"] as const) {
    const values = input[field];
    if (values && new Set(values).size !== values.length) {
      addIssue(context, [field], `${field} must be unique`);
    }
  }
});

export const DailyReflectionWorkingCardLifecycleRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema
}).strict();

export const DailyReflectionCandidateDecisionSchema = z.object({
  candidateId: DailyReflectionIdSchema,
  status: CandidateStatusSchema,
  userText: CandidateUserTextInputSchema,
  subjectPersonId: DailyReflectionIdSchema.nullable(),
  actionClaimed: z.boolean().optional()
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

export const DailyReflectionManualCandidateV2CreateRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  candidateKind: CandidateKindV2Schema,
  proposedText: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(DailyReflectionIdSchema).max(64),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(4_000),
  actionClaimed: z.boolean()
}).strict().superRefine((candidate, context) => {
  if (new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length) {
    addIssue(context, ["evidenceIds"], "evidenceIds must be unique");
  }
  if (candidate.candidateKind !== "user_action" && candidate.actionClaimed) {
    addIssue(context, ["actionClaimed"], "only user_action may claim an action");
  }
  if (candidate.actionClaimed && candidate.evidenceIds.length === 0) {
    addIssue(context, ["evidenceIds"], "claimed actions require canonical Evidence");
  }
});

export const DailyReflectionManualCandidateV2CreateResponseSchema = z.object({
  reflection: DailyReflectionSchema,
  candidate: CandidateSchema,
  retentionEligibility: z.enum(["retain_selected", "recap_only"])
}).strict();

export const DailyReflectionCandidateExcludeRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema
}).strict();

export const DailyReflectionCandidateExcludeResponseSchema = z.object({
  reflection: DailyReflectionSchema,
  candidate: CandidateSchema,
  disposition: z.literal("excluded"),
  recoverable: z.literal(true)
}).strict();

export const DailyReflectionFinalizeRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  idempotencyKey: z.string().trim().min(1).max(512)
}).strict();

export const DailyReflectionV2CreateRequestSchema = DailyReflectionV2InputSchema;

// Only accepted permits discarding the local audio. Reupload permission is a
// snapshot: POST must still claim the existing execution fence for the same key.
export const DailyReflectionOperationUploadStateSchema = z.enum([
  "still_persisting",
  "accepted",
  "reupload_allowed",
  "unresolved",
  "terminated"
]);
export type DailyReflectionOperationUploadState = z.infer<
  typeof DailyReflectionOperationUploadStateSchema
>;

export const DailyReflectionOperationLookupResponseSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }).strict(),
  z.object({
    found: z.literal(true),
    reflectionId: DailyReflectionIdSchema,
    uploadId: DailyReflectionIdSchema,
    jobId: DailyReflectionIdSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    status: DailyReflectionStatusSchema,
    uploadState: DailyReflectionOperationUploadStateSchema
  }).strict()
]);

export const DailyReflectionV2FinalizeRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  operationKey: z.string().trim().min(1).max(512),
  saveIntent: DailyReflectionSaveIntentSchema
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
  cards: z.array(DailyReflectionCardViewSchema).default([]),
  workingCards: z.array(DailyReflectionWorkingCardStateViewSchema).max(100).optional(),
  confirmation: ReflectionConfirmationSchema.nullable().default(null),
  admissionOperation: DailyReflectionAdmissionOperationSchema.nullable().default(null),
  admissionResults: z.array(CandidateAdmissionResultSchema).default([]),
  rememberedCount: z.number().int().nonnegative().optional(),
  revokedCandidateIds: z.array(DailyReflectionIdSchema).optional()
}).strict().superRefine((detail, context) => {
  const plan = detail.processingPlan;
  const segmentById = new Map(detail.segments.map((segment) => [segment.id, segment]));

  if (
    detail.workingCards
    && new Set(detail.workingCards.map((card) => card.id)).size !== detail.workingCards.length
  ) {
    addIssue(context, ["workingCards"], "Working Card ids must be unique");
  }

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

  const evidenceFreeV2Recap = detail.confirmation !== null
    && "contractVersion" in detail.confirmation
    && detail.confirmation.contractVersion === 2
    && detail.confirmation.saveIntent === "recap_only"
    && detail.confirmation.candidateSnapshots.every(
      (candidate) => candidate.evidenceIds.length === 0
    );
  if (
    (
      detail.reflection.status === "review_pending"
      || detail.reflection.status === "confirmation_ready"
      || detail.reflection.status === "admitting"
      || detail.reflection.status === "completed"
      || detail.reflection.status === "admission_failed"
    )
    && (
      !plan
      || detail.upload === null
      || (detail.segments.length === 0 && !evidenceFreeV2Recap)
    )
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

  detail.cards.forEach((card, cardIndex) => {
    if (card.reflectionId !== detail.reflection.id) {
      addIssue(context, ["cards", cardIndex, "reflectionId"], "card reflection mismatch");
    }
    card.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      const evidence = card.evidence[evidenceIndex];
      const segment = segmentById.get(evidenceId);
      if (!evidence || !segment || evidence.sourceSegmentId !== evidenceId) {
        addIssue(context, ["cards", cardIndex, "evidence", evidenceIndex], "card Evidence is unavailable");
        return;
      }
      if (
        evidence.uploadId !== segment.uploadId
        || evidence.startSeconds !== segment.startSeconds
        || evidence.endSeconds !== segment.endSeconds
        || evidence.text !== segment.text
        || !plan
        || evidence.effectiveOrigin !== plan.sourceOrigin
      ) {
        addIssue(context, ["cards", cardIndex, "evidence", evidenceIndex], "card Evidence must match the canonical transcript");
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
    const inactiveWorkingCardIds = new Set((detail.workingCards ?? [])
      .filter((card) => (
        card.memoryLifecycleStatus === "revocation_requested"
        || card.memoryLifecycleStatus === "revoked"
      ))
      .map((card) => card.id));
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
      .filter((candidateId) => (
        !revoked.has(candidateId)
        && !inactiveWorkingCardIds.has(candidateId)
      )).length;
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

export const DailyReflectionV2FinalizeRecapResponseSchema = z.object({
  reflection: DailyReflectionSchema,
  confirmation: ReflectionConfirmationV2Schema,
  admission: z.object({ exists: z.literal(false) }).strict(),
  reused: z.boolean()
}).strict();

export const DailyReflectionV2FinalizeRetainedResponseSchema = z.object({
  reflection: DailyReflectionSchema,
  confirmation: ReflectionConfirmationV2Schema,
  admission: z.object({
    exists: z.literal(true),
    operation: DailyReflectionAdmissionOperationSchema,
    results: z.array(CandidateAdmissionResultSchema)
  }).strict(),
  reused: z.boolean()
}).strict();

export const DailyReflectionV2FinalizeResponseSchema = z.union([
  DailyReflectionV2FinalizeRecapResponseSchema,
  DailyReflectionV2FinalizeRetainedResponseSchema
]);

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
export type DailyReflectionCardView = z.infer<typeof DailyReflectionCardViewSchema>;
export type DailyReflectionCardDecision = z.infer<typeof DailyReflectionCardDecisionSchema>;
export type DailyReflectionCardUpdateRequest = z.infer<
  typeof DailyReflectionCardUpdateRequestSchema
>;
export type DailyReflectionCardUpdateResponse = z.infer<
  typeof DailyReflectionCardUpdateResponseSchema
>;
export type DailyReflectionWorkingCardView = z.infer<
  typeof DailyReflectionWorkingCardViewSchema
>;
export type DailyReflectionWorkingCardDetailView = z.infer<
  typeof DailyReflectionWorkingCardDetailViewSchema
>;
export type DailyReflectionWorkingCardListQuery = z.infer<
  typeof DailyReflectionWorkingCardListQuerySchema
>;
export type DailyReflectionWorkingCardListResponse = z.infer<
  typeof DailyReflectionWorkingCardListResponseSchema
>;
export type DailyReflectionWorkingCardDetailResponse = z.infer<
  typeof DailyReflectionWorkingCardDetailResponseSchema
>;
export type DailyReflectionWorkingCardSaveRequest = z.infer<
  typeof DailyReflectionWorkingCardSaveRequestSchema
>;
export type DailyReflectionWorkingCardUpdateRequest = z.infer<
  typeof DailyReflectionWorkingCardUpdateRequestSchema
>;
export type DailyReflectionWorkingCardLifecycleRequest = z.infer<
  typeof DailyReflectionWorkingCardLifecycleRequestSchema
>;
export type DailyReflectionCandidateDecision = z.infer<
  typeof DailyReflectionCandidateDecisionSchema
>;
export type DailyReflectionCandidateUpdateRequest = z.infer<
  typeof DailyReflectionCandidateUpdateRequestSchema
>;
export type DailyReflectionFinalizeRequest = z.infer<
  typeof DailyReflectionFinalizeRequestSchema
>;
export type DailyReflectionV2CreateRequest = z.infer<
  typeof DailyReflectionV2CreateRequestSchema
>;
export type DailyReflectionV2FinalizeRequest = z.infer<
  typeof DailyReflectionV2FinalizeRequestSchema
>;
export type DailyReflectionOperationLookupResponse = z.infer<
  typeof DailyReflectionOperationLookupResponseSchema
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
export type DailyReflectionV2FinalizeResponse = z.infer<
  typeof DailyReflectionV2FinalizeResponseSchema
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
