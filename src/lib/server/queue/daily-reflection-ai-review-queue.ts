import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";

import {
  getDailyReflectionAiReviewMode,
  type DailyReflectionAiReviewMode
} from "@/lib/server/daily-reflection/runtime-config";

import { getPipelineQueueConfig, type PipelineQueueConfig } from "./config";
import { PipelineQueueUnavailableError } from "./producer";
import { assertQueueStorageProbe } from "./storage-probe";
import {
  buildDailyReflectionAiReviewQueueJobId,
  DAILY_REFLECTION_AI_REVIEW_QUEUE_JOB_NAME,
  DailyReflectionAiReviewQueuePayloadSchema,
  type DailyReflectionAiReviewQueuePayload
} from "./types";

type QueueJobLike = object;

type QueueAdapter = {
  waitUntilReady(): Promise<unknown>;
  getJob(jobId: string): Promise<QueueJobLike | null | undefined>;
  add(
    name: string,
    data: DailyReflectionAiReviewQueuePayload,
    options: JobsOptions
  ): Promise<unknown>;
  close(): Promise<void>;
};

type RedisAdapter = {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
};

export type DailyReflectionAiReviewQueueDependencies = {
  mode(): DailyReflectionAiReviewMode;
  createRedis(config: PipelineQueueConfig): RedisAdapter;
  createQueue(
    config: PipelineQueueConfig,
    connection: RedisAdapter,
    queueName: string
  ): QueueAdapter;
  verifyStorage(config: PipelineQueueConfig, connection: RedisAdapter): Promise<unknown>;
};

const defaultDependencies: DailyReflectionAiReviewQueueDependencies = {
  mode: getDailyReflectionAiReviewMode,
  createRedis: (config) => new IORedis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 5_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  }),
  createQueue: (_config, connection, queueName) => new Queue(queueName, {
    connection: connection as IORedis
  }) as unknown as QueueAdapter,
  verifyStorage: (config, connection) => assertQueueStorageProbe({
    config,
    redis: connection
  })
};

export function dailyReflectionAiReviewQueueName(config: PipelineQueueConfig) {
  return `${config.queueName}-ai-review`;
}

export class DailyReflectionAiReviewQueueDisabledError extends Error {
  constructor() {
    super("Daily Reflection AI review queue is disabled");
    this.name = "DailyReflectionAiReviewQueueDisabledError";
  }
}

async function closeRedis(connection: RedisAdapter) {
  try {
    await connection.quit();
  } catch {
    connection.disconnect(false);
  }
}

export async function enqueueDailyReflectionAiReviewJob(
  data: DailyReflectionAiReviewQueuePayload,
  options: {
    config?: PipelineQueueConfig;
    dependencies?: Partial<DailyReflectionAiReviewQueueDependencies>;
  } = {}
) {
  const payload = DailyReflectionAiReviewQueuePayloadSchema.parse(data);
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  if (dependencies.mode() === "off") {
    throw new DailyReflectionAiReviewQueueDisabledError();
  }
  const config = options.config ?? getPipelineQueueConfig();
  if (config.executionMode !== "queue") throw new PipelineQueueUnavailableError();
  const connection = dependencies.createRedis(config);
  const jobId = buildDailyReflectionAiReviewQueueJobId(payload);
  let queue: QueueAdapter | undefined;
  let addAttempted = false;

  try {
    await connection.connect();
    await connection.ping();
    await dependencies.verifyStorage(config, connection);
    queue = dependencies.createQueue(
      config,
      connection,
      dailyReflectionAiReviewQueueName(config)
    );
    await queue.waitUntilReady();
    const existing = await queue.getJob(jobId);
    if (existing) {
      return { jobId, enqueued: false };
    }
    addAttempted = true;
    await queue.add(DAILY_REFLECTION_AI_REVIEW_QUEUE_JOB_NAME, payload, {
      jobId,
      attempts: 1,
      removeOnComplete: config.retention.completed,
      removeOnFail: config.retention.failed
    });
    return { jobId, enqueued: true };
  } catch (error) {
    if (error instanceof PipelineQueueUnavailableError) throw error;
    if (queue && addAttempted) {
      try {
        if (await queue.getJob(jobId)) return { jobId, enqueued: false };
      } catch {
        // Preserve the original queue-availability error when Redis is ambiguous.
      }
    }
    throw new PipelineQueueUnavailableError(error);
  } finally {
    await queue?.close().catch(() => undefined);
    await closeRedis(connection);
  }
}
