import type { AudioInsight, TranscriptSegment } from "@/lib/domain/types";

import { deepseekAudioInsightProvider } from "./deepseek-provider";
import { openaiAudioInsightProvider } from "./openai-provider";
import { ruleAudioInsightProvider } from "./rule-provider";

export type AudioInsightProvider = {
  analyze(
    uploadId: string,
    segments: TranscriptSegment[],
    options?: AudioInsightAnalyzeOptions
  ): Promise<AudioInsight[]>;
};

export type AudioInsightAnalyzeOptions = {
  signal?: AbortSignal;
  diagnostics?: {
    chunkIndex: number;
    attempt: number;
    concurrency: number;
    attemptTimeoutMs: number;
  };
};

type ProviderName = "rule" | "openai" | "deepseek";

const providers: Record<ProviderName, AudioInsightProvider> = {
  deepseek: deepseekAudioInsightProvider,
  rule: ruleAudioInsightProvider,
  openai: openaiAudioInsightProvider
};

const AUDIO_INSIGHT_DEFAULT_FALLBACK: ProviderName = "rule";

function normalizeProviderName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function getProviderNameByEnv(): ProviderName {
  const rawProvider = normalizeProviderName(process.env.AUDIO_INSIGHT_PROVIDER);
  if (!rawProvider || rawProvider === "rule") {
    return "rule";
  }
  if (rawProvider === "openai") {
    return "openai";
  }
  if (rawProvider === "deepseek") {
    return "deepseek";
  }
  throw new Error(`Unknown audio insight provider: ${rawProvider}`);
}

function getFallbackProviderName(primaryName: ProviderName): ProviderName | null {
  const rawFallback = normalizeProviderName(process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER);
  if (!rawFallback) {
    return AUDIO_INSIGHT_DEFAULT_FALLBACK === primaryName ? null : AUDIO_INSIGHT_DEFAULT_FALLBACK;
  }
  if (rawFallback === "none" || rawFallback === primaryName) {
    return null;
  }
  if (rawFallback === "rule" || rawFallback === "openai" || rawFallback === "deepseek") {
    return rawFallback;
  }
  throw new Error(`Unknown audio insight fallback provider: ${rawFallback}`);
}

function wrapWithFallback(providerName: ProviderName, fallbackName: ProviderName | null): AudioInsightProvider {
  const primaryProvider = providers[providerName];

  if (!fallbackName) {
    return primaryProvider;
  }

  const fallbackProvider = providers[fallbackName];

  return {
    async analyze(uploadId, segments, options) {
      try {
        const insights = await primaryProvider.analyze(uploadId, segments, options);
        if (insights.length > 0 || segments.length === 0) {
          return insights;
        }

        console.error(
          `[audio insight provider fallback] ${providerName} returned no valid insights, fallback provider ${fallbackName} will be used.`
        );
        return await fallbackProvider.analyze(uploadId, segments, options);
      } catch (error) {
        console.error(
          `[audio insight provider fallback] ${providerName} failed, fallback provider ${fallbackName} will be used.`,
          error
        );
        return await fallbackProvider.analyze(uploadId, segments, options);
      }
    }
  };
}

export function getAudioInsightProvider(): AudioInsightProvider {
  const providerName = getProviderNameByEnv();
  const fallbackProviderName = getFallbackProviderName(providerName);
  return wrapWithFallback(providerName, fallbackProviderName);
}

export function getAudioInsightChunkProviders(): {
  provider: AudioInsightProvider;
  fallbackProvider: AudioInsightProvider;
} {
  const providerName = getProviderNameByEnv();
  const fallbackProviderName = getFallbackProviderName(providerName);
  return {
    provider: providers[providerName],
    fallbackProvider: fallbackProviderName ? providers[fallbackProviderName] : ruleAudioInsightProvider
  };
}
