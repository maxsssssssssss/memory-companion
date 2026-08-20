import { describe, expect, it, vi } from "vitest";

import {
  VOICEPRINT_ENROLLMENT_JOB_NAME,
  enqueueVoiceprintEnrollment,
  voiceprintEnrollmentQueuePolicy
} from "./voiceprint-enrollment-queue";

describe("voiceprint enrollment queue", () => {
  it("enqueues one durable attempt with no retry backoff", async () => {
    const redis = {
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue("PONG"),
      quit: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn()
    };
    const queue = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(null),
      add: vi.fn().mockResolvedValue({ id: "job_1" }),
      close: vi.fn().mockResolvedValue(undefined)
    };
    const data = {
      version: 1 as const,
      userId: "user_1",
      operationId: "operation_1"
    };

    const result = await enqueueVoiceprintEnrollment(data, {
      config: {
        redisUrl: "redis://127.0.0.1:6380",
        queueName: "test-voiceprint-enrollment",
        workerConcurrency: 1
      },
      createRedis: () => redis,
      createQueue: () => queue
    });

    expect(result).toMatchObject({ enqueued: true });
    expect(queue.add).toHaveBeenCalledWith(
      VOICEPRINT_ENROLLMENT_JOB_NAME,
      data,
      expect.objectContaining({
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false
      })
    );
    expect(queue.add.mock.calls[0][2]).not.toHaveProperty("backoff");
    expect(voiceprintEnrollmentQueuePolicy).toMatchObject({
      attempts: 1,
      backoff: null
    });
  });

  it("deduplicates an existing operation job", async () => {
    const queue = {
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue({ id: "existing" }),
      add: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined)
    };
    const redis = {
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue("PONG"),
      quit: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn()
    };

    await expect(
      enqueueVoiceprintEnrollment(
        {
          version: 1,
          userId: "user_1",
          operationId: "operation_1"
        },
        {
          config: {
            redisUrl: "redis://127.0.0.1:6380",
            queueName: "test-voiceprint-enrollment",
            workerConcurrency: 1
          },
          createRedis: () => redis,
          createQueue: () => queue
        }
      )
    ).resolves.toMatchObject({ enqueued: false });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
