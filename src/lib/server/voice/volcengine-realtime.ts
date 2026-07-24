import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import {
  VoiceEvent,
  encodeAudioEvent,
  encodeJsonEvent,
  parseServerEvent,
  type ParsedVoiceServerEvent
} from "./events";
import { logVoiceDebug } from "./debug";
import type { VolcengineRealtimeConfig } from "./provider";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceSessionInfo,
  VoiceUnsubscribe
} from "./types";
import { VoiceProviderError } from "./types";

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MAX_TEXT_BYTES = 64 * 1024;

export type VoiceWebSocketLike = {
  readyState: number;
  binaryType: string;
  on(event: "message", listener: (data: RawData) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  once(event: "open", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  off(event: "open", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  send(data: Buffer, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
};

export type VoiceWebSocketFactory = (
  url: string,
  options: { headers: Readonly<Record<string, string>> }
) => VoiceWebSocketLike;

type Waiter = {
  resolve: (event: ParsedVoiceServerEvent) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  sessionId?: string;
};

type AdapterState =
  | "idle"
  | "connecting"
  | "connected"
  | "session"
  | "disconnected"
  | "closing"
  | "closed";

export type VolcengineRealtimeVoiceProviderOptions = {
  socketFactory?: VoiceWebSocketFactory;
  idFactory?: () => string;
};

function defaultSocketFactory(
  url: string,
  options: { headers: Readonly<Record<string, string>> }
) {
  return new WebSocket(url, { headers: options.headers }) as unknown as VoiceWebSocketLike;
}

function rawDataBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new VoiceProviderError("protocol_error", "Volcengine returned an unsupported WebSocket message type");
}

function payloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedAudioConfiguration(config: VoiceSessionConfig["audioOutput"]) {
  if (!config || config.format === "provider_default") return undefined;
  const sampleRate = config.sampleRate ?? 24_000;
  const channels = config.channels ?? 1;
  if (sampleRate !== 24_000) {
    throw new VoiceProviderError("invalid_configuration", "Volcengine PCM16 output sample rate must be 24000");
  }
  if (channels !== 1) {
    throw new VoiceProviderError("invalid_configuration", "Volcengine PCM16 output must use one channel");
  }
  return {
    format: "pcm_s16le" as const,
    sample_rate: sampleRate,
    channel: channels
  };
}

export function buildVolcengineStartSessionPayload(
  config: VoiceSessionConfig = {},
  defaults: Pick<VolcengineRealtimeConfig, "model" | "speaker"> = { model: "1.2.1.1" }
) {
  const model = config.model ?? defaults.model;
  const inputMode = config.inputMode ?? "text";
  const speaker = config.speaker?.trim() || defaults.speaker;
  if (speaker && speaker.length > 256) {
    throw new VoiceProviderError("invalid_configuration", "Volcengine TTS speaker must not exceed 256 characters");
  }
  const audioConfig = boundedAudioConfiguration(config.audioOutput);
  const tts = speaker || audioConfig
    ? {
        ...(speaker ? { speaker } : {}),
        ...(audioConfig ? { audio_config: audioConfig } : {})
      }
    : undefined;

  return {
    dialog: {
      extra: {
        ...(inputMode === "server_vad" ? {} : { input_mod: inputMode }),
        model
      }
    },
    ...(tts ? { tts } : {})
  };
}

function providerEventError(event: ParsedVoiceServerEvent) {
  return new VoiceProviderError(
    "provider_error",
    `Volcengine voice event ${event.eventName} failed`,
    event.errorCode
  );
}

function notifyCallbacks<T>(callbacks: ReadonlySet<(value: T) => void>, value: T) {
  for (const callback of callbacks) {
    try {
      callback(value);
    } catch {
      // Consumer callbacks must not break the protocol state machine.
    }
  }
}

function cloneSessionConfig(config: VoiceSessionConfig): VoiceSessionConfig {
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.inputMode ? { inputMode: config.inputMode } : {}),
    ...(config.speaker !== undefined ? { speaker: config.speaker } : {}),
    ...(config.audioOutput
      ? {
          audioOutput: config.audioOutput.format === "provider_default"
            ? { format: "provider_default" }
            : {
                format: "pcm_s16le",
                ...(config.audioOutput.sampleRate !== undefined
                  ? { sampleRate: config.audioOutput.sampleRate }
                  : {}),
                ...(config.audioOutput.channels !== undefined
                  ? { channels: config.audioOutput.channels }
                  : {})
              }
        }
      : {})
  };
}

function safeFailureReason(error: unknown) {
  return error instanceof VoiceProviderError ? error.reason : "unknown";
}

function logProviderEventShape(event: ParsedVoiceServerEvent) {
  logVoiceDebug("provider_event", {
    event_id: event.eventId,
    event_name: event.eventName,
    session_present: Boolean(event.sessionId),
    payload_present: event.payload !== undefined,
    audio_present: Boolean(event.audio),
    error_present: event.errorCode !== undefined,
    serialization: event.serialization,
    compressed: event.compressed,
    unknown: event.unknown
  });

  if (event.eventId === VoiceEvent.ASRResponse) {
    const results = payloadRecord(event.payload)?.results;
    let finalCount = 0;
    let partialCount = 0;
    let unspecifiedCount = 0;
    if (Array.isArray(results)) {
      for (const item of results) {
        const record = payloadRecord(item);
        if (record?.is_final === true || record?.is_interim === false) finalCount += 1;
        else if (record?.is_final === false || record?.is_interim === true) partialCount += 1;
        else unspecifiedCount += 1;
      }
    }
    logVoiceDebug("asr_event", {
      event_id: event.eventId,
      result_count: Array.isArray(results) ? results.length : 0,
      final_count: finalCount,
      partial_count: partialCount,
      unspecified_count: unspecifiedCount
    });
  }

  if (
    event.eventId === VoiceEvent.TTSSentenceStart ||
    event.eventId === VoiceEvent.TTSSentenceEnd ||
    event.eventId === VoiceEvent.TTSResponse ||
    event.eventId === VoiceEvent.TTSEnded
  ) {
    logVoiceDebug("tts_event", {
      event_id: event.eventId,
      audio_present: Boolean(event.audio),
      audio_bytes: event.audio?.byteLength ?? 0
    });
  }
}

export class VolcengineRealtimeVoiceProvider implements VoiceProvider {
  private readonly socketFactory: VoiceWebSocketFactory;
  private readonly idFactory: () => string;
  private readonly transcriptCallbacks = new Set<(text: string) => void>();
  private readonly audioCallbacks = new Set<(audio: Buffer) => void>();
  private readonly eventCallbacks = new Set<(event: ParsedVoiceServerEvent) => void>();
  private readonly waiters = new Map<number, Set<Waiter>>();
  private socket?: VoiceWebSocketLike;
  private sessionId?: string;
  private lastSessionConfig?: VoiceSessionConfig;
  private reconnecting?: Promise<VoiceSessionInfo>;
  private audioInputFinished = false;
  private state: AdapterState = "idle";
  private failed = false;
  private explicitlyClosed = false;

  constructor(
    private readonly config: VolcengineRealtimeConfig,
    options: VolcengineRealtimeVoiceProviderOptions = {}
  ) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async connect() {
    if (this.state === "connected" || this.state === "session") return;
    if (this.explicitlyClosed) {
      throw new VoiceProviderError("invalid_state", "Voice provider was explicitly closed");
    }
    if (this.state !== "idle") {
      throw new VoiceProviderError("invalid_state", `Voice provider cannot connect while ${this.state}`);
    }

    this.state = "connecting";
    logVoiceDebug("websocket_connecting", { state: this.state });
    const socket = this.socketFactory(this.config.endpoint, {
      headers: {
        "X-Api-App-ID": this.config.appId,
        "X-Api-Access-Key": this.config.accessKey,
        "X-Api-Resource-Id": this.config.resourceId,
        "X-Api-App-Key": this.config.appKey,
        "X-Api-Connect-Id": this.idFactory()
      }
    });
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this.attachSocket(socket);

    try {
      await this.waitForSocketOpen(socket);
      await this.sendAndWait(
        VoiceEvent.ConnectionStarted,
        encodeJsonEvent(VoiceEvent.StartConnection, {})
      );
      this.state = "connected";
      this.failed = false;
      logVoiceDebug("websocket_connected", { state: this.state });
    } catch (error) {
      this.state = "closed";
      logVoiceDebug("websocket_connect_failed", { reason: safeFailureReason(error) });
      this.rejectAll(error instanceof Error ? error : new Error("Voice connection failed"));
      this.closeSocket(socket);
      throw error;
    }
  }

  async startSession(config: VoiceSessionConfig = {}): Promise<VoiceSessionInfo> {
    if (this.state !== "connected") {
      throw new VoiceProviderError("invalid_state", "Voice provider must be connected before starting a session");
    }
    const sessionId = this.idFactory();
    const payload = buildVolcengineStartSessionPayload(config, this.config);
    const debugFields = {
      message_type: "StartSession",
      payload_keys: Object.keys(payload).sort().join(",")
    } as const;
    logVoiceDebug("start_session_payload_prepared", debugFields);
    const frame = encodeJsonEvent(
      VoiceEvent.StartSession,
      payload,
      { sessionId }
    );
    const encodedFrameSize = frame.byteLength;
    logVoiceDebug("start_session_frame_encoded", {
      ...debugFields,
      encoded_frame_size: encodedFrameSize
    });
    const event = await this.sendAndWait(
      VoiceEvent.SessionStarted,
      frame,
      sessionId,
      (sendSuccess) => logVoiceDebug("start_session_send_settled", {
        ...debugFields,
        encoded_frame_size: encodedFrameSize,
        send_success: sendSuccess
      })
    );
    if (event.sessionId && event.sessionId !== sessionId) {
      throw new VoiceProviderError("protocol_error", "Volcengine returned a mismatched voice session ID");
    }
    this.sessionId = sessionId;
    this.lastSessionConfig = cloneSessionConfig(config);
    this.audioInputFinished = false;
    this.state = "session";
    const dialogId = payloadRecord(event.payload)?.dialog_id;
    return {
      sessionId,
      ...(typeof dialogId === "string" && dialogId.trim() ? { dialogId } : {})
    };
  }

  async reconnect(): Promise<VoiceSessionInfo> {
    if (this.reconnecting) return await this.reconnecting;
    const reconnecting = this.performReconnect();
    this.reconnecting = reconnecting;
    try {
      return await reconnecting;
    } finally {
      if (this.reconnecting === reconnecting) this.reconnecting = undefined;
    }
  }

  async sendAudio(chunk: Buffer) {
    const sessionId = this.requireSession();
    if (this.audioInputFinished) {
      throw new VoiceProviderError("invalid_state", "Voice audio input has already finished");
    }
    if (!Buffer.isBuffer(chunk) || chunk.byteLength === 0) {
      throw new VoiceProviderError("invalid_request", "Voice audio chunk must be a non-empty Buffer");
    }
    await this.sendFrame(encodeAudioEvent(VoiceEvent.TaskRequest, chunk, { sessionId }));
  }

  async finishAudioInput() {
    const sessionId = this.requireSession();
    if (this.lastSessionConfig?.inputMode !== "push_to_talk") {
      throw new VoiceProviderError(
        "invalid_state",
        "Voice audio input can only be explicitly finished in push-to-talk mode"
      );
    }
    if (this.audioInputFinished) {
      throw new VoiceProviderError("invalid_state", "Voice audio input has already finished");
    }
    const frame = encodeJsonEvent(VoiceEvent.EndASR, {}, { sessionId });
    const debugFields = {
      message_type: "EndASR",
      encoded_frame_size: frame.byteLength
    } as const;
    logVoiceDebug("end_asr_frame_encoded", debugFields);
    try {
      await this.sendFrame(frame);
      this.audioInputFinished = true;
      logVoiceDebug("end_asr_send_settled", {
        ...debugFields,
        send_success: true
      });
    } catch (error) {
      logVoiceDebug("end_asr_send_settled", {
        ...debugFields,
        send_success: false
      });
      throw error;
    }
  }

  async sendText(text: string) {
    const sessionId = this.requireSession();
    if (!text.trim()) {
      throw new VoiceProviderError("invalid_request", "Voice text must not be empty");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      throw new VoiceProviderError("invalid_request", `Voice text must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes`);
    }

    const contentFrame = encodeJsonEvent(
      VoiceEvent.ChatTTSText,
      { start: true, content: text, end: false },
      { sessionId }
    );
    await this.sendChatTtsTextFrame(contentFrame, {
      frame_role: "start_content",
      start: true,
      end: false
    });
    const endFrame = encodeJsonEvent(
      VoiceEvent.ChatTTSText,
      { start: false, content: "", end: true },
      { sessionId }
    );
    await this.sendChatTtsTextFrame(endFrame, {
      frame_role: "end",
      start: false,
      end: true
    });
  }

  async finishSession() {
    if (this.state === "connected") return;
    const sessionId = this.requireSession();
    await this.sendAndWait(
      VoiceEvent.SessionFinished,
      encodeJsonEvent(VoiceEvent.FinishSession, {}, { sessionId }),
      sessionId
    );
    this.sessionId = undefined;
    this.audioInputFinished = false;
    this.state = "connected";
  }

  onTranscript(callback: (text: string) => void): VoiceUnsubscribe {
    this.transcriptCallbacks.add(callback);
    return () => this.transcriptCallbacks.delete(callback);
  }

  onAudio(callback: (audio: Buffer) => void): VoiceUnsubscribe {
    this.audioCallbacks.add(callback);
    return () => this.audioCallbacks.delete(callback);
  }

  onEvent(callback: (event: ParsedVoiceServerEvent) => void): VoiceUnsubscribe {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  async close() {
    this.explicitlyClosed = true;
    this.lastSessionConfig = undefined;
    if (this.state === "closed") {
      this.clearCallbacks();
      return;
    }
    const socket = this.socket;
    if (!socket) {
      this.state = "closed";
      this.clearCallbacks();
      return;
    }
    const previousState = this.state;
    if (previousState === "session" && !this.failed && socket.readyState === OPEN) {
      await this.finishSession().catch(() => undefined);
    }
    this.state = "closing";
    if (socket.readyState === OPEN) {
      await this.sendFrame(encodeJsonEvent(VoiceEvent.FinishConnection, {})).catch(() => undefined);
    }
    await this.waitForSocketClose(socket);
    this.state = "closed";
    this.sessionId = undefined;
    this.rejectAll(new VoiceProviderError("connection_closed", "Voice provider was closed"));
    this.clearCallbacks();
  }

  private attachSocket(socket: VoiceWebSocketLike) {
    socket.on("message", (raw) => {
      if (this.socket !== socket) return;
      try {
        this.handleEvent(parseServerEvent(rawDataBuffer(raw)));
      } catch {
        logVoiceDebug("websocket_message_invalid", { state: this.state });
        const error = new VoiceProviderError("protocol_error", "Volcengine returned an invalid binary voice frame");
        this.notifyInternalFailure(error);
      }
    });
    socket.on("error", () => {
      if (this.socket !== socket) return;
      logVoiceDebug("websocket_error", { state: this.state });
      const error = new VoiceProviderError("connection_failed", "Volcengine voice WebSocket failed");
      this.notifyInternalFailure(error);
    });
    socket.on("close", (code) => {
      if (this.socket !== socket) return;
      logVoiceDebug("websocket_closed", {
        code,
        expected: this.state === "closing" || this.state === "closed",
        state: this.state
      });
      if (this.state !== "closing" && this.state !== "closed") {
        const error = new VoiceProviderError("connection_closed", "Volcengine voice WebSocket closed unexpectedly");
        this.notifyInternalFailure(error);
      }
    });
  }

  private handleEvent(event: ParsedVoiceServerEvent) {
    logProviderEventShape(event);
    notifyCallbacks(this.eventCallbacks, event);

    if (event.eventId === VoiceEvent.TTSResponse && event.audio) {
      notifyCallbacks(this.audioCallbacks, Buffer.from(event.audio));
    }

    if (event.eventId === VoiceEvent.ChatResponse) {
      const content = payloadRecord(event.payload)?.content;
      if (typeof content === "string" && content.trim()) {
        notifyCallbacks(this.transcriptCallbacks, content);
      }
    } else if (event.eventId === VoiceEvent.ASRResponse) {
      const results = payloadRecord(event.payload)?.results;
      if (Array.isArray(results)) {
        for (const item of results) {
          const text = payloadRecord(item)?.text;
          if (typeof text === "string" && text.trim()) {
            notifyCallbacks(this.transcriptCallbacks, text);
          }
        }
      }
    }

    if (
      event.errorCode !== undefined ||
      event.eventId === VoiceEvent.ConnectionFailed ||
      event.eventId === VoiceEvent.SessionFailed ||
      event.eventId === VoiceEvent.DialogCommonError
    ) {
      this.failed = true;
      this.rejectAll(providerEventError(event));
      return;
    }

    const waiters = this.waiters.get(event.eventId);
    if (!waiters) return;
    const matching = [...waiters].filter((waiter) => !waiter.sessionId || waiter.sessionId === event.sessionId);
    for (const waiter of matching) {
      waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    }
    if (waiters.size === 0) this.waiters.delete(event.eventId);
  }

  private waitForEvent(eventId: number, timeoutMs: number, sessionId?: string) {
    return new Promise<ParsedVoiceServerEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.waiters.get(eventId);
        if (waiters) {
          for (const waiter of waiters) {
            if (waiter.timeout === timeout) waiters.delete(waiter);
          }
          if (waiters.size === 0) this.waiters.delete(eventId);
        }
        reject(new VoiceProviderError("timeout", `Voice event ${eventId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter: Waiter = { resolve, reject, timeout, ...(sessionId ? { sessionId } : {}) };
      const waiters = this.waiters.get(eventId) ?? new Set<Waiter>();
      waiters.add(waiter);
      this.waiters.set(eventId, waiters);
    });
  }

  private async sendAndWait(
    eventId: number,
    frame: Buffer,
    sessionId?: string,
    onSendSettled?: (success: boolean) => void
  ) {
    const event = this.waitForEvent(eventId, this.config.eventTimeoutMs, sessionId);
    try {
      await this.sendFrame(frame);
      onSendSettled?.(true);
    } catch (error) {
      onSendSettled?.(false);
      const normalized = error instanceof Error ? error : new Error("Voice WebSocket send failed");
      this.rejectAll(normalized);
      await event.catch(() => undefined);
      throw normalized;
    }
    return await event;
  }

  private async sendChatTtsTextFrame(
    frame: Buffer,
    fields: {
      frame_role: "start_content" | "end";
      start: boolean;
      end: boolean;
    }
  ) {
    const debugFields = {
      message_type: "ChatTTSText",
      ...fields,
      encoded_frame_size: frame.byteLength
    } as const;
    logVoiceDebug("chat_tts_text_frame_encoded", debugFields);
    try {
      await this.sendFrame(frame);
      logVoiceDebug("chat_tts_text_send_settled", {
        ...debugFields,
        send_success: true
      });
    } catch (error) {
      logVoiceDebug("chat_tts_text_send_settled", {
        ...debugFields,
        send_success: false
      });
      throw error;
    }
  }

  private waitForSocketOpen(socket: VoiceWebSocketLike) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new VoiceProviderError(
          "timeout",
          `Volcengine voice WebSocket did not open within ${this.config.connectTimeoutMs}ms`
        ));
      }, this.config.connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("open", handleOpen);
        socket.off("error", handleError);
        socket.off("close", handleClose);
      };
      const handleOpen = () => {
        cleanup();
        logVoiceDebug("websocket_open", { state: this.state });
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new VoiceProviderError("connection_failed", "Volcengine voice WebSocket failed to open"));
      };
      const handleClose = () => {
        cleanup();
        reject(new VoiceProviderError("connection_closed", "Volcengine voice WebSocket closed before opening"));
      };
      socket.once("open", handleOpen);
      socket.once("error", handleError);
      socket.once("close", handleClose);
    });
  }

  private sendFrame(frame: Buffer) {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      throw new VoiceProviderError(
        this.explicitlyClosed ? "invalid_state" : "connection_closed",
        "Voice WebSocket is not open"
      );
    }
    return new Promise<void>((resolve, reject) => {
      socket.send(frame, (error) => {
        if (error) reject(new VoiceProviderError("connection_failed", "Voice WebSocket send failed"));
        else resolve();
      });
    });
  }

  private requireSession() {
    if (this.state === "disconnected" && !this.explicitlyClosed) {
      throw new VoiceProviderError("connection_closed", "Voice connection is unavailable");
    }
    if (this.state !== "session" || !this.sessionId) {
      throw new VoiceProviderError("invalid_state", "Voice session has not started");
    }
    return this.sessionId;
  }

  private rejectAll(error: Error) {
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }

  private notifyInternalFailure(error: VoiceProviderError) {
    const firstFailure = this.state !== "disconnected";
    this.failed = true;
    if (this.state !== "closing" && this.state !== "closed") {
      this.state = "disconnected";
      this.sessionId = undefined;
    }
    logVoiceDebug("provider_internal_failure", {
      reason: error.reason,
      first_failure: firstFailure,
      state: this.state
    });
    if (!firstFailure) {
      this.rejectAll(error);
      return;
    }
    const event: ParsedVoiceServerEvent = {
      eventId: VoiceEvent.DialogCommonError,
      eventName: "Error",
      rawPayload: Buffer.alloc(0),
      compressed: false,
      serialization: "none",
      unknown: false,
      internalFailureReason: error.reason === "connection_closed"
        ? "connection_closed"
        : error.reason === "protocol_error"
          ? "protocol_error"
          : "connection_failed"
    };
    notifyCallbacks(this.eventCallbacks, event);
    this.rejectAll(error);
  }

  private async performReconnect(): Promise<VoiceSessionInfo> {
    if (this.explicitlyClosed) {
      throw new VoiceProviderError("invalid_state", "Voice provider was explicitly closed");
    }
    if (!this.lastSessionConfig) {
      throw new VoiceProviderError("invalid_state", "Voice provider has no prior session to restore");
    }

    const sessionConfig = cloneSessionConfig(this.lastSessionConfig);
    const previousSocket = this.socket;
    this.socket = undefined;
    this.sessionId = undefined;
    this.rejectAll(new VoiceProviderError("connection_closed", "Voice connection is being restored"));
    if (previousSocket) this.closeSocket(previousSocket);
    this.state = "idle";
    this.failed = false;
    logVoiceDebug("websocket_reconnect_started", { previous_socket_present: Boolean(previousSocket) });

    try {
      await this.connect();
      const session = await this.startSession(sessionConfig);
      logVoiceDebug("websocket_reconnect_completed", { session_restored: true });
      return session;
    } catch (error) {
      logVoiceDebug("websocket_reconnect_failed", { reason: safeFailureReason(error) });
      throw error;
    }
  }

  private clearCallbacks() {
    this.transcriptCallbacks.clear();
    this.audioCallbacks.clear();
    this.eventCallbacks.clear();
  }

  private async waitForSocketClose(socket: VoiceWebSocketLike) {
    if (socket.readyState === CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        socket.terminate?.();
        finish();
      }, 2_000);
      socket.once("close", finish);
      if (socket.readyState < CLOSING) socket.close(1000, "client closing");
    });
  }

  private closeSocket(socket: VoiceWebSocketLike) {
    if (socket.readyState < CLOSING) socket.close(1011, "connection failed");
    else if (socket.readyState !== CLOSED) socket.terminate?.();
  }
}
