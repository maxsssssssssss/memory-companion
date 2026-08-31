import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  accountId: "account_1",
  recommend: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => ({
    user: { id: state.accountId, email: `${state.accountId}@example.com` }
  }) as AuthContext)
}));

vi.mock("@/lib/server/daily-reflection/memory-recommendation-service", () => ({
  getDailyReflectionMemoryRecommendationService: () => ({
    recommend: state.recommend
  })
}));

import { DailyReflectionNotFoundError } from
  "@/lib/server/daily-reflection/repository";
import { GET } from "./route";

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

beforeEach(() => {
  process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  state.accountId = "account_1";
  state.recommend.mockReset();
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection Memory recommendation route", () => {
  it("returns a private, account-scoped, default-unselected recommendation contract", async () => {
    state.recommend.mockReturnValue({
      reflectionId: "reflection_1",
      policyVersion: "daily_reflection_memory_recommendation_v1",
      recommendationFingerprint: "a".repeat(64),
      maxRecommendations: 5,
      eligibleCount: 1,
      recommendations: [{
        cardId: "card_1",
        memoryType: "summary",
        rank: 1,
        score: 0.82,
        clusterId: "cluster_1",
        sourceOrigin: "user_reflection",
        reasons: ["canonical_evidence_valid"],
        defaultSelected: false
      }]
    });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ reflectionId: "reflection_1" })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      maxRecommendations: 5,
      recommendations: [{ cardId: "card_1", defaultSelected: false }]
    });
    expect(state.recommend).toHaveBeenCalledWith({
      accountId: "account_1",
      reflectionId: "reflection_1"
    });
  });

  it("hides a cross-account Reflection as 404", async () => {
    state.recommend.mockImplementation(() => {
      throw new DailyReflectionNotFoundError();
    });
    state.accountId = "account_other";

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ reflectionId: "reflection_1" })
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "daily_reflection_not_found" });
  });

  it("keeps the feature flag fail-closed", async () => {
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "false";
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ reflectionId: "reflection_1" })
    });
    expect(response.status).toBe(404);
    expect(state.recommend).not.toHaveBeenCalled();
  });
});
