import { z } from "zod";

import {
  DcIdSchema,
  DcMemorySubjectSchema,
  DcRecordingDateSchema
} from "./date-companion-stage2";

export const DateCompanionPersonSourceCatalogStatusSchema = z.enum([
  "ready",
  "needs_review",
  "unavailable"
]);

export const DateCompanionRelationshipPersonSourceSchema = z.object({
  evidenceSnapshotId: DcIdSchema,
  interactionId: DcIdSchema,
  uploadId: DcIdSchema,
  sourceSegmentId: z.string().trim().min(1).max(512),
  recordingDate: DcRecordingDateSchema,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  speakerId: z.string().trim().min(1).max(512).optional(),
  quote: z.string().min(1),
  contentDigest: z.string().length(64).regex(/^[a-f0-9]+$/u).optional(),
  subject: DcMemorySubjectSchema.extract(["companion", "both"])
}).strict().refine((source) => source.endSeconds > source.startSeconds, {
  message: "endSeconds must be greater than startSeconds"
});

export const DateCompanionPersonSourceCatalogSchema = z.object({
  relationshipId: DcIdSchema,
  companionPersonId: DcIdSchema.nullable(),
  mappingVersion: z.number().int().positive().nullable(),
  status: DateCompanionPersonSourceCatalogStatusSchema,
  sources: z.array(DateCompanionRelationshipPersonSourceSchema)
}).strict();

export type DateCompanionRelationshipPersonSource = z.infer<
  typeof DateCompanionRelationshipPersonSourceSchema
>;

export type DateCompanionPersonSourceCatalog = z.infer<
  typeof DateCompanionPersonSourceCatalogSchema
>;
