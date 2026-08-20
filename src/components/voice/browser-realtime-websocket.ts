"use client";

import { z } from "zod";

import {
  REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2,
  decodeRealtimeVoiceGatewayAudioFrameV2,
  encodeRealtimeVoiceGatewayAudioFrameV2,
  type RealtimeVoiceGatewayAudioFrameV2,
  type RealtimeVoiceGatewayClientControlV2,
  type RealtimeVoiceGatewayServerControlV2,
  type RealtimeVoiceGatewaySessionStartV2
} from "@/lib/voice-realtime-gateway";

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const APPLICATION_PROTOCOL_CLOSE_CODE = 4003;
const APPLICATION_CONNECTION_FAILURE_CLOSE_CODE = 4004;
const APPLICATION_TRANSPORT_FAILURE_CLOSE_CODE = 4005;
// Keep this aligned with the gateway's bounded pending-frame window. Canonical
// retrieval still contains short synchronous sections, so a two-second client
// window can otherwise tear down an otherwise healthy realtime session while
// the server event loop is temporarily occupied.
const DEFAULT_MAX_UNACKED_AUDIO_FRAMES = 250;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_DELAY_MS = 150;
const MAX_SOCKET_BUFFERED_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

export type BrowserWebSocketLike = Pick<
  WebSocket,
  | "binaryType"
  | "bufferedAmount"
  | "readyState"
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
>;

export type BrowserWebSocketFactory = (
  url: string,
  protocols: string | string[]
) => BrowserWebSocketLike;

export type BrowserRealtimeWebSocketState =
  | "connecting"
  | "active"
  | "reconnecting"
  | "closed"
  | "failed";

export type BrowserRealtimeVoiceWebSocketOptions = {
  url: string;
  session: Omit<RealtimeVoiceGatewaySessionStartV2, "type" | "version">;
  webSocketFactory?: BrowserWebSocketFactory;
  readyTimeoutMs?: number;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  maxUnackedAudioFrames?: number;
  onStateChange?: (state: BrowserRealtimeWebSocketState) => unknown;
  onEvent?: (event: unknown) => unknown;
  onAudio?: (
    frame: Extract<RealtimeVoiceGatewayAudioFrameV2, { kind: "output_pcm" }>
  ) => unknown;
  onProviderEpochChange?: (providerEpoch: number, previousEpoch?: number) => unknown;
  onError?: (code: string) => unknown;
};

type PendingAudio = {
  sequence: number;
  encoded: Uint8Array;
};

const ServerControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    version: z.literal(2),
    sessionId: z.string().uuid(),
    connectionId: z.string().min(1),
    resumed: z.boolean(),
    inputEpoch: z.number().int().positive(),
    providerEpoch: z.number().int().positive(),
    inputAckThrough: z.number().int().min(0),
    replayFrom: z.number().int().positive(),
    serverSequence: z.number().int().min(0)
  }).strict(),
  z.object({
    type: z.literal("input_ack"),
    throughSequence: z.number().int().min(0)
  }).strict(),
  z.object({
    type: z.literal("event"),
    serverSequence: z.number().int().positive(),
    name: z.string().min(1),
    event: z.unknown()
  }).strict(),
  z.object({
    type: z.literal("command_ack"),
    commandId: z.string().min(1),
    status: z.enum(["applied", "already_applied", "stale", "rejected"])
  }).strict(),
  z.object({ type: z.literal("pong"), nonce: z.string() }).strict(),
  z.object({
    type: z.literal("resync_required"),
    reason: z.enum(["replay_expired", "session_lost", "provider_restarted"])
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1),
    fatal: z.boolean()
  }).strict()
]);

function safeJson(value: unknown): RealtimeVoiceGatewayServerControlV2 | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = ServerControlSchema.safeParse(parsed);
    return result.success
      ? result.data as RealtimeVoiceGatewayServerControlV2
      : undefined;
  } catch {
    return undefined;
  }
}

function messageDataBytes(value: unknown) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function commandId() {
  return globalThis.crypto?.randomUUID?.() ??
    `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Development-only v2 browser transport. It owns only delivery/reconnect
 * state; microphone capture, canonical QA, evidence, and playback remain in
 * their existing layers.
 */
export class BrowserRealtimeVoiceWebSocketTransport {
  private readonly options: BrowserRealtimeVoiceWebSocketOptions;
  private readonly webSocketFactory: BrowserWebSocketFactory;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly maxUnackedAudioFrames: number;
  private socket?: BrowserWebSocketLike;
  private sessionId?: string;
  private connectionId?: string;
  private inputEpoch = 1;
  private providerEpoch?: number;
  private nextInputSequence = 1;
  private inputAckThrough = 0;
  private serverAckThrough = 0;
  private pendingAudio = new Map<number, PendingAudio>();
  private pendingCommands = new Map<string, RealtimeVoiceGatewayClientControlV2>();
  private commandWaiters = new Map<string, () => void>();
  private processing = Promise.resolve();
  private outgoing = Promise.resolve();
  private reconnectTask?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimerResolve?: () => void;
  private reconnectAttempts = 0;
  private explicitClose = false;
  private generation = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPongAt = 0;

  constructor(options: BrowserRealtimeVoiceWebSocketOptions) {
    this.options = options;
    this.webSocketFactory = options.webSocketFactory ??
      ((url, protocols) => new WebSocket(url, protocols));
    this.reconnectDelayMs = Math.max(
      0,
      Math.min(5_000, options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS)
    );
    this.maxReconnectAttempts = Math.max(
      0,
      Math.min(10, options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS)
    );
    this.maxUnackedAudioFrames = Math.max(
      1,
      Math.min(
        500,
        options.maxUnackedAudioFrames ?? DEFAULT_MAX_UNACKED_AUDIO_FRAMES
      )
    );
  }

  get snapshot() {
    return {
      sessionId: this.sessionId,
      connectionId: this.connectionId,
      inputEpoch: this.inputEpoch,
      providerEpoch: this.providerEpoch,
      inputAckThrough: this.inputAckThrough,
      serverAckThrough: this.serverAckThrough,
      unackedAudioFrames: this.pendingAudio.size
    };
  }

  async connect() {
    if (this.socket || this.explicitClose) {
      throw new Error("voice_realtime_gateway_invalid_state");
    }
    this.options.onStateChange?.("connecting");
    await this.openSocket(false);
  }

  async sendAudio(pcm16le: Uint8Array, timestampMs = Date.now()) {
    if (this.explicitClose || !this.sessionId) {
      throw new Error("voice_realtime_gateway_not_ready");
    }
    if (this.pendingAudio.size >= this.maxUnackedAudioFrames) {
      throw new Error("voice_realtime_gateway_input_backpressure");
    }
    const sequence = this.nextInputSequence++;
    const encoded = encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "input_pcm",
      inputEpoch: this.inputEpoch,
      sequence,
      timestampMs,
      pcm16le
    });
    this.pendingAudio.set(sequence, { sequence, encoded });
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        await this.enqueueSend(encoded);
      } catch (error) {
        this.failSocket(error);
      }
    }
    return sequence;
  }

  async startTurn() {
    return await this.sendCommand({
      type: "start_turn",
      commandId: commandId()
    });
  }

  async interrupt(turnSequence?: number) {
    return await this.sendCommand({
      type: "interrupt",
      commandId: commandId(),
      ...(turnSequence !== undefined ? { turnSequence } : {})
    });
  }

  async markBrowserPlaybackStarted(turnSequence: number) {
    return await this.sendCommand({
      type: "browser_playback_start",
      commandId: commandId(),
      turnSequence
    });
  }

  async truncatePlayback(
    turnSequence: number,
    providerItemId: string,
    audioEndMs: number
  ) {
    return await this.sendCommand({
      type: "conversation_truncate",
      commandId: commandId(),
      turnSequence,
      providerItemId,
      audioEndMs
    });
  }

  async close() {
    if (this.explicitClose) return;
    this.explicitClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectTimerResolve?.();
    this.reconnectTimerResolve = undefined;
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      const closeCommandId = commandId();
      const message: RealtimeVoiceGatewayClientControlV2 = {
        type: "session_close",
        commandId: closeCommandId
      };
      this.pendingCommands.set(closeCommandId, message);
      const acknowledged = new Promise<void>((resolve) => {
        this.commandWaiters.set(closeCommandId, resolve);
      });
      socket.send(JSON.stringify(message));
      await Promise.race([
        acknowledged,
        new Promise<void>((resolve) => setTimeout(resolve, 300))
      ]);
      this.commandWaiters.delete(closeCommandId);
    }
    this.generation += 1;
    socket?.close(1000, "client_close");
    this.socket = undefined;
    this.reconnectTask = undefined;
    this.pendingAudio.clear();
    this.pendingCommands.clear();
    this.commandWaiters.clear();
    this.options.onStateChange?.("closed");
  }

  private async sendCommand(message: RealtimeVoiceGatewayClientControlV2) {
    if (!("commandId" in message) || !message.commandId) {
      throw new Error("voice_realtime_gateway_command_id_required");
    }
    if (!this.sessionId || this.explicitClose) {
      throw new Error("voice_realtime_gateway_not_ready");
    }
    this.pendingCommands.set(message.commandId, message);
    await this.sendJson(message);
    return message.commandId;
  }

  private async openSocket(resume: boolean) {
    const generation = ++this.generation;
    const socket = this.webSocketFactory(
      this.options.url,
      REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        const error = new Error("voice_realtime_gateway_ready_timeout");
        finish(error);
        if (generation === this.generation && socket === this.socket) {
          this.options.onError?.(error.message);
          socket.close(4002, "ready_timeout");
        }
      }, Math.max(1_000, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS));
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      const isCurrent = () =>
        generation === this.generation && socket === this.socket;
      const handleOpen = () => {
        if (!isCurrent()) return;
        const message: RealtimeVoiceGatewayClientControlV2 = resume && this.sessionId
          ? {
              type: "session_resume",
              version: 2,
              sessionId: this.sessionId,
              lastInputAck: this.inputAckThrough,
              lastServerAck: this.serverAckThrough
            }
          : {
              type: "session_start",
              version: 2,
              ...this.options.session
            };
        socket.send(JSON.stringify(message));
      };
      const handleMessage = (event: MessageEvent<unknown>) => {
        if (!isCurrent()) return;
        this.processing = this.processing
          .then(async () => {
            if (!isCurrent()) return;
            const ready = await this.handleMessage(event.data);
            if (ready) finish();
          })
          .catch((error: unknown) => {
            if (!isCurrent()) return;
            const normalized = error instanceof Error
              ? error
              : new Error("voice_realtime_gateway_protocol_error");
            this.options.onError?.(normalized.message);
            finish(normalized);
            socket.close(APPLICATION_PROTOCOL_CLOSE_CODE, "protocol_error");
          });
      };
      const handleError = () => {
        if (!isCurrent()) return;
        const error = new Error("voice_realtime_gateway_connection_failed");
        this.options.onError?.(error.message);
        finish(error);
        socket.close(APPLICATION_CONNECTION_FAILURE_CLOSE_CODE, "connection_failed");
      };
      const handleClose = () => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("message", handleMessage as EventListener);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
        if (!isCurrent()) return;
        this.stopHeartbeat();
        this.socket = undefined;
        if (!settled) finish(new Error("voice_realtime_gateway_connection_closed"));
        if (!this.explicitClose) {
          this.scheduleReconnect();
        }
      };
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("message", handleMessage as EventListener);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
    });
  }

  private async handleMessage(data: unknown) {
    const bytes = messageDataBytes(data);
    if (bytes) {
      const frame = decodeRealtimeVoiceGatewayAudioFrameV2(bytes);
      if (frame.kind !== "output_pcm") {
        throw new Error("voice_realtime_gateway_unexpected_input_frame");
      }
      if (frame.serverSequence <= this.serverAckThrough) {
        await this.ackServer(frame.serverSequence);
        return false;
      }
      if (frame.serverSequence !== this.serverAckThrough + 1) {
        throw new Error("voice_realtime_gateway_server_sequence_gap");
      }
      if (this.providerEpoch === undefined) {
        throw new Error("voice_realtime_gateway_provider_epoch_missing");
      }
      if (frame.providerEpoch > this.providerEpoch) {
        throw new Error("voice_realtime_gateway_provider_epoch_ahead");
      }
      if (frame.providerEpoch < this.providerEpoch) {
        // A replayed frame from the retired Provider is deliberately consumed
        // only at the transport cursor. It is never admitted to playback.
        this.serverAckThrough = frame.serverSequence;
        await this.ackServer(frame.serverSequence);
        return false;
      }
      await this.options.onAudio?.(frame);
      this.serverAckThrough = frame.serverSequence;
      await this.ackServer(frame.serverSequence);
      return false;
    }

    const message = safeJson(data);
    if (!message) throw new Error("voice_realtime_gateway_invalid_json");
    if (message.type === "ready") {
      const epochChanged = message.inputEpoch !== this.inputEpoch;
      if (!epochChanged) {
        if (message.inputAckThrough < this.inputAckThrough) {
          throw new Error("voice_realtime_gateway_input_ack_regressed");
        }
        if (message.inputAckThrough >= this.nextInputSequence) {
          throw new Error("voice_realtime_gateway_input_ack_ahead");
        }
      }
      if (message.replayFrom > this.serverAckThrough + 1) {
        throw new Error("voice_realtime_gateway_replay_cursor_gap");
      }
      if (message.serverSequence < message.replayFrom - 1) {
        throw new Error("voice_realtime_gateway_server_cursor_invalid");
      }
      this.sessionId = message.sessionId;
      this.connectionId = message.connectionId;
      if (epochChanged) {
        this.inputEpoch = message.inputEpoch;
        this.nextInputSequence = 1;
        this.inputAckThrough = 0;
        this.pendingAudio.clear();
        this.pendingCommands.clear();
      }
      const previousProviderEpoch = this.providerEpoch;
      if (
        previousProviderEpoch !== undefined &&
        message.providerEpoch < previousProviderEpoch
      ) {
        throw new Error("voice_realtime_gateway_provider_epoch_regressed");
      }
      this.providerEpoch = message.providerEpoch;
      if (
        previousProviderEpoch !== undefined &&
        previousProviderEpoch !== message.providerEpoch
      ) {
        this.pendingCommands.clear();
        await this.options.onProviderEpochChange?.(
          message.providerEpoch,
          previousProviderEpoch
        );
      }
      this.inputAckThrough = message.inputAckThrough;
      this.serverAckThrough = Math.max(
        this.serverAckThrough,
        message.replayFrom - 1
      );
      for (const sequence of this.pendingAudio.keys()) {
        if (sequence <= message.inputAckThrough) this.pendingAudio.delete(sequence);
      }
      await this.replayPending();
      this.reconnectAttempts = 0;
      this.options.onStateChange?.("active");
      this.startHeartbeat();
      return true;
    }
    if (message.type === "input_ack") {
      if (message.throughSequence < this.inputAckThrough) return false;
      if (message.throughSequence >= this.nextInputSequence) {
        throw new Error("voice_realtime_gateway_input_ack_ahead");
      }
      this.inputAckThrough = message.throughSequence;
      for (const sequence of this.pendingAudio.keys()) {
        if (sequence <= message.throughSequence) this.pendingAudio.delete(sequence);
      }
      return false;
    }
    if (message.type === "event") {
      if (message.serverSequence <= this.serverAckThrough) {
        await this.ackServer(message.serverSequence);
        return false;
      }
      if (message.serverSequence !== this.serverAckThrough + 1) {
        throw new Error("voice_realtime_gateway_server_sequence_gap");
      }
      await this.options.onEvent?.(message.event);
      this.serverAckThrough = message.serverSequence;
      await this.ackServer(message.serverSequence);
      return false;
    }
    if (message.type === "command_ack") {
      this.pendingCommands.delete(message.commandId);
      this.commandWaiters.get(message.commandId)?.();
      this.commandWaiters.delete(message.commandId);
      return false;
    }
    if (message.type === "pong") {
      this.lastPongAt = Date.now();
      return false;
    }
    if (message.type === "resync_required") {
      throw new Error(`voice_realtime_gateway_${message.reason}`);
    }
    if (message.type === "error") {
      this.options.onError?.(message.code);
      if (message.fatal) throw new Error(message.code);
    }
    return false;
  }

  private async ackServer(throughSequence: number) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    await this.sendJson({ type: "server_ack", throughSequence });
  }

  private async replayPending() {
    for (const pending of [...this.pendingAudio.values()]
      .sort((left, right) => left.sequence - right.sequence)) {
      if (pending.sequence > this.inputAckThrough) {
        await this.sendWhenWritable(pending.encoded);
      }
    }
    for (const command of this.pendingCommands.values()) {
      await this.sendJson(command);
    }
  }

  private async sendJson(message: RealtimeVoiceGatewayClientControlV2) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    await this.enqueueSend(JSON.stringify(message));
  }

  private enqueueSend(value: string | Uint8Array) {
    const socket = this.socket;
    const generation = this.generation;
    const sending = this.outgoing.then(() =>
      this.sendWhenWritable(value, socket, generation)
    );
    this.outgoing = sending.catch(() => undefined);
    return sending;
  }

  private async sendWhenWritable(
    value: string | Uint8Array,
    socket = this.socket,
    generation = this.generation
  ) {
    if (
      !socket ||
      socket !== this.socket ||
      generation !== this.generation ||
      socket.readyState !== WebSocket.OPEN
    ) return;
    const startedAt = Date.now();
    while (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      if (Date.now() - startedAt > 5_000) {
        throw new Error("voice_realtime_gateway_socket_backpressure");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (
        socket !== this.socket ||
        generation !== this.generation ||
        socket.readyState !== WebSocket.OPEN
      ) return;
    }
    socket.send(value);
  }

  private failSocket(error: unknown) {
    const code = error instanceof Error
      ? error.message
      : "voice_realtime_gateway_connection_failed";
    this.options.onError?.(code);
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(APPLICATION_TRANSPORT_FAILURE_CLOSE_CODE, "transport_failure");
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTask || this.explicitClose) return;
    const reconnecting = (async () => {
      this.reconnectAttempts += 1;
      if (this.reconnectAttempts > this.maxReconnectAttempts) {
        this.options.onStateChange?.("failed");
        this.options.onError?.("voice_realtime_gateway_reconnect_exhausted");
        return;
      }
      this.options.onStateChange?.("reconnecting");
      await new Promise<void>((resolve) => {
        this.reconnectTimerResolve = resolve;
        this.reconnectTimer = setTimeout(
          resolve,
          this.reconnectDelayMs * (2 ** (this.reconnectAttempts - 1))
        );
      });
      this.reconnectTimer = undefined;
      this.reconnectTimerResolve = undefined;
      if (!this.explicitClose) await this.openSocket(true);
    })().catch((error: unknown) => {
      if (!this.explicitClose) {
        this.options.onError?.(
          error instanceof Error ? error.message : "voice_realtime_gateway_reconnect_failed"
        );
        this.reconnectTask = undefined;
        this.scheduleReconnect();
      }
    }).finally(() => {
      if (this.reconnectTask === reconnecting) this.reconnectTask = undefined;
    });
    this.reconnectTask = reconnecting;
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        socket.close(4002, "heartbeat_timeout");
        return;
      }
      void this.sendJson({
        type: "ping",
        nonce: `${Date.now()}`
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}
