// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PipelineQueueConfig } from "./config";
import {
  buildWorkWeeklyQueueJobId,
  WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
  WORK_WEEKLY_QA_QUEUE_JOB_NAME,
  WorkWeeklyQueuePayloadSchema,
  workWeeklyQueueJobName,
  workWeeklyQueueName
} from "./work-weekly-queue";

const DIGEST = "a".repeat(64);

describe("Work Weekly queue contract", () => {
  it("builds stable redacted job IDs for each persisted run", () => {
    const payload = WorkWeeklyQueuePayloadSchema.parse({
      version: 1,
      kind: "generation",
      accountId: "account_private",
      weeklyReviewId: "weekly_private",
      runId: "run_private",
      runVersion: 3,
      sourceSnapshotDigest: DIGEST
    });
    const expected = createHash("sha256")
      .update("generation\u0000account_private\u0000run_private\u00003")
      .digest("hex");

    const jobId = buildWorkWeeklyQueueJobId(payload);

    expect(jobId).toBe(`work-weekly-generation-${expected}`);
    expect(jobId).not.toContain("account_private");
    expect(jobId).not.toContain("weekly_private");
    expect(jobId).not.toContain("run_private");
    expect(workWeeklyQueueJobName(payload)).toBe(
      WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME
    );
  });

  it("keeps QA identity strict without accepting question or source text", () => {
    const payload = WorkWeeklyQueuePayloadSchema.parse({
      version: 1,
      kind: "qa",
      accountId: "account_1",
      weeklyReviewId: "weekly_1",
      runId: "run_1",
      runVersion: 1,
      sourceSnapshotDigest: DIGEST,
      threadId: "thread_1",
      questionMessageId: "message_1"
    });

    expect(workWeeklyQueueJobName(payload)).toBe(WORK_WEEKLY_QA_QUEUE_JOB_NAME);
    expect(() => WorkWeeklyQueuePayloadSchema.parse({
      ...payload,
      question: "private question"
    })).toThrow();
  });

  it("derives an isolated queue name from the existing queue namespace", () => {
    const config = { queueName: "daily-brief-test" } as PipelineQueueConfig;
    expect(workWeeklyQueueName(config)).toBe("daily-brief-test-work-weekly");
  });
});
