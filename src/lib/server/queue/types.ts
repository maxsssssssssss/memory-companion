import { createHash } from "node:crypto";
import { z } from "zod";

export const PIPELINE_QUEUE_PAYLOAD_VERSION = 1 as const;
export const PIPELINE_QUEUE_JOB_NAME = "process-upload" as const;
export const DAILY_REFLECTION_QUEUE_JOB_NAME = "process-daily-reflection-upload" as const;
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

export const DailyReflectionQueuePayloadSchema = z.object({
  version: z.literal(PIPELINE_QUEUE_PAYLOAD_VERSION),
  ingestionContext: z.literal("daily_reflection"),
  reflectionId: QueueReferenceSchema,
  userRef: QueueReferenceSchema
}).strict();

export type DailyReflectionQueuePayload = z.infer<
  typeof DailyReflectionQueuePayloadSchema
>;

export const EmbeddingIndexQueuePayloadSchema = z
  .object({
    version: z.literal(PIPELINE_QUEUE_PAYLOAD_VERSION),
    userRef: QueueReferenceSchema,
    reason: z.enum(["startup", "upload_ready", "upload_deleted", "manual"])
  })
  .strict();

export type EmbeddingIndexQueuePayload = z.infer<
  typeof EmbeddingIndexQueuePayloadSchema
>;
export type DailyBriefQueueJobData =
  | PipelineJobData
  | DailyReflectionQueuePayload
  | EmbeddingIndexQueuePayload;

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

export function buildDailyReflectionQueueJobId(
  input: Pick<DailyReflectionQueuePayload, "reflectionId" | "userRef">
) {
  const reflectionId = QueueReferenceSchema.parse(input.reflectionId);
  const userRef = QueueReferenceSchema.parse(input.userRef);
  const digest = createHash("sha256")
    .update(`${userRef}\u0000${reflectionId}`)
    .digest("hex");
  return `daily-reflection-${digest}`;
}

export function buildEmbeddingIndexQueueJobId(
  input: Pick<EmbeddingIndexQueuePayload, "userRef">
) {
  const userRef = QueueReferenceSchema.parse(input.userRef);
  const digest = createHash("sha256").update(userRef).digest("hex");
  return `hybrid-index-${digest}`;
}
