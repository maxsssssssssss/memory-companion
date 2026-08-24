import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  accountId: "account_1",
  service: {
    get: vi.fn(),
    revoke: vi.fn()
  }
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => ({
    user: { id: state.accountId, email: `${state.accountId}@example.com` }
  }) as AuthContext)
}));

vi.mock("@/lib/server/daily-reflection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/daily-reflection")>()),
  getDailyReflectionWorkingCardMemoryRevocationService: () => state.service
}));

import { GET, POST } from "./[cardId]/revoke/route";

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
const NOW = "2026-08-24T08:00:00.000Z";

function result() {
  return {
    card: {
      id: "card_1",
      accountId: "account_1",
      sourceReflectionIds: ["reflection_1"],
      title: "已确认的决定",
      content: "我决定采用新的计划。",
      cardKind: "decision" as const,
      evidenceIds: ["segment_1"],
      status: "saved" as const,
      importance: 0.9,
      novelty: 0.8,
      relatedCardIds: [],
      tags: [],
      visibility: "private" as const,
      sourceUnavailable: false,
      memoryLifecycleStatus: "revoked" as const,
      memoryLifecycleVersion: 2,
      memoryLifecycleUpdatedAt: NOW,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW
    },
    operation: {
      id: "operation_1",
      accountId: "account_1",
      cardId: "card_1",
      reflectionId: "reflection_1",
      proposalId: "proposal_1",
      authorityConfirmationId: "proposal_1",
      authorityMemoryId: "memory_1",
      operationKey: "daily-reflection-card-revocation:card_1",
      idempotencyKey: "revoke_card_1",
      requestFingerprint: "a".repeat(64),
      requestedMemoryLifecycleVersion: 1,
      status: "completed" as const,
      attemptVersion: 1,
      indexRefreshStatus: "not_required" as const,
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW
    },
    receipt: {
      cardId: "card_1",
      proposalId: "proposal_1",
      outcome: "revoked" as const,
      historicalMemoryId: "memory_1",
      removedMemoryEvidenceCount: 1,
      removedPersonSourceCount: 0,
      createdAt: NOW
    },
    reused: false
  };
}

beforeEach(() => {
  process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  state.accountId = "account_1";
  vi.clearAllMocks();
  state.service.revoke.mockResolvedValue(result());
  state.service.get.mockReturnValue(result());
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Working Card Memory revoke route", () => {
  it("uses an account-scoped versioned request and hides internal authority fields", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        expectedMemoryLifecycleVersion: 1,
        idempotencyKey: "revoke_card_1"
      })
    }), { params: Promise.resolve({ cardId: "card_1" }) });

    expect(response.status).toBe(200);
    expect(state.service.revoke).toHaveBeenCalledWith({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "revoke_card_1"
    });
    const payload = await response.json();
    expect(payload.card).not.toHaveProperty("accountId");
    expect(payload.operation).not.toHaveProperty("operationKey");
    expect(payload.operation).not.toHaveProperty("authorityMemoryId");
  });

  it("recovers the immutable result and does not disclose another account", async () => {
    expect((await GET(new Request("http://localhost"), {
      params: Promise.resolve({ cardId: "card_1" })
    })).status).toBe(200);
    state.accountId = "account_2";
    state.service.get.mockReturnValueOnce(null);
    const crossAccount = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ cardId: "card_1" })
    });
    expect(await crossAccount.json()).toEqual({ found: false });
    expect(state.service.get).toHaveBeenLastCalledWith("account_2", "card_1");
  });

  it("rejects malformed requests before invoking the service", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ expectedMemoryLifecycleVersion: -1 })
    }), { params: Promise.resolve({ cardId: "card_1" }) });
    expect(response.status).toBe(400);
    expect(state.service.revoke).not.toHaveBeenCalled();
  });
});
