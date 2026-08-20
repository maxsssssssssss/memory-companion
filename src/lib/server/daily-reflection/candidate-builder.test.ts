// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { SourceOrigin } from "@/lib/domain/daily-reflection";
import type { TranscriptSegment } from "@/lib/domain/types";

import {
  DailyReflectionCandidateBuildError,
  buildDailyReflectionCandidates
} from "./candidate-builder";

function segment(
  id: string,
  startSeconds: number,
  text: string,
  uploadId = "upload_reflection"
): TranscriptSegment {
  return {
    id,
    uploadId,
    startSeconds,
    endSeconds: startSeconds + 1,
    speaker: "speaker_1",
    text,
    confidence: 0.98,
    sceneLabels: [],
    valueLabels: []
  };
}

function build(
  segments: TranscriptSegment[],
  sourceOrigin: SourceOrigin = "direct_conversation",
  processingProfile: "full_recording" | "quick_reflection" = "full_recording"
) {
  return buildDailyReflectionCandidates({
    segments,
    sourceOrigin,
    processingProfile
  });
}

describe("Daily Reflection candidate builder", () => {
  it.each(["user_reflection", "unknown"] as const)(
    "preserves hedges and does not upgrade %s text into a third-party fact",
    (sourceOrigin) => {
      const text = "我觉得小周可能只是有点忙，也许不是不想回复。";

      const [candidate] = build([segment("hedged_source", 0, text)], sourceOrigin);

      expect(candidate.proposedText).toBe(text);
      expect(candidate.proposedText).toContain("我觉得");
      expect(candidate.proposedText).toContain("可能");
      expect(candidate.proposedText).toContain("也许");
      expect(candidate.candidateType).toBe("summary");
      expect(candidate.sourceSegmentIds).toEqual(["hedged_source"]);
    }
  );

  it.each(["user_reflection", "unknown"] as const)(
    "keeps an apparent third-party event neutral for %s",
    (sourceOrigin) => {
      const text = "小周昨天完成了方案。";

      const [candidate] = build([segment("third_party_source", 0, text)], sourceOrigin);

      expect(candidate).toMatchObject({
        proposedText: text,
        candidateType: "summary",
        sourceSegmentIds: ["third_party_source"]
      });
    }
  );

  it("uses only real source segment ids and merges exact duplicate evidence", () => {
    const segments = [
      segment("source_later", 20, "我会在周五前发送草稿。"),
      segment("source_first", 10, "我会在周五前发送草稿。")
    ];

    const candidates = build(segments);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      ordinal: 0,
      candidateType: "commitment",
      proposedText: "我会在周五前发送草稿。",
      sourceSegmentIds: ["source_first", "source_later"]
    });
    expect(candidates[0].sourceSegmentIds.every(
      (sourceId) => segments.some((item) => item.id === sourceId)
    )).toBe(true);
  });

  it("keeps every candidate from a full recording when there are more than three", () => {
    const segments = Array.from({ length: 6 }, (_, index) =>
      segment(`source_${index}`, index, `第 ${index + 1} 条独立记录。`)
    );

    const fullRecording = build(segments, "direct_conversation", "full_recording");
    const quickReflection = build(segments, "direct_conversation", "quick_reflection");

    expect(fullRecording).toHaveLength(6);
    expect(fullRecording.map((candidate) => candidate.sourceSegmentIds[0])).toEqual([
      "source_0",
      "source_1",
      "source_2",
      "source_3",
      "source_4",
      "source_5"
    ]);
    expect(quickReflection).toHaveLength(3);
  });

  it("has stable order, deterministic ids, and no input mutation", () => {
    const chronological = [
      segment("source_question", 10, "我们什么时候再确认？"),
      segment("source_preference", 20, "我更愿意周末处理。"),
      segment("source_event", 30, "昨天完成了第一版。")
    ];
    const reversed = [...chronological].reverse();
    const reversedSnapshot = structuredClone(reversed);

    const first = build(reversed);
    const second = build(chronological);

    expect(first).toEqual(second);
    expect(first.map((candidate) => candidate.candidateType)).toEqual([
      "question",
      "preference",
      "event"
    ]);
    expect(new Set(first.map((candidate) => candidate.id)).size).toBe(3);
    expect(reversed).toEqual(reversedSnapshot);
  });

  it("fails closed when no transcript evidence is available", () => {
    expect(() => build([])).toThrow(DailyReflectionCandidateBuildError);

    try {
      build([]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "daily_reflection_segments_required"
      });
    }
  });
});
