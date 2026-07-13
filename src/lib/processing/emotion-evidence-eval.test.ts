import { describe, expect, it } from "vitest";

import type { AudioInsight } from "@/lib/domain/types";

import { applyEmotionEvidenceToAudioInsights } from "./emotion-evidence";

function lowConfidenceInsight(): AudioInsight {
  return {
    id: "insight_noise",
    uploadId: "upload_noise",
    sourceSegmentIds: ["seg_noise"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 20 },
    speaker: { id: "speaker_unknown", role: "unknown", confidence: 0.2 },
    voice: { pace: "unknown", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.2 },
    toneLabels: ["unknown"],
    emotionLabels: ["neutral"],
    interactionLabels: ["unknown"],
    summary: "这一段没有明显强烈语气，先按中性互动信号保存。",
    evidence: "原文证据不足。",
    confidence: 0.25
  };
}

describe("emotion evidence guardrails", () => {
  it("does not produce confident atmosphere claims for low-signal recordings", () => {
    const [result] = applyEmotionEvidenceToAudioInsights([lowConfidenceInsight()]);

    expect(result.atmosphereLabels).toEqual(["unknown"]);
    expect(result.emotionEvidence ?? []).toEqual([]);
  });
});
