import { buildAudioInsights } from "@/lib/processing/audio-insights";
import { applyEmotionEvidenceToAudioInsights } from "@/lib/processing/emotion-evidence";
import type { EmotionEvidence } from "@/lib/domain/types";

import type { EmotionSignalProvider } from "./provider";

export const ruleEmotionSignalProvider: EmotionSignalProvider = {
  async analyze(input): Promise<EmotionEvidence[]> {
    return applyEmotionEvidenceToAudioInsights(buildAudioInsights(input.uploadId, input.segments)).flatMap(
      (insight) => insight.emotionEvidence ?? []
    );
  }
};
