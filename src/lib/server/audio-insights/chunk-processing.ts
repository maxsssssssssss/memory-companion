import { AnalysisChunkSchema, type AnalysisChunk, type TranscriptChunk } from "@/lib/domain/chunks";
import { AudioInsightSchema, type AudioInsight, type TranscriptSegment } from "@/lib/domain/types";
import { z } from "zod";
import {
  executeWithAnalysisCheckpoint,
  fingerprintAnalysisInput,
  type AnalysisCheckpointCacheStatus,
  type JsonAnalysisChunkCheckpointStore
} from "@/lib/server/analysis-chunks/checkpoint";
import {
  ChunkAttemptTimeoutError,
  mapWithConcurrency,
  runChunkAttempt
} from "@/lib/server/chunks/bounded-scheduler";
import { ruleAudioInsightProvider } from "./rule-provider";
import type { AudioInsightProvider } from "./provider";
import { mergeAudioInsightChunks } from "./merge";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;

export type AudioInsightChunkProcessingOptions = {
  concurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  attemptTimeoutMs?: number;
  now?: () => string;
  analysisCheckpoint?: {
    store: JsonAnalysisChunkCheckpointStore;
    userId: string;
    processorFingerprint?: string;
    staleAfterMs?: number;
  };
};

const AudioInsightArraySchema = z.array(AudioInsightSchema);

export type AudioInsightChunkStats = {
  chunkCount: number;
  completedChunks: number;
  failedChunks: number;
  fallbackChunks: number;
  retrySuccessChunks: number;
  timeoutChunks: number;
  invalidJsonChunks: number;
  inputInsightCount: number;
  outputInsightCount: number;
  rejectedInsights: number;
  duplicateRemoved: number;
  parallelDurationMs: number;
  mergeDurationMs: number;
  checkpointHits: number;
  checkpointMisses: number;
  checkpointStale: number;
  checkpointCorrupt: number;
};

export type AudioInsightChunkProcessingResult = {
  insights: AudioInsight[];
  analysisChunks: AnalysisChunk[];
  stats: AudioInsightChunkStats;
};

type AudioInsightChunkOutput = {
  transcriptChunk: TranscriptChunk;
  insights: AudioInsight[];
  retryCount: number;
  fallback: boolean;
  failed: boolean;
  error: unknown;
  cacheStatus: AnalysisCheckpointCacheStatus;
};

function readInteger(name: string, fallback: number, min: number, max: number) {
  const value = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function config(options: AudioInsightChunkProcessingOptions | undefined) {
  return {
    concurrency: options?.concurrency ?? readInteger("AUDIO_INSIGHT_CHUNK_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 16),
    maxRetries: options?.maxRetries ?? readInteger("AUDIO_INSIGHT_CHUNK_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0, 3),
    retryDelayMs: options?.retryDelayMs ?? readInteger("AUDIO_INSIGHT_CHUNK_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS, 0, 60_000),
    attemptTimeoutMs: options?.attemptTimeoutMs ?? readInteger("AUDIO_INSIGHT_CHUNK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1, 10 * 60_000)
  };
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "unknown audio insight chunk error")
    .replace(/([?&](?:token|access_token|api_key|key)=)[^&\s]+/gi, "$1****")
    .slice(0, 300);
}

function failureCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof ChunkAttemptTimeoutError
      ? "timeout"
      : "provider_error";
}

function shouldRetryAudioInsight(error: unknown) {
  const code = failureCode(error);
  if (["timeout", "api_error", "empty_response", "incomplete_response", "invalid_json"].includes(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /network|connection|\b5\d\d\b|temporar(?:y|ily)|rate.?limit/i.test(message);
}

function inputCharacterCount(segments: TranscriptSegment[]) {
  return segments.reduce(
    (total, segment) => total + segment.id.length + segment.text.length + (segment.speaker?.length ?? 0) + 32,
    0
  );
}

function audioInsightInputFingerprint(uploadId: string, chunk: TranscriptChunk) {
  return fingerprintAnalysisInput({
    uploadId,
    sourceChunkId: chunk.id,
    sourceChunkIndex: chunk.index,
    segments: chunk.segments.map((segment) => ({
      id: segment.id,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      speaker: segment.speaker ?? null,
      text: segment.text,
      sceneLabels: segment.sceneLabels,
      valueLabels: segment.valueLabels
    }))
  });
}

function audioInsightProcessorFingerprint(override?: string) {
  return fingerprintAnalysisInput({
    kind: "audio_insight",
    provider: process.env.AUDIO_INSIGHT_PROVIDER ?? "rule",
    model: process.env.DEEPSEEK_AUDIO_INSIGHT_MODEL ?? process.env.OPENAI_TEXT_MODEL ?? null,
    promptVersion: "audio_insight_chunk_v2",
    schemaVersion: "audio_insight_v1",
    normalizationVersion: "audio_insight_evidence_v1",
    override: override ?? null
  });
}

function analysisChunk(input: {
  transcriptChunk: TranscriptChunk;
  status: "completed" | "failed";
  retryCount: number;
  outputIds?: string[];
  fallback: boolean;
  error?: unknown;
  now: () => string;
}): AnalysisChunk {
  const finishedAt = input.now();
  return AnalysisChunkSchema.parse({
    id: `${input.transcriptChunk.uploadId}_audio_insight_analysis_${String(input.transcriptChunk.index).padStart(5, "0")}`,
    uploadId: input.transcriptChunk.uploadId,
    index: input.transcriptChunk.index,
    kind: "audio_insight",
    startSeconds: input.transcriptChunk.startSeconds,
    endSeconds: input.transcriptChunk.endSeconds,
    timebase: "upload_global",
    transcriptChunkIds: [input.transcriptChunk.id],
    sourceSegmentIds: input.transcriptChunk.segments.map((segment) => segment.id),
    outputIds: input.outputIds ?? [],
    status: input.status,
    retryCount: input.retryCount,
    ...(input.status === "failed"
      ? { error: { code: input.error instanceof ChunkAttemptTimeoutError ? "timeout" : "provider_error", message: safeError(input.error), retryable: true } }
      : {}),
    createdAt: input.transcriptChunk.createdAt,
    updatedAt: finishedAt,
    startedAt: input.transcriptChunk.startedAt ?? input.transcriptChunk.createdAt,
    finishedAt,
    metadata: { stage: "audio_insight", fallback: input.fallback }
  });
}

export async function processAudioInsightChunks(input: {
  uploadId: string;
  transcriptChunks: TranscriptChunk[];
  segments: TranscriptSegment[];
  provider: AudioInsightProvider;
  fallbackProvider?: AudioInsightProvider;
  options?: AudioInsightChunkProcessingOptions;
}): Promise<AudioInsightChunkProcessingResult> {
  const startedAt = Date.now();
  const options = config(input.options);
  const now = input.options?.now ?? (() => new Date().toISOString());
  const fallbackProvider = input.fallbackProvider ?? ruleAudioInsightProvider;
  const chunks = [...input.transcriptChunks].sort((left, right) => left.index - right.index);

  const outputs = await mapWithConcurrency<TranscriptChunk, AudioInsightChunkOutput>({
    items: chunks,
    options: { concurrency: options.concurrency },
    worker: async (chunk): Promise<AudioInsightChunkOutput> => {
      if (input.options?.analysisCheckpoint) {
        const checkpoint = input.options.analysisCheckpoint;
        try {
          const execution = await executeWithAnalysisCheckpoint<AudioInsight[]>({
            store: checkpoint.store,
            userId: checkpoint.userId,
            uploadId: input.uploadId,
            kind: "audio_insight",
            sourceChunkId: chunk.id,
            sourceChunkIndex: chunk.index,
            inputFingerprint: audioInsightInputFingerprint(input.uploadId, chunk),
            processorFingerprint: audioInsightProcessorFingerprint(checkpoint.processorFingerprint),
            outputSchema: AudioInsightArraySchema,
            validateOutput: (insights) => {
              const validated = mergeAudioInsightChunks({
                uploadId: input.uploadId,
                segments: input.segments,
                chunks: [{ transcriptChunk: chunk, insights }]
              });
              if (chunk.segments.length > 0 && validated.insights.length === 0) {
                throw new Error("audio insight checkpoint has no valid evidence-backed output");
              }
            },
            staleAfterMs: checkpoint.staleAfterMs ?? options.attemptTimeoutMs * Math.max(1, options.maxRetries + 1) + 60_000,
            now,
            metadata: { segmentCount: chunk.segments.length, inputCharacterCount: inputCharacterCount(chunk.segments) },
            execute: async () => {
              const fresh = await processAudioInsightChunks({
                ...input,
                transcriptChunks: [chunk],
                options: {
                  ...input.options,
                  concurrency: 1,
                  analysisCheckpoint: undefined
                }
              });
              if (fresh.stats.failedChunks > 0) {
                throw new Error("audio insight chunk processing failed");
              }
              return {
                output: fresh.insights,
                resultSource: fresh.stats.fallbackChunks > 0
                  ? "rule_fallback" as const
                  : fresh.stats.retrySuccessChunks > 0
                    ? "provider_retry_success" as const
                    : "provider_success" as const,
                metadata: {
                  providerRetryCount: fresh.stats.retrySuccessChunks > 0 ? 1 : 0,
                  chunkElapsedMs: fresh.stats.parallelDurationMs
                }
              };
            }
          });
          return {
            transcriptChunk: chunk,
            insights: execution.output,
            retryCount: Number(execution.checkpoint.metadata.providerRetryCount ?? 0),
            fallback: execution.resultSource === "rule_fallback",
            failed: false,
            error: undefined as unknown,
            cacheStatus: execution.cacheStatus
          };
        } catch (error) {
          return {
            transcriptChunk: chunk,
            insights: [],
            retryCount: 0,
            fallback: false,
            failed: true,
            error,
            cacheStatus: "miss" as const
          };
        }
      }
      const chunkStartedAt = Date.now();
      let attempts = 0;
      try {
        const attempt = await runChunkAttempt({
          execute: async (signal, attemptNumber) => {
            attempts = attemptNumber;
            let insights: AudioInsight[];
            try {
              insights = await input.provider.analyze(input.uploadId, chunk.segments, {
                signal,
                diagnostics: {
                  chunkIndex: chunk.index,
                  attempt: attemptNumber,
                  concurrency: options.concurrency,
                  attemptTimeoutMs: options.attemptTimeoutMs
                }
              });
            } catch (error) {
              if (signal.aborted) throw new ChunkAttemptTimeoutError(options.attemptTimeoutMs);
              throw error;
            }
            const validated = mergeAudioInsightChunks({
              uploadId: input.uploadId,
              segments: input.segments,
              chunks: [{ transcriptChunk: chunk, insights }]
            });
            if (chunk.segments.length > 0 && validated.insights.length === 0) {
              throw new Error("audio insight chunk returned no valid evidence-backed output");
            }
            return insights;
          },
          attemptTimeoutMs: options.attemptTimeoutMs,
          maxRetries: options.maxRetries,
          retryDelayMs: options.retryDelayMs,
          shouldRetry: shouldRetryAudioInsight
        });
        const output = {
          transcriptChunk: chunk,
          insights: attempt.value,
          retryCount: attempt.retryCount,
          fallback: false,
          failed: false,
          error: undefined as unknown,
          cacheStatus: "miss" as const
        };
        console.info(
          `[audio-insights] upload_id=${input.uploadId} chunk_index=${chunk.index} segment_count=${chunk.segments.length} input_chars=${inputCharacterCount(chunk.segments)} attempt=${attempt.attempts} concurrency=${options.concurrency} attempt_timeout_ms=${options.attemptTimeoutMs} status=completed provider_status=${attempt.retryCount > 0 ? "provider_retry_success" : "provider_success"} retry_count=${attempt.retryCount} fallback=false insights=${attempt.value.length} elapsed_ms=${Date.now() - chunkStartedAt}`
        );
        return output;
      } catch (primaryError) {
        try {
          const insights = await fallbackProvider.analyze(input.uploadId, chunk.segments);
          const validated = mergeAudioInsightChunks({
            uploadId: input.uploadId,
            segments: input.segments,
            chunks: [{ transcriptChunk: chunk, insights }]
          });
          if (chunk.segments.length > 0 && validated.insights.length === 0) {
            throw new Error("audio insight fallback returned no valid evidence-backed output");
          }
          const output = {
            transcriptChunk: chunk,
            insights,
            retryCount: Math.max(0, attempts - 1),
            fallback: true,
            failed: false,
            error: primaryError,
            cacheStatus: "miss" as const
          };
          console.info(
            `[audio-insights] upload_id=${input.uploadId} chunk_index=${chunk.index} segment_count=${chunk.segments.length} input_chars=${inputCharacterCount(chunk.segments)} attempt=${attempts} concurrency=${options.concurrency} attempt_timeout_ms=${options.attemptTimeoutMs} status=completed provider_status=rule_fallback retry_count=${Math.max(0, attempts - 1)} fallback=true fallback_reason=${failureCode(primaryError)} insights=${insights.length} error_name=${primaryError instanceof Error ? primaryError.name : "unknown"} elapsed_ms=${Date.now() - chunkStartedAt}`
          );
          return output;
        } catch (fallbackError) {
          const output = {
            transcriptChunk: chunk,
            insights: [],
            retryCount: Math.max(0, attempts - 1),
            fallback: true,
            failed: true,
            error: fallbackError,
            cacheStatus: "miss" as const
          };
          console.info(
            `[audio-insights] upload_id=${input.uploadId} chunk_index=${chunk.index} segment_count=${chunk.segments.length} input_chars=${inputCharacterCount(chunk.segments)} attempt=${attempts} concurrency=${options.concurrency} attempt_timeout_ms=${options.attemptTimeoutMs} status=failed provider_status=rule_fallback retry_count=${Math.max(0, attempts - 1)} fallback=true fallback_reason=${failureCode(primaryError)} insights=0 error_name=${fallbackError instanceof Error ? fallbackError.name : "unknown"} elapsed_ms=${Date.now() - chunkStartedAt}`
          );
          return output;
        }
      }
    }
  });
  const parallelDurationMs = Date.now() - startedAt;
  const mergeStartedAt = Date.now();
  const merged = mergeAudioInsightChunks({
    uploadId: input.uploadId,
    segments: input.segments,
    chunks: outputs.filter((output) => !output.failed)
  });
  const mergeDurationMs = Date.now() - mergeStartedAt;
  const analysisChunks = outputs.map((output) =>
    analysisChunk({
      transcriptChunk: output.transcriptChunk,
      status: output.failed ? "failed" : "completed",
      retryCount: output.retryCount,
      outputIds: Object.entries(merged.sourceChunkIdsByInsightId)
        .filter(([, chunkIds]) => chunkIds.includes(output.transcriptChunk.id))
        .map(([insightId]) => insightId),
      fallback: output.fallback,
      error: output.error,
      now
    })
  );
  const stats = {
    chunkCount: chunks.length,
    completedChunks: outputs.filter((output) => !output.failed).length,
    failedChunks: outputs.filter((output) => output.failed).length,
    fallbackChunks: outputs.filter((output) => output.fallback && !output.failed).length,
    retrySuccessChunks: outputs.filter((output) => !output.fallback && output.retryCount > 0).length,
    timeoutChunks: outputs.filter((output) => failureCode(output.error) === "timeout").length,
    invalidJsonChunks: outputs.filter((output) => failureCode(output.error) === "invalid_json").length,
    inputInsightCount: merged.inputCount,
    outputInsightCount: merged.insights.length,
    rejectedInsights: merged.rejectedCount,
    duplicateRemoved: merged.duplicateRemoved,
    parallelDurationMs,
    mergeDurationMs,
    checkpointHits: outputs.filter((output) => output.cacheStatus === "hit").length,
    checkpointMisses: outputs.filter((output) => output.cacheStatus === "miss").length,
    checkpointStale: outputs.filter((output) => output.cacheStatus === "stale").length,
    checkpointCorrupt: outputs.filter((output) => output.cacheStatus === "corrupt").length
  };
  console.info(
    `[audio-insights] chunks=${stats.chunkCount} success_chunks=${stats.completedChunks - stats.fallbackChunks} retry_success_chunks=${stats.retrySuccessChunks} failed_chunks=${stats.failedChunks} fallback_chunks=${stats.fallbackChunks} timeout_chunks=${stats.timeoutChunks} invalid_json_chunks=${stats.invalidJsonChunks} checkpoint_hits=${stats.checkpointHits} checkpoint_misses=${stats.checkpointMisses} checkpoint_stale=${stats.checkpointStale} checkpoint_corrupt=${stats.checkpointCorrupt} insights=${stats.outputInsightCount} rejected=${stats.rejectedInsights} duplicates_removed=${stats.duplicateRemoved} wall_clock_ms=${parallelDurationMs} parallel_elapsed_ms=${parallelDurationMs} merge_elapsed_ms=${mergeDurationMs}`
  );

  return { insights: merged.insights, analysisChunks, stats };
}
