import { describe, expect, it } from "vitest";
import type { BriefItem, TranscriptSegment } from "@/lib/domain/types";
import { mergeBriefItems, mergeBriefItemsWithStats } from "./merge";

function segment(index: number): TranscriptSegment {
  return {
    id: `seg_${index}`,
    uploadId: "upload_merge",
    startSeconds: index * 10,
    endSeconds: index * 10 + 8,
    speaker: "speaker_1",
    text: `证据片段 ${index}`,
    confidence: 0.9,
    sceneLabels: ["product_discussion"],
    valueLabels: ["task"]
  };
}

function brief(index: number, overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    id: `temporary_${index}`,
    uploadId: "upload_merge",
    category: "task",
    title: `待办 ${index}`,
    body: `需要跟进第 ${index} 项`,
    priority: "medium",
    confidence: 0.7,
    status: "candidate",
    sourceSegmentIds: [`seg_${index}`],
    sourceTimeRange: {
      startSeconds: index * 10,
      endSeconds: index * 10 + 8
    },
    transcriptExcerpt: `证据片段 ${index}`,
    people: [],
    topics: ["产品"],
    ...overrides
  };
}

describe("mergeBriefItems", () => {
  it("deduplicates the same category and source IDs and keeps the higher confidence item", () => {
    const segments = [segment(1), segment(2)];
    const result = mergeBriefItems({
      uploadId: "upload_merge",
      segments,
      items: [
        brief(1, { title: "低置信度", confidence: 0.5 }),
        brief(99, {
          title: "高置信度",
          confidence: 0.9,
          sourceSegmentIds: ["seg_1"],
          sourceTimeRange: { startSeconds: 0, endSeconds: 1 }
        })
      ]
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "upload_merge_brief_1",
      title: "高置信度",
      sourceSegmentIds: ["seg_1"],
      sourceTimeRange: { startSeconds: 10, endSeconds: 18 }
    });
  });

  it("reports raw, valid, deduplicated, and final item counts", () => {
    const result = mergeBriefItemsWithStats({
      uploadId: "upload_merge",
      segments: [segment(1)],
      items: [
        brief(1, { confidence: 0.5 }),
        brief(2, { confidence: 0.9, sourceSegmentIds: ["seg_1"] }),
        brief(3, { sourceSegmentIds: ["missing"] })
      ]
    });

    expect(result.stats).toEqual({
      rawItemCount: 3,
      validItemCount: 2,
      deduplicatedItemCount: 1,
      finalItemCount: 1
    });
  });

  it("removes invalid source IDs and drops items with no real evidence", () => {
    const result = mergeBriefItems({
      uploadId: "upload_merge",
      segments: [segment(1)],
      items: [
        brief(1, { sourceSegmentIds: ["missing", "seg_1"] }),
        brief(2, { sourceSegmentIds: ["missing"] })
      ]
    });

    expect(result).toHaveLength(1);
    expect(result[0].sourceSegmentIds).toEqual(["seg_1"]);
    expect(result[0].sourceTimeRange).toEqual({ startSeconds: 10, endSeconds: 18 });
  });

  it("selects at most 30 items by priority and confidence, then returns them chronologically", () => {
    const segments = Array.from({ length: 40 }, (_, index) => segment(index + 1));
    const items = segments.map((_, index) =>
      brief(index + 1, {
        priority: index >= 30 ? "high" : "low",
        confidence: index / 40
      })
    );

    const result = mergeBriefItems({ uploadId: "upload_merge", segments, items });

    expect(result).toHaveLength(30);
    expect(result.map((item) => item.sourceSegmentIds[0])).toEqual(
      Array.from({ length: 30 }, (_, index) => `seg_${index + 11}`)
    );
    expect(new Set(result.map((item) => item.id)).size).toBe(30);
    expect(result.map((item) => item.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `upload_merge_brief_${index + 1}`)
    );
  });
});
