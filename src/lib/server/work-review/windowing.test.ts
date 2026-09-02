import { describe, expect, it } from "vitest";

import { buildWorkMeetingTranscriptWindows } from "./windowing";

function segment(index: number, speaker = index % 2 ? "Speaker 2" : "Speaker 1", text = `segment ${index}`) {
  return {
    id: `segment_${index}`,
    uploadId: "upload_1",
    startSeconds: index,
    endSeconds: index + 1,
    speaker,
    text,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

describe("Work Meeting transcript windowing", () => {
  it("creates deterministic bounded windows with canonical Evidence overlap", () => {
    const segments = Array.from({ length: 9 }, (_, index) => segment(index));
    const first = buildWorkMeetingTranscriptWindows(segments, {
      maxSegments: 4,
      maxCharacters: 1_000,
      overlapSegments: 1,
      minimumSegmentsBeforeBoundary: 2
    });
    const second = buildWorkMeetingTranscriptWindows(segments, {
      maxSegments: 4,
      maxCharacters: 1_000,
      overlapSegments: 1,
      minimumSegmentsBeforeBoundary: 2
    });
    expect(second).toEqual(first);
    expect(first.every((window) => window.segments.length <= 4)).toBe(true);
    expect(first.map((window) => window.index)).toEqual(
      Array.from({ length: first.length }, (_, index) => index)
    );
    expect(first.every((window) => window.count === first.length)).toBe(true);
    expect(new Set(first.flatMap((window) => window.evidenceIds))).toEqual(
      new Set(segments.map((item) => item.id))
    );
    expect(first.slice(1).every((window, index) =>
      first[index].evidenceIds.some((id) => window.evidenceIds.includes(id))
    )).toBe(true);
  });

  it("sorts a copy without mutating canonical input", () => {
    const segments = [segment(2), segment(0), segment(1)];
    const originalOrder = segments.map((item) => item.id);
    const windows = buildWorkMeetingTranscriptWindows(segments, {
      maxSegments: 3,
      maxCharacters: 1_000,
      overlapSegments: 0
    });
    expect(windows[0].evidenceIds).toEqual(["segment_0", "segment_1", "segment_2"]);
    expect(segments.map((item) => item.id)).toEqual(originalOrder);
  });

  it("keeps one oversized canonical segment whole instead of inventing duplicate Evidence", () => {
    const windows = buildWorkMeetingTranscriptWindows([
      segment(0, "Speaker 1", "x".repeat(2_000))
    ], {
      maxSegments: 2,
      maxCharacters: 256,
      overlapSegments: 0
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].evidenceIds).toEqual(["segment_0"]);
    expect(windows[0].characterCount).toBeGreaterThan(256);
  });

  it("rejects invalid overlap rather than looping forever", () => {
    expect(() => buildWorkMeetingTranscriptWindows([segment(0)], {
      maxSegments: 1,
      overlapSegments: 1
    })).toThrow("overlapSegments");
  });
});
