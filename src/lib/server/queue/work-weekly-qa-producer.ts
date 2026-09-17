import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";

import { isWorkReviewWeeklyQaEnabled } from "@/lib/server/work-review/runtime-config";
import { getPipelineQueueConfig, type PipelineQueueConfig } from "./config";
import { PipelineQueueUnavailableError, type RedisConnectionAdapter } from "./producer";
import { assertQueueStorageProbe } from "./storage-probe";
import { buildWorkWeeklyQueueJobId, WORK_WEEKLY_QA_QUEUE_JOB_NAME, WorkWeeklyQaQueuePayloadSchema,
  workWeeklyQueueName, type WorkWeeklyQaQueuePayload } from "./work-weekly-queue";

type QueueAdapter = {
  waitUntilReady(): Promise<unknown>;
  getJob(jobId: string): Promise<object | null | undefined>;
  add(name: string, data: WorkWeeklyQaQueuePayload, options: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
};

export type WorkWeeklyQaProducerDependencies = {
  enabled(): boolean;
  createRedis(config: PipelineQueueConfig): RedisConnectionAdapter;
  createQueue(config: PipelineQueueConfig, connection: RedisConnectionAdapter): QueueAdapter;
  verifyStorage(config: PipelineQueueConfig, connection: RedisConnectionAdapter): Promise<unknown>;
};

const defaultDependencies: WorkWeeklyQaProducerDependencies = {
  enabled: () => isWorkReviewWeeklyQaEnabled() === true,
  createRedis: (config) => new IORedis(config.redisUrl, {
    lazyConnect: true, connectTimeout: 1_000, commandTimeout: 1_000,
    enableReadyCheck: true, maxRetriesPerRequest: 0, retryStrategy: () => null
  // ioredis otherwise prints unhandled error.stack, including endpoint details.
  // Command rejection is handled by the caller's fixed, content-free diagnostic.
  }).on("error", () => undefined),
  createQueue: (config, connection) => new Queue(workWeeklyQueueName(config), {
    connection: connection as IORedis
  }) as unknown as QueueAdapter,
  verifyStorage: (config, connection) => assertQueueStorageProbe({ config, redis: connection })
};

/** An immediate transport hint for an already committed run. SQLite remains
 * authority; failed hints are recovered by the unchanged periodic scan. */
export async function enqueueWorkWeeklyQaJob(data: WorkWeeklyQaQueuePayload, options: {
  config?: PipelineQueueConfig;
  dependencies?: Partial<WorkWeeklyQaProducerDependencies>;
} = {}) {
  const payload = WorkWeeklyQaQueuePayloadSchema.parse(data);
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  if (!dependencies.enabled()) throw new PipelineQueueUnavailableError();
  const config = options.config ?? getPipelineQueueConfig();
  if (config.executionMode !== "queue") throw new PipelineQueueUnavailableError();
  const jobId = buildWorkWeeklyQueueJobId(payload);
  const connection = dependencies.createRedis(config);
  let queue: QueueAdapter | undefined;
  let addAttempted = false;
  try {
    await connection.connect();
    await connection.ping();
    await dependencies.verifyStorage(config, connection);
    queue = dependencies.createQueue(config, connection);
    await queue.waitUntilReady();
    // Terminal receipts also deduplicate: this endpoint never revives a job.
    if (await queue.getJob(jobId)) return { jobId, enqueued: false };
    addAttempted = true;
    await queue.add(WORK_WEEKLY_QA_QUEUE_JOB_NAME, payload, {
      jobId, attempts: 1, removeOnComplete: config.retention.completed, removeOnFail: config.retention.failed
    });
    return { jobId, enqueued: true };
  } catch (error) {
    if (queue && addAttempted && await queue.getJob(jobId).catch(() => null)) return { jobId, enqueued: false };
    throw new PipelineQueueUnavailableError(error);
  } finally {
    await queue?.close().catch(() => undefined);
    try { await connection.quit(); } catch { connection.disconnect(false); }
  }
}
