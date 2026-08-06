// @vitest-environment node

import { describe, expect, it } from "vitest";

import { evaluatePipelineQueueHealth } from "./health";

describe("pipeline queue health", () => {
  it("requires queue mode, Redis, and at least one registered worker", () => {
    expect(evaluatePipelineQueueHealth({
      executionMode: "queue",
      redisPing: "PONG",
      workerCount: 1,
      storageProbeStatus: "matched",
      recentFailedCount: 0
    })).toEqual({ ok: true, reasons: [] });

    expect(evaluatePipelineQueueHealth({
      executionMode: "inline",
      redisPing: "PONG",
      workerCount: 0,
      storageProbeStatus: "worker_probe_missing",
      recentFailedCount: 2
    })).toEqual({
      ok: false,
      reasons: [
        "execution_mode_not_queue",
        "worker_not_detected",
        "worker_probe_missing",
        "recent_failed_jobs"
      ]
    });
  });

  it("rejects multiple Workers, mismatched storage, and recent failures", () => {
    expect(evaluatePipelineQueueHealth({
      executionMode: "queue",
      redisPing: "PONG",
      workerCount: 2,
      storageProbeStatus: "storage_mismatch",
      recentFailedCount: 1
    })).toEqual({
      ok: false,
      reasons: ["multiple_workers_detected", "storage_mismatch", "recent_failed_jobs"]
    });
  });
});
