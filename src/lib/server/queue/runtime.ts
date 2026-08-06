import { UnrecoverableError, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { appStore } from "@/lib/server/storage/json-store";
import {
  getPipelineQueueConfig,
  sanitizedRedisEndpoint,
  type PipelineQueueConfig
} from "./config";
import {
  enqueueEmbeddingIndexJob,
  enqueuePipelineJob,
  type EnqueuePipelineJobResult
} from "./producer";
import { recoverPipelineJobs, type PipelineRecoveryReport } from "./recovery";
import {
  processEmbeddingIndexJob,
  type EmbeddingIndexWorkerResult
} from "./embedding-index-worker";
import {
  clearQueueWorkerStorageProbe,
  publishQueueWorkerStorageProbe,
  queueStorageMarkerFingerprint
} from "./storage-probe";
import {
  finalizePipelineQueueFailure,
  processPipelineJob,
  type PipelineWorkerResult
} from "./worker";
import {
  EMBEDDING_INDEX_QUEUE_JOB_NAME,
  EmbeddingIndexQueuePayloadSchema,
  PIPELINE_QUEUE_JOB_NAME,
  type DailyBriefQueueJobData,
  type PipelineJobData
} from "./types";
import {
  resolveHybridIndexRetentionPolicy,
  resolveQaHybridRetrievalMode,
  type HybridIndexRetentionPolicy
} from "@/lib/server/retrieval/hybrid/runtime-config";

export type PipelineWorkerRuntime = {
  recovery: PipelineRecoveryReport;
  runPromise: Promise<void>;
  close(): Promise<void>;
};

export function assertHybridIndexSingleWriter(
  mode: ReturnType<typeof resolveQaHybridRetrievalMode>,
  workerConcurrency: number,
  retentionPolicy: HybridIndexRetentionPolicy = "off"
) {
  if (
    (mode !== "off" || retentionPolicy !== "off") &&
    workerConcurrency !== 1
  ) {
    throw new Error("Hybrid index refresh requires PIPELINE_WORKER_CONCURRENCY=1");
  }
}

export async function enqueueAllUserEmbeddingIndexJobs(input: {
  users?: Array<{ id: string; value: { id?: string } }>;
  enqueue?: (
    payload: Parameters<typeof enqueueEmbeddingIndexJob>[0]
  ) => Promise<EnqueuePipelineJobResult>;
} = {}) {
  const users = input.users ?? await appStore.list<{ id?: string }>("users");
  const enqueue = input.enqueue ?? ((payload) => enqueueEmbeddingIndexJob(payload));
  let enqueued = 0;
  let existing = 0;
  for (const [index, record] of users.entries()) {
    const userRef =
      typeof record.value.id === "string" && record.value.id.trim()
        ? record.value.id
        : record.id;
    const result = await enqueue({
      version: 1,
      userRef,
      reason: "startup"
    });
    if (result.enqueued) enqueued += 1;
    else existing += 1;
    console.info(
      `[hybrid-index-worker] startup progress=${index + 1}/${users.length} ` +
      `status=${result.enqueued ? "enqueued" : "coalesced"}`
    );
  }
  return { total: users.length, enqueued, existing };
}

export async function processEmbeddingIndexQueueJob(
  job: Job<DailyBriefQueueJobData>,
  options: {
    config: PipelineQueueConfig;
    process?: typeof processEmbeddingIndexJob;
    enqueue?: (
      payload: Parameters<typeof enqueueEmbeddingIndexJob>[0]
    ) => Promise<EnqueuePipelineJobResult>;
  }
) {
  const payload = EmbeddingIndexQueuePayloadSchema.parse(job.data);
  const result = await (options.process ?? processEmbeddingIndexJob)(job);
  if (payload.reason === "permanent_delete") {
    const enqueue = options.enqueue ?? ((followup) =>
      enqueueEmbeddingIndexJob(followup, { config: options.config })
    );
    await enqueue({
      version: 1,
      userRef: payload.userRef,
      reason: "upload_deleted"
    });
  }
  return result;
}

export type PeriodicEmbeddingIndexRecoveryRuntime = {
  close(): Promise<void>;
};

export function startPeriodicEmbeddingIndexRecovery(input: {
  enabled: boolean;
  intervalMs: number;
  run: () => Promise<{ total: number; enqueued: number; existing: number }>;
  onReport?: (report: { total: number; enqueued: number; existing: number }) => void;
  onError?: (error: unknown) => void;
}): PeriodicEmbeddingIndexRecoveryRuntime {
  let closed = false;
  let running: Promise<void> | null = null;
  const trigger = () => {
    if (closed || running) return;
    running = input.run()
      .then((report) => input.onReport?.(report))
      .catch((error: unknown) => input.onError?.(error))
      .finally(() => {
        running = null;
      });
  };
  const timer = input.enabled ? setInterval(trigger, input.intervalMs) : undefined;
  timer?.unref();
  return {
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await running;
    }
  };
}

export async function startPipelineWorker(): Promise<PipelineWorkerRuntime> {
  const config = getPipelineQueueConfig();
  if (config.executionMode !== "queue") {
    throw new Error("daily-brief-worker requires PIPELINE_EXECUTION_MODE=queue");
  }
  const hybridMode = resolveQaHybridRetrievalMode();
  const hybridRetentionPolicy = resolveHybridIndexRetentionPolicy();
  const hybridIndexEnabled =
    hybridMode !== "off" || hybridRetentionPolicy !== "off";
  assertHybridIndexSingleWriter(
    hybridMode,
    config.workerConcurrency,
    hybridRetentionPolicy
  );

  const connection = new IORedis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 10_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: null
  });
  let workerStorageSummary: Awaited<ReturnType<typeof publishQueueWorkerStorageProbe>>;
  try {
    await connection.connect();
    await connection.ping();
    workerStorageSummary = await publishQueueWorkerStorageProbe({
      config,
      redis: connection
    });
  } catch (error) {
    connection.disconnect(false);
    throw error;
  }

  type QueueWorkerResult = PipelineWorkerResult | EmbeddingIndexWorkerResult;
  let worker: Worker<DailyBriefQueueJobData, QueueWorkerResult>;
  try {
    worker = new Worker<DailyBriefQueueJobData, QueueWorkerResult>(
      config.queueName,
      async (job: Job<DailyBriefQueueJobData>) => {
        if (job.name === EMBEDDING_INDEX_QUEUE_JOB_NAME) {
          return processEmbeddingIndexQueueJob(job, { config });
        }
        if (job.name !== PIPELINE_QUEUE_JOB_NAME) {
          throw new UnrecoverableError(`Unknown queue job name ${job.name}`);
        }
        const result = await processPipelineJob(job as Job<PipelineJobData>);
        if (result.status === "failed") {
          throw new UnrecoverableError(`Pipeline input is unavailable for upload ${result.uploadId}`);
        }
        if (result.status === "ready" && hybridIndexEnabled) {
          try {
            await enqueueEmbeddingIndexJob({
              version: 1,
              userRef: job.data.userRef,
              reason: "upload_ready"
            }, { config });
          } catch (error) {
            console.warn(
              `[hybrid-index-worker] enqueue_failed reason=upload_ready ` +
              `error_name=${error instanceof Error ? error.name : "unknown"}`
            );
            // The upload remains ready. Failing this BullMQ attempt gives the
            // enqueue path the configured retries instead of silently losing
            // the index refresh until the next Worker restart.
            throw error;
          }
        }
        return result;
      },
      {
        connection,
        concurrency: config.workerConcurrency,
        autorun: false,
        maxStalledCount: 2
      }
    );
  } catch (error) {
    await clearQueueWorkerStorageProbe({
      config,
      redis: connection,
      workerId: workerStorageSummary.workerId
    }).catch(() => undefined);
    connection.disconnect(false);
    throw error;
  }
  const failureReconciliations = new Set<Promise<void>>();

  const trackFailureReconciliation = (promise: Promise<void>) => {
    const tracked = promise
      .catch((error) => {
        console.error(
          `[pipeline-worker] terminal status reconciliation failed error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      })
      .finally(() => {
        failureReconciliations.delete(tracked);
      });
    failureReconciliations.add(tracked);
  };

  worker.on("active", (job) => {
    console.info(
      `[pipeline-worker] active queue_job_id=${job.id ?? "unknown"} attempt=${job.attemptsMade + 1}`
    );
  });
  worker.on("completed", (job, result) => {
    console.info(
      `[pipeline-worker] completed queue_job_id=${job.id ?? "unknown"} status=${result.status}`
    );
  });
  worker.on("failed", (job, error) => {
    console.error(
      `[pipeline-worker] failed queue_job_id=${job?.id ?? "unknown"} attempt=${Math.max(1, job?.attemptsMade ?? 1)} error_name=${error.name}`
    );
    if (!job) {
      return;
    }
    if (job.name !== PIPELINE_QUEUE_JOB_NAME) {
      return;
    }
    const maximumAttempts = Math.max(1, Math.floor(job.opts.attempts ?? 1));
    const terminal =
      error instanceof UnrecoverableError ||
      error.name === "UnrecoverableError" ||
      job.attemptsMade >= maximumAttempts;
    if (terminal) {
      trackFailureReconciliation(finalizePipelineQueueFailure(job.data));
    }
  });
  worker.on("error", (error) => {
    console.error(`[pipeline-worker] runtime error error_name=${error.name}`);
  });

  try {
    const runRecovery = () => recoverPipelineJobs({
      enqueue: (payload, enqueueOptions) =>
        enqueuePipelineJob(payload, {
          config,
          reviveTerminal: enqueueOptions.reviveTerminal
        }),
      staleAfterMs: config.processingStaleMs
    });
    const recovery = await runRecovery();
    const embeddingRecovery = !hybridIndexEnabled
      ? { total: 0, enqueued: 0, existing: 0 }
      : await enqueueAllUserEmbeddingIndexJobs({
          enqueue: (payload) => enqueueEmbeddingIndexJob(payload, { config })
        });
    console.info(
      `[pipeline-worker] ready queue=${config.queueName} redis=${sanitizedRedisEndpoint(config.redisUrl)} concurrency=${config.workerConcurrency} storage=${queueStorageMarkerFingerprint(workerStorageSummary.storageId)} recovered_enqueued=${recovery.enqueued} recovered_existing=${recovery.existing}`
    );
    console.info(
      `[hybrid-index-worker] startup users=${embeddingRecovery.total} ` +
      `enqueued=${embeddingRecovery.enqueued} coalesced=${embeddingRecovery.existing}`
    );
    const runPromise = worker.run();
    const periodicEmbeddingRecovery = startPeriodicEmbeddingIndexRecovery({
      enabled: hybridIndexEnabled,
      intervalMs: config.hybridIndexRecoveryIntervalMs,
      run: () => enqueueAllUserEmbeddingIndexJobs({
        enqueue: (payload) => enqueueEmbeddingIndexJob(payload, { config })
      }),
      onReport: (report) => {
        console.info(
          `[hybrid-index-worker] recovery users=${report.total} ` +
          `enqueued=${report.enqueued} coalesced=${report.existing}`
        );
      },
      onError: (error) => {
        console.error(
          `[hybrid-index-worker] periodic recovery failed ` +
          `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      }
    });
    let periodicRecovery: Promise<void> | null = null;
    const recoveryTimer = setInterval(() => {
      if (periodicRecovery) return;
      periodicRecovery = runRecovery()
        .then((report) => {
          console.info(
            `[pipeline-worker] recovery users=${report.usersScanned} jobs=${report.jobsScanned} enqueued=${report.enqueued} existing=${report.existing} queue_unavailable=${report.queueUnavailableRecovered}`
          );
        })
        .catch((error: unknown) => {
          console.error(
            `[pipeline-worker] periodic recovery failed error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        })
        .finally(() => {
          periodicRecovery = null;
        });
    }, config.recoveryIntervalMs);
    recoveryTimer.unref();
    let closePromise: Promise<void> | undefined;
    return {
      recovery,
      runPromise,
      close() {
        closePromise ??= (async () => {
          console.info("[pipeline-worker] shutdown started");
          clearInterval(recoveryTimer);
          await periodicEmbeddingRecovery.close();
          await worker.close();
          await runPromise.catch(() => undefined);
          await periodicRecovery?.catch(() => undefined);
          await Promise.allSettled(Array.from(failureReconciliations));
          await clearQueueWorkerStorageProbe({
            config,
            redis: connection,
            workerId: workerStorageSummary.workerId
          }).catch(() => undefined);
          try {
            await connection.quit();
          } catch {
            connection.disconnect(false);
          }
          console.info("[pipeline-worker] shutdown completed");
        })();
        return closePromise;
      }
    };
  } catch (error) {
    await worker.close(true).catch(() => undefined);
    await clearQueueWorkerStorageProbe({
      config,
      redis: connection,
      workerId: workerStorageSummary.workerId
    }).catch(() => undefined);
    connection.disconnect(false);
    throw error;
  }
}
