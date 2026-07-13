import { buildAudioInsights } from "@/lib/processing/audio-insights";

import type { AudioInsightProvider } from "./provider";

export const ruleAudioInsightProvider: AudioInsightProvider = {
  async analyze(uploadId, segments) {
    return buildAudioInsights(uploadId, segments);
  }
};
