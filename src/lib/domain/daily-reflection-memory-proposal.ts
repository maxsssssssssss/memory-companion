import { z } from "zod";

import {
  DailyReflectionIdSchema,
  DailyReflectionV2CapturePurposeSchema,
  DailyReflectionV2InputAdapterSchema,
  DailyReflectionV2SourceOriginSchema,
  DailyReflectionVersionSchema,
  ReflectionCardEpistemicStatusSchema,
  ReflectionCardRiskFlagSchema,
  SourceOriginSchema
} from "./daily-reflection";
import { DailyReflectionWorkingCardKindSchema } from "./daily-reflection-working-card";

export const DailyReflectionMemoryProposalTypeSchema = z.enum([
  "summary",
  "question",
  "decision",
  "commitment",
  "preference",
  "person_fact",
  "event"
]);

export type DailyReflectionMemoryProposalType = z.infer<
  typeof DailyReflectionMemoryProposalTypeSchema
>;

export const DailyReflectionMemoryProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "admitted"
]);

export const DailyReflectionMemoryProposalEpistemicCautionSchema = z
  .literal("reported_inference")
  .nullable();

export const DailyReflectionMemoryProposalReasonSchema = z.string()
  .trim()
  .min(1)
  .max(256);

export const DailyReflectionMemoryProposalAcknowledgementSchema = z.enum([
  "acknowledge_sensitive_content",
  "acknowledge_inference",
  "acknowledge_attribution_uncertainty"
]);

export const DailyReflectionMemoryProposalConfirmationRequirementCodeSchema = z.enum([
  ...DailyReflectionMemoryProposalAcknowledgementSchema.options,
  "verify_fact_owner"
]);

export const DailyReflectionMemoryProposalConfirmationRequirementSchema = z.object({
  code: DailyReflectionMemoryProposalConfirmationRequirementCodeSchema,
  resolution: z.enum(["acknowledgement", "verified_owner"])
}).strict();

export type DailyReflectionMemoryProposalAcknowledgement = z.infer<
  typeof DailyReflectionMemoryProposalAcknowledgementSchema
>;

export type DailyReflectionMemoryProposalConfirmationRequirement = z.infer<
  typeof DailyReflectionMemoryProposalConfirmationRequirementSchema
>;

const CONFIRMATION_REQUIRED_PREFIX = "confirmation_required:";

export function memoryProposalConfirmationRequirements(
  reasons: string[]
): DailyReflectionMemoryProposalConfirmationRequirement[] {
  const codes = new Set(reasons.flatMap((reason) => {
    if (!reason.startsWith(CONFIRMATION_REQUIRED_PREFIX)) return [];
    const parsed = DailyReflectionMemoryProposalConfirmationRequirementCodeSchema
      .safeParse(reason.slice(CONFIRMATION_REQUIRED_PREFIX.length));
    return parsed.success ? [parsed.data] : [];
  }));
  return [...codes].sort().map((code) => ({
    code,
    resolution: code === "verify_fact_owner"
      ? "verified_owner" as const
      : "acknowledgement" as const
  }));
}

export const DailyReflectionMemoryProposalEvidenceSnapshotSchema = z.object({
  sourceSegmentId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  effectiveOrigin: SourceOriginSchema
}).strict().refine((evidence) => evidence.endSeconds > evidence.startSeconds, {
  message: "evidence endSeconds must be greater than startSeconds"
});

export const DailyReflectionMemoryProposalSchema = z.object({
  id: DailyReflectionIdSchema,
  cardId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  title: z.string().trim().min(1).max(240),
  cardKind: DailyReflectionWorkingCardKindSchema,
  actionClaimed: z.boolean(),
  memoryType: DailyReflectionMemoryProposalTypeSchema,
  content: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  evidenceSnapshots: z.array(
    DailyReflectionMemoryProposalEvidenceSnapshotSchema
  ).min(1).max(64),
  riskFlags: z.array(ReflectionCardRiskFlagSchema).max(8),
  subjectPersonId: DailyReflectionIdSchema.nullable(),
  importance: z.number().min(0).max(1),
  durability: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  sensitivity: z.number().min(0).max(1),
  epistemicStatus: ReflectionCardEpistemicStatusSchema,
  epistemicCaution: DailyReflectionMemoryProposalEpistemicCautionSchema,
  status: DailyReflectionMemoryProposalStatusSchema,
  policyVersion: z.string().trim().min(1).max(128),
  score: z.number().min(0).max(1),
  reasons: z.array(DailyReflectionMemoryProposalReasonSchema).max(32),
  operationKey: z.string().trim().min(1).max(512),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  memoryId: DailyReflectionIdSchema.nullable(),
  sourceOrigin: DailyReflectionV2SourceOriginSchema,
  inputAdapter: DailyReflectionV2InputAdapterSchema,
  capturePurpose: DailyReflectionV2CapturePurposeSchema,
  recordingDate: z.string().date(),
  createdBy: z.literal("user"),
  admissionMethod: z.literal("daily_reflection_memory_proposal_v1"),
  cardVersion: DailyReflectionVersionSchema,
  version: DailyReflectionVersionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  admittedAt: z.string().datetime().nullable()
}).strict().superRefine((proposal, context) => {
  if (new Set(proposal.evidenceIds).size !== proposal.evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "evidenceIds must be unique"
    });
  }
  if (
    proposal.evidenceSnapshots.length !== proposal.evidenceIds.length
    || proposal.evidenceSnapshots.some(
      (evidence, index) => evidence.sourceSegmentId !== proposal.evidenceIds[index]
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceSnapshots"],
      message: "evidenceSnapshots must exactly cover evidenceIds in order"
    });
  }
  for (const [index, evidence] of proposal.evidenceSnapshots.entries()) {
    if (evidence.effectiveOrigin !== proposal.sourceOrigin) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceSnapshots", index, "effectiveOrigin"],
        message: "proposal Evidence origin must match sourceOrigin"
      });
    }
  }
  if (new Set(proposal.riskFlags).size !== proposal.riskFlags.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["riskFlags"],
      message: "riskFlags must be unique"
    });
  }
  if (proposal.cardKind !== "action" && proposal.actionClaimed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actionClaimed"],
      message: "only action Cards may claim an action"
    });
  }
  if (
    proposal.memoryType === "commitment"
    && (proposal.status === "approved" || proposal.status === "admitted")
    && (proposal.cardKind !== "action" || !proposal.actionClaimed)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memoryType"],
      message: "commitment proposals require an explicitly claimed action Card"
    });
  }
  if (
    proposal.memoryType === "person_fact"
    && (proposal.status === "approved" || proposal.status === "admitted")
    && proposal.subjectPersonId === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectPersonId"],
      message: "person_fact proposals require a frozen Subject"
    });
  }
  if (new Set(proposal.reasons).size !== proposal.reasons.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasons"],
      message: "reasons must be unique"
    });
  }
  if (proposal.operationKey !== `daily-reflection-card:${proposal.cardId}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operationKey"],
      message: "operationKey must be stable for the Working Card"
    });
  }
  const admitted = proposal.status === "admitted";
  if (admitted !== (proposal.memoryId !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memoryId"],
      message: "memoryId is required only for admitted proposals"
    });
  }
  if (admitted !== (proposal.admittedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["admittedAt"],
      message: "admittedAt is required only for admitted proposals"
    });
  }
  if (proposal.status === "rejected" && proposal.reasons.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasons"],
      message: "rejected proposals require an auditable reason"
    });
  }
});

export const DailyReflectionMemoryProposalEventTypeSchema = z.enum([
  "created",
  "evaluated",
  "admission_started",
  "admission_failed",
  "admitted",
  "recovered",
  "revoked"
]);

const SafeReasonIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_.:-]*$/u);

export const DailyReflectionMemoryProposalEventReasonMetadataSchema = z.object({
  reasonCode: SafeReasonIdentifierSchema.nullable().optional(),
  errorCode: SafeReasonIdentifierSchema.nullable().optional(),
  attemptVersion: DailyReflectionVersionSchema.optional(),
  recoveredFromEventId: DailyReflectionIdSchema.nullable().optional()
}).strict();

export const DailyReflectionMemoryProposalEventSchema = z.object({
  id: DailyReflectionIdSchema,
  proposalId: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  proposalVersion: DailyReflectionVersionSchema,
  eventType: DailyReflectionMemoryProposalEventTypeSchema,
  reasonMetadata: DailyReflectionMemoryProposalEventReasonMetadataSchema,
  createdAt: z.string().datetime()
}).strict();

export const DailyReflectionMemoryProposalCreateRequestSchema = z.object({
  expectedCardVersion: DailyReflectionVersionSchema,
  memoryType: DailyReflectionMemoryProposalTypeSchema
}).strict();

export const DailyReflectionMemoryProposalEvaluateRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema
}).strict();

export const DailyReflectionMemoryProposalAdmitRequestSchema = z.object({
  expectedVersion: DailyReflectionVersionSchema,
  acknowledgements: z.array(
    DailyReflectionMemoryProposalAcknowledgementSchema
  ).max(3).default([])
}).strict().superRefine((request, context) => {
  if (new Set(request.acknowledgements).size !== request.acknowledgements.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acknowledgements"],
      message: "acknowledgements must be unique"
    });
  }
});

export const DailyReflectionMemoryProposalPublicSchema =
  DailyReflectionMemoryProposalSchema.transform((proposal) => ({
    id: proposal.id,
    cardId: proposal.cardId,
    reflectionId: proposal.reflectionId,
    title: proposal.title,
    cardKind: proposal.cardKind,
    actionClaimed: proposal.actionClaimed,
    memoryType: proposal.memoryType,
    content: proposal.content,
    evidenceIds: proposal.evidenceIds,
    evidenceSnapshots: proposal.evidenceSnapshots,
    riskFlags: proposal.riskFlags,
    subjectPersonId: proposal.subjectPersonId,
    importance: proposal.importance,
    durability: proposal.durability,
    novelty: proposal.novelty,
    sensitivity: proposal.sensitivity,
    epistemicStatus: proposal.epistemicStatus,
    epistemicCaution: proposal.epistemicCaution,
    status: proposal.status,
    policyVersion: proposal.policyVersion,
    score: proposal.score,
    reasons: proposal.reasons,
    confirmationRequirements: memoryProposalConfirmationRequirements(proposal.reasons),
    memoryId: proposal.memoryId,
    sourceOrigin: proposal.sourceOrigin,
    recordingDate: proposal.recordingDate,
    version: proposal.version,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    admittedAt: proposal.admittedAt
  }));

export const DailyReflectionMemoryProposalProvenanceSchema = z.object({
  proposal: DailyReflectionMemoryProposalPublicSchema,
  publicationId: DailyReflectionIdSchema.nullable(),
  publicationStatus: z.enum(["unpublished", "published", "deleted"]).nullable(),
  memoryId: DailyReflectionIdSchema.nullable(),
  revoked: z.boolean(),
  evidence: z.array(z.object({
    memoryEvidenceId: DailyReflectionIdSchema,
    sourceSegmentId: DailyReflectionIdSchema,
    uploadId: DailyReflectionIdSchema,
    effectiveOrigin: SourceOriginSchema,
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.string().datetime()
  }).strict()).max(64)
}).strict();

export const DailyReflectionMemoryProposalListResponseSchema = z.object({
  proposals: z.array(DailyReflectionMemoryProposalPublicSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative()
}).strict();

export const DailyReflectionMemoryProposalAdmissionResponseSchema = z.object({
  status: z.enum([
    "approved",
    "needs_confirmation",
    "rejected",
    "admitted",
    "already_exists"
  ]),
  proposal: DailyReflectionMemoryProposalPublicSchema,
  memoryId: DailyReflectionIdSchema.nullable(),
  reasons: z.array(DailyReflectionMemoryProposalReasonSchema).max(64),
  confirmationRequirements: z.array(
    DailyReflectionMemoryProposalConfirmationRequirementSchema
  ).max(4).default([])
}).strict();

export const DailyReflectionMemoryRecommendationSchema = z.object({
  cardId: DailyReflectionIdSchema,
  memoryType: DailyReflectionMemoryProposalTypeSchema,
  rank: z.number().int().min(1).max(5),
  score: z.number().min(0).max(1),
  clusterId: DailyReflectionIdSchema,
  sourceOrigin: DailyReflectionV2SourceOriginSchema,
  reasons: z.array(DailyReflectionMemoryProposalReasonSchema).min(1).max(8),
  defaultSelected: z.literal(false)
}).strict();

export const DailyReflectionMemoryRecommendationResponseSchema = z.object({
  reflectionId: DailyReflectionIdSchema,
  policyVersion: z.string().trim().min(1).max(128),
  recommendationFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  maxRecommendations: z.literal(5),
  eligibleCount: z.number().int().nonnegative(),
  recommendations: z.array(DailyReflectionMemoryRecommendationSchema).max(5)
}).strict().superRefine((response, context) => {
  if (response.recommendations.some((item, index) => item.rank !== index + 1)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendations"],
      message: "recommendation ranks must be contiguous and stable"
    });
  }
  const cardIds = response.recommendations.map((item) => item.cardId);
  if (new Set(cardIds).size !== cardIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendations"],
      message: "recommendations must contain unique Cards"
    });
  }
});

export type DailyReflectionMemoryProposal = z.infer<
  typeof DailyReflectionMemoryProposalSchema
>;
export type DailyReflectionMemoryProposalEvent = z.infer<
  typeof DailyReflectionMemoryProposalEventSchema
>;
export type DailyReflectionMemoryRecommendation = z.infer<
  typeof DailyReflectionMemoryRecommendationSchema
>;
export type DailyReflectionMemoryRecommendationResponse = z.infer<
  typeof DailyReflectionMemoryRecommendationResponseSchema
>;

// Wire DTO: PublicSchema projects private repository records; this schema parses that public output.
export const DailyReflectionMemoryProposalClientViewSchema = z.object({
  id: DailyReflectionIdSchema,
  cardId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  title: z.string().trim().min(1).max(240),
  cardKind: DailyReflectionWorkingCardKindSchema,
  actionClaimed: z.boolean(),
  memoryType: DailyReflectionMemoryProposalTypeSchema,
  content: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  evidenceSnapshots: z.array(
    DailyReflectionMemoryProposalEvidenceSnapshotSchema
  ).min(1).max(64),
  riskFlags: z.array(ReflectionCardRiskFlagSchema).max(8),
  subjectPersonId: DailyReflectionIdSchema.nullable(),
  importance: z.number().min(0).max(1),
  durability: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  sensitivity: z.number().min(0).max(1),
  epistemicStatus: ReflectionCardEpistemicStatusSchema,
  epistemicCaution: DailyReflectionMemoryProposalEpistemicCautionSchema,
  status: DailyReflectionMemoryProposalStatusSchema,
  policyVersion: z.string().trim().min(1).max(128),
  score: z.number().min(0).max(1),
  reasons: z.array(DailyReflectionMemoryProposalReasonSchema).max(32),
  confirmationRequirements: z.array(
    DailyReflectionMemoryProposalConfirmationRequirementSchema
  ).max(4),
  memoryId: DailyReflectionIdSchema.nullable(),
  sourceOrigin: DailyReflectionV2SourceOriginSchema,
  recordingDate: z.string().date(),
  version: DailyReflectionVersionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  admittedAt: z.string().datetime().nullable()
}).strict().superRefine((proposal, context) => {
  if (
    proposal.evidenceSnapshots.length !== proposal.evidenceIds.length
    || proposal.evidenceSnapshots.some(
      (evidence, index) => evidence.sourceSegmentId !== proposal.evidenceIds[index]
        || evidence.effectiveOrigin !== proposal.sourceOrigin
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceSnapshots"],
      message: "proposal Evidence must exactly match the public allowlist"
    });
  }
  if (proposal.cardKind !== "action" && proposal.actionClaimed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actionClaimed"],
      message: "only action Cards may be explicitly claimed"
    });
  }
  const admitted = proposal.status === "admitted";
  if (admitted !== (proposal.memoryId !== null && proposal.admittedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memoryId"],
      message: "admitted proposals require matching durable state"
    });
  }
});

export const DailyReflectionWorkingCardMemoryLookupResponseSchema = z.object({
  proposal: DailyReflectionMemoryProposalClientViewSchema.nullable(),
  publicationStatus: z.enum(["unpublished", "published", "deleted"]).nullable(),
  revoked: z.boolean(),
  actionClaimed: z.boolean()
}).strict();
