// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { Job } from "bullmq";
import { getPipelineQueueConfig } from "./config";
import type { DailyBriefQueueJobData } from "./types";
import {
  assertHybridIndexSingleWriter,
  enqueueAllUserEmbeddingIndexJobs,
  processEmbeddingIndexQueueJob,
  startPeriodicEmbeddingIndexRecovery
} from "./runtime";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Hybrid index startup recovery", () => {
  const queueConfig = getPipelineQueueConfig({
    PIPELINE_EXECUTION_MODE: "queue",
    APP_DATA_DIR: resolve("queue-data"),
    APP_STORAGE_MODE: "server",
    REDIS_URL: "redis://127.0.0.1:6381"
  });

  it("rejects Hybrid indexing when BullMQ concurrency is not one", () => {
    expect(() => assertHybridIndexSingleWriter("shadow", 2)).toThrow(
      "PIPELINE_WORKER_CONCURRENCY=1"
    );
    expect(() => assertHybridIndexSingleWriter("phase31", 1)).not.toThrow();
    expect(() => assertHybridIndexSingleWriter("off", 4)).not.toThrow();
    expect(() => assertHybridIndexSingleWriter("off", 2, "browser_cache")).toThrow(
      /PIPELINE_WORKER_CONCURRENCY=1/u
    );
  });

  it("enqueues every user with real completed/total progress", async () => {
    const enqueue = vi.fn()
      .mockResolvedValueOnce({ jobId: "job-1", enqueued: true })
      .mockResolvedValueOnce({ jobId: "job-2", enqueued: false });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(enqueueAllUserEmbeddingIndexJobs({
      users: [
        { id: "record-1", value: { id: "user_1" } },
        { id: "user_2", value: {} }
      ],
      enqueue
    })).resolves.toEqual({ total: 2, enqueued: 1, existing: 1 });
    expect(enqueue).toHaveBeenNthCalledWith(1, {
      version: 1,
      userRef: "user_1",
      reason: "startup"
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, {
      version: 1,
      userRef: "user_2",
      reason: "startup"
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("progress=1/2"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("progress=2/2"));
  });

  it("fails startup when any user cannot be enqueued so the supervisor retries", async () => {
    const enqueue = vi.fn()
      .mockResolvedValueOnce({ jobId: "job-1", enqueued: true })
      .mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(enqueueAllUserEmbeddingIndexJobs({
      users: [
        { id: "user_1", value: {} },
        { id: "user_2", value: {} }
      ],
      enqueue
    })).rejects.toThrow("queue unavailable");
  });

  it("enqueues a normal refresh after a permanent deletion processor succeeds", async () => {
    const result = {
      status: "indexed" as const,
      userRef: "user_1",
      uploadCount: 0,
      retainedUploadCount: 0,
      completedDeletionCount: 1,
      total: 1,
      embedded: 0,
      unchanged: 0,
      removed: 1
    };
    const process = vi.fn(async () => result);
    const enqueue = vi.fn(async () => ({ jobId: "followup", enqueued: true }));
    const job = {
      data: { version: 1, userRef: "user_1", reason: "permanent_delete" }
    } as Job<DailyBriefQueueJobData>;

    await expect(processEmbeddingIndexQueueJob(job, {
      config: queueConfig,
      process,
      enqueue
    })).resolves.toEqual(result);
    expect(enqueue).toHaveBeenCalledWith({
      version: 1,
      userRef: "user_1",
      reason: "upload_deleted"
    });
  });

  it("fails the permanent deletion job when its refresh follow-up cannot be queued", async () => {
    const process = vi.fn(async () => ({
      status: "indexed" as const,
      userRef: "user_1",
      uploadCount: 0,
      retainedUploadCount: 0,
      completedDeletionCount: 1,
      total: 1,
      embedded: 0,
      unchanged: 0,
      removed: 1
    }));
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const job = {
      data: { version: 1, userRef: "user_1", reason: "permanent_delete" }
    } as Job<DailyBriefQueueJobData>;

    await expect(processEmbeddingIndexQueueJob(job, {
      config: queueConfig,
      process,
      enqueue
    })).rejects.toThrow("queue unavailable");
    expect(process).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("runs low-frequency Hybrid recovery without overlapping and stops on close", async () => {
    vi.useFakeTimers();
    let finishFirst: ((value: { total: number; enqueued: number; existing: number }) => void)
      | undefined;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValue({ total: 2, enqueued: 1, existing: 1 });
    const onReport = vi.fn();
    const recovery = startPeriodicEmbeddingIndexRecovery({
      enabled: true,
      intervalMs: 900_000,
      run,
      onReport
    });

    await vi.advanceTimersByTimeAsync(899_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(run).toHaveBeenCalledTimes(1);

    finishFirst?.({ total: 2, enqueued: 1, existing: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(onReport).toHaveBeenCalledWith({ total: 2, enqueued: 1, existing: 1 });

    await vi.advanceTimersByTimeAsync(900_000);
    expect(run).toHaveBeenCalledTimes(2);
    await recovery.close();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
