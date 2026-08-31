import { describe, expect, it, vi } from "vitest";

import type { ReflectionCard } from "@/lib/domain/daily-reflection";
import type { DailyReflectionWorkingCard } from
  "@/lib/domain/daily-reflection-working-card";

import { DailyReflectionNotFoundError } from "./repository";
import {
  createDailyReflectionMemoryRecommendationService,
  DAILY_REFLECTION_MEMORY_RECOMMENDATION_LIMIT
} from "./memory-recommendation-service";

const NOW = "2026-08-27T08:00:00.000Z";

function workingCard(index: number, overrides: Partial<DailyReflectionWorkingCard> = {}) {
  return {
    id: `card_${index}`,
    accountId: "account_1",
    sourceReflectionIds: ["reflection_1"],
    title: `Card ${index}`,
    content: `值得长期保留的内容 ${index}`,
    cardKind: index % 4 === 0 ? "question" as const : "insight" as const,
    evidenceIds: [`segment_${index}`],
    status: "saved" as const,
    importance: Math.max(0.1, 1 - index * 0.04),
    novelty: Math.max(0.1, 0.9 - index * 0.03),
    relatedCardIds: [],
    tags: [],
    visibility: "private" as const,
    sourceUnavailable: false,
    memoryLifecycleStatus: "not_admitted" as const,
    memoryLifecycleVersion: 0,
    memoryLifecycleUpdatedAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } satisfies DailyReflectionWorkingCard;
}

function reflectionCard(
  card: DailyReflectionWorkingCard,
  index: number,
  overrides: Partial<ReflectionCard> = {}
): ReflectionCard {
  return {
    id: card.id,
    reflectionId: "reflection_1",
    cardKind: card.cardKind === "question" ? "open_question" as const : "insight" as const,
    proposedTitle: card.title,
    proposedText: card.content,
    userTitle: null,
    userText: null,
    sourceCandidateIds: [`candidate_${index}`],
    evidenceIds: [...card.evidenceIds],
    clusterId: `cluster_${index % 4}`,
    clusterTitle: `Cluster ${index % 4}`,
    displayTier: "primary" as const,
    rank: index,
    confidence: 0.9,
    importance: card.importance,
    durability: Math.max(0.1, 0.85 - index * 0.02),
    novelty: card.novelty,
    epistemicStatus: "explicit_user_statement" as const,
    riskFlags: [],
    actionClaimed: false,
    reviewStatus: "pending" as const,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function harness(inputCards: DailyReflectionWorkingCard[]) {
  const sourceCards = inputCards.map((card, index) => reflectionCard(card, index));
  const repository = {
    getReflection: vi.fn(() => ({
      id: "reflection_1",
      accountId: "account_1",
      uploadId: "upload_1",
      status: "completed"
    })),
    getProcessingPlan: vi.fn(() => ({
      uploadId: "upload_1",
      sourceOrigin: "user_reflection"
    })),
    listReflectionCards: vi.fn(() => sourceCards),
    listWorkingCards: vi.fn((input: { offset: number; limit: number }) => ({
      cards: inputCards.slice(input.offset, input.offset + input.limit),
      total: inputCards.length,
      limit: input.limit,
      offset: input.offset
    })),
    readWorkingCardWithEvidence: vi.fn((_accountId: string, cardId: string) => {
      const card = inputCards.find((item) => item.id === cardId)!;
      return {
        card,
        evidence: card.id === "card_missing_evidence"
          ? []
          : card.evidenceIds.map((sourceSegmentId) => ({
            sourceSegmentId,
            uploadId: "upload_1",
            effectiveOrigin: "user_reflection",
            startSeconds: 0,
            endSeconds: 5,
            text: "canonical Evidence"
          }))
      };
    })
  };
  return {
    repository,
    sourceCards,
    service: createDailyReflectionMemoryRecommendationService({
      repository: repository as never
    })
  };
}

describe("Daily Reflection Memory recommendation service", () => {
  it("returns at most five stable, unselected recommendations with cluster coverage", () => {
    const cards = Array.from({ length: 12 }, (_, index) => workingCard(index + 1));
    const fixture = harness(cards);

    const first = fixture.service.recommend({
      accountId: "account_1",
      reflectionId: "reflection_1"
    });
    const replay = fixture.service.recommend({
      accountId: "account_1",
      reflectionId: "reflection_1"
    });

    expect(first).toEqual(replay);
    expect(first.maxRecommendations).toBe(DAILY_REFLECTION_MEMORY_RECOMMENDATION_LIMIT);
    expect(first.recommendations).toHaveLength(5);
    expect(first.recommendations.every((item) => item.defaultSelected === false)).toBe(true);
    expect(first.recommendations.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(first.recommendations.slice(0, 4).map((item) => item.clusterId)).size)
      .toBe(4);
  });

  it("deduplicates equivalent content without making non-recommended Cards ineligible", () => {
    const original = workingCard(1);
    const duplicate = workingCard(2, {
      title: original.title,
      content: original.content
    });
    const fixture = harness([original, duplicate, workingCard(3)]);
    const result = fixture.service.recommend({
      accountId: "account_1",
      reflectionId: "reflection_1"
    });

    expect(result.eligibleCount).toBe(2);
    expect(result.recommendations).toHaveLength(2);
    expect(fixture.repository.readWorkingCardWithEvidence).toHaveBeenCalledTimes(3);
  });

  it("recommends saved pending Cards but excludes source Cards explicitly excluded by the user", () => {
    const fixture = harness([workingCard(1), workingCard(2)]);
    fixture.sourceCards[1]!.reviewStatus = "excluded";

    const result = fixture.service.recommend({
      accountId: "account_1",
      reflectionId: "reflection_1"
    });

    expect(result.eligibleCount).toBe(1);
    expect(result.recommendations).toEqual([
      expect.objectContaining({ cardId: "card_1", defaultSelected: false })
    ]);
  });

  it("recommends review-pending generated Cards without selecting or saving them", () => {
    const fixture = harness([
      workingCard(1, { status: "review_pending" }),
      workingCard(2, { status: "generated", cardKind: "action" }),
      workingCard(3, { status: "generated" })
    ]);
    fixture.repository.getReflection.mockReturnValue({
      id: "reflection_1",
      accountId: "account_1",
      uploadId: "upload_1",
      status: "review_pending"
    });
    fixture.sourceCards[1]!.cardKind = "user_action";
    fixture.sourceCards[1]!.actionClaimed = false;
    fixture.sourceCards[2]!.reviewStatus = "excluded";

    const result = fixture.service.recommend({
      accountId: "account_1",
      reflectionId: "reflection_1"
    });

    expect(result.eligibleCount).toBe(1);
    expect(result.recommendations).toEqual([
      expect.objectContaining({
        cardId: "card_1",
        defaultSelected: false,
        reasons: expect.arrayContaining(["generated_reflection_card"])
      })
    ]);
  });

  it("returns zero when every Card fails a hard source, lifecycle, Evidence, or action gate", () => {
    const cards = [
      workingCard(1, { sourceUnavailable: true }),
      workingCard(2, { memoryLifecycleStatus: "revoked" }),
      workingCard(3, {
        id: "card_missing_evidence",
        evidenceIds: ["segment_missing"]
      }),
      workingCard(4, { cardKind: "action" })
    ];
    const fixture = harness(cards);
    fixture.sourceCards[0]!.reviewStatus = "excluded";
    fixture.sourceCards[3]!.cardKind = "user_action";
    fixture.sourceCards[3]!.actionClaimed = false;

    const result = fixture.service.recommend({
      accountId: "account_1",
      reflectionId: "reflection_1"
    });

    expect(result.eligibleCount).toBe(0);
    expect(result.recommendations).toEqual([]);
  });

  it("fails closed for a cross-account or tombstoned Reflection", () => {
    const fixture = harness([workingCard(1)]);
    fixture.repository.getReflection.mockImplementation(() => {
      throw new DailyReflectionNotFoundError();
    });
    expect(() => fixture.service.recommend({
      accountId: "account_other",
      reflectionId: "reflection_1"
    })).toThrow(DailyReflectionNotFoundError);

    fixture.repository.getReflection.mockReturnValue({
      id: "reflection_1",
      accountId: "account_1",
      uploadId: "upload_1",
      status: "deleted"
    });
    expect(() => fixture.service.recommend({
      accountId: "account_1",
      reflectionId: "reflection_1"
    })).toThrow(DailyReflectionNotFoundError);
  });
});
