// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  getPipelineQueueConfig,
  resolvePipelineExecutionMode,
  sanitizedRedisEndpoint
} from "./config";

describe("pipeline queue configuration", () => {
  it("defaults to inline and the documented safe local values", () => {
    expect(getPipelineQueueConfig({})).toEqual({
      executionMode: "inline",
      redisUrl: "redis://127.0.0.1:6380",
      queueName: "daily-brief-pipeline",
      workerConcurrency: 1,
      attempts: 3,
      backoffMs: 5_000,
      processingStaleMs: 7_200_000,
      recoveryIntervalMs: 60_000,
      hybridIndexRecoveryIntervalMs: 900_000,
      failedHealthWindowMs: 3_600_000,
      retention: {
        completed: { age: 86_400, count: 1_000 },
        failed: { age: 604_800, count: 1_000 }
      },
      dataDirectory: resolve(".data"),
      storageMode: "local"
    });
  });

  it("requires explicit shared server storage and one Worker in queue mode", () => {
    const dataDirectory = resolve("queue-data");
    expect(getPipelineQueueConfig({
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: dataDirectory,
      APP_STORAGE_MODE: "server",
      PIPELINE_WORKER_CONCURRENCY: "1"
    })).toMatchObject({
      executionMode: "queue",
      dataDirectory,
      storageMode: "server",
      workerConcurrency: 1
    });

    expect(() => getPipelineQueueConfig({
      PIPELINE_EXECUTION_MODE: "queue",
      APP_STORAGE_MODE: "server"
    })).toThrow("absolute path");
    expect(() => getPipelineQueueConfig({
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: dataDirectory,
      APP_STORAGE_MODE: "local"
    })).toThrow("APP_STORAGE_MODE=server");
    expect(() => getPipelineQueueConfig({
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: dataDirectory,
      APP_STORAGE_MODE: "server",
      PIPELINE_WORKER_CONCURRENCY: "2"
    })).toThrow("PIPELINE_WORKER_CONCURRENCY=1");
  });

  it("fails closed when production queue mode has no explicit Redis URL", () => {
    const dataDirectory = resolve("queue-data");
    expect(() => getPipelineQueueConfig({
      NODE_ENV: "production",
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: dataDirectory,
      APP_STORAGE_MODE: "server"
    })).toThrow("Production queue mode requires REDIS_URL");

    expect(getPipelineQueueConfig({
      NODE_ENV: "production",
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: dataDirectory,
      APP_STORAGE_MODE: "server",
      REDIS_URL: "redis://127.0.0.1:6381"
    })).toMatchObject({
      executionMode: "queue",
      redisUrl: "redis://127.0.0.1:6381"
    });
  });

  it("rejects unknown modes instead of silently falling back inline", () => {
    expect(resolvePipelineExecutionMode("queue")).toBe("queue");
    expect(() => resolvePipelineExecutionMode("worker")).toThrow(
      "PIPELINE_EXECUTION_MODE must be inline or queue"
    );
  });

  it("uses a configurable low-frequency Hybrid recovery interval", () => {
    expect(getPipelineQueueConfig({
      HYBRID_INDEX_RECOVERY_INTERVAL_MS: "1200000"
    }).hybridIndexRecoveryIntervalMs).toBe(1_200_000);
    expect(() => getPipelineQueueConfig({
      HYBRID_INDEX_RECOVERY_INTERVAL_MS: "60000"
    })).toThrow("between 300000 and 86400000");
  });

  it("never exposes Redis credentials in the health endpoint", () => {
    expect(sanitizedRedisEndpoint("rediss://queue-user:secret@redis.internal:6380/2?x=1")).toBe(
      "rediss://redis.internal:6380/2"
    );
  });
});
