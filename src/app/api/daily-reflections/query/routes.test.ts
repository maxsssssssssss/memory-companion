import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  accountId: "account_query_1",
  authenticated: true,
  query: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => {
    if (!state.authenticated) throw new Error("unauthenticated");
    return {
      user: { id: state.accountId, email: `${state.accountId}@example.com` }
    } as AuthContext;
  })
}));

vi.mock("@/lib/server/daily-reflection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/daily-reflection")>()),
  getDailyReflectionQueryService: () => ({ query: state.query })
}));

import { POST } from "./route";

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

function request(body: unknown) {
  return new Request("http://localhost/api/daily-reflections/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function response() {
  return {
    answer: "现有记录里，与这个主题相关的内容是：\n你曾记录：“晨间写作。”",
    intent: "memory_exploration",
    confidence: 0.72,
    insufficientEvidence: false,
    claims: [{
      text: "你曾记录：“晨间写作。”",
      sourceMemoryIds: ["memory_query_1"],
      sourceCardIds: ["card_query_1"],
      evidenceIds: ["segment_query_1"],
      epistemicStatuses: ["explicit_user_statement"],
      evidence: [{
        reflectionId: "reflection_query_1",
        cardId: "card_query_1",
        recordingDate: "2026-08-20",
        sourceOrigin: "user_reflection",
        sourceSegmentId: "segment_query_1",
        startSeconds: 12,
        endSeconds: 18,
        snippet: "晨间写作。"
      }]
    }],
    resurfacing: null,
    createdAt: "2026-08-24T12:00:00.000Z"
  };
}

beforeEach(() => {
  process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  state.accountId = "account_query_1";
  state.authenticated = true;
  vi.clearAllMocks();
  state.query.mockReturnValue(response());
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection query route", () => {
  it("uses only the authenticated account and a strict parsed DTO", async () => {
    const result = await POST(request({
      query: "回顾晨间写作",
      scope: "last_30_days"
    }));
    expect(result.status).toBe(200);
    expect(state.query).toHaveBeenCalledWith("account_query_1", {
      query: "回顾晨间写作",
      scope: "last_30_days"
    });
    const body = await result.json();
    expect(body).not.toHaveProperty("accountId");
    expect(JSON.stringify(body)).not.toContain("provider");
  });

  it("keeps another account isolated at the service boundary", async () => {
    state.accountId = "account_query_2";
    const result = await POST(request({ query: "回顾晨间写作" }));
    expect(result.status).toBe(200);
    expect(state.query).toHaveBeenCalledWith("account_query_2", {
      query: "回顾晨间写作",
      scope: "all"
    });
  });

  it.each([
    {},
    { query: "" },
    { query: "问" },
    { query: "正常问题\u0000隐藏内容" },
    { query: "有效问题", unknown: true },
    { query: "有效问题", personId: "" },
    { query: "有效问题", scope: "current" },
    { query: "问".repeat(513) }
  ])("rejects invalid input without querying sources %#", async (body) => {
    const result = await POST(request(body));
    expect(result.status).toBe(400);
    expect(state.query).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const result = await POST(new Request(
      "http://localhost/api/daily-reflections/query",
      { method: "POST", body: "{" }
    ));
    expect(result.status).toBe(400);
    expect(state.query).not.toHaveBeenCalled();
  });

  it("returns an indistinguishable unauthenticated response", async () => {
    state.authenticated = false;
    const result = await POST(request({ query: "回顾晨间写作" }));
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "unauthenticated" });
    expect(state.query).not.toHaveBeenCalled();
  });

  it("fails closed for malformed service output or source errors", async () => {
    state.query.mockReturnValueOnce({ ...response(), claims: [] });
    const malformed = await POST(request({ query: "回顾晨间写作" }));
    expect(malformed.status).toBe(503);

    state.query.mockImplementationOnce(() => {
      throw new Error("private transcript body must not escape");
    });
    const failed = await POST(request({ query: "回顾晨间写作" }));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("transcript");
  });

  it("keeps the feature flag fail closed", async () => {
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "false";
    const result = await POST(request({ query: "回顾晨间写作" }));
    expect(result.status).toBe(404);
    expect(state.query).not.toHaveBeenCalled();
  });
});
