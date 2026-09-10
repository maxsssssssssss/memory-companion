import { createHash } from "node:crypto";

import { z } from "zod";

import type { PipelineQueueConfig } from "./config";

export const WORK_WEEKLY_QUEUE_PAYLOAD_VERSION = 1 as const;
export const WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME =
  "generate-work-weekly-review" as const;
export const WORK_WEEKLY_QA_QUEUE_JOB_NAME = "answer-work-weekly-question" as const;

const QueueReferenceSchema = z.string().trim().min(1).max(512);
const SourceSnapshotDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const WorkWeeklyQueueIdentityShape = {
  version: z.literal(WORK_WEEKLY_QUEUE_PAYLOAD_VERSION),
  accountId: QueueReferenceSchema,
  weeklyReviewId: QueueReferenceSchema,
  runId: QueueReferenceSchema,
  runVersion: z.number().int().positive(),
  sourceSnapshotDigest: SourceSnapshotDigestSchema
} as const;

export const WorkWeeklyGenerationQueuePayloadSchema = z.object({
  ...WorkWeeklyQueueIdentityShape,
  kind: z.literal("generation")
}).strict();

export const WorkWeeklyQaQueuePayloadSchema = z.object({
  ...WorkWeeklyQueueIdentityShape,
  kind: z.literal("qa"),
  threadId: QueueReferenceSchema,
  questionMessageId: QueueReferenceSchema
}).strict();

export const WorkWeeklyQueuePayloadSchema = z.discriminatedUnion("kind", [
  WorkWeeklyGenerationQueuePayloadSchema,
  WorkWeeklyQaQueuePayloadSchema
]);

export type WorkWeeklyGenerationQueuePayload = z.infer<
  typeof WorkWeeklyGenerationQueuePayloadSchema
>;
export type WorkWeeklyQaQueuePayload = z.infer<
  typeof WorkWeeklyQaQueuePayloadSchema
>;
export type WorkWeeklyQueuePayload = z.infer<typeof WorkWeeklyQueuePayloadSchema>;

export function workWeeklyQueueName(config: Pick<PipelineQueueConfig, "queueName">) {
  return `${config.queueName}-work-weekly`;
}

export function workWeeklyQueueJobName(payload: WorkWeeklyQueuePayload) {
  return payload.kind === "generation"
    ? WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME
    : WORK_WEEKLY_QA_QUEUE_JOB_NAME;
}

export function buildWorkWeeklyQueueJobId(input: WorkWeeklyQueuePayload) {
  const payload = WorkWeeklyQueuePayloadSchema.parse(input);
  const digest = createHash("sha256")
    .update(
      `${payload.kind}\u0000${payload.accountId}\u0000${payload.runId}\u0000${payload.runVersion}`
    )
    .digest("hex");
  return `work-weekly-${payload.kind}-${digest}`;
}
