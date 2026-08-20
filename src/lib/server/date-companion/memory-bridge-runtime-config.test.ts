// @vitest-environment node

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  dateCompanionMemoryBridgeRuntimeDefaults,
  getDateCompanionMemoryBridgeRuntimeConfig,
  isDateCompanionMemoryBridgeConsumerEnabled
} from "./memory-bridge-runtime-config";

describe("Date Companion Memory Bridge runtime configuration", () => {
  it("is disabled by default with bounded conservative values", () => {
    expect(getDateCompanionMemoryBridgeRuntimeConfig({})).toEqual({
      enabled: false,
      dataDirectory: resolve(".data"),
      pollIntervalMs: 5_000,
      batchSize: 10,
      leaseMs: 300_000,
      retryBaseMs: 5_000,
      retryMaxMs: 300_000,
      shutdownDrainTimeoutMs: 30_000,
      oldestPendingHealthMs: 900_000,
      failedCountThreshold: 10
    });
    expect(dateCompanionMemoryBridgeRuntimeDefaults.enabled).toBe(false);
    expect(isDateCompanionMemoryBridgeConsumerEnabled({})).toBe(false);
  });

  it("requires an explicit strict boolean", () => {
    expect(getDateCompanionMemoryBridgeRuntimeConfig({
      DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: " FALSE "
    }).enabled).toBe(false);
    expect(() => getDateCompanionMemoryBridgeRuntimeConfig({
      DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "yes"
    })).toThrow("must be true or false");
  });

  it("requires enabled consumers to use the existing one-Worker queue contract", () => {
    const dataDirectory = resolve("bridge-runtime-data");
    expect(getDateCompanionMemoryBridgeRuntimeConfig({
      DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "true",
      PIPELINE_EXECUTION_MODE: "queue",
      PIPELINE_WORKER_CONCURRENCY: "1",
      APP_DATA_DIR: dataDirectory,
      APP_STORAGE_MODE: "server"
    })).toMatchObject({ enabled: true, dataDirectory });

    expect(() => getDateCompanionMemoryBridgeRuntimeConfig({
      DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "true",
      PIPELINE_EXECUTION_MODE: "inline"
    })).toThrow("requires PIPELINE_EXECUTION_MODE=queue");
    expect(() => getDateCompanionMemoryBridgeRuntimeConfig({
      DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "true",
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: ".data",
      APP_STORAGE_MODE: "server"
    })).toThrow("absolute path");
    expect(() => getDateCompanionMemoryBridgeRuntimeConfig({
      NODE_ENV: "production",
      DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "true",
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: dataDirectory,
      APP_STORAGE_MODE: "server"
    })).toThrow("app_data_dir_must_be_outside_release");
  });

  it.each([
    ["DATE_COMPANION_MEMORY_BRIDGE_POLL_INTERVAL_MS", "999"],
    ["DATE_COMPANION_MEMORY_BRIDGE_BATCH_SIZE", "101"],
    ["DATE_COMPANION_MEMORY_BRIDGE_LEASE_MS", "29999"],
    ["DATE_COMPANION_MEMORY_BRIDGE_RETRY_BASE_MS", "999"],
    ["DATE_COMPANION_MEMORY_BRIDGE_RETRY_MAX_MS", "3600001"],
    ["DATE_COMPANION_MEMORY_BRIDGE_SHUTDOWN_DRAIN_TIMEOUT_MS", "999"],
    ["DATE_COMPANION_MEMORY_BRIDGE_OLDEST_PENDING_HEALTH_MS", "59999"],
    ["DATE_COMPANION_MEMORY_BRIDGE_FAILED_COUNT_THRESHOLD", "0"]
  ])("rejects unsafe %s=%s even while disabled", (name, value) => {
    expect(() => getDateCompanionMemoryBridgeRuntimeConfig({
      [name]: value
    })).toThrow(name);
  });

  it("rejects malformed integers and retry maxima below the base", () => {
    expect(() => getDateCompanionMemoryBridgeRuntimeConfig({
      DATE_COMPANION_MEMORY_BRIDGE_BATCH_SIZE: "2.5"
    })).toThrow("DATE_COMPANION_MEMORY_BRIDGE_BATCH_SIZE");
    expect(() => getDateCompanionMemoryBridgeRuntimeConfig({
      DATE_COMPANION_MEMORY_BRIDGE_RETRY_BASE_MS: "6000",
      DATE_COMPANION_MEMORY_BRIDGE_RETRY_MAX_MS: "5000"
    })).toThrow("must be greater than or equal");
  });

  it("accepts the documented safe custom values", () => {
    expect(getDateCompanionMemoryBridgeRuntimeConfig({
      DATE_COMPANION_MEMORY_BRIDGE_POLL_INTERVAL_MS: "60000",
      DATE_COMPANION_MEMORY_BRIDGE_BATCH_SIZE: "25",
      DATE_COMPANION_MEMORY_BRIDGE_LEASE_MS: "600000",
      DATE_COMPANION_MEMORY_BRIDGE_RETRY_BASE_MS: "10000",
      DATE_COMPANION_MEMORY_BRIDGE_RETRY_MAX_MS: "900000",
      DATE_COMPANION_MEMORY_BRIDGE_SHUTDOWN_DRAIN_TIMEOUT_MS: "60000",
      DATE_COMPANION_MEMORY_BRIDGE_OLDEST_PENDING_HEALTH_MS: "3600000",
      DATE_COMPANION_MEMORY_BRIDGE_FAILED_COUNT_THRESHOLD: "50"
    })).toMatchObject({
      pollIntervalMs: 60_000,
      batchSize: 25,
      leaseMs: 600_000,
      retryBaseMs: 10_000,
      retryMaxMs: 900_000,
      shutdownDrainTimeoutMs: 60_000,
      oldestPendingHealthMs: 3_600_000,
      failedCountThreshold: 50
    });
  });
});
