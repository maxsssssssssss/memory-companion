import { UnrecoverableError, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { getPipelineQueueConfig, sanitizedRedisEndpoint } from "./config";
import { enqueuePipelineJob } from "./producer";
import { recoverPipelineJobs, type PipelineRecoveryReport } from "./recovery";
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
  await connection.connect();
  await connection.ping();

  const worker = new Worker<PipelineJobData, PipelineWorkerResult>(
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
    const recovery = await recoverPipelineJobs({
      enqueue: (payload, enqueueOptions) =>
        enqueuePipelineJob(payload, {
          config,
          reviveTerminal: enqueueOptions.reviveTerminal
        }),
      staleAfterMs: config.processingStaleMs
    });
    console.info(
      `[pipeline-worker] ready queue=${config.queueName} redis=${sanitizedRedisEndpoint(config.redisUrl)} concurrency=${config.workerConcurrency} recovered_enqueued=${recovery.enqueued} recovered_existing=${recovery.existing}`
    );
    const runPromise = worker.run();
    let closePromise: Promise<void> | undefined;
    return {
      recovery,
      runPromise,
      close() {
        closePromise ??= (async () => {
          console.info("[pipeline-worker] shutdown started");
          await worker.close();
          await runPromise.catch(() => undefined);
          await Promise.allSettled(Array.from(failureReconciliations));
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
    connection.disconnect(false);
    throw error;
  }
}
