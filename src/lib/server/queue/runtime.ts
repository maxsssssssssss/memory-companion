import { UnrecoverableError, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { appStore } from "@/lib/server/storage/json-store";
import { getPipelineQueueConfig, sanitizedRedisEndpoint } from "./config";
import {
  enqueueDailyReflectionJob,
  enqueueEmbeddingIndexJob,
  enqueuePipelineJob
} from "./producer";
import {
  recoverDailyReflectionJobs,
  type DailyReflectionRecoveryReport
} from "./daily-reflection-recovery";
import { recoverPipelineJobs, type PipelineRecoveryReport } from "./recovery";
import {
  processEmbeddingIndexJob,
  type EmbeddingIndexWorkerResult
} from "./embedding-index-worker";
import {
  processDailyReflectionJob,
  type DailyReflectionQueueWorkerResult
} from "./daily-reflection-worker";
import {
  finalizePipelineQueueFailure,
  processPipelineJob,
  type PipelineWorkerResult
} from "./worker";
import {
  DAILY_REFLECTION_QUEUE_JOB_NAME,
  EMBEDDING_INDEX_QUEUE_JOB_NAME,
  PIPELINE_QUEUE_JOB_NAME,
  type DailyBriefQueueJobData,
  type DailyReflectionQueuePayload,
  type PipelineJobData
} from "./types";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";
import { resolveQaHybridRetrievalMode } from "@/lib/server/retrieval/hybrid/runtime-config";
import {
  clearQueueWorkerStorageProbe,
  publishQueueWorkerStorageProbe,
  queueStorageMarkerFingerprint
} from "./storage-probe";

export type PipelineWorkerRuntime = {
  recovery: PipelineRecoveryReport;
  dailyReflectionRecovery: DailyReflectionRecoveryReport;
  runPromise: Promise<void>;
  close(): Promise<void>;
};

export async function startPipelineWorker(): Promise<PipelineWorkerRuntime> {
  const config = getPipelineQueueConfig();
  if (config.executionMode !== "queue") {
    throw new Error("daily-brief-worker requires PIPELINE_EXECUTION_MODE=queue");
  }

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

  type QueueWorkerResult =
    | PipelineWorkerResult
    | DailyReflectionQueueWorkerResult
    | EmbeddingIndexWorkerResult;
  let worker: Worker<DailyBriefQueueJobData, QueueWorkerResult>;
  try {
    worker = new Worker<DailyBriefQueueJobData, QueueWorkerResult>(
      config.queueName,
      async (job: Job<DailyBriefQueueJobData>) => {
        if (job.name === EMBEDDING_INDEX_QUEUE_JOB_NAME) {
          return processEmbeddingIndexJob(job);
        }
        if (job.name === DAILY_REFLECTION_QUEUE_JOB_NAME) {
          if (!isDailyReflectionUploadEnabled()) {
            throw new UnrecoverableError("Daily Reflection upload is disabled");
          }
          const result = await processDailyReflectionJob(
            job as Job<DailyReflectionQueuePayload>
          );
          if (result.status === "failed") {
            throw new UnrecoverableError(
              `Daily Reflection staging failed for ${result.reflectionId}`
            );
          }
          return result;
        }
        if (job.name !== PIPELINE_QUEUE_JOB_NAME) {
          throw new UnrecoverableError(`Unknown queue job name ${job.name}`);
        }
        const result = await processPipelineJob(job as Job<PipelineJobData>);
        if (result.status === "failed") {
          throw new UnrecoverableError(`Pipeline input is unavailable for upload ${result.uploadId}`);
        }
        if (result.status === "ready" && resolveQaHybridRetrievalMode() !== "off") {
          await enqueueEmbeddingIndexJob({
            version: 1,
            userRef: job.data.userRef,
            reason: "upload_ready"
          }, { config }).catch((error: unknown) => {
            console.warn(
              `[hybrid-index-worker] enqueue_failed reason=upload_ready ` +
              `error_name=${error instanceof Error ? error.name : "unknown"}`
            );
          });
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
    const runDailyReflectionRecovery = () => recoverDailyReflectionJobs({
      enqueue: (payload, enqueueOptions) =>
        enqueueDailyReflectionJob(payload, {
          config,
          reviveTerminal: enqueueOptions.reviveTerminal
        }),
      staleAfterMs: config.processingStaleMs
    });
    const recovery = await runRecovery();
    const dailyReflectionRecovery = isDailyReflectionUploadEnabled()
      ? await runDailyReflectionRecovery()
      : {
          workflowsScanned: 0,
          enqueued: 0,
          existing: 0,
          freshActiveSkipped: 0,
          missingUploadFailed: 0,
          missingPlanFailed: 0,
          racesSkipped: 0,
          provisionalCleaned: 0
        };
    let embeddingIndexEnqueued = 0;
    let embeddingIndexExisting = 0;
    if (resolveQaHybridRetrievalMode() !== "off") {
      const users = await appStore.list<{ id?: string }>("users");
      for (const record of users) {
        const userRef =
          typeof record.value.id === "string" && record.value.id.trim()
            ? record.value.id
            : record.id;
        try {
          const result = await enqueueEmbeddingIndexJob({
            version: 1,
            userRef,
            reason: "startup"
          }, { config });
          if (result.enqueued) embeddingIndexEnqueued += 1;
          else embeddingIndexExisting += 1;
        } catch (error) {
          console.warn(
            `[hybrid-index-worker] enqueue_failed reason=startup ` +
            `error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        }
      }
    }
    console.info(
      `[pipeline-worker] ready queue=${config.queueName} redis=${sanitizedRedisEndpoint(config.redisUrl)} concurrency=${config.workerConcurrency} storage=${queueStorageMarkerFingerprint(workerStorageSummary.storageId)} recovered_enqueued=${recovery.enqueued} recovered_existing=${recovery.existing}`
    );
    console.info(
      `[daily-reflection-worker] recovery workflows=${dailyReflectionRecovery.workflowsScanned} ` +
      `enqueued=${dailyReflectionRecovery.enqueued} existing=${dailyReflectionRecovery.existing}`
    );
    console.info(
      `[hybrid-index-worker] startup users_enqueued=${embeddingIndexEnqueued} ` +
      `users_existing=${embeddingIndexExisting}`
    );
    const runPromise = worker.run();
    let periodicRecovery: Promise<void> | null = null;
    const recoveryTimer = setInterval(() => {
      if (periodicRecovery) return;
      periodicRecovery = runRecovery()
        .then(async (report) => {
          console.info(
            `[pipeline-worker] recovery users=${report.usersScanned} jobs=${report.jobsScanned} enqueued=${report.enqueued} existing=${report.existing} queue_unavailable=${report.queueUnavailableRecovered}`
          );
          if (isDailyReflectionUploadEnabled()) {
            const dailyReflectionReport = await runDailyReflectionRecovery();
            console.info(
              `[daily-reflection-worker] recovery workflows=${dailyReflectionReport.workflowsScanned} ` +
              `enqueued=${dailyReflectionReport.enqueued} existing=${dailyReflectionReport.existing}`
            );
          }
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
      dailyReflectionRecovery,
      runPromise,
      close() {
        closePromise ??= (async () => {
          console.info("[pipeline-worker] shutdown started");
          clearInterval(recoveryTimer);
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
