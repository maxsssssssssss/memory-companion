import { z, ZodError } from "zod";

import {
  BriefCategorySchema,
  BriefItemSchema,
  PrioritySchema,
  type BriefItem,
  type TranscriptSegment
} from "@/lib/domain/types";
import { fingerprintAnalysisInput } from "@/lib/server/analysis-chunks/checkpoint";
import { createOpenAIClient } from "@/lib/server/openai/client";
import {
  parseStructuredJsonResponse,
  type StructuredJsonDiagnostics,
  type StructuredJsonValidationFailureRawResponse,
  type StructuredJsonResponseMode
} from "@/lib/server/openai/structured-json";
import { captureProviderValidationFailure } from "@/lib/server/evaluation/provider-response-capture";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import {
  processDailyBriefChunks,
  resolveDailyBriefChunkConcurrency,
  resolveDailyBriefMaxRetries,
  resolveDailyBriefRecoveryConcurrency,
  resolveDailyBriefRetryDelayMs,
  type DailyBriefChunkAttemptContext,
  type DailyBriefRecoveryMode
} from "./chunk-processing";
import { formatExtractionSegments, type ExtractionChunk } from "./chunks";
import {
  buildDailyBriefValidationCheckpointSummary,
  buildDailyBriefValidationLogFields,
  classifyDailyBriefFailure,
  DailyBriefEvidenceValidationError,
  type DailyBriefFailureClassification,
  type DailyBriefValidationCheckpointSummary,
  wrapDailyBriefProviderFailure
} from "./failure-diagnostics";
import type { ExtractionOptions, ExtractionProvider } from "./provider";
import { ruleExtractionProvider } from "./rule-provider";

const DEFAULT_CHUNK_TIMEOUT_MS = 45_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 3_000;
const SDK_MAX_RETRIES = 0;
const PROMPT_VERSION = "founder_daily_brief_chunk_v2_explicit_recovery";
const PROVIDER_SCHEMA_VERSION = "extracted_brief_v1";
const NORMALIZATION_VERSION = "daily_brief_strict_evidence_v2";
const RETRY_CONTRACT_VERSION = "daily_brief_recovery_v1";

const SYSTEM_PROMPT =
  "你是创始人每日复盘助手。只抽取有证据的承诺、待办、决策、想法、风险、未决问题和重要原话。每块最多输出 6 条最有价值的项目，每个项目必须引用 sourceSegmentIds。";
const JSON_INSTRUCTION =
  "输出 founder_daily_brief JSON：items 为数组且最多 6 项；每项包含 category、title、body、priority、confidence、sourceSegmentIds、transcriptExcerpt、people、topics。" +
  "category 只能是 commitment、task、decision、idea、risk、open_question、notable_quote；priority 只能是 high、medium、low。" +
  "没有足够证据时输出 {\"items\":[]}。";
const COMPACT_RECOVERY_INSTRUCTION =
  "这是截断响应的恢复请求。只返回当前片段最重要且互不重复的最多 4 项；title 与 body 保持简短，不要解释 JSON。";

const ExtractedBriefSchema = z.object({
  items: z.array(
    z.object({
      category: BriefCategorySchema,
      title: z.string(),
      body: z.string(),
      priority: PrioritySchema,
      confidence: z.number().min(0).max(1),
      sourceSegmentIds: z.array(z.string().min(1)),
      transcriptExcerpt: z.string(),
      people: z.array(z.string()),
      topics: z.array(z.string())
    })
  ).max(6)
});

type ExtractedBriefItems = z.infer<typeof ExtractedBriefSchema>["items"];

type SafeResponseDiagnostics = {
  responseStatus: "complete" | "incomplete" | "failed" | "unavailable";
  responseTextLength: number;
  finishReason: "not_available";
  incompleteReason: "max_output_tokens" | "content_filter" | "other" | "none";
  parseResult: StructuredJsonDiagnostics["parseResult"];
  validationResult: StructuredJsonDiagnostics["validationResult"];
  evidenceValidationResult: "not_started" | "success" | "failed";
};

type DailyBriefAttemptAudit = {
  attempt: number;
  recoveryMode: DailyBriefRecoveryMode;
  concurrency: number;
  segmentCount: number;
  inputChars: number;
  promptChars: number;
  outputTokenLimit: number;
  attemptTimeoutMs: number;
  requestStartedAt: string;
  elapsedMs: number;
  providerStatus: "success" | "failed";
  responseDiagnostics: SafeResponseDiagnostics;
  failurePhase?: DailyBriefFailureClassification["failurePhase"];
  failureReason?: DailyBriefFailureClassification["failureCode"];
  retryable?: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  retryAfterCapped?: boolean;
  validationIssueSummary?: DailyBriefValidationCheckpointSummary["validationIssueSummary"];
  validationIssueCount?: number;
  validationIssuesTruncated?: boolean;
};

class ExtractionDeadlineError extends Error {
  readonly code = "DAILY_BRIEF_DEADLINE";

  constructor() {
    super("Daily Brief extraction deadline exceeded");
    this.name = "ExtractionDeadlineError";
  }
}

function readBoundedInteger(input: {
  name: string;
  raw: string | undefined;
  fallback: number;
  min: number;
  max: number;
}) {
  if (input.raw === undefined || input.raw.trim() === "") return input.fallback;
  if (!/^\d+$/u.test(input.raw.trim())) {
    throw new Error(`${input.name} must be an integer between ${input.min} and ${input.max}`);
  }
  const value = Number(input.raw.trim());
  if (!Number.isSafeInteger(value) || value < input.min || value > input.max) {
    throw new Error(`${input.name} must be an integer between ${input.min} and ${input.max}`);
  }
  return value;
}

function configuredResponseMode(): StructuredJsonResponseMode {
  const mode = process.env.EXTRACTION_RESPONSE_MODE?.trim().toLowerCase();
  return mode === "auto" || mode === "structured" || mode === "json" ? mode : "json";
}

function singleRequestMode(mode: StructuredJsonResponseMode): Exclude<StructuredJsonResponseMode, "auto"> {
  return mode === "auto" ? "structured" : mode;
}

function resolveMaxOutputTokens() {
  return readBoundedInteger({
    name: "DAILY_BRIEF_CHUNK_MAX_OUTPUT_TOKENS",
    raw: process.env.DAILY_BRIEF_CHUNK_MAX_OUTPUT_TOKENS ?? process.env.EXTRACTION_MAX_OUTPUT_TOKENS,
    fallback: DEFAULT_MAX_OUTPUT_TOKENS,
    min: 256,
    max: 8_000
  });
}

export function resolveDailyBriefCheckpointLeaseMs(totalTimeoutMs: number) {
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs < 0) {
    throw new Error("Daily Brief total timeout must be a finite non-negative number");
  }
  if (totalTimeoutMs <= 1) return 1;
  return Math.max(1, Math.min(60_000, Math.floor(totalTimeoutMs / 2)));
}

function combineAbortSignals(signals: AbortSignal[]) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => signals.forEach((signal) => signal.removeEventListener("abort", abort))
  };
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    const error = new Error("Daily Brief provider request aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const error = new Error("Daily Brief provider request aborted");
      error.name = "AbortError";
      reject(error);
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

function safeResponseStatus(value: string | undefined): SafeResponseDiagnostics["responseStatus"] {
  if (value === "completed" || value === "complete") return "complete";
  if (value === "incomplete") return "incomplete";
  if (value === "failed") return "failed";
  return "unavailable";
}

function safeIncompleteReason(value: string | undefined): SafeResponseDiagnostics["incompleteReason"] {
  if (value === "max_output_tokens" || value === "content_filter") return value;
  return value ? "other" : "none";
}

function safeResponseDiagnostics(
  diagnostics: StructuredJsonDiagnostics | undefined,
  evidenceValidationResult: SafeResponseDiagnostics["evidenceValidationResult"],
  successful: boolean
): SafeResponseDiagnostics {
  return {
    responseStatus: safeResponseStatus(diagnostics?.responseStatus),
    responseTextLength: Math.max(0, Math.trunc(diagnostics?.responseTextLength ?? 0)),
    finishReason: "not_available",
    incompleteReason: safeIncompleteReason(diagnostics?.incompleteReason),
    parseResult: diagnostics?.parseResult ?? (successful ? "success" : "not_started"),
    validationResult: diagnostics?.validationResult ?? (successful ? "success" : "not_started"),
    evidenceValidationResult
  };
}

function normalizeChunkItems(input: {
  uploadId: string;
  chunk: ExtractionChunk;
  parsedItems: ExtractedBriefItems;
}) {
  const segmentMap = new Map(input.chunk.segments.map((segment) => [segment.id, segment] as const));
  let invalidReferenceCount = 0;
  let rejectedItemCount = 0;

  for (const item of input.parsedItems) {
    const uniqueIds = new Set(item.sourceSegmentIds);
    const invalidIds = item.sourceSegmentIds.filter((sourceId) => !segmentMap.has(sourceId));
    if (
      item.sourceSegmentIds.length === 0
      || uniqueIds.size !== item.sourceSegmentIds.length
      || invalidIds.length > 0
    ) {
      invalidReferenceCount += invalidIds.length
        + Math.max(0, item.sourceSegmentIds.length - uniqueIds.size)
        + (item.sourceSegmentIds.length === 0 ? 1 : 0);
      rejectedItemCount += 1;
    }
  }
  if (rejectedItemCount > 0) {
    throw new DailyBriefEvidenceValidationError({ invalidReferenceCount, rejectedItemCount });
  }

  return input.parsedItems.map((item, index): BriefItem => {
    const resolvedSources = item.sourceSegmentIds.map((sourceId) => segmentMap.get(sourceId)!);
    return BriefItemSchema.parse({
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
      // Evidence text is deterministically backfilled from the retained transcript.
      transcriptExcerpt: resolvedSources[0].text,
      people: item.people,
      topics: item.topics
    });
  });
}

function requestText(chunk: ExtractionChunk, recoveryMode: DailyBriefRecoveryMode) {
  const transcript = formatExtractionSegments(chunk.segments);
  const recoveryInstruction = recoveryMode === "compact" ? COMPACT_RECOVERY_INSTRUCTION : "";
  const jsonInstruction = recoveryInstruction
    ? `${JSON_INSTRUCTION}\n${recoveryInstruction}`
    : JSON_INSTRUCTION;
  return {
    transcript,
    jsonInstruction,
    promptChars: SYSTEM_PROMPT.length + transcript.length + jsonInstruction.length
  };
}

export function dailyBriefProviderRequestMetrics(
  chunk: ExtractionChunk,
  recoveryMode: DailyBriefRecoveryMode = "standard"
) {
  const request = requestText(chunk, recoveryMode);
  return {
    inputChars: request.transcript.length,
    promptChars: request.promptChars,
    outputTokenLimit: resolveMaxOutputTokens()
  };
}

async function extractChunk(input: {
  client: ReturnType<typeof createOpenAIClient>;
  model: string;
  mode: Exclude<StructuredJsonResponseMode, "auto">;
  uploadId: string;
  chunk: ExtractionChunk;
  recoveryMode: DailyBriefRecoveryMode;
  timeoutMs: number;
  outputTokenLimit: number;
  signal: AbortSignal;
  onDiagnostics: (diagnostics: StructuredJsonDiagnostics) => void;
  onValidationFailureRawResponse?: (
    capture: StructuredJsonValidationFailureRawResponse
  ) => void | Promise<void>;
}) {
  const request = requestText(input.chunk, input.recoveryMode);
  const parsed = await parseStructuredJsonResponse({
    client: input.client,
    model: input.model,
    name: "founder_daily_brief_chunk",
    schema: ExtractedBriefSchema,
    requestInput: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: request.transcript }
    ],
    jsonInstruction: request.jsonInstruction,
    mode: input.mode,
    maxOutputTokens: input.outputTokenLimit,
    requestOptions: {
      timeout: input.timeoutMs,
      maxRetries: SDK_MAX_RETRIES,
      signal: input.signal
    },
    onDiagnostics: input.onDiagnostics,
    ...(input.onValidationFailureRawResponse ? {
      onValidationFailureRawResponse: input.onValidationFailureRawResponse
    } : {})
  });

  return {
    items: normalizeChunkItems({ uploadId: input.uploadId, chunk: input.chunk, parsedItems: parsed.items }),
    inputChars: request.transcript.length,
    promptChars: request.promptChars
  };
}

function validationSummary(
  error: unknown,
  diagnostics: StructuredJsonDiagnostics | undefined
): DailyBriefValidationCheckpointSummary | undefined {
  if (error instanceof ZodError) return buildDailyBriefValidationCheckpointSummary(error);
  if (diagnostics?.validationResult === "failed") {
    return buildDailyBriefValidationCheckpointSummary(diagnostics);
  }
  return undefined;
}

function validationLogFields(error: unknown, diagnostics: StructuredJsonDiagnostics | undefined) {
  if (error instanceof ZodError) return buildDailyBriefValidationLogFields(error);
  return buildDailyBriefValidationLogFields(diagnostics);
}

function attemptMetadata(records: DailyBriefAttemptAudit[]) {
  const latest = records.at(-1);
  return {
    responseDiagnostics: latest?.responseDiagnostics ?? safeResponseDiagnostics(undefined, "not_started", false),
    attemptDiagnostics: records.map(({ validationIssueSummary: _summary, ...record }) => record),
    ...(latest?.failurePhase ? { failurePhase: latest.failurePhase } : {}),
    ...(latest?.failureReason ? { failureReason: latest.failureReason } : {}),
    ...(latest?.validationIssueSummary ? {
      validationIssueSummary: latest.validationIssueSummary,
      validationIssueCount: latest.validationIssueCount ?? latest.validationIssueSummary.reduce(
        (sum, issue) => sum + issue.count,
        0
      ),
      validationIssuesTruncated: latest.validationIssuesTruncated === true
    } : {})
  };
}

function safeClassification(error: unknown, totalDeadlineAborted = false) {
  return classifyDailyBriefFailure(error, {
    totalDeadlineAborted,
    requestStarted: true
  });
}

function logAttemptStarted(input: {
  uploadId: string;
  chunk: ExtractionChunk;
  attempt: DailyBriefChunkAttemptContext;
  inputChars: number;
  promptChars: number;
  outputTokenLimit: number;
  attemptTimeoutMs: number;
  requestStartedAt: string;
}) {
  console.info(
    `[daily-brief-provider] request_started upload_id=${input.uploadId} chunk_index=${input.chunk.index + 1} attempt=${input.attempt.attempt} concurrency=${input.attempt.concurrency} segment_count=${input.chunk.segments.length} input_chars=${input.inputChars} prompt_chars=${input.promptChars} output_token_limit=${input.outputTokenLimit} attempt_timeout_ms=${input.attemptTimeoutMs} request_started_at=${input.requestStartedAt} recovery_mode=${input.attempt.recoveryMode}`
  );
}

function logAttemptFinished(input: {
  uploadId: string;
  chunk: ExtractionChunk;
  audit: DailyBriefAttemptAudit;
}) {
  const diagnostics = input.audit.responseDiagnostics;
  console.info(
    `[daily-brief-provider] request_finished upload_id=${input.uploadId} chunk_index=${input.chunk.index + 1} attempt=${input.audit.attempt} concurrency=${input.audit.concurrency} segment_count=${input.audit.segmentCount} input_chars=${input.audit.inputChars} prompt_chars=${input.audit.promptChars} output_token_limit=${input.audit.outputTokenLimit} attempt_timeout_ms=${input.audit.attemptTimeoutMs} request_started_at=${input.audit.requestStartedAt} elapsed_ms=${input.audit.elapsedMs} provider_status=${input.audit.providerStatus} http_status=${input.audit.httpStatus ?? "none"} response_status=${diagnostics.responseStatus} response_text_length=${diagnostics.responseTextLength} finish_reason=${diagnostics.finishReason} incomplete_reason=${diagnostics.incompleteReason} parse_result=${diagnostics.parseResult} validation_result=${diagnostics.validationResult} evidence_validation_result=${diagnostics.evidenceValidationResult} failure_phase=${input.audit.failurePhase ?? "none"} failure_reason=${input.audit.failureReason ?? "none"} retry_reason=${input.audit.retryable ? input.audit.failureReason ?? "unknown_provider_error" : "none"} retry_after_ms=${input.audit.retryAfterMs ?? 0} retry_after_capped=${input.audit.retryAfterCapped === true} fallback_reason=none recovery_mode=${input.audit.recoveryMode}`
  );
}

function processorFingerprint(input: {
  suppliedFingerprint?: string;
  provider: string;
  model: string;
  configuredMode: StructuredJsonResponseMode;
  requestMode: Exclude<StructuredJsonResponseMode, "auto">;
  outputTokenLimit: number;
  chunkTimeoutMs: number;
  totalTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  recoveryConcurrency: number;
}) {
  return fingerprintAnalysisInput({
    kind: "daily_brief",
    suppliedFingerprint: input.suppliedFingerprint ?? null,
    provider: input.provider,
    model: input.model,
    configuredResponseMode: input.configuredMode,
    requestMode: input.requestMode,
    promptVersion: PROMPT_VERSION,
    providerSchemaVersion: PROVIDER_SCHEMA_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    retryContractVersion: RETRY_CONTRACT_VERSION,
    plannerVersion: "semantic_guided_extraction_v1",
    outputTokenLimit: input.outputTokenLimit,
    chunkTimeoutMs: input.chunkTimeoutMs,
    totalTimeoutMs: input.totalTimeoutMs,
    maxRetries: input.maxRetries,
    retryDelayMs: input.retryDelayMs,
    recoveryConcurrency: input.recoveryConcurrency,
    sdkMaxRetries: SDK_MAX_RETRIES
  });
}

export const openaiExtractionProvider: ExtractionProvider = {
  async extract(uploadId: string, segments: TranscriptSegment[], options?: ExtractionOptions) {
    const extractionStartedAt = Date.now();
    const client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
    const model = process.env.OPENAI_TEXT_MODEL ?? "gpt-4.1-mini";
    const configuredMode = configuredResponseMode();
    const requestMode = singleRequestMode(configuredMode);
    const chunkTimeoutMs = readBoundedInteger({
      name: "EXTRACTION_CHUNK_TIMEOUT_MS",
      raw: process.env.EXTRACTION_CHUNK_TIMEOUT_MS,
      fallback: DEFAULT_CHUNK_TIMEOUT_MS,
      min: 1,
      max: 5 * 60_000
    });
    const totalTimeoutMs = readBoundedInteger({
      name: "EXTRACTION_TOTAL_TIMEOUT_MS",
      raw: process.env.EXTRACTION_TOTAL_TIMEOUT_MS,
      fallback: DEFAULT_TOTAL_TIMEOUT_MS,
      min: 0,
      max: 60 * 60_000
    });
    const maxRetries = resolveDailyBriefMaxRetries();
    const retryDelayMs = resolveDailyBriefRetryDelayMs();
    const recoveryConcurrency = resolveDailyBriefRecoveryConcurrency();
    const outputTokenLimit = resolveMaxOutputTokens();
    const attemptsByChunk = new Map<number, DailyBriefAttemptAudit[]>();
    const totalDeadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => totalDeadlineController.abort(), totalTimeoutMs);
    const checkpointProcessorFingerprint = processorFingerprint({
      suppliedFingerprint: options?.analysisCheckpoint?.processorFingerprint,
      provider: process.env.EXTRACTION_PROVIDER ?? "openai",
      model,
      configuredMode,
      requestMode,
      outputTokenLimit,
      chunkTimeoutMs,
      totalTimeoutMs,
      maxRetries,
      retryDelayMs,
      recoveryConcurrency
    });

    try {
      const result = await processDailyBriefChunks({
        uploadId,
        segments,
        semanticSegments: options?.semanticSegments,
        concurrency: resolveDailyBriefChunkConcurrency(),
        recoveryConcurrency,
        maxRetries,
        retryDelayMs,
        attemptTimeoutMs: chunkTimeoutMs,
        totalBudgetMs: totalTimeoutMs,
        onProgress: options?.onProgress,
        ...(options?.analysisCheckpoint ? {
          checkpoint: {
            store: options.analysisCheckpoint.store,
            userId: options.analysisCheckpoint.userId,
            recordingDate: options.analysisCheckpoint.recordingDate,
            processorFingerprint: checkpointProcessorFingerprint,
            // A live owner refreshes this lease while it waits for the bounded
            // recovery queue. A crashed owner can therefore be reclaimed without
            // waiting for the entire ten-minute stage budget.
            staleAfterMs: options.analysisCheckpoint.staleAfterMs
              ?? resolveDailyBriefCheckpointLeaseMs(totalTimeoutMs)
          }
        } : {}),
        executeChunk: async (chunk, attempt) => {
          if (totalDeadlineController.signal.aborted || Date.now() - extractionStartedAt >= totalTimeoutMs) {
            throw new ExtractionDeadlineError();
          }

          const request = requestText(chunk, attempt.recoveryMode);
          const requestStartedAt = new Date().toISOString();
          const attemptStartedAt = Date.now();
          let diagnostics: StructuredJsonDiagnostics | undefined;
          const combined = combineAbortSignals([attempt.signal, totalDeadlineController.signal]);
          logAttemptStarted({
            uploadId,
            chunk,
            attempt,
            inputChars: request.transcript.length,
            promptChars: request.promptChars,
            outputTokenLimit,
            attemptTimeoutMs: chunkTimeoutMs,
            requestStartedAt
          });

          try {
            const extracted = await awaitWithSignal(extractChunk({
              client,
              model,
              mode: requestMode,
              uploadId,
              chunk,
              recoveryMode: attempt.recoveryMode,
              timeoutMs: chunkTimeoutMs,
              outputTokenLimit,
              signal: combined.signal,
              onDiagnostics: (value) => {
                diagnostics = value;
              },
              ...(options?.evaluationRawResponseCapture ? {
                onValidationFailureRawResponse: async (capture) => {
                  await captureProviderValidationFailure({
                    provider: "daily_brief",
                    uploadId,
                    chunkIndex: chunk.index,
                    attempt: attempt.attempt,
                    model: capture.model,
                    schemaName: capture.schemaName,
                    capturedAt: capture.capturedAt,
                    rawResponse: capture.rawResponse,
                    validationIssueCount: capture.validationIssueCount,
                    validationIssues: capture.validationIssues,
                    validationIssueSummary: capture.validationIssueSummary,
                    validationIssuesTruncated: capture.validationIssuesTruncated,
                    evaluationRetention: true
                  });
                }
              } : {})
            }), combined.signal);
            const record: DailyBriefAttemptAudit = {
              attempt: attempt.attempt,
              recoveryMode: attempt.recoveryMode,
              concurrency: attempt.concurrency,
              segmentCount: chunk.segments.length,
              inputChars: extracted.inputChars,
              promptChars: extracted.promptChars,
              outputTokenLimit,
              attemptTimeoutMs: chunkTimeoutMs,
              requestStartedAt,
              elapsedMs: Date.now() - attemptStartedAt,
              providerStatus: "success",
              responseDiagnostics: safeResponseDiagnostics(diagnostics, "success", true)
            };
            const records = attemptsByChunk.get(chunk.index) ?? [];
            records.push(record);
            attemptsByChunk.set(chunk.index, records);
            logAttemptFinished({ uploadId, chunk, audit: record });
            return {
              items: extracted.items,
              resultSource: "provider_success",
              metadata: attemptMetadata(records)
            };
          } catch (error) {
            const classification = classifyDailyBriefFailure(error, {
              diagnostics,
              totalDeadlineAborted: totalDeadlineController.signal.aborted,
              requestStarted: true
            });
            const summary = validationSummary(error, diagnostics);
            const evidenceResult = error instanceof DailyBriefEvidenceValidationError ? "failed" : "not_started";
            const record: DailyBriefAttemptAudit = {
              attempt: attempt.attempt,
              recoveryMode: attempt.recoveryMode,
              concurrency: attempt.concurrency,
              segmentCount: chunk.segments.length,
              inputChars: request.transcript.length,
              promptChars: request.promptChars,
              outputTokenLimit,
              attemptTimeoutMs: chunkTimeoutMs,
              requestStartedAt,
              elapsedMs: Date.now() - attemptStartedAt,
              providerStatus: "failed",
              responseDiagnostics: safeResponseDiagnostics(diagnostics, evidenceResult, false),
              failurePhase: classification.failurePhase,
              failureReason: classification.failureCode,
              retryable: classification.retryable,
              ...(classification.httpStatus === undefined ? {} : { httpStatus: classification.httpStatus }),
              ...(classification.retryAfterMs === undefined ? {} : {
                retryAfterMs: classification.retryAfterMs,
                retryAfterCapped: classification.retryAfterCapped === true
              }),
              ...(summary ? {
                validationIssueSummary: summary.validationIssueSummary,
                validationIssueCount: summary.validationIssueCount,
                validationIssuesTruncated: summary.validationIssuesTruncated
              } : {})
            };
            const records = attemptsByChunk.get(chunk.index) ?? [];
            records.push(record);
            attemptsByChunk.set(chunk.index, records);
            if (classification.failureCode === "validation_failure") {
              const fields = validationLogFields(error, diagnostics);
              console.info(
                `[daily-brief-provider] validation_failed upload_id=${uploadId} chunk_index=${chunk.index + 1} attempt=${attempt.attempt} validation_issue_count=${fields.validationIssueCount} validation_issue_codes=${fields.validationIssueCodes.join(",") || "none"} validation_issue_paths=${fields.validationIssuePaths.join(",") || "none"} truncated=${fields.validationIssuesTruncated}`
              );
            }
            logAttemptFinished({ uploadId, chunk, audit: record });
            throw wrapDailyBriefProviderFailure(error, {
              diagnostics,
              totalDeadlineAborted: totalDeadlineController.signal.aborted,
              requestStarted: true
            });
          } finally {
            combined.dispose();
          }
        },
        shouldRetry: (error) => safeClassification(error).retryable,
        retryDelayForError: (error, configuredDelayMs) => {
          const classification = safeClassification(error);
          return Math.max(configuredDelayMs, classification.retryAfterMs ?? 0);
        },
        recoveryModeForError: (error) => safeClassification(error).compactRecovery ? "compact" : "standard",
        failureReasonForError: (error) => safeClassification(
          error,
          totalDeadlineController.signal.aborted
        ).failureCode,
        fallbackChunk: async (chunk, error) => {
          const classification = safeClassification(
            error,
            totalDeadlineController.signal.aborted
          );
          const records = attemptsByChunk.get(chunk.index) ?? [];
          console.info(
            `[daily-brief-provider] fallback upload_id=${uploadId} chunk_index=${chunk.index + 1} attempt_count=${records.length} failure_phase=${classification.failurePhase} failure_reason=${classification.failureCode} retry_reason=none fallback_reason=${classification.failureCode}`
          );
          return {
            items: await ruleExtractionProvider.extract(uploadId, chunk.segments),
            resultSource: "rule_fallback",
            fallbackReason: classification.failureCode,
            metadata: attemptMetadata(records)
          };
        }
      });
      return result.items;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
};
