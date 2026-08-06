import { z } from "zod";

import { ProactiveInsightSchema } from "@/lib/domain/proactive-insights";
import {
  AudioInsightSchema,
  AudioUploadSchema,
  BriefItemSchema,
  ProcessingJobSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  SpeakerAliasMapSchema,
  SpeakerAliasesByUploadIdSchema,
  TranscriptSegmentSchema
} from "@/lib/domain/types";

export const RecordingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

const DateCompanionAudioUploadSchema = AudioUploadSchema.extend({
  recordingDate: RecordingDateSchema
});

/**
 * Runtime contract returned by GET /api/days/{uploadId}.
 *
 * The API can return `job: null` before the job document has been created. It is
 * normalized to `undefined` so callers only need to handle one "not available"
 * representation. Result arrays and availability flags intentionally remain
 * required: an empty in-progress array is not the same as a completed empty
 * result.
 */
export const DayPayloadSchema = z
  .object({
    upload: DateCompanionAudioUploadSchema,
    job: ProcessingJobSchema.nullish().transform((job) => job ?? undefined),
    segments: z.array(TranscriptSegmentSchema),
    audioInsights: z.array(AudioInsightSchema),
    semanticSegments: z.array(SemanticSegmentSchema),
    semanticSegmentsAvailable: z.boolean(),
    briefItems: z.array(BriefItemSchema),
    relationshipSignals: z.array(RelationshipSignalCardSchema),
    relationshipSignalsAvailable: z.boolean(),
    proactiveInsights: z.array(ProactiveInsightSchema),
    proactiveInsightsAvailable: z.boolean(),
    speakerAliases: SpeakerAliasMapSchema,
    speakerAliasesByUploadId: SpeakerAliasesByUploadIdSchema
  })
  .superRefine((payload, context) => {
    const uploadId = payload.upload.id;
    const uploadBoundItems = [
      ...payload.segments.map((item) => ({ path: "segments", id: item.id, uploadId: item.uploadId })),
      ...payload.audioInsights.map((item) => ({ path: "audioInsights", id: item.id, uploadId: item.uploadId })),
      ...payload.semanticSegments.map((item) => ({ path: "semanticSegments", id: item.id, uploadId: item.uploadId })),
      ...payload.briefItems.map((item) => ({ path: "briefItems", id: item.id, uploadId: item.uploadId })),
      ...payload.relationshipSignals.map((item) => ({ path: "relationshipSignals", id: item.id, uploadId: item.uploadId }))
    ];

    for (const item of uploadBoundItems) {
      if (item.uploadId !== uploadId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [item.path],
          message: `${item.path} item ${item.id} belongs to another upload`
        });
      }
    }

    if (payload.job && payload.job.uploadId !== uploadId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["job", "uploadId"],
        message: "job belongs to another upload"
      });
    }
  });

export type DayPayload = z.infer<typeof DayPayloadSchema>;

export function parseDayPayload(value: unknown): DayPayload {
  return DayPayloadSchema.parse(value);
}
