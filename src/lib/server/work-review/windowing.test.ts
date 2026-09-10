import { describe, expect, it } from "vitest";

import {
  buildWorkMeetingTranscriptWindows,
  estimateWorkMeetingInputTokens,
  splitWorkMeetingTranscriptWindow
} from "./windowing";

function segment(
  index: number,
  speaker = index % 2 ? "Speaker 2" : "Speaker 1",
  text = `segment ${index}`,
  timeOffset = 0
) {
  return {
    id: `segment_${index}`,
    uploadId: "upload_1",
    startSeconds: index + timeOffset,
    endSeconds: index + timeOffset + 1,
    speaker,
    text,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function expectCanonicalCoverage(
  windows: ReturnType<typeof buildWorkMeetingTranscriptWindows>,
  segments: ReturnType<typeof segment>[]
) {
  expect([...new Set(windows.flatMap((window) => window.evidenceIds))]).toEqual(
    segments.map((item) => item.id)
  );
  expect(windows.flatMap((window) => window.segments).every((item) => {
    const source = segments.find((candidate) => candidate.id === item.id);
    return source?.text === item.text
      && source.startSeconds === item.startSeconds
      && source.endSeconds === item.endSeconds;
  })).toBe(true);
}

describe("Work Meeting transcript windowing", () => {
  it("uses a conservative Work-only estimate for mixed Chinese and ASCII text", () => {
    expect(estimateWorkMeetingInputTokens("中文")).toBe(2);
    expect(estimateWorkMeetingInputTokens("abcd")).toBe(2);
    expect(estimateWorkMeetingInputTokens("中a")).toBe(2);
    expect(estimateWorkMeetingInputTokens("")).toBe(1);
  });

  it("targets 1000 tokens inside the preferred 800-1200 range", () => {
    const segments = Array.from({ length: 60 }, (_, index) =>
      segment(index, `Speaker ${Math.floor(index / 2) % 3}`, "会议更新".repeat(18))
    );
    const windows = buildWorkMeetingTranscriptWindows(segments);

    expect(windows.length).toBeGreaterThan(4);
    expect(windows.slice(0, -1).every((window) =>
      window.estimatedInputTokens >= 800 && window.estimatedInputTokens <= 1_200
    )).toBe(true);
    expect(windows.every((window) =>
      window.segments.length === 1 || window.estimatedInputTokens <= 1_500
    )).toBe(true);
    expect(windows.every((window) => window.segments.length <= 96)).toBe(true);
    expectCanonicalCoverage(windows, segments);
  });

  it("uses token budgets rather than a fixed Segment count for 105 realistic Segments", () => {
    const segments = Array.from({ length: 105 }, (_, index) => {
      const topicPrefix = index > 0 && index % 20 === 0 ? "接下来讨论另一个事项。" : "";
      return segment(
        index,
        `Speaker ${Math.floor(index / 2) % 4}`,
        `${topicPrefix}${"项目进展、风险和下一步安排。".repeat(6 + (index % 3))}`
      );
    });
    const first = buildWorkMeetingTranscriptWindows(segments);
    const second = buildWorkMeetingTranscriptWindows(segments);

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(8);
    expect(first.length).toBeLessThan(20);
    expect(first.slice(0, -1).every((window) =>
      window.estimatedInputTokens >= 800 && window.estimatedInputTokens <= 1_200
    )).toBe(true);
    expect(first.every((window) => window.estimatedInputTokens <= 1_500)).toBe(true);
    expect(first.some((window) => window.segments.length > 8)).toBe(true);
    expectCanonicalCoverage(first, segments);
  });

  it("prefers a complete speaker-turn boundary inside the token range", () => {
    const segments = Array.from({ length: 10 }, (_, index) =>
      segment(index, index < 4 ? "Speaker A" : "Speaker B", "中".repeat(90))
    );
    const windows = buildWorkMeetingTranscriptWindows(segments, {
      targetInputTokens: 550,
      preferredMinInputTokens: 400,
      preferredMaxInputTokens: 650,
      maxInputTokens: 750,
      overlapTurns: 0
    });

    expect(windows[0].evidenceIds).toEqual([
      "segment_0", "segment_1", "segment_2", "segment_3"
    ]);
  });

  it("prefers a pause of at least two seconds inside the token range", () => {
    const segments = Array.from({ length: 10 }, (_, index) =>
      segment(index, "Speaker A", "中".repeat(90), index >= 4 ? 2.5 : 0)
    );
    const windows = buildWorkMeetingTranscriptWindows(segments, {
      targetInputTokens: 550,
      preferredMinInputTokens: 400,
      preferredMaxInputTokens: 650,
      maxInputTokens: 750,
      overlapTurns: 0
    });

    expect(windows[0].evidenceIds.at(-1)).toBe("segment_3");
    expect(windows[1].evidenceIds[0]).toBe("segment_4");
  });

  it("prefers an explicit topic transition inside the token range", () => {
    const segments = Array.from({ length: 10 }, (_, index) =>
      segment(
        index,
        "Speaker A",
        `${index === 4 ? "接下来讨论另一个事项。" : ""}${"中".repeat(90)}`
      )
    );
    const windows = buildWorkMeetingTranscriptWindows(segments, {
      targetInputTokens: 550,
      preferredMinInputTokens: 400,
      preferredMaxInputTokens: 650,
      maxInputTokens: 750,
      overlapTurns: 0
    });

    expect(windows[0].evidenceIds.at(-1)).toBe("segment_3");
    expect(windows[1].evidenceIds[0]).toBe("segment_4");
  });

  it("overlaps only complete speaker turns and supports at most two turns", () => {
    const segments = Array.from({ length: 12 }, (_, index) =>
      segment(index, `Speaker ${Math.floor(index / 2)}`, "short")
    );
    const oneTurn = buildWorkMeetingTranscriptWindows(segments, {
      maxSegments: 6,
      maxCharacters: 10_000,
      targetInputTokens: 1_000,
      preferredMinInputTokens: 800,
      preferredMaxInputTokens: 1_200,
      maxInputTokens: 10_000,
      overlapTurns: 1,
      overlapSegmentHardCap: 4
    });
    const twoTurns = buildWorkMeetingTranscriptWindows(segments, {
      maxSegments: 6,
      maxCharacters: 10_000,
      targetInputTokens: 1_000,
      preferredMinInputTokens: 800,
      preferredMaxInputTokens: 1_200,
      maxInputTokens: 10_000,
      overlapTurns: 2,
      overlapSegmentHardCap: 4
    });

    expect(oneTurn[0].evidenceIds).toEqual([
      "segment_0", "segment_1", "segment_2", "segment_3", "segment_4", "segment_5"
    ]);
    expect(oneTurn[1].evidenceIds.slice(0, 2)).toEqual(["segment_4", "segment_5"]);
    expect(twoTurns[1].evidenceIds.slice(0, 4)).toEqual([
      "segment_2", "segment_3", "segment_4", "segment_5"
    ]);
    expectCanonicalCoverage(oneTurn, segments);
    expectCanonicalCoverage(twoTurns, segments);
  });

  it("degrades unknown speakers to one-Segment turns and caps a long known turn", () => {
    const unknownSegments = Array.from({ length: 10 }, (_, index) =>
      segment(index, index === 4 || index === 5 ? "unknown" : `Speaker ${Math.floor(index / 2)}`)
    );
    const unknownWindows = buildWorkMeetingTranscriptWindows(unknownSegments, {
      maxSegments: 6,
      maxInputTokens: 10_000,
      overlapTurns: 1,
      overlapSegmentHardCap: 3
    });
    const longTurnSegments = Array.from({ length: 10 }, (_, index) =>
      segment(index, "Speaker A")
    );
    const longTurnWindows = buildWorkMeetingTranscriptWindows(longTurnSegments, {
      maxSegments: 6,
      maxInputTokens: 10_000,
      overlapTurns: 1,
      overlapSegmentHardCap: 3
    });

    expect(unknownWindows[1].evidenceIds[0]).toBe("segment_5");
    expect(longTurnWindows[1].evidenceIds[0]).toBe("segment_6");
  });

  it("splits recovery windows without adding duplicate Evidence", () => {
    const [source] = buildWorkMeetingTranscriptWindows(
      Array.from({ length: 10 }, (_, index) => segment(index)),
      {
        maxSegments: 10,
        maxCharacters: 10_000,
        maxInputTokens: 10_000,
        overlapTurns: 0
      }
    );
    const recovered = splitWorkMeetingTranscriptWindow(source);

    expect(recovered).toHaveLength(2);
    expect(recovered.map((window) => window.segments.length)).toEqual([5, 5]);
    expect(recovered.flatMap((window) => window.evidenceIds)).toEqual(source.evidenceIds);
    expect(recovered.reduce((total, window) => total + window.segments.length, 0)).toBe(
      source.segments.length
    );
    expect(recovered.map((window) => [window.index, window.count])).toEqual([
      [0, 2], [1, 2]
    ]);
  });

  it("sorts a copy without mutating canonical input", () => {
    const segments = [segment(2), segment(0), segment(1)];
    const originalOrder = segments.map((item) => item.id);
    const windows = buildWorkMeetingTranscriptWindows(segments, {
      maxSegments: 3,
      maxInputTokens: 10_000,
      overlapTurns: 0
    });
    expect(windows[0].evidenceIds).toEqual(["segment_0", "segment_1", "segment_2"]);
    expect(segments.map((item) => item.id)).toEqual(originalOrder);
  });

  it("keeps one oversized canonical Segment whole", () => {
    const windows = buildWorkMeetingTranscriptWindows([
      segment(0, "Speaker 1", "中".repeat(2_000))
    ], {
      maxCharacters: 256,
      maxInputTokens: 64,
      overlapTurns: 0,
      targetInputTokens: 64,
      preferredMinInputTokens: 64,
      preferredMaxInputTokens: 64
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].evidenceIds).toEqual(["segment_0"]);
    expect(windows[0].estimatedInputTokens).toBeGreaterThan(64);
    expect(windows[0].segments[0].text).toBe("中".repeat(2_000));
  });

  it("rejects invalid token and overlap budgets", () => {
    expect(() => buildWorkMeetingTranscriptWindows([segment(0)], {
      maxInputTokens: 63
    })).toThrow("maxInputTokens");
    expect(() => buildWorkMeetingTranscriptWindows([segment(0)], {
      targetInputTokens: 700,
      preferredMinInputTokens: 800
    })).toThrow("token budgets");
    expect(() => buildWorkMeetingTranscriptWindows([segment(0)], {
      overlapTurns: 3
    })).toThrow("overlapTurns");
  });
});
