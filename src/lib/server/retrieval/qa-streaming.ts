import { randomUUID } from "node:crypto";

import { z } from "zod";
import type { QuestionAnswer } from "@/lib/domain/types";

const NullableDurationSchema = z.number().int().nonnegative().nullable();
const NullableTimestampSchema = z.string().datetime().nullable();

export const QaStreamingFallbackReasonSchema = z.enum([
  "empty_stream",
  "unsupported_stream",
  "incomplete_stream",
  "provider_stream_error",
  "provider_error",
  "provider_error_after_partial_stream",
  "insufficient_evidence",
  "empty_answer",
  "answer_too_long",
  "forbidden_relationship_output",
  "unsupported_answer",
  "missing_citations",
  "relationship_scope_boundary",
  "memory_scope_boundary",
  "assistant_meta_scope",
  "model_provider_mismatch"
]);

export type QaStreamingFallbackReason = z.infer<typeof QaStreamingFallbackReasonSchema>;

export const QaSentenceCommitDiagnosticsSchema = z.object({
  sentenceUnits: z.number().int().nonnegative(),
  committedUnits: z.number().int().nonnegative(),
  missingSentenceSupport: z.number().int().nonnegative(),
  citationMetadataMismatch: z.number().int().nonnegative(),
  responseNotFullyCommittable: z.number().int().nonnegative()
}).strict();

export type QaSentenceCommitDiagnostics = z.infer<typeof QaSentenceCommitDiagnosticsSchema>;

export const QaStreamingProviderMetricsSchema = z.object({
  providerId: z.enum(["gpt-5.5", "qwen-vllm"]),
  model: z.string().trim().min(1).max(256),
  reasoningEnabled: z.boolean().nullable(),
  outputTokenCount: z.number().int().nonnegative().nullable(),
  totalTokenCount: z.number().int().nonnegative().nullable()
}).strict();

export type QaStreamingProviderMetrics = z.infer<typeof QaStreamingProviderMetricsSchema>;

export const QaStreamingTraceSchema = z.object({
  version: z.literal(1),
  streamId: z.string().uuid(),
  status: z.enum(["completed", "completed_with_fallback", "failed"]),
  timestamps: z.object({
    stream_started: z.string().datetime(),
    provider_request_started: NullableTimestampSchema,
    first_token_received: NullableTimestampSchema,
    first_sentence_candidate: NullableTimestampSchema,
    first_sentence_validated: NullableTimestampSchema,
    first_sentence_completed: NullableTimestampSchema,
    provider_stream_ended: NullableTimestampSchema,
    stream_completed: NullableTimestampSchema
  }).strict(),
  latencies: z.object({
    firstTokenMs: NullableDurationSchema,
    firstSentenceCandidateMs: NullableDurationSchema,
    firstSentenceValidatedMs: NullableDurationSchema,
    firstSentenceMs: NullableDurationSchema,
    totalStreamMs: NullableDurationSchema,
    totalOperationMs: NullableDurationSchema
  }).strict(),
  tokenChunkCount: z.number().int().nonnegative(),
  sentenceCount: z.number().int().nonnegative(),
  providerCallCount: z.number().int().nonnegative(),
  fallbackReason: QaStreamingFallbackReasonSchema.nullable(),
  sentenceCommit: QaSentenceCommitDiagnosticsSchema.optional(),
  providerMetrics: QaStreamingProviderMetricsSchema.optional()
}).strict();

export type QaStreamingTrace = z.infer<typeof QaStreamingTraceSchema>;
export type QaStreamingTraceObserver = (trace: QaStreamingTrace) => unknown;

export type QaAnswerStreamEvent =
  | {
      type: "stream_started";
      streamId: string;
      timestamp: string;
    }
  | {
      type: "token";
      sequence: number;
      /** Explicitly quarantined raw JSON delta. */
      quarantinedText: string;
      /** Raw provider JSON delta. It is never safe to route to UI or TTS. */
      safeForSpeech: false;
      safeForPersistence: false;
      validated: false;
    }
  | {
      type: "sentence_completed";
      sequence: number;
      /** Citation-free sentence projection produced by SentenceCommitManager. */
      sentence: string;
      /** Backward-compatible alias for sentence. */
      text: string;
      citationIds: string[];
      /** Trusted source segment IDs resolved from this turn's evidence allowlist. */
      supportIds: string[];
      /** Explicit canonical source IDs for the sentence; identical to supportIds. */
      citedSegmentIds: string[];
      groundingValidated: true;
      /** The unchanged Voice Response Optimizer must run before TTS. */
      safeForSpeech: false;
      safeForPersistence: false;
      requiresResponseOptimization: true;
      validated: true;
      status: "committed";
      reason: "grounded";
    }
  | {
      type: "final";
      answer: QuestionAnswer;
      source: "provider_stream" | "provider_stream_validation_fallback" | "non_stream_fallback";
      trace: QaStreamingTrace;
    };

type TraceClock = {
  now(): number;
  isoNow(): string;
};

export type QaStreamingTraceRecorder = {
  readonly streamId: string;
  readonly startedAt: string;
  markProviderStarted(): void;
  markFirstToken(): void;
  markFirstSentenceCandidate(): void;
  markFirstSentenceValidated(): void;
  markFirstSentence(): void;
  markProviderEnded(): void;
  complete(input: {
    status: QaStreamingTrace["status"];
    tokenChunkCount: number;
    sentenceCount: number;
    providerCallCount: number;
    fallbackReason?: QaStreamingFallbackReason | null;
    sentenceCommit?: QaSentenceCommitDiagnostics;
    providerMetrics?: QaStreamingProviderMetrics;
  }): QaStreamingTrace;
};

export function createQaStreamingTraceRecorder(options: {
  clock?: TraceClock;
  streamId?: string;
} = {}): QaStreamingTraceRecorder {
  const clock = options.clock ?? {
    now: () => performance.now(),
    isoNow: () => new Date().toISOString()
  };
  const streamId = options.streamId ?? randomUUID();
  const startedMonotonic = clock.now();
  const startedAt = clock.isoNow();
  let providerStartedAt: string | null = null;
  let providerStartedMonotonic: number | null = null;
  let firstTokenAt: string | null = null;
  let firstTokenMonotonic: number | null = null;
  let firstSentenceCandidateAt: string | null = null;
  let firstSentenceCandidateMonotonic: number | null = null;
  let firstSentenceValidatedAt: string | null = null;
  let firstSentenceValidatedMonotonic: number | null = null;
  let firstSentenceAt: string | null = null;
  let firstSentenceMonotonic: number | null = null;
  let providerEndedAt: string | null = null;
  let providerEndedMonotonic: number | null = null;
  let completedTrace: QaStreamingTrace | null = null;
  const elapsed = (start: number | null, end: number | null) =>
    start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || end < start
      ? null
      : Math.round(end - start);

  return {
    streamId,
    startedAt,
    markProviderStarted() {
      if (completedTrace || providerStartedAt !== null) return;
      providerStartedMonotonic = clock.now();
      providerStartedAt = clock.isoNow();
    },
    markFirstToken() {
      if (completedTrace || firstTokenAt !== null || providerStartedAt === null) return;
      firstTokenMonotonic = clock.now();
      firstTokenAt = clock.isoNow();
    },
    markFirstSentenceCandidate() {
      if (completedTrace || firstSentenceCandidateAt !== null) return;
      firstSentenceCandidateMonotonic = clock.now();
      firstSentenceCandidateAt = clock.isoNow();
    },
    markFirstSentenceValidated() {
      if (completedTrace || firstSentenceValidatedAt !== null) return;
      firstSentenceValidatedMonotonic = clock.now();
      firstSentenceValidatedAt = clock.isoNow();
    },
    markFirstSentence() {
      if (completedTrace || firstSentenceAt !== null) return;
      firstSentenceMonotonic = clock.now();
      firstSentenceAt = clock.isoNow();
      if (firstSentenceValidatedAt === null) {
        firstSentenceValidatedMonotonic = firstSentenceMonotonic;
        firstSentenceValidatedAt = firstSentenceAt;
      }
    },
    markProviderEnded() {
      if (completedTrace || providerEndedAt !== null || providerStartedAt === null) return;
      providerEndedMonotonic = clock.now();
      providerEndedAt = clock.isoNow();
    },
    complete(input) {
      if (completedTrace) return completedTrace;
      const completedMonotonic = clock.now();
      const completedAt = clock.isoNow();
      completedTrace = QaStreamingTraceSchema.parse({
        version: 1,
        streamId,
        status: input.status,
        timestamps: {
          stream_started: startedAt,
          provider_request_started: providerStartedAt,
          first_token_received: firstTokenAt,
          first_sentence_candidate: firstSentenceCandidateAt,
          first_sentence_validated: firstSentenceValidatedAt,
          first_sentence_completed: firstSentenceAt,
          provider_stream_ended: providerEndedAt,
          stream_completed: completedAt
        },
        latencies: {
          firstTokenMs: elapsed(providerStartedMonotonic, firstTokenMonotonic),
          firstSentenceCandidateMs: elapsed(startedMonotonic, firstSentenceCandidateMonotonic),
          firstSentenceValidatedMs: elapsed(startedMonotonic, firstSentenceValidatedMonotonic),
          firstSentenceMs: elapsed(startedMonotonic, firstSentenceMonotonic),
          totalStreamMs: elapsed(providerStartedMonotonic, providerEndedMonotonic),
          totalOperationMs: elapsed(startedMonotonic, completedMonotonic)
        },
        tokenChunkCount: input.tokenChunkCount,
        sentenceCount: input.sentenceCount,
        providerCallCount: input.providerCallCount,
        fallbackReason: input.fallbackReason ?? null,
        ...(input.sentenceCommit ? { sentenceCommit: input.sentenceCommit } : {}),
        ...(input.providerMetrics ? { providerMetrics: input.providerMetrics } : {})
      });
      return completedTrace;
    }
  };
}

/** Splits only an already validated answer and keeps immediate [E#] citations attached. */
export function splitValidatedQaSentences(text: string): string[] {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  let buffer = "";
  for (let index = 0; index < normalized.length; index += 1) {
    buffer += normalized[index];
    if (!/[。！？!?]/u.test(normalized[index])) continue;

    let cursor = index + 1;
    while (cursor < normalized.length) {
      const suffix = normalized.slice(cursor);
      const trailing = suffix.match(/^(?:[”’」』）)\]]|\s*\[E\d+\])+/u)?.[0];
      if (!trailing) break;
      buffer += trailing;
      cursor += trailing.length;
    }
    index = cursor - 1;
    const sentence = buffer.replace(/\s+/gu, " ").trim();
    if (sentence) sentences.push(sentence);
    buffer = "";
  }

  const remainder = buffer.replace(/\s+/gu, " ").trim();
  if (remainder) sentences.push(remainder);
  return sentences;
}

export function notifyQaStreamingTrace(
  observer: QaStreamingTraceObserver | undefined,
  trace: QaStreamingTrace,
  logger: Pick<Console, "info" | "warn"> = console
) {
  const payload = {
    stream_id: trace.streamId,
    status: trace.status,
    first_token_ms: trace.latencies.firstTokenMs,
    first_sentence_candidate_ms: trace.latencies.firstSentenceCandidateMs,
    first_sentence_validated_ms: trace.latencies.firstSentenceValidatedMs,
    first_sentence_ms: trace.latencies.firstSentenceMs,
    total_stream_ms: trace.latencies.totalStreamMs,
    total_operation_ms: trace.latencies.totalOperationMs,
    token_chunk_count: trace.tokenChunkCount,
    sentence_count: trace.sentenceCount,
    provider_call_count: trace.providerCallCount,
    fallback_reason: trace.fallbackReason,
    sentence_units: trace.sentenceCommit?.sentenceUnits ?? null,
    committed_units: trace.sentenceCommit?.committedUnits ?? null,
    missing_sentence_support: trace.sentenceCommit?.missingSentenceSupport ?? null,
    citation_metadata_mismatch: trace.sentenceCommit?.citationMetadataMismatch ?? null,
    response_not_fully_committable:
      trace.sentenceCommit?.responseNotFullyCommittable ?? null,
    provider_id: trace.providerMetrics?.providerId ?? null,
    model: trace.providerMetrics?.model ?? null,
    reasoning_enabled: trace.providerMetrics?.reasoningEnabled ?? null,
    output_token_count: trace.providerMetrics?.outputTokenCount ?? null,
    total_token_count: trace.providerMetrics?.totalTokenCount ?? null
  };
  try {
    logger.info(`QA_STREAM_TRACE: ${JSON.stringify(payload)}`);
  } catch {
    // Observability must never alter QA control flow.
  }
  if (!observer) return;

  try {
    const result = observer(QaStreamingTraceSchema.parse(trace));
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch((error: unknown) => {
        try {
          logger.warn(
            `[qa-streaming] observer_failed error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        } catch {
          // Observability must never alter QA control flow.
        }
      });
    }
  } catch (error) {
    try {
      logger.warn(
        `[qa-streaming] observer_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    } catch {
      // Observability must never alter QA control flow.
    }
  }
}
