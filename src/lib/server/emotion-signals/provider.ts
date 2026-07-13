import type { EmotionEvidence, TranscriptSegment } from "@/lib/domain/types";

import { ruleEmotionSignalProvider } from "./rule-provider";

export type EmotionSignalProviderInput = {
  uploadId: string;
  filePath: string;
  mimeType: string;
  segments: TranscriptSegment[];
};

export type EmotionSignalProvider = {
  analyze(input: EmotionSignalProviderInput): Promise<EmotionEvidence[]>;
};

const noneEmotionSignalProvider: EmotionSignalProvider = {
  async analyze() {
    return [];
  }
};

function normalizeProviderName(value: string | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export function getEmotionSignalProvider(): EmotionSignalProvider {
  const providerName = normalizeProviderName(process.env.EMOTION_SIGNAL_PROVIDER);

  if (!providerName || providerName === "none") {
    return noneEmotionSignalProvider;
  }

  if (providerName === "rule") {
    return ruleEmotionSignalProvider;
  }

  throw new Error(`Unknown emotion signal provider: ${providerName}`);
}
