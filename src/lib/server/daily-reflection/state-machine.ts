import type { DailyReflectionStatus } from "@/lib/domain/daily-reflection";

const DAILY_REFLECTION_TRANSITIONS = {
  created: ["uploading", "failed", "cancelled", "deleted"],
  uploading: ["transcribing", "failed", "cancelled", "deleted"],
  transcribing: ["extracting", "failed", "cancelled", "deleted"],
  extracting: ["review_pending", "failed", "cancelled", "deleted"],
  review_pending: ["confirmation_ready", "cancelled", "deleted"],
  confirmation_ready: ["admitting", "admission_failed", "deleted"],
  admitting: ["completed", "admission_failed", "deleted"],
  completed: ["deleted"],
  admission_failed: ["admitting", "deleted"],
  failed: ["deleted"],
  cancelled: ["deleted"],
  deleted: []
} as const satisfies Record<DailyReflectionStatus, readonly DailyReflectionStatus[]>;

const DAILY_REFLECTION_FAILED_RETRY_TARGETS = [
  "uploading",
  "transcribing",
  "extracting"
] as const;

export type DailyReflectionRetryStatus =
  (typeof DAILY_REFLECTION_FAILED_RETRY_TARGETS)[number];

export class DailyReflectionTransitionError extends Error {
  readonly code = "daily_reflection_invalid_transition";

  constructor(
    readonly from: DailyReflectionStatus,
    readonly to: DailyReflectionStatus
  ) {
    super(`Daily Reflection cannot transition from ${from} to ${to}`);
  }
}

export function canTransitionDailyReflection(
  from: DailyReflectionStatus,
  to: DailyReflectionStatus
) {
  return (DAILY_REFLECTION_TRANSITIONS[from] as readonly DailyReflectionStatus[])
    .includes(to);
}

export function assertDailyReflectionTransition(
  from: DailyReflectionStatus,
  to: DailyReflectionStatus
) {
  if (!canTransitionDailyReflection(from, to)) {
    throw new DailyReflectionTransitionError(from, to);
  }
}

export function canRetryFailedDailyReflection(
  from: DailyReflectionStatus,
  to: DailyReflectionStatus
): to is DailyReflectionRetryStatus {
  return from === "failed"
    && (DAILY_REFLECTION_FAILED_RETRY_TARGETS as readonly DailyReflectionStatus[])
      .includes(to);
}

export function assertFailedDailyReflectionRetry(
  from: DailyReflectionStatus,
  to: DailyReflectionStatus
): asserts to is DailyReflectionRetryStatus {
  if (!canRetryFailedDailyReflection(from, to)) {
    throw new DailyReflectionTransitionError(from, to);
  }
}

export function isDailyReflectionTombstone(status: DailyReflectionStatus) {
  return status === "cancelled" || status === "deleted";
}

export {
  DAILY_REFLECTION_FAILED_RETRY_TARGETS,
  DAILY_REFLECTION_TRANSITIONS
};
