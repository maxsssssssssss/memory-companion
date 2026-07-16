import { z } from "zod";
import { BriefItemSchema, type BriefItem, type SemanticSegment, type TranscriptSegment } from "@/lib/domain/types";
import {
  executeWithAnalysisCheckpoint,
  fingerprintAnalysisInput,
  type AnalysisCheckpointResultSource,
  type JsonAnalysisChunkCheckpointStore
} from "@/lib/server/analysis-chunks/checkpoint";
import { mapWithConcurrency } from "@/lib/server/chunks/bounded-scheduler";
import { formatExtractionSegments, planExtractionChunks, type ExtractionChunk } from "./chunks";
import { mergeBriefItemsWithStats } from "./merge";
import type { ExtractionFallbackReason, ExtractionProgressEvent } from "./provider";

const DEFAULT_CONCURRENCY = 2;
const BriefItemsSchema = z.array(BriefItemSchema);

export type DailyBriefChunkExecution = {
  items: BriefItem[];
  resultSource: AnalysisCheckpointResultSource;
  fallbackReason?: ExtractionFallbackReason;
  metadata?: Record<string, unknown>;
};

export type DailyBriefCheckpointContext = {
  store: JsonAnalysisChunkCheckpointStore;
  userId: string;
  recordingDate?: string;
  processorFingerprint: string;
  staleAfterMs: number;
};

export function resolveDailyBriefChunkConcurrency(raw = process.env.DAILY_BRIEF_CHUNK_CONCURRENCY) {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CONCURRENCY;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error("DAILY_BRIEF_CHUNK_CONCURRENCY must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("DAILY_BRIEF_CHUNK_CONCURRENCY must be a positive integer");
  }
  return value;
}

async function emit(
  onProgress: ((event: ExtractionProgressEvent) => void | Promise<void>) | undefined,
  event: ExtractionProgressEvent
) {
  await onProgress?.(event);
}

function relatedSemanticSegments(chunk: ExtractionChunk, semanticSegments: SemanticSegment[]) {
  const sourceIds = new Set(chunk.segments.map((segment) => segment.id));
  return semanticSegments.filter((segment) => segment.sourceSegmentIds.some((id) => sourceIds.has(id)));
}

function chunkInputFingerprint(input: {
  uploadId: string;
  chunk: ExtractionChunk;
  semanticSegments: SemanticSegment[];
  recordingDate?: string;
}) {
  return fingerprintAnalysisInput({
    uploadId: input.uploadId,
    sourceChunkId: input.chunk.id,
    sourceChunkIndex: input.chunk.index,
    recordingDate: input.recordingDate ?? null,
    segments: input.chunk.segments.map((segment) => ({
      id: segment.id,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      speaker: segment.speaker ?? null,
      text: segment.text,
      sceneLabels: segment.sceneLabels,
      valueLabels: segment.valueLabels
    })),
    semanticSegments: relatedSemanticSegments(input.chunk, input.semanticSegments).map((segment) => ({
      id: segment.id,
      sourceSegmentIds: segment.sourceSegmentIds,
      title: segment.title,
      summary: segment.summary
    }))
  });
}

function validateChunkItems(uploadId: string, chunk: ExtractionChunk, items: BriefItem[]) {
  const sourceIds = new Set(chunk.segments.map((segment) => segment.id));
  for (const item of BriefItemsSchema.parse(items)) {
    if (item.uploadId !== uploadId) {
      throw new Error("Daily Brief checkpoint item uploadId does not match");
    }
    if (item.sourceSegmentIds.length === 0 || item.sourceSegmentIds.some((id) => !sourceIds.has(id))) {
      throw new Error("Daily Brief checkpoint item has invalid evidence refs");
    }
  }
}

export async function processDailyBriefChunks(input: {
  uploadId: string;
  segments: TranscriptSegment[];
  semanticSegments?: SemanticSegment[];
  concurrency?: number;
  executeChunk: (chunk: ExtractionChunk) => Promise<DailyBriefChunkExecution>;
  fallbackChunk: (chunk: ExtractionChunk, error: unknown) => Promise<DailyBriefChunkExecution>;
  onProgress?: (event: ExtractionProgressEvent) => void | Promise<void>;
  checkpoint?: DailyBriefCheckpointContext;
  providerLabel?: "openai" | "fixture";
}) {
  const startedAt = Date.now();
  const semanticSegments = input.semanticSegments ?? [];
  const plan = planExtractionChunks({ segments: input.segments, semanticSegments });
  const concurrency = input.concurrency ?? resolveDailyBriefChunkConcurrency();
  await emit(input.onProgress, {
    phase: "planned",
    segmentCount: plan.segmentCount,
    inputChars: plan.inputChars,
    inputBytes: plan.inputBytes,
    estimatedTokensMin: plan.estimatedTokensMin,
    estimatedTokensMax: plan.estimatedTokensMax,
    chunkCount: plan.chunks.length,
    longForm: plan.longForm,
    oversizedChunkCount: plan.oversizedChunkCount
  });

  let completedCount = 0;
  const chunkResults = await mapWithConcurrency({
    items: plan.chunks,
    options: { concurrency },
    worker: async (chunk) => {
      const chunkStartedAt = Date.now();
      await emit(input.onProgress, {
        phase: "chunk_started",
        chunkIndex: chunk.index + 1,
        chunkCount: plan.chunks.length,
        segmentCount: chunk.segments.length,
        inputChars: chunk.inputChars,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds
      });

      const execute = async () => {
        try {
          return await input.executeChunk(chunk);
        } catch (error) {
          return await input.fallbackChunk(chunk, error);
        }
      };

      const execution = input.checkpoint
        ? await executeWithAnalysisCheckpoint<BriefItem[]>({
            store: input.checkpoint.store,
            userId: input.checkpoint.userId,
            uploadId: input.uploadId,
            kind: "daily_brief",
            sourceChunkId: `${input.uploadId}_daily_brief_${chunk.id}`,
            sourceChunkIndex: chunk.index,
            inputFingerprint: chunkInputFingerprint({
              uploadId: input.uploadId,
              chunk,
              semanticSegments,
              recordingDate: input.checkpoint.recordingDate
            }),
            processorFingerprint: input.checkpoint.processorFingerprint,
            outputSchema: BriefItemsSchema,
            validateOutput: (items) => validateChunkItems(input.uploadId, chunk, items),
            staleAfterMs: input.checkpoint.staleAfterMs,
            metadata: {
              segmentCount: chunk.segments.length,
              inputCharacterCount: formatExtractionSegments(chunk.segments).length
            },
            execute: async () => {
              const result = await execute();
              return { output: result.items, resultSource: result.resultSource, metadata: result.metadata };
            }
          })
        : null;
      const result = execution
        ? {
            items: execution.output,
            resultSource: execution.resultSource,
            cacheStatus: execution.cacheStatus,
            fallbackReason: undefined as ExtractionFallbackReason | undefined
          }
        : { ...(await execute()), cacheStatus: "miss" as const };

      completedCount += 1;
      const elapsedMs = Date.now() - chunkStartedAt;
      if (result.resultSource === "rule_fallback") {
        await emit(input.onProgress, {
          phase: "chunk_fallback",
          chunkIndex: chunk.index + 1,
          chunkCount: plan.chunks.length,
          completedCount,
          itemCount: result.items.length,
          elapsedMs,
          reason: result.fallbackReason ?? "provider_error"
        });
      } else {
        await emit(input.onProgress, {
          phase: "chunk_completed",
          chunkIndex: chunk.index + 1,
          chunkCount: plan.chunks.length,
          completedCount,
          itemCount: result.items.length,
          elapsedMs,
          provider: execution?.cacheStatus === "hit" ? "checkpoint" : (input.providerLabel ?? "openai")
        });
      }
      return {
        chunkIndex: chunk.index,
        items: result.items,
        resultSource: result.resultSource,
        cacheStatus: result.cacheStatus,
        elapsedMs
      };
    }
  });

  const mergeStartedAt = Date.now();
  const ordered = [...chunkResults].sort((left, right) => left.chunkIndex - right.chunkIndex);
  const merged = mergeBriefItemsWithStats({
    uploadId: input.uploadId,
    segments: input.segments,
    items: ordered.flatMap((result) => result.items)
  });
  const mergeElapsedMs = Date.now() - mergeStartedAt;
  const fallbackChunks = ordered.filter((result) => result.resultSource === "rule_fallback").length;
  await emit(input.onProgress, {
    phase: "merged",
    ...merged.stats,
    fallbackChunks,
    elapsedMs: Date.now() - startedAt
  });
  const stats = {
    chunkCount: plan.chunks.length,
    concurrency,
    checkpointHits: ordered.filter((result) => result.cacheStatus === "hit").length,
    checkpointMisses: ordered.filter((result) => result.cacheStatus === "miss").length,
    checkpointStale: ordered.filter((result) => result.cacheStatus === "stale").length,
    checkpointCorrupt: ordered.filter((result) => result.cacheStatus === "corrupt").length,
    providerSuccess: ordered.filter((result) => result.resultSource === "provider_success").length,
    providerRetrySuccess: ordered.filter((result) => result.resultSource === "provider_retry_success").length,
    fallbackChunks,
    wallClockMs: Date.now() - startedAt,
    sumChunkElapsedMs: ordered.reduce((sum, result) => sum + result.elapsedMs, 0),
    mergeElapsedMs
  };
  console.info(
    `[daily-brief-chunks] chunk_count=${stats.chunkCount} concurrency=${stats.concurrency} checkpoint_hits=${stats.checkpointHits} checkpoint_misses=${stats.checkpointMisses} checkpoint_stale=${stats.checkpointStale} checkpoint_corrupt=${stats.checkpointCorrupt} provider_success=${stats.providerSuccess} provider_retry_success=${stats.providerRetrySuccess} fallback_count=${stats.fallbackChunks} wall_clock_ms=${stats.wallClockMs} sum_chunk_elapsed_ms=${stats.sumChunkElapsedMs} merge_elapsed_ms=${stats.mergeElapsedMs}`
  );
  return { items: merged.items, chunkResults: ordered, stats };
}
