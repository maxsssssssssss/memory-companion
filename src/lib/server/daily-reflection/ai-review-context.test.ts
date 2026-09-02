import { describe, expect, it } from "vitest";

import type {
  DailyReflectionDailyReturnResponse,
  DailyReflectionReturnItem,
  DailyReflectionWeeklyReflectionResponse
} from "@/lib/domain/daily-reflection-return";

import {
  buildDailyReflectionAiReviewContext,
  fingerprintDailyReflectionAiReviewContext,
  projectDailyReflectionAiReviewDraft
} from "./ai-review-context";

const timestamp = "2026-09-01T00:00:00.000Z";

function item(input: {
  id: string;
  type: DailyReflectionReturnItem["type"];
  cardId: string;
  segmentId: string;
  body?: string;
}): DailyReflectionReturnItem {
  return {
    id: input.id,
    type: input.type,
    title: `Title ${input.id}`,
    body: input.body ?? `Body ${input.id}`,
    sourceMemoryIds: [`memory_${input.cardId}`],
    sourceCardIds: [input.cardId],
    evidenceIds: [input.segmentId],
    evidence: [{
      reflectionId: `reflection_${input.cardId}`,
      cardId: input.cardId,
      recordingDate: "2026-09-01",
      sourceOrigin: "user_reflection",
      sourceSegmentId: input.segmentId,
      startSeconds: 1,
      endSeconds: 2,
      snippet: `Snippet ${input.segmentId}`
    }],
    epistemicStatuses: ["explicit_user_statement"],
    createdAt: timestamp
  };
}

function service(daily: DailyReflectionDailyReturnResponse) {
  const emptyWeekly: DailyReflectionWeeklyReflectionResponse = {
    startDate: "2026-08-26",
    endDate: "2026-09-01",
    timeZone: "Asia/Shanghai",
    repeatedThemes: [],
    changedDecisions: [],
    openCommitments: [],
    emergingIdeas: []
  };
  return { daily: () => daily, weekly: () => emptyWeekly };
}

describe("Daily Reflection AI review context", () => {
  it("uses Return authority, drops prompts, and deduplicates repeated Evidence", () => {
    const openLoop = item({
      id: "source_open",
      type: "open_loop",
      cardId: "card_shared",
      segmentId: "segment_shared"
    });
    const context = buildDailyReflectionAiReviewContext({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01",
      promptVersion: "review-v1",
      model: "gpt",
      returnService: service({
        referenceDate: "2026-09-01",
        timeZone: "Asia/Shanghai",
        openLoops: [openLoop],
        resurfacedMemories: [{
          ...openLoop,
          id: "source_duplicate",
          type: "resurfaced_memory"
        }, item({
          id: "source_other",
          type: "resurfaced_memory",
          cardId: "card_other",
          segmentId: "segment_other"
        })],
        reflectionPrompts: [item({
          id: "source_prompt",
          type: "reflection_prompt",
          cardId: "card_prompt",
          segmentId: "segment_prompt"
        })]
      })
    });
    expect(context?.sources.map((source) => source.sourceId).sort()).toEqual([
      "source_open",
      "source_other"
    ]);
    expect(context?.sources.some((source) => source.sourceKind === "reflection_prompt"))
      .toBe(false);
  });

  it("returns null without canonical Return sources", () => {
    expect(buildDailyReflectionAiReviewContext({
      accountId: "account_1",
      scope: "weekly",
      referenceDate: "2026-09-01",
      promptVersion: "review-v1",
      model: "gpt",
      returnService: service({
        referenceDate: "2026-09-01",
        timeZone: "Asia/Shanghai",
        openLoops: [],
        resurfacedMemories: [],
        reflectionPrompts: []
      })
    })).toBeNull();
  });

  it("fingerprints the full authority and projects only allowlisted sources", () => {
    const context = buildDailyReflectionAiReviewContext({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01",
      promptVersion: "review-v1",
      model: "gpt",
      returnService: service({
        referenceDate: "2026-09-01",
        timeZone: "Asia/Shanghai",
        openLoops: [item({
          id: "source_1",
          type: "open_loop",
          cardId: "card_1",
          segmentId: "segment_1"
        })],
        resurfacedMemories: [],
        reflectionPrompts: []
      })
    })!;
    expect(context.sourceFingerprint).toBe(
      fingerprintDailyReflectionAiReviewContext(context)
    );
    const ready = projectDailyReflectionAiReviewDraft({
      context,
      draft: {
        schemaVersion: 1,
        selectedSourceIds: ["source_1"],
        observations: [{
          sourceIds: ["source_1"],
          interpretation: "模型推演",
          followUpQuestion: "是否需要继续？"
        }]
      }
    });
    expect(ready.canonicalSources[0]?.content).toBe("Body source_1");
    expect(ready.observations[0]?.modelInterpretation.kind).toBe("model_inference");
    expect(ready.observations[0]?.followUpQuestion).toBeNull();
    expect(() => projectDailyReflectionAiReviewDraft({
      context,
      draft: {
        schemaVersion: 1,
        selectedSourceIds: ["source_unknown"],
        observations: [{
          sourceIds: ["source_unknown"],
          interpretation: "模型推演",
          followUpQuestion: null
        }]
      }
    })).toThrow(/source_not_allowed/u);
  });

  it("drops a follow-up that presupposes adopting a third-party suggestion", () => {
    const context = buildDailyReflectionAiReviewContext({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01",
      promptVersion: "review-v1",
      model: "gpt",
      returnService: service({
        referenceDate: "2026-09-01",
        timeZone: "Asia/Shanghai",
        openLoops: [],
        resurfacedMemories: [item({
          id: "source_suggestion",
          type: "resurfaced_memory",
          cardId: "card_suggestion",
          segmentId: "segment_suggestion",
          body: "协作者提出了一个展示建议，记录里没有用户采纳这个建议。"
        })],
        reflectionPrompts: []
      })
    })!;
    const unsafeQuestion = "你准备怎样落实已经采用的这个展示方案？";

    const ready = projectDailyReflectionAiReviewDraft({
      context,
      draft: {
        schemaVersion: 1,
        selectedSourceIds: ["source_suggestion"],
        observations: [{
          sourceIds: ["source_suggestion"],
          interpretation: "这个建议可以作为一个待确认的选项。",
          followUpQuestion: unsafeQuestion
        }]
      }
    });

    expect(ready.canonicalSources[0]?.content).toContain("没有用户采纳");
    expect(ready.observations[0]?.modelInterpretation.text).toBe(
      "这个建议可以作为一个待确认的选项。"
    );
    expect(ready.observations[0]?.followUpQuestion).toBeNull();
    expect(JSON.stringify(ready)).not.toContain(unsafeQuestion);
  });
});
