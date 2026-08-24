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
  "decision",
  "commitment",
  "preference",
  "person_fact",
  "event"
]);

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
  expectedVersion: DailyReflectionVersionSchema
}).strict();

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
  status: z.enum(["approved", "rejected", "admitted", "already_exists"]),
  proposal: DailyReflectionMemoryProposalPublicSchema,
  memoryId: DailyReflectionIdSchema.nullable(),
  reasons: z.array(DailyReflectionMemoryProposalReasonSchema).max(64)
}).strict();

export type DailyReflectionMemoryProposal = z.infer<
  typeof DailyReflectionMemoryProposalSchema
>;
export type DailyReflectionMemoryProposalEvent = z.infer<
  typeof DailyReflectionMemoryProposalEventSchema
>;
