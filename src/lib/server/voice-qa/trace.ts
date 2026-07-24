import { randomUUID } from "node:crypto";

import { z } from "zod";
import { QaExecutionDiagnosticsSchema } from "@/lib/server/retrieval/qa-observability";

export const VOICE_SESSION_TRACE_EVENTS = [
  "session_created",
  "speech_started",
  "speech_ended",
  "asr_first_partial",
  "asr_final_received",
  "qa_started",
  "qa_completed",
  "tts_started",
  "first_sentence_committed",
  "first_safe_sentence",
  "tts_stream_started",
  "first_audio_chunk_received",
  "playback_started",
  "stream_completed",
  "audio_play_started",
  "session_completed"
] as const;

export type VoiceSessionTraceEvent = (typeof VOICE_SESSION_TRACE_EVENTS)[number];

export const VoiceSessionTraceStatusSchema = z.enum([
  "in_progress",
  "completed",
  "completed_with_errors",
  "failed",
  "aborted",
  "incomplete"
]);

export type VoiceSessionTraceStatus = z.infer<typeof VoiceSessionTraceStatusSchema>;

export const VoiceSessionTraceFailureStageSchema = z.enum([
  "session",
  "asr",
  "qa",
  "tts",
  "playback"
]);

export type VoiceSessionTraceFailureStage = z.infer<typeof VoiceSessionTraceFailureStageSchema>;

export const VoiceSessionTraceFailureCodeSchema = z.enum([
  "request_aborted",
  "response_timeout",
  "session_failed",
  "asr_failed",
  "asr_timeout",
  "asr_final_missing",
  "qa_failed",
  "qa_timeout",
  "tts_failed",
  "tts_timeout",
  "playback_failed",
  "client_closed",
  "connection_lost"
]);

export type VoiceSessionTraceFailureCode = z.infer<typeof VoiceSessionTraceFailureCodeSchema>;

const VoiceSessionTraceTimestampsSchema = z.object({
  session_created: z.string().datetime(),
  speech_started: z.string().datetime().optional(),
  speech_ended: z.string().datetime().optional(),
  asr_first_partial: z.string().datetime().optional(),
  asr_final_received: z.string().datetime().optional(),
  qa_started: z.string().datetime().optional(),
  qa_completed: z.string().datetime().optional(),
  tts_started: z.string().datetime().optional(),
  first_sentence_committed: z.string().datetime().optional(),
  first_safe_sentence: z.string().datetime().optional(),
  tts_stream_started: z.string().datetime().optional(),
  first_audio_chunk_received: z.string().datetime().optional(),
  playback_started: z.string().datetime().optional(),
  stream_completed: z.string().datetime().optional(),
  audio_play_started: z.string().datetime().optional(),
  session_completed: z.string().datetime().optional()
}).strict();

const VoiceSessionTraceLatenciesSchema = z.object({
  asrLatencyMs: z.number().int().nonnegative().nullable(),
  qaLatencyMs: z.number().int().nonnegative().nullable(),
  ttsLatencyMs: z.number().int().nonnegative().nullable(),
  totalResponseLatencyMs: z.number().int().nonnegative().nullable()
}).strict();

const VoiceStreamingTraceLatenciesSchema = z.object({
  speechToFirstSentenceCommittedMs: z.number().int().nonnegative().nullable(),
  speechToFirstSafeSentenceMs: z.number().int().nonnegative().nullable(),
  ttsToFirstAudioChunkMs: z.number().int().nonnegative().nullable(),
  firstAudioChunkToPlaybackMs: z.number().int().nonnegative().nullable(),
  speechToFirstAudioPlayMs: z.number().int().nonnegative().nullable(),
  streamDurationMs: z.number().int().nonnegative().nullable()
}).strict();

const VoiceSessionTraceFailureSchema = z.object({
  stage: VoiceSessionTraceFailureStageSchema,
  code: VoiceSessionTraceFailureCodeSchema
}).strict();

export const VoiceQaLatencyBreakdownSchema = QaExecutionDiagnosticsSchema.extend({
  totalMs: z.number().int().nonnegative().nullable(),
  evidenceCount: z.number().int().nonnegative().nullable(),
  providerCallCount: z.number().int().nonnegative().nullable(),
  responseOptimizationMs: z.number().int().nonnegative().nullable(),
  endToEndQaMs: z.number().int().nonnegative().nullable()
}).strict();

export type VoiceQaLatencyBreakdown = z.infer<typeof VoiceQaLatencyBreakdownSchema>;

export const VoiceSessionTraceSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  applicationSessionId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  providerSessionId: z.string().min(1).max(256).optional(),
  scope: z.enum(["current", "week", "all"]),
  uploadId: z.string().min(1).max(256).optional(),
  status: VoiceSessionTraceStatusSchema,
  timestamps: VoiceSessionTraceTimestampsSchema,
  latencies: VoiceSessionTraceLatenciesSchema,
  streamingLatencies: VoiceStreamingTraceLatenciesSchema.optional(),
  qaBreakdown: VoiceQaLatencyBreakdownSchema.optional(),
  failures: z.array(VoiceSessionTraceFailureSchema).max(8),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export type VoiceSessionTrace = z.infer<typeof VoiceSessionTraceSchema>;

export type VoiceSessionTraceWriter = {
  write(trace: VoiceSessionTrace): Promise<void>;
};

export type VoiceSessionTraceLogger = Pick<Console, "info" | "warn">;

export type VoiceSessionTraceRecorder = {
  readonly sessionId: string;
  mark(event: VoiceSessionTraceEvent): boolean;
  setProviderSessionId(providerSessionId: string): void;
  recordFailure(stage: VoiceSessionTraceFailureStage, code: VoiceSessionTraceFailureCode): void;
  recordQaBreakdown?(breakdown: VoiceQaLatencyBreakdown): void;
  complete(status?: Extract<VoiceSessionTraceStatus, "completed" | "failed" | "aborted" | "incomplete">): void;
  snapshot(): VoiceSessionTrace;
  flush(): Promise<void>;
};

type TraceClock = () => Date;

const TERMINAL_STATUSES = new Set<VoiceSessionTraceStatus>([
  "completed",
  "completed_with_errors",
  "failed",
  "aborted",
  "incomplete"
]);

export function isTerminalVoiceSessionTraceStatus(status: VoiceSessionTraceStatus) {
  return TERMINAL_STATUSES.has(status);
}

function safeIsoTimestamp(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Voice session trace clock must return a valid Date");
  }
  return value.toISOString();
}

function durationMs(
  timestamps: VoiceSessionTrace["timestamps"],
  start: VoiceSessionTraceEvent,
  end: VoiceSessionTraceEvent
) {
  const startValue = timestamps[start];
  const endValue = timestamps[end];
  if (!startValue || !endValue) return null;
  const duration = Date.parse(endValue) - Date.parse(startValue);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function calculateVoiceSessionTraceLatencies(
  timestamps: VoiceSessionTrace["timestamps"]
): VoiceSessionTrace["latencies"] {
  return {
    asrLatencyMs: durationMs(timestamps, "speech_ended", "asr_final_received"),
    qaLatencyMs: durationMs(timestamps, "qa_started", "qa_completed"),
    ttsLatencyMs: timestamps.playback_started
      ? durationMs(timestamps, "tts_stream_started", "playback_started")
      : durationMs(timestamps, "tts_started", "audio_play_started"),
    totalResponseLatencyMs: timestamps.playback_started
      ? durationMs(timestamps, "speech_ended", "playback_started")
      : durationMs(timestamps, "speech_ended", "audio_play_started")
  };
}

export function calculateVoiceStreamingTraceLatencies(
  timestamps: VoiceSessionTrace["timestamps"]
) {
  return VoiceStreamingTraceLatenciesSchema.parse({
    speechToFirstSentenceCommittedMs: durationMs(
      timestamps,
      "speech_ended",
      "first_sentence_committed"
    ),
    speechToFirstSafeSentenceMs: durationMs(
      timestamps,
      "speech_ended",
      "first_safe_sentence"
    ),
    ttsToFirstAudioChunkMs: durationMs(
      timestamps,
      "tts_stream_started",
      "first_audio_chunk_received"
    ),
    firstAudioChunkToPlaybackMs: durationMs(
      timestamps,
      "first_audio_chunk_received",
      "playback_started"
    ),
    speechToFirstAudioPlayMs: durationMs(
      timestamps,
      "speech_ended",
      "playback_started"
    ),
    streamDurationMs: durationMs(
      timestamps,
      "tts_stream_started",
      "stream_completed"
    )
  });
}

function hasStreamingTraceTimestamp(timestamps: VoiceSessionTrace["timestamps"]) {
  return Boolean(
    timestamps.first_sentence_committed ||
    timestamps.first_safe_sentence ||
    timestamps.tts_stream_started ||
    timestamps.first_audio_chunk_received ||
    timestamps.playback_started ||
    timestamps.stream_completed
  );
}

export type CreateVoiceSessionTraceInput = {
  sessionId?: string;
  applicationSessionId?: string;
  scope: "current" | "week" | "all";
  uploadId?: string;
  now?: TraceClock;
};

export function createVoiceSessionTraceModel(input: CreateVoiceSessionTraceInput): VoiceSessionTrace {
  const timestamp = safeIsoTimestamp((input.now ?? (() => new Date()))());
  return VoiceSessionTraceSchema.parse({
    version: 1,
    sessionId: input.sessionId ?? randomUUID(),
    ...(input.applicationSessionId
      ? { applicationSessionId: input.applicationSessionId }
      : {}),
    scope: input.scope,
    ...(input.uploadId ? { uploadId: input.uploadId } : {}),
    status: "in_progress",
    timestamps: { session_created: timestamp },
    latencies: {
      asrLatencyMs: null,
      qaLatencyMs: null,
      ttsLatencyMs: null,
      totalResponseLatencyMs: null
    },
    failures: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export type UpdateVoiceSessionTraceInput = {
  event?: VoiceSessionTraceEvent;
  providerSessionId?: string;
  failure?: {
    stage: VoiceSessionTraceFailureStage;
    code: VoiceSessionTraceFailureCode;
  };
  qaBreakdown?: VoiceQaLatencyBreakdown;
  terminalStatus?: Extract<VoiceSessionTraceStatus, "completed" | "failed" | "aborted" | "incomplete">;
  now?: TraceClock;
};

export function updateVoiceSessionTrace(
  trace: VoiceSessionTrace,
  input: UpdateVoiceSessionTraceInput
): VoiceSessionTrace {
  const current = VoiceSessionTraceSchema.parse(trace);
  // A terminal trace is immutable. Browser telemetry can be delayed or
  // duplicated, so accepting a late event would make the persisted trace
  // disagree with the terminal VOICE_TRACE log that was already emitted.
  if (TERMINAL_STATUSES.has(current.status)) return trace;
  const timestamp = safeIsoTimestamp((input.now ?? (() => new Date()))());
  const timestamps = { ...current.timestamps };
  let changed = false;
  if (input.event && timestamps[input.event] === undefined) {
    timestamps[input.event] = timestamp;
    changed = true;
  }

  const failures = [...current.failures];
  if (
    input.failure &&
    !failures.some((failure) => failure.stage === input.failure!.stage && failure.code === input.failure!.code) &&
    failures.length < 8
  ) {
    failures.push(input.failure);
    changed = true;
  }

  let status = current.status;
  if (!TERMINAL_STATUSES.has(status) && input.terminalStatus) {
    status = input.terminalStatus === "completed" && failures.length > 0
      ? "completed_with_errors"
      : input.terminalStatus;
    changed = true;
  }

  const providerSessionId = input.providerSessionId?.trim();
  if (providerSessionId && !current.providerSessionId) changed = true;
  const qaBreakdown = input.qaBreakdown
    ? VoiceQaLatencyBreakdownSchema.parse(input.qaBreakdown)
    : current.qaBreakdown;
  if (input.qaBreakdown && current.qaBreakdown === undefined) changed = true;
  if (!changed) return current;

  return VoiceSessionTraceSchema.parse({
    ...current,
    ...(providerSessionId && !current.providerSessionId
      ? { providerSessionId }
      : {}),
    status,
    timestamps,
    latencies: calculateVoiceSessionTraceLatencies(timestamps),
    ...(hasStreamingTraceTimestamp(timestamps)
      ? { streamingLatencies: calculateVoiceStreamingTraceLatencies(timestamps) }
      : {}),
    ...(qaBreakdown ? { qaBreakdown } : {}),
    failures,
    updatedAt: timestamp
  });
}

function assertMergeCompatible(current: VoiceSessionTrace, incoming: VoiceSessionTrace) {
  if (
    current.sessionId !== incoming.sessionId ||
    current.version !== incoming.version ||
    current.applicationSessionId !== incoming.applicationSessionId ||
    current.scope !== incoming.scope ||
    current.uploadId !== incoming.uploadId ||
    current.createdAt !== incoming.createdAt
  ) {
    throw new Error("Cannot merge incompatible voice session traces");
  }
}

function laterIsoTimestamp(left: string, right: string) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/**
 * Merges a locally captured tracer snapshot into the latest persisted trace.
 * Persisted values are first-write-wins: a delayed snapshot may append events
 * that are still missing, but it may never replace browser telemetry or a
 * terminal trace that was persisted by another request.
 */
export function mergeVoiceSessionTrace(
  persisted: VoiceSessionTrace,
  snapshot: VoiceSessionTrace
): VoiceSessionTrace {
  const current = VoiceSessionTraceSchema.parse(persisted);
  const incoming = VoiceSessionTraceSchema.parse(snapshot);
  assertMergeCompatible(current, incoming);
  if (isTerminalVoiceSessionTraceStatus(current.status)) return persisted;

  const timestamps: VoiceSessionTrace["timestamps"] = { ...current.timestamps };
  let changed = false;
  for (const event of VOICE_SESSION_TRACE_EVENTS) {
    const incomingTimestamp = incoming.timestamps[event];
    if (timestamps[event] === undefined && incomingTimestamp !== undefined) {
      timestamps[event] = incomingTimestamp;
      changed = true;
    }
  }

  const failures = [...current.failures];
  for (const failure of incoming.failures) {
    if (
      failures.length < 8 &&
      !failures.some((value) => value.stage === failure.stage && value.code === failure.code)
    ) {
      failures.push(failure);
      changed = true;
    }
  }

  const providerSessionId = current.providerSessionId ?? incoming.providerSessionId;
  if (!current.providerSessionId && providerSessionId) changed = true;
  const qaBreakdown = current.qaBreakdown ?? incoming.qaBreakdown;
  if (!current.qaBreakdown && qaBreakdown) changed = true;

  let status = current.status;
  if (isTerminalVoiceSessionTraceStatus(incoming.status)) {
    status = incoming.status;
    if (status === "completed" && failures.length > 0) status = "completed_with_errors";
    changed = true;
  }

  if (!changed) return persisted;
  return VoiceSessionTraceSchema.parse({
    ...current,
    ...(providerSessionId ? { providerSessionId } : {}),
    status,
    timestamps,
    latencies: calculateVoiceSessionTraceLatencies(timestamps),
    ...(hasStreamingTraceTimestamp(timestamps)
      ? { streamingLatencies: calculateVoiceStreamingTraceLatencies(timestamps) }
      : {}),
    ...(qaBreakdown ? { qaBreakdown } : {}),
    failures,
    updatedAt: laterIsoTimestamp(current.updatedAt, incoming.updatedAt)
  });
}

export function voiceTraceLogPayload(trace: VoiceSessionTrace) {
  return {
    session_id: trace.sessionId,
    asr_latency_ms: trace.latencies.asrLatencyMs,
    qa_latency_ms: trace.latencies.qaLatencyMs,
    tts_latency_ms: trace.latencies.ttsLatencyMs,
    total_latency_ms: trace.latencies.totalResponseLatencyMs,
    speech_to_first_audio_play_ms:
      trace.streamingLatencies?.speechToFirstAudioPlayMs ?? null,
    first_sentence_committed_ms:
      trace.streamingLatencies?.speechToFirstSentenceCommittedMs ?? null,
    tts_to_first_audio_chunk_ms:
      trace.streamingLatencies?.ttsToFirstAudioChunkMs ?? null,
    status: trace.status
  };
}

export function logVoiceSessionTrace(
  trace: VoiceSessionTrace,
  logger: Pick<Console, "info"> = console
) {
  logger.info(`VOICE_TRACE: ${JSON.stringify(voiceTraceLogPayload(trace))}`);
}

export type VoiceSessionTracerOptions = CreateVoiceSessionTraceInput & {
  writer?: VoiceSessionTraceWriter;
  logger?: VoiceSessionTraceLogger;
};

export class VoiceSessionTracer implements VoiceSessionTraceRecorder {
  private current: VoiceSessionTrace;
  private readonly now: TraceClock;
  private readonly writer?: VoiceSessionTraceWriter;
  private readonly logger: VoiceSessionTraceLogger;
  private persistenceTail: Promise<void> = Promise.resolve();
  private terminalLogged = false;

  constructor(options: VoiceSessionTracerOptions) {
    this.now = options.now ?? (() => new Date());
    this.writer = options.writer;
    this.logger = options.logger ?? console;
    this.current = createVoiceSessionTraceModel({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.applicationSessionId
        ? { applicationSessionId: options.applicationSessionId }
        : {}),
      scope: options.scope,
      ...(options.uploadId ? { uploadId: options.uploadId } : {}),
      now: this.now
    });
    this.queuePersistence();
  }

  get sessionId() {
    return this.current.sessionId;
  }

  mark(event: VoiceSessionTraceEvent) {
    if (this.current.timestamps[event] !== undefined) return false;
    const updated = updateVoiceSessionTrace(this.current, { event, now: this.now });
    if (updated === this.current) return false;
    this.current = updated;
    this.queuePersistence();
    return true;
  }

  setProviderSessionId(providerSessionId: string) {
    const normalized = providerSessionId.trim();
    if (!normalized || this.current.providerSessionId) return;
    if (normalized.length > 256) {
      this.logger.warn(`[voice-trace] provider_session_id_rejected session_id=${this.sessionId}`);
      return;
    }
    this.current = updateVoiceSessionTrace(this.current, {
      providerSessionId: normalized,
      now: this.now
    });
    this.queuePersistence();
  }

  recordFailure(stage: VoiceSessionTraceFailureStage, code: VoiceSessionTraceFailureCode) {
    const before = this.current.failures.length;
    this.current = updateVoiceSessionTrace(this.current, {
      failure: { stage, code },
      now: this.now
    });
    if (this.current.failures.length !== before) this.queuePersistence();
  }

  recordQaBreakdown(breakdown: VoiceQaLatencyBreakdown) {
    if (this.current.qaBreakdown) return;
    this.current = updateVoiceSessionTrace(this.current, {
      qaBreakdown: breakdown,
      now: this.now
    });
    this.queuePersistence();
  }

  complete(
    status: Extract<VoiceSessionTraceStatus, "completed" | "failed" | "aborted" | "incomplete"> = "completed"
  ) {
    const alreadyTerminal = TERMINAL_STATUSES.has(this.current.status);
    this.current = updateVoiceSessionTrace(this.current, {
      event: "session_completed",
      terminalStatus: status,
      now: this.now
    });
    if (!alreadyTerminal) {
      this.queuePersistence();
      this.logTerminal();
    }
  }

  snapshot() {
    return VoiceSessionTraceSchema.parse(this.current);
  }

  async flush() {
    await this.persistenceTail;
  }

  private queuePersistence() {
    if (!this.writer) return;
    const snapshot = this.snapshot();
    this.persistenceTail = this.persistenceTail
      .then(() => this.writer!.write(snapshot))
      .catch((error: unknown) => {
        this.logger.warn(
          `[voice-trace] persist_failed session_id=${this.sessionId} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      });
  }

  private logTerminal() {
    if (this.terminalLogged) return;
    this.terminalLogged = true;
    logVoiceSessionTrace(this.current, this.logger);
  }
}
