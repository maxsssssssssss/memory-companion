import type { AudioInsight, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import {
  buildConservativeRelationshipSignalFallbackCards,
  type RawRelationshipSignalItem
} from "@/lib/processing/relationship-signals";
import { emptyRelationshipSignalProvider } from "./empty-provider";
import { openaiRelationshipSignalProvider } from "./openai-provider";
import type { StructuredJsonDiagnostics } from "@/lib/server/openai/structured-json";

export type RelationshipSignalRequestMetrics = {
  responseMode: "json";
  model: string;
  promptCharacterCount: number;
  unoptimizedContextCharacterCount: number;
  optimizedContextCharacterCount: number;
  transcriptCharacterCount: number;
  semanticCharacterCount: number;
  semanticSegmentCount: number;
  insightCharacterCount: number;
  systemPromptCharacterCount: number;
  jsonInstructionCharacterCount: number;
  maxOutputTokens: number;
  recoveryMode: RelationshipSignalRecoveryMode;
  candidateLimit: 3 | 5;
  insightsBefore?: number;
  insightsAfter?: number;
  insightCharsBefore?: number;
  insightCharsAfter?: number;
  removedReasonCounts?: Record<string, number>;
};

export type RelationshipSignalRecoveryMode = "standard" | "compact";

export type RelationshipSignalCandidateAudit = {
  contract: "compact";
  recoveryMode: RelationshipSignalRecoveryMode;
  candidateLimit: 3 | 5;
  rawCandidateCount: number;
  compactCandidateCount: number;
  overLimitCount: number;
};

export type RelationshipSignalProviderInput = {
  uploadId: string;
  recordingDate: string;
  segments: TranscriptSegment[];
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
  recoveryMode?: RelationshipSignalRecoveryMode;
  signal?: AbortSignal;
  onDiagnostics?: (diagnostics: StructuredJsonDiagnostics) => void;
  onRequestMetrics?: (metrics: RelationshipSignalRequestMetrics) => void;
  onCandidateAudit?: (audit: RelationshipSignalCandidateAudit) => void;
  evaluationRawResponseCapture?: {
    evaluationRetention: boolean;
    chunkIndex: number;
    attempt: number;
  };
};

export type RelationshipSignalProvider = {
  analyze(input: RelationshipSignalProviderInput): Promise<RelationshipSignalCard[]>;
  extractCandidates?(input: RelationshipSignalProviderInput): Promise<RawRelationshipSignalItem[]>;
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

  const wrapped: RelationshipSignalProvider = {
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

  if (primaryProvider.extractCandidates) {
    wrapped.extractCandidates = async (input) => {
      try {
        return await primaryProvider.extractCandidates!(input);
      } catch (error) {
        if (fallbackProvider.extractCandidates) {
          console.warn(
            `[relationship signal provider fallback] ${providerName} candidate extraction failed, fallback provider ${fallbackName} will be used.`,
            error instanceof Error ? error.message : error
          );
          return await fallbackProvider.extractCandidates(input);
        }
        throw error;
      }
    };
  }

  return wrapped;
}

export function getRelationshipSignalProvider(): RelationshipSignalProvider {
  const providerName = getProviderNameByEnv();
  const fallbackProviderName = getFallbackProviderName(providerName);
  return wrapWithFallback(providerName, fallbackProviderName);
}
