import { resolve } from "node:path";

import { getPipelineQueueConfig } from "@/lib/server/queue/config";
import { getDataRootDir } from "@/lib/server/storage/paths";
import { resolveDateCompanionMemoryBridgePreflightDataDirectory } from "./memory-bridge-preflight";

const DEFAULTS = {
  enabled: false,
  pollIntervalMs: 5_000,
  batchSize: 10,
  leaseMs: 5 * 60_000,
  retryBaseMs: 5_000,
  retryMaxMs: 5 * 60_000,
  shutdownDrainTimeoutMs: 30_000,
  oldestPendingHealthMs: 15 * 60_000,
  failedCountThreshold: 10
} as const;

export type DateCompanionMemoryBridgeRuntimeConfig = {
  enabled: boolean;
  dataDirectory: string;
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  shutdownDrainTimeoutMs: number;
  oldestPendingHealthMs: number;
  failedCountThreshold: number;
};

function strictBoolean(name: string, value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function getDateCompanionMemoryBridgeRuntimeConfig(
  env: Record<string, string | undefined> = process.env
): DateCompanionMemoryBridgeRuntimeConfig {
  const enabled = strictBoolean(
    "DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED",
    env.DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED,
    DEFAULTS.enabled
  );
  const retryBaseMs = boundedInteger(
    "DATE_COMPANION_MEMORY_BRIDGE_RETRY_BASE_MS",
    env.DATE_COMPANION_MEMORY_BRIDGE_RETRY_BASE_MS,
    DEFAULTS.retryBaseMs,
    1_000,
    5 * 60_000
  );
  const retryMaxMs = boundedInteger(
    "DATE_COMPANION_MEMORY_BRIDGE_RETRY_MAX_MS",
    env.DATE_COMPANION_MEMORY_BRIDGE_RETRY_MAX_MS,
    DEFAULTS.retryMaxMs,
    1_000,
    60 * 60_000
  );
  if (retryMaxMs < retryBaseMs) {
    throw new Error(
      "DATE_COMPANION_MEMORY_BRIDGE_RETRY_MAX_MS must be greater than or equal to DATE_COMPANION_MEMORY_BRIDGE_RETRY_BASE_MS"
    );
  }

  let dataDirectory = resolve(getDataRootDir(env));
  if (enabled) {
    const pipeline = getPipelineQueueConfig(env);
    if (pipeline.executionMode !== "queue") {
      throw new Error(
        "DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED=true requires PIPELINE_EXECUTION_MODE=queue"
      );
    }
    dataDirectory = resolveDateCompanionMemoryBridgePreflightDataDirectory(env);
    if (dataDirectory !== pipeline.dataDirectory) {
      throw new Error("Date Companion Memory Bridge storage configuration is inconsistent");
    }
  }

  return {
    enabled,
    dataDirectory,
    pollIntervalMs: boundedInteger(
      "DATE_COMPANION_MEMORY_BRIDGE_POLL_INTERVAL_MS",
      env.DATE_COMPANION_MEMORY_BRIDGE_POLL_INTERVAL_MS,
      DEFAULTS.pollIntervalMs,
      1_000,
      5 * 60_000
    ),
    batchSize: boundedInteger(
      "DATE_COMPANION_MEMORY_BRIDGE_BATCH_SIZE",
      env.DATE_COMPANION_MEMORY_BRIDGE_BATCH_SIZE,
      DEFAULTS.batchSize,
      1,
      100
    ),
    leaseMs: boundedInteger(
      "DATE_COMPANION_MEMORY_BRIDGE_LEASE_MS",
      env.DATE_COMPANION_MEMORY_BRIDGE_LEASE_MS,
      DEFAULTS.leaseMs,
      30_000,
      60 * 60_000
    ),
    retryBaseMs,
    retryMaxMs,
    shutdownDrainTimeoutMs: boundedInteger(
      "DATE_COMPANION_MEMORY_BRIDGE_SHUTDOWN_DRAIN_TIMEOUT_MS",
      env.DATE_COMPANION_MEMORY_BRIDGE_SHUTDOWN_DRAIN_TIMEOUT_MS,
      DEFAULTS.shutdownDrainTimeoutMs,
      1_000,
      2 * 60_000
    ),
    oldestPendingHealthMs: boundedInteger(
      "DATE_COMPANION_MEMORY_BRIDGE_OLDEST_PENDING_HEALTH_MS",
      env.DATE_COMPANION_MEMORY_BRIDGE_OLDEST_PENDING_HEALTH_MS,
      DEFAULTS.oldestPendingHealthMs,
      60_000,
      7 * 24 * 60 * 60_000
    ),
    failedCountThreshold: boundedInteger(
      "DATE_COMPANION_MEMORY_BRIDGE_FAILED_COUNT_THRESHOLD",
      env.DATE_COMPANION_MEMORY_BRIDGE_FAILED_COUNT_THRESHOLD,
      DEFAULTS.failedCountThreshold,
      1,
      100_000
    )
  };
}

export function isDateCompanionMemoryBridgeConsumerEnabled(
  env: Record<string, string | undefined> = process.env
) {
  return getDateCompanionMemoryBridgeRuntimeConfig(env).enabled;
}

export const dateCompanionMemoryBridgeRuntimeDefaults = { ...DEFAULTS } as const;
