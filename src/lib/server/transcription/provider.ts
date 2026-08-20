import type { TranscriptSegment } from "@/lib/domain/types";
import { fixtureTranscriptionProvider } from "./fixture-provider";
import { openaiTranscriptionProvider } from "./openai-provider";
import { speakerAsrTranscriptionProvider } from "./speaker-asr-provider";

export type AudioAccessPolicy = "legacy_bearer" | "daily_reflection_capability";

export type TranscriptionInput = {
  uploadId: string;
  filePath: string;
  mimeType: string;
  audioAccessPolicy?: AudioAccessPolicy;
};

export type TranscriptionProvider = {
  transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]>;
};

export type TranscriptionProviderName = "fixture" | "openai" | "speaker-asr";

const providers: Record<TranscriptionProviderName, TranscriptionProvider> = {
  fixture: fixtureTranscriptionProvider,
  openai: openaiTranscriptionProvider,
  "speaker-asr": speakerAsrTranscriptionProvider
};

const TRANSCRIPTION_DEFAULT_FALLBACK: TranscriptionProviderName = "fixture";

function normalizeProviderName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function getProviderNameByEnv(): TranscriptionProviderName {
  const rawProvider = normalizeProviderName(process.env.TRANSCRIPTION_PROVIDER);
  if (!rawProvider || rawProvider === "fixture") {
    return "fixture";
  }
  if (rawProvider === "openai") {
    return "openai";
  }
  if (rawProvider === "speaker-asr") {
    return "speaker-asr";
  }
  throw new Error(`Unknown transcription provider: ${rawProvider}`);
}

function getFallbackProviderName(primaryName: TranscriptionProviderName): TranscriptionProviderName | null {
  const rawFallback = normalizeProviderName(process.env.TRANSCRIPTION_FALLBACK_PROVIDER);
  if (!rawFallback) {
    return TRANSCRIPTION_DEFAULT_FALLBACK === primaryName ? null : TRANSCRIPTION_DEFAULT_FALLBACK;
  }
  if (rawFallback === "none" || rawFallback === primaryName) {
    return null;
  }
  if (rawFallback === "fixture" || rawFallback === "openai" || rawFallback === "speaker-asr") {
    return rawFallback;
  }
  throw new Error(`Unknown transcription fallback provider: ${rawFallback}`);
}

function wrapWithFallback(
  providerName: TranscriptionProviderName,
  fallbackName: TranscriptionProviderName | null
): TranscriptionProvider {
  const primaryProvider = providers[providerName];

  if (!fallbackName) {
    return primaryProvider;
  }

  const fallbackProvider = providers[fallbackName];

  return {
    async transcribe(input) {
      try {
        return await primaryProvider.transcribe(input);
      } catch (error) {
        console.error(
          `[transcription provider fallback] ${providerName} failed, fallback provider ${fallbackName} will be used.`,
          error
        );
        return await fallbackProvider.transcribe(input);
      }
    }
  };
}

export function getTranscriptionProvider(): TranscriptionProvider {
  const providerName = getProviderNameByEnv();
  const fallbackProviderName = getFallbackProviderName(providerName);
  return wrapWithFallback(providerName, fallbackProviderName);
}

export function getTranscriptionProviderRuntime() {
  const name = getProviderNameByEnv();
  const fallbackName = getFallbackProviderName(name);
  return {
    name,
    provider: providers[name],
    fallbackName,
    fallbackProvider: fallbackName ? providers[fallbackName] : null
  };
}
