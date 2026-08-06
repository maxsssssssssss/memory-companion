// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PipelineQueueConfig } from "./config";
import {
  ensureQueueStorageMarker,
  inspectQueueStorageProbe,
  publishQueueWorkerStorageProbe,
  queueWorkerStorageProbeKey
} from "./storage-probe";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(dataDirectory: string): PipelineQueueConfig {
  return {
    executionMode: "queue",
    redisUrl: "redis://127.0.0.1:6380",
    queueName: "probe-test",
    workerConcurrency: 1,
    attempts: 3,
    backoffMs: 5_000,
    processingStaleMs: 60_000,
    recoveryIntervalMs: 60_000,
    hybridIndexRecoveryIntervalMs: 900_000,
    failedHealthWindowMs: 60_000,
    retention: {
      completed: { age: 3_600, count: 10 },
      failed: { age: 7_200, count: 20 }
    },
    dataDirectory,
    storageMode: "server"
  };
}

describe("queue shared-storage probe", () => {
  it("persists one marker and matches the Worker summary through Redis", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-storage-probe-"));
    roots.push(root);
    const values = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      del: vi.fn(async (key: string) => values.delete(key) ? 1 : 0)
    };
    const queueConfig = config(root);

    const first = await ensureQueueStorageMarker(root, {
      storageId: () => "storage_marker_one",
      now: () => "2026-08-05T00:00:00.000Z"
    });
    const second = await ensureQueueStorageMarker(root, {
      storageId: () => "storage_marker_two"
    });
    expect(second.storageId).toBe(first.storageId);

    await publishQueueWorkerStorageProbe({
      config: queueConfig,
      redis,
      workerId: "worker_one",
      now: () => "2026-08-05T00:00:01.000Z"
    });
    await expect(inspectQueueStorageProbe({ config: queueConfig, redis })).resolves.toMatchObject({
      status: "matched",
      workerId: "worker_one"
    });
    expect(values.has(queueWorkerStorageProbeKey(queueConfig.queueName))).toBe(true);
  });

  it("fails the comparison when Web and Worker use different data roots", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "queue-storage-web-"));
    const workerRoot = await mkdtemp(join(tmpdir(), "queue-storage-worker-"));
    roots.push(webRoot, workerRoot);
    const values = new Map<string, string>();
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => { values.set(key, value); },
      del: async (key: string) => values.delete(key) ? 1 : 0
    };
    await publishQueueWorkerStorageProbe({
      config: config(workerRoot),
      redis,
      workerId: "worker_other"
    });

    await expect(inspectQueueStorageProbe({
      config: config(webRoot),
      redis
    })).resolves.toMatchObject({ status: "storage_mismatch" });
  });
});
