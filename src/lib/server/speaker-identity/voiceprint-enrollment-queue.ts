import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";

import {
  getUserScopedStore,
  getUserUploadsRootDir
} from "@/lib/server/auth/session";
import {
  getPipelineQueueConfig,
  sanitizedRedisEndpoint,
  type PipelineQueueConfig
} from "@/lib/server/queue/config";

import { processVoiceprintSelfEnrollment } from "./voiceprint-self-enrollment";

export const VOICEPRINT_ENROLLMENT_JOB_NAME = "voiceprint-self-enrollment";

export const VoiceprintEnrollmentJobDataSchema = z.object({
  version: z.literal(1),
  userId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512),
  operationId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512)
}).strict();

export type VoiceprintEnrollmentJobData = z.infer<
  typeof VoiceprintEnrollmentJobDataSchema
>;

export type VoiceprintEnrollmentQueueConfig = {
  redisUrl: string;
  queueName: string;
  workerConcurrency: number;
};

function enrollmentConfig(
  pipeline: PipelineQueueConfig = getPipelineQueueConfig()
): VoiceprintEnrollmentQueueConfig {
  return {
    redisUrl: pipeline.redisUrl,
    queueName: `${pipeline.queueName}-voiceprint-enrollment`,
    workerConcurrency: 1
  };
}

function enrollmentJobId(data: VoiceprintEnrollmentJobData) {
  return `voiceprint-enrollment-${data.userId}-${data.operationId}`;
}

type QueueJobLike = {
  id?: string;
};

export type VoiceprintEnrollmentQueueAdapter = {
  waitUntilReady(): Promise<unknown>;
  getJob(jobId: string): Promise<QueueJobLike | null | undefined>;
  add(
    name: string,
    data: VoiceprintEnrollmentJobData,
    options: JobsOptions
  ): Promise<QueueJobLike>;
  close(): Promise<void>;
};

export type VoiceprintEnrollmentRedisAdapter = {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
};

export class VoiceprintEnrollmentQueueUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Voiceprint enrollment queue is unavailable", { cause });
    this.name = "VoiceprintEnrollmentQueueUnavailableError";
  }
}

async function closeRedis(connection: VoiceprintEnrollmentRedisAdapter) {
  try {
    await connection.quit();
  } catch {
    connection.disconnect(false);
  }
}

export async function enqueueVoiceprintEnrollment(
  rawData: VoiceprintEnrollmentJobData,
  options: {
    config?: VoiceprintEnrollmentQueueConfig;
    createRedis?: (
      config: VoiceprintEnrollmentQueueConfig
    ) => VoiceprintEnrollmentRedisAdapter;
    createQueue?: (
      config: VoiceprintEnrollmentQueueConfig,
      connection: VoiceprintEnrollmentRedisAdapter
    ) => VoiceprintEnrollmentQueueAdapter;
  } = {}
) {
  const data = VoiceprintEnrollmentJobDataSchema.parse(rawData);
  const config = options.config ?? enrollmentConfig();
  const createRedis =
    options.createRedis ??
    ((resolved: VoiceprintEnrollmentQueueConfig) =>
      new IORedis(resolved.redisUrl, {
        lazyConnect: true,
        connectTimeout: 5_000,
        enableReadyCheck: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null
      }));
  const createQueue =
    options.createQueue ??
    ((
      resolved: VoiceprintEnrollmentQueueConfig,
      connection: VoiceprintEnrollmentRedisAdapter
    ) =>
      new Queue<VoiceprintEnrollmentJobData>(resolved.queueName, {
        connection: connection as IORedis
      }) as unknown as VoiceprintEnrollmentQueueAdapter);
  const redis = createRedis(config);
  let queue: VoiceprintEnrollmentQueueAdapter | undefined;
  const jobId = enrollmentJobId(data);

  try {
    await redis.connect();
    await redis.ping();
    queue = createQueue(config, redis);
    await queue.waitUntilReady();
    const existing = await queue.getJob(jobId);
    if (existing) {
      return { jobId, enqueued: false };
    }
    await queue.add(VOICEPRINT_ENROLLMENT_JOB_NAME, data, {
      jobId,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false
    });
    return { jobId, enqueued: true };
  } catch (error) {
    throw new VoiceprintEnrollmentQueueUnavailableError(error);
  } finally {
    await queue?.close().catch(() => undefined);
    await closeRedis(redis);
  }
}

export type VoiceprintEnrollmentWorkerRuntime = {
  runPromise: Promise<void>;
  close(): Promise<void>;
};

export async function startVoiceprintEnrollmentWorker(): Promise<
  VoiceprintEnrollmentWorkerRuntime
> {
  const config = enrollmentConfig();
  const connection = new IORedis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 10_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: null
  });
  await connection.connect();
  await connection.ping();
  const worker = new Worker<
    VoiceprintEnrollmentJobData,
    Awaited<ReturnType<typeof processVoiceprintSelfEnrollment>>
  >(
    config.queueName,
    async (job: Job<VoiceprintEnrollmentJobData>) => {
      const data = VoiceprintEnrollmentJobDataSchema.parse(job.data);
      return await processVoiceprintSelfEnrollment({
        store: getUserScopedStore(data.userId),
        userId: data.userId,
        uploadsRootDir: getUserUploadsRootDir(data.userId),
        operationId: data.operationId
      });
    },
    {
      connection,
      concurrency: config.workerConcurrency,
      autorun: false,
      maxStalledCount: 1
    }
  );
  worker.on("active", (job) => {
    console.info(
      `[voiceprint-enrollment-worker] active queue_job_id=${job.id ?? "unknown"} attempt=1`
    );
  });
  worker.on("completed", (job, result) => {
    console.info(
      `[voiceprint-enrollment-worker] completed queue_job_id=${job.id ?? "unknown"} status=${result.status}`
    );
  });
  worker.on("failed", (job, error) => {
    console.error(
      `[voiceprint-enrollment-worker] failed queue_job_id=${job?.id ?? "unknown"} attempt=1 error_name=${error.name}`
    );
  });
  worker.on("error", (error) => {
    console.error(
      `[voiceprint-enrollment-worker] runtime error error_name=${error.name}`
    );
  });

  console.info(
    `[voiceprint-enrollment-worker] ready queue=${config.queueName} redis=${sanitizedRedisEndpoint(config.redisUrl)} concurrency=${config.workerConcurrency}`
  );
  const runPromise = worker.run();
  let closePromise: Promise<void> | undefined;
  return {
    runPromise,
    close() {
      closePromise ??= (async () => {
        console.info("[voiceprint-enrollment-worker] shutdown started");
        await worker.close();
        await runPromise.catch(() => undefined);
        try {
          await connection.quit();
        } catch {
          connection.disconnect(false);
        }
        console.info("[voiceprint-enrollment-worker] shutdown completed");
      })();
      return closePromise;
    }
  };
}

export const voiceprintEnrollmentQueuePolicy = {
  attempts: 1,
  backoff: null,
  removeOnComplete: false,
  removeOnFail: false
} as const;
