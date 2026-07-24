import { AnalysisChunkSchema, type AnalysisChunk, type TranscriptChunk } from "@/lib/domain/chunks";
import { transcriptSpeakerIdentityFingerprint } from "@/lib/domain/speaker-identity";
import type { AudioInsight, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { z } from "zod";
import {
  executeWithAnalysisCheckpoint,
  fingerprintAnalysisInput,
  lookupAnalysisCheckpoint,
  type JsonAnalysisChunkCheckpointStore
} from "@/lib/server/analysis-chunks/checkpoint";
import {
  buildConservativeRelationshipSignalFallbackCards,
  hasRelationshipSignalContext
} from "@/lib/processing/relationship-signals";
import { ChunkAttemptTimeoutError, mapWithConcurrency, runChunkAttempt } from "@/lib/server/chunks/bounded-scheduler";
import {
  StructuredJsonResponseError,
  type StructuredJsonDiagnostics
} from "@/lib/server/openai/structured-json";
import { ZodError } from "zod";
import type {
  RelationshipSignalCandidateAudit,
  RelationshipSignalProvider,
  RelationshipSignalRecoveryMode,
  RelationshipSignalRequestMetrics
} from "./provider";
import { selectRelationshipContext } from "./context-selector";
import {
  createRelationshipSignalCandidates,
  reduceRelationshipSignalCandidates,
  relationshipCardsToCandidates,
  RelationshipSignalCandidateSchema,
  type RelationshipCandidateValidationRejection,
  type RelationshipSignalCandidate
} from "./candidates";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RECOVERY_CONCURRENCY = 1;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 75_000;
const DEFAULT_TOTAL_BUDGET_MS = 160_000;

export type RelationshipSignalChunkProcessingOptions = {
  concurrency?: number;
  recoveryConcurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  attemptTimeoutMs?: number;
  totalBudgetMs?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => string;
  evaluationRawResponseCapture?: boolean;
  analysisCheckpoint?: {
    store: JsonAnalysisChunkCheckpointStore;
    userId: string;
    processorFingerprint?: string;
    staleAfterMs?: number;
  };
};

const RelationshipCandidateArraySchema = z.array(RelationshipSignalCandidateSchema);
const RelationshipCandidateValidationRejectionArraySchema: z.ZodType<RelationshipCandidateValidationRejection[]> = z.array(
  z.object({
    candidateId: z.string().min(1),
    rejectionReason: z.enum([
      "invalid_schema",
      "forbidden_judgment",
      "caution_required",
      "evidence_missing_or_invalid"
    ])
  }).strict()
);

function checkpointValidationRejections(value: unknown) {
  const parsed = RelationshipCandidateValidationRejectionArraySchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function validationRejectionReasons(rejections: RelationshipCandidateValidationRejection[]) {
  return rejections.reduce<Record<string, number>>((counts, rejection) => {
    counts[rejection.rejectionReason] = (counts[rejection.rejectionReason] ?? 0) + 1;
    return counts;
  }, {});
}

function readInteger(name: string, fallback: number, min: number, max: number) {
  const value = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function config(options: RelationshipSignalChunkProcessingOptions | undefined) {
  return {
    concurrency: options?.concurrency ?? readInteger("RELATIONSHIP_SIGNAL_CHUNK_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 12),
    recoveryConcurrency: options?.recoveryConcurrency ?? readInteger("RELATIONSHIP_SIGNAL_CHUNK_RECOVERY_CONCURRENCY", DEFAULT_RECOVERY_CONCURRENCY, 1, 4),
    maxRetries: options?.maxRetries ?? readInteger("RELATIONSHIP_SIGNAL_CHUNK_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0, 1),
    retryDelayMs: options?.retryDelayMs ?? readInteger("RELATIONSHIP_SIGNAL_CHUNK_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS, 0, 60_000),
    attemptTimeoutMs: options?.attemptTimeoutMs ?? readInteger("RELATIONSHIP_SIGNAL_CHUNK_ATTEMPT_TIMEOUT_MS", DEFAULT_ATTEMPT_TIMEOUT_MS, 1, 10 * 60_000),
    totalBudgetMs: options?.totalBudgetMs ?? readInteger("RELATIONSHIP_SIGNAL_CHUNK_TOTAL_BUDGET_MS", DEFAULT_TOTAL_BUDGET_MS, 1, 30 * 60_000),
    random: options?.random ?? Math.random,
    sleep: options?.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  };
}

function relatedSemanticSegments(chunk: TranscriptChunk, semanticSegments: SemanticSegment[]) {
  const sourceIds = new Set(chunk.segments.map((segment) => segment.id));
  return semanticSegments.filter((segment) => segment.sourceSegmentIds.some((id) => sourceIds.has(id)));
}

function relatedAudioInsights(chunk: TranscriptChunk, audioInsights: AudioInsight[]) {
  const sourceIds = new Set(chunk.segments.map((segment) => segment.id));
  return audioInsights.filter((insight) => insight.sourceSegmentIds.some((id) => sourceIds.has(id)));
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "unknown relationship signal chunk error")
    .replace(/([?&](?:token|access_token|api_key|key)=)[^&\s]+/gi, "$1****")
    .slice(0, 300);
}

function relationshipInputCharacterCount(input: {
  transcriptChunk: TranscriptChunk;
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
}) {
  const transcript = input.transcriptChunk.segments.reduce(
    (total, segment) => total + segment.id.length + segment.text.length + (segment.speaker?.length ?? 0) + 32,
    0
  );
  const semantic = input.semanticSegments.reduce(
    (total, segment) => total + segment.id.length + segment.title.length + segment.summary.length + 24,
    0
  );
  const insights = input.audioInsights.reduce(
    (total, insight) => total + insight.id.length + insight.summary.length + insight.evidence.length + 24,
    0
  );
  return transcript + semantic + insights;
}

function relationshipInputFingerprint(input: {
  uploadId: string;
  recordingDate: string;
  transcriptChunk: TranscriptChunk;
  audioInsights: AudioInsight[];
  shouldProcess: boolean;
}) {
  const selectedContext = selectRelationshipContext({
    segments: input.transcriptChunk.segments,
    audioInsights: input.audioInsights
  });
  return fingerprintAnalysisInput({
    uploadId: input.uploadId,
    recordingDate: input.recordingDate,
    sourceChunkId: input.transcriptChunk.id,
    sourceChunkIndex: input.transcriptChunk.index,
    shouldProcess: input.shouldProcess,
    segments: input.transcriptChunk.segments.map((segment) => ({
      id: segment.id,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      speaker: segment.speaker ?? null,
      identity: transcriptSpeakerIdentityFingerprint(segment),
      text: segment.text
    })),
    audioInsights: selectedContext.audioInsights.map((insight) => ({
      id: insight.id,
      sourceSegmentIds: insight.sourceSegmentIds,
      sourceTimeRange: insight.sourceTimeRange,
      speakerId: insight.speaker.id,
      summary: insight.summary,
      toneLabels: insight.toneLabels,
      emotionLabels: insight.emotionLabels,
      interactionLabels: insight.interactionLabels,
      atmosphereLabels: insight.atmosphereLabels ?? []
    }))
  });
}

function relationshipProcessorFingerprint(override?: string) {
  const configuredProvider = process.env.RELATIONSHIP_SIGNAL_PROVIDER?.trim().toLowerCase() || "openai";
  return fingerprintAnalysisInput({
    kind: "relationship_candidate",
    provider: configuredProvider,
    model: process.env.OPENAI_RELATIONSHIP_SIGNAL_MODEL ?? process.env.OPENAI_TEXT_MODEL ?? null,
    promptVersion: "relationship_candidate_chunk_v5_speaker_identity",
    schemaVersion: "relationship_provider_compact_candidate_v1",
    normalizationVersion: "relationship_compact_backfill_v2_confidence_labels_evidence_quality_v4",
    maxOutputTokens: process.env.RELATIONSHIP_SIGNAL_CHUNK_MAX_OUTPUT_TOKENS ?? "2800",
    override: override ?? null
  });
}

function validateCandidateOutput(chunk: TranscriptChunk, candidates: RelationshipSignalCandidate[]) {
  const sourceIds = new Set(chunk.segments.map((segment) => segment.id));
  for (const candidate of RelationshipCandidateArraySchema.parse(candidates)) {
    if (
      candidate.uploadId !== chunk.uploadId ||
      candidate.transcriptChunkId !== chunk.id ||
      candidate.chunkIndex !== chunk.index ||
      candidate.item.evidenceSegmentIds.length === 0 ||
      candidate.item.evidenceSegmentIds.some((id) => !sourceIds.has(id))
    ) {
      throw new Error("relationship candidate checkpoint has invalid evidence refs");
    }
  }
}

function relationshipFailureCode(error: unknown) {
  if (error instanceof ChunkAttemptTimeoutError) return "timeout";
  if (error instanceof StructuredJsonResponseError) return error.code;
  if (error instanceof ZodError) return "validation_failure";
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return `http_${error.status}`;
  }
  return "provider_error";
}

function relationshipFailurePhase(error: unknown) {
  if (!error) return "none";
  if (error instanceof ChunkAttemptTimeoutError) return "provider_wait";
  if (error instanceof StructuredJsonResponseError) {
    return error.code === "incomplete_response" ? "provider_response" : "parse";
  }
  if (error instanceof ZodError) return "validation";
  return "provider";
}

function relationshipValidationIssueLogFields(diagnostics: StructuredJsonDiagnostics | undefined) {
  if (
    diagnostics?.parseResult !== "success" ||
    diagnostics.validationResult !== "failed"
  ) {
    return null;
  }

  const codes = (diagnostics.validationIssueSummary ?? [])
    .slice(0, 10)
    .map((issue) => issue.code)
    .join(",") || "none";
  const paths = (diagnostics.validationIssues ?? [])
    .slice(0, 10)
    .map((issue) => issue.path)
    .join(",") || "none";

  return [
    `validation_issue_count=${diagnostics.validationIssueCount ?? 0}`,
    `validation_issue_codes=${codes}`,
    `validation_issue_paths=${paths}`,
    `truncated=${diagnostics.validationIssuesTruncated === true}`
  ].join(" ");
}

function checkpointResponseDiagnostics(diagnostics: StructuredJsonDiagnostics) {
  const safeDiagnostics = { ...diagnostics };
  delete safeDiagnostics.validationIssues;
  delete safeDiagnostics.validationIssueSummary;
  return safeDiagnostics;
}

function checkpointValidationIssueSummary(diagnostics: StructuredJsonDiagnostics | undefined) {
  return diagnostics?.validationIssueSummary?.slice(0, 10).map(({ code, count }) => ({ code, count })) ?? [];
}

function isRetryableRelationshipError(error: unknown) {
  if (error instanceof ZodError) return false;
  if (error instanceof ChunkAttemptTimeoutError) return true;
  if (error instanceof StructuredJsonResponseError) {
    return ["no_json", "empty_response", "incomplete_json", "invalid_json", "incomplete_response"].includes(error.code);
  }
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status === 429 || error.status >= 500;
  }
  const message = error instanceof Error ? error.message : "";
  return /aborted|network|connection|timed?\s*out|temporar(?:y|ily)|rate.?limit|\b5\d\d\b/i.test(message);
}

function retryDelayMs(baseDelayMs: number, retryNumber: number, random: () => number) {
  if (baseDelayMs <= 0) return 0;
  const exponential = baseDelayMs * 2 ** Math.max(0, retryNumber - 1);
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.round(exponential * jitter);
}

function analysisChunk(input: {
  transcriptChunk: TranscriptChunk;
  status: "completed" | "failed";
  retryCount: number;
  candidates: RelationshipSignalCandidate[];
  fallback: boolean;
  error?: unknown;
  now: () => string;
}): AnalysisChunk {
  const finishedAt = input.now();
  return AnalysisChunkSchema.parse({
    id: `${input.transcriptChunk.uploadId}_relationship_analysis_${String(input.transcriptChunk.index).padStart(5, "0")}`,
    uploadId: input.transcriptChunk.uploadId,
    index: input.transcriptChunk.index,
    kind: "relationship_signal",
    startSeconds: input.transcriptChunk.startSeconds,
    endSeconds: input.transcriptChunk.endSeconds,
    timebase: "upload_global",
    transcriptChunkIds: [input.transcriptChunk.id],
    sourceSegmentIds: input.transcriptChunk.segments.map((segment) => segment.id),
    outputIds: input.candidates.map((candidate) => candidate.id),
    status: input.status,
    retryCount: input.retryCount,
    ...(input.status === "failed"
      ? { error: { code: input.error instanceof ChunkAttemptTimeoutError ? "timeout" : "provider_error", message: safeError(input.error), retryable: true } }
      : {}),
    createdAt: input.transcriptChunk.createdAt,
    updatedAt: finishedAt,
    startedAt: input.transcriptChunk.startedAt ?? input.transcriptChunk.createdAt,
    finishedAt,
    metadata: { stage: "relationship_candidate", fallback: input.fallback }
  });
}

async function extractChunkCandidates(input: {
  provider: RelationshipSignalProvider;
  uploadId: string;
  recordingDate: string;
  transcriptChunk: TranscriptChunk;
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
  signal: AbortSignal;
  recoveryMode: RelationshipSignalRecoveryMode;
  evaluationRawResponseCapture?: {
    evaluationRetention: boolean;
    chunkIndex: number;
    attempt: number;
  };
  onDiagnostics?: (diagnostics: StructuredJsonDiagnostics) => void;
  onRequestMetrics?: (metrics: RelationshipSignalRequestMetrics) => void;
  onCandidateAudit?: (audit: RelationshipSignalCandidateAudit) => void;
}) {
  if (input.provider.extractCandidates) {
    const rawItems = await input.provider.extractCandidates({
      uploadId: input.uploadId,
      recordingDate: input.recordingDate,
      segments: input.transcriptChunk.segments,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights,
      signal: input.signal,
      recoveryMode: input.recoveryMode,
      ...(input.evaluationRawResponseCapture ? {
        evaluationRawResponseCapture: input.evaluationRawResponseCapture
      } : {}),
      ...(input.onDiagnostics ? { onDiagnostics: input.onDiagnostics } : {}),
      ...(input.onRequestMetrics ? { onRequestMetrics: input.onRequestMetrics } : {}),
      ...(input.onCandidateAudit ? { onCandidateAudit: input.onCandidateAudit } : {})
    });
    return createRelationshipSignalCandidates({
      uploadId: input.uploadId,
      transcriptChunk: input.transcriptChunk,
      rawItems,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights
    });
  }

  const cards = await input.provider.analyze({
    uploadId: input.uploadId,
    recordingDate: input.recordingDate,
    segments: input.transcriptChunk.segments,
    semanticSegments: input.semanticSegments,
    audioInsights: input.audioInsights,
    signal: input.signal,
    recoveryMode: input.recoveryMode,
    ...(input.evaluationRawResponseCapture ? {
      evaluationRawResponseCapture: input.evaluationRawResponseCapture
    } : {}),
    ...(input.onDiagnostics ? { onDiagnostics: input.onDiagnostics } : {}),
    ...(input.onRequestMetrics ? { onRequestMetrics: input.onRequestMetrics } : {}),
    ...(input.onCandidateAudit ? { onCandidateAudit: input.onCandidateAudit } : {})
  });
  return relationshipCardsToCandidates({
    uploadId: input.uploadId,
    transcriptChunk: input.transcriptChunk,
    cards,
    semanticSegments: input.semanticSegments,
    audioInsights: input.audioInsights
  });
}

export type RelationshipSignalChunkProcessingInput = {
  uploadId: string;
  recordingDate: string;
  transcriptChunks: TranscriptChunk[];
  segments: TranscriptSegment[];
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
  provider: RelationshipSignalProvider;
  options?: RelationshipSignalChunkProcessingOptions;
};

async function processRelationshipSignalChunksOwned(input: RelationshipSignalChunkProcessingInput) {
  const startedAt = Date.now();
  const options = config(input.options);
  const now = input.options?.now ?? (() => new Date().toISOString());
  const chunks = [...input.transcriptChunks].sort((left, right) => left.index - right.index);
  const checkpointOptions = input.options?.analysisCheckpoint;
  const processorFingerprint = relationshipProcessorFingerprint(checkpointOptions?.processorFingerprint);
  const baseContexts = chunks.map((transcriptChunk) => {
    const semanticSegments = relatedSemanticSegments(transcriptChunk, input.semanticSegments);
    const audioInsights = relatedAudioInsights(transcriptChunk, input.audioInsights);
    return {
      transcriptChunk,
      semanticSegments,
      audioInsights,
      startedAt: 0,
      spentMs: 0,
      inputCharacters: relationshipInputCharacterCount({ transcriptChunk, semanticSegments, audioInsights }),
      shouldProcess: hasRelationshipSignalContext({
        segments: transcriptChunk.segments,
        semanticSegments,
        audioInsights
      })
    };
  });
  const contexts = await Promise.all(baseContexts.map(async (context) => {
    if (!checkpointOptions) return { ...context, checkpointInput: undefined, checkpointLookup: undefined };
    const checkpointInput = {
      store: checkpointOptions.store,
      userId: checkpointOptions.userId,
      uploadId: input.uploadId,
      kind: "relationship_candidate" as const,
      sourceChunkId: context.transcriptChunk.id,
      sourceChunkIndex: context.transcriptChunk.index,
      inputFingerprint: relationshipInputFingerprint({
        uploadId: input.uploadId,
        recordingDate: input.recordingDate,
        transcriptChunk: context.transcriptChunk,
        audioInsights: context.audioInsights,
        shouldProcess: context.shouldProcess
      }),
      processorFingerprint,
      outputSchema: RelationshipCandidateArraySchema,
      validateOutput: (candidates: RelationshipSignalCandidate[]) => validateCandidateOutput(context.transcriptChunk, candidates),
      staleAfterMs: checkpointOptions.staleAfterMs ?? options.totalBudgetMs + 60_000,
      now
    };
    return {
      ...context,
      checkpointInput,
      checkpointLookup: await lookupAnalysisCheckpoint<RelationshipSignalCandidate[]>(checkpointInput)
    };
  }));
  type Context = (typeof contexts)[number];
  type CandidateResult = Awaited<ReturnType<typeof extractChunkCandidates>>;
  type AttemptRecord = {
    context: Context;
    attempt: number;
    recoveryMode: RelationshipSignalRecoveryMode;
    durationMs: number;
    value?: CandidateResult;
    error?: unknown;
    diagnostics?: StructuredJsonDiagnostics;
    requestMetrics?: RelationshipSignalRequestMetrics;
    candidateAudit?: RelationshipSignalCandidateAudit;
    checkpointHit?: boolean;
    checkpointResultSource?: "provider_success" | "provider_retry_success" | "rule_fallback" | "deterministic_skip";
  };
  const attemptHistory = new Map<number, AttemptRecord[]>();

  const recordAttempt = (record: AttemptRecord) => {
    const history = attemptHistory.get(record.context.transcriptChunk.index) ?? [];
    history.push(record);
    attemptHistory.set(record.context.transcriptChunk.index, history);
    return record;
  };

  const runAttempt = async (
    context: Context,
    attempt: number,
    concurrency: number,
    recoveryMode: RelationshipSignalRecoveryMode
  ): Promise<AttemptRecord> => {
    const attemptStartedAt = Date.now();
    if (context.startedAt === 0) context.startedAt = attemptStartedAt;
    const remainingBudgetMs = options.totalBudgetMs - context.spentMs;
    if (remainingBudgetMs <= 0) {
      return recordAttempt({
        context,
        attempt,
        recoveryMode,
        durationMs: 0,
        error: new ChunkAttemptTimeoutError(options.totalBudgetMs)
      });
    }
    const attemptTimeoutMs = Math.min(options.attemptTimeoutMs, remainingBudgetMs);
    let diagnostics: StructuredJsonDiagnostics | undefined;
    let requestMetrics: RelationshipSignalRequestMetrics | undefined;
    let candidateAudit: RelationshipSignalCandidateAudit | undefined;
    try {
      const result = await runChunkAttempt({
        execute: async (signal) => {
          try {
            return await extractChunkCandidates({
              provider: input.provider,
              uploadId: input.uploadId,
              recordingDate: input.recordingDate,
              transcriptChunk: context.transcriptChunk,
              semanticSegments: context.semanticSegments,
              audioInsights: context.audioInsights,
              signal,
              recoveryMode,
              ...(input.options?.evaluationRawResponseCapture ? {
                evaluationRawResponseCapture: {
                  evaluationRetention: true,
                  chunkIndex: context.transcriptChunk.index,
                  attempt
                }
              } : {}),
              onDiagnostics: (value) => { diagnostics = value; },
              onCandidateAudit: (value) => { candidateAudit = value; },
              onRequestMetrics: (value) => {
                requestMetrics = value;
                const removedReasons = Object.entries(value.removedReasonCounts ?? {})
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([reason, count]) => `${reason}:${count}`)
                  .join(",") || "none";
                console.info(
                  `[relationship_context_selection] upload_id=${input.uploadId} chunk_index=${context.transcriptChunk.index} attempt=${attempt} insights_before=${value.insightsBefore ?? context.audioInsights.length} insights_after=${value.insightsAfter ?? context.audioInsights.length} insight_chars_before=${value.insightCharsBefore ?? value.insightCharacterCount} insight_chars_after=${value.insightCharsAfter ?? value.insightCharacterCount} removed_reason_counts=${removedReasons}`
                );
                console.info(
                  `[relationship-provider] request_start upload_id=${input.uploadId} chunk_index=${context.transcriptChunk.index} attempt=${attempt} concurrency=${concurrency} recovery_mode=${value.recoveryMode} candidate_limit=${value.candidateLimit} started_at=${new Date(attemptStartedAt).toISOString()} segment_count=${context.transcriptChunk.segments.length} insight_count=${context.audioInsights.length} semantic_count=${value.semanticSegmentCount} input_chars_before=${context.inputCharacters} context_chars_before=${value.unoptimizedContextCharacterCount} context_chars_after=${value.optimizedContextCharacterCount} prompt_chars=${value.promptCharacterCount} transcript_chars=${value.transcriptCharacterCount} insight_chars=${value.insightCharacterCount} semantic_chars=${value.semanticCharacterCount} max_output_tokens=${value.maxOutputTokens} output_tokens_budget=${value.maxOutputTokens} response_mode=${value.responseMode}`
                );
              }
            });
          } catch (error) {
            if (signal.aborted) throw new ChunkAttemptTimeoutError(attemptTimeoutMs);
            throw error;
          }
        },
        attemptTimeoutMs,
        maxRetries: 0
      });
      const providerStatus = result.value.candidates.length > 0 ? "provider_success" : "empty_safe_result";
      const durationMs = Date.now() - attemptStartedAt;
      console.info(
        `[relationship-signals] upload_id=${input.uploadId} chunk_index=${context.transcriptChunk.index} segment_count=${context.transcriptChunk.segments.length} insight_count=${context.audioInsights.length} semantic_count=${requestMetrics?.semanticSegmentCount ?? -1} input_chars=${context.inputCharacters} prompt_chars=${requestMetrics?.promptCharacterCount ?? -1} output_token_limit=${requestMetrics?.maxOutputTokens ?? -1} output_tokens_budget=${requestMetrics?.maxOutputTokens ?? -1} compact_candidate_count=${candidateAudit?.compactCandidateCount ?? result.value.candidates.length} recovery_mode=${recoveryMode} attempt=${attempt} concurrency=${concurrency} attempt_timeout_ms=${attemptTimeoutMs} elapsed_ms=${durationMs} first_response_ms=-1 response_complete_ms=${diagnostics?.responseCompleteDurationMs ?? -1} parse_ms=${diagnostics?.parseDurationMs ?? -1} validation_ms=${diagnostics?.validationDurationMs ?? -1} total_ms=${diagnostics?.totalDurationMs ?? -1} provider_status=${providerStatus} failure_phase=none response_text_length=${diagnostics?.responseTextLength ?? -1} response_status=${diagnostics?.responseStatus ?? "unknown"} incomplete_reason=${diagnostics?.incompleteReason ?? "none"} finish_reason=unavailable parse_result=${diagnostics?.parseResult ?? "unknown"} validation_result=${diagnostics?.validationResult ?? "unknown"} retry_reason=none fallback_reason=none`
      );
      context.spentMs += durationMs;
      return recordAttempt({
        context,
        attempt,
        recoveryMode,
        durationMs,
        value: result.value,
        diagnostics,
        requestMetrics,
        candidateAudit
      });
    } catch (error) {
      const code = relationshipFailureCode(error);
      const willRetry = attempt === 1 && options.maxRetries > 0 && isRetryableRelationshipError(error);
      const validationIssueFields = relationshipValidationIssueLogFields(diagnostics);
      if (validationIssueFields) {
        console.info(
          `[relationship-provider] validation_failed upload_id=${input.uploadId} chunk_index=${context.transcriptChunk.index} attempt=${attempt} parse_result=success validation_result=failed ${validationIssueFields}`
        );
      }
      console.info(
        `[relationship-signals] upload_id=${input.uploadId} chunk_index=${context.transcriptChunk.index} segment_count=${context.transcriptChunk.segments.length} insight_count=${context.audioInsights.length} semantic_count=${requestMetrics?.semanticSegmentCount ?? -1} input_chars=${context.inputCharacters} prompt_chars=${requestMetrics?.promptCharacterCount ?? -1} output_token_limit=${requestMetrics?.maxOutputTokens ?? -1} output_tokens_budget=${requestMetrics?.maxOutputTokens ?? -1} compact_candidate_count=${candidateAudit?.compactCandidateCount ?? 0} recovery_mode=${recoveryMode} attempt=${attempt} concurrency=${concurrency} attempt_timeout_ms=${attemptTimeoutMs} elapsed_ms=${Date.now() - attemptStartedAt} first_response_ms=-1 response_complete_ms=${diagnostics?.responseCompleteDurationMs ?? -1} parse_ms=${diagnostics?.parseDurationMs ?? -1} validation_ms=${diagnostics?.validationDurationMs ?? -1} total_ms=${diagnostics?.totalDurationMs ?? -1} provider_status=failed failure_phase=${relationshipFailurePhase(error)} response_text_length=${diagnostics?.responseTextLength ?? -1} response_status=${diagnostics?.responseStatus ?? "unknown"} incomplete_reason=${diagnostics?.incompleteReason ?? "none"} finish_reason=unavailable parse_result=${diagnostics?.parseResult ?? "unknown"} validation_result=${diagnostics?.validationResult ?? "unknown"} failure_reason=${code} will_retry=${willRetry} retry_reason=${willRetry ? code : "none"} fallback_reason=none`
      );
      const durationMs = Date.now() - attemptStartedAt;
      context.spentMs += durationMs;
      return recordAttempt({
        context,
        attempt,
        recoveryMode,
        durationMs,
        error,
        diagnostics,
        requestMetrics,
        candidateAudit
      });
    }
  };

  const firstPassStartedAt = Date.now();
  const initial = await mapWithConcurrency({
    items: contexts,
    options: { concurrency: options.concurrency },
    worker: async (context): Promise<AttemptRecord> => {
      if (context.checkpointLookup?.cacheStatus === "hit" && context.checkpointLookup.output) {
        context.startedAt = Date.now();
        const validationRejections = checkpointValidationRejections(
          context.checkpointLookup.checkpoint?.metadata.validationRejections
        );
        return recordAttempt({
          context,
          attempt: 0,
          recoveryMode: "standard",
          durationMs: 0,
          value: {
            candidates: context.checkpointLookup.output,
            rejectedCount: validationRejections.length,
            rejectionReasons: validationRejectionReasons(validationRejections),
            validationRejections
          },
          checkpointHit: true,
          checkpointResultSource: context.checkpointLookup.checkpoint?.resultSource
        });
      }
      if (!context.shouldProcess) {
        context.startedAt = Date.now();
        console.info(
          `[relationship-signals] upload_id=${input.uploadId} chunk_index=${context.transcriptChunk.index} segment_count=${context.transcriptChunk.segments.length} insight_count=${context.audioInsights.length} input_chars=${context.inputCharacters} attempt=0 concurrency=${options.concurrency} attempt_timeout_ms=${options.attemptTimeoutMs} elapsed_ms=0 provider_status=skipped response_text_length=0 finish_reason=none parse_result=not_started validation_result=not_started retry_reason=none fallback_reason=non_relationship_context`
        );
        return recordAttempt({
          context,
          attempt: 0,
          recoveryMode: "standard",
          durationMs: 0,
          value: { candidates: [], rejectedCount: 0, rejectionReasons: {}, validationRejections: [] }
        });
      }
      return runAttempt(context, 1, options.concurrency, "standard");
    }
  });
  const firstPassWallMs = Date.now() - firstPassStartedAt;

  const retryable = initial.filter(
    (record) => record.error && options.maxRetries > 0 && isRetryableRelationshipError(record.error)
  );
  const recoveryStartedAt = Date.now();
  const recovered = await mapWithConcurrency({
    items: retryable,
    options: { concurrency: options.recoveryConcurrency },
    worker: async (record) => {
      const delay = retryDelayMs(options.retryDelayMs, 1, options.random);
      if (delay > 0) {
        await options.sleep(delay);
        record.context.spentMs += delay;
      }
      const recoveryMode: RelationshipSignalRecoveryMode =
        relationshipFailureCode(record.error) === "incomplete_response"
          && record.diagnostics?.incompleteReason === "max_output_tokens"
          ? "compact"
          : "standard";
      return runAttempt(record.context, 2, options.recoveryConcurrency, recoveryMode);
    }
  });
  const recoveryWallMs = retryable.length > 0 ? Date.now() - recoveryStartedAt : 0;
  const recoveredByIndex = new Map(
    recovered.map((record) => [record.context.transcriptChunk.index, record])
  );
  const finalAttempts = initial.map(
    (record) => recoveredByIndex.get(record.context.transcriptChunk.index) ?? record
  );

  const outputs = finalAttempts.map((record) => {
    const { context } = record;
    const retryCount = Math.max(0, record.attempt - 1);
    if (record.value) {
      const checkpointFallback = Boolean(record.checkpointHit && record.checkpointResultSource === "rule_fallback");
      const checkpointSkipped = Boolean(record.checkpointHit && record.checkpointResultSource === "deterministic_skip");
      const providerStatus = record.checkpointHit
        ? "checkpoint_hit"
        : record.attempt > 1
        ? "provider_retry_success"
        : context.shouldProcess
          ? record.value.candidates.length > 0 ? "provider_success" : "empty_safe_result"
          : "skipped";
      console.info(
        `[relationship-signals] chunk completed index=${context.transcriptChunk.index} status=${checkpointSkipped || !context.shouldProcess ? "skipped" : "completed"} provider_status=${providerStatus} checkpoint_result_source=${record.checkpointResultSource ?? "none"} retry_count=${retryCount} fallback=${checkpointFallback} candidates=${record.value.candidates.length} types=${formatCandidateTypes(record.value.candidates)} rejected=${record.value.rejectedCount} reasons=${formatRejectionReasons(record.value.rejectionReasons)} elapsed_ms=${Date.now() - context.startedAt}`
      );
      return {
        transcriptChunk: context.transcriptChunk,
        candidates: record.value.candidates,
        rejectedCount: record.value.rejectedCount,
        rejectionReasons: record.value.rejectionReasons,
        validationRejections: record.value.validationRejections,
        retryCount,
        providerStatus,
        fallback: checkpointFallback,
        skipped: checkpointSkipped || !context.shouldProcess,
        failed: false,
        error: undefined as unknown
        ,checkpointHit: record.checkpointHit ?? false
      };
    }

    try {
      const fallbackCards = buildConservativeRelationshipSignalFallbackCards({
        uploadId: input.uploadId,
        recordingDate: input.recordingDate,
        segments: context.transcriptChunk.segments,
        semanticSegments: context.semanticSegments,
        audioInsights: context.audioInsights,
        createdAt: now()
      });
      const fallback = relationshipCardsToCandidates({
        uploadId: input.uploadId,
        transcriptChunk: context.transcriptChunk,
        cards: fallbackCards,
        semanticSegments: context.semanticSegments,
        audioInsights: context.audioInsights
      });
      console.info(
        `[relationship-signals] chunk completed index=${context.transcriptChunk.index} status=completed provider_status=rule_fallback retry_count=${retryCount} fallback=true fallback_reason=${relationshipFailureCode(record.error)} candidates=${fallback.candidates.length} types=${formatCandidateTypes(fallback.candidates)} rejected=${fallback.rejectedCount} reasons=${formatRejectionReasons(fallback.rejectionReasons)} elapsed_ms=${Date.now() - context.startedAt}`
      );
      return {
        transcriptChunk: context.transcriptChunk,
        candidates: fallback.candidates,
        rejectedCount: fallback.rejectedCount,
        rejectionReasons: fallback.rejectionReasons,
        validationRejections: fallback.validationRejections,
        retryCount,
        providerStatus: "rule_fallback",
        fallback: true,
        skipped: false,
        failed: false,
        error: record.error
        ,checkpointHit: false
      };
    } catch (fallbackError) {
      console.info(
        `[relationship-signals] chunk completed index=${context.transcriptChunk.index} status=failed provider_status=rule_fallback retry_count=${retryCount} fallback=true fallback_reason=${relationshipFailureCode(record.error)} candidates=0 rejected=0 reasons=none error_name=${fallbackError instanceof Error ? fallbackError.name : "unknown"} elapsed_ms=${Date.now() - context.startedAt}`
      );
      return {
        transcriptChunk: context.transcriptChunk,
        candidates: [],
        rejectedCount: 0,
        rejectionReasons: {},
        validationRejections: [],
        retryCount,
        providerStatus: "rule_fallback",
        fallback: true,
        skipped: false,
        failed: true,
        error: fallbackError
        ,checkpointHit: false
      };
    }
  });
  if (checkpointOptions) {
    await Promise.all(outputs.filter((output) => !output.checkpointHit).map(async (output) => {
      const context = contexts.find((item) => item.transcriptChunk.index === output.transcriptChunk.index)!;
      if (!context.checkpointInput) return;
      const providerAttempt = attemptHistory.get(output.transcriptChunk.index)?.at(-1);
      try {
        await executeWithAnalysisCheckpoint<RelationshipSignalCandidate[]>({
          ...context.checkpointInput,
          metadata: {
            segmentCount: context.transcriptChunk.segments.length,
            insightCount: context.audioInsights.length,
            inputCharacterCount: context.inputCharacters,
            providerRetryCount: output.retryCount,
            validationRejections: output.validationRejections,
            ...(providerAttempt ? { recoveryMode: providerAttempt.recoveryMode } : {}),
            ...(providerAttempt?.requestMetrics ? {
              requestMetrics: providerAttempt.requestMetrics
            } : {}),
            ...(providerAttempt?.candidateAudit ? {
              candidateContractAudit: providerAttempt.candidateAudit
            } : {}),
            ...(providerAttempt?.diagnostics ? {
              responseDiagnostics: checkpointResponseDiagnostics(providerAttempt.diagnostics)
            } : {}),
            ...(checkpointValidationIssueSummary(providerAttempt?.diagnostics).length > 0 ? {
              validationIssueSummary: checkpointValidationIssueSummary(providerAttempt?.diagnostics)
            } : {}),
            ...(providerAttempt?.error ? {
              failureCode: relationshipFailureCode(providerAttempt.error),
              failurePhase: relationshipFailurePhase(providerAttempt.error)
            } : {})
          },
          execute: async () => {
            if (output.failed) throw output.error;
            return {
              output: output.candidates,
              resultSource: output.skipped
                ? "deterministic_skip" as const
                : output.fallback
                  ? "rule_fallback" as const
                  : output.providerStatus === "provider_retry_success"
                    ? "provider_retry_success" as const
                    : "provider_success" as const
            };
          }
        });
      } catch {
        // The chunk result already follows the stage's existing failure isolation.
      }
    }));
  }
  const parallelDurationMs = Date.now() - startedAt;
  const reducerStartedAt = Date.now();
  const candidates = outputs.flatMap((output) => output.candidates);
  const validationRejections = outputs.flatMap((output) => output.validationRejections);
  const reduced = reduceRelationshipSignalCandidates({
    uploadId: input.uploadId,
    recordingDate: input.recordingDate,
    candidates,
    segments: input.segments,
    semanticSegments: input.semanticSegments,
    audioInsights: input.audioInsights,
    validationRejections,
    createdAt: now()
  });
  const reducerDurationMs = Date.now() - reducerStartedAt;
  const candidateValidationRejected = outputs.reduce((total, output) => total + output.rejectedCount, 0);
  const analysisChunks = outputs.map((output) => analysisChunk({
    transcriptChunk: output.transcriptChunk,
    status: output.failed ? "failed" : "completed",
    retryCount: output.retryCount,
    candidates: output.candidates,
    fallback: output.fallback,
    error: output.error,
    now
  }));
  const sumProviderMs = [...attemptHistory.values()]
    .flat()
    .filter((attempt) => attempt.attempt > 0)
    .reduce((total, attempt) => total + attempt.durationMs, 0);
  const criticalPathMs = firstPassWallMs + recoveryWallMs;
  const chunkAudits = outputs.map((output) => {
    const context = contexts.find((item) => item.transcriptChunk.index === output.transcriptChunk.index)!;
    const history = attemptHistory.get(output.transcriptChunk.index) ?? [];
    const firstAttempt = history.find((attempt) => attempt.attempt === 1);
    const retryAttempt = history.find((attempt) => attempt.attempt === 2);
    const finalAttempt = history.at(-1);
    const requestMetrics = finalAttempt?.requestMetrics ?? firstAttempt?.requestMetrics;
    return {
      chunkIndex: output.transcriptChunk.index,
      segmentCount: output.transcriptChunk.segments.length,
      transcriptChars: requestMetrics?.transcriptCharacterCount ?? null,
      insightsBefore: requestMetrics?.insightsBefore ?? context.audioInsights.length,
      insightsAfter: requestMetrics?.insightsAfter ?? null,
      insightCharsBefore: requestMetrics?.insightCharsBefore ?? null,
      insightCharsAfter: requestMetrics?.insightCharsAfter ?? requestMetrics?.insightCharacterCount ?? null,
      contextCharsBefore: requestMetrics?.unoptimizedContextCharacterCount ?? null,
      contextCharsAfter: requestMetrics?.optimizedContextCharacterCount ?? null,
      promptChars: requestMetrics?.promptCharacterCount ?? null,
      outputTokensBudget: requestMetrics?.maxOutputTokens ?? null,
      firstAttemptDurationMs: firstAttempt?.durationMs ?? null,
      retryDurationMs: retryAttempt?.durationMs ?? null,
      responseTextChars: finalAttempt?.diagnostics?.responseTextLength ?? null,
      responseStatus: finalAttempt?.diagnostics?.responseStatus ?? null,
      failurePhase: finalAttempt?.error ? relationshipFailurePhase(finalAttempt.error) : "none",
      candidateCount: output.candidates.length,
      finalResultSource: output.providerStatus,
      attempts: history.map((attempt) => ({
        attempt: attempt.attempt,
        recoveryMode: attempt.recoveryMode,
        durationMs: attempt.durationMs,
        status: attempt.error ? "failed" as const : "completed" as const,
        failureCode: attempt.error ? relationshipFailureCode(attempt.error) : null,
        failurePhase: attempt.error ? relationshipFailurePhase(attempt.error) : "none",
        responseTextChars: attempt.diagnostics?.responseTextLength ?? null,
        responseStatus: attempt.diagnostics?.responseStatus ?? null,
        incompleteReason: attempt.diagnostics?.incompleteReason ?? null,
        rawCandidateCount: attempt.candidateAudit?.rawCandidateCount ?? attempt.value?.candidates.length ?? 0,
        validCandidateCount: attempt.value?.candidates.length ?? 0,
        compactCandidateCount: attempt.candidateAudit?.compactCandidateCount ?? attempt.value?.candidates.length ?? 0,
        requestMetrics: attempt.requestMetrics ?? null
      }))
    };
  });
  const stats = {
    chunkCount: chunks.length,
    completedChunks: outputs.filter((output) => !output.failed).length,
    failedChunks: outputs.filter((output) => output.failed).length,
    fallbackChunks: outputs.filter((output) => output.fallback && !output.failed).length,
    successChunks: outputs.filter((output) => !output.fallback && !output.skipped && !output.failed).length,
    retrySuccessChunks: outputs.filter((output) => output.providerStatus === "provider_retry_success").length,
    skippedChunks: outputs.filter((output) => output.skipped).length,
    timeoutChunks: [...attemptHistory.values()].filter((history) => history.some((record) => relationshipFailureCode(record.error) === "timeout")).length,
    invalidJsonChunks: [...attemptHistory.values()].filter((history) => history.some((record) => ["no_json", "empty_response", "incomplete_json", "invalid_json", "incomplete_response"].includes(relationshipFailureCode(record.error)))).length,
    parseFailureChunks: [...attemptHistory.values()].filter((history) => history.some((record) => relationshipFailurePhase(record.error) === "parse")).length,
    validationFailureChunks: [...attemptHistory.values()].filter((history) => history.some((record) => relationshipFailurePhase(record.error) === "validation")).length,
    providerFailureChunks: [...attemptHistory.values()].filter((history) => history.some((record) => ["provider", "provider_wait", "provider_response"].includes(relationshipFailurePhase(record.error)))).length,
    candidateCount: candidates.length,
    candidateValidationRejected,
    qualityRejectedCandidates: reduced.audit.qualityRejectedCount,
    rejectedCandidates: candidateValidationRejected + reduced.audit.qualityRejectedCount,
    clusterCount: reduced.audit.clusterCount,
    mergedCandidateCount: reduced.mergedCandidateCount,
    clusterRejected: reduced.audit.clusterRejectedCount,
    normalizationRejected: reduced.audit.normalizationRejectedCount,
    selectionRejected: reduced.audit.clusterRejectedCount + reduced.audit.normalizationRejectedCount,
    cardCount: reduced.cards.length,
    firstPassWallMs,
    recoveryWallMs,
    sumProviderMs,
    criticalPathMs,
    parallelDurationMs,
    reducerDurationMs,
    checkpointHits: outputs.filter((output) => output.checkpointHit).length,
    checkpointMisses: outputs.filter((output) => !output.checkpointHit).length
  };
  console.info(
    `[relationship-signals] chunks=${stats.chunkCount} success_chunks=${stats.successChunks} retry_success_chunks=${stats.retrySuccessChunks} fallback_chunks=${stats.fallbackChunks} skipped_chunks=${stats.skippedChunks} failed_chunks=${stats.failedChunks} timeout_chunks=${stats.timeoutChunks} invalid_json_chunks=${stats.invalidJsonChunks} parse_failure_chunks=${stats.parseFailureChunks} validation_failure_chunks=${stats.validationFailureChunks} provider_failure_chunks=${stats.providerFailureChunks} checkpoint_hits=${stats.checkpointHits} checkpoint_misses=${stats.checkpointMisses} candidates=${stats.candidateCount} validation_rejected=${stats.candidateValidationRejected} quality_rejected=${stats.qualityRejectedCandidates} rejected=${stats.rejectedCandidates} clusters=${stats.clusterCount} merged_candidates=${stats.mergedCandidateCount} cluster_rejected=${stats.clusterRejected} normalization_rejected=${stats.normalizationRejected} selection_rejected=${stats.selectionRejected} cards=${stats.cardCount} first_pass_wall_ms=${firstPassWallMs} recovery_wall_ms=${recoveryWallMs} critical_path_ms=${criticalPathMs} sum_provider_ms=${sumProviderMs} wall_clock_ms=${parallelDurationMs} reducer_elapsed_ms=${reducerDurationMs}`
  );
  return {
    cards: reduced.cards,
    candidates,
    candidateIdsByCardId: reduced.candidateIdsByCardId,
    analysisChunks,
    stats,
    reducerAudit: reduced.audit,
    chunkAudits
  };
}

const relationshipStageFlights = new Map<
  string,
  ReturnType<typeof processRelationshipSignalChunksOwned>
>();

function relationshipStageFlightKey(input: RelationshipSignalChunkProcessingInput) {
  const checkpoint = input.options?.analysisCheckpoint;
  if (!checkpoint) return null;
  return fingerprintAnalysisInput({
    userId: checkpoint.userId,
    uploadId: input.uploadId,
    recordingDate: input.recordingDate,
    processorFingerprint: relationshipProcessorFingerprint(checkpoint.processorFingerprint),
    transcriptChunks: input.transcriptChunks.map((chunk) => ({
      id: chunk.id,
      index: chunk.index,
      segments: chunk.segments.map((segment) => ({
        id: segment.id,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        speaker: segment.speaker ?? null,
        identity: transcriptSpeakerIdentityFingerprint(segment),
        text: segment.text,
        sceneLabels: segment.sceneLabels,
        valueLabels: segment.valueLabels
      }))
    })),
    semanticSegments: input.semanticSegments.map((segment) => ({
      id: segment.id,
      sourceSegmentIds: segment.sourceSegmentIds,
      title: segment.title,
      summary: segment.summary
    })),
    audioInsights: input.audioInsights.map((insight) => ({
      id: insight.id,
      sourceSegmentIds: insight.sourceSegmentIds,
      summary: insight.summary,
      confidence: insight.confidence,
      toneLabels: insight.toneLabels,
      emotionLabels: insight.emotionLabels,
      interactionLabels: insight.interactionLabels
    }))
  });
}

export function processRelationshipSignalChunks(input: RelationshipSignalChunkProcessingInput) {
  const flightKey = relationshipStageFlightKey(input);
  if (!flightKey) return processRelationshipSignalChunksOwned(input);
  const existing = relationshipStageFlights.get(flightKey);
  if (existing) return existing;
  const execution = processRelationshipSignalChunksOwned(input);
  relationshipStageFlights.set(flightKey, execution);
  const release = () => {
    if (relationshipStageFlights.get(flightKey) === execution) {
      relationshipStageFlights.delete(flightKey);
    }
  };
  void execution.then(release, release);
  return execution;
}

function formatRejectionReasons(reasons: Record<string, number>) {
  const entries = Object.entries(reasons).filter(([, count]) => count > 0);
  return entries.length > 0 ? entries.map(([reason, count]) => `${reason}:${count}`).join(",") : "none";
}

function formatCandidateTypes(candidates: RelationshipSignalCandidate[]) {
  const types = [...new Set(candidates.map((candidate) => candidate.item.signalType))].sort();
  return types.length > 0 ? types.join(",") : "none";
}
