import { randomUUID } from "node:crypto";

import {
  Queue,
  UnrecoverableError,
  Worker,
  type Job,
  type JobsOptions
} from "bullmq";
import IORedis from "ioredis";

import {
  getDailyReflectionAiReviewService
} from "@/lib/server/daily-reflection/ai-review-service";
import {
  getDailyReflectionAiReviewMode,
  type DailyReflectionAiReviewMode
} from "@/lib/server/daily-reflection/runtime-config";

import { getPipelineQueueConfig, type PipelineQueueConfig } from "./config";
import { dailyReflectionAiReviewQueueName } from
  "./daily-reflection-ai-review-queue";
import { assertQueueStorageProbe } from "./storage-probe";
import {
  buildDailyReflectionAiReviewQueueJobId,
  DAILY_REFLECTION_AI_REVIEW_QUEUE_JOB_NAME,
  DailyReflectionAiReviewQueuePayloadSchema,
  type DailyReflectionAiReviewQueuePayload
} from "./types";

type RuntimeResult = {
  status: string;
};

type RedisAdapter = {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
};

type QueueAdapter = {
  waitUntilReady(): Promise<unknown>;
  getJob(jobId: string): Promise<{
    getState(): Promise<string>;
    remove(): Promise<void>;
  } | null | undefined>;
  add(
    name: string,
    data: DailyReflectionAiReviewQueuePayload,
    options: JobsOptions
  ): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getWorkersCount(): Promise<number>;
  close(): Promise<void>;
};

type WorkerJob = {
  id?: string;
  name: string;
  data: DailyReflectionAiReviewQueuePayload;
};

type WorkerAdapter = {
  on(event: "active", listener: (job: WorkerJob) => void): unknown;
  on(
    event: "completed",
    listener: (job: WorkerJob, result: RuntimeResult) => void
  ): unknown;
  on(
    event: "failed",
    listener: (job: WorkerJob | undefined, error: Error) => void
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  run(): Promise<void>;
  close(force?: boolean): Promise<void>;
};

type ServiceAdapter = {
  recover(): {
    returnedToQueue: number;
    providerOutcomeUnknown: number;
    queued: Array<{ accountId: string; reviewId: string }>;
  };
  process(input: {
    accountId: string;
    reviewId: string;
    workerId: string;
  }): Promise<RuntimeResult>;
};

type RuntimeLogger = Pick<Console, "info" | "warn" | "error">;

export type DailyReflectionAiReviewRuntimeHealth = {
  mode: Exclude<DailyReflectionAiReviewMode, "off">;
  running: boolean;
  workers: number;
  waiting: number;
  active: number;
  failed: number;
};

export type DailyReflectionAiReviewRuntime = {
  readonly mode: Exclude<DailyReflectionAiReviewMode, "off">;
  readonly recovery: {
    returnedToQueue: number;
    providerOutcomeUnknown: number;
    queued: number;
    enqueued: number;
    existing: number;
  };
  readonly runPromise: Promise<void>;
  getHealthSnapshot(): Promise<DailyReflectionAiReviewRuntimeHealth>;
  close(): Promise<void>;
};

export type DailyReflectionAiReviewRuntimeDependencies = {
  mode(env: Readonly<Record<string, string | undefined>>): DailyReflectionAiReviewMode;
  createRedis(config: PipelineQueueConfig): RedisAdapter;
  createQueue(
    config: PipelineQueueConfig,
    connection: RedisAdapter,
    queueName: string
  ): QueueAdapter;
  createWorker(
    config: PipelineQueueConfig,
    connection: RedisAdapter,
    queueName: string,
    processor: (job: WorkerJob) => Promise<RuntimeResult>
  ): WorkerAdapter;
  verifyStorage(config: PipelineQueueConfig, connection: RedisAdapter): Promise<unknown>;
  createService(): ServiceAdapter;
  workerId(): string;
  logger: RuntimeLogger;
  setInterval(handler: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
};

export const DAILY_REFLECTION_AI_REVIEW_MAX_STALLED_COUNT = 0 as const;

const defaultDependencies: DailyReflectionAiReviewRuntimeDependencies = {
  mode: getDailyReflectionAiReviewMode,
  createRedis: (config) => new IORedis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 10_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: null
  }),
  createQueue: (_config, connection, queueName) => new Queue(queueName, {
    connection: connection as IORedis
  }) as unknown as QueueAdapter,
  createWorker: (_config, connection, queueName, processor) =>
    new Worker<DailyReflectionAiReviewQueuePayload, RuntimeResult>(
      queueName,
      (job: Job<DailyReflectionAiReviewQueuePayload>) => processor(job),
      {
        connection: connection as IORedis,
        concurrency: 1,
        autorun: false,
        maxStalledCount: DAILY_REFLECTION_AI_REVIEW_MAX_STALLED_COUNT
      }
    ) as unknown as WorkerAdapter,
  verifyStorage: (config, connection) => assertQueueStorageProbe({
    config,
    redis: connection
  }),
  createService: getDailyReflectionAiReviewService,
  workerId: () => `daily-reflection-ai-review:${randomUUID()}`,
  logger: console,
  setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
  clearInterval: (timer) => clearInterval(timer)
};

async function closeRedis(connection: RedisAdapter) {
  try {
    await connection.quit();
  } catch {
    connection.disconnect(false);
  }
}

function queueOptions(config: PipelineQueueConfig): JobsOptions {
  return {
    attempts: 1,
    removeOnComplete: config.retention.completed,
    removeOnFail: config.retention.failed
  };
}

export async function startDailyReflectionAiReviewRuntime(
  options: {
    env?: Record<string, string | undefined>;
    config?: PipelineQueueConfig;
    dependencies?: Partial<DailyReflectionAiReviewRuntimeDependencies>;
  } = {}
): Promise<DailyReflectionAiReviewRuntime | null> {
  const env = options.env ?? process.env;
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const mode = dependencies.mode(env);
  if (mode === "off") return null;

  const config = options.config ?? getPipelineQueueConfig(env);
  if (config.executionMode !== "queue") {
    throw new Error("Daily Reflection AI review requires queue execution mode");
  }

  const connection = dependencies.createRedis(config);
  const queueName = dailyReflectionAiReviewQueueName(config);
  let queue: QueueAdapter | undefined;
  let worker: WorkerAdapter | undefined;
  try {
    await connection.connect();
    await connection.ping();
    await dependencies.verifyStorage(config, connection);
    queue = dependencies.createQueue(config, connection, queueName);
    await queue.waitUntilReady();

    const service = dependencies.createService();
    const workerId = dependencies.workerId();
    const processor = async (job: WorkerJob): Promise<RuntimeResult> => {
      if (job.name !== DAILY_REFLECTION_AI_REVIEW_QUEUE_JOB_NAME) {
        throw new UnrecoverableError("Unknown Daily Reflection AI review job");
      }
      const payload = DailyReflectionAiReviewQueuePayloadSchema.parse(job.data);
      if (dependencies.mode(env) === "off") {
        return { status: "disabled" };
      }
      const result = await service.process({
        accountId: payload.userRef,
        reviewId: payload.reviewId,
        workerId
      });
      if (result.status === "failed") {
        throw new UnrecoverableError("Daily Reflection AI review failed");
      }
      return result;
    };

    worker = dependencies.createWorker(
      config,
      connection,
      queueName,
      processor
    );
    worker.on("active", (job) => {
      dependencies.logger.info(
        `[daily-reflection-ai-review-worker] active queue_job_id=${job.id ?? "unknown"}`
      );
    });
    worker.on("completed", (job, result) => {
      dependencies.logger.info(
        `[daily-reflection-ai-review-worker] completed queue_job_id=${job.id ?? "unknown"} status=${result.status}`
      );
    });
    worker.on("failed", (job, error) => {
      dependencies.logger.error(
        `[daily-reflection-ai-review-worker] failed queue_job_id=${job?.id ?? "unknown"} error_name=${error.name}`
      );
    });
    worker.on("error", (error) => {
      dependencies.logger.error(
        `[daily-reflection-ai-review-worker] runtime_error error_name=${error.name}`
      );
    });

    const recoverOnce = async () => {
      const recovered = service.recover();
      let enqueued = 0;
      let existing = 0;
      for (const item of recovered.queued) {
        const payload = DailyReflectionAiReviewQueuePayloadSchema.parse({
          version: 1,
          reviewId: item.reviewId,
          userRef: item.accountId
        });
        const jobId = buildDailyReflectionAiReviewQueueJobId(payload);
        const existingJob = await queue!.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state === "completed" || state === "failed") {
            // The SQLite recovery result is the authority here: listQueued()
            // only exposes rows whose Provider call never started. A retained
            // terminal Bull job can therefore be replaced without repeating a
            // completion. Active/waiting jobs remain untouched.
            await existingJob.remove();
          } else {
            existing += 1;
            continue;
          }
        }
        await queue!.add(
          DAILY_REFLECTION_AI_REVIEW_QUEUE_JOB_NAME,
          payload,
          { ...queueOptions(config), jobId }
        );
        enqueued += 1;
      }
      return {
        returnedToQueue: recovered.returnedToQueue,
        providerOutcomeUnknown: recovered.providerOutcomeUnknown,
        queued: recovered.queued.length,
        enqueued,
        existing
      };
    };
    const recovery = await recoverOnce();
    dependencies.logger.info(
      `[daily-reflection-ai-review-worker] ready mode=${mode} queue=${queueName} concurrency=1 recovered=${recovery.enqueued}/${recovery.queued} provider_outcome_unknown=${recovery.providerOutcomeUnknown}`
    );

    let running = true;
    let closing = false;
    const runPromise = worker.run().finally(() => {
      running = false;
    });
    let periodicRecovery: Promise<void> | null = null;
    const recoveryTimer = dependencies.setInterval(() => {
      if (closing || periodicRecovery || dependencies.mode(env) === "off") return;
      periodicRecovery = recoverOnce()
        .then((report) => {
          dependencies.logger.info(
            `[daily-reflection-ai-review-worker] recovery recovered=${report.enqueued}/${report.queued} existing=${report.existing} provider_outcome_unknown=${report.providerOutcomeUnknown}`
          );
        })
        .catch((error: unknown) => {
          dependencies.logger.error(
            `[daily-reflection-ai-review-worker] recovery_failed error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        })
        .finally(() => {
          periodicRecovery = null;
        });
    }, config.recoveryIntervalMs);
    recoveryTimer.unref?.();
    let closePromise: Promise<void> | undefined;
    return {
      mode,
      recovery,
      runPromise,
      async getHealthSnapshot() {
        const counts = await queue!.getJobCounts("waiting", "active", "failed");
        return {
          mode,
          running,
          workers: await queue!.getWorkersCount(),
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0
        };
      },
      close() {
        closePromise ??= (async () => {
          closing = true;
          running = false;
          dependencies.clearInterval(recoveryTimer);
          await worker!.close();
          await runPromise.catch(() => undefined);
          await periodicRecovery?.catch(() => undefined);
          await queue!.close();
          await closeRedis(connection);
          dependencies.logger.info(
            "[daily-reflection-ai-review-worker] shutdown_completed"
          );
        })();
        return closePromise;
      }
    };
  } catch (error) {
    await worker?.close(true).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await closeRedis(connection);
    throw error;
  }
}
