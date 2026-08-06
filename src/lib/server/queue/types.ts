import { createHash } from "node:crypto";
import { z } from "zod";

export const PIPELINE_QUEUE_PAYLOAD_VERSION = 1 as const;
export const PIPELINE_QUEUE_JOB_NAME = "process-upload" as const;
export const EMBEDDING_INDEX_QUEUE_JOB_NAME = "refresh-embedding-index" as const;

const QueueReferenceSchema = z.string().trim().min(1).max(512);

export const PipelineQueuePayloadSchema = z
  .object({
    version: z.literal(PIPELINE_QUEUE_PAYLOAD_VERSION),
    uploadId: QueueReferenceSchema,
    userRef: QueueReferenceSchema
  })
  .strict();

export type PipelineQueuePayload = z.infer<typeof PipelineQueuePayloadSchema>;

// Compatibility aliases for consumers that describe BullMQ data as job data.
export const PipelineJobDataSchema = PipelineQueuePayloadSchema;
export type PipelineJobData = PipelineQueuePayload;

export const EmbeddingIndexQueuePayloadSchema = z
  .object({
    version: z.literal(PIPELINE_QUEUE_PAYLOAD_VERSION),
    userRef: QueueReferenceSchema,
    reason: z.enum([
      "startup",
      "upload_ready",
      "upload_deleted",
      "speaker_aliases",
      "audio_insight_corrections",
      "browser_cleanup",
      "permanent_delete",
      "manual"
    ])
  })
  .strict();

export type EmbeddingIndexQueuePayload = z.infer<
  typeof EmbeddingIndexQueuePayloadSchema
>;
export type DailyBriefQueueJobData = PipelineJobData | EmbeddingIndexQueuePayload;

export function buildPipelineQueueJobId(
  input: Pick<PipelineQueuePayload, "uploadId" | "userRef"> &
    Partial<Pick<PipelineQueuePayload, "version">>
) {
  const uploadId = QueueReferenceSchema.parse(input.uploadId);
  const userRef = QueueReferenceSchema.parse(input.userRef);
  const digest = createHash("sha256").update(userRef + uploadId).digest("hex");
  return `pipeline-${digest}`;
}

export const buildPipelineJobId = buildPipelineQueueJobId;

export function buildEmbeddingIndexQueueJobIds(
  input: Pick<EmbeddingIndexQueuePayload, "userRef">
) {
  const userRef = QueueReferenceSchema.parse(input.userRef);
  const digest = createHash("sha256").update(userRef).digest("hex");
  return [`hybrid-index-${digest}-0`, `hybrid-index-${digest}-1`] as const;
}

export function buildEmbeddingIndexQueueJobId(
  input: Pick<EmbeddingIndexQueuePayload, "userRef">
) {
  return buildEmbeddingIndexQueueJobIds(input)[0];
}
