import { describe, expect, it } from "vitest";

import type { DailyReflectionStatus } from "@/lib/domain/daily-reflection";

import {
  DAILY_REFLECTION_FAILED_RETRY_TARGETS,
  DAILY_REFLECTION_TRANSITIONS,
  DailyReflectionTransitionError,
  assertFailedDailyReflectionRetry,
  assertDailyReflectionTransition,
  canRetryFailedDailyReflection,
  canTransitionDailyReflection,
  isDailyReflectionTombstone
} from "./state-machine";

describe("Daily Reflection state machine", () => {
  it("admits the ordered processing path and declared exceptional paths", () => {
    const expected: Record<DailyReflectionStatus, readonly DailyReflectionStatus[]> = {
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
    };
    expect(DAILY_REFLECTION_TRANSITIONS).toEqual(expected);
    for (const [from, targets] of Object.entries(expected)) {
      for (const to of targets) {
        expect(canTransitionDailyReflection(
          from as DailyReflectionStatus,
          to
        )).toBe(true);
      }
    }
  });

  it.each([
    ["created", "review_pending"],
    ["uploading", "review_pending"],
    ["review_pending", "extracting"],
    ["failed", "uploading"],
    ["cancelled", "review_pending"],
    ["deleted", "created"],
    ["deleted", "deleted"]
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(canTransitionDailyReflection(from, to)).toBe(false);
    expect(() => assertDailyReflectionTransition(from, to))
      .toThrow(DailyReflectionTransitionError);
  });

  it("allows failed recovery only through the explicit retry transition", () => {
    expect(DAILY_REFLECTION_FAILED_RETRY_TARGETS).toEqual([
      "uploading",
      "transcribing",
      "extracting"
    ]);
    for (const target of DAILY_REFLECTION_FAILED_RETRY_TARGETS) {
      expect(canRetryFailedDailyReflection("failed", target)).toBe(true);
      expect(() => assertFailedDailyReflectionRetry("failed", target)).not.toThrow();
      expect(canTransitionDailyReflection("failed", target)).toBe(false);
    }
    expect(canRetryFailedDailyReflection("failed", "review_pending")).toBe(false);
    expect(canRetryFailedDailyReflection("cancelled", "uploading")).toBe(false);
    expect(canRetryFailedDailyReflection("deleted", "extracting")).toBe(false);
  });

  it("identifies worker-stopping tombstones", () => {
    expect(isDailyReflectionTombstone("cancelled")).toBe(true);
    expect(isDailyReflectionTombstone("deleted")).toBe(true);
    expect(isDailyReflectionTombstone("failed")).toBe(false);
    expect(isDailyReflectionTombstone("review_pending")).toBe(false);
  });
});
