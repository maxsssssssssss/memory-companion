import type { BriefItem, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { JsonAnalysisChunkCheckpointStore } from "@/lib/server/analysis-chunks/checkpoint";
import { openaiExtractionProvider } from "./openai-provider";
import { ruleExtractionProvider } from "./rule-provider";

export type ExtractionFallbackReason =
  | "deadline"
  | "network_error"
  | "fetch_timeout"
  | "provider_5xx"
  | "rate_limit"
  | "empty_response"
  | "incomplete_response"
  | "max_output_tokens"
  | "invalid_json"
  | "validation_failure"
  | "evidence_validation_failure"
  | "content_filter"
  | "unknown_provider_error";

export type ExtractionProgressEvent =
  | {
      phase: "planned";
      segmentCount: number;
      inputChars: number;
      inputBytes: number;
      estimatedTokensMin: number;
      estimatedTokensMax: number;
      chunkCount: number;
      longForm: boolean;
      oversizedChunkCount: number;
    }
  | {
      phase: "chunk_started";
      chunkIndex: number;
      chunkCount: number;
      segmentCount: number;
      inputChars: number;
      startSeconds: number;
      endSeconds: number;
    }
  | {
      phase: "chunk_completed";
      chunkIndex: number;
      chunkCount: number;
      completedCount?: number;
      itemCount: number;
      elapsedMs: number;
      provider: "openai" | "checkpoint" | "fixture";
      resultSource?: "provider_success" | "provider_retry_success";
    }
  | {
      phase: "chunk_fallback";
      chunkIndex: number;
      chunkCount: number;
      completedCount?: number;
      itemCount: number;
      elapsedMs: number;
      reason: ExtractionFallbackReason;
      resultSource?: "rule_fallback";
    }
  | {
      phase: "merged";
      rawItemCount: number;
      validItemCount: number;
      deduplicatedItemCount: number;
      finalItemCount: number;
      fallbackChunks: number;
      elapsedMs: number;
    };

export type ExtractionOptions = {
  semanticSegments?: SemanticSegment[];
  onProgress?: (event: ExtractionProgressEvent) => void | Promise<void>;
  evaluationRawResponseCapture?: boolean;
  analysisCheckpoint?: {
    store: JsonAnalysisChunkCheckpointStore;
    userId: string;
    recordingDate?: string;
    processorFingerprint?: string;
    staleAfterMs?: number;
  };
};

export type ExtractionProvider = {
  extract(uploadId: string, segments: TranscriptSegment[], options?: ExtractionOptions): Promise<BriefItem[]>;
};

type ProviderName = "rule" | "openai";

const providers: Record<ProviderName, ExtractionProvider> = {
  rule: ruleExtractionProvider,
  openai: openaiExtractionProvider
};

const EXTRACTION_DEFAULT_FALLBACK: ProviderName = "rule";

function normalizeProviderName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function getProviderNameByEnv(): ProviderName {
  const rawProvider = normalizeProviderName(process.env.EXTRACTION_PROVIDER);
  if (!rawProvider || rawProvider === "rule") {
    return "rule";
  }
  if (rawProvider === "openai") {
    return "openai";
  }
  throw new Error(`Unknown extraction provider: ${rawProvider}`);
}

function getFallbackProviderName(primaryName: ProviderName): ProviderName | null {
  const rawFallback = normalizeProviderName(process.env.EXTRACTION_FALLBACK_PROVIDER);
  if (!rawFallback) {
    return EXTRACTION_DEFAULT_FALLBACK === primaryName ? null : EXTRACTION_DEFAULT_FALLBACK;
  }
  if (rawFallback === "none" || rawFallback === primaryName) {
    return null;
  }
  if (rawFallback === "rule" || rawFallback === "openai") {
    return rawFallback;
  }
  throw new Error(`Unknown extraction fallback provider: ${rawFallback}`);
}

function wrapWithFallback(providerName: ProviderName, fallbackName: ProviderName | null): ExtractionProvider {
  const primaryProvider = providers[providerName];

  if (!fallbackName) {
    return primaryProvider;
  }

  const fallbackProvider = providers[fallbackName];

  return {
    async extract(uploadId, segments, options) {
      try {
        return await primaryProvider.extract(uploadId, segments, options);
      } catch (error) {
        const failureName = error instanceof Error
          ? error.name.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 80) || "Error"
          : "UnknownError";
        console.error(
          `[extraction provider fallback] primary=${providerName} fallback=${fallbackName} error_name=${failureName}`
        );
        return await fallbackProvider.extract(uploadId, segments, options);
      }
    }
  };
}

export function getExtractionProvider(): ExtractionProvider {
  const providerName = getProviderNameByEnv();
  const fallbackProviderName = getFallbackProviderName(providerName);
  return wrapWithFallback(providerName, fallbackProviderName);
}
