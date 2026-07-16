// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { PipelineQueueConfig } from "./config";
import {
  enqueuePipelineJob,
  PipelineQueueUnavailableError,
  type PipelineQueueAdapter,
  type RedisConnectionAdapter
} from "./producer";
import { buildPipelineJobId, type PipelineJobData } from "./types";

const config: PipelineQueueConfig = {
  executionMode: "queue",
  redisUrl: "redis://127.0.0.1:6379",
  queueName: "daily-brief-pipeline-test",
  workerConcurrency: 1,
  attempts: 3,
  backoffMs: 5_000,
  processingStaleMs: 60_000
};

function fixture(
  existing: {
    id?: string;
    getState?(): Promise<string>;
    remove?(): Promise<void>;
  } | null = null
) {
  const redis: RedisConnectionAdapter = {
    connect: vi.fn(async () => undefined),
    ping: vi.fn(async () => "PONG"),
    quit: vi.fn(async () => "OK"),
    disconnect: vi.fn()
  };
  const queue: PipelineQueueAdapter = {
    waitUntilReady: vi.fn(async () => undefined),
    getJob: vi.fn(async () => existing),
    add: vi.fn(async (_name, _data, options) => ({ id: String(options.jobId) })),
    close: vi.fn(async () => undefined)
  };
  return { redis, queue };
}

const data: PipelineJobData = { version: 1, uploadId: "upload_1", userRef: "user_1" };

describe("pipeline queue producer", () => {
  it("adds the minimal payload with bounded exponential retry options", async () => {
    const { redis, queue } = fixture();
    const result = await enqueuePipelineJob(data, {
      config,
      dependencies: {
        createRedis: () => redis,
        createQueue: () => queue
      }
    });

    const jobId = buildPipelineJobId(data);
    expect(result).toEqual({ jobId, enqueued: true });
    expect(queue.add).toHaveBeenCalledWith("process-upload", data, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: false,
      removeOnFail: false
    });
    expect(queue.close).toHaveBeenCalledOnce();
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it("returns the stable existing job without adding a duplicate", async () => {
    const jobId = buildPipelineJobId(data);
    const existing = {
      id: jobId,
      getState: vi.fn(async () => "completed"),
      remove: vi.fn(async () => undefined)
    };
    const { redis, queue } = fixture(existing);
    await expect(
      enqueuePipelineJob(data, {
        config,
        dependencies: { createRedis: () => redis, createQueue: () => queue }
      })
    ).resolves.toEqual({ jobId, enqueued: false });
    expect(queue.add).not.toHaveBeenCalled();
    expect(existing.getState).not.toHaveBeenCalled();
    expect(existing.remove).not.toHaveBeenCalled();
  });

  it("lets startup recovery replace a terminal failed job", async () => {
    const jobId = buildPipelineJobId(data);
    const existing = {
      id: jobId,
      getState: vi.fn(async () => "failed"),
      remove: vi.fn(async () => undefined)
    };
    const { redis, queue } = fixture(existing);

    await expect(
      enqueuePipelineJob(data, {
        config,
        reviveTerminal: true,
        dependencies: { createRedis: () => redis, createQueue: () => queue }
      })
    ).resolves.toEqual({ jobId, enqueued: true });

    expect(existing.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it.each(["waiting", "active", "delayed"])(
    "does not replace an existing %s job during recovery",
    async (state) => {
      const jobId = buildPipelineJobId(data);
      const existing = {
        id: jobId,
        getState: vi.fn(async () => state),
        remove: vi.fn(async () => undefined)
      };
      const { redis, queue } = fixture(existing);

      await expect(
        enqueuePipelineJob(data, {
          config,
          reviveTerminal: true,
          dependencies: { createRedis: () => redis, createQueue: () => queue }
        })
      ).resolves.toEqual({ jobId, enqueued: false });

      expect(existing.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    }
  );

  it("lets startup recovery replace a terminal completed job", async () => {
    const jobId = buildPipelineJobId(data);
    const existing = {
      id: jobId,
      getState: vi.fn(async () => "completed"),
      remove: vi.fn(async () => undefined)
    };
    const { redis, queue } = fixture(existing);

    await expect(
      enqueuePipelineJob(data, {
        config,
        reviveTerminal: true,
        dependencies: { createRedis: () => redis, createQueue: () => queue }
      })
    ).resolves.toEqual({ jobId, enqueued: true });

    expect(existing.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it("fails closed when Redis is unavailable", async () => {
    const { redis, queue } = fixture();
    vi.mocked(redis.connect).mockRejectedValueOnce(new Error("ECONNREFUSED redis://secret@host"));

    await expect(
      enqueuePipelineJob(data, {
        config,
        dependencies: { createRedis: () => redis, createQueue: () => queue }
      })
    ).rejects.toBeInstanceOf(PipelineQueueUnavailableError);
    expect(queue.add).not.toHaveBeenCalled();
    expect(redis.quit).toHaveBeenCalledOnce();
  });
});
