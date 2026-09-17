// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import IORedis from "ioredis";
import type { PipelineQueueConfig } from "./config";
import { enqueueWorkWeeklyQaJob } from "./work-weekly-qa-producer";
import { buildWorkWeeklyQueueJobId } from "./work-weekly-queue";

const config = { executionMode: "queue", queueName: "isolated-fixture", retention: { completed: { count: 10 }, failed: { count: 10 } } } as PipelineQueueConfig;
const payload = { version: 1, kind: "qa", accountId: "account_a", weeklyReviewId: "weekly_a", runId: "run_a",
  runVersion: 1, sourceSnapshotDigest: "a".repeat(64), threadId: "thread_a", questionMessageId: "question_a" } as const;
function fixture() {
  const connection = { connect: vi.fn(async () => undefined), ping: vi.fn(async () => "PONG"), get: vi.fn(async () => null), quit: vi.fn(async () => undefined), disconnect: vi.fn() };
  const queue = { waitUntilReady: vi.fn(async () => undefined), getJob: vi.fn<() => Promise<object | null>>(async () => null),
    add: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  return { connection, queue, dependencies: { enabled: () => true, createRedis: vi.fn(() => connection), createQueue: vi.fn(() => queue), verifyStorage: vi.fn(async () => undefined) } };
}
describe("Work Weekly QA immediate producer", () => {
  it("handles a Redis error event without logging raw endpoint details or opening a socket", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connect = vi.spyOn(IORedis.prototype, "connect").mockImplementation(async function (this: IORedis) {
      expect(this.listenerCount("error")).toBeGreaterThan(0);
      this.emit("error", new Error("private redis://credential@host"));
      throw new Error("private redis://credential@host");
    });
    const quit = vi.spyOn(IORedis.prototype, "quit").mockResolvedValue("OK");
    try {
      await expect(enqueueWorkWeeklyQaJob(payload, { config: { ...config, redisUrl: "redis://127.0.0.1:6379" },
        dependencies: { enabled: () => true } })).rejects.toThrow("Pipeline queue is unavailable");
      expect(connect).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); quit.mockRestore(); log.mockRestore(); }
  });
  it("uses the existing run job identity with one attempt and closes transport", async () => {
    const f = fixture();
    expect(await enqueueWorkWeeklyQaJob(payload, { config, dependencies: f.dependencies })).toEqual({ jobId: buildWorkWeeklyQueueJobId(payload), enqueued: true });
    expect(f.queue.add).toHaveBeenCalledExactlyOnceWith("answer-work-weekly-question", payload,
      { jobId: buildWorkWeeklyQueueJobId(payload), attempts: 1, removeOnComplete: config.retention.completed, removeOnFail: config.retention.failed });
    expect(f.queue.close).toHaveBeenCalledTimes(1);
    expect(f.connection.quit).toHaveBeenCalledTimes(1);
  });
  it.each(["waiting", "active", "completed", "failed"])("never revives an existing %s receipt", async (state) => {
    const f = fixture();
    f.queue.getJob.mockResolvedValue({ state });
    expect(await enqueueWorkWeeklyQaJob(payload, { config, dependencies: f.dependencies })).toMatchObject({ enqueued: false });
    expect(f.queue.add).not.toHaveBeenCalled();
  });
  it("treats an ambiguous add with a retained receipt as deduplicated without retry", async () => {
    const f = fixture();
    f.queue.getJob.mockResolvedValueOnce(null).mockResolvedValueOnce({});
    f.queue.add.mockRejectedValue(new Error("private Redis response"));
    expect(await enqueueWorkWeeklyQaJob(payload, { config, dependencies: f.dependencies })).toMatchObject({ enqueued: false });
    expect(f.queue.add).toHaveBeenCalledTimes(1);
  });
  it("fails a lost add once, leaving the durable product run to recovery", async () => {
    const f = fixture();
    f.queue.add.mockRejectedValue(new Error("private Redis response"));
    await expect(enqueueWorkWeeklyQaJob(payload, { config, dependencies: f.dependencies })).rejects.toThrow("Pipeline queue is unavailable");
    expect(f.queue.add).toHaveBeenCalledTimes(1);
    expect(f.connection.quit).toHaveBeenCalledTimes(1);
  });
  it("checks the product gate before creating Redis", async () => {
    const f = fixture();
    await expect(enqueueWorkWeeklyQaJob(payload, { config, dependencies: { ...f.dependencies, enabled: () => false } })).rejects.toThrow();
    expect(f.dependencies.createRedis).not.toHaveBeenCalled();
  });
});
