import { VoiceEvent, type ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import { logVoiceDebug } from "@/lib/server/voice/debug";
import type {
  VoiceQaShadowReviewVoiceMetrics
} from "@/lib/server/evaluation/voice-qa-shadow-review";
import {
  safeElapsedMs,
  type QaExecutionDiagnostics
} from "@/lib/server/retrieval/qa-observability";
import type { QaAnswerStreamEvent } from "@/lib/server/retrieval/qa-streaming";
import type { VoiceQaShadowReviewContext } from "@/lib/server/retrieval/ai-qa";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceUnsubscribe
} from "@/lib/server/voice/types";
import { VoiceProviderError } from "@/lib/server/voice/types";
import {
  StreamingTtsError,
  streamTextToSpeech,
  type StreamingSpeechSentence,
  type StreamingTtsEvent
} from "@/lib/server/voice/streaming-tts";
import {
  requireSpokenProjection,
  SpokenProjectionError
} from "@/lib/server/voice/spoken-projection";

import {
  normalizeVoiceQaQuery,
  parseVoiceQaTranscriptUpdates
} from "./adapter";
import {
  VoiceErrorHandler,
  isVoiceConnectionLoss,
  type VoiceErrorCode
} from "./error-handler";
import {
  optimizeVoiceResponse,
  voiceResponseSourceFromQuestionAnswer
} from "./response-optimizer";
import {
  optimizeStreamingVoiceSentence
} from "./streaming-response-optimizer";
import {
  buildVoiceQaLatencyBreakdown,
  logVoiceQaBenchmark
} from "./qa-benchmark";
import type { VoiceSessionState } from "./session-manager";
import { VoiceQaSession } from "./session";
import type { VoiceSessionTraceRecorder } from "./trace";
import type {
  VoiceQaAnswerer,
  VoiceQaConversationMessage,
  VoiceQaError,
  VoiceQAResponse,
  VoiceQaResponseMode,
  VoiceQaSessionSnapshot,
  VoiceQaTranscriptUpdate
} from "./types";

export type VoiceQaStreamingOutputEvent =
  | ({ type: "speech_sentence" } & StreamingSpeechSentence)
  | StreamingTtsEvent
  | {
      type: "stream_error";
      code: "tts_failed";
      afterAudio: boolean;
    };

const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const DEFAULT_QA_TIMEOUT_MS = 60_000;
const MAX_STREAMING_TTS_FIRST_AUDIO_TIMEOUT_MS = 10_000;
const MAX_STREAMING_TTS_AUDIO_IDLE_TIMEOUT_MS = 5_000;
const MAX_STREAMING_TTS_HARD_SENTENCE_TIMEOUT_MS = 45_000;
const MAX_STREAMING_TTS_RECOVERY_MS = 12_000;
const ASR_FAILURE_TEXT = "无法识别，请再说一次";
const QA_FAILURE_TEXT = "暂时无法获取相关记录";

type ActiveTtsTurn = {
  chunks: Buffer[];
  promise: Promise<Buffer>;
  resolve: (audio: Buffer) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
  chatTtsStarted: boolean;
  activeChatStream?: ProviderTtsStream;
  observedStream?: ProviderTtsStream;
  questionId?: string;
  replyId?: string;
};

type ProviderTtsStream = {
  type: string;
  questionId?: string;
  replyId?: string;
};

type SentenceQueueWaiter = {
  resolve: (result: IteratorResult<StreamingSpeechSentence>) => void;
};

/**
 * Single-producer/single-consumer hand-off between QA sentence commit and TTS.
 * The producer never exposes provider token deltas: only the already validated
 * StreamingSpeechSentence projection can enter this queue.
 */
class StreamingSentenceQueue implements AsyncIterable<StreamingSpeechSentence> {
  private readonly items: StreamingSpeechSentence[] = [];
  private readonly waiters: SentenceQueueWaiter[] = [];
  private closed = false;

  push(sentence: StreamingSpeechSentence) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: sentence, done: false });
    } else {
      this.items.push(sentence);
    }
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.items.length === 0) {
      for (const waiter of this.waiters.splice(0)) {
        waiter.resolve({ value: undefined, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamingSpeechSentence> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<StreamingSpeechSentence>>((resolve) => {
          this.waiters.push({ resolve });
        });
      }
    };
  }
}

type LiveStreamingTtsResult = {
  audioChunkCount: number;
  error?: unknown;
};

type VoiceQaShadowReviewTurn = {
  responseBaselineAtMs: number;
  asrLatencyMs: number | null;
  retrievalCompletedAtMs: number | null;
  llmFirstTokenLatencyMs: number | null;
  firstPlayableSentenceLatencyMs: number | null;
  firstAudioLatencyMs: number | null;
  streamingComplete: boolean;
  ttsFailures: Set<string>;
};

function streamingTtsAllowsFullTextFallback(error: unknown) {
  return error instanceof StreamingTtsError && [
    "buffer_overflow",
    "empty_audio",
    "provider_failure",
    "protocol_error",
    "timeout"
  ].includes(error.code);
}

function ttsFailureReason(error: unknown) {
  if (error instanceof SpokenProjectionError) return error.reason;
  if (error instanceof StreamingTtsError) return error.code;
  if (error instanceof VoiceProviderError) return error.reason;
  return "unknown";
}

function ttsProviderResponseCategory(error: unknown) {
  if (error instanceof SpokenProjectionError) return "input_rejected";
  if (error instanceof StreamingTtsError) return "stream_failed";
  if (error instanceof VoiceProviderError) return "provider_rejected";
  return "unknown";
}

const EXACT_SESSION_EVENTS = new Set<number>([
  VoiceEvent.ASRResponse,
  VoiceEvent.ASREnded,
  VoiceEvent.TTSSentenceStart,
  VoiceEvent.TTSSentenceEnd,
  VoiceEvent.TTSResponse,
  VoiceEvent.TTSEnded
]);

export type VoiceQaBridgeOptions = {
  provider: VoiceProvider;
  answerer: VoiceQaAnswerer;
  userId?: string;
  scope?: "current" | "week" | "all";
  uploadId?: string;
  responseMode?: VoiceQaResponseMode;
  sessionConfig?: VoiceSessionConfig;
  ttsTimeoutMs?: number;
  qaTimeoutMs?: number;
  now?: () => Date;
  trace?: VoiceSessionTraceRecorder;
  applicationSessionId?: string;
  initialConversation?: VoiceQaConversationMessage[];
  onLifecycleStateChange?: (
    state: Extract<VoiceSessionState, "PROCESSING" | "RESPONDING" | "IDLE">
  ) => void | Promise<void>;
  onTurnCompleted?: (turn: {
    transcript: string;
    response: string;
    retrievedMemoryIds: string[];
  }) => void | Promise<void>;
  onStreamingEvent?: (event: VoiceQaStreamingOutputEvent) => void | Promise<void>;
  streamingSignal?: AbortSignal;
  errorHandler?: VoiceErrorHandler;
};

export type VoiceQaResponseListener = (response: VoiceQAResponse) => void;

function providerFailed(event: ParsedVoiceServerEvent) {
  return (
    event.errorCode !== undefined ||
    event.eventId === VoiceEvent.ConnectionFailed ||
    event.eventId === VoiceEvent.SessionFailed ||
    event.eventId === VoiceEvent.DialogCommonError
  );
}

function providerFailureError(event: ParsedVoiceServerEvent) {
  if (event.internalFailureReason) {
    return new VoiceProviderError(
      event.internalFailureReason,
      `Voice provider event ${event.eventName} failed`,
      event.errorCode
    );
  }
  return new VoiceProviderError(
    "provider_error",
    `Voice provider event ${event.eventName} failed`,
    event.errorCode
  );
}

function normalizedTranscriptCandidate(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function optionalNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerTtsStream(event: ParsedVoiceServerEvent): ProviderTtsStream | undefined {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  const type = optionalNonEmptyString(payload.tts_type);
  if (!type) return undefined;
  const questionId = optionalNonEmptyString(payload.question_id);
  const replyId = optionalNonEmptyString(payload.reply_id);
  return {
    type,
    ...(questionId ? { questionId } : {}),
    ...(replyId ? { replyId } : {})
  };
}

function sameProviderTtsStream(
  turn: Pick<ActiveTtsTurn, "questionId" | "replyId">,
  stream: Pick<ProviderTtsStream, "questionId" | "replyId">
) {
  if (turn.replyId && stream.replyId && turn.replyId !== stream.replyId) return false;
  if (turn.questionId && stream.questionId && turn.questionId !== stream.questionId) return false;
  return true;
}

function boundedTtsTimeout(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_TTS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new VoiceProviderError(
      "invalid_configuration",
      "Voice QA TTS timeout must be between 1000 and 300000ms"
    );
  }
  return timeoutMs;
}

function boundedQaTimeout(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_QA_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new VoiceProviderError(
      "invalid_configuration",
      "Voice QA timeout must be between 1000 and 300000ms"
    );
  }
  return timeoutMs;
}

function boundedInitialConversation(
  conversation: readonly VoiceQaConversationMessage[] | undefined
): VoiceQaConversationMessage[] {
  return (conversation ?? []).flatMap((message): VoiceQaConversationMessage[] => {
    const content = message.content.trim().replace(/\s+/gu, " ").slice(0, 1_200);
    return content ? [{ role: message.role, content }] : [];
  }).slice(-8);
}

const QA_TIMEOUT = Symbol("voice_qa_timeout");

async function withQaTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | typeof QA_TIMEOUT>([
      promise,
      new Promise<typeof QA_TIMEOUT>((resolve) => {
        timeout = setTimeout(() => resolve(QA_TIMEOUT), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withVoiceOperationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new VoiceProviderError("timeout", message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class VoiceQaBridge {
  private readonly provider: VoiceProvider;
  private readonly answerer: VoiceQaAnswerer;
  private readonly userId?: string;
  private readonly scope: "current" | "week" | "all";
  private readonly uploadId?: string;
  private readonly responseMode: VoiceQaResponseMode;
  private readonly sessionConfig: VoiceSessionConfig;
  private readonly ttsTimeoutMs: number;
  private readonly qaTimeoutMs: number;
  private readonly now?: () => Date;
  private readonly trace?: VoiceSessionTraceRecorder;
  private readonly applicationSessionId?: string;
  private readonly onLifecycleStateChange?: VoiceQaBridgeOptions["onLifecycleStateChange"];
  private readonly onTurnCompleted?: VoiceQaBridgeOptions["onTurnCompleted"];
  private readonly onStreamingEvent?: VoiceQaBridgeOptions["onStreamingEvent"];
  private readonly streamingSignal?: AbortSignal;
  private readonly errorHandler: VoiceErrorHandler;
  private readonly responseListeners = new Set<VoiceQaResponseListener>();
  private readonly conversation: VoiceQaConversationMessage[];
  private readonly unsubscribers: VoiceUnsubscribe[] = [];
  private readonly audioReplayChunks: Buffer[] = [];

  private session?: VoiceQaSession;
  private providerSessionId?: string;
  private started = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private abortPromise?: Promise<void>;
  private activeTts?: ActiveTtsTurn;
  private autonomousTtsActive = false;
  private readonly autonomousTtsIdleWaiters = new Set<() => void>();
  private bufferedTranscript?: string;
  private bufferedTranscriptIsFinal = false;
  private asrTurnActive = false;
  private asrTurnHadFinal = false;
  private audioInputFinished = false;
  private shadowReviewSpeechEndedAtMs: number | null = null;
  private activeShadowReviewTurn?: VoiceQaShadowReviewTurn;
  private turnTail: Promise<void> = Promise.resolve();
  private reconnectPromise?: Promise<boolean>;

  constructor(options: VoiceQaBridgeOptions) {
    this.provider = options.provider;
    this.answerer = options.answerer;
    this.userId = options.userId?.trim() || undefined;
    this.scope = options.scope ?? "all";
    this.uploadId = options.uploadId?.trim() || undefined;
    this.responseMode = options.responseMode ?? "VOICE";
    this.sessionConfig = {
      inputMode: "server_vad",
      ...options.sessionConfig
    };
    this.ttsTimeoutMs = boundedTtsTimeout(options.ttsTimeoutMs);
    this.qaTimeoutMs = boundedQaTimeout(options.qaTimeoutMs);
    this.now = options.now;
    this.trace = options.trace;
    this.applicationSessionId = options.applicationSessionId?.trim() || undefined;
    this.conversation = boundedInitialConversation(options.initialConversation);
    this.onLifecycleStateChange = options.onLifecycleStateChange;
    this.onTurnCompleted = options.onTurnCompleted;
    this.onStreamingEvent = options.onStreamingEvent;
    this.streamingSignal = options.streamingSignal;
    this.errorHandler = options.errorHandler ?? new VoiceErrorHandler();
  }

  async start(): Promise<VoiceQaSessionSnapshot> {
    if (this.started) {
      throw new VoiceProviderError("invalid_state", "Voice QA bridge has already started");
    }
    this.started = true;
    this.unsubscribers.push(
      this.provider.onEvent((event) => this.handleProviderEvent(event))
    );
    try {
      await this.provider.connect();
      const info = await this.provider.startSession(this.sessionConfig);
      this.providerSessionId = info.sessionId;
      this.session = new VoiceQaSession({
        id: info.sessionId,
        ...(this.userId ? { userId: this.userId } : {}),
        ...(this.now ? { now: this.now } : {})
      });
      this.trace?.setProviderSessionId(info.sessionId);
      return this.session.snapshot();
    } catch (error) {
      this.unsubscribeAll();
      await this.provider.close().catch(() => undefined);
      this.started = false;
      throw error;
    }
  }

  snapshot(): VoiceQaSessionSnapshot {
    return this.requireSession().snapshot();
  }

  onResponse(listener: VoiceQaResponseListener): VoiceUnsubscribe {
    this.responseListeners.add(listener);
    return () => this.responseListeners.delete(listener);
  }

  async sendAudio(chunk: Buffer) {
    if (this.closing) {
      throw new VoiceProviderError("invalid_state", "Voice QA bridge is closing");
    }
    if (this.sessionConfig.inputMode === "text") {
      throw new VoiceProviderError("invalid_state", "Voice QA text sessions do not accept audio");
    }
    const session = this.requireOpenSession();
    if (session.state === "idle") {
      session.transition("listening");
      this.resetAsrTurn();
      this.asrTurnActive = true;
    } else if (session.state !== "listening") {
      throw new VoiceProviderError(
        "invalid_state",
        `Voice QA cannot accept audio while ${session.state}`
      );
    }
    this.audioReplayChunks.push(Buffer.from(chunk));
    try {
      await this.provider.sendAudio(chunk);
    } catch (error) {
      if (this.closing) return;
      const connectionLost = isVoiceConnectionLoss(error) || Boolean(this.reconnectPromise);
      if (connectionLost) {
        if (await this.recoverProviderConnection(true)) return;
        await this.enqueueConnectionFailure();
      } else {
        await this.enqueueAsrFailure();
      }
    }
  }

  async finishAudioInput() {
    if (this.closing) {
      throw new VoiceProviderError("invalid_state", "Voice QA bridge is closing");
    }
    if (this.sessionConfig.inputMode !== "push_to_talk") {
      throw new VoiceProviderError(
        "invalid_state",
        "Voice QA audio input can only be explicitly finished in push-to-talk mode"
      );
    }
    const session = this.requireOpenSession();
    if (session.state !== "listening") {
      throw new VoiceProviderError(
        "invalid_state",
        `Voice QA cannot finish audio input while ${session.state}`
      );
    }
    if (this.audioInputFinished) return;
    this.audioInputFinished = true;
    this.shadowReviewSpeechEndedAtMs = performance.now();

    try {
      await this.provider.finishAudioInput();
      logVoiceDebug("audio_input_finished", {
        input_mode: "push_to_talk",
        recovered: false
      });
    } catch (error) {
      if (this.closing) return;
      const connectionLost = isVoiceConnectionLoss(error) || Boolean(this.reconnectPromise);
      if (!connectionLost || !await this.recoverProviderConnection(true)) throw error;
      await this.provider.finishAudioInput();
      logVoiceDebug("audio_input_finished", {
        input_mode: "push_to_talk",
        recovered: true
      });
    }
  }

  async handleAsrTimeout(): Promise<VoiceQAResponse | null> {
    if (this.closing || this.asrTurnHadFinal) return null;
    const session = this.requireOpenSession();
    if (session.state !== "listening") return null;
    const decision = this.errorHandler.asrTimeout();
    this.trace?.recordFailure("asr", "asr_timeout");
    this.asrTurnActive = false;
    this.asrTurnHadFinal = true;
    this.bufferedTranscript = undefined;
    this.bufferedTranscriptIsFinal = false;
    logVoiceDebug("asr_timeout_fallback", {
      asr_ended_received: false,
      tts_attempted: false
    });
    return this.enqueueTurn(() => this.speakFallback(
      "",
      decision.message,
      ["asr_failed"],
      [decision.code],
      false
    ));
  }

  async acceptTranscript(update: VoiceQaTranscriptUpdate): Promise<VoiceQAResponse | null> {
    if (this.closing) return null;
    const session = this.requireOpenSession();
    if (update.sessionId && update.sessionId !== this.providerSessionId) return null;
    if (session.state === "thinking" || session.state === "speaking") return null;

    const candidate = normalizedTranscriptCandidate(update.transcript);
    if (update.finality !== "final") {
      if (!candidate) return null;
      this.trace?.mark("asr_first_partial");
      if (session.state === "idle") {
        session.transition("listening");
        this.resetAsrTurn();
      }
      this.asrTurnActive = true;
      if (!this.bufferedTranscriptIsFinal) {
        this.bufferedTranscript = candidate;
        this.bufferedTranscriptIsFinal = false;
      }
      return null;
    }

    if (!candidate) {
      return this.enqueueAsrFailure();
    }
    const transcript = normalizeVoiceQaQuery(candidate);
    if (!transcript) {
      return this.enqueueAsrFailure();
    }
    if (this.asrTurnHadFinal) {
      return null;
    }
    this.asrTurnActive = true;
    this.asrTurnHadFinal = true;
    this.trace?.mark("asr_final_received");
    const shadowReviewTurn = this.beginShadowReviewTurn();
    logVoiceDebug("asr_final_received", { has_transcript: true });
    this.bufferedTranscript = undefined;
    this.bufferedTranscriptIsFinal = false;
    return this.enqueueTurn(() => this.answerAndSpeak(transcript, shadowReviewTurn));
  }

  async submitTextQuery(transcript: string): Promise<VoiceQAResponse> {
    if (this.closing) {
      throw new VoiceProviderError("invalid_state", "Voice QA bridge is closing");
    }
    const session = this.requireOpenSession();
    if (session.state !== "idle") {
      throw new VoiceProviderError(
        "invalid_state",
        `Voice QA cannot submit a text query while ${session.state}`
      );
    }
    this.resetAsrTurn();
    const response = await this.acceptTranscript({
      transcript,
      finality: "final",
      sessionId: this.requireProviderSessionId()
    });
    if (!response) {
      throw new VoiceProviderError("invalid_request", "Voice QA text query did not produce a response");
    }
    return response;
  }

  async waitForIdle() {
    await this.turnTail;
  }

  async close() {
    if (!this.started) return;
    if (this.abortPromise) return this.abortPromise;
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const frozenTail = this.turnTail;
    this.rejectActiveTts(new VoiceProviderError("connection_closed", "Voice QA bridge is closing"));
    this.closePromise = (async () => {
      await frozenTail.catch(() => undefined);
      if (this.abortPromise) {
        await this.abortPromise;
        return;
      }
      const session = this.session;
      if (session && session.state !== "closed") {
        await this.provider.finishSession().catch(() => undefined);
        await this.provider.close().catch(() => undefined);
        session.transition("closed");
      } else {
        await this.provider.close().catch(() => undefined);
      }
      this.unsubscribeAll();
      this.responseListeners.clear();
    })();
    return this.closePromise;
  }

  /**
   * Immediately detaches the bridge without draining an in-flight QA turn.
   * Provider cleanup continues in the background; the detached turn remains
   * rejection-observed and cannot publish after the session is closed.
   */
  async abort() {
    if (!this.started) return;
    if (this.abortPromise) return this.abortPromise;
    this.closing = true;
    this.rejectActiveTts(new VoiceProviderError(
      "connection_closed",
      "Voice QA bridge was aborted"
    ));
    void this.turnTail.catch(() => undefined);
    this.abortPromise = (async () => {
      // Volcengine's graceful close can wait for a provider event. Start that
      // bounded cleanup, but do not let it extend an HTTP/request abort path.
      try {
        void this.provider.close().catch(() => undefined);
      } catch {
        // A synchronous adapter failure must not prevent local cancellation.
      }
      const session = this.session;
      if (session && session.state !== "closed") session.transition("closed");
      this.unsubscribeAll();
      this.responseListeners.clear();
    })();
    return this.abortPromise;
  }

  private handleProviderEvent(event: ParsedVoiceServerEvent) {
    const session = this.session;
    if (!session || session.state === "closed") return;
    if (event.sessionId && event.sessionId !== this.providerSessionId) return;
    if (EXACT_SESSION_EVENTS.has(event.eventId) && event.sessionId !== this.providerSessionId) return;

    if (event.eventId === VoiceEvent.TTSSentenceStart) {
      const stream = providerTtsStream(event);
      const turn = this.activeTts;
      if (!stream) return;
      if (stream.type !== "chat_tts_text") {
        this.setAutonomousTtsActive(true);
      } else if (this.autonomousTtsActive) {
        this.setAutonomousTtsActive(false);
      }
      if (!turn) return;
      turn.observedStream = stream;
      if (stream.type !== "chat_tts_text") return;
      if (turn.chatTtsStarted && !sameProviderTtsStream(turn, stream)) return;
      turn.chatTtsStarted = true;
      turn.activeChatStream ??= stream;
      turn.questionId ??= stream.questionId;
      turn.replyId ??= stream.replyId;
      return;
    }

    if (event.eventId === VoiceEvent.TTSResponse) {
      const turn = this.activeTts;
      const stream = turn?.observedStream ?? turn?.activeChatStream;
      if (
        turn &&
        turn.chatTtsStarted &&
        stream?.type === "chat_tts_text" &&
        sameProviderTtsStream(turn, stream) &&
        event.audio &&
        event.audio.byteLength > 0
      ) {
        this.markShadowReviewFirstAudio();
        turn.chunks.push(Buffer.from(event.audio));
      }
      return;
    }

    if (
      event.eventId === VoiceEvent.TTSSentenceEnd ||
      event.eventId === VoiceEvent.TTSEnded
    ) {
      const turn = this.activeTts;
      const explicitTerminalStream = providerTtsStream(event);
      if (
        explicitTerminalStream?.type === "default" ||
        (!explicitTerminalStream && this.autonomousTtsActive && !turn?.chatTtsStarted)
      ) {
        this.setAutonomousTtsActive(false);
      }
      if (!turn) return;
      const terminalStream = explicitTerminalStream ?? turn.observedStream;
      if (terminalStream && terminalStream.type !== "chat_tts_text") {
        turn.observedStream = undefined;
        return;
      }
      const stream = terminalStream ?? turn.activeChatStream;
      if (
        stream?.type === "chat_tts_text" &&
        turn.chatTtsStarted &&
        sameProviderTtsStream(turn, stream)
      ) {
        this.resolveActiveTts();
      }
      return;
    }

    if (providerFailed(event)) {
      const failure = providerFailureError(event);
      this.rejectActiveTts(failure);
      if (!this.closing && session.state === "listening" && this.asrTurnActive) {
        if (isVoiceConnectionLoss(failure)) {
          void this.recoverProviderConnection(true).then((recovered) => {
            if (!recovered) {
              void this.enqueueConnectionFailure().catch(() => undefined);
            }
          });
        } else {
          void this.enqueueAsrFailure().catch(() => undefined);
        }
      }
      return;
    }

    if (this.closing) return;

    if (event.eventId === VoiceEvent.ASRResponse) {
      const updates = parseVoiceQaTranscriptUpdates(event, this.providerSessionId);
      const finalCount = updates.filter((update) => update.finality === "final").length;
      logVoiceDebug("asr_message", {
        result_count: updates.length,
        final_count: finalCount,
        partial_count: updates.length - finalCount
      });
      const latestFinal = [...updates].reverse().find((update) => update.finality === "final");
      const selected = latestFinal ?? updates.at(-1);
      if (selected && session.state !== "thinking" && session.state !== "speaking") {
        const candidate = normalizedTranscriptCandidate(selected.transcript);
        if (!candidate) return;
        if (session.state === "idle") {
          session.transition("listening");
          this.resetAsrTurn();
        }
        if (session.state !== "listening") return;
        this.asrTurnActive = true;
        if (selected.finality !== "final") {
          this.trace?.mark("asr_first_partial");
        }
        if (selected.finality === "final" || !this.bufferedTranscriptIsFinal) {
          this.bufferedTranscript = candidate;
          this.bufferedTranscriptIsFinal = selected.finality === "final";
        }
      }
      return;
    }

    if (event.eventId === VoiceEvent.ASREnded) {
      if (!this.asrTurnHadFinal && this.bufferedTranscript) {
        const transcript = this.bufferedTranscript;
        this.bufferedTranscript = undefined;
        void this.acceptTranscript({
          transcript,
          finality: "final",
          sessionId: this.requireProviderSessionId()
        }).catch(() => undefined);
      } else if (this.asrTurnActive && !this.asrTurnHadFinal && !this.bufferedTranscript) {
        void this.enqueueAsrFailure().catch(() => undefined);
      }
      return;
    }

  }

  private enqueueAsrFailure() {
    this.trace?.recordFailure("asr", "asr_failed");
    this.asrTurnActive = false;
    this.asrTurnHadFinal = true;
    this.bufferedTranscript = undefined;
    this.bufferedTranscriptIsFinal = false;
    return this.enqueueTurn(() => this.speakFallback("", ASR_FAILURE_TEXT, ["asr_failed"]));
  }

  private enqueueConnectionFailure() {
    const decision = this.errorHandler.connectionLost();
    this.trace?.recordFailure("session", "connection_lost");
    this.asrTurnActive = false;
    this.asrTurnHadFinal = true;
    this.bufferedTranscript = undefined;
    this.bufferedTranscriptIsFinal = false;
    return this.enqueueTurn(() => this.speakFallback(
      "",
      decision.message,
      ["connection_lost"],
      [decision.code],
      false
    ));
  }

  private enqueueTurn(task: () => Promise<VoiceQAResponse>) {
    const run = this.turnTail.then(task);
    this.turnTail = run.then(() => undefined, () => undefined);
    void run.then((response) => this.notifyResponse(response), () => undefined);
    return run;
  }

  private async answerAndSpeak(
    transcript: string,
    shadowReviewTurn: VoiceQaShadowReviewTurn
  ): Promise<VoiceQAResponse> {
    const session = this.requireOpenSession();
    const voiceSessionId = this.applicationSessionId ?? session.id;
    const traceId = this.trace?.sessionId;
    const shadowReviewContext: VoiceQaShadowReviewContext | undefined = traceId
      ? { voiceSessionId, traceId }
      : undefined;
    this.activeShadowReviewTurn = shadowReviewTurn;
    try {
      return await this.answerAndSpeakTurn(transcript, shadowReviewContext);
    } finally {
      this.trace?.mark("voice_response_complete");
      const metrics = this.completeShadowReviewTurn(shadowReviewTurn);
      if (this.activeShadowReviewTurn === shadowReviewTurn) {
        this.activeShadowReviewTurn = undefined;
      }
      this.recordShadowReviewVoiceOutcome(shadowReviewContext, metrics);
    }
  }

  private async answerAndSpeakTurn(
    transcript: string,
    shadowReviewContext: VoiceQaShadowReviewContext | undefined
  ): Promise<VoiceQAResponse> {
    const session = this.requireOpenSession();
    if (session.state === "listening" || session.state === "idle") {
      session.transition("thinking");
    } else {
      throw new VoiceProviderError("invalid_state", `Voice QA cannot think while ${session.state}`);
    }

    if (this.onLifecycleStateChange) await this.updateLifecycleState("PROCESSING");
    let answer;
    let qaCompleted = false;
    let qaBenchmarkRecorded = false;
    let qaFailure: {
      text: string;
      errors: VoiceQaError[];
      errorCodes: VoiceErrorCode[];
    } | undefined;
    let qaDiagnostics: QaExecutionDiagnostics | undefined;
    const retrievedMemoryIds: string[] = [];
    const liveSpokenSentences: string[] = [];
    let acceptingLiveSentences = true;
    let liveSentenceQueue: StreamingSentenceQueue | undefined;
    let liveStreamingTask: Promise<LiveStreamingTtsResult> | undefined;

    const ensureLiveStreaming = async () => {
      if (liveSentenceQueue) return liveSentenceQueue;
      const queue = new StreamingSentenceQueue();
      liveSentenceQueue = queue;
      this.trace?.mark("first_safe_sentence");
      this.markShadowReviewFirstPlayableSentence();
      if (session.state !== "thinking") {
        throw new VoiceProviderError(
          "invalid_state",
          `Voice QA cannot begin streaming speech while ${session.state}`
        );
      }
      session.transition("speaking");
      if (this.onLifecycleStateChange) await this.updateLifecycleState("RESPONDING");
      this.trace?.mark("tts_started");
      this.trace?.mark("tts_stream_started");
      logVoiceDebug("tts_stream_started", { early_commit: acceptingLiveSentences });
      liveStreamingTask = this.consumeLiveStreamingTts(queue);
      return queue;
    };

    const acceptCommittedSentence = async (
      event: Extract<QaAnswerStreamEvent, { type: "sentence_completed" }>
    ) => {
      if (!acceptingLiveSentences || !this.onStreamingEvent) return;
      this.trace?.mark("first_sentence_committed");
      const optimized = optimizeStreamingVoiceSentence({
        sequence: event.sequence,
        sentence: event.sentence,
        supportIds: event.supportIds,
        citedSegmentIds: Array.isArray(event.citedSegmentIds)
          ? event.citedSegmentIds
          : [],
        groundingValidated: event.groundingValidated
      });
      if (!optimized.ok) return;
      try {
        requireSpokenProjection(optimized.spokenSentence);
      } catch (error) {
        logVoiceDebug("tts_sentence_rejected", {
          text_length: optimized.spokenSentence.length,
          sentence_index: optimized.sequence,
          provider_response_category: "input_rejected",
          failure_reason: ttsFailureReason(error)
        });
        return;
      }

      const queue = await ensureLiveStreaming();

      try {
        await this.onStreamingEvent({ type: "speech_sentence", ...optimized });
      } catch {
        acceptingLiveSentences = false;
        queue.close();
        return;
      }
      liveSpokenSentences.push(optimized.spokenSentence);
      queue.push({
        ...optimized,
        source: "grounded_commit"
      });
    };

    const acceptFinalProjection = async (
      finalText: string,
      supportIds: readonly string[]
    ) => {
      if (!this.onStreamingEvent || liveStreamingTask) return false;
      let spokenSentence: string;
      try {
        spokenSentence = requireSpokenProjection(finalText);
      } catch (error) {
        logVoiceDebug("tts_sentence_rejected", {
          text_length: finalText.length,
          sentence_index: 1,
          provider_response_category: "final_projection_rejected",
          failure_reason: ttsFailureReason(error)
        });
        return false;
      }
      const queue = await ensureLiveStreaming();
      const sentence: StreamingSpeechSentence = {
        sequence: 1,
        spokenSentence,
        supportIds: [...new Set(supportIds)],
        safeForSpeech: true,
        source: "final_projection"
      };
      try {
        await this.onStreamingEvent({ type: "speech_sentence", ...sentence });
      } catch {
        queue.close();
        return false;
      }
      liveSpokenSentences.push(spokenSentence);
      queue.push(sentence);
      queue.close();
      return true;
    };

    this.trace?.mark("voice_question_received");
    this.trace?.mark("qa_started");
    const qaStartedAt = performance.now();
    logVoiceDebug("qa_started", { conversation_messages: this.conversation.length });
    try {
      const voiceSessionId = this.applicationSessionId ?? session.id;
      const traceId = shadowReviewContext?.traceId;
      const answerPromise = this.answerer.answer({
        sessionId: voiceSessionId,
        transcript,
        ...(this.userId ? { userId: this.userId } : {}),
        scope: this.scope,
        ...(this.uploadId ? { uploadId: this.uploadId } : {}),
        mode: this.responseMode,
        ...(traceId ? { traceId } : {}),
        ...(shadowReviewContext ? { shadowReviewContext } : {}),
        onRetrievedMemoryIds: (memoryIds) => {
          retrievedMemoryIds.splice(0, retrievedMemoryIds.length, ...new Set(memoryIds));
        },
        onQaDiagnostics: (diagnostics) => {
          qaDiagnostics = diagnostics;
        },
        onQaMilestone: (milestone) => {
          if (milestone === "retrieval_complete") {
            this.trace?.mark("retrieval_complete");
            this.markShadowReviewRetrievalComplete();
          } else if (milestone === "llm_first_token") {
            this.trace?.mark("llm_first_token");
            this.markShadowReviewLlmFirstToken();
          }
        },
        ...(this.onStreamingEvent ? {
          onQaStreamEvent: (event: Extract<
            QaAnswerStreamEvent,
            { type: "sentence_completed" | "final" }
          >) => {
            if (event.type === "sentence_completed") {
              return acceptCommittedSentence(event);
            }
            if (event.source === "provider_stream") {
              this.trace?.mark("qa_provider_stream_complete");
            }
            return undefined;
          }
        } : {}),
        ...(this.conversation.length > 0 ? { conversation: [...this.conversation] } : {})
      });
      void answerPromise.catch(() => undefined);
      const result = await withQaTimeout(answerPromise, this.qaTimeoutMs);
      if (result === QA_TIMEOUT) {
        this.trace?.recordFailure("qa", "qa_timeout");
        logVoiceDebug("qa_timeout", {
          elapsed_ms: Math.max(0, Math.round(performance.now() - qaStartedAt))
        });
        const benchmarkInput = {
          sessionId: this.trace?.sessionId ?? this.applicationSessionId ?? session.id,
          answerMode: qaDiagnostics?.answerMode ?? this.answerer.answerMode ?? "agent" as const,
          ...(qaDiagnostics ? { diagnostics: qaDiagnostics } : {}),
          responseOptimizationMs: null,
          totalLatencyMs: safeElapsedMs(qaStartedAt),
          responseLength: 0
        };
        this.trace?.recordQaBreakdown?.(buildVoiceQaLatencyBreakdown(benchmarkInput));
        logVoiceQaBenchmark(benchmarkInput);
        qaBenchmarkRecorded = true;
        const decision = this.errorHandler.qaTimeout(this.conversation.length > 0);
        qaFailure = {
          text: decision.message,
          errors: ["qa_failed"],
          errorCodes: [decision.code]
        };
      } else {
        answer = result;
        qaCompleted = true;
      }
    } catch {
      qaCompleted = true;
      this.trace?.recordFailure("qa", "qa_failed");
      qaFailure = {
        text: QA_FAILURE_TEXT,
        errors: ["qa_failed"],
        errorCodes: []
      };
    } finally {
      acceptingLiveSentences = false;
      liveSentenceQueue?.close();
      if (qaCompleted) this.trace?.mark("qa_completed");
      if (qaCompleted) {
        logVoiceDebug("qa_completed", {
          elapsed_ms: Math.max(0, Math.round(performance.now() - qaStartedAt)),
          success: Boolean(answer)
        });
      }
    }

    if (!answer) {
      const benchmarkInput = {
        sessionId: this.trace?.sessionId ?? this.applicationSessionId ?? session.id,
        answerMode: qaDiagnostics?.answerMode ?? this.answerer.answerMode ?? "agent" as const,
        ...(qaDiagnostics ? { diagnostics: qaDiagnostics } : {}),
        responseOptimizationMs: null,
        totalLatencyMs: safeElapsedMs(qaStartedAt),
        responseLength: 0
      };
      if (!qaBenchmarkRecorded) {
        this.trace?.recordQaBreakdown?.(buildVoiceQaLatencyBreakdown(benchmarkInput));
        logVoiceQaBenchmark(benchmarkInput);
      }
      this.trace?.recordFailure("qa", "qa_failed");
      const fallbackText = qaFailure?.text ?? QA_FAILURE_TEXT;
      if (await acceptFinalProjection(fallbackText, [])) {
        const liveResult = await liveStreamingTask!;
        return this.finishLiveStreamingResponse({
          transcript,
          text: fallbackText,
          streamResult: liveResult,
          errors: qaFailure?.errors ?? ["qa_failed"],
          errorCodes: qaFailure?.errorCodes ?? []
        });
      }
      if (liveStreamingTask) {
        const liveResult = await liveStreamingTask;
        return this.finishLiveStreamingResponse({
          transcript,
          text: liveResult.audioChunkCount > 0 && liveSpokenSentences.length > 0
            ? liveSpokenSentences.join(" ")
            : fallbackText,
          streamResult: liveResult,
          errors: qaFailure?.errors ?? ["qa_failed"],
          errorCodes: qaFailure?.errorCodes ?? []
        });
      }
      return this.speakFallback(
        transcript,
        fallbackText,
        qaFailure?.errors ?? ["qa_failed"],
        qaFailure?.errorCodes ?? []
      );
    }

    const optimizerStartedAt = performance.now();
    const optimized = optimizeVoiceResponse({
      responseMode: this.responseMode,
      response: voiceResponseSourceFromQuestionAnswer(answer)
    });
    const responseOptimizationMs = safeElapsedMs(optimizerStartedAt);
    const text = optimized.spoken_text;
    const benchmarkInput = {
      sessionId: this.trace?.sessionId ?? this.applicationSessionId ?? session.id,
      answerMode: qaDiagnostics?.answerMode ?? this.answerer.answerMode ?? "agent" as const,
      ...(qaDiagnostics ? { diagnostics: qaDiagnostics } : {}),
      responseOptimizationMs,
      totalLatencyMs: safeElapsedMs(qaStartedAt),
      responseLength: text.length
    };
    this.trace?.recordQaBreakdown?.(buildVoiceQaLatencyBreakdown(benchmarkInput));
    logVoiceQaBenchmark(benchmarkInput);
    this.conversation.push(
      { role: "user", content: transcript },
      { role: "assistant", content: answer.answer }
    );
    if (this.conversation.length > 8) {
      this.conversation.splice(0, this.conversation.length - 8);
    }
    if (this.onTurnCompleted) {
      await this.onTurnCompleted({
        transcript,
        response: answer.answer,
        retrievedMemoryIds: [...retrievedMemoryIds]
      });
    }
    await acceptFinalProjection(text, answer.citedSegmentIds);
    if (liveStreamingTask) {
      const liveResult = await liveStreamingTask;
      return this.finishLiveStreamingResponse({
        transcript,
        // The response text mirrors what was actually released to speech. If a
        // later suffix is quarantined, never claim that the withheld suffix was
        // played and never replay a conflicting full-answer fallback. Before
        // the first audio chunk, however, the established full validated answer
        // remains the safe fallback because no prefix reached the listener.
        text:
          liveResult.error && liveResult.audioChunkCount === 0
            ? text
            : liveSpokenSentences.length > 0
              ? liveSpokenSentences.join(" ")
              : text,
        answer,
        streamResult: liveResult,
        errors: [],
        errorCodes: []
      });
    }
    return this.speakResponse({ transcript, text, answer, errors: [] });
  }

  private recordShadowReviewVoiceOutcome(
    context: VoiceQaShadowReviewContext | undefined,
    metrics: VoiceQaShadowReviewVoiceMetrics
  ) {
    if (!context?.caseId || !this.userId) return;
    const caseId = context.caseId;
    const userId = this.userId;
    void import("@/lib/server/evaluation/voice-qa-shadow-review")
      .then(({ recordVoiceQaShadowReviewVoiceOutcome }) =>
        recordVoiceQaShadowReviewVoiceOutcome({
          caseId,
          userId,
          traceId: context.traceId,
          metrics
        })
      )
      .catch((error: unknown) => {
        console.warn(
          `[voice-qa-shadow-review] case_id=${caseId} ` +
          `scope=${this.scope} status=fallback ` +
          "fallback_reason=voice_outcome_persistence_failed " +
          `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      });
  }

  private async consumeLiveStreamingTts(
    sentences: AsyncIterable<StreamingSpeechSentence>
  ): Promise<LiveStreamingTtsResult> {
    let audioChunkCount = 0;
    const ttsStartedAt = performance.now();
    try {
      await this.prepareProviderForCanonicalTts();
      for await (const event of streamTextToSpeech(sentences, {
        provider: this.provider,
        sessionId: this.requireProviderSessionId(),
        ...(this.streamingSignal ? { signal: this.streamingSignal } : {}),
        firstAudioTimeoutMs: Math.min(
          this.ttsTimeoutMs,
          MAX_STREAMING_TTS_FIRST_AUDIO_TIMEOUT_MS
        ),
        audioIdleTimeoutMs: Math.min(
          this.ttsTimeoutMs,
          MAX_STREAMING_TTS_AUDIO_IDLE_TIMEOUT_MS
        ),
        hardSentenceTimeoutMs: Math.min(
          this.ttsTimeoutMs,
          MAX_STREAMING_TTS_HARD_SENTENCE_TIMEOUT_MS
        ),
        onTtsRequestStart: () => {
          this.trace?.mark("tts_request_start");
        }
      })) {
        if (event.type === "audio_chunk") {
          const firstAudioChunk = audioChunkCount === 0;
          audioChunkCount += 1;
          this.trace?.mark("first_audio_chunk_received");
          this.markShadowReviewFirstAudio();
          // Persistence starts synchronously inside mark(), but no audio chunk
          // waits for JsonStore I/O. If browser telemetry wins the race, its
          // bounded 409 retry observes the queued first-chunk checkpoint.
          if (firstAudioChunk) void this.trace?.flush();
        }
        if (event.type === "stream_completed") {
          this.trace?.mark("tts_stream_complete");
          this.markShadowReviewStreamingComplete();
        }
        await this.onStreamingEvent?.(event);
      }
      logVoiceDebug("tts_stream_completed", {
        elapsed_ms: Math.max(0, Math.round(performance.now() - ttsStartedAt)),
        audio_chunk_count: audioChunkCount
      });
      return { audioChunkCount };
    } catch (error) {
      const afterAudio = audioChunkCount > 0;
      this.trace?.recordFailure("tts", "tts_failed");
      this.markShadowReviewTtsFailure("tts_failed");
      if (afterAudio) this.trace?.mark("tts_partial_audio_failure");
      logVoiceDebug("tts_stream_failed", {
        elapsed_ms: Math.max(0, Math.round(performance.now() - ttsStartedAt)),
        after_audio: afterAudio,
        error_code: error instanceof StreamingTtsError ? error.code : "unknown"
      });
      try {
        await this.onStreamingEvent?.({
          type: "stream_error",
          code: "tts_failed",
          afterAudio
        });
      } catch {
        // Streaming transport diagnostics must not prevent the established
        // pre-audio fallback or turn-state cleanup.
      }
      return { audioChunkCount, error };
    }
  }

  private async finishLiveStreamingResponse(input: {
    transcript: string;
    text: string;
    answer?: VoiceQAResponse["answer"];
    streamResult: LiveStreamingTtsResult;
    errors: VoiceQaError[];
    errorCodes: VoiceErrorCode[];
  }): Promise<VoiceQAResponse> {
    const session = this.requireOpenSession();
    if (session.state !== "speaking") {
      throw new VoiceProviderError(
        "invalid_state",
        `Voice QA cannot finish streaming speech while ${session.state}`
      );
    }

    let fallbackAudio: Buffer | undefined;
    const errors = [...input.errors];
    const errorCodes = [...input.errorCodes];
    try {
      if (
        input.streamResult.error &&
        input.streamResult.audioChunkCount === 0 &&
        !this.streamingSignal?.aborted
      ) {
        if (streamingTtsAllowsFullTextFallback(input.streamResult.error)) {
          try {
            fallbackAudio = await this.recoverStreamingTtsWithoutAudio(input.text);
            this.trace?.mark("fallback_audio_complete");
          } catch (error) {
            errors.push("tts_failed");
            errorCodes.push(this.errorHandler.ttsFailed(input.text).code);
            logVoiceDebug("tts_fallback_failed", {
              text_length: input.text.length,
              sentence_index: 1,
              provider_response_category: ttsProviderResponseCategory(error),
              failure_reason: ttsFailureReason(error)
            });
          }
        } else {
          errors.push("tts_failed");
          errorCodes.push(this.errorHandler.ttsFailed(input.text).code);
          logVoiceDebug("tts_fallback_skipped", {
            text_length: input.text.length,
            sentence_index: 1,
            provider_response_category: "stream_failed",
            failure_reason: ttsFailureReason(input.streamResult.error)
          });
        }
      } else if (input.streamResult.error) {
        errors.push("tts_failed");
        errorCodes.push(this.errorHandler.ttsFailed(input.text).code);
      }
    } finally {
      session.transition("idle");
      if (this.onLifecycleStateChange) await this.updateLifecycleState("IDLE");
    }

    return {
      sessionId: session.id,
      transcript: input.transcript,
      mode: this.responseMode,
      text: input.text,
      ...(input.answer ? { answer: input.answer } : {}),
      ...(fallbackAudio ? { audio: fallbackAudio } : {}),
      ...(input.streamResult.audioChunkCount > 0 ? { streamedAudio: true } : {}),
      ...(errors.length > 0 ? { errors: [...new Set(errors)] } : {}),
      ...(errorCodes.length > 0 ? { errorCodes: [...new Set(errorCodes)] } : {})
    };
  }

  private async speakFallback(
    transcript: string,
    text: string,
    errors: VoiceQaError[],
    errorCodes: VoiceErrorCode[] = [],
    synthesize = true
  ) {
    if (this.onLifecycleStateChange) await this.updateLifecycleState("PROCESSING");
    return this.speakResponse({ transcript, text, errors, errorCodes, synthesize });
  }

  private async speakResponse(input: {
    transcript: string;
    text: string;
    answer?: VoiceQAResponse["answer"];
    errors: VoiceQaError[];
    errorCodes?: VoiceErrorCode[];
    synthesize?: boolean;
  }): Promise<VoiceQAResponse> {
    const session = this.requireOpenSession();
    if (session.state === "thinking") {
      session.transition("speaking");
    } else if (session.state === "idle" || session.state === "listening") {
      session.transition("thinking");
      session.transition("speaking");
    } else {
      throw new VoiceProviderError("invalid_state", `Voice QA cannot speak while ${session.state}`);
    }

    if (this.onLifecycleStateChange) await this.updateLifecycleState("RESPONDING");
    let audio: Buffer | undefined;
    const errors = [...input.errors];
    const errorCodes = [...(input.errorCodes ?? [])];
    if (input.synthesize !== false) {
      this.trace?.mark("tts_started");
      this.markShadowReviewFirstPlayableSentence();
    }
    const ttsStartedAt = performance.now();
    if (input.synthesize !== false) logVoiceDebug("tts_started");
    try {
      if (input.synthesize !== false) audio = await this.synthesizeText(input.text);
    } catch (error) {
      if (!this.closing && isVoiceConnectionLoss(error)) {
        this.trace?.recordFailure("session", "connection_lost");
        errors.push("connection_lost");
        errorCodes.push(this.errorHandler.connectionLost().code);
      }
      this.trace?.recordFailure("tts", "tts_failed");
      this.markShadowReviewTtsFailure("tts_failed");
      errors.push("tts_failed");
      const decision = this.errorHandler.ttsFailed(input.text);
      errorCodes.push(decision.code);
      logVoiceDebug("tts_failed", {
        elapsed_ms: Math.max(0, Math.round(performance.now() - ttsStartedAt))
      });
    } finally {
      session.transition("idle");
      if (this.onLifecycleStateChange) await this.updateLifecycleState("IDLE");
    }

    if (audio) {
      logVoiceDebug("tts_completed", {
        elapsed_ms: Math.max(0, Math.round(performance.now() - ttsStartedAt)),
        audio_bytes: audio.byteLength
      });
    }

    return {
      sessionId: session.id,
      transcript: input.transcript,
      mode: this.responseMode,
      text: input.text,
      ...(input.answer ? { answer: input.answer } : {}),
      ...(audio ? { audio } : {}),
      ...(errors.length > 0 ? { errors: [...new Set(errors)] } : {}),
      ...(errorCodes.length > 0 ? { errorCodes: [...new Set(errorCodes)] } : {})
    };
  }

  private async synthesizeText(text: string) {
    return this.synthesizeTextWithin(text, this.ttsTimeoutMs);
  }

  private async recoverStreamingTtsWithoutAudio(text: string) {
    const recoveryBudgetMs = Math.min(
      this.ttsTimeoutMs,
      MAX_STREAMING_TTS_RECOVERY_MS
    );
    const startedAt = performance.now();
    const recovered = await withVoiceOperationTimeout(
      this.recoverProviderConnection(false),
      recoveryBudgetMs,
      "Voice TTS recovery exceeded its bounded budget"
    );
    if (!recovered) {
      throw new VoiceProviderError(
        "connection_failed",
        "Voice TTS recovery did not restore a provider session"
      );
    }
    const remainingMs = Math.max(
      1,
      recoveryBudgetMs - Math.round(performance.now() - startedAt)
    );
    return this.synthesizeTextWithin(text, remainingMs);
  }

  private async synthesizeTextWithin(text: string, timeoutMs: number) {
    const spokenProjection = requireSpokenProjection(text);
    const deadline = performance.now() + timeoutMs;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs < 1) {
        throw new VoiceProviderError(
          "timeout",
          "Voice QA TTS exhausted its bounded retry budget"
        );
      }
      await this.prepareProviderForCanonicalTts();
      const turn = this.beginTtsTurn(remainingMs);
      this.trace?.mark("tts_request_start");
      logVoiceDebug("tts_request", {
        text_length: spokenProjection.length,
        text_bytes: Buffer.byteLength(spokenProjection, "utf8"),
        sentence_index: 1,
        attempt: attempt + 1,
        provider_response_category: "request_started"
      });
      try {
        const [, audio] = await Promise.all([
          this.provider.sendText(spokenProjection),
          turn.promise
        ]);
        logVoiceDebug("tts_request_completed", {
          text_length: spokenProjection.length,
          sentence_index: 1,
          attempt: attempt + 1,
          provider_response_category: "completed",
          audio_bytes: audio.byteLength
        });
        return audio;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error("Voice TTS failed");
        this.rejectActiveTts(normalized);
        await turn.promise.catch(() => undefined);
        logVoiceDebug("tts_request_failed", {
          text_length: spokenProjection.length,
          sentence_index: 1,
          attempt: attempt + 1,
          provider_response_category: ttsProviderResponseCategory(normalized),
          failure_reason: ttsFailureReason(normalized)
        });
        if (attempt === 0 && isVoiceConnectionLoss(normalized)) {
          const recovered = await this.recoverProviderConnection(false);
          if (recovered) continue;
        }
        throw normalized;
      }
    }
    throw new VoiceProviderError("connection_closed", "Voice TTS recovery did not complete");
  }

  private setAutonomousTtsActive(active: boolean) {
    this.autonomousTtsActive = active;
    if (active) return;
    for (const resolve of this.autonomousTtsIdleWaiters) resolve();
    this.autonomousTtsIdleWaiters.clear();
  }

  private waitForAutonomousTtsIdle(timeoutMs: number) {
    if (!this.autonomousTtsActive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.autonomousTtsIdleWaiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.autonomousTtsIdleWaiters.add(finish);
    });
  }

  private async prepareProviderForCanonicalTts() {
    if (!this.autonomousTtsActive) return;
    if (!this.provider.interruptResponse) {
      logVoiceDebug("autonomous_tts_interrupt_skipped", {
        provider_response_category: "unsupported"
      });
      return;
    }
    logVoiceDebug("autonomous_tts_interrupt_started", {
      provider_response_category: "default_stream_active"
    });
    await this.provider.interruptResponse();
    await this.waitForAutonomousTtsIdle(1_500);
    logVoiceDebug("autonomous_tts_interrupt_completed", {
      provider_response_category: this.autonomousTtsActive
        ? "terminal_not_observed"
        : "terminal_observed"
    });
  }

  private beginTtsTurn(timeoutMs = this.ttsTimeoutMs): ActiveTtsTurn {
    if (this.activeTts) {
      throw new VoiceProviderError("invalid_state", "A Voice QA TTS turn is already active");
    }
    let resolvePromise!: (audio: Buffer) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<Buffer>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const turn: ActiveTtsTurn = {
      chunks: [],
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout: setTimeout(() => {
        this.rejectActiveTts(new VoiceProviderError(
          "timeout",
          `Voice QA TTS did not finish within ${timeoutMs}ms`
        ));
      }, timeoutMs),
      settled: false,
      chatTtsStarted: false
    };
    this.activeTts = turn;
    return turn;
  }

  private resolveActiveTts() {
    const turn = this.activeTts;
    if (!turn || turn.settled) return;
    if (turn.chunks.length === 0) {
      this.rejectActiveTts(new VoiceProviderError(
        "protocol_error",
        "Voice provider ended TTS without returning audio"
      ));
      return;
    }
    turn.settled = true;
    clearTimeout(turn.timeout);
    this.activeTts = undefined;
    turn.resolve(Buffer.concat(turn.chunks));
  }

  private rejectActiveTts(error: Error) {
    const turn = this.activeTts;
    if (!turn || turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.timeout);
    this.activeTts = undefined;
    turn.reject(error);
  }

  private notifyResponse(response: VoiceQAResponse) {
    for (const listener of this.responseListeners) {
      try {
        listener(response);
      } catch {
        // Consumer callbacks must not break the bridge state machine.
      }
    }
  }

  private async recoverProviderConnection(replayAudio: boolean) {
    if (this.closing) return false;
    if (this.reconnectPromise) return this.reconnectPromise;
    const recovery = (async () => {
      const restored = await this.errorHandler.reconnect(this.provider, (info) => {
        this.providerSessionId = info.sessionId;
        this.trace?.setProviderSessionId(info.sessionId);
      });
      if (!restored) return false;
      if (replayAudio) {
        try {
          for (const chunk of this.audioReplayChunks) {
            await this.provider.sendAudio(chunk);
          }
        } catch {
          return false;
        }
      }
      logVoiceDebug("connection_recovered", {
        replayed_audio_chunks: replayAudio ? this.audioReplayChunks.length : 0
      });
      return true;
    })();
    this.reconnectPromise = recovery;
    try {
      return await recovery;
    } finally {
      if (this.reconnectPromise === recovery) this.reconnectPromise = undefined;
    }
  }

  private async updateLifecycleState(
    state: Extract<VoiceSessionState, "PROCESSING" | "RESPONDING" | "IDLE">
  ) {
    await this.onLifecycleStateChange?.(state);
  }

  private beginShadowReviewTurn(): VoiceQaShadowReviewTurn {
    const asrCompletedAtMs = performance.now();
    const responseBaselineAtMs =
      this.shadowReviewSpeechEndedAtMs ?? asrCompletedAtMs;
    return {
      responseBaselineAtMs,
      asrLatencyMs:
        this.shadowReviewSpeechEndedAtMs === null
          ? null
          : Math.max(
              0,
              Math.round(asrCompletedAtMs - this.shadowReviewSpeechEndedAtMs)
            ),
      retrievalCompletedAtMs: null,
      llmFirstTokenLatencyMs: null,
      firstPlayableSentenceLatencyMs: null,
      firstAudioLatencyMs: null,
      streamingComplete: false,
      ttsFailures: new Set<string>()
    };
  }

  private shadowReviewElapsedSince(startedAtMs: number) {
    return Math.max(0, Math.round(performance.now() - startedAtMs));
  }

  private markShadowReviewRetrievalComplete() {
    const turn = this.activeShadowReviewTurn;
    if (turn && turn.retrievalCompletedAtMs === null) {
      turn.retrievalCompletedAtMs = performance.now();
    }
  }

  private markShadowReviewLlmFirstToken() {
    const turn = this.activeShadowReviewTurn;
    if (
      turn &&
      turn.llmFirstTokenLatencyMs === null &&
      turn.retrievalCompletedAtMs !== null
    ) {
      turn.llmFirstTokenLatencyMs = this.shadowReviewElapsedSince(
        turn.retrievalCompletedAtMs
      );
    }
  }

  private markShadowReviewFirstPlayableSentence() {
    const turn = this.activeShadowReviewTurn;
    if (turn && turn.firstPlayableSentenceLatencyMs === null) {
      turn.firstPlayableSentenceLatencyMs = this.shadowReviewElapsedSince(
        turn.responseBaselineAtMs
      );
    }
  }

  private markShadowReviewFirstAudio() {
    const turn = this.activeShadowReviewTurn;
    if (turn && turn.firstAudioLatencyMs === null) {
      turn.firstAudioLatencyMs = this.shadowReviewElapsedSince(
        turn.responseBaselineAtMs
      );
    }
  }

  private markShadowReviewStreamingComplete() {
    if (this.activeShadowReviewTurn) {
      this.activeShadowReviewTurn.streamingComplete = true;
    }
  }

  private markShadowReviewTtsFailure(code: string) {
    this.activeShadowReviewTurn?.ttsFailures.add(code);
  }

  private completeShadowReviewTurn(
    turn: VoiceQaShadowReviewTurn
  ): VoiceQaShadowReviewVoiceMetrics {
    return {
      asrLatencyMs: turn.asrLatencyMs,
      llmFirstTokenLatencyMs: turn.llmFirstTokenLatencyMs,
      firstPlayableSentenceLatencyMs: turn.firstPlayableSentenceLatencyMs,
      firstAudioLatencyMs: turn.firstAudioLatencyMs,
      completeLatencyMs: this.shadowReviewElapsedSince(
        turn.responseBaselineAtMs
      ),
      streamingComplete: turn.streamingComplete,
      ttsFailure:
        turn.ttsFailures.size > 0
          ? [...turn.ttsFailures].sort().join(",")
          : null
    };
  }

  private resetAsrTurn() {
    this.bufferedTranscript = undefined;
    this.bufferedTranscriptIsFinal = false;
    this.asrTurnActive = false;
    this.asrTurnHadFinal = false;
    this.audioInputFinished = false;
    this.shadowReviewSpeechEndedAtMs = null;
    this.audioReplayChunks.length = 0;
  }

  private requireSession() {
    if (!this.session) {
      throw new VoiceProviderError("invalid_state", "Voice QA bridge has not started");
    }
    return this.session;
  }

  private requireProviderSessionId() {
    if (!this.providerSessionId) {
      throw new VoiceProviderError("invalid_state", "Voice provider session has not started");
    }
    return this.providerSessionId;
  }

  private requireOpenSession() {
    const session = this.requireSession();
    if (session.state === "closed") {
      throw new VoiceProviderError("invalid_state", "Voice QA bridge is closed");
    }
    return session;
  }

  private unsubscribeAll() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }
}
