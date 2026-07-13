import { describe, expect, it } from "vitest";

import { applySpeakerAliasesToPayload, replaceSpeakerIdsForUpload } from "./speaker-aliases";
import type { AudioInsight, BriefItem, TranscriptSegment } from "./types";

function segment(uploadId: string): TranscriptSegment {
  return {
    id: `${uploadId}_seg_1`,
    uploadId,
    startSeconds: 0,
    endSeconds: 30,
    speaker: "speaker_1",
    text: "speaker_1 说今天要确认方案。",
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: ["task"]
  };
}

function insight(uploadId: string): AudioInsight {
  return {
    id: `${uploadId}_insight_1`,
    uploadId,
    sourceSegmentIds: [`${uploadId}_seg_1`],
    sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
    speaker: { id: "speaker_1", role: "unknown", confidence: 0.5 },
    voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.4 },
    toneLabels: ["firm"],
    emotionLabels: ["neutral"],
    interactionLabels: ["decision_moment"],
    summary: "speaker_1 明确推进方案。",
    evidence: "speaker_1 说今天要确认方案。",
    confidence: 0.7
  };
}

function brief(uploadId: string): BriefItem {
  return {
    id: `${uploadId}_brief_1`,
    uploadId,
    category: "task",
    title: "speaker_1 确认方案",
    body: "speaker_1 今天要确认方案。",
    priority: "high",
    confidence: 0.9,
    status: "confirmed",
    sourceSegmentIds: [`${uploadId}_seg_1`],
    sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
    transcriptExcerpt: "speaker_1 说今天要确认方案。",
    people: ["speaker_1"],
    topics: ["方案"]
  };
}

describe("speaker aliases", () => {
  it("applies aliases by upload id without overwriting original segment speaker ids", () => {
    const payload = {
      segments: [segment("upload_a"), segment("upload_b")],
      audioInsights: [insight("upload_a"), insight("upload_b")],
      semanticSegments: [],
      briefItems: [brief("upload_a"), brief("upload_b")]
    };

    const result = applySpeakerAliasesToPayload(payload, {
      upload_a: { speaker_1: "张三" },
      upload_b: { speaker_1: "李四" }
    });

    expect(result.segments.map((item) => [item.uploadId, item.speaker])).toEqual([
      ["upload_a", "speaker_1"],
      ["upload_b", "speaker_1"]
    ]);
    expect(result.audioInsights.map((item) => [item.uploadId, item.speaker.displayName, item.summary])).toEqual([
      ["upload_a", "张三", "张三 明确推进方案。"],
      ["upload_b", "李四", "李四 明确推进方案。"]
    ]);
    expect(result.briefItems.map((item) => [item.uploadId, item.people[0], item.title])).toEqual([
      ["upload_a", "张三", "张三 确认方案"],
      ["upload_b", "李四", "李四 确认方案"]
    ]);
  });

  it("does not replace speaker ids inside longer speaker ids", () => {
    const result = replaceSpeakerIdsForUpload(
      "upload_a",
      "speaker_10 先说，speaker_1 后说，speaker_10 不是 speaker_1。",
      {
        upload_a: {
          speaker_1: "张三",
          speaker_10: "李四"
        }
      }
    );

    expect(result).toBe("李四 先说，张三 后说，李四 不是 张三。");
  });
});
