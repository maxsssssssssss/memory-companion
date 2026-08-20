import { DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT } from "./audio";
import { logVoiceDebug } from "./debug";
import { VoiceEvent, type ParsedVoiceServerEvent } from "./events";
import {
  requireSpokenProjection,
  SpokenProjectionError
} from "./spoken-projection";
import { VoiceProviderError } from "./types";
import type { VoiceProvider, VoiceUnsubscribe } from "./types";

const DEFAULT_FIRST_AUDIO_TIMEOUT_MS = 10_000;
const DEFAULT_AUDIO_IDLE_TIMEOUT_MS = 5_000;
const DEFAULT_HARD_SENTENCE_TIMEOUT_MS = 45_000;
// Provider events cannot be backpressured. Keep this larger than the browser's
// five-second PCM queue so normal playback backpressure does not look like a
// Provider failure, while retaining a hard upper bound.
const DEFAULT_MAX_BUFFERED_AUDIO_CHUNKS = 256;
const MAX_SENTENCE_TIMEOUT_MS = 300_000;
const MAX_BUFFERED_AUDIO_CHUNKS = 1_024;

export type StreamingSpeechSentence = {
  sequence: number;
  spokenSentence: string;
  supportIds: readonly string[];
  safeForSpeech: true;
  /**
   * Grounded commits are released before the canonical answer completes.
   * A final projection is created only after the canonical answer is final and
   * may legitimately have no evidence IDs (for example safe uncertainty).
   */
  source?: "grounded_commit" | "final_projection";
};

export type StreamingTtsAudioFormat = typeof DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT;

export type StreamingTtsEvent =
  | {
      type: "sentence_started";
      sentenceSequence: number;
      supportIds: string[];
    }
  | {
      type: "audio_chunk";
      /** Monotonic across the complete stream, starting at one. */
      sequence: number;
      sentenceSequence: number;
      /** Monotonic within one sentence, starting at one. */
      sentenceChunkSequence: number;
      supportIds: string[];
      audio: Buffer;
      format: StreamingTtsAudioFormat;
    }
  | {
      type: "sentence_completed";
      sentenceSequence: number;
      supportIds: string[];
      audioChunkCount: number;
    }
  | {
      type: "stream_completed";
      sentenceCount: number;
      audioChunkCount: number;
    };

export type StreamingTtsErrorCode =
  | "invalid_configuration"
  | "unsafe_sentence"
  | "invalid_sentence"
  | "empty_stream"
  | "empty_audio"
  | "buffer_overflow"
  | "timeout"
  | "provider_failure"
  | "protocol_error"
  | "aborted";

export class StreamingTtsError extends Error {
  constructor(
    readonly code: StreamingTtsErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StreamingTtsError";
  }
}

export type StreamTextToSpeechOptions = {
  provider: VoiceProvider;
  /** The already-started Provider session owned by the surrounding Voice bridge. */
  sessionId: string;
  signal?: AbortSignal;
  /** @deprecated Use hardSentenceTimeoutMs. Retained for existing callers. */
  sentenceTimeoutMs?: number;
  /** Maximum wait from request start to the first accepted audio chunk. */
  firstAudioTimeoutMs?: number;
  /** Maximum silence between accepted audio chunks before failing closed. */
  audioIdleTimeoutMs?: number;
  /** Absolute per-sentence ceiling even while audio is still arriving. */
  hardSentenceTimeoutMs?: number;
  /** Bounds pushed Provider chunks while the downstream consumer is slower. */
  maxBufferedAudioChunks?: number;
  /** Content-free hook fired immediately before each Provider TTS request. */
  onTtsRequestStart?: (input: { sentenceSequence: number }) => void;
};

type SpeechSentenceSource =
  | Iterable<StreamingSpeechSentence>
  | AsyncIterable<StreamingSpeechSentence>;

type ProviderTtsStream = {
  type: string;
  questionId?: string;
  replyId?: string;
};

type TurnEvent = Exclude<StreamingTtsEvent, { type: "stream_completed" }>;

type QueuedTurnEvent = {
  event: TurnEvent;
  audio: boolean;
};

type QueueResult<T> = IteratorResult<T, undefined>;

type QueueWaiter<T> = {
  resolve: (result: QueueResult<T>) => void;
  reject: (error: Error) => void;
};

class BoundedTurnQueue {
  private readonly items: QueuedTurnEvent[] = [];
  private readonly waiters: QueueWaiter<TurnEvent>[] = [];
  private bufferedAudioChunks = 0;
  private closed = false;
  private failure?: Error;

  constructor(private readonly maxBufferedAudioChunks: number) {}

  push(event: TurnEvent, audio = false) {
    if (this.closed || this.failure) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return true;
    }
    if (audio && this.bufferedAudioChunks >= this.maxBufferedAudioChunks) {
      this.fail(new StreamingTtsError(
        "buffer_overflow",
        "Streaming TTS audio buffer exceeded its bounded capacity"
      ));
      return false;
    }
    this.items.push({ event, audio });
    if (audio) this.bufferedAudioChunks += 1;
    return true;
  }

  close() {
    if (this.closed || this.failure) return;
    this.closed = true;
    if (this.items.length === 0) this.resolveDone();
  }

  fail(error: Error) {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.items.splice(0);
    this.bufferedAudioChunks = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<QueueResult<TurnEvent>> {
    if (this.failure) return Promise.reject(this.failure);
    const item = this.items.shift();
    if (item) {
      if (item.audio) this.bufferedAudioChunks -= 1;
      return Promise.resolve({ value: item.event, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private resolveDone() {
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}

type ActiveSentenceTurn = {
  sentence: StreamingSpeechSentence;
  queue: BoundedTurnQueue;
  started: boolean;
  completed: boolean;
  audioChunkCount: number;
  activeChatStream?: ProviderTtsStream;
  observedStream?: ProviderTtsStream;
  questionId?: string;
  replyId?: string;
  firstAudioTimeout?: ReturnType<typeof setTimeout>;
  audioIdleTimeout?: ReturnType<typeof setTimeout>;
  hardTimeout?: ReturnType<typeof setTimeout>;
  timeoutCategory?: "first_audio_timeout" | "audio_idle_timeout" | "hard_timeout";
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new StreamingTtsError(
      "invalid_configuration",
      `${name} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return resolved;
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
  turn: Pick<ActiveSentenceTurn, "questionId" | "replyId">,
  stream: Pick<ProviderTtsStream, "questionId" | "replyId">
) {
  if (turn.questionId && stream.questionId && turn.questionId !== stream.questionId) return false;
  if (turn.replyId && stream.replyId && turn.replyId !== stream.replyId) return false;
  return true;
}

function providerFailed(event: ParsedVoiceServerEvent) {
  return (
    event.errorCode !== undefined ||
    event.eventId === VoiceEvent.ConnectionFailed ||
    event.eventId === VoiceEvent.SessionFailed ||
    event.eventId === VoiceEvent.DialogCommonError
  );
}

function providerFailure(event: ParsedVoiceServerEvent) {
  const cause = new VoiceProviderError(
    event.internalFailureReason ?? "provider_error",
    "Voice provider rejected streaming TTS",
    event.errorCode
  );
  return new StreamingTtsError(
    "provider_failure",
    `Voice provider event ${event.eventName} failed`,
    { cause }
  );
}

function normalizedProviderFailure(error: unknown) {
  if (error instanceof StreamingTtsError) return error;
  return new StreamingTtsError(
    "provider_failure",
    "Voice provider failed while accepting streaming TTS text",
    error instanceof Error ? { cause: error } : undefined
  );
}

function abortError() {
  return new StreamingTtsError("aborted", "Streaming TTS was aborted");
}

function validateSentence(
  sentence: StreamingSpeechSentence,
  previousSequence: number | undefined
): StreamingSpeechSentence {
  if (!sentence || typeof sentence !== "object" || sentence.safeForSpeech !== true) {
    throw new StreamingTtsError(
      "unsafe_sentence",
      "Only explicitly speech-safe sentences can enter streaming TTS"
    );
  }
  if (!Number.isSafeInteger(sentence.sequence) || sentence.sequence < 1) {
    throw new StreamingTtsError("invalid_sentence", "Streaming TTS sentence sequence must be positive");
  }
  if (previousSequence !== undefined && sentence.sequence <= previousSequence) {
    throw new StreamingTtsError(
      "invalid_sentence",
      "Streaming TTS sentence sequences must be strictly increasing"
    );
  }
  const candidate = typeof sentence.spokenSentence === "string"
    ? sentence.spokenSentence
    : "";
  let spokenSentence: string;
  try {
    spokenSentence = requireSpokenProjection(candidate);
  } catch (error) {
    throw new StreamingTtsError(
      error instanceof SpokenProjectionError && error.reason === "empty_text"
        ? "invalid_sentence"
        : "unsafe_sentence",
      "Streaming TTS requires a citation-free spoken projection",
      error instanceof Error ? { cause: error } : undefined
    );
  }
  if (!Array.isArray(sentence.supportIds)) {
    throw new StreamingTtsError("invalid_sentence", "Streaming TTS support IDs must be an array");
  }
  if (!sentence.supportIds.every((id) => typeof id === "string" && id.trim())) {
    throw new StreamingTtsError(
      "invalid_sentence",
      "Streaming TTS support IDs must be non-empty strings"
    );
  }
  const supportIds = [...new Set(sentence.supportIds.map((id) => id.trim()))];
  const source = sentence.source ?? "grounded_commit";
  if (
    supportIds.length !== sentence.supportIds.length ||
    (source === "grounded_commit" && supportIds.length === 0)
  ) {
    throw new StreamingTtsError(
      "invalid_sentence",
      source === "grounded_commit"
        ? "Streaming TTS grounded sentence must retain valid, unique support IDs"
        : "Streaming TTS final projection support IDs must be unique"
    );
  }
  return {
    sequence: sentence.sequence,
    spokenSentence,
    supportIds,
    safeForSpeech: true,
    ...(sentence.source ? { source: sentence.source } : {})
  };
}

function sentenceIterator(source: SpeechSentenceSource): AsyncIterator<StreamingSpeechSentence> {
  const asyncSource = source as AsyncIterable<StreamingSpeechSentence>;
  if (typeof asyncSource?.[Symbol.asyncIterator] === "function") {
    return asyncSource[Symbol.asyncIterator]();
  }
  const syncSource = source as Iterable<StreamingSpeechSentence>;
  if (typeof syncSource?.[Symbol.iterator] !== "function") {
    throw new StreamingTtsError("invalid_configuration", "Streaming TTS requires a sentence iterable");
  }
  const iterator = syncSource[Symbol.iterator]();
  return {
    next: async () => iterator.next(),
    return: iterator.return
      ? async () => iterator.return!()
      : undefined
  };
}

function exactSessionEvent(event: ParsedVoiceServerEvent, sessionId: string) {
  return event.sessionId === sessionId;
}

/**
 * Streams already speech-safe sentences through an already-started VoiceProvider
 * session. It deliberately does not own or close the Provider session, preserving
 * the existing full-text TTS path and its surrounding Voice bridge lifecycle.
 */
export async function* streamTextToSpeech(
  sentences: SpeechSentenceSource,
  options: StreamTextToSpeechOptions
): AsyncGenerator<StreamingTtsEvent, void, void> {
  const sessionId = options.sessionId?.trim();
  if (!sessionId) {
    throw new StreamingTtsError("invalid_configuration", "Streaming TTS requires a Provider session ID");
  }
  const hardSentenceTimeoutMs = boundedInteger(
    options.hardSentenceTimeoutMs ?? options.sentenceTimeoutMs,
    DEFAULT_HARD_SENTENCE_TIMEOUT_MS,
    1,
    MAX_SENTENCE_TIMEOUT_MS,
    "Streaming TTS hard sentence timeout"
  );
  const firstAudioTimeoutMs = boundedInteger(
    options.firstAudioTimeoutMs,
    Math.min(DEFAULT_FIRST_AUDIO_TIMEOUT_MS, hardSentenceTimeoutMs),
    1,
    hardSentenceTimeoutMs,
    "Streaming TTS first audio timeout"
  );
  const audioIdleTimeoutMs = boundedInteger(
    options.audioIdleTimeoutMs,
    Math.min(DEFAULT_AUDIO_IDLE_TIMEOUT_MS, hardSentenceTimeoutMs),
    1,
    hardSentenceTimeoutMs,
    "Streaming TTS audio idle timeout"
  );
  const maxBufferedAudioChunks = boundedInteger(
    options.maxBufferedAudioChunks,
    DEFAULT_MAX_BUFFERED_AUDIO_CHUNKS,
    1,
    MAX_BUFFERED_AUDIO_CHUNKS,
    "Streaming TTS buffered audio chunks"
  );
  if (options.signal?.aborted) throw abortError();

  const iterator = sentenceIterator(sentences);
  let activeTurn: ActiveSentenceTurn | undefined;
  let globalAudioSequence = 0;
  let sentenceCount = 0;
  let previousSentenceSequence: number | undefined;
  let sourceCompleted = false;
  let abortReject: ((error: Error) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });
  // Abort may happen between awaited operations. Keep an observer attached so
  // the cancellation gate itself never becomes an unhandled rejection.
  void abortPromise.catch(() => undefined);
  const onAbort = () => {
    const error = abortError();
    activeTurn?.queue.fail(error);
    abortReject?.(error);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const raceAbort = <T>(operation: Promise<T>) => options.signal
    ? Promise.race([operation, abortPromise])
    : operation;

  let unsubscribe: VoiceUnsubscribe = () => undefined;
  const clearTurnTimers = (turn: ActiveSentenceTurn) => {
    if (turn.firstAudioTimeout) clearTimeout(turn.firstAudioTimeout);
    if (turn.audioIdleTimeout) clearTimeout(turn.audioIdleTimeout);
    if (turn.hardTimeout) clearTimeout(turn.hardTimeout);
    turn.firstAudioTimeout = undefined;
    turn.audioIdleTimeout = undefined;
    turn.hardTimeout = undefined;
  };
  const failTurnTimeout = (
    turn: ActiveSentenceTurn,
    category: ActiveSentenceTurn["timeoutCategory"],
    timeoutMs: number
  ) => {
    turn.timeoutCategory = category;
    turn.queue.fail(new StreamingTtsError(
      "timeout",
      `Streaming TTS ${category} exceeded ${timeoutMs}ms`
    ));
  };
  const resetAudioIdleTimeout = (turn: ActiveSentenceTurn) => {
    if (turn.audioIdleTimeout) clearTimeout(turn.audioIdleTimeout);
    turn.audioIdleTimeout = setTimeout(() => {
      failTurnTimeout(turn, "audio_idle_timeout", audioIdleTimeoutMs);
    }, audioIdleTimeoutMs);
  };
  try {
    unsubscribe = options.provider.onEvent((event) => {
      const turn = activeTurn;
      if (!turn || turn.completed) return;
      if (event.sessionId && event.sessionId !== sessionId) return;
      if (providerFailed(event)) {
        turn.queue.fail(providerFailure(event));
        return;
      }

      if (
        event.eventId !== VoiceEvent.TTSSentenceStart &&
        event.eventId !== VoiceEvent.TTSResponse &&
        event.eventId !== VoiceEvent.TTSSentenceEnd &&
        event.eventId !== VoiceEvent.TTSEnded
      ) {
        return;
      }
      if (!exactSessionEvent(event, sessionId)) return;

      if (event.eventId === VoiceEvent.TTSSentenceStart) {
        const stream = providerTtsStream(event);
        if (!stream) return;
        turn.observedStream = stream;
        if (stream.type !== "chat_tts_text") {
          logVoiceDebug("tts_stream_ignored", {
            sentence_index: turn.sentence.sequence,
            provider_response_category: "autonomous_stream_start"
          });
          return;
        }
        if (turn.started && !sameProviderTtsStream(turn, stream)) {
          turn.queue.fail(new StreamingTtsError(
            "protocol_error",
            "Voice provider started a different chat TTS stream before the active sentence ended"
          ));
          return;
        }
        turn.questionId ??= stream.questionId;
        turn.replyId ??= stream.replyId;
        turn.activeChatStream ??= stream;
        if (turn.started) return;
        turn.started = true;
        turn.queue.push({
          type: "sentence_started",
          sentenceSequence: turn.sentence.sequence,
          supportIds: [...turn.sentence.supportIds]
        });
        return;
      }

      if (event.eventId === VoiceEvent.TTSResponse) {
        const stream = turn.observedStream ?? turn.activeChatStream;
        if (
          !turn.started ||
          stream?.type !== "chat_tts_text" ||
          !sameProviderTtsStream(turn, stream) ||
          !event.audio ||
          event.audio.byteLength === 0
        ) {
          return;
        }
        if (turn.firstAudioTimeout) {
          clearTimeout(turn.firstAudioTimeout);
          turn.firstAudioTimeout = undefined;
        }
        resetAudioIdleTimeout(turn);
        turn.audioChunkCount += 1;
        globalAudioSequence += 1;
        turn.queue.push({
          type: "audio_chunk",
          sequence: globalAudioSequence,
          sentenceSequence: turn.sentence.sequence,
          sentenceChunkSequence: turn.audioChunkCount,
          supportIds: [...turn.sentence.supportIds],
          audio: Buffer.from(event.audio),
          format: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT
        }, true);
        return;
      }

      const terminalStream = providerTtsStream(event) ?? turn.observedStream;
      if (terminalStream && terminalStream.type !== "chat_tts_text") {
        logVoiceDebug("tts_stream_ignored", {
          sentence_index: turn.sentence.sequence,
          provider_response_category: "autonomous_stream_terminal",
          terminal_event_id: event.eventId
        });
        turn.observedStream = undefined;
        return;
      }
      const stream = terminalStream ?? turn.activeChatStream;
      if (
        stream?.type === "chat_tts_text" &&
        turn.started &&
        sameProviderTtsStream(turn, stream)
      ) {
        if (turn.audioChunkCount === 0) {
          turn.queue.fail(new StreamingTtsError(
            "empty_audio",
            "Voice provider ended streaming TTS without returning audio"
          ));
          return;
        }
        turn.completed = true;
        clearTurnTimers(turn);
        turn.queue.push({
          type: "sentence_completed",
          sentenceSequence: turn.sentence.sequence,
          supportIds: [...turn.sentence.supportIds],
          audioChunkCount: turn.audioChunkCount
        });
        turn.queue.close();
      }
    });

    while (true) {
      const nextSentence = await raceAbort(Promise.resolve(iterator.next()));
      if (nextSentence.done) {
        sourceCompleted = true;
        break;
      }
      const sentence = validateSentence(nextSentence.value, previousSentenceSequence);
      previousSentenceSequence = sentence.sequence;
      sentenceCount += 1;
      const queue = new BoundedTurnQueue(maxBufferedAudioChunks);
      const turn: ActiveSentenceTurn = {
        sentence,
        queue,
        started: false,
        completed: false,
        audioChunkCount: 0
      };
      activeTurn = turn;
      let providerResponseCategory = "none";
      turn.firstAudioTimeout = setTimeout(() => {
        failTurnTimeout(turn, "first_audio_timeout", firstAudioTimeoutMs);
      }, firstAudioTimeoutMs);
      turn.hardTimeout = setTimeout(() => {
        failTurnTimeout(turn, "hard_timeout", hardSentenceTimeoutMs);
      }, hardSentenceTimeoutMs);

      const send = Promise.resolve()
        .then(() => {
          logVoiceDebug("tts_sentence_request", {
            text_length: sentence.spokenSentence.length,
            text_bytes: Buffer.byteLength(sentence.spokenSentence, "utf8"),
            sentence_index: sentence.sequence,
            provider_response_category: "request_started"
          });
          try {
            options.onTtsRequestStart?.({
              sentenceSequence: sentence.sequence
            });
          } catch {
            // Observability cannot prevent a safe sentence from reaching TTS.
          }
          return options.provider.sendText(sentence.spokenSentence);
        });
      void send.catch((error: unknown) => {
        providerResponseCategory = "send_rejected";
        turn.queue.fail(normalizedProviderFailure(error));
      });

      try {
        while (true) {
          const queued = await raceAbort(turn.queue.next());
          if (queued.done) break;
          if (queued.value.type === "sentence_started") {
            providerResponseCategory = "sentence_started";
          } else if (queued.value.type === "audio_chunk") {
            providerResponseCategory = "audio";
          } else {
            providerResponseCategory = "sentence_completed";
          }
          yield queued.value;
        }
        await raceAbort(send);
        logVoiceDebug("tts_sentence_completed", {
          text_length: sentence.spokenSentence.length,
          sentence_index: sentence.sequence,
          provider_response_category: providerResponseCategory,
          audio_chunk_count: turn.audioChunkCount
        });
      } catch (error) {
        if (turn.timeoutCategory) providerResponseCategory = turn.timeoutCategory;
        const failureReason = error instanceof StreamingTtsError
          ? error.code
          : "provider_failure";
        logVoiceDebug("tts_sentence_failed", {
          text_length: sentence.spokenSentence.length,
          sentence_index: sentence.sequence,
          provider_response_category: providerResponseCategory,
          failure_reason: failureReason
        });
        throw error;
      } finally {
        clearTurnTimers(turn);
        if (activeTurn === turn) activeTurn = undefined;
      }
    }

    if (sentenceCount === 0) {
      throw new StreamingTtsError("empty_stream", "Streaming TTS received no speech sentences");
    }
    yield {
      type: "stream_completed",
      sentenceCount,
      audioChunkCount: globalAudioSequence
    };
  } finally {
    if (activeTurn) clearTurnTimers(activeTurn);
    activeTurn?.queue.fail(abortError());
    activeTurn = undefined;
    unsubscribe();
    options.signal?.removeEventListener("abort", onAbort);
    if (!sourceCompleted && iterator.return) {
      // A source may be waiting on its own producer. Cleanup is best-effort and
      // must not make cancellation wait indefinitely for that producer.
      void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }
}
