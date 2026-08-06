import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { getPipelineQueueConfig, type PipelineQueueConfig } from "./config";
import { assertQueueStorageProbe } from "./storage-probe";
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
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
};

export type PipelineProducerDependencies = {
  createRedis: (config: PipelineQueueConfig) => RedisConnectionAdapter;
  createQueue: (config: PipelineQueueConfig, connection: RedisConnectionAdapter) => PipelineQueueAdapter;
  verifyStorageProbe: (
    config: PipelineQueueConfig,
    connection: RedisConnectionAdapter
  ) => Promise<unknown>;
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
    }) as unknown as PipelineQueueAdapter,
  verifyStorageProbe: (config, connection) => assertQueueStorageProbe({
    config,
    redis: connection
  })
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
  let addAttempted = false;

  try {
    await redis.connect();
    await redis.ping();
    await dependencies.verifyStorageProbe(config, redis);
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
    addAttempted = true;
    await queue.add(PIPELINE_QUEUE_JOB_NAME, payload, {
      jobId,
      attempts: config.attempts,
      backoff: { type: "exponential", delay: config.backoffMs },
      removeOnComplete: config.retention.completed,
      removeOnFail: config.retention.failed
    });
    return { jobId, enqueued: true };
  } catch (error) {
    if (error instanceof PipelineQueueUnavailableError) {
      throw error;
    }
    // BullMQ may persist the stable job and then lose the producer response.
    // Treat a readable job as accepted so the Web route never overwrites a
    // concurrently running/ready product state with a false terminal failure.
    if (queue && addAttempted) {
      try {
        if (await queue.getJob(jobId)) return { jobId, enqueued: false };
      } catch {
        // Preserve the original availability error when Redis is ambiguous.
      }
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
