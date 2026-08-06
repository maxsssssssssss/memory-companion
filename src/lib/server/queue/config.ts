import { resolve } from "node:path";

import {
  getDataRootDir,
  getStorageMode,
  requireQueueStorageConfiguration,
  type StorageMode
} from "@/lib/server/storage/paths";

export type PipelineExecutionMode = "inline" | "queue";

export type PipelineQueueRetention = {
  completed: { age: number; count: number };
  failed: { age: number; count: number };
};

export type PipelineQueueConfig = {
  executionMode: PipelineExecutionMode;
  redisUrl: string;
  queueName: string;
  workerConcurrency: number;
  attempts: number;
  backoffMs: number;
  processingStaleMs: number;
  recoveryIntervalMs: number;
  failedHealthWindowMs: number;
  retention: PipelineQueueRetention;
  dataDirectory: string;
  storageMode: StorageMode;
};

const DEFAULTS = {
  redisUrl: "redis://127.0.0.1:6380",
  queueName: "daily-brief-pipeline",
  workerConcurrency: 1,
  attempts: 3,
  backoffMs: 5_000,
  processingStaleMs: 2 * 60 * 60 * 1_000,
  recoveryIntervalMs: 60_000,
  failedHealthWindowMs: 60 * 60 * 1_000,
  completedRetentionAgeSeconds: 24 * 60 * 60,
  completedRetentionCount: 1_000,
  failedRetentionAgeSeconds: 7 * 24 * 60 * 60,
  failedRetentionCount: 1_000
} as const;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (!value?.trim()) {
    return fallback;
  }
  if (!/^\d+$/u.test(value.trim())) {
    throw new Error(`Queue integer configuration must be between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Queue integer configuration must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function resolvePipelineExecutionMode(value = process.env.PIPELINE_EXECUTION_MODE): PipelineExecutionMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "inline") {
    return "inline";
  }
  if (normalized === "queue") {
    return "queue";
  }
  throw new Error("PIPELINE_EXECUTION_MODE must be inline or queue");
}

function resolveRedisUrl(value: string | undefined) {
  const redisUrl = value?.trim() || DEFAULTS.redisUrl;
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  if ((parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") || !parsed.hostname) {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  return redisUrl;
}

export function getPipelineQueueConfig(
  env: Record<string, string | undefined> = process.env
): PipelineQueueConfig {
  const executionMode = resolvePipelineExecutionMode(env.PIPELINE_EXECUTION_MODE);
  const queueName = env.PIPELINE_QUEUE_NAME?.trim() || DEFAULTS.queueName;
  if (!/^[A-Za-z0-9_-]+$/u.test(queueName)) {
    throw new Error("PIPELINE_QUEUE_NAME may contain only letters, numbers, underscores, and hyphens");
  }

  const workerConcurrency = boundedInteger(
    env.PIPELINE_WORKER_CONCURRENCY,
    DEFAULTS.workerConcurrency,
    1,
    16
  );
  if (executionMode === "queue" && workerConcurrency !== 1) {
    throw new Error("Queue mode currently requires PIPELINE_WORKER_CONCURRENCY=1");
  }
  const storage = executionMode === "queue"
    ? requireQueueStorageConfiguration(env)
    : {
        dataDirectory: resolve(getDataRootDir(env)),
        storageMode: getStorageMode(env)
      };

  return {
    executionMode,
    redisUrl: resolveRedisUrl(env.REDIS_URL),
    queueName,
    workerConcurrency,
    attempts: boundedInteger(env.PIPELINE_JOB_ATTEMPTS, DEFAULTS.attempts, 1, 10),
    backoffMs: boundedInteger(env.PIPELINE_JOB_BACKOFF_MS, DEFAULTS.backoffMs, 0, 60 * 60 * 1_000),
    processingStaleMs: boundedInteger(
      env.PIPELINE_PROCESSING_STALE_MS,
      DEFAULTS.processingStaleMs,
      60_000,
      24 * 60 * 60 * 1_000
    ),
    recoveryIntervalMs: boundedInteger(
      env.PIPELINE_RECOVERY_INTERVAL_MS,
      DEFAULTS.recoveryIntervalMs,
      10_000,
      60 * 60 * 1_000
    ),
    failedHealthWindowMs: boundedInteger(
      env.PIPELINE_FAILED_HEALTH_WINDOW_MS,
      DEFAULTS.failedHealthWindowMs,
      60_000,
      7 * 24 * 60 * 60 * 1_000
    ),
    retention: {
      completed: {
        age: boundedInteger(
          env.PIPELINE_COMPLETED_RETENTION_AGE_SECONDS,
          DEFAULTS.completedRetentionAgeSeconds,
          60,
          30 * 24 * 60 * 60
        ),
        count: boundedInteger(
          env.PIPELINE_COMPLETED_RETENTION_COUNT,
          DEFAULTS.completedRetentionCount,
          1,
          100_000
        )
      },
      failed: {
        age: boundedInteger(
          env.PIPELINE_FAILED_RETENTION_AGE_SECONDS,
          DEFAULTS.failedRetentionAgeSeconds,
          60,
          90 * 24 * 60 * 60
        ),
        count: boundedInteger(
          env.PIPELINE_FAILED_RETENTION_COUNT,
          DEFAULTS.failedRetentionCount,
          1,
          100_000
        )
      }
    },
    ...storage
  };
}

export const readPipelineQueueConfig = getPipelineQueueConfig;

export function sanitizedRedisEndpoint(redisUrl: string) {
  const parsed = new URL(resolveRedisUrl(redisUrl));
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}
