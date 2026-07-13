import { describe, expect, it } from "vitest";

import type { AudioInsight } from "@/lib/domain/types";

import { applyEmotionEvidenceToAudioInsights, atmosphereLabelsForInsight } from "./emotion-evidence";

function insight(overrides?: Partial<AudioInsight>): AudioInsight {
  return {
    id: "insight_1",
    uploadId: "upload_1",
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 10 },
    speaker: { id: "speaker_1", role: "self", confidence: 0.72 },
    voice: {
      pace: "normal",
      volume: "high",
      pause: "many",
      overlap: true,
      confidence: 0.74,
      explanations: [
        { kind: "volume", label: "音量更高", detail: "这一段平均音量约 -16 dBFS。", confidence: 0.74 },
        { kind: "pause", label: "停顿变多", detail: "静音和停顿占比约 42%。", confidence: 0.68 },
        { kind: "overlap", label: "多人重叠", detail: "speaker_1 与 speaker_2 的转写时间发生重叠。", confidence: 0.72 }
      ]
    },
    toneLabels: ["questioning", "serious"],
    emotionLabels: ["anxious"],
    interactionLabels: ["tension", "follow_up_question"],
    summary: "这一段语气认真，并带有紧张信号。",
    evidence: "原文证据。",
    confidence: 0.77,
    ...overrides
  };
}

describe("emotion evidence", () => {
  it("derives atmosphere labels from semantic and acoustic signals", () => {
    expect(atmosphereLabelsForInsight(insight())).toEqual(expect.arrayContaining(["serious", "tense"]));
  });

  it("adds fusion and acoustic evidence to audio insights", () => {
    const [enriched] = applyEmotionEvidenceToAudioInsights([insight()]);

    expect(enriched.atmosphereLabels).toEqual(expect.arrayContaining(["serious", "tense"]));
    expect(enriched.emotionEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "fusion",
          kind: "atmosphere",
          normalizedLabel: "tense",
          sourceSegmentIds: ["seg_1"]
        })
      ])
    );
    expect(enriched.emotionEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "acoustic",
          kind: "atmosphere",
          detail: expect.stringContaining("音量更高")
        })
      ])
    );
  });

  it("prioritizes user corrections before generated evidence", () => {
    const [enriched] = applyEmotionEvidenceToAudioInsights([
      insight({
        userCorrections: [
          {
            labelCorrections: [{ from: "紧张", to: "认真" }],
            note: "用户确认这一段不是紧张，而是在认真讨论。"
          }
        ]
      })
    ]);

    expect(enriched.emotionEvidence?.[0]).toMatchObject({
      source: "user_correction",
      normalizedLabel: "serious",
      correctedByUser: true
    });
    expect(enriched.atmosphereLabels).toContain("serious");
    expect(enriched.atmosphereLabels).not.toContain("tense");
    expect(enriched.atmosphereLabels).not.toContain("conflicted");
    expect(enriched.emotionEvidence?.some((evidence) => evidence.source !== "user_correction" && evidence.normalizedLabel === "tense")).toBe(false);
    expect(enriched.emotionEvidence?.some((evidence) => evidence.source !== "user_correction" && evidence.normalizedLabel === "conflicted")).toBe(false);
  });
});
