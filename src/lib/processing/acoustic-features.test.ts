import { describe, expect, it } from "vitest";

import type { AudioInsight } from "@/lib/domain/types";

import { applyAcousticFeaturesToAudioInsights, classifyPauseFromSilenceRatio, classifyVolumeFromDb } from "./acoustic-features";

function insight(overrides?: Partial<AudioInsight>): AudioInsight {
  return {
    id: "insight_1",
    uploadId: "upload_1",
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 10 },
    speaker: { id: "speaker_1", role: "unknown", confidence: 0.45 },
    voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
    toneLabels: ["unknown"],
    emotionLabels: ["neutral"],
    interactionLabels: ["unknown"],
    summary: "中性互动。",
    evidence: "原文证据。",
    confidence: 0.5,
    ...overrides
  };
}

describe("acoustic features", () => {
  it("classifies waveform volume from dBFS values", () => {
    expect(classifyVolumeFromDb(-42)).toBe("low");
    expect(classifyVolumeFromDb(-24)).toBe("normal");
    expect(classifyVolumeFromDb(-14)).toBe("high");
    expect(classifyVolumeFromDb(undefined)).toBe("unknown");
  });

  it("classifies pauses from silence ratio", () => {
    expect(classifyPauseFromSilenceRatio(0.04)).toBe("few");
    expect(classifyPauseFromSilenceRatio(0.18)).toBe("normal");
    expect(classifyPauseFromSilenceRatio(0.44)).toBe("many");
    expect(classifyPauseFromSilenceRatio(undefined)).toBe("unknown");
  });

  it("merges real audio features into existing audio insights without replacing semantic labels", () => {
    const [enriched] = applyAcousticFeaturesToAudioInsights([insight()], [
      {
        segmentId: "seg_1",
        volume: "high",
        pause: "many",
        overlap: true,
        confidence: 0.72,
        explanations: [
          { kind: "volume", label: "音量更高", detail: "这一段平均音量约 -16 dBFS。", confidence: 0.72 },
          { kind: "pause", label: "停顿变多", detail: "静音和停顿占比约 42%。", confidence: 0.72 },
          { kind: "overlap", label: "多人重叠", detail: "speaker_1 与 speaker_2 的转写时间发生重叠。", confidence: 0.72 }
        ]
      }
    ]);

    expect(enriched.voice).toEqual({
      pace: "normal",
      volume: "high",
      pause: "many",
      overlap: true,
      confidence: 0.72,
      explanations: [
        { kind: "volume", label: "音量更高", detail: "这一段平均音量约 -16 dBFS。", confidence: 0.72 },
        { kind: "pause", label: "停顿变多", detail: "静音和停顿占比约 42%。", confidence: 0.72 },
        { kind: "overlap", label: "多人重叠", detail: "speaker_1 与 speaker_2 的转写时间发生重叠。", confidence: 0.72 }
      ]
    });
    expect(enriched.toneLabels).toEqual(["unknown"]);
    expect(enriched.summary).toBe("中性互动。");
  });
});
