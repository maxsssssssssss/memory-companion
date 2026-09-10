// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authenticated: true,
  calls: [] as Array<{ method: string; accountId: string; value: unknown }>
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => {
    if (!state.authenticated) throw new Error("unauthenticated");
    return { user: { id: "account_server" } };
  })
}));

vi.mock("@/lib/server/work-review/db", () => ({
  getWorkReviewDatabase: vi.fn(() => ({ database: "mock" }))
}));

vi.mock("@/lib/server/work-review/weekly-service", () => ({
  WorkWeeklyService: class {
    getByScope(accountId: string, value: unknown) {
      state.calls.push({ method: "getByScope", accountId, value });
      return { review: null, items: [], sourceSummary: {
        meetingCount: 0, findingCount: 0, todoCount: 0, todoEventCount: 0,
        evidenceCount: 0, projectCount: 0, pendingCandidateCount: 0,
        includedFindingCount: 0, includedTodoCount: 0, includedTodoEventCount: 0,
        includedEvidenceCount: 0, omittedFindingCount: 0, omittedTodoCount: 0,
        omittedTodoEventCount: 0, omittedEvidenceCount: 0, truncated: false,
        historyCompleteness: "exact"
      } };
    }

    generate(accountId: string, value: unknown) {
      state.calls.push({ method: "generate", accountId, value });
      return { review: { id: "weekly_1" }, run: { id: "run_1" }, reused: false };
    }
  }
}));

import { POST as generate } from "./generate/route";
import { GET as getByScope } from "./route";

beforeEach(() => {
  state.authenticated = true;
  state.calls = [];
  process.env.WORK_REVIEW_ENABLED = "true";
  process.env.WORK_REVIEW_WEEKLY_ENABLED = "true";
  process.env.WORK_REVIEW_WEEKLY_AI_ENABLED = "true";
});

afterEach(() => {
  delete process.env.WORK_REVIEW_ENABLED;
  delete process.env.WORK_REVIEW_WEEKLY_ENABLED;
  delete process.env.WORK_REVIEW_WEEKLY_AI_ENABLED;
});

describe("Work Weekly Core routes", () => {
  it("derives account scope only from auth and returns private/no-store", async () => {
    const response = await getByScope(new Request(
      "http://localhost/api/work-reviews/weekly?weekStart=2026-08-31&timeZone=Asia%2FShanghai&scopeKind=all"
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.calls).toEqual([expect.objectContaining({
      method: "getByScope", accountId: "account_server"
    })]);
  });

  it("rejects a client-owned accountId and keeps the error private", async () => {
    const response = await generate(new Request(
      "http://localhost/api/work-reviews/weekly/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "account_attacker",
          weekStart: "2026-08-31",
          timeZone: "Asia/Shanghai",
          scopeKind: "all",
          projectId: null,
          operationKey: "generate_1",
          expectedVersion: null
        })
      }
    ));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.calls).toEqual([]);
  });

  it("fails closed when Weekly AI is disabled", async () => {
    process.env.WORK_REVIEW_WEEKLY_AI_ENABLED = "false";
    const response = await generate(new Request(
      "http://localhost/api/work-reviews/weekly/generate",
      { method: "POST", body: "{}" }
    ));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "weekly_ai_disabled" });
  });
});
