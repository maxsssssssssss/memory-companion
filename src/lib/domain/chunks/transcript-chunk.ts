import { z } from "zod";
import { TranscriptSegmentSchema } from "@/lib/domain/types";
import { chunkLifecycleShape, validateChunkLifecycle } from "./chunk-status";

const TIME_RANGE_TOLERANCE_SECONDS = 0.01;

export const ChunkTimebaseSchema = z.literal("upload_global");
export const SpeakerIdScopeSchema = z.enum(["chunk", "upload"]);

function validateTranscriptChunk(
  chunk: {
    uploadId: string;
    startSeconds: number;
    endSeconds: number;
    speakerIdScope: z.infer<typeof SpeakerIdScopeSchema>;
    speakerMap: Record<string, string>;
    segments: z.infer<typeof TranscriptSegmentSchema>[];
  },
  context: z.RefinementCtx
) {
  if (chunk.endSeconds <= chunk.startSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endSeconds"],
      message: "transcript chunk endSeconds must be greater than startSeconds"
    });
  }

  const segmentIds = new Set<string>();
  chunk.segments.forEach((segment, segmentIndex) => {
    if (segment.uploadId !== chunk.uploadId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segments", segmentIndex, "uploadId"],
        message: "transcript segment uploadId must match its chunk"
      });
    }
    if (
      segment.startSeconds < chunk.startSeconds - TIME_RANGE_TOLERANCE_SECONDS ||
      segment.endSeconds > chunk.endSeconds + TIME_RANGE_TOLERANCE_SECONDS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segments", segmentIndex],
        message: "transcript segment must use the global chunk range"
      });
    }
    if (segmentIds.has(segment.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segments", segmentIndex, "id"],
        message: "transcript segment id must be unique within its chunk"
      });
    }
    segmentIds.add(segment.id);

    if (chunk.speakerIdScope === "chunk" && segment.speaker && !chunk.speakerMap[segment.speaker]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["speakerMap", segment.speaker],
        message: "speakerMap must map every chunk-local speaker id"
      });
    }
  });
}

export const TranscriptChunkSchema = z
  .object({
    id: z.string().min(1),
    uploadId: z.string().min(1),
    audioChunkId: z.string().min(1),
    index: z.number().int().nonnegative(),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    timebase: ChunkTimebaseSchema,
    speakerIdScope: SpeakerIdScopeSchema,
    speakerMap: z.record(z.string().min(1), z.string().min(1)).default({}),
    segments: z.array(TranscriptSegmentSchema),
    ...chunkLifecycleShape
  })
  .strict()
  .superRefine((chunk, context) => {
    validateChunkLifecycle(chunk, context);
    validateTranscriptChunk(chunk, context);
  });

function validateTranscriptChunkSet(
  value: { uploadId: string; chunks: z.infer<typeof TranscriptChunkSchema>[] },
  context: z.RefinementCtx
) {
  const ids = new Set<string>();
  const audioChunkIds = new Set<string>();
  const indices = new Set<number>();
  const segmentIds = new Set<string>();

  value.chunks.forEach((chunk, chunkIndex) => {
    if (chunk.uploadId !== value.uploadId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunks", chunkIndex, "uploadId"],
        message: "transcript chunk uploadId must match its set"
      });
    }

    for (const [key, item, message] of [
      ["id", chunk.id, "transcript chunk id must be unique"],
      ["audioChunkId", chunk.audioChunkId, "audio chunk reference must be unique"]
    ] as const) {
      const target = key === "id" ? ids : audioChunkIds;
      if (target.has(item)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["chunks", chunkIndex, key], message });
      }
      target.add(item);
    }

    if (indices.has(chunk.index)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunks", chunkIndex, "index"],
        message: "transcript chunk index must be unique"
      });
    }
    indices.add(chunk.index);

    chunk.segments.forEach((segment, segmentIndex) => {
      if (segmentIds.has(segment.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chunks", chunkIndex, "segments", segmentIndex, "id"],
          message: "transcript segment id must be globally unique across chunks"
        });
      }
      segmentIds.add(segment.id);
    });
  });
}

export const TranscriptChunkSetSchema = z
  .object({
    uploadId: z.string().min(1),
    chunks: z.array(TranscriptChunkSchema)
  })
  .strict()
  .superRefine(validateTranscriptChunkSet);

export const TranscriptChunkMergeInputSchema = z
  .object({
    uploadId: z.string().min(1),
    chunks: z.array(TranscriptChunkSchema).min(1)
  })
  .strict()
  .superRefine((value, context) => {
    validateTranscriptChunkSet(value, context);
    value.chunks.forEach((chunk, chunkIndex) => {
      if (chunk.status !== "completed") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chunks", chunkIndex, "status"],
          message: "only completed transcript chunks can be merged"
        });
      }
    });
  });

export const TranscriptChunkMergeResultSchema = z
  .object({
    uploadId: z.string().min(1),
    sourceChunkIds: z.array(z.string().min(1)).min(1),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    timebase: ChunkTimebaseSchema,
    speakerIdScope: z.literal("upload"),
    segments: z.array(TranscriptSegmentSchema)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endSeconds <= value.startSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endSeconds"],
        message: "merged transcript endSeconds must be greater than startSeconds"
      });
    }

    if (new Set(value.sourceChunkIds).size !== value.sourceChunkIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceChunkIds"],
        message: "merged transcript sourceChunkIds must be unique"
      });
    }

    const segmentIds = new Set<string>();
    let previousStart = Number.NEGATIVE_INFINITY;
    value.segments.forEach((segment, segmentIndex) => {
      if (segment.uploadId !== value.uploadId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", segmentIndex, "uploadId"],
          message: "merged transcript segment uploadId must match"
        });
      }
      if (segmentIds.has(segment.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", segmentIndex, "id"],
          message: "merged transcript segment ids must be unique"
        });
      }
      segmentIds.add(segment.id);

      if (segment.startSeconds < previousStart) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", segmentIndex, "startSeconds"],
          message: "merged transcript segments must be chronological"
        });
      }
      previousStart = segment.startSeconds;

      if (
        segment.startSeconds < value.startSeconds - TIME_RANGE_TOLERANCE_SECONDS ||
        segment.endSeconds > value.endSeconds + TIME_RANGE_TOLERANCE_SECONDS
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", segmentIndex],
          message: "merged transcript segment must be inside the result range"
        });
      }
    });
  });

export function buildTranscriptChunkId(uploadId: string, index: number) {
  if (!uploadId.trim()) {
    throw new Error("uploadId is required");
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("chunk index must be a non-negative integer");
  }
  return `${uploadId}_transcript_chunk_${String(index).padStart(5, "0")}`;
}

export type ChunkTimebase = z.infer<typeof ChunkTimebaseSchema>;
export type SpeakerIdScope = z.infer<typeof SpeakerIdScopeSchema>;
export type TranscriptChunk = z.infer<typeof TranscriptChunkSchema>;
export type TranscriptChunkSet = z.infer<typeof TranscriptChunkSetSchema>;
export type TranscriptChunkMergeInput = z.infer<typeof TranscriptChunkMergeInputSchema>;
export type TranscriptChunkMergeResult = z.infer<typeof TranscriptChunkMergeResultSchema>;
