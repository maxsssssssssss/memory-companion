import { z } from "zod";

import {
  BriefItemSchema,
  type BriefItem,
  type SemanticSegment,
  type TranscriptSegment
} from "@/lib/domain/types";
import {
  AnalysisChunkCheckpointSchema,
  AnalysisCheckpointBusyError,
  buildAnalysisCheckpointId,
  executeWithAnalysisCheckpoint,
  fingerprintAnalysisInput,
  lookupAnalysisCheckpoint,
  type AnalysisCheckpointCacheStatus,
  type AnalysisCheckpointExecutionResult,
  type AnalysisCheckpointResultSource,
  type JsonAnalysisChunkCheckpointStore
} from "@/lib/server/analysis-chunks/checkpoint";
import { mapWithConcurrency, runChunkAttempt } from "@/lib/server/chunks/bounded-scheduler";
import { formatExtractionSegments, planExtractionChunks, type ExtractionChunk } from "./chunks";
import {
  classifyDailyBriefFailure,
  DailyBriefEvidenceValidationError
} from "./failure-diagnostics";
import { mergeBriefItemsWithStats } from "./merge";
import type { ExtractionFallbackReason, ExtractionProgressEvent } from "./provider";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RECOVERY_CONCURRENCY = 1;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const BriefItemsSchema = z.array(BriefItemSchema);

export type DailyBriefRecoveryMode = "standard" | "compact";

export type DailyBriefChunkAttemptContext = {
  attempt: number;
  concurrency: number;
  recoveryMode: DailyBriefRecoveryMode;
  signal: AbortSignal;
};

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

type DailyBriefAttemptRecord = {
  attempt: number;
  recoveryMode: DailyBriefRecoveryMode;
  elapsedMs: number;
  execution?: DailyBriefChunkExecution;
  error?: unknown;
};

type CheckpointExecutionPayload = {
  output: BriefItem[];
  resultSource: AnalysisCheckpointResultSource;
  metadata?: Record<string, unknown>;
};

type CheckpointOwner = {
  promise: Promise<AnalysisCheckpointExecutionResult<BriefItem[]>>;
  resolve: (payload: CheckpointExecutionPayload) => void;
  reject: (error: unknown) => void;
};

type CheckpointHeartbeat = {
  stop: () => Promise<void>;
};

type DailyBriefChunkContext = {
  chunk: ExtractionChunk;
  startedAt?: number;
  checkpointOwner?: CheckpointOwner;
  checkpointHeartbeat?: CheckpointHeartbeat;
};

type DailyBriefFinalResult = {
  chunkIndex: number;
  items: BriefItem[];
  resultSource: AnalysisCheckpointResultSource;
  cacheStatus: AnalysisCheckpointCacheStatus;
  fallbackReason?: ExtractionFallbackReason;
  metadata: Record<string, unknown>;
  elapsedMs: number;
  providerAttemptCount: number;
};

class DailyBriefBudgetError extends Error {
  readonly code = "DAILY_BRIEF_DEADLINE";

  constructor() {
    super("Daily Brief total budget exceeded");
    this.name = "DailyBriefBudgetError";
  }
}

function readStrictInteger(input: {
  name: string;
  raw: string | undefined;
  fallback: number;
  min: number;
  max: number;
}) {
  if (input.raw === undefined || input.raw.trim() === "") return input.fallback;
  const normalized = input.raw.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${input.name} must be an integer between ${input.min} and ${input.max}`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < input.min || value > input.max) {
    throw new Error(`${input.name} must be an integer between ${input.min} and ${input.max}`);
  }
  return value;
}

function explicitInteger(input: {
  name: string;
  value: number | undefined;
  fallback: () => number;
  min: number;
  max: number;
}) {
  if (input.value === undefined) return input.fallback();
  if (!Number.isSafeInteger(input.value) || input.value < input.min || input.value > input.max) {
    throw new Error(`${input.name} must be an integer between ${input.min} and ${input.max}`);
  }
  return input.value;
}

export function resolveDailyBriefChunkConcurrency(raw = process.env.DAILY_BRIEF_CHUNK_CONCURRENCY) {
  return readStrictInteger({
    name: "DAILY_BRIEF_CHUNK_CONCURRENCY",
    raw,
    fallback: DEFAULT_CONCURRENCY,
    min: 1,
    max: 8
  });
}

export function resolveDailyBriefRecoveryConcurrency(
  raw = process.env.DAILY_BRIEF_CHUNK_RECOVERY_CONCURRENCY
) {
  return readStrictInteger({
    name: "DAILY_BRIEF_CHUNK_RECOVERY_CONCURRENCY",
    raw,
    fallback: DEFAULT_RECOVERY_CONCURRENCY,
    min: 1,
    max: 4
  });
}

export function resolveDailyBriefMaxRetries(
  raw = process.env.DAILY_BRIEF_CHUNK_MAX_RETRIES ?? process.env.EXTRACTION_MAX_RETRIES
) {
  return readStrictInteger({
    name: "DAILY_BRIEF_CHUNK_MAX_RETRIES",
    raw,
    fallback: DEFAULT_MAX_RETRIES,
    min: 0,
    max: 2
  });
}

export function resolveDailyBriefRetryDelayMs(
  raw = process.env.DAILY_BRIEF_CHUNK_RETRY_DELAY_MS
) {
  return readStrictInteger({
    name: "DAILY_BRIEF_CHUNK_RETRY_DELAY_MS",
    raw,
    fallback: DEFAULT_RETRY_DELAY_MS,
    min: 0,
    max: 60_000
  });
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
  const parsedItems = BriefItemsSchema.parse(items);
  const sourceById = new Map(chunk.segments.map((segment) => [segment.id, segment] as const));
  let invalidReferenceCount = 0;
  let rejectedItemCount = 0;
  for (const item of parsedItems) {
    const uniqueSourceIds = new Set(item.sourceSegmentIds);
    const resolvedSources = item.sourceSegmentIds.flatMap((id) => {
      const segment = sourceById.get(id);
      return segment ? [segment] : [];
    });
    const expectedStart = resolvedSources.length > 0
      ? Math.min(...resolvedSources.map((segment) => segment.startSeconds))
      : Number.NaN;
    const expectedEnd = resolvedSources.length > 0
      ? Math.max(...resolvedSources.map((segment) => segment.endSeconds))
      : Number.NaN;
    const invalid = item.uploadId !== uploadId
      || item.sourceSegmentIds.length === 0
      || uniqueSourceIds.size !== item.sourceSegmentIds.length
      || resolvedSources.length !== item.sourceSegmentIds.length
      || item.sourceTimeRange.startSeconds !== expectedStart
      || item.sourceTimeRange.endSeconds !== expectedEnd
      || !resolvedSources.some((segment) => segment.text.includes(item.transcriptExcerpt));
    if (invalid) {
      invalidReferenceCount += Math.max(
        1,
        item.sourceSegmentIds.filter((id) => !sourceById.has(id)).length
          + Math.max(0, item.sourceSegmentIds.length - uniqueSourceIds.size)
      );
      rejectedItemCount += 1;
    }
  }
  if (rejectedItemCount > 0) {
    throw new DailyBriefEvidenceValidationError({ invalidReferenceCount, rejectedItemCount });
  }
  return parsedItems;
}

function isFallbackReason(value: unknown): value is ExtractionFallbackReason {
  return [
    "deadline",
    "network_error",
    "fetch_timeout",
    "provider_5xx",
    "rate_limit",
    "empty_response",
    "incomplete_response",
    "max_output_tokens",
    "invalid_json",
    "validation_failure",
    "evidence_validation_failure",
    "content_filter",
    "unknown_provider_error"
  ].includes(String(value));
}

function fallbackReasonFromMetadata(metadata: Record<string, unknown> | undefined) {
  return isFallbackReason(metadata?.fallbackReason) ? metadata.fallbackReason : undefined;
}

function checkpointArguments(input: {
  uploadId: string;
  context: DailyBriefChunkContext;
  semanticSegments: SemanticSegment[];
  checkpoint: DailyBriefCheckpointContext;
}) {
  const { chunk } = input.context;
  return {
    store: input.checkpoint.store,
    userId: input.checkpoint.userId,
    uploadId: input.uploadId,
    kind: "daily_brief" as const,
    sourceChunkId: `${input.uploadId}_daily_brief_${chunk.id}`,
    sourceChunkIndex: chunk.index,
    inputFingerprint: chunkInputFingerprint({
      uploadId: input.uploadId,
      chunk,
      semanticSegments: input.semanticSegments,
      recordingDate: input.checkpoint.recordingDate
    }),
    processorFingerprint: input.checkpoint.processorFingerprint,
    outputSchema: BriefItemsSchema,
    validateOutput: (items: BriefItem[]) => {
      validateChunkItems(input.uploadId, chunk, items);
    },
    staleAfterMs: input.checkpoint.staleAfterMs,
    metadata: {
      segmentCount: chunk.segments.length,
      inputCharacterCount: formatExtractionSegments(chunk.segments).length
    }
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function contextElapsedMs(context: DailyBriefChunkContext) {
  return context.startedAt === undefined ? 0 : Date.now() - context.startedAt;
}

async function startCheckpointHeartbeat(
  arguments_: ReturnType<typeof checkpointArguments>
): Promise<CheckpointHeartbeat | undefined> {
  const checkpointId = buildAnalysisCheckpointId(arguments_);
  const parsed = AnalysisChunkCheckpointSchema.safeParse(await arguments_.store.read(checkpointId));
  if (!parsed.success || parsed.data.status !== "processing" || !parsed.data.startedAt) {
    return undefined;
  }
  const ownerAttemptCount = parsed.data.attemptCount;
  const ownerStartedAt = parsed.data.startedAt;
  const intervalMs = Math.max(10, Math.min(10_000, Math.floor(arguments_.staleAfterMs / 3)));
  let stopped = false;
  let inFlight = Promise.resolve();
  const touch = async () => {
    const current = AnalysisChunkCheckpointSchema.safeParse(
      await arguments_.store.read(checkpointId)
    );
    if (
      !current.success
      || current.data.status !== "processing"
      || current.data.attemptCount !== ownerAttemptCount
      || current.data.startedAt !== ownerStartedAt
    ) {
      stopped = true;
      return;
    }
    await arguments_.store.write({
      ...current.data,
      updatedAt: new Date().toISOString()
    });
  };
  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = inFlight.then(touch).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    }
  };
}

export async function processDailyBriefChunks(input: {
  uploadId: string;
  segments: TranscriptSegment[];
  semanticSegments?: SemanticSegment[];
  concurrency?: number;
  recoveryConcurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  attemptTimeoutMs?: number;
  totalBudgetMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  executeChunk: (
    chunk: ExtractionChunk,
    context: DailyBriefChunkAttemptContext
  ) => Promise<DailyBriefChunkExecution>;
  fallbackChunk: (chunk: ExtractionChunk, error: unknown) => Promise<DailyBriefChunkExecution>;
  shouldRetry?: (error: unknown) => boolean;
  retryDelayForError?: (error: unknown, configuredDelayMs: number) => number;
  recoveryModeForError?: (error: unknown) => DailyBriefRecoveryMode;
  failureReasonForError?: (error: unknown) => ExtractionFallbackReason;
  onProgress?: (event: ExtractionProgressEvent) => void | Promise<void>;
  checkpoint?: DailyBriefCheckpointContext;
  providerLabel?: "openai" | "fixture";
}) {
  const startedAt = Date.now();
  const semanticSegments = input.semanticSegments ?? [];
  const plan = planExtractionChunks({ segments: input.segments, semanticSegments });
  const concurrency = explicitInteger({
    name: "concurrency",
    value: input.concurrency,
    fallback: resolveDailyBriefChunkConcurrency,
    min: 1,
    max: 8
  });
  const recoveryConcurrency = explicitInteger({
    name: "recoveryConcurrency",
    value: input.recoveryConcurrency,
    fallback: resolveDailyBriefRecoveryConcurrency,
    min: 1,
    max: 4
  });
  const maxRetries = explicitInteger({
    name: "maxRetries",
    value: input.maxRetries,
    fallback: resolveDailyBriefMaxRetries,
    min: 0,
    max: 2
  });
  const retryDelayMs = explicitInteger({
    name: "retryDelayMs",
    value: input.retryDelayMs,
    fallback: resolveDailyBriefRetryDelayMs,
    min: 0,
    max: 60_000
  });
  const attemptTimeoutMs = input.attemptTimeoutMs === undefined
    ? undefined
    : explicitInteger({
        name: "attemptTimeoutMs",
        value: input.attemptTimeoutMs,
        fallback: () => input.attemptTimeoutMs!,
        min: 1,
        max: 5 * 60_000
      });
  if (
    input.totalBudgetMs !== undefined
    && (!Number.isFinite(input.totalBudgetMs) || input.totalBudgetMs < 0)
  ) {
    throw new Error("totalBudgetMs must be a finite non-negative number");
  }
  const sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const budgetDeadline = input.totalBudgetMs === undefined
    ? Number.POSITIVE_INFINITY
    : startedAt + input.totalBudgetMs;
  const attemptHistory = new Map<number, DailyBriefAttemptRecord[]>();
  const finalByIndex = new Map<number, DailyBriefFinalResult>();
  const contexts = plan.chunks.map((chunk): DailyBriefChunkContext => ({ chunk }));

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

  const beginContext = async (context: DailyBriefChunkContext) => {
    context.startedAt = Date.now();
    await emit(input.onProgress, {
      phase: "chunk_started",
      chunkIndex: context.chunk.index + 1,
      chunkCount: plan.chunks.length,
      segmentCount: context.chunk.segments.length,
      inputChars: context.chunk.inputChars,
      startSeconds: context.chunk.startSeconds,
      endSeconds: context.chunk.endSeconds
    });
  };

  const acquireCheckpoint = async (context: DailyBriefChunkContext) => {
    if (!input.checkpoint) return null;
    const arguments_ = checkpointArguments({
      uploadId: input.uploadId,
      context,
      semanticSegments,
      checkpoint: input.checkpoint
    });

    while (true) {
      const payload = createDeferred<CheckpointExecutionPayload>();
      const owned = createDeferred<void>();
      const promise = executeWithAnalysisCheckpoint<BriefItem[]>({
        ...arguments_,
        execute: async () => {
          owned.resolve();
          return await payload.promise;
        }
      });
      try {
        const outcome = await Promise.race([
          owned.promise.then(() => ({ kind: "owner" as const })),
          promise.then((result) => ({ kind: "completed" as const, result }))
        ]);
        if (outcome.kind === "completed") {
          const metadata = outcome.result.checkpoint.metadata;
          return {
            kind: "completed" as const,
            result: {
              chunkIndex: context.chunk.index,
              items: outcome.result.output,
              resultSource: outcome.result.resultSource,
              cacheStatus: "hit" as const,
              ...(fallbackReasonFromMetadata(metadata)
                ? { fallbackReason: fallbackReasonFromMetadata(metadata) }
                : {}),
              metadata,
              elapsedMs: contextElapsedMs(context),
              providerAttemptCount: 0
            }
          };
        }
        const owner: CheckpointOwner = {
          promise,
          resolve: payload.resolve,
          reject: payload.reject
        };
        context.checkpointOwner = owner;
        context.checkpointHeartbeat = await startCheckpointHeartbeat(arguments_);
        return { kind: "owner" as const, owner };
      } catch (error) {
        if (!(error instanceof AnalysisCheckpointBusyError)) throw error;
      }

      while (true) {
        const remaining = budgetDeadline - Date.now();
        if (remaining <= 0) throw new DailyBriefBudgetError();
        const lookup = await lookupAnalysisCheckpoint<BriefItem[]>(arguments_);
        if (lookup.cacheStatus === "hit" && lookup.output && lookup.checkpoint?.resultSource) {
          const metadata = lookup.checkpoint.metadata;
          return {
            kind: "completed" as const,
            result: {
              chunkIndex: context.chunk.index,
              items: lookup.output,
              resultSource: lookup.checkpoint.resultSource,
              cacheStatus: "hit" as const,
              ...(fallbackReasonFromMetadata(metadata)
                ? { fallbackReason: fallbackReasonFromMetadata(metadata) }
                : {}),
              metadata,
              elapsedMs: contextElapsedMs(context),
              providerAttemptCount: 0
            }
          };
        }
        if (lookup.checkpoint?.status !== "processing" || lookup.cacheStatus !== "miss") break;
        await sleep(Math.min(250, remaining));
      }
      // A failed, corrupt, or stale foreign owner can now be reclaimed by the
      // normal atomic checkpoint execution path.
    }
  };

  const finalize = async (
    context: DailyBriefChunkContext,
    execution: DailyBriefChunkExecution,
    resultSource: AnalysisCheckpointResultSource,
    providerAttemptCount: number
  ): Promise<DailyBriefFinalResult> => {
    const items = validateChunkItems(input.uploadId, context.chunk, execution.items);
    const metadata = {
      ...(execution.metadata ?? {}),
      providerAttemptCount,
      retryCount: Math.max(0, providerAttemptCount - 1),
      ...(execution.fallbackReason ? { fallbackReason: execution.fallbackReason } : {})
    };
    if (!context.checkpointOwner) {
      return {
        chunkIndex: context.chunk.index,
        items,
        resultSource,
        cacheStatus: "miss",
        ...(execution.fallbackReason ? { fallbackReason: execution.fallbackReason } : {}),
        metadata,
        elapsedMs: contextElapsedMs(context),
        providerAttemptCount
      };
    }
    await context.checkpointHeartbeat?.stop();
    context.checkpointHeartbeat = undefined;
    context.checkpointOwner.resolve({ output: items, resultSource, metadata });
    const persisted = await context.checkpointOwner.promise;
    context.checkpointOwner = undefined;
    return {
      chunkIndex: context.chunk.index,
      items: persisted.output,
      resultSource: persisted.resultSource,
      cacheStatus: persisted.cacheStatus,
      ...(fallbackReasonFromMetadata(persisted.checkpoint.metadata)
        ? { fallbackReason: fallbackReasonFromMetadata(persisted.checkpoint.metadata) }
        : {}),
      metadata: persisted.checkpoint.metadata,
      elapsedMs: contextElapsedMs(context),
      providerAttemptCount
    };
  };

  let completedCount = 0;
  const emitCompleted = async (context: DailyBriefChunkContext, result: DailyBriefFinalResult) => {
    completedCount += 1;
    if (result.resultSource === "rule_fallback") {
      await emit(input.onProgress, {
        phase: "chunk_fallback",
        chunkIndex: context.chunk.index + 1,
        chunkCount: plan.chunks.length,
        completedCount,
        itemCount: result.items.length,
        elapsedMs: result.elapsedMs,
        reason: result.fallbackReason ?? "unknown_provider_error",
        resultSource: "rule_fallback"
      });
      return;
    }
    await emit(input.onProgress, {
      phase: "chunk_completed",
      chunkIndex: context.chunk.index + 1,
      chunkCount: plan.chunks.length,
      completedCount,
      itemCount: result.items.length,
      elapsedMs: result.elapsedMs,
      provider: result.cacheStatus === "hit" ? "checkpoint" : (input.providerLabel ?? "openai"),
      resultSource: result.resultSource === "provider_retry_success"
        ? "provider_retry_success"
        : "provider_success"
    });
  };

  const remainingBudgetMs = () => budgetDeadline - Date.now();
  const failureReason = (error: unknown) => input.failureReasonForError?.(error)
    ?? classifyDailyBriefFailure(error).failureCode;
  const shouldRetry = (error: unknown) => input.shouldRetry?.(error)
    ?? classifyDailyBriefFailure(error).retryable;

  const runAttempt = async (
    context: DailyBriefChunkContext,
    attempt: number,
    attemptConcurrency: number,
    recoveryMode: DailyBriefRecoveryMode
  ): Promise<DailyBriefAttemptRecord> => {
    const attemptStartedAt = Date.now();
    try {
      const remaining = remainingBudgetMs();
      if (remaining <= 0) throw new DailyBriefBudgetError();
      const execute = async (signal: AbortSignal) => {
        const execution = await input.executeChunk(context.chunk, {
          attempt,
          concurrency: attemptConcurrency,
          recoveryMode,
          signal
        });
        if (execution.resultSource !== "provider_success") {
          throw new Error("Daily Brief provider attempt returned an invalid result source");
        }
        validateChunkItems(input.uploadId, context.chunk, execution.items);
        return execution;
      };
      const effectiveTimeout = Number.isFinite(remaining)
        ? Math.max(1, Math.min(attemptTimeoutMs ?? remaining, remaining))
        : attemptTimeoutMs;
      const execution = effectiveTimeout === undefined
        ? await execute(new AbortController().signal)
        : (await runChunkAttempt({
            execute: (signal) => execute(signal),
            attemptTimeoutMs: effectiveTimeout,
            maxRetries: 0
          })).value;
      const record: DailyBriefAttemptRecord = {
        attempt,
        recoveryMode,
        elapsedMs: Date.now() - attemptStartedAt,
        execution
      };
      const history = attemptHistory.get(context.chunk.index) ?? [];
      history.push(record);
      attemptHistory.set(context.chunk.index, history);
      return record;
    } catch (error) {
      const record: DailyBriefAttemptRecord = {
        attempt,
        recoveryMode,
        elapsedMs: Date.now() - attemptStartedAt,
        error
      };
      const history = attemptHistory.get(context.chunk.index) ?? [];
      history.push(record);
      attemptHistory.set(context.chunk.index, history);
      return record;
    }
  };

  const firstPassStartedAt = Date.now();
  const unresolved = await mapWithConcurrency({
    items: contexts,
    options: { concurrency },
    worker: async (context) => {
      await beginContext(context);
      let checkpoint;
      try {
        checkpoint = await acquireCheckpoint(context);
      } catch (error) {
        return { context, error };
      }
      if (checkpoint?.kind === "completed") {
        finalByIndex.set(context.chunk.index, checkpoint.result);
        await emitCompleted(context, checkpoint.result);
        return null;
      }
      const record = await runAttempt(context, 1, concurrency, "standard");
      if (record.execution) {
        const result = await finalize(context, record.execution, "provider_success", 1);
        finalByIndex.set(context.chunk.index, result);
        await emitCompleted(context, result);
        return null;
      }
      return { context, error: record.error };
    }
  });
  let failed = unresolved.filter(
    (record): record is { context: DailyBriefChunkContext; error: unknown } => record !== null
  );
  const firstPassWallMs = contexts.length > 0 ? Date.now() - firstPassStartedAt : 0;

  let recoveryWallMs = 0;
  for (let retryIndex = 0; retryIndex < maxRetries && failed.length > 0; retryIndex += 1) {
    const classified = failed.map((record) => ({ record, retryable: shouldRetry(record.error) }));
    const retryable = classified.filter((item) => item.retryable).map((item) => item.record);
    const notRetryable = classified.filter((item) => !item.retryable).map((item) => item.record);
    if (retryable.length === 0) {
      failed = notRetryable;
      break;
    }
    const recoveryStartedAt = Date.now();
    const recovered = await mapWithConcurrency({
      items: retryable,
      options: { concurrency: recoveryConcurrency },
      worker: async (record) => {
        const configuredDelay = Math.max(
          0,
          input.retryDelayForError?.(record.error, retryDelayMs) ?? retryDelayMs
        );
        const remainingBeforeDelay = remainingBudgetMs();
        if (remainingBeforeDelay > 0 && configuredDelay > 0) {
          await sleep(Math.min(configuredDelay, remainingBeforeDelay));
        }
        const attempt = retryIndex + 2;
        const recoveryMode = input.recoveryModeForError?.(record.error) ?? "standard";
        const retried = await runAttempt(record.context, attempt, recoveryConcurrency, recoveryMode);
        if (retried.execution) {
          const result = await finalize(
            record.context,
            retried.execution,
            "provider_retry_success",
            attempt
          );
          finalByIndex.set(record.context.chunk.index, result);
          await emitCompleted(record.context, result);
          return null;
        }
        return { context: record.context, error: retried.error };
      }
    });
    recoveryWallMs += Date.now() - recoveryStartedAt;
    failed = [
      ...notRetryable,
      ...recovered.filter(
        (record): record is { context: DailyBriefChunkContext; error: unknown } => record !== null
      )
    ];
  }

  if (failed.length > 0) {
    await mapWithConcurrency({
      items: failed,
      options: { concurrency },
      worker: async ({ context, error }) => {
        try {
          const fallback = await input.fallbackChunk(context.chunk, error);
          if (fallback.resultSource !== "rule_fallback") {
            throw new Error("Daily Brief fallback returned an invalid result source");
          }
          const reason = fallback.fallbackReason ?? failureReason(error);
          const providerAttemptCount = attemptHistory.get(context.chunk.index)?.length ?? 0;
          const result = await finalize(
            context,
            { ...fallback, fallbackReason: reason },
            "rule_fallback",
            providerAttemptCount
          );
          finalByIndex.set(context.chunk.index, result);
          await emitCompleted(context, result);
        } catch (fallbackError) {
          const owner = context.checkpointOwner;
          await context.checkpointHeartbeat?.stop();
          context.checkpointHeartbeat = undefined;
          owner?.reject(fallbackError);
          context.checkpointOwner = undefined;
          if (owner) {
            await owner.promise.catch(() => undefined);
          }
          throw fallbackError;
        }
      }
    });
  }

  const mergeStartedAt = Date.now();
  const ordered = contexts.map((context) => {
    const result = finalByIndex.get(context.chunk.index);
    if (!result) throw new Error(`Daily Brief chunk ${context.chunk.index} did not produce a result`);
    return result;
  });
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

  const failureCodes = [...attemptHistory.entries()].map(([chunkIndex, history]) => ({
    chunkIndex,
    codes: history.flatMap((record) => record.error ? [failureReason(record.error)] : [])
  }));
  const countChunksWith = (codes: ExtractionFallbackReason[]) => failureCodes.filter(
    (entry) => entry.codes.some((code) => codes.includes(code))
  ).length;
  const sumProviderMs = [...attemptHistory.values()].flat().reduce(
    (sum, record) => sum + record.elapsedMs,
    0
  );
  const stats = {
    chunkCount: plan.chunks.length,
    concurrency,
    recoveryConcurrency,
    maxRetries,
    checkpointHits: ordered.filter((result) => result.cacheStatus === "hit").length,
    checkpointMisses: ordered.filter((result) => result.cacheStatus === "miss").length,
    checkpointStale: ordered.filter((result) => result.cacheStatus === "stale").length,
    checkpointCorrupt: ordered.filter((result) => result.cacheStatus === "corrupt").length,
    firstAttemptSuccess: [...attemptHistory.values()].filter((history) => history[0]?.execution).length,
    providerSuccess: ordered.filter((result) => result.resultSource === "provider_success").length,
    providerRetrySuccess: ordered.filter((result) => result.resultSource === "provider_retry_success").length,
    retryChunks: [...attemptHistory.values()].filter((history) => history.length > 1).length,
    fallbackChunks,
    timeoutChunks: countChunksWith(["fetch_timeout"]),
    incompleteResponseChunks: countChunksWith(["incomplete_response", "max_output_tokens"]),
    invalidJsonChunks: countChunksWith(["invalid_json", "empty_response"]),
    rateLimitChunks: countChunksWith(["rate_limit"]),
    provider5xxChunks: countChunksWith(["provider_5xx"]),
    validationFailureChunks: countChunksWith(["validation_failure"]),
    evidenceValidationFailureChunks: countChunksWith(["evidence_validation_failure"]),
    firstPassWallMs,
    recoveryWallMs,
    criticalPathMs: firstPassWallMs + recoveryWallMs,
    sumProviderMs,
    wallClockMs: Date.now() - startedAt,
    sumChunkElapsedMs: ordered.reduce((sum, result) => sum + result.elapsedMs, 0),
    mergeElapsedMs
  };
  console.info(
    `[daily-brief-chunks] chunk_count=${stats.chunkCount} concurrency=${stats.concurrency} recovery_concurrency=${stats.recoveryConcurrency} checkpoint_hits=${stats.checkpointHits} checkpoint_misses=${stats.checkpointMisses} checkpoint_stale=${stats.checkpointStale} checkpoint_corrupt=${stats.checkpointCorrupt} first_attempt_success=${stats.firstAttemptSuccess} provider_success=${stats.providerSuccess} provider_retry_success=${stats.providerRetrySuccess} retry_chunks=${stats.retryChunks} fallback_count=${stats.fallbackChunks} timeout_chunks=${stats.timeoutChunks} incomplete_response_chunks=${stats.incompleteResponseChunks} invalid_json_chunks=${stats.invalidJsonChunks} rate_limit_chunks=${stats.rateLimitChunks} provider_5xx_chunks=${stats.provider5xxChunks} validation_failure_chunks=${stats.validationFailureChunks} evidence_validation_failure_chunks=${stats.evidenceValidationFailureChunks} first_pass_wall_ms=${stats.firstPassWallMs} recovery_wall_ms=${stats.recoveryWallMs} critical_path_ms=${stats.criticalPathMs} sum_provider_ms=${stats.sumProviderMs} wall_clock_ms=${stats.wallClockMs} sum_chunk_elapsed_ms=${stats.sumChunkElapsedMs} merge_elapsed_ms=${stats.mergeElapsedMs}`
  );
  return {
    items: merged.items,
    chunkResults: ordered,
    stats,
    attemptHistory: Object.fromEntries(
      [...attemptHistory.entries()].map(([chunkIndex, history]) => [chunkIndex, history.map((record) => ({
        attempt: record.attempt,
        recoveryMode: record.recoveryMode,
        elapsedMs: record.elapsedMs,
        status: record.execution ? "success" : "failed",
        failureReason: record.error ? failureReason(record.error) : null
      }))])
    )
  };
}
