import { z } from "zod";

export const ChunkProcessingStatusSchema = z.enum(["created", "processing", "completed", "failed"]);

export const ChunkProcessingErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean()
  })
  .strict();

export const ChunkMetadataSchema = z.record(z.string(), z.unknown());

export const chunkLifecycleShape = {
  status: ChunkProcessingStatusSchema,
  retryCount: z.number().int().nonnegative().default(0),
  error: ChunkProcessingErrorSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  metadata: ChunkMetadataSchema.default({})
};

export function validateChunkLifecycle(
  chunk: {
    status: z.infer<typeof ChunkProcessingStatusSchema>;
    error?: z.infer<typeof ChunkProcessingErrorSchema>;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
  },
  context: z.RefinementCtx
) {
  if (chunk.status === "failed" && !chunk.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "failed chunks require an error"
    });
  }

  const createdAt = Date.parse(chunk.createdAt);
  const updatedAt = Date.parse(chunk.updatedAt);
  if (updatedAt < createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["updatedAt"],
      message: "updatedAt cannot be earlier than createdAt"
    });
  }

  if (chunk.startedAt && Date.parse(chunk.startedAt) < createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startedAt"],
      message: "startedAt cannot be earlier than createdAt"
    });
  }

  if (chunk.finishedAt) {
    const lowerBound = chunk.startedAt ? Date.parse(chunk.startedAt) : createdAt;
    if (Date.parse(chunk.finishedAt) < lowerBound) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt cannot be earlier than chunk start"
      });
    }
  }
}

export type ChunkProcessingStatus = z.infer<typeof ChunkProcessingStatusSchema>;
export type ChunkProcessingError = z.infer<typeof ChunkProcessingErrorSchema>;
export type ChunkMetadata = z.infer<typeof ChunkMetadataSchema>;
