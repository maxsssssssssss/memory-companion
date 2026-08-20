import { z } from "zod";

export const DcIdSchema = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
export const DcRecordingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const DcVersionSchema = z.number().int().nonnegative();

export const DcRelationshipStatusSchema = z.enum(["active", "archived"]);
export const DcInteractionStatusSchema = z.enum(["draft", "confirmed"]);
export const DcSourceStateSchema = z.enum(["available", "server_cleaned", "explicitly_deleted"]);
export const DcParticipantRoleSchema = z.enum(["self", "companion", "unresolved"]);
export const DcResolvedParticipantRoleSchema = z.enum(["self", "companion"]);
export const DcParticipantSuggestionSourceSchema = z.literal("previous_confirmation");
export const DcRecapKindSchema = z.enum(["moment", "mentioned", "promise", "continue"]);
export const DcRecapDispositionSchema = z.enum(["pending", "kept", "excluded"]);
export const DcPromiseStatusSchema = z.enum(["open", "done"]);
export const DcVoiceEnrollmentStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "expired",
  "cancelled"
]);
export const DcMemorySubjectSchema = z.enum(["self", "companion", "both", "unknown"]);
export const DcSubjectSuggestionReasonCodeSchema = z.enum([
  "explicit_self_reference",
  "explicit_companion_reference",
  "mutual_relationship_context",
  "third_party",
  "mixed_subject",
  "ambiguous_pronoun",
  "insufficient_context",
  "low_confidence",
  "provider_output_invalid"
]);
export const DcSubjectSuggestionConfirmationSchema = z.object({
  batchId: DcIdSchema,
  evidenceDigest: z.string().length(64).regex(/^[a-f0-9]+$/u),
  proposalDigest: z.string().length(64).regex(/^[a-f0-9]+$/u),
  confirmationFingerprint: z.string().length(64).regex(/^[a-f0-9]+$/u),
  confirmedVisibleSuggestions: z.literal(true)
}).strict();
export const DcMemoryBridgeStatusSchema = z.enum([
  "waiting_for_cleanup",
  "pending",
  "processing",
  "completed",
  "retryable_failed",
  "needs_review",
  "cancelled"
]);
export const DcMemoryBridgeReviewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("relationship_reconfirmation_required"),
    canReconfirm: z.literal(true),
    reason: z.literal("relationship_was_archived"),
    nextAction: z.literal("reconfirm_archived_relationship")
  }).strict(),
  z.object({
    kind: z.literal("mapping_review_required"),
    canReconfirm: z.literal(false),
    reason: z.literal("person_mapping_changed"),
    nextAction: z.literal("review_person_mapping")
  }).strict(),
  z.object({
    kind: z.literal("evidence_review_required"),
    canReconfirm: z.literal(false),
    reason: z.literal("source_evidence_changed"),
    nextAction: z.literal("review_source_evidence")
  }).strict()
]);

export const DcRelationshipSchema = z.object({
  id: DcIdSchema,
  displayName: z.string().trim().min(1).max(120).optional(),
  status: DcRelationshipStatusSchema,
  version: DcVersionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const DcEvidenceSnapshotSchema = z.object({
  id: DcIdSchema,
  recapItemId: DcIdSchema,
  uploadId: DcIdSchema,
  sourceSegmentId: z.string().min(1).max(512),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  speakerId: z.string().min(1).max(512).optional(),
  quote: z.string().min(1),
  contentDigest: z.string().length(64).regex(/^[a-f0-9]+$/u).optional(),
  createdAt: z.string().datetime()
}).strict().refine((item) => item.endSeconds > item.startSeconds, {
  message: "endSeconds must be greater than startSeconds"
});

export const DcParticipantAssignmentSchema = z.object({
  speakerId: z.string().min(1).max(512),
  reviewGroupId: DcIdSchema.optional(),
  audioSampleAvailable: z.literal(true).optional(),
  voiceEnrollmentEligible: z.literal(true).optional(),
  role: DcParticipantRoleSchema,
  confirmedAt: z.string().datetime().optional(),
  roleSuggestion: z.object({
    role: DcResolvedParticipantRoleSchema,
    source: DcParticipantSuggestionSourceSchema
  }).strict().optional()
}).strict();

export const DcRecapItemSchema = z.object({
  id: DcIdSchema,
  interactionId: DcIdSchema,
  kind: DcRecapKindSchema,
  proposedText: z.string().min(1),
  userText: z.string().min(1).optional(),
  displayedText: z.string().min(1),
  disposition: DcRecapDispositionSchema,
  version: DcVersionSchema,
  sortOrder: z.number().int().nonnegative(),
  evidence: z.array(DcEvidenceSnapshotSchema).min(1)
}).strict();

export const DcInteractionSchema = z.object({
  id: DcIdSchema,
  relationshipId: DcIdSchema,
  sourceUploadId: DcIdSchema,
  recordingDate: DcRecordingDateSchema,
  originalName: z.string().min(1),
  durationSeconds: z.number().nonnegative().optional(),
  status: DcInteractionStatusSchema,
  sourceState: DcSourceStateSchema,
  version: DcVersionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  confirmedAt: z.string().datetime().optional()
}).strict();

export const DcInteractionDetailSchema = DcInteractionSchema.extend({
  participants: z.array(DcParticipantAssignmentSchema),
  recapItems: z.array(DcRecapItemSchema),
  voiceEnrollment: z.object({
    status: DcVoiceEnrollmentStatusSchema
  }).strict().optional(),
  memoryBridge: z.object({
    status: DcMemoryBridgeStatusSchema,
    attemptCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    retryable: z.boolean(),
    review: DcMemoryBridgeReviewSchema.optional()
  }).strict().optional()
}).strict();

export const DcPromiseSchema = z.object({
  id: DcIdSchema,
  relationshipId: DcIdSchema,
  originatingRecapItemId: DcIdSchema,
  text: z.string().min(1),
  status: DcPromiseStatusSchema,
  version: DcVersionSchema,
  resolvedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  evidence: z.array(DcEvidenceSnapshotSchema).min(1)
}).strict();

export const DcRelationshipViewSchema = z.object({
  relationship: DcRelationshipSchema,
  interactions: z.array(DcInteractionDetailSchema),
  promises: z.array(DcPromiseSchema)
}).strict();

export const DcSearchResultSchema = z.object({
  recapItemId: DcIdSchema,
  interactionId: DcIdSchema,
  kind: DcRecapKindSchema,
  text: z.string().min(1),
  recordingDate: DcRecordingDateSchema,
  evidence: z.array(DcEvidenceSnapshotSchema).min(1)
}).strict();

export const DcRelationshipsResponseSchema = z.object({
  relationships: z.array(DcRelationshipSchema)
}).strict();
export const DcCreateRelationshipRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional()
}).strict();
export const DcCreateRelationshipResponseSchema = z.object({
  relationship: DcRelationshipSchema,
  reused: z.boolean()
}).strict();
export const DcRelationshipViewResponseSchema = z.object({
  view: DcRelationshipViewSchema
}).strict();

export const DcImportInteractionRequestSchema = z.object({
  uploadId: DcIdSchema
}).strict();
export const DcImportInteractionResponseSchema = z.object({
  interactionId: DcIdSchema,
  reused: z.boolean(),
  view: DcRelationshipViewSchema
}).strict();

export const DcUpdateParticipantsRequestSchema = z.object({
  version: DcVersionSchema,
  assignments: z.array(z.object({
    speakerId: z.string().min(1).max(512),
    role: DcParticipantRoleSchema
  }).strict()).min(1)
}).strict();

export const DcRecapItemMutationSchema = z.object({
  id: DcIdSchema,
  version: DcVersionSchema,
  userText: z.string().trim().min(1).max(10_000).nullable().optional(),
  disposition: DcRecapDispositionSchema
}).strict();
export const DcUpdateRecapRequestSchema = z.object({
  version: DcVersionSchema,
  assignments: z.array(z.object({
    speakerId: z.string().min(1).max(512),
    role: DcParticipantRoleSchema
  }).strict()).min(1).optional(),
  items: z.array(DcRecapItemMutationSchema).default([]),
  voiceEnrollmentIntents: z.array(z.object({
    speakerIds: z.array(z.string().trim().min(1).max(512)).min(1).max(16)
  }).strict()).max(1).optional(),
  memoryAdmission: z.object({
    mappingVersion: z.number().int().positive(),
    subjectSuggestionConfirmation: DcSubjectSuggestionConfirmationSchema.optional(),
    selections: z.array(z.object({
      evidenceSnapshotId: DcIdSchema,
      subject: DcMemorySubjectSchema
    }).strict()).max(2_000)
  }).strict().optional(),
  finalize: z.boolean().default(false)
}).strict().refine((input) => input.finalize || input.items.length > 0, {
  message: "At least one recap mutation or finalize=true is required"
}).refine((input) => input.finalize || input.assignments === undefined, {
  message: "Participant assignments can only be submitted with final confirmation"
}).refine((input) => input.finalize || input.voiceEnrollmentIntents === undefined, {
  message: "Voice enrollment intents can only be submitted with final confirmation"
}).refine((input) => input.finalize || input.memoryAdmission === undefined, {
  message: "Memory admission can only be submitted with final confirmation"
});

export const DcSubjectSuggestionSchema = z.object({
  canonicalSourceKey: z.string().length(64).regex(/^[a-f0-9]+$/u),
  uploadId: DcIdSchema,
  sourceSegmentId: z.string().min(1).max(512),
  contentDigest: z.string().length(64).regex(/^[a-f0-9]+$/u),
  recapItemIds: z.array(DcIdSchema).min(1),
  evidenceSnapshotIds: z.array(DcIdSchema).min(1),
  proposedSubject: DcMemorySubjectSchema,
  confidence: z.number().min(0).max(1),
  reasonCode: DcSubjectSuggestionReasonCodeSchema
}).strict();

export const DcSubjectSuggestionBatchSchema = z.object({
  batchId: DcIdSchema,
  interactionId: DcIdSchema,
  interactionVersion: DcVersionSchema,
  mappingVersion: z.number().int().positive(),
  evidenceDigest: z.string().length(64).regex(/^[a-f0-9]+$/u),
  proposalDigest: z.string().length(64).regex(/^[a-f0-9]+$/u),
  confirmationFingerprint: z.string().length(64).regex(/^[a-f0-9]+$/u),
  model: z.literal("Qwen/Qwen3.6-27B"),
  status: z.enum(["ready", "degraded"]),
  suggestions: z.array(DcSubjectSuggestionSchema),
  createdAt: z.string().datetime()
}).strict();

export const DcSubjectSuggestionResponseSchema = z.object({
  batch: DcSubjectSuggestionBatchSchema
}).strict();

const DcSubjectSuggestionStatusBaseSchema = z.object({
  interactionId: DcIdSchema,
  interactionVersion: DcVersionSchema,
  mappingVersion: z.number().int().positive(),
  evidenceDigest: z.string().length(64).regex(/^[a-f0-9]+$/u)
});

export const DcSubjectSuggestionStatusResponseSchema = z.discriminatedUnion("status", [
  DcSubjectSuggestionStatusBaseSchema.extend({
    status: z.enum(["idle", "processing"])
  }).strict(),
  DcSubjectSuggestionStatusBaseSchema.extend({
    status: z.literal("ready"),
    batch: DcSubjectSuggestionBatchSchema
  }).strict()
]);

export const DcPatchPromiseRequestSchema = z.object({
  version: DcVersionSchema,
  status: DcPromiseStatusSchema
}).strict();

export const DcSearchResponseSchema = z.object({
  results: z.array(DcSearchResultSchema)
}).strict();
export const DcDeleteInteractionResponseSchema = z.object({
  deleted: z.literal(true)
}).strict();

export type DcRelationship = z.infer<typeof DcRelationshipSchema>;
export type DcRelationshipStatus = z.infer<typeof DcRelationshipStatusSchema>;
export type DcInteractionStatus = z.infer<typeof DcInteractionStatusSchema>;
export type DcSourceState = z.infer<typeof DcSourceStateSchema>;
export type DcParticipantRole = z.infer<typeof DcParticipantRoleSchema>;
export type DcParticipantSuggestionSource = z.infer<typeof DcParticipantSuggestionSourceSchema>;
export type DcRecapKind = z.infer<typeof DcRecapKindSchema>;
export type DcRecapDisposition = z.infer<typeof DcRecapDispositionSchema>;
export type DcPromiseStatus = z.infer<typeof DcPromiseStatusSchema>;
export type DcMemorySubject = z.infer<typeof DcMemorySubjectSchema>;
export type DcSubjectSuggestionReasonCode = z.infer<typeof DcSubjectSuggestionReasonCodeSchema>;
export type DcSubjectSuggestionConfirmation = z.infer<typeof DcSubjectSuggestionConfirmationSchema>;
export type DcSubjectSuggestion = z.infer<typeof DcSubjectSuggestionSchema>;
export type DcSubjectSuggestionBatch = z.infer<typeof DcSubjectSuggestionBatchSchema>;
export type DcSubjectSuggestionStatusResponse = z.infer<typeof DcSubjectSuggestionStatusResponseSchema>;
export type DcMemoryBridgeStatus = z.infer<typeof DcMemoryBridgeStatusSchema>;
export type DcMemoryBridgeReview = z.infer<typeof DcMemoryBridgeReviewSchema>;
export type DcVoiceEnrollmentStatus = z.infer<typeof DcVoiceEnrollmentStatusSchema>;
export type DcEvidenceSnapshot = z.infer<typeof DcEvidenceSnapshotSchema>;
export type DcParticipantAssignment = z.infer<typeof DcParticipantAssignmentSchema>;
export type DcRecapItem = z.infer<typeof DcRecapItemSchema>;
export type DcInteraction = z.infer<typeof DcInteractionSchema>;
export type DcInteractionDetail = z.infer<typeof DcInteractionDetailSchema>;
export type DcPromise = z.infer<typeof DcPromiseSchema>;
export type DcRelationshipView = z.infer<typeof DcRelationshipViewSchema>;
export type DcSearchResult = z.infer<typeof DcSearchResultSchema>;
export type DcCreateRelationshipRequest = z.infer<typeof DcCreateRelationshipRequestSchema>;
export type DcImportInteractionRequest = z.infer<typeof DcImportInteractionRequestSchema>;
export type DcUpdateParticipantsRequest = z.infer<typeof DcUpdateParticipantsRequestSchema>;
export type DcUpdateRecapRequest = z.infer<typeof DcUpdateRecapRequestSchema>;
export type DcPatchPromiseRequest = z.infer<typeof DcPatchPromiseRequestSchema>;
