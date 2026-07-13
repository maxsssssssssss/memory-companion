import type { AudioInsight, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { buildConservativeRelationshipSignalFallbackCards } from "@/lib/processing/relationship-signals";
import { emptyRelationshipSignalProvider } from "./empty-provider";
import { openaiRelationshipSignalProvider } from "./openai-provider";

export type RelationshipSignalProviderInput = {
  uploadId: string;
  recordingDate: string;
  segments: TranscriptSegment[];
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
};

export type RelationshipSignalProvider = {
  analyze(input: RelationshipSignalProviderInput): Promise<RelationshipSignalCard[]>;
};

type ProviderName = "openai" | "none";

const providers: Record<ProviderName, RelationshipSignalProvider> = {
  openai: openaiRelationshipSignalProvider,
  none: emptyRelationshipSignalProvider
};

function normalizeProviderName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function getProviderNameByEnv(): ProviderName {
  const rawProvider = normalizeProviderName(process.env.RELATIONSHIP_SIGNAL_PROVIDER);
  if (!rawProvider || rawProvider === "openai") {
    return "openai";
  }
  if (rawProvider === "none") {
    return "none";
  }
  throw new Error(`Unknown relationship signal provider: ${rawProvider}`);
}

function getFallbackProviderName(primaryName: ProviderName): ProviderName | null {
  const rawFallback = normalizeProviderName(process.env.RELATIONSHIP_SIGNAL_FALLBACK_PROVIDER);
  if (!rawFallback || rawFallback === "none" || rawFallback === primaryName) {
    return primaryName === "none" ? null : "none";
  }
  if (rawFallback === "openai") {
    return "openai";
  }
  throw new Error(`Unknown relationship signal fallback provider: ${rawFallback}`);
}

function wrapWithFallback(providerName: ProviderName, fallbackName: ProviderName | null): RelationshipSignalProvider {
  const primaryProvider = providers[providerName];

  if (!fallbackName) {
    return primaryProvider;
  }

  const fallbackProvider = providers[fallbackName];

  return {
    async analyze(input) {
      try {
        return await primaryProvider.analyze(input);
      } catch (error) {
        console.warn(
          `[relationship signal provider fallback] ${providerName} failed, fallback provider ${fallbackName} will be used.`,
          error instanceof Error ? error.message : error
        );
        const conservativeCards = buildConservativeRelationshipSignalFallbackCards(input);
        if (conservativeCards.length > 0) {
          return conservativeCards;
        }
        return await fallbackProvider.analyze(input);
      }
    }
  };
}

export function getRelationshipSignalProvider(): RelationshipSignalProvider {
  const providerName = getProviderNameByEnv();
  const fallbackProviderName = getFallbackProviderName(providerName);
  return wrapWithFallback(providerName, fallbackProviderName);
}
