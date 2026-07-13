import { describe, expect, it } from "vitest";
import type { SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { planExtractionChunks } from "./chunks";

function segment(index: number, startSeconds: number, durationSeconds = 12): TranscriptSegment {
  return {
    id: `seg_${index}`,
    uploadId: "upload_long",
    startSeconds,
    endSeconds: startSeconds + durationSeconds,
    speaker: index % 2 === 0 ? "speaker_1" : "speaker_2",
    text: `第 ${index} 段录音内容，包含需要复盘的事实和后续安排。`,
    confidence: 0.9,
    sceneLabels: ["product_discussion"],
    valueLabels: index % 11 === 0 ? ["task"] : []
  };
}

function semantic(index: number, segments: TranscriptSegment[]): SemanticSegment {
  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    id: `semantic_${index}`,
    uploadId: "upload_long",
    title: `主题 ${index}`,
    summary: `第 ${index} 个语义主题`,
    startSeconds: first.startSeconds,
    endSeconds: last.endSeconds,
    tags: ["产品"],
    sceneLabels: ["product_discussion"],
    valueLabels: [],
    confidence: 0.9,
    sourceSegmentIds: segments.map((item) => item.id),
    sourceTimeRange: {
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds
    },
    transcriptExcerpt: first.text
  };
}

describe("planExtractionChunks", () => {
  it.each([
    ["60 seconds", 5],
    ["90 seconds", 7]
  ])("keeps a %s recording in one chunk", (_label, count) => {
    const segments = Array.from({ length: count }, (_, index) => segment(index + 1, index * 12));

    const plan = planExtractionChunks({ segments, semanticSegments: [] });

    expect(plan.longForm).toBe(false);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].segments.map((item) => item.id)).toEqual(segments.map((item) => item.id));
  });

  it("uses four semantic boundaries for a 34 minute 155-segment recording", () => {
    const segments = Array.from({ length: 155 }, (_, index) => segment(index + 1, index * 13.1, 12));
    const groups = [segments.slice(0, 39), segments.slice(39, 75), segments.slice(75, 113), segments.slice(113)];

    const plan = planExtractionChunks({
      segments,
      semanticSegments: groups.map((items, index) => semantic(index + 1, items))
    });

    expect(plan.longForm).toBe(true);
    expect(plan.chunks).toHaveLength(4);
    expect(plan.chunks.map((chunk) => chunk.segments.length)).toEqual([39, 36, 38, 42]);
    expect(plan.chunks.flatMap((chunk) => chunk.segments.map((item) => item.id))).toEqual(
      segments.map((item) => item.id)
    );
    expect(plan.chunks.every((chunk) => chunk.segments.length <= 50)).toBe(true);
    expect(plan.chunks.every((chunk) => chunk.endSeconds - chunk.startSeconds <= 12 * 60)).toBe(true);
    expect(plan.chunks.every((chunk) => chunk.inputChars <= 8_000)).toBe(true);
  });

  it("hard-splits a two-hour synthetic recording without losing or duplicating segments", () => {
    const segments = Array.from({ length: 600 }, (_, index) => segment(index + 1, index * 12, 11));

    const plan = planExtractionChunks({ segments, semanticSegments: [] });
    const plannedIds = plan.chunks.flatMap((chunk) => chunk.segments.map((item) => item.id));

    expect(plan.longForm).toBe(true);
    expect(plan.chunks.length).toBeGreaterThan(10);
    expect(new Set(plannedIds).size).toBe(segments.length);
    expect(plannedIds).toEqual(segments.map((item) => item.id));
    expect(plan.chunks.every((chunk) => chunk.segments.length <= 50)).toBe(true);
    expect(plan.chunks.every((chunk) => chunk.endSeconds - chunk.startSeconds <= 12 * 60)).toBe(true);
    expect(plan.chunks.every((chunk) => chunk.inputChars <= 8_000)).toBe(true);
  });

  it("places transcript segments omitted by semantic groups into chronological chunks", () => {
    const segments = Array.from({ length: 70 }, (_, index) => segment(index + 1, index * 18, 15));
    const semanticSegments = [semantic(1, segments.slice(0, 30)), semantic(2, segments.slice(35))];

    const plan = planExtractionChunks({ segments, semanticSegments });

    expect(plan.chunks.flatMap((chunk) => chunk.segments.map((item) => item.id))).toEqual(
      segments.map((item) => item.id)
    );
  });

  it("keeps an oversized evidence segment atomic and reports the limit exception", () => {
    const oversized = segment(1, 0, 13 * 60);
    oversized.text = "证据".repeat(5_000);
    const filler = Array.from({ length: 61 }, (_, index) => segment(index + 2, 13 * 60 + index * 12));

    const plan = planExtractionChunks({ segments: [oversized, ...filler], semanticSegments: [] });

    expect(plan.chunks[0].segments).toEqual([oversized]);
    expect(plan.chunks[0].exceedsLimits).toBe(true);
    expect(plan.oversizedChunkCount).toBe(1);
  });
});
