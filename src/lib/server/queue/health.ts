import type { PipelineExecutionMode } from "./config";

export type PipelineQueueHealthInput = {
  executionMode: PipelineExecutionMode;
  redisPing: string;
  workerCount: number;
  storageProbeStatus:
    | "matched"
    | "worker_probe_missing"
    | "worker_probe_invalid"
    | "storage_mismatch";
  recentFailedCount: number;
  memoryBridge?: {
    ok: boolean;
    reasons: string[];
  };
  aiReview?: {
    mode: "off" | "shadow" | "on";
    workerCount: number;
    waitingCount: number;
    activeCount: number;
    recentFailedCount: number;
  };
};

export function evaluatePipelineQueueHealth(input: PipelineQueueHealthInput) {
  const reasons: string[] = [];
  if (input.executionMode !== "queue") reasons.push("execution_mode_not_queue");
  if (input.redisPing !== "PONG") reasons.push("redis_not_ready");
  if (!Number.isSafeInteger(input.workerCount) || input.workerCount < 1) {
    reasons.push("worker_not_detected");
  } else if (input.workerCount !== 1) {
    reasons.push("multiple_workers_detected");
  }
  if (input.storageProbeStatus !== "matched") {
    reasons.push(input.storageProbeStatus);
  }
  if (!Number.isSafeInteger(input.recentFailedCount) || input.recentFailedCount < 0) {
    reasons.push("failed_job_count_invalid");
  } else if (input.recentFailedCount > 0) {
    reasons.push("recent_failed_jobs");
  }
  if (input.memoryBridge && !input.memoryBridge.ok) {
    reasons.push(...input.memoryBridge.reasons);
  }
  if (input.aiReview) {
    const counts = [
      input.aiReview.workerCount,
      input.aiReview.waitingCount,
      input.aiReview.activeCount,
      input.aiReview.recentFailedCount
    ];
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      reasons.push("ai_review_queue_counts_invalid");
    } else if (input.aiReview.mode === "off") {
      if (input.aiReview.workerCount > 0 || input.aiReview.activeCount > 0) {
        reasons.push("ai_review_worker_running_while_disabled");
      }
    } else {
      if (input.aiReview.workerCount < 1) {
        reasons.push("ai_review_worker_not_detected");
      } else if (input.aiReview.workerCount !== 1) {
        reasons.push("ai_review_multiple_workers_detected");
      }
      if (input.aiReview.activeCount > 1) {
        reasons.push("ai_review_concurrency_exceeded");
      }
      if (input.aiReview.recentFailedCount > 0) {
        reasons.push("ai_review_recent_failed_jobs");
      }
    }
  }
  return {
    ok: reasons.length === 0,
    reasons
  };
}
