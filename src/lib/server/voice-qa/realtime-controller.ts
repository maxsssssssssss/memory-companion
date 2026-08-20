import type { QuestionAnswer } from "@/lib/domain/types";
import {
  RealtimeVoiceLatencyTracker,
  type RealtimeVoiceLatencyMarker,
  type RealtimeVoiceLatencySnapshot
} from "@/lib/voice-realtime-latency";
import {
  type QaRetrievedEvidence
} from "@/lib/server/retrieval/ai-qa";
import { VoiceEvent, type ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import { logVoiceDebug } from "@/lib/server/voice/debug";
import { requireSpokenProjection } from "@/lib/server/voice/spoken-projection";
import {
  StreamingTtsError,
  streamTextToSpeech,
  type StreamingSpeechSentence
} from "@/lib/server/voice/streaming-tts";
import {
  VoiceProviderError,
  type VoiceProvider,
  type VoiceSessionConfig,
  type VoiceUnsubscribe
} from "@/lib/server/voice/types";

import {
  normalizeVoiceQaQuery,
  parseVoiceQaTranscriptUpdates
} from "./adapter";
import {
  optimizeVoiceResponse,
  voiceResponseSourceFromQuestionAnswer
} from "./response-optimizer";
import { optimizeStreamingVoiceSentence } from "./streaming-response-optimizer";
import type { VoiceQaAnswerer } from "./types";
import type { VoiceQaConversationMessage } from "./types";

const DEFAULT_REALTIME_VAD_END_SMOOTH_WINDOW_MS = 700;
const DEFAULT_REALTIME_TURN_TIMEOUT_MS = 60_000;
const DEFAULT_REALTIME_PROVIDER_RECONNECT_ATTEMPTS = 3;
const DEFAULT_REALTIME_PROVIDER_RECONNECT_DELAY_MS = 100;
export const REALTIME_VOICE_INPUT_RESET_REQUIRED_ERROR =
  "voice_realtime_gateway_input_reset_required";
const REALTIME_FALLBACK_TEXT = "暂时无法获取相关记录。";

export type RealtimeVoiceQaEvent =
  | {
      type: "session_started";
      providerSessionId: string;
    }
  | {
      type: "session_reconnected";
      providerSessionId: string;
    }
  | {
      type: "voice_activity";
    }
  | {
      type: "asr_partial";
      transcript: string;
    }
  | {
      type: "asr_final";
      turnSequence: number;
      transcript: string;
    }
  | {
      type: "turn_state";
      turnSequence: number;
      state: "thinking" | "speaking" | "listening";
    }
  | {
      type: "speech_sentence";
      turnSequence: number;
      sentenceSequence: number;
      supportIds: string[];
      text: string;
    }
  | {
      type: "audio_chunk";
      turnSequence: number;
      sequence: number;
      sentenceSequence: number;
      sentenceChunkSequence: number;
      supportIds: string[];
      providerItemId?: string;
      audio: Buffer;
    }
  | {
      type: "latency_marker";
      turnSequence: number;
      marker: RealtimeVoiceLatencyMarker;
      atMs: number;
    }
  | {
      type: "turn_trace";
      turnSequence: number;
      terminalStatus: "completed" | "failed" | "interrupted";
      terminalReason: string;
      latency: RealtimeVoiceLatencySnapshot;
      reconnectCount: number;
      interruptLatencyMs: number | null;
      abortedGenerationCount: number;
      providerGenerationStarted: boolean;
      providerGenerationCompleted: boolean;
      audioChunkCount: number;
      wastedTokenCount: null;
    }
  | {
      type: "answer";
      turnSequence: number;
      transcript: string;
      text: string;
      answer?: QuestionAnswer;
    }
  | {
      type: "turn_complete";
      turnSequence: number;
      status: "completed" | "failed" | "interrupted";
      errorCode?: string;
    }
  | {
      type: "turn_interrupted";
      turnSequence: number;
      reason: "barge_in" | "connection_lost" | "session_closed";
    }
  | {
      type: "error";
      code: string;
    }
  | {
      type: "session_closed";
    };

export type RealtimeVoiceQaRagShadowInput = {
  turnSequence: number;
  transcript: string;
  evidence: QaRetrievedEvidence[];
};

export type RealtimeVoiceQaControllerOptions = {
  provider: VoiceProvider;
  answerer: VoiceQaAnswerer;
  sessionConfig?: VoiceSessionConfig;
  turnTimeoutMs?: number;
  providerReconnectAttempts?: number;
  providerReconnectDelayMs?: number;
  conversation?: readonly VoiceQaConversationMessage[];
  onTurnCompleted?: (input: {
    transcript: string;
    answer: QuestionAnswer;
  }) => void | Promise<void>;
  runRagShadow?: (
    input: RealtimeVoiceQaRagShadowInput
  ) => void | Promise<void>;
};

type QueueWaiter = {
  resolve: (value: IteratorResult<StreamingSpeechSentence>) => void;
  reject: (error: Error) => void;
};

class RealtimeSentenceQueue implements AsyncIterable<StreamingSpeechSentence> {
  private readonly items: StreamingSpeechSentence[] = [];
  private readonly waiters: QueueWaiter[] = [];
  private closed = false;
  private failure?: Error;

  push(sentence: StreamingSpeechSentence) {
    if (this.closed || this.failure) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: sentence, done: false });
    else this.items.push(sentence);
    return true;
  }

  close() {
    if (this.closed || this.failure) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error) {
    if (this.closed || this.failure) return;
    this.failure = error;
    this.items.splice(0);
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamingSpeechSentence> {
    return {
      next: () => {
        if (this.failure) return Promise.reject(this.failure);
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<StreamingSpeechSentence>>(
          (resolve, reject) => this.waiters.push({ resolve, reject })
        );
      }
    };
  }
}

type ActiveRealtimeTurn = {
  sequence: number;
  abortController: AbortController;
  latency: RealtimeVoiceLatencyTracker;
  sentenceQueue?: RealtimeSentenceQueue;
  streamingTask?: Promise<void>;
  currentProviderItemId?: string;
  interrupted: boolean;
  terminalEmitted: boolean;
  stage: RealtimeTurnStage;
  providerGenerationStarted: boolean;
  providerGenerationCompleted: boolean;
  audioChunkCount: number;
  abortedGenerationCount: number;
  timeoutTriggered: boolean;
};

export type RealtimeVoiceQaSessionState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "reconnecting"
  | "closed";

type RealtimeTurnStage =
  | "retrieval"
  | "qa"
  | "llm_stream"
  | "sentence_commit"
  | "tts"
  | "finalization";

function boundedTurnTimeout(value: number | undefined) {
  const timeout = value ?? DEFAULT_REALTIME_TURN_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new VoiceProviderError(
      "invalid_configuration",
      "Realtime Voice QA turn timeout must be between 1000 and 300000ms"
    );
  }
  return timeout;
}

function boundedReconnectAttempts(value: number | undefined) {
  const attempts = value ?? DEFAULT_REALTIME_PROVIDER_RECONNECT_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new VoiceProviderError(
      "invalid_configuration",
      "Realtime Voice Provider reconnect attempts must be between 1 and 10"
    );
  }
  return attempts;
}

function boundedReconnectDelay(value: number | undefined) {
  const delay = value ?? DEFAULT_REALTIME_PROVIDER_RECONNECT_DELAY_MS;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 5_000) {
    throw new VoiceProviderError(
      "invalid_configuration",
      "Realtime Voice Provider reconnect delay must be between 0 and 5000ms"
    );
  }
  return delay;
}

function payloadString(
  event: ParsedVoiceServerEvent,
  field: string
) {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return undefined;
  }
  const value = (event.payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function payloadBoolean(
  event: ParsedVoiceServerEvent,
  field: string
) {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return undefined;
  }
  const value = (event.payload as Record<string, unknown>)[field];
  return typeof value === "boolean" ? value : undefined;
}

function reconnectableProviderFailure(error: unknown) {
  return error instanceof VoiceProviderError && (
    error.reason === "connection_closed" ||
    error.reason === "connection_failed"
  );
}

function reconnectableProviderEvent(event: ParsedVoiceServerEvent) {
  return event.internalFailureReason === "connection_closed" ||
    event.internalFailureReason === "connection_failed";
}

function safeRealtimeErrorCode(error: unknown) {
  if (error instanceof VoiceProviderError) return error.reason;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "realtime_turn_failed";
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Realtime Voice QA turn aborted", "AbortError")
    );
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Realtime Voice QA turn aborted", "AbortError")
      );
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      }
    );
  });
}

/**
 * Owns one persistent Volcengine server-VAD session and multiple canonical QA
 * turns. Provider free-form ChatResponse/default audio is never forwarded.
 */
export class RealtimeVoiceQaController {
  private readonly provider: VoiceProvider;
  private readonly answerer: VoiceQaAnswerer;
  private readonly sessionConfig: VoiceSessionConfig;
  private readonly turnTimeoutMs: number;
  private readonly providerReconnectAttempts: number;
  private readonly providerReconnectDelayMs: number;
  private readonly onTurnCompleted?: RealtimeVoiceQaControllerOptions["onTurnCompleted"];
  private readonly runRagShadow?: RealtimeVoiceQaControllerOptions["runRagShadow"];
  private readonly listeners = new Set<(event: RealtimeVoiceQaEvent) => unknown>();
  private readonly conversation: VoiceQaConversationMessage[];
  private readonly unsubscribers: VoiceUnsubscribe[] = [];
  private providerSessionId?: string;
  private bufferedPartialTranscript?: string;
  private bufferedFinalTranscript?: string;
  private turnSequence = 0;
  private activeTurn?: ActiveRealtimeTurn;
  private pendingLatency?: RealtimeVoiceLatencyTracker;
  private readonly latencyByTurn = new Map<number, RealtimeVoiceLatencyTracker>();
  private readonly providerItems = new Map<string, number>();
  private reconnecting?: Promise<void>;
  private cancellingTurn?: Promise<void>;
  private abortedGenerationCount = 0;
  private providerReconnectCount = 0;
  private sessionState: RealtimeVoiceQaSessionState = "idle";
  private started = false;
  private closing = false;

  constructor(options: RealtimeVoiceQaControllerOptions) {
    this.provider = options.provider;
    this.answerer = options.answerer;
    this.turnTimeoutMs = boundedTurnTimeout(options.turnTimeoutMs);
    this.providerReconnectAttempts = boundedReconnectAttempts(
      options.providerReconnectAttempts
    );
    this.providerReconnectDelayMs = boundedReconnectDelay(
      options.providerReconnectDelayMs
    );
    this.onTurnCompleted = options.onTurnCompleted;
    this.runRagShadow = options.runRagShadow;
    this.conversation = (options.conversation ?? [])
      .slice(-8)
      .map((message) => ({ ...message }));
    this.sessionConfig = {
      inputMode: "server_vad",
      model: "1.2.1.1",
      audioOutput: {
        format: "pcm_s16le",
        sampleRate: 24_000,
        channels: 1
      },
      vad: {
        endSmoothWindowMs: DEFAULT_REALTIME_VAD_END_SMOOTH_WINDOW_MS,
        enableCustomVad: true
      },
      dialog: {
        enableConversationTruncate: true
      },
      ...options.sessionConfig
    };
  }

  onEvent(listener: (event: RealtimeVoiceQaEvent) => unknown): VoiceUnsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get snapshot() {
    return {
      state: this.sessionState,
      providerSessionId: this.providerSessionId,
      activeTurnSequence: this.activeTurn?.sequence,
      turnSequence: this.turnSequence,
      reconnectCount: this.providerReconnectCount,
      abortedGenerationCount: this.abortedGenerationCount
    };
  }

  async start() {
    if (this.started) {
      throw new VoiceProviderError(
        "invalid_state",
        "Realtime Voice QA session has already started"
      );
    }
    this.started = true;
    this.unsubscribers.push(
      this.provider.onEvent((event) => this.handleProviderEvent(event))
    );
    try {
      await this.provider.connect();
      const session = await this.provider.startSession(this.sessionConfig);
      this.providerSessionId = session.sessionId;
      this.transitionSession("listening");
      this.emit({
        type: "session_started",
        providerSessionId: session.sessionId
      });
      return session;
    } catch (error) {
      this.started = false;
      this.unsubscribeAll();
      await this.provider.close().catch(() => undefined);
      throw error;
    }
  }

  async sendAudio(chunk: Buffer) {
    if (!this.started || this.closing) {
      throw new VoiceProviderError(
        "invalid_state",
        "Realtime Voice QA session is not accepting audio"
      );
    }
    if (!Buffer.isBuffer(chunk) || chunk.byteLength === 0) {
      throw new VoiceProviderError(
        "invalid_request",
        "Realtime Voice QA audio chunk must not be empty"
      );
    }
    try {
      await this.provider.sendAudio(chunk);
    } catch (error) {
      if (!reconnectableProviderFailure(error) || !this.provider.reconnect) {
        throw error;
      }
      try {
        await this.reconnectProvider();
      } catch (reconnectError) {
        this.emit({ type: "error", code: safeRealtimeErrorCode(reconnectError) });
        if (!this.closing) await this.close();
        throw reconnectError;
      }
      // A fresh Provider session has none of the PCM preceding this failed
      // chunk. Replaying only the tail would corrupt ASR context, so leave the
      // new session empty and require a fresh client input epoch instead.
      throw new VoiceProviderError(
        "connection_closed",
        REALTIME_VOICE_INPUT_RESET_REQUIRED_ERROR
      );
    }
  }

  async markBrowserPlaybackStarted(turnSequence: number) {
    const latency = this.latencyByTurn.get(turnSequence);
    if (!latency) return false;
    if (latency.snapshot().timestamps.complete !== undefined) {
      return latency.mark("browser_playback_start");
    }
    this.markLatency(latency, "browser_playback_start");
    return true;
  }

  async startClientTurn() {
    const latency = this.ensurePendingLatency();
    if (this.markLatency(latency, "speech_start")) {
      this.emit({ type: "voice_activity" });
      await this.cancelSessionTurn("barge_in");
    }
  }

  async cancelSessionTurn(
    reason: Extract<
      RealtimeVoiceQaEvent,
      { type: "turn_interrupted" }
    >["reason"] = "barge_in",
    expectedTurnSequence?: number
  ) {
    return await this.interruptActiveTurn(reason, expectedTurnSequence);
  }

  latencySnapshot(turnSequence: number): RealtimeVoiceLatencySnapshot | undefined {
    return this.latencyByTurn.get(turnSequence)?.snapshot();
  }

  async truncatePlayback(
    turnSequence: number,
    providerItemId: string,
    audioEndMs: number
  ) {
    if (
      this.providerItems.get(providerItemId) !== turnSequence ||
      !this.provider.truncateConversation
    ) {
      return false;
    }
    await this.provider.truncateConversation(providerItemId, audioEndMs);
    this.providerItems.delete(providerItemId);
    return true;
  }

  async close() {
    if (!this.started || this.closing) return;
    this.closing = true;
    await this.interruptActiveTurn("session_closed");
    await this.provider.finishSession().catch(() => undefined);
    await this.provider.close().catch(() => undefined);
    this.unsubscribeAll();
    this.transitionSession("closed");
    this.emit({ type: "session_closed" });
    this.listeners.clear();
  }

  private emit(event: RealtimeVoiceQaEvent) {
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (
          result &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // Observers cannot break the authenticated Voice session.
      }
    }
  }

  private transitionSession(next: RealtimeVoiceQaSessionState) {
    if (this.sessionState === next) return false;
    if (this.sessionState === "closed") return false;
    const allowed: Record<RealtimeVoiceQaSessionState, readonly RealtimeVoiceQaSessionState[]> = {
      idle: ["listening", "closed"],
      listening: ["thinking", "reconnecting", "closed"],
      thinking: ["speaking", "listening", "reconnecting", "closed"],
      speaking: ["listening", "reconnecting", "closed"],
      reconnecting: ["listening", "closed"],
      closed: []
    };
    if (!allowed[this.sessionState].includes(next)) {
      throw new VoiceProviderError(
        "invalid_state",
        `Illegal Realtime Voice session transition: ${this.sessionState} -> ${next}`
      );
    }
    this.sessionState = next;
    return true;
  }

  private emitTurnTerminal(
    turn: ActiveRealtimeTurn,
    status: Extract<RealtimeVoiceQaEvent, { type: "turn_complete" }>["status"],
    options: {
      errorCode?: string;
      terminalReason: string;
      interruptLatencyMs?: number;
      providerCancelStatus?: "not_needed" | "sent" | "failed";
    }
  ) {
    if (turn.terminalEmitted) return false;
    turn.terminalEmitted = true;
    if (this.activeTurn === turn) this.activeTurn = undefined;
    this.markLatency(turn.latency, "complete");
    logVoiceDebug("realtime_turn_terminal", {
      turn_id: turn.sequence,
      terminal_status: status,
      failure_stage: status === "failed" ? turn.stage : "none",
      terminal_reason: options.terminalReason,
      audio_chunk_count: turn.audioChunkCount,
      provider_generation_started: turn.providerGenerationStarted,
      provider_generation_completed: turn.providerGenerationCompleted,
      aborted_generation_count: this.abortedGenerationCount,
      ...(options.interruptLatencyMs !== undefined
        ? { interrupt_latency_ms: options.interruptLatencyMs }
        : {}),
      ...(options.providerCancelStatus
        ? { provider_cancel_status: options.providerCancelStatus }
        : {})
    });
    this.emit({
      type: "turn_trace",
      turnSequence: turn.sequence,
      terminalStatus: status,
      terminalReason: options.terminalReason,
      latency: turn.latency.snapshot(),
      reconnectCount: this.providerReconnectCount,
      interruptLatencyMs: options.interruptLatencyMs ?? null,
      abortedGenerationCount: turn.abortedGenerationCount,
      providerGenerationStarted: turn.providerGenerationStarted,
      providerGenerationCompleted: turn.providerGenerationCompleted,
      audioChunkCount: turn.audioChunkCount,
      wastedTokenCount: null
    });
    this.emit({
      type: "turn_complete",
      turnSequence: turn.sequence,
      status,
      ...(options.errorCode ? { errorCode: options.errorCode } : {})
    });
    return true;
  }

  private ensurePendingLatency() {
    const expectedSequence = this.turnSequence + 1;
    if (this.pendingLatency?.turnSequence === expectedSequence) {
      return this.pendingLatency;
    }
    const latency = new RealtimeVoiceLatencyTracker(expectedSequence);
    this.pendingLatency = latency;
    this.latencyByTurn.set(expectedSequence, latency);
    while (this.latencyByTurn.size > 16) {
      const oldest = this.latencyByTurn.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.latencyByTurn.delete(oldest);
    }
    return latency;
  }

  private markLatency(
    latency: RealtimeVoiceLatencyTracker,
    marker: RealtimeVoiceLatencyMarker
  ) {
    if (!latency.mark(marker)) return false;
    const atMs = latency.snapshot().timestamps[marker];
    if (atMs === undefined) return false;
    this.emit({
      type: "latency_marker",
      turnSequence: latency.turnSequence,
      marker,
      atMs
    });
    return true;
  }

  private async reconnectProvider() {
    if (!this.provider.reconnect) {
      throw new VoiceProviderError(
        "connection_closed",
        "Realtime Voice Provider cannot restore its session"
      );
    }
    if (this.reconnecting) return await this.reconnecting;
    const reconnecting = (async () => {
      await this.interruptActiveTurn("connection_lost");
      this.transitionSession("reconnecting");
      this.pendingLatency = undefined;
      this.bufferedPartialTranscript = undefined;
      this.bufferedFinalTranscript = undefined;
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.providerReconnectAttempts; attempt += 1) {
        if (this.closing) {
          throw new VoiceProviderError(
            "connection_closed",
            "Realtime Voice session closed while reconnecting"
          );
        }
        try {
          const session = await this.provider.reconnect!();
          if (this.closing) {
            await this.provider.finishSession().catch(() => undefined);
            throw new VoiceProviderError(
              "connection_closed",
              "Realtime Voice session closed while reconnecting"
            );
          }
          this.providerReconnectCount += 1;
          this.providerSessionId = session.sessionId;
          this.providerItems.clear();
          this.transitionSession("listening");
          this.emit({
            type: "session_reconnected",
            providerSessionId: session.sessionId
          });
          return;
        } catch (error) {
          lastError = error;
          if (this.closing) throw error;
          if (attempt < this.providerReconnectAttempts) {
            await this.waitForProviderReconnect(attempt);
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new VoiceProviderError(
            "connection_failed",
            "Realtime Voice Provider reconnect attempts were exhausted"
          );
    })();
    this.reconnecting = reconnecting;
    try {
      await reconnecting;
    } finally {
      if (this.reconnecting === reconnecting) this.reconnecting = undefined;
    }
  }

  private async waitForProviderReconnect(attempt: number) {
    const delay = this.providerReconnectDelayMs * (2 ** Math.max(0, attempt - 1));
    if (delay <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      const poll = setInterval(() => {
        if (!this.closing) return;
        clearTimeout(timer);
        clearInterval(poll);
        reject(new VoiceProviderError(
          "connection_closed",
          "Realtime Voice session closed while waiting to reconnect"
        ));
      }, Math.min(25, delay));
      timer.unref?.();
      poll.unref?.();
      setTimeout(() => clearInterval(poll), delay + 1).unref?.();
    });
  }

  private handleProviderEvent(event: ParsedVoiceServerEvent) {
    if (
      this.closing ||
      (event.sessionId && event.sessionId !== this.providerSessionId)
    ) {
      return;
    }
    if (reconnectableProviderEvent(event)) {
      void this.reconnectProvider().catch(async (error: unknown) => {
        this.emit({ type: "error", code: safeRealtimeErrorCode(error) });
        if (!this.closing) await this.close();
      });
      return;
    }
    if (event.eventId === VoiceEvent.ASRInfo) {
      const latency = this.ensurePendingLatency();
      if (payloadBoolean(event, "speaking") === false) {
        this.markLatency(latency, "speech_end");
        return;
      }
      if (this.markLatency(latency, "speech_start")) {
        this.emit({ type: "voice_activity" });
        void this.interruptActiveTurn("barge_in");
      }
      return;
    }
    if (event.eventId === VoiceEvent.ASRResponse) {
      const updates = parseVoiceQaTranscriptUpdates(
        event,
        this.providerSessionId
      );
      const selected =
        [...updates].reverse().find((update) => update.finality === "final") ??
        updates.at(-1);
      if (!selected) return;
      const transcript = normalizeVoiceQaQuery(selected.transcript);
      if (!transcript) return;
      const latency = this.ensurePendingLatency();
      if (selected.finality === "final") {
        this.bufferedFinalTranscript = transcript;
      } else if (!this.bufferedFinalTranscript) {
        this.bufferedPartialTranscript = transcript;
        this.markLatency(latency, "first_partial_asr");
        this.emit({ type: "asr_partial", transcript });
      }
      return;
    }
    if (event.eventId === VoiceEvent.ASREnded) {
      const latency = this.pendingLatency;
      const transcript =
        this.bufferedFinalTranscript ?? this.bufferedPartialTranscript;
      this.bufferedFinalTranscript = undefined;
      this.bufferedPartialTranscript = undefined;
      this.pendingLatency = undefined;
      if (!transcript) {
        if (latency) this.emit({ type: "error", code: "asr_empty" });
        return;
      }
      const selectedLatency = latency ?? this.ensurePendingLatency();
      this.pendingLatency = undefined;
      this.markLatency(selectedLatency, "speech_end");
      void this.beginTurn(transcript, selectedLatency);
      return;
    }
    if (event.eventId === VoiceEvent.TTSSentenceStart) {
      if (payloadString(event, "tts_type") === "chat_tts_text") {
        const replyId = payloadString(event, "reply_id");
        const turn = this.activeTurn;
        if (replyId && turn) {
          turn.currentProviderItemId = replyId;
          this.providerItems.set(replyId, turn.sequence);
          while (this.providerItems.size > 16) {
            const oldest = this.providerItems.keys().next().value as string | undefined;
            if (!oldest) break;
            this.providerItems.delete(oldest);
          }
        }
      }
    }
  }

  private async interruptActiveTurn(
    reason: Extract<
      RealtimeVoiceQaEvent,
      { type: "turn_interrupted" }
    >["reason"],
    expectedTurnSequence?: number
  ) {
    const turn = this.activeTurn;
    if (
      !turn ||
      (expectedTurnSequence !== undefined && turn.sequence !== expectedTurnSequence)
    ) return false;
    if (turn.interrupted) {
      await this.cancellingTurn?.catch(() => undefined);
      return false;
    }
    turn.interrupted = true;
    const interruptedAt = performance.now();
    const abortError = new DOMException(
      "Realtime Voice QA turn interrupted",
      "AbortError"
    );
    turn.abortController.abort(abortError);
    turn.sentenceQueue?.fail(abortError);
    if (turn.providerGenerationStarted && !turn.providerGenerationCompleted) {
      this.abortedGenerationCount += 1;
      turn.abortedGenerationCount += 1;
    }
    this.emit({
      type: "turn_interrupted",
      turnSequence: turn.sequence,
      reason
    });
    const cancellation = (async () => {
      const cancel = this.provider.cancelSessionTurn ??
        this.provider.interruptResponse;
      let providerCancelStatus: "not_needed" | "sent" | "failed" = "not_needed";
      if (cancel) {
        try {
          await cancel.call(this.provider);
          providerCancelStatus = "sent";
        } catch {
          providerCancelStatus = "failed";
        }
      }
      if (this.activeTurn === turn) this.activeTurn = undefined;
      if (!this.closing && this.sessionState !== "reconnecting") {
        this.transitionSession("listening");
      }
      this.emitTurnTerminal(turn, "interrupted", {
        terminalReason: reason,
        interruptLatencyMs: Math.max(0, Math.round(performance.now() - interruptedAt)),
        providerCancelStatus
      });
    })();
    this.cancellingTurn = cancellation;
    try {
      await cancellation;
    } finally {
      if (this.cancellingTurn === cancellation) this.cancellingTurn = undefined;
    }
    return true;
  }

  private timeoutTurn(turn: ActiveRealtimeTurn) {
    if (
      this.activeTurn !== turn ||
      turn.terminalEmitted ||
      turn.interrupted ||
      turn.timeoutTriggered
    ) {
      return;
    }
    turn.timeoutTriggered = true;
    const timeoutError = new VoiceProviderError(
      "timeout",
      "Realtime Voice QA turn exceeded its bounded deadline"
    );
    if (turn.providerGenerationStarted && !turn.providerGenerationCompleted) {
      this.abortedGenerationCount += 1;
      turn.abortedGenerationCount += 1;
    }
    turn.abortController.abort(timeoutError);
    turn.sentenceQueue?.fail(timeoutError);
    const cancel = this.provider.cancelSessionTurn ?? this.provider.interruptResponse;
    if (!cancel) return;
    const cancellation = Promise.resolve(cancel.call(this.provider))
      .catch(() => undefined)
      .then(() => undefined);
    this.cancellingTurn = cancellation;
    void cancellation.finally(() => {
      if (this.cancellingTurn === cancellation) this.cancellingTurn = undefined;
    });
  }

  private async beginTurn(
    transcript: string,
    latency: RealtimeVoiceLatencyTracker
  ) {
    if (this.closing) return;
    await this.cancellingTurn?.catch(() => undefined);
    await this.interruptActiveTurn("barge_in");
    const sequence = ++this.turnSequence;
    const turnLatency = latency.turnSequence === sequence
      ? latency
      : new RealtimeVoiceLatencyTracker(sequence);
    this.latencyByTurn.set(sequence, turnLatency);
    const turn: ActiveRealtimeTurn = {
      sequence,
      abortController: new AbortController(),
      latency: turnLatency,
      interrupted: false,
      terminalEmitted: false,
      stage: "retrieval",
      providerGenerationStarted: false,
      providerGenerationCompleted: false,
      audioChunkCount: 0,
      abortedGenerationCount: 0,
      timeoutTriggered: false
    };
    this.activeTurn = turn;
    this.transitionSession("thinking");
    this.markLatency(turn.latency, "asr_final");
    this.emit({
      type: "asr_final",
      turnSequence: turn.sequence,
      transcript
    });
    this.emit({
      type: "turn_state",
      turnSequence: turn.sequence,
      state: "thinking"
    });

    const timeout = setTimeout(() => void this.timeoutTurn(turn), this.turnTimeoutMs);
    try {
      await this.answerTurn(turn, transcript);
    } finally {
      clearTimeout(timeout);
      if (this.activeTurn === turn) this.activeTurn = undefined;
    }
  }

  private startStreamingTts(
    turn: ActiveRealtimeTurn,
    queue: RealtimeSentenceQueue
  ) {
    if (turn.streamingTask) return turn.streamingTask;
    const sessionId = this.providerSessionId;
    if (!sessionId) {
      throw new VoiceProviderError(
        "invalid_state",
        "Realtime Voice QA Provider session is missing"
      );
    }
    turn.sentenceQueue = queue;
    turn.stage = "tts";
    this.transitionSession("speaking");
    this.emit({
      type: "turn_state",
      turnSequence: turn.sequence,
      state: "speaking"
    });
    const streamingTask = (async () => {
      for await (const event of streamTextToSpeech(queue, {
        provider: this.provider,
        sessionId,
        signal: turn.abortController.signal,
        onTtsRequestStart: () => {
          this.markLatency(turn.latency, "tts_start");
        }
      })) {
        if (turn.interrupted || this.activeTurn !== turn) return;
        if (event.type === "audio_chunk") {
          turn.audioChunkCount += 1;
          this.markLatency(turn.latency, "first_audio");
          this.emit({
            type: "audio_chunk",
            turnSequence: turn.sequence,
            sequence: event.sequence,
            sentenceSequence: event.sentenceSequence,
            sentenceChunkSequence: event.sentenceChunkSequence,
            supportIds: event.supportIds,
            ...(turn.currentProviderItemId
              ? { providerItemId: turn.currentProviderItemId }
              : {}),
            audio: event.audio
          });
        }
      }
    })();
    // A speaking turn can be aborted while the canonical answer promise is
    // still pending. Attach a rejection observer immediately so the TTS task
    // cannot become an unhandled rejection before answerTurn reaches its await.
    void streamingTask.catch(() => undefined);
    turn.streamingTask = streamingTask;
    return streamingTask;
  }

  private async answerTurn(
    turn: ActiveRealtimeTurn,
    transcript: string
  ) {
    const queue = new RealtimeSentenceQueue();
    let answer: QuestionAnswer | null = null;
    let spokenText = "";
    const releasedSentences: string[] = [];
    const pendingSentences = new Map<number, StreamingSpeechSentence>();
    let lastReleasedSentenceSequence: number | undefined;
    let shadowStarted = false;
    const startShadow = (
      evidence: QaRetrievedEvidence[]
    ) => {
      if (!this.runRagShadow || shadowStarted || turn.interrupted) return;
      shadowStarted = true;
      void Promise.resolve(this.runRagShadow({
        turnSequence: turn.sequence,
        transcript,
        evidence
      })).catch(() => undefined);
    };
    const releaseSentence = (sentence: StreamingSpeechSentence) => {
      if (turn.interrupted || this.activeTurn !== turn) return;
      this.markLatency(turn.latency, "answer_ready");
      this.markLatency(turn.latency, "sentence_commit");
      this.emit({
        type: "speech_sentence",
        turnSequence: turn.sequence,
        sentenceSequence: sentence.sequence,
        supportIds: [...sentence.supportIds],
        text: sentence.spokenSentence
      });
      this.startStreamingTts(turn, queue);
      if (!queue.push(sentence)) {
        throw new VoiceProviderError(
          "invalid_state",
          "Realtime Voice sentence queue rejected a grounded sentence"
        );
      }
      releasedSentences.push(sentence.spokenSentence);
      lastReleasedSentenceSequence = sentence.sequence;
    };
    const drainPendingSentences = (final: boolean) => {
      if (turn.interrupted || this.activeTurn !== turn) return;
      if (lastReleasedSentenceSequence === undefined) {
        if (pendingSentences.has(1)) {
          // A canonical first sentence is available; low-latency release is safe.
        } else if (!final) {
          // A later provisional sentence arrived first. Hold it until the missing
          // earlier grounded sentence or the canonical final answer settles.
          return;
        }
      }
      while (pendingSentences.size > 0) {
        const ordered = [...pendingSentences.keys()].sort((a, b) => a - b);
        const nextSequence = lastReleasedSentenceSequence === undefined
          ? ordered[0]
          : lastReleasedSentenceSequence + 1;
        const next = nextSequence === undefined
          ? undefined
          : pendingSentences.get(nextSequence);
        if (!next) {
          if (!final) return;
          const fallbackSequence = ordered.find((sequence) =>
            lastReleasedSentenceSequence === undefined ||
            sequence > lastReleasedSentenceSequence
          );
          if (fallbackSequence === undefined) return;
          const fallback = pendingSentences.get(fallbackSequence);
          if (!fallback) return;
          pendingSentences.delete(fallbackSequence);
          releaseSentence(fallback);
          continue;
        }
        pendingSentences.delete(nextSequence!);
        releaseSentence(next);
      }
    };

    try {
      turn.stage = "retrieval";
      this.markLatency(turn.latency, "retrieval_start");
      answer = await abortable(this.answerer.answer({
        sessionId: this.providerSessionId ?? "realtime_voice",
        transcript,
        mode: "VOICE",
        signal: turn.abortController.signal,
        ...(this.conversation.length > 0
          ? { conversation: this.conversation.map((message) => ({ ...message })) }
          : {}),
        onRetrievedEvidence: (evidence) => startShadow(evidence),
        onQaMilestone: (milestone) => {
          if (milestone === "retrieval_complete") {
            turn.stage = "qa";
            this.markLatency(turn.latency, "retrieval_complete");
            this.markLatency(turn.latency, "qa_start");
          } else if (milestone === "llm_started") {
            turn.stage = "llm_stream";
            turn.providerGenerationStarted = true;
            this.markLatency(turn.latency, "qa_start");
          } else if (milestone === "llm_first_token") {
            turn.stage = "llm_stream";
            turn.providerGenerationStarted = true;
            this.markLatency(turn.latency, "qa_start");
            this.markLatency(turn.latency, "llm_first_token");
          }
        },
        onQaStreamEvent: async (event) => {
          if (
            turn.interrupted ||
            this.activeTurn !== turn ||
            event.type !== "sentence_completed"
          ) {
            return;
          }
          turn.stage = "sentence_commit";
          const optimized = optimizeStreamingVoiceSentence({
            sequence: event.sequence,
            sentence: event.sentence,
            supportIds: event.supportIds,
            citedSegmentIds: event.citedSegmentIds,
            groundingValidated: event.groundingValidated
          });
          if (!optimized.ok) return;
          const text = requireSpokenProjection(optimized.spokenSentence);
          if (
            lastReleasedSentenceSequence !== undefined &&
            event.sequence <= lastReleasedSentenceSequence
          ) {
            logVoiceDebug("realtime_sentence_late_ignored", {
              turn_id: turn.sequence,
              sentence_index: event.sequence,
              last_released_sentence_index: lastReleasedSentenceSequence,
              terminal_reason: "non_monotonic_late_sentence"
            });
            return;
          }
          pendingSentences.set(event.sequence, {
            sequence: event.sequence,
            spokenSentence: text,
            supportIds: optimized.supportIds,
            safeForSpeech: true,
            source: "grounded_commit"
          });
          drainPendingSentences(false);
        }
      }), turn.abortController.signal);
      turn.providerGenerationCompleted = true;
      turn.stage = "sentence_commit";
      drainPendingSentences(true);
      this.markLatency(turn.latency, "qa_start");
      this.markLatency(turn.latency, "qa_complete");
      this.markLatency(turn.latency, "answer_ready");

      if (turn.interrupted || this.activeTurn !== turn) return;
      if (answer) {
        spokenText = requireSpokenProjection(
          optimizeVoiceResponse({
            responseMode: "VOICE",
            response: voiceResponseSourceFromQuestionAnswer(answer)
          }).spoken_text
        );
      } else {
        spokenText = requireSpokenProjection(REALTIME_FALLBACK_TEXT);
      }

      if (!turn.streamingTask) {
        this.startStreamingTts(turn, queue);
        queue.push({
          sequence: 1,
          spokenSentence: spokenText,
          supportIds: answer?.citedSegmentIds ?? [],
          safeForSpeech: true,
          source: "final_projection"
        });
        releasedSentences.push(spokenText);
      }
      queue.close();
      turn.stage = "tts";
      await turn.streamingTask;
      if (turn.interrupted || this.activeTurn !== turn) return;

      turn.stage = "finalization";
      this.emit({
        type: "answer",
        turnSequence: turn.sequence,
        transcript,
        text: releasedSentences.length > 0
          ? releasedSentences.join(" ")
          : spokenText,
        ...(answer ? { answer } : {})
      });
      if (answer) {
        this.conversation.push(
          { role: "user", content: transcript },
          { role: "assistant", content: answer.answer }
        );
        if (this.conversation.length > 8) {
          this.conversation.splice(0, this.conversation.length - 8);
        }
        await this.onTurnCompleted?.({ transcript, answer });
      }
      this.emit({
        type: "turn_state",
        turnSequence: turn.sequence,
        state: "listening"
      });
      this.transitionSession("listening");
      this.emitTurnTerminal(turn, "completed", {
        terminalReason: "completed"
      });
    } catch (error) {
      queue.fail(
        error instanceof Error ? error : new Error("Realtime Voice QA failed")
      );
      if (turn.interrupted || this.activeTurn !== turn) return;
      if (turn.timeoutTriggered) {
        await this.cancellingTurn?.catch(() => undefined);
      }
      if (error instanceof StreamingTtsError) turn.stage = "tts";
      const code = safeRealtimeErrorCode(error);
      this.emit({ type: "error", code });
      this.emit({
        type: "turn_state",
        turnSequence: turn.sequence,
        state: "listening"
      });
      this.transitionSession("listening");
      this.emitTurnTerminal(turn, "failed", {
        terminalReason: code,
        errorCode: code
      });
    }
  }

  private unsubscribeAll() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }
}
