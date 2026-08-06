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
  return {
    ok: reasons.length === 0,
    reasons
  };
}
