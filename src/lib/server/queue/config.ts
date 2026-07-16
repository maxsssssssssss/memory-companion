export type PipelineExecutionMode = "inline" | "queue";

export type PipelineQueueConfig = {
  executionMode: PipelineExecutionMode;
  redisUrl: string;
  queueName: string;
  workerConcurrency: number;
  attempts: number;
  backoffMs: number;
  processingStaleMs: number;
};

const DEFAULTS = {
  redisUrl: "redis://127.0.0.1:6379",
  queueName: "daily-brief-pipeline",
  workerConcurrency: 1,
  attempts: 3,
  backoffMs: 5_000,
  processingStaleMs: 2 * 60 * 60 * 1_000
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
  const queueName = env.PIPELINE_QUEUE_NAME?.trim() || DEFAULTS.queueName;
  if (!/^[A-Za-z0-9_-]+$/u.test(queueName)) {
    throw new Error("PIPELINE_QUEUE_NAME may contain only letters, numbers, underscores, and hyphens");
  }

  return {
    executionMode: resolvePipelineExecutionMode(env.PIPELINE_EXECUTION_MODE),
    redisUrl: resolveRedisUrl(env.REDIS_URL),
    queueName,
    workerConcurrency: boundedInteger(env.PIPELINE_WORKER_CONCURRENCY, DEFAULTS.workerConcurrency, 1, 16),
    attempts: boundedInteger(env.PIPELINE_JOB_ATTEMPTS, DEFAULTS.attempts, 1, 10),
    backoffMs: boundedInteger(env.PIPELINE_JOB_BACKOFF_MS, DEFAULTS.backoffMs, 0, 60 * 60 * 1_000),
    processingStaleMs: boundedInteger(
      env.PIPELINE_PROCESSING_STALE_MS,
      DEFAULTS.processingStaleMs,
      60_000,
      24 * 60 * 60 * 1_000
    )
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
