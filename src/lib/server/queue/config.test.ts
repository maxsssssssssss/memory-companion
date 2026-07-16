// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  getPipelineQueueConfig,
  resolvePipelineExecutionMode,
  sanitizedRedisEndpoint
} from "./config";

describe("pipeline queue configuration", () => {
  it("defaults to inline and the documented safe local values", () => {
    expect(getPipelineQueueConfig({})).toEqual({
      executionMode: "inline",
      redisUrl: "redis://127.0.0.1:6379",
      queueName: "daily-brief-pipeline",
      workerConcurrency: 1,
      attempts: 3,
      backoffMs: 5_000,
      processingStaleMs: 7_200_000
    });
  });

  it("rejects unknown modes instead of silently falling back inline", () => {
    expect(resolvePipelineExecutionMode("queue")).toBe("queue");
    expect(() => resolvePipelineExecutionMode("worker")).toThrow(
      "PIPELINE_EXECUTION_MODE must be inline or queue"
    );
  });

  it("never exposes Redis credentials in the health endpoint", () => {
    expect(sanitizedRedisEndpoint("rediss://queue-user:secret@redis.internal:6380/2?x=1")).toBe(
      "rediss://redis.internal:6380/2"
    );
  });
});
