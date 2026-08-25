import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  accountId: "account_1",
  anonymous: false,
  listAccounts: [] as string[],
  detailCalls: [] as Array<[string, string]>
}));

const memory = {
  id: "memory_1",
  cardId: "card_1",
  reflectionId: "reflection_1",
  recordingDate: "2026-08-13",
  memoryType: "decision" as const,
  cardKind: "decision" as const,
  epistemicStatus: "explicit_user_statement" as const,
  epistemicCaution: null,
  title: "决定先完成一个小版本",
  content: "先把最小版本完成，再继续扩展。",
  sourceCount: 1,
  evidence: [{
    reflectionId: "reflection_1",
    cardId: "card_1",
    recordingDate: "2026-08-13",
    sourceOrigin: "user_reflection" as const,
    sourceSegmentId: "segment_1",
    startSeconds: 4,
    endSeconds: 12,
    snippet: "我决定先完成一个小版本。"
  }]
};

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => {
    if (state.anonymous) throw new Error("unauthenticated");
    return {
      user: { id: state.accountId, email: `${state.accountId}@example.com` }
    } as AuthContext;
  })
}));

vi.mock("@/lib/server/daily-reflection/memory-view", () => ({
  listDailyReflectionMemories: (accountId: string) => {
    state.listAccounts.push(accountId);
    return accountId === "account_1"
      ? { memories: [memory], total: 1 }
      : { memories: [], total: 0 };
  },
  getDailyReflectionMemory: (accountId: string, memoryId: string) => {
    state.detailCalls.push([accountId, memoryId]);
    return accountId === "account_1" && memoryId === memory.id ? { memory } : null;
  }
}));

import { GET as getMemory } from "./[memoryId]/route";
import { GET as listMemories } from "./route";

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

beforeEach(() => {
  process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  state.accountId = "account_1";
  state.anonymous = false;
  state.listAccounts.length = 0;
  state.detailCalls.length = 0;
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection memory view routes", () => {
  it("uses the authenticated account and keeps responses private", async () => {
    const list = await listMemories(new Request("http://localhost/api/daily-reflections/memories"));
    const detail = await getMemory(
      new Request("http://localhost/api/daily-reflections/memories/memory_1"),
      { params: Promise.resolve({ memoryId: "memory_1" }) }
    );

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(detail.headers.get("cache-control")).toBe("private, no-store");
    expect(state.listAccounts).toEqual(["account_1"]);
    expect(state.detailCalls).toEqual([["account_1", "memory_1"]]);
    expect(await list.json()).not.toHaveProperty("accountId");
  });

  it("returns an isolated empty list and 404 for another account", async () => {
    state.accountId = "account_2";
    const list = await listMemories(new Request("http://localhost/api/daily-reflections/memories"));
    const detail = await getMemory(
      new Request("http://localhost/api/daily-reflections/memories/memory_1"),
      { params: Promise.resolve({ memoryId: "memory_1" }) }
    );

    expect(await list.json()).toEqual({ memories: [], total: 0 });
    expect(detail.status).toBe(404);
    expect(state.detailCalls).toEqual([["account_2", "memory_1"]]);
  });

  it("fails closed for anonymous, disabled, and invalid requests", async () => {
    state.anonymous = true;
    expect((await listMemories(new Request("http://localhost/api/daily-reflections/memories"))).status)
      .toBe(401);

    state.anonymous = false;
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "false";
    expect((await listMemories(new Request("http://localhost/api/daily-reflections/memories"))).status)
      .toBe(404);

    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    const invalid = await getMemory(
      new Request("http://localhost/api/daily-reflections/memories/%20"),
      { params: Promise.resolve({ memoryId: " " }) }
    );
    expect(invalid.status).toBe(404);
  });
});
