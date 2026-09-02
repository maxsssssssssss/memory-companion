import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  mode: "on" as "off" | "shadow" | "on",
  uploadEnabled: true,
  requireAuth: vi.fn(),
  ensure: vi.fn(),
  lookup: vi.fn(),
  summary: vi.fn(),
  markSeen: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth/request-context")>(
    "@/lib/server/auth/request-context"
  );
  return { ...actual, requireAuthContext: state.requireAuth };
});
vi.mock("@/lib/server/daily-reflection/runtime-config", () => ({
  getDailyReflectionAiReviewMode: () => state.mode,
  isDailyReflectionUploadEnabled: () => state.uploadEnabled
}));
vi.mock("@/lib/server/daily-reflection/ai-review-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/server/daily-reflection/ai-review-service")
  >("@/lib/server/daily-reflection/ai-review-service");
  return {
    ...actual,
    getDailyReflectionAiReviewService: () => ({
      ensure: state.ensure,
      lookup: state.lookup,
      summary: state.summary,
      markSeen: state.markSeen
    })
  };
});

import { GET, POST } from "./route";
import { GET as getSummary } from "./summary/route";
import { POST as markSeen } from "./[reviewId]/seen/route";

const operation = {
  schemaVersion: 1 as const,
  reviewId: "dr_ai_review_1",
  scope: "daily" as const,
  startDate: "2026-09-01",
  endDate: "2026-09-01",
  status: "queued" as const,
  sourceFingerprint: "a".repeat(64),
  promptVersion: "daily-reflection-ai-review-v1",
  model: "gpt-5.5",
  content: null,
  failureCode: null,
  providerStartedAt: null,
  completedAt: null,
  seenAt: null,
  updatedAt: "2026-09-01T00:00:00.000Z"
};

function post(body: unknown) {
  return POST(new Request("http://localhost/api/daily-reflections/returns/ai-review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
}

describe("Daily Reflection AI review routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.mode = "on";
    state.uploadEnabled = true;
    state.requireAuth.mockResolvedValue({
      user: { id: "account_1", email: "user@example.com" },
      store: {}
    } as AuthContext);
    state.ensure.mockResolvedValue({
      schemaVersion: 1,
      exposureMode: "on",
      scope: "daily",
      referenceDate: "2026-09-01",
      review: operation
    });
    state.lookup.mockResolvedValue({
      schemaVersion: 1,
      exposureMode: "on",
      scope: "daily",
      referenceDate: "2026-09-01",
      review: operation
    });
    state.summary.mockReturnValue({
      schemaVersion: 1,
      exposureMode: "on",
      pendingCount: 1,
      unseenReadyCount: 0,
      items: []
    });
    state.markSeen.mockResolvedValue({ ...operation, status: "ready" });
  });

  it("fails closed before auth and persistence when either feature gate is off", async () => {
    state.mode = "off";
    const aiOff = await post({ scope: "daily", referenceDate: "2026-09-01" });
    state.mode = "on";
    state.uploadEnabled = false;
    const reflectionOff = await GET(new Request(
      "http://localhost/api/daily-reflections/returns/ai-review?scope=daily&referenceDate=2026-09-01"
    ));
    expect(aiOff.status).toBe(404);
    expect(reflectionOff.status).toBe(404);
    expect(state.requireAuth).not.toHaveBeenCalled();
    expect(state.ensure).not.toHaveBeenCalled();
    expect(state.lookup).not.toHaveBeenCalled();
  });

  it("requires the real session and keeps all responses private", async () => {
    state.requireAuth.mockRejectedValueOnce(new Error("unauthenticated"));
    const response = await GET(new Request(
      "http://localhost/api/daily-reflections/returns/ai-review?scope=daily&referenceDate=2026-09-01"
    ));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("accepts only scope/date and derives account, model, Evidence and fingerprint server-side", async () => {
    const injected = await post({
      scope: "daily",
      referenceDate: "2026-09-01",
      accountId: "account_2",
      model: "attacker-model",
      evidence: []
    });
    expect(injected.status).toBe(400);
    expect(state.ensure).not.toHaveBeenCalled();

    const accepted = await post({ scope: "daily", referenceDate: "2026-09-01" });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.ensure).toHaveBeenCalledWith({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01"
    });
    await expect(accepted.json()).resolves.toEqual(operation);
  });

  it("performs read-only lookup with strict query cardinality", async () => {
    const invalid = await GET(new Request(
      "http://localhost/api/daily-reflections/returns/ai-review?scope=daily&scope=weekly&referenceDate=2026-09-01"
    ));
    expect(invalid.status).toBe(400);
    const impossibleDate = await GET(new Request(
      "http://localhost/api/daily-reflections/returns/ai-review?scope=daily&referenceDate=2026-99-99"
    ));
    expect(impossibleDate.status).toBe(400);
    expect(state.lookup).not.toHaveBeenCalled();

    const found = await GET(new Request(
      "http://localhost/api/daily-reflections/returns/ai-review?scope=daily&referenceDate=2026-09-01"
    ));
    expect(found.status).toBe(200);
    expect(state.lookup).toHaveBeenCalledWith({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01"
    });
  });

  it("keeps summary and seen state account-scoped and rejects forged IDs", async () => {
    const summary = await getSummary(new Request(
      "http://localhost/api/daily-reflections/returns/ai-review/summary"
    ));
    expect(summary.status).toBe(200);
    expect(state.summary).toHaveBeenCalledWith("account_1");

    const invalid = await markSeen(
      new Request("http://localhost/api/daily-reflections/returns/ai-review/bad%20id/seen", {
        method: "POST"
      }),
      { params: Promise.resolve({ reviewId: "bad id" }) }
    );
    expect(invalid.status).toBe(404);
    expect(state.markSeen).not.toHaveBeenCalled();

    const seen = await markSeen(
      new Request("http://localhost/api/daily-reflections/returns/ai-review/dr_ai_review_1/seen", {
        method: "POST"
      }),
      { params: Promise.resolve({ reviewId: "dr_ai_review_1" }) }
    );
    expect(seen.status).toBe(200);
    expect(state.markSeen).toHaveBeenCalledWith("account_1", "dr_ai_review_1");
  });

  it("returns a stable conflict when sources disappear before enqueue", async () => {
    state.ensure.mockResolvedValueOnce({
      schemaVersion: 1,
      exposureMode: "on",
      scope: "daily",
      referenceDate: "2026-09-01",
      review: null
    });
    const response = await post({ scope: "daily", referenceDate: "2026-09-01" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "daily_reflection_ai_review_conflict"
    });
  });
});
