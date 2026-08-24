import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  accountId: "account_1",
  repository: {
    listWorkingCards: vi.fn(),
    getWorkingCardWithEvidence: vi.fn(),
    saveWorkingCardFromReflection: vi.fn(),
    updateWorkingCard: vi.fn(),
    archiveWorkingCard: vi.fn(),
    restoreWorkingCard: vi.fn(),
    removeWorkingCard: vi.fn()
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
  getDailyReflectionRepository: () => state.repository
}));

import { DailyReflectionNotFoundError } from "@/lib/server/daily-reflection";
import { GET as listCards } from "./route";
import {
  DELETE as removeCard,
  GET as getCard,
  PATCH as updateCard
} from "./[cardId]/route";
import { POST as archiveCard } from "./[cardId]/archive/route";
import { POST as restoreCard } from "./[cardId]/restore/route";
import { POST as saveCard } from "../[reflectionId]/cards/[cardId]/save/route";

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

function workingCard(status: "saved" | "archived" | "removed" = "saved") {
  return {
    id: "card_1",
    accountId: "account_1",
    sourceReflectionIds: ["reflection_1"],
    title: "一个工作卡片",
    content: "保留可核对的原始依据。",
    cardKind: "insight" as const,
    evidenceIds: ["segment_1"],
    status,
    importance: 0.8,
    novelty: 0.7,
    relatedCardIds: [],
    tags: [],
    visibility: "private" as const,
    sourceUnavailable: false,
    version: status === "saved" ? 1 : 2,
    createdAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:00:00.000Z"
  };
}

function withEvidence(status: "saved" | "archived" | "removed" = "saved") {
  return {
    card: workingCard(status),
    evidence: [{
      sourceSegmentId: "segment_1",
      uploadId: "upload_1",
      effectiveOrigin: "user_reflection" as const,
      startSeconds: 0,
      endSeconds: 8,
      text: "原始复盘依据。"
    }]
  };
}

beforeEach(() => {
  process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  state.accountId = "account_1";
  vi.clearAllMocks();
  state.repository.listWorkingCards.mockReturnValue({
    cards: [workingCard()], total: 1, limit: 24, offset: 0
  });
  state.repository.getWorkingCardWithEvidence.mockReturnValue(withEvidence());
  state.repository.saveWorkingCardFromReflection.mockReturnValue(workingCard());
  state.repository.updateWorkingCard.mockReturnValue(workingCard());
  state.repository.archiveWorkingCard.mockReturnValue(workingCard("archived"));
  state.repository.restoreWorkingCard.mockReturnValue(workingCard());
  state.repository.removeWorkingCard.mockReturnValue(workingCard("removed"));
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection Working Card routes", () => {
  it("lists only account-scoped product fields with strict filters", async () => {
    const response = await listCards(new Request(
      "http://localhost/api/daily-reflections/cards?type=insight&q=30%25&status=saved&limit=10&offset=2"
    ));
    expect(response.status).toBe(200);
    expect(state.repository.listWorkingCards).toHaveBeenCalledWith({
      accountId: "account_1",
      cardKind: "insight",
      query: "30%",
      status: "saved",
      sort: "updated_desc",
      limit: 10,
      offset: 2
    });
    const payload = await response.json();
    expect(payload.cards[0]).not.toHaveProperty("accountId");
    expect(payload.cards[0]).not.toHaveProperty("sourceCandidateIds");
    expect(payload.cards[0]).not.toHaveProperty("confidence");
  });

  it("keeps save, update, archive, restore, and remove strictly versioned", async () => {
    const saved = await saveCard(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ expectedVersion: 0 })
      }),
      { params: Promise.resolve({ reflectionId: "reflection_1", cardId: "card_1" }) }
    );
    expect(saved.status).toBe(200);
    expect(state.repository.saveWorkingCardFromReflection).toHaveBeenCalledWith({
      accountId: "account_1",
      reflectionId: "reflection_1",
      cardId: "card_1",
      expectedVersion: 0
    });

    const updated = await updateCard(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersion: 1,
          title: "更新标题",
          content: "更新内容"
        })
      }),
      { params: Promise.resolve({ cardId: "card_1" }) }
    );
    expect(updated?.status).toBe(200);
    expect(state.repository.updateWorkingCard).toHaveBeenCalledWith({
      accountId: "account_1",
      cardId: "card_1",
      expectedVersion: 1,
      title: "更新标题",
      content: "更新内容"
    });

    for (const [handler, method] of [
      [archiveCard, "archiveWorkingCard"],
      [restoreCard, "restoreWorkingCard"]
    ] as const) {
      const response = await handler(
        new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ expectedVersion: 2 })
        }),
        { params: Promise.resolve({ cardId: "card_1" }) }
      );
      expect(response.status).toBe(200);
      expect(state.repository[method]).toHaveBeenCalledWith({
        accountId: "account_1",
        cardId: "card_1",
        expectedVersion: 2
      });
    }
    const removed = await removeCard(
      new Request("http://localhost", {
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: 1 })
      }),
      { params: Promise.resolve({ cardId: "card_1" }) }
    );
    expect(removed?.status).toBe(200);
    expect(state.repository.removeWorkingCard).toHaveBeenCalledWith({
      accountId: "account_1",
      cardId: "card_1",
      expectedVersion: 1
    });
  });

  it("returns 404 for cross-account list/get/update/archive/restore/remove targets", async () => {
    state.accountId = "account_2";
    state.repository.listWorkingCards.mockReturnValue({ cards: [], total: 0, limit: 24, offset: 0 });
    const listResponse = await listCards(new Request("http://localhost/api/daily-reflections/cards"));
    expect(await listResponse.json()).toMatchObject({ cards: [], total: 0 });
    expect(state.repository.listWorkingCards).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_2"
    }));

    for (const method of [
      "getWorkingCardWithEvidence",
      "updateWorkingCard",
      "archiveWorkingCard",
      "restoreWorkingCard",
      "removeWorkingCard"
    ] as const) {
      state.repository[method].mockImplementationOnce(() => {
        throw new DailyReflectionNotFoundError();
      });
    }
    const requests = [
      getCard(new Request("http://localhost"), { params: Promise.resolve({ cardId: "card_1" }) }),
      updateCard(new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, title: "越权" })
      }), { params: Promise.resolve({ cardId: "card_1" }) }),
      archiveCard(new Request("http://localhost", {
        method: "POST", body: JSON.stringify({ expectedVersion: 1 })
      }), { params: Promise.resolve({ cardId: "card_1" }) }),
      restoreCard(new Request("http://localhost", {
        method: "POST", body: JSON.stringify({ expectedVersion: 1 })
      }), { params: Promise.resolve({ cardId: "card_1" }) }),
      removeCard(new Request("http://localhost", {
        method: "DELETE", body: JSON.stringify({ expectedVersion: 1 })
      }), { params: Promise.resolve({ cardId: "card_1" }) })
    ];
    for (const response of await Promise.all(requests)) expect(response?.status).toBe(404);
  });
});
