import { describe, expect, it } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";

import {
  DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY,
  buildDailyReflectionTranscriptWindows,
  dailyReflectionCardDisplayPlan
} from "./card-pipeline-policy";

function segment(index: number, text: string): TranscriptSegment {
  return {
    id: `segment_${index}`,
    uploadId: "upload_1",
    startSeconds: index * 10,
    endSeconds: index * 10 + 9,
    text,
    confidence: 0.95,
    sceneLabels: [],
    valueLabels: []
  };
}

describe("DailyReflectionCardPipelinePolicy", () => {
  it("windows only at Canonical Segment boundaries and preserves configured overlap", () => {
    const segments = Array.from({ length: 7 }, (_, index) =>
      segment(index, `第 ${index + 1} 段完整文字`.repeat(8))
    );
    const windows = buildDailyReflectionTranscriptWindows({
      segments,
      policy: {
        ...DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY,
        extractionInputTokenBudget: 100,
        segmentOverlapCount: 2
      }
    });
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.flatMap((window) => window.segments).every((item) =>
      segments.some((source) => source.id === item.id && source.text === item.text)
    )).toBe(true);
    for (let index = 1; index < windows.length; index += 1) {
      const previous = windows[index - 1].segments.map((item) => item.id);
      const current = windows[index].segments.map((item) => item.id);
      const overlapCount = Math.min(2, previous.length - 1);
      expect(current.slice(0, overlapCount))
        .toEqual(overlapCount > 0 ? previous.slice(-overlapCount) : []);
    }
  });

  it("keeps an oversized Canonical Segment whole instead of slicing text", () => {
    const oversized = segment(0, "完整长段落".repeat(200));
    const windows = buildDailyReflectionTranscriptWindows({
      segments: [oversized, segment(1, "下一段")],
      policy: {
        ...DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY,
        extractionInputTokenBudget: 20
      }
    });
    expect(windows[0].segments).toEqual([oversized]);
    expect(windows[0].segments[0].text).toBe(oversized.text);
  });

  it.each([
    [180_000, 3, 5, null, null, "compact"],
    [600_000, 5, 9, null, null, "compact"],
    [1_800_000, 6, 8, 4, 2, "topics"],
    [3_600_000, 8, 12, null, null, "overview"],
    [3_600_001, 8, 12, null, null, "chapters"]
  ] as const)("uses the duration tier for %i ms", (
    duration,
    primary,
    maxCards,
    maxClusters,
    maxCardsPerCluster,
    presentation
  ) => {
    expect(dailyReflectionCardDisplayPlan(duration)).toEqual({
      primaryCount: primary,
      maxCards,
      maxClusters,
      maxCardsPerCluster,
      presentation
    });
  });
});
