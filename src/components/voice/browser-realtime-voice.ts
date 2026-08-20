"use client";

import {
  VoiceAudioQueue,
  type VoiceAudioQueueOptions,
  type VoiceAudioPlaybackPosition
} from "@/lib/client/voice-audio-queue";
import type { VoiceQaContext } from "@/lib/domain/voice-qa-context";
import {
  calculateRealtimeVoiceLatencyMetrics,
  type RealtimeVoiceLatencyMarker,
  type RealtimeVoiceLatencySnapshot
} from "@/lib/voice-realtime-latency";
import type { VoiceBrowserAnswerMetadata } from "@/lib/voice-browser-stream";

import type {
  BrowserVoiceQaCompletedTurn,
  BrowserVoiceQaConversationMessage
} from "./browser-voice-qa";
import {
  BrowserRealtimeVoiceWebSocketTransport,
  type BrowserWebSocketFactory
} from "./browser-realtime-websocket";
import type { BrowserVoiceQaState } from "./voice-session-status";

const MAX_PENDING_CAPTURE_CHUNKS = 250;
const MAX_PENDING_PLAYBACK_EVENTS = 256;
const MAX_TRANSPORT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_TRANSPORT_RECONNECT_DELAY_MS = 100;
const DEFAULT_REALTIME_IDLE_TIMEOUT_MS = 10 * 60_000;
const REALTIME_WORKLET_URL = "/voice-pcm-worklet.js";

type BrowserVoiceAudioQueue = Pick<
  VoiceAudioQueue,
  "prepare" | "enqueue" | "finish" | "cancel"
> & Partial<Pick<VoiceAudioQueue, "playbackPosition">>;
type ReconnectableBrowserVoiceAudioQueue = BrowserVoiceAudioQueue & Partial<Pick<
  VoiceAudioQueue,
  "pauseForReconnect" | "resumeAfterReconnect"
>>;

type RealtimeSessionResponse = {
  sessionId: string;
};

type RealtimeWireEvent =
  | { type: "session_started"; providerSessionId: string }
  | { type: "session_reconnected"; providerSessionId: string }
  | { type: "voice_activity" }
  | { type: "asr_partial"; transcript: string }
  | { type: "asr_final"; turnSequence: number; transcript: string }
  | {
      type: "turn_state";
      turnSequence: number;
      state: "thinking" | "speaking" | "listening";
    }
  | {
      type: "audio_chunk";
      turnSequence: number;
      sequence: number;
      sentenceSequence: number;
      sentenceChunkSequence: number;
      providerItemId?: string;
      audioBase64: string;
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
      answer?: VoiceBrowserAnswerMetadata;
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
      reason?: "barge_in" | "connection_lost" | "session_closed";
    }
  | { type: "error"; code: string }
  | { type: "session_closed" };

export type BrowserRealtimeVoiceOptions = {
  scope: "current" | "week" | "all";
  uploadId?: string;
  referenceDate?: string;
  context?: VoiceQaContext;
  conversation?: readonly BrowserVoiceQaConversationMessage[];
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Explicit development v2 gateway URL. Omitted keeps the existing HTTP path. */
  gatewayUrl?: string;
  webSocketFactory?: BrowserWebSocketFactory;
  audioQueueFactory?: (
    options: VoiceAudioQueueOptions
  ) => ReconnectableBrowserVoiceAudioQueue;
  /** Test seam for bounded reconnect timing; production defaults to 100 ms. */
  reconnectDelayMs?: number;
  /** Semantic inactivity timeout; raw silent PCM and heartbeats do not reset it. */
  idleTimeoutMs?: number;
  onStateChange?: (state: BrowserVoiceQaState) => void;
  onTranscript?: (transcript: string) => void;
  onAnswer?: (answer: string) => void;
  onTurnCompleted?: (turn: BrowserVoiceQaCompletedTurn) => void;
  onLatencyMarker?: (input: {
    turnSequence: number;
    marker: RealtimeVoiceLatencyMarker;
    atMs: number;
  }) => void;
  onTurnTrace?: (trace: BrowserRealtimeVoiceTurnTrace) => void;
  onSessionEnded?: (input: {
    reason: BrowserRealtimeVoiceSessionEndReason;
    sessionId?: string;
    sessionEpoch: number;
  }) => void;
  onError?: (code: string) => void;
};

export type BrowserRealtimeVoiceSessionEndReason =
  | "user"
  | "idle_timeout"
  | "remote"
  | "transport_error"
  | "startup_error";

export type BrowserRealtimeVoiceLifecycleState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "reconnecting"
  | "ending"
  | "error";

export type BrowserRealtimeVoiceTurnTrace = {
  version: 1;
  sessionId: string;
  sessionEpoch: number;
  turnId: string;
  turnSequence: number;
  stateTransitions: Array<{ state: BrowserVoiceQaState; atMs: number }>;
  latency: RealtimeVoiceLatencySnapshot;
  terminalStatus: "completed" | "failed" | "interrupted";
  terminalReason: string;
  reconnectCount: number;
  interruptLatencyMs: number | null;
  abortedGenerationCount: number;
  providerGenerationStarted: boolean;
  providerGenerationCompleted: boolean;
  audioChunkCount: number;
  wastedTokenCount: null;
};

type BrowserActiveRealtimeTurn = {
  sequence: number;
  sessionEpoch: number;
  terminalReceived: boolean;
  audioReceived: boolean;
  answer?: BrowserVoiceQaCompletedTurn;
  stateTransitions: Array<{ state: BrowserVoiceQaState; atMs: number }>;
  timestamps: Partial<Record<RealtimeVoiceLatencyMarker, number>>;
  serverTrace?: Extract<RealtimeWireEvent, { type: "turn_trace" }>;
};

function decodeBase64(value: string) {
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sessionResponse(value: unknown): RealtimeSessionResponse | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
  return { sessionId: value.sessionId };
}

async function* parseNdjson(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<RealtimeWireEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const decoded: unknown = JSON.parse(line);
        if (!isRecord(decoded) || typeof decoded.type !== "string") {
          throw new Error("invalid_voice_realtime_event");
        }
        yield decoded as RealtimeWireEvent;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      const decoded: unknown = JSON.parse(buffered);
      if (!isRecord(decoded) || typeof decoded.type !== "string") {
        throw new Error("invalid_voice_realtime_event");
      }
      yield decoded as RealtimeWireEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

function errorCode(value: unknown, fallback: string) {
  if (isRecord(value) && typeof value.error === "string" && value.error.trim()) {
    return value.error;
  }
  return fallback;
}

function requireDevelopmentLoopbackGatewayUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("voice_realtime_gateway_url_invalid");
  }
  const loopback = parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (
    process.env.NODE_ENV === "production" ||
    parsed.protocol !== "ws:" ||
    !loopback ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("voice_realtime_gateway_url_not_allowed");
  }
  return parsed.toString();
}

/**
 * Browser transport for the development realtime Voice path. It sends exact
 * 20 ms PCM16 chunks, keeps the microphone open across turns, and cancels
 * playback immediately when the server reports new voice activity.
 */
export class BrowserRealtimeVoiceSession {
  private readonly options: BrowserRealtimeVoiceOptions;
  private readonly fetcher: NonNullable<BrowserRealtimeVoiceOptions["fetcher"]>;
  private readonly audioQueueFactory: NonNullable<
    BrowserRealtimeVoiceOptions["audioQueueFactory"]
  >;
  private readonly reconnectDelayMs: number;
  private readonly idleTimeoutMs: number;
  private gatewayTransport?: BrowserRealtimeVoiceWebSocketTransport;
  private sessionId?: string;
  private mediaStream?: MediaStream;
  private captureContext?: AudioContext;
  private captureSource?: MediaStreamAudioSourceNode;
  private captureNode?: AudioWorkletNode;
  private uploadWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private uploadTask?: Promise<void>;
  private uploadAbortController?: AbortController;
  private uploadGeneration = 0;
  private uploadReconnectAttempts = 0;
  private uploadReconnectTask?: Promise<void>;
  private eventsAbortController?: AbortController;
  private eventStreamGeneration = 0;
  private audioQueue?: ReconnectableBrowserVoiceAudioQueue;
  private playbackTurn?: number;
  private lastAudioSequence = 0;
  private playbackGeneration = 0;
  private playbackTail = Promise.resolve();
  private pendingPlaybackEvents = 0;
  private readonly interruptedTurns = new Set<number>();
  private readonly terminalTurns = new Set<number>();
  private readonly pendingTurnTelemetry = new Map<number, {
    timestamps: Partial<Record<RealtimeVoiceLatencyMarker, number>>;
    serverTrace?: Extract<RealtimeWireEvent, { type: "turn_trace" }>;
  }>();
  private readonly captureQueue: Uint8Array[] = [];
  private captureFlushRunning = false;
  private uploadTail = Promise.resolve();
  private stopping = false;
  private lifecycleGeneration = 0;
  private sessionEpoch = 0;
  private lifecycleState: BrowserRealtimeVoiceLifecycleState = "idle";
  private productState: BrowserVoiceQaState = "idle";
  private activeTurn?: BrowserActiveRealtimeTurn;
  private lastTurnSequence = 0;
  private reconnectCount = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(options: BrowserRealtimeVoiceOptions) {
    this.options = options;
    this.fetcher = options.fetcher ?? fetch;
    this.audioQueueFactory = options.audioQueueFactory ??
      ((queueOptions) => new VoiceAudioQueue(queueOptions));
    this.reconnectDelayMs = Math.max(
      0,
      Math.min(5_000, options.reconnectDelayMs ?? DEFAULT_TRANSPORT_RECONNECT_DELAY_MS)
    );
    this.idleTimeoutMs = Math.max(
      100,
      Math.min(60 * 60_000, options.idleTimeoutMs ?? DEFAULT_REALTIME_IDLE_TIMEOUT_MS)
    );
  }

  get snapshot() {
    return {
      sessionId: this.sessionId,
      sessionEpoch: this.sessionEpoch,
      lifecycleState: this.lifecycleState,
      state: this.productState,
      activeTurnSequence: this.activeTurn?.sequence,
      playbackTurnSequence: this.playbackTurn,
      lastTurnSequence: this.lastTurnSequence,
      reconnectCount: this.reconnectCount
    };
  }

  private setLifecycleState(next: BrowserRealtimeVoiceLifecycleState) {
    this.lifecycleState = next;
  }

  private moveTo(next: BrowserVoiceQaState, turn = this.activeTurn) {
    if (this.productState === next) return false;
    const allowed: Record<BrowserVoiceQaState, readonly BrowserVoiceQaState[]> = {
      idle: ["listening"],
      listening: ["thinking", "idle"],
      thinking: ["speaking", "listening", "idle"],
      speaking: ["listening", "idle"]
    };
    if (!allowed[this.productState].includes(next)) return false;
    this.productState = next;
    if (["idle", "listening", "thinking", "speaking"].includes(this.lifecycleState)) {
      this.lifecycleState = next;
    }
    if (turn && turn.sessionEpoch === this.sessionEpoch) {
      turn.stateTransitions.push({ state: next, atMs: Date.now() });
    }
    this.options.onStateChange?.(next);
    return true;
  }

  private assertGeneration(generation: number) {
    if (generation === this.lifecycleGeneration && !this.stopping) return;
    throw new DOMException("Realtime Voice session start was cancelled", "AbortError");
  }

  private touchIdleTimer() {
    if (!this.sessionId || this.stopping) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const epoch = this.sessionEpoch;
    this.idleTimer = setTimeout(() => {
      if (this.sessionEpoch !== epoch || this.stopping) return;
      void this.stop("idle_timeout");
    }, this.idleTimeoutMs);
  }

  private beginTurn(turnSequence: number) {
    if (
      !Number.isSafeInteger(turnSequence) ||
      turnSequence < 1 ||
      this.terminalTurns.has(turnSequence) ||
      turnSequence <= this.lastTurnSequence ||
      this.activeTurn
    ) {
      return undefined;
    }
    const telemetry = this.pendingTurnTelemetry.get(turnSequence);
    const turn: BrowserActiveRealtimeTurn = {
      sequence: turnSequence,
      sessionEpoch: this.sessionEpoch,
      terminalReceived: false,
      audioReceived: false,
      stateTransitions: [{ state: "listening", atMs: Date.now() }],
      timestamps: { ...(telemetry?.timestamps ?? {}) },
      ...(telemetry?.serverTrace ? { serverTrace: telemetry.serverTrace } : {})
    };
    this.pendingTurnTelemetry.delete(turnSequence);
    this.activeTurn = turn;
    this.lastTurnSequence = turnSequence;
    this.moveTo("thinking", turn);
    this.touchIdleTimer();
    return turn;
  }

  private rememberTerminalTurn(turnSequence: number) {
    this.terminalTurns.add(turnSequence);
    while (this.terminalTurns.size > 32) {
      const oldest = this.terminalTurns.values().next().value as number | undefined;
      if (oldest === undefined) break;
      this.terminalTurns.delete(oldest);
    }
  }

  private finalizeTurn(
    turn: BrowserActiveRealtimeTurn,
    status: "completed" | "failed" | "interrupted",
    reason: string
  ) {
    if (
      this.activeTurn !== turn ||
      turn.sessionEpoch !== this.sessionEpoch ||
      this.terminalTurns.has(turn.sequence)
    ) {
      return false;
    }
    this.moveTo("listening", turn);
    this.rememberTerminalTurn(turn.sequence);
    this.activeTurn = undefined;
    const serverTrace = turn.serverTrace;
    const timestamps = {
      ...(serverTrace?.latency.timestamps ?? {}),
      ...turn.timestamps
    };
    const sessionId = this.sessionId;
    if (sessionId) {
      this.options.onTurnTrace?.({
        version: 1,
        sessionId,
        sessionEpoch: this.sessionEpoch,
        turnId: `${sessionId}:${this.sessionEpoch}:${turn.sequence}`,
        turnSequence: turn.sequence,
        stateTransitions: turn.stateTransitions.map((transition) => ({ ...transition })),
        latency: {
          version: 1,
          turnSequence: turn.sequence,
          timestamps,
          metrics: calculateRealtimeVoiceLatencyMetrics(timestamps)
        },
        terminalStatus: status,
        terminalReason: reason,
        reconnectCount: serverTrace?.reconnectCount ?? this.reconnectCount,
        interruptLatencyMs: serverTrace?.interruptLatencyMs ?? null,
        abortedGenerationCount: serverTrace?.abortedGenerationCount ?? 0,
        providerGenerationStarted: serverTrace?.providerGenerationStarted ?? false,
        providerGenerationCompleted: serverTrace?.providerGenerationCompleted ?? false,
        audioChunkCount: serverTrace?.audioChunkCount ?? (turn.audioReceived ? 1 : 0),
        wastedTokenCount: null
      });
    }
    if (status === "completed" && turn.answer) {
      this.options.onTurnCompleted?.(turn.answer);
    }
    this.touchIdleTimer();
    return true;
  }

  async start() {
    if (this.sessionId || this.stopping) {
      throw new Error("voice_realtime_already_started");
    }
    const generation = ++this.lifecycleGeneration;
    this.sessionEpoch += 1;
    this.reconnectCount = 0;
    this.lastTurnSequence = 0;
    this.activeTurn = undefined;
    this.interruptedTurns.clear();
    this.terminalTurns.clear();
    this.pendingTurnTelemetry.clear();
    this.setLifecycleState("connecting");
    if (
      !globalThis.navigator?.mediaDevices?.getUserMedia ||
      typeof AudioWorkletNode === "undefined" ||
      (!this.options.gatewayUrl && typeof TransformStream === "undefined")
    ) {
      throw new Error("voice_realtime_unsupported");
    }

    try {
      this.audioQueue = this.createAudioQueue();
      await this.audioQueue.prepare();
      this.assertGeneration(generation);
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (generation !== this.lifecycleGeneration || this.stopping) {
        for (const track of mediaStream.getTracks()) track.stop();
        this.assertGeneration(generation);
      }
      this.mediaStream = mediaStream;
      if (this.options.gatewayUrl) {
        await this.startWebSocketGateway();
      } else {
        const response = await this.fetcher("/api/voice/realtime/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: this.options.scope,
            ...(this.options.uploadId ? { uploadId: this.options.uploadId } : {}),
            ...(this.options.referenceDate
              ? { referenceDate: this.options.referenceDate }
              : {}),
            ...(this.options.context ? { context: this.options.context } : {}),
            ...(this.options.conversation
              ? { conversation: this.options.conversation }
              : {})
          })
        });
        const payload: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          throw new Error(errorCode(payload, `voice_realtime_http_${response.status}`));
        }
        const session = sessionResponse(payload);
        if (!session) throw new Error("invalid_voice_realtime_session");
        this.sessionId = session.sessionId;
        this.startEventStream();
        this.startAudioUpload();
      }
      this.assertGeneration(generation);
      await this.startCaptureWorklet();
      this.assertGeneration(generation);
      this.setLifecycleState("listening");
      this.moveTo("listening");
      this.touchIdleTimer();
    } catch (error) {
      if (generation === this.lifecycleGeneration) {
        await this.stop("startup_error");
      }
      throw error;
    }
  }

  async stop(reason: BrowserRealtimeVoiceSessionEndReason = "user") {
    if (this.stopping) return;
    this.stopping = true;
    this.lifecycleGeneration += 1;
    this.setLifecycleState("ending");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const sessionId = this.sessionId;
    this.playbackGeneration += 1;
    this.eventStreamGeneration += 1;
    this.uploadGeneration += 1;
    this.eventsAbortController?.abort();
    this.eventsAbortController = undefined;
    this.uploadAbortController?.abort();
    this.uploadAbortController = undefined;
    await this.uploadWriter?.abort().catch(() => undefined);
    this.uploadWriter = undefined;
    // Release microphone resources before any reconnect/close handshake. A
    // slow network must never retain capture after the user stops the session.
    this.captureNode?.port.postMessage("stop");
    this.captureNode?.disconnect();
    this.captureSource?.disconnect();
    for (const track of this.mediaStream?.getTracks() ?? []) track.stop();
    await this.captureContext?.close().catch(() => undefined);
    this.captureNode = undefined;
    this.captureSource = undefined;
    this.captureContext = undefined;
    this.mediaStream = undefined;
    this.captureQueue.splice(0);
    await this.audioQueue?.cancel().catch(() => undefined);
    this.audioQueue = undefined;
    const gatewayTransport = this.gatewayTransport;
    this.gatewayTransport = undefined;
    await gatewayTransport?.close().catch(() => undefined);
    await this.uploadTail.catch(() => undefined);
    await this.uploadTask?.catch(() => undefined);
    this.uploadTask = undefined;
    await this.uploadReconnectTask?.catch(() => undefined);
    this.uploadReconnectTask = undefined;
    await this.playbackTail.catch(() => undefined);
    if (sessionId && !gatewayTransport) {
      await this.fetcher(
        `/api/voice/realtime/session/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", keepalive: true }
      ).catch(() => undefined);
    }
    if (this.activeTurn) {
      this.finalizeTurn(this.activeTurn, "interrupted", "session_closed");
    }
    this.sessionId = undefined;
    this.playbackTurn = undefined;
    this.lastAudioSequence = 0;
    this.interruptedTurns.clear();
    this.terminalTurns.clear();
    this.pendingTurnTelemetry.clear();
    this.moveTo("idle");
    this.setLifecycleState("idle");
    this.stopping = false;
    this.options.onSessionEnded?.({
      reason,
      ...(sessionId ? { sessionId } : {}),
      sessionEpoch: this.sessionEpoch
    });
  }

  private createAudioQueue() {
    return this.audioQueueFactory({
      startSequence: 1,
      onPlaybackStarted: () => {
        const turn = this.activeTurn;
        if (
          !turn ||
          turn.sequence !== this.playbackTurn ||
          turn.sessionEpoch !== this.sessionEpoch ||
          this.terminalTurns.has(turn.sequence)
        ) {
          return;
        }
        this.moveTo("speaking", turn);
        turn.timestamps.browser_playback_start ??= Date.now();
        this.touchIdleTimer();
        const sessionId = this.sessionId;
        const turnSequence = this.playbackTurn;
        if (sessionId && turnSequence !== undefined) {
          if (this.gatewayTransport) {
            void this.gatewayTransport
              .markBrowserPlaybackStarted(turnSequence)
              .catch(() => undefined);
          } else {
            void this.fetcher(
              `/api/voice/realtime/session/${encodeURIComponent(sessionId)}/playback`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  event: "browser_playback_start",
                  turnSequence
                }),
                keepalive: true
              }
            ).catch(() => undefined);
          }
        }
      }
    });
  }

  private async startWebSocketGateway() {
    const gatewayUrl = this.options.gatewayUrl;
    if (!gatewayUrl) throw new Error("voice_realtime_gateway_url_missing");
    const allowedGatewayUrl = requireDevelopmentLoopbackGatewayUrl(gatewayUrl);
    const sessionEpoch = this.sessionEpoch;
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: allowedGatewayUrl,
      session: {
        scope: this.options.scope,
        ...(this.options.uploadId ? { uploadId: this.options.uploadId } : {}),
        ...(this.options.referenceDate
          ? { referenceDate: this.options.referenceDate }
          : {}),
        ...(this.options.context ? { context: this.options.context } : {}),
        ...(this.options.conversation
          ? { conversation: [...this.options.conversation] }
          : {})
      },
      ...(this.options.webSocketFactory
        ? { webSocketFactory: this.options.webSocketFactory }
        : {}),
      reconnectDelayMs: this.reconnectDelayMs,
      onStateChange: (state) => {
        if (sessionEpoch !== this.sessionEpoch || this.stopping) return;
        if (state === "reconnecting") {
          if (this.lifecycleState !== "reconnecting") this.reconnectCount += 1;
          this.setLifecycleState("reconnecting");
          this.audioQueue?.pauseForReconnect?.();
        } else if (state === "active") {
          this.sessionId = transport.snapshot.sessionId ?? this.sessionId;
          this.setLifecycleState(this.productState);
          void this.audioQueue?.resumeAfterReconnect?.();
        } else if (state === "failed") {
          this.setLifecycleState("error");
          this.options.onError?.("voice_realtime_gateway_reconnect_exhausted");
          queueMicrotask(() => void this.stop("transport_error"));
        }
      },
      onProviderEpochChange: async () => {
        if (sessionEpoch !== this.sessionEpoch || this.stopping) return;
        await this.resetPlaybackForProviderRestart();
      },
      onEvent: async (value) => {
        if (sessionEpoch !== this.sessionEpoch || this.stopping) return;
        if (!isRecord(value) || typeof value.type !== "string") {
          throw new Error("invalid_voice_realtime_event");
        }
        const event = value as RealtimeWireEvent;
        if (event.type === "audio_chunk") {
          throw new Error("voice_realtime_gateway_audio_must_be_binary");
        }
        await this.handleEvent(event, sessionEpoch);
      },
      onAudio: async (frame) => {
        if (sessionEpoch !== this.sessionEpoch || this.stopping) return;
        this.queueAudioEvent({
          type: "audio_chunk",
          turnSequence: frame.turnSequence,
          sequence: frame.sequence,
          sentenceSequence: frame.sentenceSequence,
          sentenceChunkSequence: frame.sequence,
          providerItemId: frame.providerItemId,
          audioBase64: this.encodeBase64(frame.pcm16le)
        }, sessionEpoch);
      },
      onError: (code) => this.options.onError?.(code)
    });
    this.gatewayTransport = transport;
    await transport.connect();
    const sessionId = transport.snapshot.sessionId;
    if (!sessionId) throw new Error("invalid_voice_realtime_session");
    this.sessionId = sessionId;
  }

  private encodeBase64(value: Uint8Array) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
  }

  private startEventStream() {
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error("voice_realtime_session_missing");
    const sessionEpoch = this.sessionEpoch;
    const generation = ++this.eventStreamGeneration;
    void (async () => {
      let reconnectAttempts = 0;
      while (
        !this.stopping &&
        this.sessionId === sessionId &&
        this.eventStreamGeneration === generation
      ) {
        const controller = new AbortController();
        this.eventsAbortController = controller;
        try {
          const response = await this.fetcher(
            `/api/voice/realtime/session/${encodeURIComponent(sessionId)}/events`,
            {
              headers: { Accept: "application/x-ndjson" },
              signal: controller.signal
            }
          );
          if (!response.ok || !response.body) {
            const payload: unknown = await response.json().catch(() => undefined);
            throw new Error(errorCode(payload, "voice_realtime_events_failed"));
          }
          await this.audioQueue?.resumeAfterReconnect?.();
          this.setLifecycleState(this.productState);
          for await (const event of parseNdjson(response.body)) {
            if (controller.signal.aborted) return;
            reconnectAttempts = 0;
            if (event.type === "audio_chunk") {
              this.queueAudioEvent(event, sessionEpoch);
            } else {
              await this.handleEvent(event, sessionEpoch);
            }
          }
          if (this.stopping || controller.signal.aborted) return;
          throw new Error("voice_realtime_events_closed");
        } catch (error) {
          if (
            this.stopping ||
            this.eventStreamGeneration !== generation ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            return;
          }
          reconnectAttempts += 1;
          if (this.lifecycleState !== "reconnecting") this.reconnectCount += 1;
          this.setLifecycleState("reconnecting");
          this.audioQueue?.pauseForReconnect?.();
          if (reconnectAttempts > MAX_TRANSPORT_RECONNECT_ATTEMPTS) {
            this.options.onError?.(
              error instanceof Error
                ? error.message
                : "voice_realtime_events_failed"
            );
            this.setLifecycleState("error");
            void this.stop("transport_error");
            return;
          }
          await this.waitForReconnect(reconnectAttempts);
        } finally {
          if (this.eventsAbortController === controller) {
            this.eventsAbortController = undefined;
          }
        }
      }
    })();
  }

  private waitForReconnect(attempt: number) {
    return new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        this.reconnectDelayMs * (2 ** Math.max(0, attempt - 1))
      );
    });
  }

  private startAudioUpload() {
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error("voice_realtime_session_missing");
    const generation = ++this.uploadGeneration;
    const transport = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transport.writable.getWriter();
    this.uploadWriter = writer;
    const controller = new AbortController();
    this.uploadAbortController = controller;
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: transport.readable,
      duplex: "half",
      signal: controller.signal
    };
    const task = this.fetcher(
      `/api/voice/realtime/session/${encodeURIComponent(sessionId)}/audio`,
      init
    ).then(async (response) => {
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        throw new Error(errorCode(payload, "voice_realtime_audio_failed"));
      }
      if (!this.stopping) {
        throw new Error("voice_realtime_audio_closed");
      }
    }).catch((error: unknown) => {
      return this.handleAudioUploadFailure(generation, writer, controller, error);
    });
    this.uploadTask = task;
    void this.flushCaptureQueue();
  }

  private async handleAudioUploadFailure(
    generation: number,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    controller: AbortController,
    error: unknown
  ) {
    if (
      this.stopping ||
      generation !== this.uploadGeneration ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      return;
    }
    this.uploadGeneration += 1;
    controller.abort();
    await writer.abort().catch(() => undefined);
    if (this.uploadWriter === writer) this.uploadWriter = undefined;
    if (this.uploadAbortController === controller) {
      this.uploadAbortController = undefined;
    }
    this.uploadReconnectAttempts += 1;
    if (this.lifecycleState !== "reconnecting") this.reconnectCount += 1;
    this.setLifecycleState("reconnecting");
    if (this.uploadReconnectAttempts > MAX_TRANSPORT_RECONNECT_ATTEMPTS) {
      this.options.onError?.(
        error instanceof Error ? error.message : "voice_realtime_audio_failed"
      );
      this.setLifecycleState("error");
      void this.stop("transport_error");
      return;
    }
    const reconnecting = (async () => {
      await this.waitForReconnect(this.uploadReconnectAttempts);
      if (!this.stopping && this.sessionId) {
        this.startAudioUpload();
        this.setLifecycleState(this.productState);
      }
    })();
    this.uploadReconnectTask = reconnecting;
    try {
      await reconnecting;
    } finally {
      if (this.uploadReconnectTask === reconnecting) {
        this.uploadReconnectTask = undefined;
      }
    }
  }

  private async startCaptureWorklet() {
    if (!this.mediaStream || (!this.uploadWriter && !this.gatewayTransport)) {
      throw new Error("voice_realtime_capture_not_ready");
    }
    const CaptureContext = globalThis.AudioContext;
    this.captureContext = new CaptureContext();
    await this.captureContext.audioWorklet.addModule(REALTIME_WORKLET_URL);
    await this.captureContext.resume();
    this.captureSource = this.captureContext.createMediaStreamSource(
      this.mediaStream
    );
    this.captureNode = new AudioWorkletNode(
      this.captureContext,
      "daily-brief-voice-pcm-processor",
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      }
    );
    this.captureNode.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!(event.data instanceof ArrayBuffer) || this.stopping) return;
      this.queueCaptureChunk(new Uint8Array(event.data));
    };
    this.captureSource.connect(this.captureNode);
    this.captureNode.connect(this.captureContext.destination);
  }

  private queueCaptureChunk(chunk: Uint8Array) {
    if (this.captureQueue.length >= MAX_PENDING_CAPTURE_CHUNKS) {
      this.options.onError?.("voice_realtime_capture_backpressure");
      void this.stop();
      return;
    }
    this.captureQueue.push(chunk.slice());
    void this.flushCaptureQueue();
  }

  private flushCaptureQueue() {
    if (this.captureFlushRunning || this.stopping) return this.uploadTail;
    this.captureFlushRunning = true;
    const flushing = (async () => {
      while (!this.stopping && this.captureQueue.length > 0) {
        if (this.gatewayTransport) {
          const chunk = this.captureQueue[0]!;
          await this.gatewayTransport.sendAudio(chunk);
          this.captureQueue.shift();
          continue;
        }
        const writer = this.uploadWriter;
        const generation = this.uploadGeneration;
        const controller = this.uploadAbortController;
        if (!writer || !controller) break;
        const chunk = this.captureQueue.shift()!;
        try {
          await writer.write(chunk);
          if (generation === this.uploadGeneration) {
            this.uploadReconnectAttempts = 0;
          }
        } catch (error) {
          await this.handleAudioUploadFailure(
            generation,
            writer,
            controller,
            error
          );
          break;
        }
      }
    })().catch((error: unknown) => {
      if (!this.stopping) {
        this.options.onError?.(
          error instanceof Error
            ? error.message
            : "voice_realtime_capture_transport_failed"
        );
        this.setLifecycleState("error");
        queueMicrotask(() => void this.stop("transport_error"));
      }
    }).finally(() => {
      this.captureFlushRunning = false;
      if (
        !this.stopping &&
        this.captureQueue.length > 0 &&
        (this.uploadWriter || this.gatewayTransport)
      ) {
        void this.flushCaptureQueue();
      }
    });
    this.uploadTail = flushing;
    return flushing;
  }

  private async resetPlaybackForBargeIn() {
    const activeTurn = this.activeTurn;
    if (!this.audioQueue || this.playbackTurn === undefined) {
      if (activeTurn?.terminalReceived) {
        this.finalizeTurn(activeTurn, "interrupted", "playback_barge_in");
      }
      return;
    }
    const sessionId = this.sessionId;
    const turnSequence = this.playbackTurn;
    const position: VoiceAudioPlaybackPosition | undefined =
      this.audioQueue.playbackPosition?.();
    const queue = this.audioQueue;
    this.playbackGeneration += 1;
    this.audioQueue = undefined;
    this.playbackTurn = undefined;
    this.lastAudioSequence = 0;
    await queue.cancel().catch(() => undefined);
    if (sessionId && position) {
      if (this.gatewayTransport) {
        void this.gatewayTransport.truncatePlayback(
          turnSequence,
          position.playbackItemId,
          position.audioEndMs
        ).catch(() => undefined);
      } else {
        void this.fetcher(
          `/api/voice/realtime/session/${encodeURIComponent(sessionId)}/playback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: "truncate",
              turnSequence,
              providerItemId: position.playbackItemId,
              audioEndMs: position.audioEndMs
            }),
            keepalive: true
          }
        ).catch(() => undefined);
      }
    }
    if (activeTurn?.terminalReceived) {
      this.finalizeTurn(activeTurn, "interrupted", "playback_barge_in");
    }
  }

  private async resetPlaybackForProviderRestart() {
    this.playbackGeneration += 1;
    const queue = this.audioQueue;
    this.audioQueue = undefined;
    this.playbackTurn = undefined;
    this.lastAudioSequence = 0;
    await queue?.cancel().catch(() => undefined);
  }

  private rememberInterruptedTurn(turnSequence: number) {
    this.interruptedTurns.add(turnSequence);
    while (this.interruptedTurns.size > 16) {
      const oldest = this.interruptedTurns.values().next().value as number | undefined;
      if (oldest === undefined) break;
      this.interruptedTurns.delete(oldest);
    }
  }

  private queueAudioEvent(
    event: Extract<RealtimeWireEvent, { type: "audio_chunk" }>,
    sessionEpoch = this.sessionEpoch
  ) {
    if (
      sessionEpoch !== this.sessionEpoch ||
      this.terminalTurns.has(event.turnSequence) ||
      this.activeTurn?.sequence !== event.turnSequence
    ) {
      return;
    }
    if (this.pendingPlaybackEvents >= MAX_PENDING_PLAYBACK_EVENTS) {
      throw new Error("voice_realtime_playback_backpressure");
    }
    this.pendingPlaybackEvents += 1;
    const generation = this.playbackGeneration;
    this.playbackTail = this.playbackTail
      .then(async () => {
        if (
          this.stopping ||
          sessionEpoch !== this.sessionEpoch ||
          generation !== this.playbackGeneration ||
          this.interruptedTurns.has(event.turnSequence)
        ) {
          return;
        }
        await this.handleEvent(event, sessionEpoch);
      })
      .catch((error: unknown) => {
        if (!this.stopping && generation === this.playbackGeneration) {
          this.options.onError?.(
            error instanceof Error
              ? error.message
              : "voice_realtime_playback_failed"
          );
        }
      })
      .finally(() => {
        this.pendingPlaybackEvents = Math.max(0, this.pendingPlaybackEvents - 1);
      });
  }

  private async handleEvent(
    event: RealtimeWireEvent,
    sessionEpoch = this.sessionEpoch
  ) {
    if (sessionEpoch !== this.sessionEpoch || this.stopping) return;
    if (event.type === "session_reconnected") {
      this.setLifecycleState(this.productState);
      if (!this.activeTurn && this.productState !== "listening") {
        this.moveTo("listening");
      }
      return;
    }
    if (event.type === "latency_marker") {
      if (this.terminalTurns.has(event.turnSequence)) return;
      const turn = this.activeTurn?.sequence === event.turnSequence
        ? this.activeTurn
        : undefined;
      if (turn) {
        turn.timestamps[event.marker] = event.atMs;
      } else if (event.turnSequence > this.lastTurnSequence) {
        const telemetry = this.pendingTurnTelemetry.get(event.turnSequence) ?? {
          timestamps: {}
        };
        telemetry.timestamps[event.marker] = event.atMs;
        this.pendingTurnTelemetry.set(event.turnSequence, telemetry);
      } else {
        return;
      }
      this.options.onLatencyMarker?.({
        turnSequence: event.turnSequence,
        marker: event.marker,
        atMs: event.atMs
      });
      return;
    }
    if (event.type === "turn_trace") {
      if (this.terminalTurns.has(event.turnSequence)) return;
      if (this.activeTurn?.sequence === event.turnSequence) {
        this.activeTurn.serverTrace = event;
      } else if (event.turnSequence > this.lastTurnSequence) {
        const telemetry = this.pendingTurnTelemetry.get(event.turnSequence) ?? {
          timestamps: {}
        };
        telemetry.serverTrace = event;
        this.pendingTurnTelemetry.set(event.turnSequence, telemetry);
      }
      return;
    }
    if (event.type === "voice_activity") {
      this.touchIdleTimer();
      await this.resetPlaybackForBargeIn();
      this.moveTo("listening");
      return;
    }
    if (event.type === "asr_partial") {
      this.touchIdleTimer();
      this.options.onTranscript?.(event.transcript);
      return;
    }
    if (event.type === "asr_final") {
      const turn = this.beginTurn(event.turnSequence);
      if (!turn) return;
      this.options.onTranscript?.(event.transcript);
      return;
    }
    if (event.type === "turn_state") {
      const turn = this.activeTurn;
      if (
        !turn ||
        turn.sequence !== event.turnSequence ||
        turn.sessionEpoch !== sessionEpoch ||
        this.interruptedTurns.has(event.turnSequence) ||
        this.terminalTurns.has(event.turnSequence)
      ) return;
      if (event.state === "thinking") this.moveTo("thinking", turn);
      // `speaking` is product-visible only after browser playback actually starts.
      // Server `listening` is also held until playback has completed locally.
      return;
    }
    if (event.type === "audio_chunk") {
      const turn = this.activeTurn;
      if (
        !turn ||
        turn.sequence !== event.turnSequence ||
        turn.sessionEpoch !== sessionEpoch ||
        this.interruptedTurns.has(event.turnSequence) ||
        this.terminalTurns.has(event.turnSequence)
      ) return;
      if (this.playbackTurn !== event.turnSequence) {
        if (this.playbackTurn !== undefined) {
          return;
        }
        if (!this.audioQueue) {
          const queue = this.createAudioQueue();
          this.audioQueue = queue;
          await queue.prepare();
        }
        this.playbackTurn = event.turnSequence;
        this.lastAudioSequence = 0;
      }
      turn.audioReceived = true;
      this.lastAudioSequence = Math.max(
        this.lastAudioSequence,
        event.sequence
      );
      const queue = this.audioQueue;
      if (!queue) throw new Error("voice_realtime_playback_missing");
      await queue.enqueue({
        sequence: event.sequence,
        pcm16le: decodeBase64(event.audioBase64),
        ...(event.providerItemId
          ? { playbackItemId: event.providerItemId }
          : {})
      });
      return;
    }
    if (event.type === "answer") {
      const turn = this.activeTurn;
      if (
        !turn ||
        turn.sequence !== event.turnSequence ||
        turn.sessionEpoch !== sessionEpoch ||
        this.interruptedTurns.has(event.turnSequence) ||
        this.terminalTurns.has(event.turnSequence)
      ) return;
      this.options.onTranscript?.(event.transcript);
      this.options.onAnswer?.(event.text);
      if (event.answer) {
        turn.answer = {
          id: event.answer.id,
          question: event.transcript,
          answer: event.text,
          citedSegmentIds: event.answer.citedSegmentIds,
          citations: event.answer.citations
        };
      }
      return;
    }
    if (event.type === "turn_complete") {
      const turn = this.activeTurn;
      if (
        !turn ||
        turn.sequence !== event.turnSequence ||
        turn.sessionEpoch !== sessionEpoch ||
        turn.terminalReceived ||
        this.terminalTurns.has(event.turnSequence)
      ) return;
      turn.terminalReceived = true;
      if (event.status === "interrupted") {
        this.rememberInterruptedTurn(event.turnSequence);
      }
      if (event.status === "completed") {
        // Audio events are intentionally queued off the control-event loop so
        // VAD can preempt backpressure. Join that ordered tail only for normal
        // completion before sealing the final sequence.
        await this.playbackTail.catch(() => undefined);
      }
      if (
        event.status === "completed" &&
        this.audioQueue &&
        this.playbackTurn === event.turnSequence
      ) {
        const queue = this.audioQueue;
        const finalSequence = this.lastAudioSequence;
        const generation = this.playbackGeneration;
        void queue.finish(finalSequence).then((result) => {
          if (
            this.audioQueue === queue &&
            this.activeTurn === turn &&
            generation === this.playbackGeneration &&
            sessionEpoch === this.sessionEpoch
          ) {
            this.audioQueue = undefined;
            this.playbackTurn = undefined;
            this.lastAudioSequence = 0;
            if (result.status === "completed") {
              turn.timestamps.browser_playback_complete = Date.now();
              this.finalizeTurn(
                turn,
                "completed",
                turn.serverTrace?.terminalReason ?? "completed"
              );
            } else {
              this.options.onError?.("voice_realtime_playback_failed");
              this.finalizeTurn(turn, "failed", "playback_failed");
            }
          }
        }).catch(() => {
          if (this.activeTurn !== turn || sessionEpoch !== this.sessionEpoch) return;
          this.options.onError?.("voice_realtime_playback_failed");
          this.finalizeTurn(turn, "failed", "playback_failed");
        });
      } else if (event.status === "completed") {
        this.finalizeTurn(
          turn,
          "completed",
          turn.serverTrace?.terminalReason ?? "completed"
        );
      } else {
        this.finalizeTurn(
          turn,
          event.status,
          event.errorCode ?? turn.serverTrace?.terminalReason ?? event.status
        );
        await this.resetPlaybackForBargeIn();
      }
      if (event.errorCode) this.options.onError?.(event.errorCode);
      return;
    }
    if (event.type === "turn_interrupted") {
      if (this.activeTurn?.sequence !== event.turnSequence) return;
      this.rememberInterruptedTurn(event.turnSequence);
      if (this.playbackTurn === event.turnSequence) {
        await this.resetPlaybackForBargeIn();
      }
      this.moveTo("listening");
      return;
    }
    if (event.type === "error") {
      this.options.onError?.(event.code);
      return;
    }
    if (event.type === "session_closed" && !this.stopping) {
      this.options.onError?.("voice_realtime_session_closed");
      queueMicrotask(() => void this.stop("remote"));
    }
  }
}
