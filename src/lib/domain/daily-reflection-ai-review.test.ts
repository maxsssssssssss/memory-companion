import { describe, expect, it } from "vitest";

import {
  DailyReflectionAiReviewLookupResponseSchema,
  DailyReflectionAiReviewProviderDraftSchema,
  DailyReflectionAiReviewSummarySchema
} from "./daily-reflection-ai-review";

const timestamp = "2026-09-01T01:00:00.000Z";

describe("Daily Reflection AI review contract", () => {
  it("keeps Provider output strict, bounded, and ID-only", () => {
    const draft = {
      schemaVersion: 1,
      selectedSourceIds: ["source_1"],
      observations: [{
        sourceIds: ["source_1"],
        interpretation: "这是模型推演。",
        followUpQuestion: null
      }]
    } as const;
    expect(DailyReflectionAiReviewProviderDraftSchema.parse(draft)).toEqual(draft);
    expect(DailyReflectionAiReviewProviderDraftSchema.safeParse({
      ...draft,
      observations: [{ ...draft.observations[0], canonicalText: "not allowed" }]
    }).success).toBe(false);
    expect(DailyReflectionAiReviewProviderDraftSchema.safeParse({
      ...draft,
      observations: [{
        ...draft.observations[0],
        sourceIds: ["a", "b", "c", "d", "e"]
      }]
    }).success).toBe(false);
    expect(DailyReflectionAiReviewProviderDraftSchema.safeParse({
      ...draft,
      observations: [{ ...draft.observations[0], sourceIds: ["source_2"] }]
    }).success).toBe(false);
  });

  it("permits shadow status without exposing ready content", () => {
    const response = {
      schemaVersion: 1,
      exposureMode: "shadow",
      scope: "daily",
      referenceDate: "2026-09-01",
      review: {
        schemaVersion: 1,
        reviewId: "review_1",
        scope: "daily",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        status: "ready",
        sourceFingerprint: "a".repeat(64),
        promptVersion: "ai-review-v1",
        model: "gpt",
        content: null,
        failureCode: null,
        providerStartedAt: timestamp,
        completedAt: timestamp,
        seenAt: null,
        updatedAt: timestamp
      }
    } as const;
    expect(DailyReflectionAiReviewLookupResponseSchema.parse(response)).toEqual(response);
    expect(DailyReflectionAiReviewLookupResponseSchema.safeParse({
      ...response,
      review: { ...response.review, status: "processing", content: {} }
    }).success).toBe(false);
  });

  it("exposes only pending and unseen metadata in the summary", () => {
    const summary = {
      schemaVersion: 1,
      exposureMode: "on",
      pendingCount: 2,
      unseenReadyCount: 1,
      items: [{
        reviewId: "review_1",
        scope: "weekly",
        startDate: "2026-08-24",
        endDate: "2026-08-30",
        completedAt: timestamp
      }]
    } as const;
    expect(DailyReflectionAiReviewSummarySchema.parse(summary)).toEqual(summary);
    expect(DailyReflectionAiReviewSummarySchema.safeParse({
      ...summary,
      modelText: "not allowed"
    }).success).toBe(false);
  });
});
