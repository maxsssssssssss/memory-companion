import { z } from "zod";
import { chunkLifecycleShape, validateChunkLifecycle } from "./chunk-status";
import { ChunkTimebaseSchema } from "./transcript-chunk";

export const AnalysisChunkKindSchema = z.enum([
  "audio_insight",
  "semantic_timeline",
  "daily_brief",
  "relationship_signal"
]);

export const AnalysisChunkSchema = z
  .object({
    id: z.string().min(1),
    uploadId: z.string().min(1),
    index: z.number().int().nonnegative(),
    kind: AnalysisChunkKindSchema,
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    timebase: ChunkTimebaseSchema,
    transcriptChunkIds: z.array(z.string().min(1)).min(1),
    sourceSegmentIds: z.array(z.string().min(1)),
    outputIds: z.array(z.string().min(1)).default([]),
    ...chunkLifecycleShape
  })
  .strict()
  .superRefine((chunk, context) => {
    validateChunkLifecycle(chunk, context);
    if (chunk.endSeconds <= chunk.startSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endSeconds"],
        message: "analysis chunk endSeconds must be greater than startSeconds"
      });
    }
    if (new Set(chunk.transcriptChunkIds).size !== chunk.transcriptChunkIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transcriptChunkIds"],
        message: "analysis chunk transcriptChunkIds must be unique"
      });
    }
    if (new Set(chunk.sourceSegmentIds).size !== chunk.sourceSegmentIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceSegmentIds"],
        message: "analysis chunk sourceSegmentIds must be unique"
      });
    }
  });

export type AnalysisChunkKind = z.infer<typeof AnalysisChunkKindSchema>;
export type AnalysisChunk = z.infer<typeof AnalysisChunkSchema>;
