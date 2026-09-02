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

  it("aggregates enabled Memory bridge degradation without changing disabled health", () => {
    expect(evaluatePipelineQueueHealth({
      executionMode: "queue",
      redisPing: "PONG",
      workerCount: 1,
      storageProbeStatus: "matched",
      recentFailedCount: 0,
      memoryBridge: { ok: true, reasons: [] }
    })).toEqual({ ok: true, reasons: [] });

    expect(evaluatePipelineQueueHealth({
      executionMode: "queue",
      redisPing: "PONG",
      workerCount: 1,
      storageProbeStatus: "matched",
      recentFailedCount: 0,
      memoryBridge: {
        ok: false,
        reasons: ["memory_bridge_consumer_not_running"]
      }
    })).toEqual({
      ok: false,
      reasons: ["memory_bridge_consumer_not_running"]
    });
  });

  it("observes the separate low-concurrency AI review queue", () => {
    const base = {
      executionMode: "queue" as const,
      redisPing: "PONG",
      workerCount: 1,
      storageProbeStatus: "matched" as const,
      recentFailedCount: 0
    };

    expect(evaluatePipelineQueueHealth({
      ...base,
      aiReview: {
        mode: "on",
        workerCount: 1,
        waitingCount: 3,
        activeCount: 1,
        recentFailedCount: 0
      }
    })).toEqual({ ok: true, reasons: [] });

    expect(evaluatePipelineQueueHealth({
      ...base,
      aiReview: {
        mode: "shadow",
        workerCount: 0,
        waitingCount: 2,
        activeCount: 0,
        recentFailedCount: 1
      }
    })).toEqual({
      ok: false,
      reasons: [
        "ai_review_worker_not_detected",
        "ai_review_recent_failed_jobs"
      ]
    });

    expect(evaluatePipelineQueueHealth({
      ...base,
      aiReview: {
        mode: "off",
        workerCount: 1,
        waitingCount: 0,
        activeCount: 1,
        recentFailedCount: 0
      }
    })).toEqual({
      ok: false,
      reasons: ["ai_review_worker_running_while_disabled"]
    });
  });
});
