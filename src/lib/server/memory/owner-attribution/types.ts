import { z } from "zod";
import type { TranscriptSegment } from "@/lib/domain/types";
import { MemoryItemTypeSchema, type MemoryItemType } from "../types";

const RecordIdSchema = z.string().trim().min(1).max(512);

export const MemoryOwnerAttributionTypeSchema = z.enum([
  "known_identity",
  "local_speaker",
  "unknown"
]);

export const MemoryOwnerAttributionSourceSchema = z.enum([
  "speaker_identity",
  "manual_mapping",
  "explicit_statement",
  "unknown"
]);

export const MemoryOwnershipScopeSchema = z.enum([
  "individual",
  "shared",
  "unknown"
]);

export const MemoryOwnerAttributionSchema = z.object({
  type: MemoryOwnerAttributionTypeSchema,
  identityId: RecordIdSchema.optional(),
  confidence: z.number().min(0).max(1),
  source: MemoryOwnerAttributionSourceSchema
}).strict().superRefine((value, context) => {
  if (value.type === "unknown") {
    if (value.identityId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["identityId"],
        message: "unknown owner attribution cannot contain an identity id"
      });
    }
    if (value.confidence !== 0 || value.source !== "unknown") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unknown owner attribution must have zero confidence and unknown source"
      });
    }
    return;
  }

  if (!value.identityId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identityId"],
      message: "resolved owner attribution requires an identity id"
    });
  }
  if (value.source === "unknown") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source"],
      message: "resolved owner attribution cannot use unknown source"
    });
  }
});

export const MemoryParticipantRoleSchema = z.enum([
  "owner",
  "actor",
  "receiver",
  "participant"
]);

export const MemoryParticipantAttributionSchema = z.object({
  role: MemoryParticipantRoleSchema,
  attribution: MemoryOwnerAttributionSchema,
  evidenceSegmentIds: z.array(RecordIdSchema).min(1)
}).strict().superRefine((value, context) => {
  if (value.attribution.type === "unknown") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attribution"],
      message: "unknown identities are omitted from participant lists"
    });
  }
});

export const MemoryOwnerStatementKindSchema = z.enum([
  "self_statement",
  "third_person_reference",
  "shared_statement",
  "other"
]);

export const MemoryOwnerObservationReasonSchema = z.enum([
  "explicit_self_statement",
  "trusted_speaker_identity",
  "third_person_reference",
  "identity_missing",
  "identity_not_provider_verified",
  "identity_below_threshold"
]);

export const MemoryOwnerObservationSchema = z.object({
  segmentId: RecordIdSchema,
  statementKind: MemoryOwnerStatementKindSchema,
  eligible: z.boolean(),
  attribution: MemoryOwnerAttributionSchema,
  reason: MemoryOwnerObservationReasonSchema
}).strict();

export const MemoryOwnerResolutionReasonSchema = z.enum([
  "explicit_owner",
  "speaker_identity_owner",
  "ambiguous_owner",
  "third_person_only",
  "no_trusted_identity",
  "commitment_actor",
  "receiver_unique",
  "receiver_unresolved",
  "shared_context",
  "individual_participant",
  "owner_not_applicable"
]);

export const MemoryOwnerResolutionSchema = z.object({
  version: z.literal(1),
  memoryId: RecordIdSchema,
  memoryType: MemoryItemTypeSchema,
  scope: MemoryOwnershipScopeSchema,
  owner: MemoryOwnerAttributionSchema,
  participants: z.array(MemoryParticipantAttributionSchema),
  evidenceSegmentIds: z.array(RecordIdSchema),
  observations: z.array(MemoryOwnerObservationSchema),
  reasons: z.array(MemoryOwnerResolutionReasonSchema).min(1)
}).strict();

export const MemoryOwnerMetadataSchema = MemoryOwnerResolutionSchema.omit({
  observations: true
});

export const MemoryOwnerAuditRecordSchema = z.object({
  memoryId: RecordIdSchema,
  memoryType: MemoryItemTypeSchema,
  ownerType: MemoryOwnerAttributionTypeSchema,
  scope: MemoryOwnershipScopeSchema,
  confidence: z.number().min(0).max(1),
  source: MemoryOwnerAttributionSourceSchema,
  evidenceSegmentIds: z.array(RecordIdSchema),
  participantCount: z.number().int().nonnegative(),
  reasons: z.array(MemoryOwnerResolutionReasonSchema).min(1)
}).strict();

export const MemoryOwnerAuditSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  memoriesProcessed: z.number().int().nonnegative(),
  knownOwners: z.number().int().nonnegative(),
  localSpeakerOwners: z.number().int().nonnegative(),
  unknownOwners: z.number().int().nonnegative(),
  individualMemories: z.number().int().nonnegative(),
  sharedMemories: z.number().int().nonnegative(),
  unknownScopeMemories: z.number().int().nonnegative(),
  speakerDerived: z.number().int().nonnegative(),
  manualDerived: z.number().int().nonnegative(),
  explicitDerived: z.number().int().nonnegative(),
  records: z.array(MemoryOwnerAuditRecordSchema)
}).strict();

export type MemoryOwnerAttributionType = z.infer<typeof MemoryOwnerAttributionTypeSchema>;
export type MemoryOwnerAttributionSource = z.infer<typeof MemoryOwnerAttributionSourceSchema>;
export type MemoryOwnershipScope = z.infer<typeof MemoryOwnershipScopeSchema>;
export type MemoryOwnerAttribution = z.infer<typeof MemoryOwnerAttributionSchema>;
export type MemoryParticipantRole = z.infer<typeof MemoryParticipantRoleSchema>;
export type MemoryParticipantAttribution = z.infer<typeof MemoryParticipantAttributionSchema>;
export type MemoryOwnerStatementKind = z.infer<typeof MemoryOwnerStatementKindSchema>;
export type MemoryOwnerObservation = z.infer<typeof MemoryOwnerObservationSchema>;
export type MemoryOwnerResolutionReason = z.infer<typeof MemoryOwnerResolutionReasonSchema>;
export type MemoryOwnerResolution = z.infer<typeof MemoryOwnerResolutionSchema>;
export type MemoryOwnerMetadata = z.infer<typeof MemoryOwnerMetadataSchema>;
export type MemoryOwnerAuditRecord = z.infer<typeof MemoryOwnerAuditRecordSchema>;
export type MemoryOwnerAudit = z.infer<typeof MemoryOwnerAuditSchema>;

export type ResolveMemoryOwnerAttributionInput = {
  memoryId: string;
  memoryType: MemoryItemType;
  evidenceSegments: TranscriptSegment[];
  allowManualMappingIdentity?: boolean;
};

export type ResolveMemoryOwnerAttributionsInput = {
  memories: ResolveMemoryOwnerAttributionInput[];
  now?: () => string;
};
