import { z } from "zod";
import {
  BriefCategorySchema,
  BriefItemSchema,
  PrioritySchema,
  type BriefItem,
  type TranscriptSegment
} from "@/lib/domain/types";
import { formatExtractionSegments, type ExtractionChunk } from "./chunks";
import type {
  ExtractionFallbackReason,
  ExtractionOptions,
  ExtractionProvider
} from "./provider";
import { ruleExtractionProvider } from "./rule-provider";
import { createOpenAIClient } from "@/lib/server/openai/client";
import {
  parseStructuredJsonResponse,
  type StructuredJsonResponseMode
} from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import { fingerprintAnalysisInput } from "@/lib/server/analysis-chunks/checkpoint";
import { processDailyBriefChunks, resolveDailyBriefChunkConcurrency } from "./chunk-processing";

const DEFAULT_CHUNK_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_OUTPUT_TOKENS = 3_000;

const ExtractedBriefSchema = z.object({
  items: z.array(
    z.object({
      category: BriefCategorySchema,
      title: z.string(),
      body: z.string(),
      priority: PrioritySchema,
      confidence: z.number().min(0).max(1),
      sourceSegmentIds: z.array(z.string()),
      transcriptExcerpt: z.string(),
      people: z.array(z.string()),
      topics: z.array(z.string())
    })
  ).max(6)
});

class ExtractionDeadlineError extends Error {
  constructor() {
    super("Extraction deadline exceeded");
    this.name = "ExtractionDeadlineError";
  }
}

function readNonNegativeInteger(variableName: string, defaultValue: number) {
  const rawValue = process.env[variableName]?.trim();
  if (!rawValue) {
    return defaultValue;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

function responseMode(): StructuredJsonResponseMode {
  const mode = process.env.EXTRACTION_RESPONSE_MODE?.trim().toLowerCase();
  return mode === "auto" || mode === "structured" || mode === "json" ? mode : "json";
}

function fallbackReason(error: unknown): ExtractionFallbackReason {
  if (error instanceof z.ZodError) {
    return "invalid_schema";
  }

  const status =
    error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);

  if (status === 429) {
    return "rate_limit";
  }
  if (/timed?\s*out|timeout/i.test(message)) {
    return "timeout";
  }
  if (/json|unexpected token|structured response/i.test(message)) {
    return "invalid_json";
  }
  if ((status !== undefined && status >= 500) || /fetch|network|connection/i.test(message)) {
    return "network";
  }
  return "provider_error";
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new ExtractionDeadlineError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new ExtractionDeadlineError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function normalizeChunkItems(input: {
  uploadId: string;
  chunk: ExtractionChunk;
  parsedItems: z.infer<typeof ExtractedBriefSchema>["items"];
}) {
  const segmentMap = new Map(input.chunk.segments.map((segment) => [segment.id, segment]));

  return input.parsedItems.flatMap((item, index): BriefItem[] => {
    const resolvedSources = item.sourceSegmentIds.flatMap((sourceSegmentId) => {
      const source = segmentMap.get(sourceSegmentId);
      return source ? [source] : [];
    });

    if (resolvedSources.length === 0) {
      return [];
    }

    return [
      BriefItemSchema.parse({
        id: `${input.uploadId}_${input.chunk.id}_brief_${index + 1}`,
        uploadId: input.uploadId,
        category: item.category,
        title: item.title,
        body: item.body,
        priority: item.priority,
        confidence: item.confidence,
        status: "candidate",
        sourceSegmentIds: resolvedSources.map((source) => source.id),
        sourceTimeRange: {
          startSeconds: Math.min(...resolvedSources.map((source) => source.startSeconds)),
          endSeconds: Math.max(...resolvedSources.map((source) => source.endSeconds))
        },
        transcriptExcerpt: item.transcriptExcerpt || resolvedSources[0].text,
        people: item.people,
        topics: item.topics
      })
    ];
  });
}

async function extractChunk(input: {
  client: ReturnType<typeof createOpenAIClient>;
  model: string;
  mode: StructuredJsonResponseMode;
  uploadId: string;
  chunk: ExtractionChunk;
  timeout: number;
  maxRetries: number;
  signal: AbortSignal;
}) {
  const parsed = await parseStructuredJsonResponse({
    client: input.client,
    model: input.model,
    name: "founder_daily_brief_chunk",
    schema: ExtractedBriefSchema,
    requestInput: [
      {
        role: "system",
        content:
          "你是创始人每日复盘助手。只抽取有证据的承诺、待办、决策、想法、风险、未决问题和重要原话。每块最多输出 6 条最有价值的项目，每个项目必须引用 sourceSegmentIds。"
      },
      {
        role: "user",
        content: formatExtractionSegments(input.chunk.segments)
      }
    ],
    jsonInstruction:
      "输出 founder_daily_brief JSON：items 为数组且最多 6 项；每项包含 category、title、body、priority、confidence、sourceSegmentIds、transcriptExcerpt、people、topics。" +
      "category 只能是 commitment、task、decision、idea、risk、open_question、notable_quote；priority 只能是 high、medium、low。" +
      "没有足够证据时输出 {\"items\":[]}。",
    mode: input.mode,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    requestOptions: {
      timeout: input.timeout,
      maxRetries: input.maxRetries,
      signal: input.signal
    }
  });

  return normalizeChunkItems({ uploadId: input.uploadId, chunk: input.chunk, parsedItems: parsed.items });
}

export const openaiExtractionProvider: ExtractionProvider = {
  async extract(uploadId, segments, options) {
    const extractionStartedAt = Date.now();
    const client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
    const model = process.env.OPENAI_TEXT_MODEL ?? "gpt-4.1-mini";
    const mode = responseMode();
    const chunkTimeoutMs = readNonNegativeInteger("EXTRACTION_CHUNK_TIMEOUT_MS", DEFAULT_CHUNK_TIMEOUT_MS);
    const maxRetries = readNonNegativeInteger("EXTRACTION_MAX_RETRIES", DEFAULT_MAX_RETRIES);
    const totalTimeoutMs = readNonNegativeInteger("EXTRACTION_TOTAL_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS);
    const deadline = extractionStartedAt + totalTimeoutMs;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(),
      Math.max(0, deadline - Date.now())
    );
    const processorFingerprint = options?.analysisCheckpoint?.processorFingerprint ?? fingerprintAnalysisInput({
      kind: "daily_brief",
      provider: process.env.EXTRACTION_PROVIDER ?? "openai",
      model,
      responseMode: mode,
      promptVersion: "founder_daily_brief_chunk_v1",
      schemaVersion: "extracted_brief_v1",
      normalizationVersion: "daily_brief_evidence_v1"
    });

    try {
      const result = await processDailyBriefChunks({
        uploadId,
        segments,
        semanticSegments: options?.semanticSegments,
        concurrency: resolveDailyBriefChunkConcurrency(),
        onProgress: options?.onProgress,
        ...(options?.analysisCheckpoint ? {
          checkpoint: {
            store: options.analysisCheckpoint.store,
            userId: options.analysisCheckpoint.userId,
            recordingDate: options.analysisCheckpoint.recordingDate,
            processorFingerprint,
            staleAfterMs: options.analysisCheckpoint.staleAfterMs ?? Math.max(
              totalTimeoutMs + 60_000,
              chunkTimeoutMs * Math.max(1, maxRetries + 1) + 60_000
            )
          }
        } : {}),
        executeChunk: async (chunk) => {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0 || deadlineController.signal.aborted) {
            throw new ExtractionDeadlineError();
          }
          const requestTimeout = Math.max(
            1,
            Math.min(chunkTimeoutMs, Math.floor(remainingMs / Math.max(1, maxRetries + 1)))
          );
          const items = await awaitWithAbort(
            extractChunk({
              client,
              model,
              mode,
              uploadId,
              chunk,
              timeout: requestTimeout,
              maxRetries,
              signal: deadlineController.signal
            }),
            deadlineController.signal
          );
          return { items, resultSource: "provider_success" };
        },
        fallbackChunk: async (chunk, error) => ({
          items: await ruleExtractionProvider.extract(uploadId, chunk.segments),
          resultSource: "rule_fallback",
          fallbackReason:
            deadlineController.signal.aborted || error instanceof ExtractionDeadlineError
              ? "deadline"
              : fallbackReason(error)
        })
      });
      return result.items;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
};
