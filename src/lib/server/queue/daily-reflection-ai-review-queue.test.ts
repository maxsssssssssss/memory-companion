// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { PipelineQueueConfig } from "./config";
import {
  DailyReflectionAiReviewQueueDisabledError,
  dailyReflectionAiReviewQueueName,
  enqueueDailyReflectionAiReviewJob
} from "./daily-reflection-ai-review-queue";

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

describe("Daily Reflection AI review queue", () => {
  it("uses a separate queue and one BullMQ attempt", async () => {
    const add = vi.fn(async () => ({ id: "job" }));
    const createQueue = vi.fn(() => ({
      waitUntilReady: vi.fn(async () => undefined),
      getJob: vi.fn(async () => null),
      add,
      close: vi.fn(async () => undefined)
    }));
    const result = await enqueueDailyReflectionAiReviewJob({
      version: 1,
      reviewId: "review_1",
      userRef: "account_1"
    }, {
      config,
      dependencies: {
        mode: () => "on",
        createRedis: () => ({
          connect: vi.fn(async () => undefined),
          ping: vi.fn(async () => "PONG"),
          get: vi.fn(async () => null),
          quit: vi.fn(async () => undefined),
          disconnect: vi.fn()
        }),
        createQueue,
        verifyStorage: vi.fn(async () => undefined)
      }
    });

    expect(result.enqueued).toBe(true);
    expect(createQueue).toHaveBeenCalledWith(
      config,
      expect.anything(),
      "daily-brief-test-ai-review"
    );
    expect(add).toHaveBeenCalledWith(
      "generate-daily-reflection-ai-review",
      expect.objectContaining({ reviewId: "review_1" }),
      expect.objectContaining({ attempts: 1 })
    );
  });

  it("derives a stable isolated queue name", () => {
    expect(dailyReflectionAiReviewQueueName(config)).toBe("daily-brief-test-ai-review");
  });

  it("fails before Redis when the feature mode is off", async () => {
    const createRedis = vi.fn();

    await expect(enqueueDailyReflectionAiReviewJob({
      version: 1,
      reviewId: "review_off",
      userRef: "account_1"
    }, {
      config,
      dependencies: {
        mode: () => "off",
        createRedis
      }
    })).rejects.toBeInstanceOf(DailyReflectionAiReviewQueueDisabledError);

    expect(createRedis).not.toHaveBeenCalled();
  });

  it("never removes or revives a retained terminal Bull job", async () => {
    const existing = {
      getState: vi.fn(async () => "failed"),
      remove: vi.fn(async () => undefined)
    };
    const add = vi.fn();
    const result = await enqueueDailyReflectionAiReviewJob({
      version: 1,
      reviewId: "review_terminal",
      userRef: "account_1"
    }, {
      config,
      dependencies: {
        mode: () => "shadow",
        createRedis: () => ({
          connect: vi.fn(async () => undefined),
          ping: vi.fn(async () => "PONG"),
          get: vi.fn(async () => null),
          quit: vi.fn(async () => undefined),
          disconnect: vi.fn()
        }),
        createQueue: () => ({
          waitUntilReady: vi.fn(async () => undefined),
          getJob: vi.fn(async () => existing),
          add,
          close: vi.fn(async () => undefined)
        }),
        verifyStorage: vi.fn(async () => undefined)
      }
    });

    expect(result.enqueued).toBe(false);
    expect(existing.getState).not.toHaveBeenCalled();
    expect(existing.remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
