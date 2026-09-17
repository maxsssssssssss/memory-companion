// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ persist: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/server/auth/request-context", () => ({ requireAuthContext: async () => ({ user: { id: "account_a" } }), isUnauthenticatedError: () => false }));
vi.mock("@/lib/server/work-review/db", () => ({ getWorkReviewDatabase: () => ({}) }));
vi.mock("@/lib/server/work-review/weekly-service", () => ({ WorkWeeklyService: class { askQa = mocks.persist; } }));
vi.mock("@/lib/server/queue/work-weekly-qa-producer", () => ({ enqueueWorkWeeklyQaJob: mocks.enqueue }));
import { POST } from "./[weeklyReviewId]/qa/route";
const run = { id: "run_a", state: "queued", accountId: "account_a", weeklyReviewId: "weekly_a", runVersion: 1,
  sourceSnapshotDigest: "a".repeat(64), threadId: "thread_a", questionMessageId: "question_a" };
const post = () => POST(new Request("http://localhost/qa", { method: "POST", body: JSON.stringify({ question: "本周如何？", operationKey: "op_a", expectedVersion: null }) }), { params: Promise.resolve({ weeklyReviewId: "weekly_a" }) });
beforeEach(() => {
  mocks.persist.mockReset().mockReturnValue({ run, reused: false });
  mocks.enqueue.mockReset().mockResolvedValue({ enqueued: true });
  for (const key of ["WORK_REVIEW_ENABLED", "WORK_REVIEW_WEEKLY_ENABLED", "WORK_REVIEW_WEEKLY_QA_ENABLED"]) vi.stubEnv(key, "true");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("QA POST dispatch", () => {
  it("dispatches the committed identity and returns accepted without waiting for a model", async () => {
    expect((await post()).status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({ version: 1, kind: "qa", accountId: run.accountId, weeklyReviewId: run.weeklyReviewId,
      runId: run.id, runVersion: run.runVersion, sourceSnapshotDigest: run.sourceSnapshotDigest, threadId: run.threadId, questionMessageId: run.questionMessageId });
    expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0]!);
  });
  it("keeps the committed queued run and 202 on dispatch failure without leaking errors", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.enqueue.mockRejectedValue(new Error("private redis://credential/question"));
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ run, reused: false });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|credential|question|account_a/);
  });
  it.each(["processing", "verifying", "completed", "failed", "superseded"])("does not dispatch a reused %s run", async (state) => {
    mocks.persist.mockReturnValue({ run: { ...run, state }, reused: true });
    expect((await post()).status).toBe(200);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
