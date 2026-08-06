import { UnrecoverableError, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { getPipelineQueueConfig, sanitizedRedisEndpoint } from "./config";
import { enqueuePipelineJob } from "./producer";
import { recoverPipelineJobs, type PipelineRecoveryReport } from "./recovery";
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
import type { PipelineJobData } from "./types";

export type PipelineWorkerRuntime = {
  recovery: PipelineRecoveryReport;
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

  let worker: Worker<PipelineJobData, PipelineWorkerResult>;
  try {
    worker = new Worker<PipelineJobData, PipelineWorkerResult>(
      config.queueName,
      async (job: Job<PipelineJobData>) => {
        const result = await processPipelineJob(job);
        if (result.status === "failed") {
          throw new UnrecoverableError(`Pipeline input is unavailable for upload ${result.uploadId}`);
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
    console.info(
      `[pipeline-worker] ready queue=${config.queueName} redis=${sanitizedRedisEndpoint(config.redisUrl)} concurrency=${config.workerConcurrency} storage=${queueStorageMarkerFingerprint(workerStorageSummary.storageId)} recovered_enqueued=${recovery.enqueued} recovered_existing=${recovery.existing}`
    );
    const runPromise = worker.run();
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
