import { z } from "zod";

export const DcIdSchema = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
export const DcRecordingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const DcVersionSchema = z.number().int().nonnegative();

export const DcRelationshipStatusSchema = z.enum(["active", "archived"]);
export const DcInteractionStatusSchema = z.enum(["draft", "confirmed"]);
export const DcSourceStateSchema = z.enum(["available", "server_cleaned", "explicitly_deleted"]);
export const DcParticipantRoleSchema = z.enum(["self", "companion", "unresolved"]);
export const DcRecapKindSchema = z.enum(["moment", "mentioned", "promise", "continue"]);
export const DcRecapDispositionSchema = z.enum(["pending", "kept", "excluded"]);
export const DcPromiseStatusSchema = z.enum(["open", "done"]);

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
  createdAt: z.string().datetime()
}).strict().refine((item) => item.endSeconds > item.startSeconds, {
  message: "endSeconds must be greater than startSeconds"
});

export const DcParticipantAssignmentSchema = z.object({
  speakerId: z.string().min(1).max(512),
  role: DcParticipantRoleSchema,
  confirmedAt: z.string().datetime().optional()
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
  recapItems: z.array(DcRecapItemSchema)
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
  items: z.array(DcRecapItemMutationSchema).default([]),
  finalize: z.boolean().default(false)
}).strict().refine((input) => input.finalize || input.items.length > 0, {
  message: "At least one recap mutation or finalize=true is required"
});

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
export type DcRecapKind = z.infer<typeof DcRecapKindSchema>;
export type DcRecapDisposition = z.infer<typeof DcRecapDispositionSchema>;
export type DcPromiseStatus = z.infer<typeof DcPromiseStatusSchema>;
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
