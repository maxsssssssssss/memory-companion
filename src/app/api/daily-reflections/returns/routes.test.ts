import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  accountId: "account_1",
  service: { daily: vi.fn(), weekly: vi.fn() }
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => ({
    user: { id: state.accountId, email: `${state.accountId}@example.com` }
  }) as AuthContext)
}));

vi.mock("@/lib/server/daily-reflection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/daily-reflection")>()),
  getDailyReflectionReturnService: () => state.service
}));

import { GET as getDaily } from "./daily/route";
import { GET as getWeekly } from "./weekly/route";

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

beforeEach(() => {
  process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  state.accountId = "account_1";
  vi.clearAllMocks();
  state.service.daily.mockReturnValue({
    referenceDate: "2026-08-24",
    timeZone: "Asia/Shanghai",
    openLoops: [], resurfacedMemories: [], reflectionPrompts: []
  });
  state.service.weekly.mockReturnValue({
    startDate: "2026-08-18",
    endDate: "2026-08-24",
    timeZone: "Asia/Shanghai",
    repeatedThemes: [], changedDecisions: [], openCommitments: [], emergingIdeas: []
  });
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Return and Weekly Reflection routes", () => {
  it("uses authenticated account scope and server-owned date boundaries", async () => {
    const daily = await getDaily(new Request(
      "http://localhost/api/daily-reflections/returns/daily?date=2026-08-24"
    ));
    const weekly = await getWeekly(new Request(
      "http://localhost/api/daily-reflections/returns/weekly?endDate=2026-08-24"
    ));
    expect(daily.status).toBe(200);
    expect(weekly.status).toBe(200);
    expect(state.service.daily).toHaveBeenCalledWith("account_1", "2026-08-24");
    expect(state.service.weekly).toHaveBeenCalledWith("account_1", "2026-08-24");
    expect(await daily.json()).not.toHaveProperty("accountId");
  });

  it("keeps another account on an isolated empty projection", async () => {
    state.accountId = "account_2";
    const response = await getDaily(new Request(
      "http://localhost/api/daily-reflections/returns/daily"
    ));
    expect(response.status).toBe(200);
    expect(state.service.daily).toHaveBeenCalledWith("account_2", undefined);
  });

  it("rejects unknown, repeated, and invalid date query parameters", async () => {
    for (const request of [
      new Request("http://localhost/api/daily-reflections/returns/daily?date=2026-08-24&date=2026-08-23"),
      new Request("http://localhost/api/daily-reflections/returns/daily?unknown=1"),
      new Request("http://localhost/api/daily-reflections/returns/weekly?endDate=not-a-date")
    ]) {
      const response = request.url.includes("weekly")
        ? await getWeekly(request)
        : await getDaily(request);
      expect(response.status).toBe(400);
    }
    expect(state.service.daily).not.toHaveBeenCalled();
    expect(state.service.weekly).not.toHaveBeenCalled();
  });
});
