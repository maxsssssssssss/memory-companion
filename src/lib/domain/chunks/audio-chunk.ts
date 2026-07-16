import { z } from "zod";
import { chunkLifecycleShape, validateChunkLifecycle } from "./chunk-status";

const DURATION_TOLERANCE_SECONDS = 0.01;

export const AudioChunkSourceSchema = z
  .object({
    type: z.enum(["uploaded_audio", "generated_chunk"]),
    path: z.string().min(1).optional(),
    url: z.string().url().optional()
  })
  .strict();

export const AudioChunkSchema = z
  .object({
    id: z.string().min(1),
    uploadId: z.string().min(1),
    index: z.number().int().nonnegative(),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    durationSeconds: z.number().positive(),
    source: AudioChunkSourceSchema,
    ...chunkLifecycleShape
  })
  .strict()
  .superRefine((chunk, context) => {
    validateChunkLifecycle(chunk, context);

    if (chunk.endSeconds <= chunk.startSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endSeconds"],
        message: "audio chunk endSeconds must be greater than startSeconds"
      });
      return;
    }

    const rangeDuration = chunk.endSeconds - chunk.startSeconds;
    if (Math.abs(rangeDuration - chunk.durationSeconds) > DURATION_TOLERANCE_SECONDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: "audio chunk durationSeconds must match its time range"
      });
    }
  });

export const AudioChunkSetSchema = z
  .object({
    uploadId: z.string().min(1),
    chunks: z.array(AudioChunkSchema)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const indices = new Set<number>();

    value.chunks.forEach((chunk, chunkIndex) => {
      if (chunk.uploadId !== value.uploadId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chunks", chunkIndex, "uploadId"],
          message: "audio chunk uploadId must match its set"
        });
      }
      if (ids.has(chunk.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chunks", chunkIndex, "id"],
          message: "audio chunk id must be unique"
        });
      }
      if (indices.has(chunk.index)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chunks", chunkIndex, "index"],
          message: "audio chunk index must be unique"
        });
      }
      ids.add(chunk.id);
      indices.add(chunk.index);
    });
  });

export function buildAudioChunkId(uploadId: string, index: number) {
  if (!uploadId.trim()) {
    throw new Error("uploadId is required");
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("chunk index must be a non-negative integer");
  }
  return `${uploadId}_audio_chunk_${String(index).padStart(5, "0")}`;
}

export type AudioChunkSource = z.infer<typeof AudioChunkSourceSchema>;
export type AudioChunk = z.infer<typeof AudioChunkSchema>;
export type AudioChunkSet = z.infer<typeof AudioChunkSetSchema>;
