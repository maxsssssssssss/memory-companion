import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { getPipelineQueueConfig, type PipelineQueueConfig } from "./config";
import {
  buildPipelineJobId,
  PIPELINE_QUEUE_JOB_NAME,
  PipelineJobDataSchema,
  type PipelineJobData
} from "./types";

type QueueJobLike = {
  id?: string;
  getState?(): Promise<string>;
  remove?(): Promise<void>;
};

export type PipelineQueueAdapter = {
  waitUntilReady(): Promise<unknown>;
  getJob(jobId: string): Promise<QueueJobLike | null | undefined>;
  add(name: string, data: PipelineJobData, options: JobsOptions): Promise<QueueJobLike>;
  close(): Promise<void>;
};

export type RedisConnectionAdapter = {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
};

export type PipelineProducerDependencies = {
  createRedis: (config: PipelineQueueConfig) => RedisConnectionAdapter;
  createQueue: (config: PipelineQueueConfig, connection: RedisConnectionAdapter) => PipelineQueueAdapter;
};

const defaultDependencies: PipelineProducerDependencies = {
  createRedis: (config) =>
    new IORedis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 5_000,
      enableReadyCheck: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    }),
  createQueue: (config, connection) =>
    new Queue<PipelineJobData>(config.queueName, {
      connection: connection as IORedis
    }) as unknown as PipelineQueueAdapter
};

export type EnqueuePipelineJobResult = { jobId: string; enqueued: boolean };

export type EnqueuePipelineJobOptions = {
  config?: PipelineQueueConfig;
  dependencies?: Partial<PipelineProducerDependencies>;
  /**
   * Startup recovery may replace a terminal BullMQ record whose product job is
   * still recoverable. Normal producers deliberately deduplicate terminal jobs
   * as well as active ones.
   */
  reviveTerminal?: boolean;
};

export class PipelineQueueUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Pipeline queue is unavailable", { cause });
    this.name = "PipelineQueueUnavailableError";
  }
}

async function closeRedis(connection: RedisConnectionAdapter) {
  try {
    await connection.quit();
  } catch {
    connection.disconnect(false);
  }
}

export async function enqueuePipelineJob(
  data: PipelineJobData,
  options: EnqueuePipelineJobOptions = {}
): Promise<EnqueuePipelineJobResult> {
  const payload = PipelineJobDataSchema.parse(data);
  const config = options.config ?? getPipelineQueueConfig();
  if (config.executionMode !== "queue") {
    throw new PipelineQueueUnavailableError();
  }
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const jobId = buildPipelineJobId(payload);
  const redis = dependencies.createRedis(config);
  let queue: PipelineQueueAdapter | undefined;

  try {
    await redis.connect();
    await redis.ping();
    queue = dependencies.createQueue(config, redis);
    await queue.waitUntilReady();
    const existing = await queue.getJob(jobId);
    if (existing) {
      if (
        !options.reviveTerminal ||
        !existing.getState ||
        !existing.remove
      ) {
        return { jobId, enqueued: false };
      }
      const state = await existing.getState();
      if (state !== "completed" && state !== "failed") {
        return { jobId, enqueued: false };
      }
      await existing.remove();
    }
    await queue.add(PIPELINE_QUEUE_JOB_NAME, payload, {
      jobId,
      attempts: config.attempts,
      backoff: { type: "exponential", delay: config.backoffMs },
      removeOnComplete: false,
      removeOnFail: false
    });
    return { jobId, enqueued: true };
  } catch (error) {
    if (error instanceof PipelineQueueUnavailableError) {
      throw error;
    }
    throw new PipelineQueueUnavailableError(error);
  } finally {
    await queue?.close().catch(() => undefined);
    await closeRedis(redis);
  }
}

export type PipelineQueueProducer = {
  enqueue(payload: PipelineJobData): Promise<EnqueuePipelineJobResult>;
  close(): Promise<void>;
};

export function createPipelineQueueProducer(
  options: Parameters<typeof enqueuePipelineJob>[1] = {}
): PipelineQueueProducer {
  return {
    enqueue: (payload) => enqueuePipelineJob(payload, options),
    close: async () => undefined
  };
}

export const enqueue = enqueuePipelineJob;
