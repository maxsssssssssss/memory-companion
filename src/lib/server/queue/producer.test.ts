// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { PipelineQueueConfig } from "./config";
import {
  enqueueEmbeddingIndexJob,
  enqueuePipelineJob,
  PipelineQueueUnavailableError,
  type PipelineQueueAdapter,
  type RedisConnectionAdapter
} from "./producer";
import {
  buildEmbeddingIndexQueueJobIds,
  buildPipelineJobId,
  type EmbeddingIndexQueuePayload,
  type PipelineJobData
} from "./types";

const config: PipelineQueueConfig = {
  executionMode: "queue",
  redisUrl: "redis://127.0.0.1:6380",
  queueName: "daily-brief-pipeline-test",
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
  dataDirectory: resolve(".data-producer-test"),
  storageMode: "server"
};

const verifyStorageProbe = vi.fn(async () => undefined);

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
    get: vi.fn(async () => null),
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

function dependenciesFor(
  redis: RedisConnectionAdapter,
  queue: PipelineQueueAdapter
) {
  return {
    createRedis: () => redis,
    createQueue: () => queue,
    verifyStorageProbe
  };
}

const data: PipelineJobData = { version: 1, uploadId: "upload_1", userRef: "user_1" };

describe("pipeline queue producer", () => {
  it("adds the minimal payload with bounded exponential retry options", async () => {
    const { redis, queue } = fixture();
    const result = await enqueuePipelineJob(data, {
      config,
      dependencies: dependenciesFor(redis, queue)
    });

    const jobId = buildPipelineJobId(data);
    expect(result).toEqual({ jobId, enqueued: true });
    expect(queue.add).toHaveBeenCalledWith("process-upload", data, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: config.retention.completed,
      removeOnFail: config.retention.failed
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
        dependencies: dependenciesFor(redis, queue)
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
        dependencies: dependenciesFor(redis, queue)
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
          dependencies: dependenciesFor(redis, queue)
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
        dependencies: dependenciesFor(redis, queue)
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
        dependencies: dependenciesFor(redis, queue)
      })
    ).rejects.toBeInstanceOf(PipelineQueueUnavailableError);
    expect(queue.add).not.toHaveBeenCalled();
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it("treats an add response failure as accepted when the stable job was persisted", async () => {
    const jobId = buildPipelineJobId(data);
    const { redis, queue } = fixture();
    vi.mocked(queue.getJob)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: jobId });
    vi.mocked(queue.add).mockRejectedValueOnce(new Error("response lost after add"));

    await expect(enqueuePipelineJob(data, {
      config,
      dependencies: dependenciesFor(redis, queue)
    })).resolves.toEqual({ jobId, enqueued: false });
    expect(queue.getJob).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a failed terminal-job removal for a successful enqueue", async () => {
    const jobId = buildPipelineJobId(data);
    const existing = {
      id: jobId,
      getState: vi.fn(async () => "failed"),
      remove: vi.fn(async () => {
        throw new Error("remove failed");
      })
    };
    const { redis, queue } = fixture(existing);

    await expect(enqueuePipelineJob(data, {
      config,
      reviveTerminal: true,
      dependencies: dependenciesFor(redis, queue)
    })).rejects.toBeInstanceOf(PipelineQueueUnavailableError);

    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.getJob).toHaveBeenCalledOnce();
  });
});

describe("embedding index queue producer", () => {
  const indexData: EmbeddingIndexQueuePayload = {
    version: 1,
    userRef: "user_1",
    reason: "manual"
  };

  function indexFixture(states: Array<"absent" | "waiting" | "active" | "completed">) {
    const base = fixture();
    const ids = buildEmbeddingIndexQueueJobIds(indexData);
    const jobs = states.map((state, index) => state === "absent" ? null : ({
      id: ids[index],
      getState: vi.fn(async () => state),
      remove: vi.fn(async () => undefined)
    }));
    vi.mocked(base.queue.getJob).mockImplementation(async (jobId) =>
      jobs[ids.indexOf(jobId as typeof ids[number])] ?? null
    );
    return { ...base, ids, jobs };
  }

  it("adds the primary stable slot with three retry attempts", async () => {
    const current = indexFixture(["absent", "absent"]);
    await expect(enqueueEmbeddingIndexJob(indexData, {
      config,
      dependencies: dependenciesFor(current.redis, current.queue)
    })).resolves.toEqual({ jobId: current.ids[0], enqueued: true });
    expect(current.queue.add).toHaveBeenCalledWith(
      "refresh-embedding-index",
      indexData,
      expect.objectContaining({ jobId: current.ids[0], attempts: 3 })
    );
  });

  it("adds a stable follow-up when the primary refresh is already active", async () => {
    const current = indexFixture(["active", "absent"]);
    await expect(enqueueEmbeddingIndexJob(indexData, {
      config,
      dependencies: dependenciesFor(current.redis, current.queue)
    })).resolves.toEqual({ jobId: current.ids[1], enqueued: true });
    expect(current.queue.add).toHaveBeenCalledWith(
      "refresh-embedding-index",
      indexData,
      expect.objectContaining({ jobId: current.ids[1] })
    );
  });

  it("coalesces into an already waiting follow-up", async () => {
    const current = indexFixture(["active", "waiting"]);
    await expect(enqueueEmbeddingIndexJob(indexData, {
      config,
      dependencies: dependenciesFor(current.redis, current.queue)
    })).resolves.toEqual({ jobId: current.ids[1], enqueued: false });
    expect(current.queue.add).not.toHaveBeenCalled();
  });
});
