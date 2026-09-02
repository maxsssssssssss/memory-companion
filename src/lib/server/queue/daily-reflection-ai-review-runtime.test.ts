// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { PipelineQueueConfig } from "./config";
import {
  DAILY_REFLECTION_AI_REVIEW_MAX_STALLED_COUNT,
  startDailyReflectionAiReviewRuntime,
  type DailyReflectionAiReviewRuntimeDependencies
} from "./daily-reflection-ai-review-runtime";

const config: PipelineQueueConfig = {
  redisUrl: "redis://127.0.0.1:6379",
  queueName: "daily-brief-test",
  executionMode: "queue",
  attempts: 3,
  backoffMs: 1_000,
  workerConcurrency: 1,
  processingStaleMs: 60_000,
  recoveryIntervalMs: 60_000,
  failedHealthWindowMs: 60_000,
  retention: {
    completed: { age: 3_600, count: 10 },
    failed: { age: 3_600, count: 10 }
  },
  dataDirectory: "C:\\tmp\\daily-brief-test",
  storageMode: "server"
};

function createHarness(input: {
  mode?: "off" | "shadow" | "on";
  recovered?: Array<{ accountId: string; reviewId: string }>;
  existingJob?: boolean;
  existingState?: string;
  processStatus?: string;
} = {}) {
  let processor: Parameters<
    DailyReflectionAiReviewRuntimeDependencies["createWorker"]
  >[3] | undefined;
  let resolveRun: (() => void) | undefined;
  const runPromise = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  const add = vi.fn(async () => ({ id: "job" }));
  const removeExisting = vi.fn(async () => undefined);
  const getJob = vi.fn(async () => input.existingJob ? {
    getState: vi.fn(async () => input.existingState ?? "waiting"),
    remove: removeExisting
  } : null);
  const process = vi.fn(async () => ({ status: input.processStatus ?? "ready" }));
  const recover = vi.fn(() => ({
    returnedToQueue: 0,
    providerOutcomeUnknown: 0,
    queued: input.recovered ?? []
  }));
  const createRedis = vi.fn(() => ({
    connect: vi.fn(async () => undefined),
    ping: vi.fn(async () => "PONG"),
    get: vi.fn(async () => null),
    quit: vi.fn(async () => undefined),
    disconnect: vi.fn()
  }));
  const closeWorker = vi.fn(async () => {
    resolveRun?.();
  });
  let intervalHandler: (() => void) | undefined;
  const intervalHandle = {
    unref: vi.fn()
  } as unknown as ReturnType<typeof setInterval>;
  const dependencies: Partial<DailyReflectionAiReviewRuntimeDependencies> = {
    mode: () => input.mode ?? "on",
    createRedis,
    createQueue: () => ({
      waitUntilReady: vi.fn(async () => undefined),
      getJob,
      add,
      getJobCounts: vi.fn(async () => ({ waiting: 2, active: 1, failed: 0 })),
      getWorkersCount: vi.fn(async () => 1),
      close: vi.fn(async () => undefined)
    }),
    createWorker: (_config, _connection, _queueName, jobProcessor) => {
      processor = jobProcessor;
      return {
        on: vi.fn(),
        run: vi.fn(() => runPromise),
        close: closeWorker
      };
    },
    verifyStorage: vi.fn(async () => undefined),
    createService: () => ({
      recover,
      process
    }),
    workerId: () => "worker_test",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    setInterval: vi.fn((handler) => {
      intervalHandler = handler;
      return intervalHandle;
    }),
    clearInterval: vi.fn()
  };
  return {
    dependencies,
    createRedis,
    add,
    getJob,
    removeExisting,
    process,
    recover,
    closeWorker,
    processor: () => processor,
    runInterval: () => intervalHandler?.()
  };
}

describe("Daily Reflection AI review runtime", () => {
  it("does not create Redis, a service, or a Worker while mode is off", async () => {
    const harness = createHarness({ mode: "off" });
    const createService = vi.fn(harness.dependencies.createService);

    const runtime = await startDailyReflectionAiReviewRuntime({
      config,
      dependencies: { ...harness.dependencies, createService }
    });

    expect(runtime).toBeNull();
    expect(harness.createRedis).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
  });

  it("replaces a retained terminal job only after repository recovery fencing", async () => {
    const harness = createHarness({
      mode: "shadow",
      recovered: [
        { accountId: "account_1", reviewId: "review_1" },
        { accountId: "account_2", reviewId: "review_2" }
      ],
      existingJob: true,
      existingState: "completed"
    });
    harness.getJob
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        getState: vi.fn(async () => "completed"),
        remove: harness.removeExisting
      });

    const runtime = await startDailyReflectionAiReviewRuntime({
      config,
      dependencies: harness.dependencies
    });

    expect(runtime?.recovery).toEqual({
      returnedToQueue: 0,
      providerOutcomeUnknown: 0,
      queued: 2,
      enqueued: 2,
      existing: 0
    });
    expect(harness.removeExisting).toHaveBeenCalledTimes(1);
    expect(harness.add).toHaveBeenCalledTimes(2);
    expect(harness.add).toHaveBeenCalledWith(
      "generate-daily-reflection-ai-review",
      { version: 1, reviewId: "review_1", userRef: "account_1" },
      expect.objectContaining({ attempts: 1 })
    );
    await runtime?.close();
  });

  it("preserves active or waiting jobs and periodically recovers later leases", async () => {
    const harness = createHarness({ existingJob: true, existingState: "active" });
    harness.recover
      .mockReturnValueOnce({
        returnedToQueue: 0,
        providerOutcomeUnknown: 0,
        queued: [{ accountId: "account_1", reviewId: "review_active" }]
      })
      .mockReturnValueOnce({
        returnedToQueue: 1,
        providerOutcomeUnknown: 1,
        queued: [{ accountId: "account_2", reviewId: "review_later" }]
      });
    harness.getJob
      .mockResolvedValueOnce({
        getState: vi.fn(async () => "active"),
        remove: harness.removeExisting
      })
      .mockResolvedValueOnce(null);

    const runtime = await startDailyReflectionAiReviewRuntime({
      config,
      dependencies: harness.dependencies
    });
    expect(runtime?.recovery.existing).toBe(1);
    expect(harness.add).not.toHaveBeenCalled();

    harness.runInterval();
    await vi.waitFor(() => expect(harness.add).toHaveBeenCalledTimes(1));
    expect(harness.removeExisting).not.toHaveBeenCalled();
    expect(harness.add).toHaveBeenCalledWith(
      "generate-daily-reflection-ai-review",
      { version: 1, reviewId: "review_later", userRef: "account_2" },
      expect.objectContaining({ attempts: 1 })
    );
    await runtime?.close();
  });

  it("maps the opaque userRef only to accountId and relies on service fencing", async () => {
    const harness = createHarness();
    const runtime = await startDailyReflectionAiReviewRuntime({
      config,
      dependencies: harness.dependencies
    });

    await expect(harness.processor()?.({
      id: "hashed-job-id",
      name: "generate-daily-reflection-ai-review",
      data: { version: 1, reviewId: "review_1", userRef: "account_internal_1" }
    })).resolves.toEqual({ status: "ready" });
    expect(harness.process).toHaveBeenCalledWith({
      accountId: "account_internal_1",
      reviewId: "review_1",
      workerId: "worker_test"
    });
    expect(harness.process).toHaveBeenCalledTimes(1);
    await runtime?.close();
  });

  it("re-checks off mode before processing and exposes isolated queue health", async () => {
    let mode: "on" | "off" = "on";
    const harness = createHarness();
    harness.dependencies.mode = () => mode;
    const runtime = await startDailyReflectionAiReviewRuntime({
      config,
      dependencies: harness.dependencies
    });
    mode = "off";

    await expect(harness.processor()?.({
      name: "generate-daily-reflection-ai-review",
      data: { version: 1, reviewId: "review_1", userRef: "account_1" }
    })).resolves.toEqual({ status: "disabled" });
    expect(harness.process).not.toHaveBeenCalled();
    await expect(runtime?.getHealthSnapshot()).resolves.toEqual({
      mode: "on",
      running: true,
      workers: 1,
      waiting: 2,
      active: 1,
      failed: 0
    });
    await runtime?.close();
  });

  it("disables Bull stalled-job replay because SQLite owns provider fencing", () => {
    expect(DAILY_REFLECTION_AI_REVIEW_MAX_STALLED_COUNT).toBe(0);
  });
});
