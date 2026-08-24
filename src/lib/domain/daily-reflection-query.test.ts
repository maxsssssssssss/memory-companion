import { describe, expect, it } from "vitest";

import { DailyReflectionQueryResponseSchema } from "./daily-reflection-query";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    reflectionId: "reflection_query_schema",
    cardId: "card_query_schema",
    recordingDate: "2026-08-20",
    sourceOrigin: "user_reflection",
    sourceSegmentId: "segment_query_schema",
    startSeconds: 10,
    endSeconds: 16,
    snippet: "我记录了晨间写作。",
    ...overrides
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    answer: "现有记录里有一条晨间写作记录。",
    intent: "memory_exploration",
    confidence: 0.65,
    insufficientEvidence: false,
    claims: [{
      text: "你曾记录晨间写作。",
      sourceMemoryIds: ["memory_query_schema"],
      sourceCardIds: ["card_query_schema"],
      evidenceIds: ["segment_query_schema"],
      evidence: [evidence()],
      epistemicStatuses: ["explicit_user_statement"]
    }],
    resurfacing: null,
    createdAt: "2026-08-24T12:00:00.000Z",
    ...overrides
  };
}

describe("Daily Reflection explainable query DTO", () => {
  it("accepts an exact grounded response", () => {
    expect(DailyReflectionQueryResponseSchema.parse(response()))
      .toEqual(response());
  });

  it("rejects a source Card without Claim Evidence", () => {
    const value = response();
    (value.claims[0] as { sourceCardIds: string[] }).sourceCardIds.push(
      "card_without_evidence"
    );
    expect(DailyReflectionQueryResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects resurfacing for an insufficient answer", () => {
    const source = evidence();
    const value = response({
      answer: "没有足够证据。",
      confidence: 0,
      insufficientEvidence: true,
      claims: [],
      resurfacing: {
        title: "不应出现",
        body: "不应出现的提示。",
        earliestDate: "2026-08-20",
        evidence: source
      }
    });
    expect(DailyReflectionQueryResponseSchema.safeParse(value).success).toBe(false);
  });

  it("requires resurfacing to reuse exact Claim Evidence and date", () => {
    const value = response({
      resurfacing: {
        title: "再次出现",
        body: "这个主题曾再次出现。",
        earliestDate: "2026-08-19",
        evidence: evidence({ snippet: "被替换的文字。" })
      }
    });
    expect(DailyReflectionQueryResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects one Segment ID mapped to different authorities", () => {
    const value = response();
    value.claims.push({
      text: "另一条冲突来源。",
      sourceMemoryIds: [],
      sourceCardIds: ["card_conflict"],
      evidenceIds: ["segment_query_schema"],
      evidence: [evidence({
        reflectionId: "reflection_conflict",
        cardId: "card_conflict"
      })],
      epistemicStatuses: ["explicit_user_statement"]
    });
    expect(DailyReflectionQueryResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects AI inference and unknown factual Claims", () => {
    for (const epistemicStatus of ["ai_inference", "unknown"] as const) {
      const value = response();
      value.claims[0]!.epistemicStatuses = [epistemicStatus];
      expect(DailyReflectionQueryResponseSchema.safeParse(value).success).toBe(false);
    }
  });
});
