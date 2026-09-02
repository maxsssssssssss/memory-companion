// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisConnect: vi.fn(),
  redisPing: vi.fn(),
  redisDisconnect: vi.fn(),
  redisQuit: vi.fn(),
  workerOn: vi.fn(),
  workerRun: vi.fn(),
  workerClose: vi.fn(),
  workerRunPromise: Promise.resolve() as Promise<void>,
  resolveWorkerRun: (() => undefined) as () => void,
  publishStorageProbe: vi.fn(),
  clearStorageProbe: vi.fn(),
  recoverPipelineJobs: vi.fn(),
  recoverDailyReflectionJobs: vi.fn(),
  runWorkReviewStartupRecovery: vi.fn()
}));

vi.mock("ioredis", () => ({
  default: class MockRedis {
    connect = mocks.redisConnect;
    ping = mocks.redisPing;
    disconnect = mocks.redisDisconnect;
    quit = mocks.redisQuit;
  }
}));

vi.mock("bullmq", () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
  Worker: class MockWorker {
    on = mocks.workerOn;

    run() {
      mocks.workerRun();
      return mocks.workerRunPromise;
    }

    async close(force?: boolean) {
      mocks.workerClose(force);
      mocks.resolveWorkerRun();
    }
  }
}));

vi.mock("@/lib/server/storage/json-store", () => ({
  appStore: { list: vi.fn().mockResolvedValue([]) }
}));

vi.mock("./config", () => ({
  getPipelineQueueConfig: () => ({
    executionMode: "queue",
    redisUrl: "redis://127.0.0.1:6380",
    queueName: "test-pipeline",
    workerConcurrency: 1,
    attempts: 3,
    backoffMs: 5_000,
    processingStaleMs: 120_000,
    recoveryIntervalMs: 60_000,
    failedHealthWindowMs: 3_600_000,
    retention: {
      completed: { age: 86_400, count: 1_000 },
      failed: { age: 604_800, count: 1_000 }
    },
    dataDirectory: "C:/data",
    storageMode: "server"
  }),
  sanitizedRedisEndpoint: () => "redis://127.0.0.1:6380"
}));

vi.mock("./producer", () => ({
  enqueueDailyReflectionJob: vi.fn(),
  enqueueEmbeddingIndexJob: vi.fn(),
  enqueuePipelineJob: vi.fn()
}));

vi.mock("./daily-reflection-recovery", () => ({
  recoverDailyReflectionJobs: mocks.recoverDailyReflectionJobs
}));

vi.mock("./recovery", () => ({
  recoverPipelineJobs: mocks.recoverPipelineJobs
}));

vi.mock("./embedding-index-worker", () => ({
  processEmbeddingIndexJob: vi.fn()
}));

vi.mock("./daily-reflection-worker", () => ({
  processDailyReflectionJob: vi.fn()
}));

vi.mock("./worker", () => ({
  finalizePipelineQueueFailure: vi.fn(),
  processPipelineJob: vi.fn()
}));

vi.mock("./storage-probe", () => ({
  clearQueueWorkerStorageProbe: mocks.clearStorageProbe,
  publishQueueWorkerStorageProbe: mocks.publishStorageProbe,
  queueStorageMarkerFingerprint: () => "storage-fingerprint"
}));

vi.mock("./work-review-recovery-runtime", () => ({
  runWorkReviewStartupRecovery: mocks.runWorkReviewStartupRecovery
}));

vi.mock("@/lib/server/daily-reflection/runtime-config", () => ({
  isDailyReflectionUploadEnabled: () => false
}));

vi.mock("@/lib/server/retrieval/hybrid/runtime-config", () => ({
  resolveQaHybridRetrievalMode: () => "off"
}));

import { startPipelineWorker } from "./runtime";

const PIPELINE_RECOVERY = {
  usersScanned: 0,
  jobsScanned: 0,
  enqueued: 0,
  existing: 0,
  readyReconciled: 0,
  missingAudioFailed: 0,
  queueUnavailableRecovered: 0,
  freshActiveSkipped: 0,
  terminalSkipped: 0,
  missingUploadsSkipped: 0
};

const WORK_RECOVERY = {
  selected: 0,
  completed: 0,
  recovered: 0,
  failed: 0,
  skippedBusy: 0,
  skippedChanged: 0,
  skippedDeleted: 0,
  errors: 0
};

describe("pipeline runtime Work Review startup recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerRunPromise = new Promise<void>((resolve) => {
      mocks.resolveWorkerRun = resolve;
    });
    mocks.redisConnect.mockResolvedValue(undefined);
    mocks.redisPing.mockResolvedValue("PONG");
    mocks.redisQuit.mockResolvedValue("OK");
    mocks.publishStorageProbe.mockResolvedValue({
      version: 1,
      queueName: "test-pipeline",
      storageId: "storage-id-123456789",
      workerId: "worker-id",
      startedAt: "2026-09-02T00:00:00.000Z"
    });
    mocks.clearStorageProbe.mockResolvedValue(undefined);
    mocks.recoverPipelineJobs.mockResolvedValue(PIPELINE_RECOVERY);
    mocks.recoverDailyReflectionJobs.mockResolvedValue({});
    mocks.runWorkReviewStartupRecovery.mockResolvedValue(WORK_RECOVERY);
  });

  it("runs Work recovery exactly once before accepting queue work", async () => {
    const runtime = await startPipelineWorker();

    expect(mocks.runWorkReviewStartupRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.workerRun).toHaveBeenCalledTimes(1);
    expect(mocks.runWorkReviewStartupRecovery.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.workerRun.mock.invocationCallOrder[0]);
    expect(runtime.workReviewRecovery).toBe(WORK_RECOVERY);

    await runtime.close();
    expect(mocks.workerClose).toHaveBeenCalledTimes(1);
    expect(mocks.clearStorageProbe).toHaveBeenCalledTimes(1);
    expect(mocks.redisQuit).toHaveBeenCalledTimes(1);
  });

  it("cleans Worker, storage probe and Redis when Work recovery rejects", async () => {
    const failure = new Error("work recovery unavailable");
    mocks.runWorkReviewStartupRecovery.mockRejectedValueOnce(failure);

    await expect(startPipelineWorker()).rejects.toBe(failure);

    expect(mocks.workerRun).not.toHaveBeenCalled();
    expect(mocks.workerClose).toHaveBeenCalledWith(true);
    expect(mocks.clearStorageProbe).toHaveBeenCalledTimes(1);
    expect(mocks.redisDisconnect).toHaveBeenCalledWith(false);
    expect(mocks.redisQuit).not.toHaveBeenCalled();
  });
});
