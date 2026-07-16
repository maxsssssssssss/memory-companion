import { createHash } from "node:crypto";
import { z } from "zod";

export const PIPELINE_QUEUE_PAYLOAD_VERSION = 1 as const;
export const PIPELINE_QUEUE_JOB_NAME = "process-upload" as const;

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
