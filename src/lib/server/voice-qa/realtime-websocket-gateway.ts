import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";

import {
  MAX_VOICE_QA_CONTEXT_BYTES,
  VoiceQaContextSchema,
  type VoiceQaContext
} from "@/lib/domain/voice-qa-context";
import {
  REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2,
  decodeRealtimeVoiceGatewayAudioFrameV2,
  encodeRealtimeVoiceGatewayAudioFrameV2,
  type RealtimeVoiceGatewayClientControlV2,
  type RealtimeVoiceGatewayServerControlV2
} from "@/lib/voice-realtime-gateway";
import type { JsonStore } from "@/lib/server/storage/json-store";

import type { RealtimeVoiceQaEvent } from "./realtime-controller";
import {
  MemoryRealtimeVoiceSessionStore,
  RealtimeVoiceSessionStoreError,
  type RealtimeVoiceConnectionFence,
  type RealtimeVoiceOutboundFrame,
  type SessionStore
} from "./realtime-session-store";
import type { VoiceQaConversationMessage } from "./types";

export const REALTIME_VOICE_GATEWAY_PATH = "/api/voice/realtime/gateway";

const MAX_GATEWAY_CONTROL_BYTES = MAX_VOICE_QA_CONTEXT_BYTES + 64 * 1024;
const MAX_PENDING_INPUT_FRAMES = 250;
const MAX_PENDING_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 2 * 1024 * 1024;
const READY_TIMEOUT_MS = 10_000;
const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

const ConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(20_000)
}).strict();

const ClientControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_start"),
    version: z.literal(2),
    scope: z.enum(["current", "week", "all"]),
    uploadId: z.string().min(1).max(200).regex(STORE_KEY_PATTERN).optional(),
    referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    context: VoiceQaContextSchema.optional(),
    conversation: ConversationMessageSchema.array().max(8).optional()
  }).strict(),
  z.object({
    type: z.literal("session_resume"),
    version: z.literal(2),
    sessionId: z.string().uuid(),
    lastInputAck: z.number().int().min(0),
    lastServerAck: z.number().int().min(0)
  }).strict(),
  z.object({
    type: z.literal("start_turn"),
    commandId: z.string().min(1).max(200)
  }).strict(),
  z.object({
    type: z.literal("interrupt"),
    commandId: z.string().min(1).max(200),
    turnSequence: z.number().int().positive().optional()
  }).strict(),
  z.object({
    type: z.literal("server_ack"),
    throughSequence: z.number().int().min(0)
  }).strict(),
  z.object({
    type: z.literal("browser_playback_start"),
    commandId: z.string().min(1).max(200),
    turnSequence: z.number().int().positive()
  }).strict(),
  z.object({
    type: z.literal("conversation_truncate"),
    commandId: z.string().min(1).max(200),
    turnSequence: z.number().int().positive(),
    providerItemId: z.string().trim().min(1).max(1_024),
    audioEndMs: z.number().int().min(0).max(60 * 60_000)
  }).strict(),
  z.object({
    type: z.literal("ping"),
    nonce: z.string().max(200)
  }).strict(),
  z.object({
    type: z.literal("session_close"),
    commandId: z.string().min(1).max(200)
  }).strict()
]);

export type RealtimeVoiceGatewayAuthContext = {
  userId: string;
  store: JsonStore;
};

export type CreateRealtimeVoiceGatewayRuntimeInput = {
  userId: string;
  store: JsonStore;
  scope: "current" | "week" | "all";
  uploadId?: string;
  referenceDate?: string;
  context?: VoiceQaContext;
  conversation?: readonly VoiceQaConversationMessage[];
};

export interface RealtimeVoiceGatewayRuntime {
  readonly sessionId: string;
  readonly userId: string;
  subscribe(listener: (event: RealtimeVoiceQaEvent) => unknown): () => void;
  sendAudio(chunk: Buffer): Promise<void>;
  startClientTurn(): Promise<void>;
  cancelSessionTurn(expectedTurnSequence?: number): Promise<boolean>;
  keepAlive(): Promise<void>;
  markBrowserPlaybackStarted(turnSequence: number): Promise<boolean>;
  truncatePlayback(
    turnSequence: number,
    providerItemId: string,
    audioEndMs: number
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface RealtimeVoiceGatewayRuntimeManager {
  create(
    input: CreateRealtimeVoiceGatewayRuntimeInput
  ): Promise<RealtimeVoiceGatewayRuntime>;
  get(sessionId: string, userId: string): Promise<RealtimeVoiceGatewayRuntime | undefined>;
  close(sessionId: string, userId: string): Promise<void>;
}

type GatewayBinding = {
  runtime: RealtimeVoiceGatewayRuntime;
  fence: RealtimeVoiceConnectionFence;
  unsubscribe: () => void;
  providerEpoch: number;
  itemOffsets: Map<string, { turnSequence: number; offsetSamples: number }>;
  commandResults: Map<
    string,
    { fingerprint: string; response: RealtimeVoiceGatewayServerControlV2 }
  >;
  forwarding: Promise<void>;
  deliveryReady: boolean;
  closing: boolean;
};

type GatewayConnection = {
  socket: WebSocket;
  auth: RealtimeVoiceGatewayAuthContext;
  connectionId: string;
  binding?: GatewayBinding;
  processing: Promise<void>;
  pendingFrames: number;
  pendingBytes: number;
  superseded: boolean;
  closed: boolean;
  readyTimer: ReturnType<typeof setTimeout>;
};

const MAX_COMMAND_RESULTS = 256;
const MAX_PROVIDER_ITEMS = 128;

type StoredAudioDescriptor = {
  providerEpoch: number;
  turnSequence: number;
  sequence: number;
  sentenceSequence: number;
  itemOffsetSamples: number;
  providerItemId: string;
  pcmBase64: string;
};

export type RealtimeVoiceWebSocketGatewayOptions = {
  authenticate(request: IncomingMessage): Promise<RealtimeVoiceGatewayAuthContext>;
  runtimeManager: RealtimeVoiceGatewayRuntimeManager;
  sessionStore?: SessionStore;
  allowedOrigins?: readonly string[];
  connectionIdFactory?: () => string;
};

function parseControl(data: RawData) {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);
  if (bytes.byteLength > MAX_GATEWAY_CONTROL_BYTES) {
    throw new Error("voice_realtime_gateway_control_too_large");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("voice_realtime_gateway_invalid_json");
  }
  const parsed = ClientControlSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("voice_realtime_gateway_invalid_control");
  const value = parsed.data as RealtimeVoiceGatewayClientControlV2;
  if (value.type === "session_start") {
    if (value.scope === "current" && !value.uploadId) {
      throw new Error("voice_realtime_gateway_current_upload_required");
    }
    if (value.scope !== "current" && value.uploadId) {
      throw new Error("voice_realtime_gateway_upload_scope_mismatch");
    }
    if (value.scope !== "week" && value.referenceDate) {
      throw new Error("voice_realtime_gateway_reference_date_scope_mismatch");
    }
    const context = value.context as VoiceQaContext | undefined;
    if (context && context.contextId !== value.uploadId) {
      throw new Error("voice_realtime_gateway_context_mismatch");
    }
  }
  return value;
}

function publicErrorCode(error: unknown) {
  if (error instanceof RealtimeVoiceSessionStoreError) {
    if (error.code === "not_found" || error.code === "owner_mismatch") {
      return "voice_realtime_gateway_session_lost";
    }
    if (error.code === "stale_connection") {
      return "voice_realtime_gateway_stale_connection";
    }
    if (error.code === "session_limit") {
      return "voice_realtime_gateway_session_limit";
    }
  }
  if (error instanceof Error && error.message.startsWith("voice_realtime_")) {
    return error.message;
  }
  return "voice_realtime_gateway_failure";
}

function eventStatePatch(event: RealtimeVoiceQaEvent) {
  if (event.type === "session_started" || event.type === "session_reconnected") {
    return {
      status: "listening" as const,
      providerSessionId: event.providerSessionId
    };
  }
  if (event.type === "turn_state") {
    return {
      status: event.state === "thinking"
        ? ("processing" as const)
        : event.state,
      activeTurnSequence: event.turnSequence
    };
  }
  if (event.type === "turn_complete") {
    return { status: "listening" as const, activeTurnSequence: null };
  }
  if (event.type === "session_closed") return { status: "closed" as const };
  return undefined;
}

function eventWithoutAudio(event: RealtimeVoiceQaEvent) {
  if (event.type !== "audio_chunk") return event;
  const { audio: _audio, ...metadata } = event;
  return metadata;
}

function originAllowed(request: IncomingMessage, allowedOrigins: readonly string[]) {
  const origin = request.headers.origin;
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

function requestedProtocols(request: IncomingMessage) {
  return String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export class RealtimeVoiceWebSocketGateway {
  private readonly store: SessionStore;
  private readonly runtimeManager: RealtimeVoiceGatewayRuntimeManager;
  private readonly connectionIdFactory: () => string;
  private readonly allowedOrigins: readonly string[];
  private readonly connections = new Set<GatewayConnection>();
  private readonly activeBySession = new Map<string, GatewayConnection>();
  private readonly bindingsBySession = new Map<string, GatewayBinding>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: RealtimeVoiceWebSocketGatewayOptions) {
    this.store = options.sessionStore ?? new MemoryRealtimeVoiceSessionStore();
    this.runtimeManager = options.runtimeManager;
    this.connectionIdFactory = options.connectionIdFactory ?? randomUUID;
    this.allowedOrigins = options.allowedOrigins ?? [
      "http://127.0.0.1:3000",
      "http://localhost:3000"
    ];
    this.cleanupTimer = setInterval(() => {
      void this.pruneExpired().catch(() => undefined);
    }, 60_000);
    this.cleanupTimer.unref?.();
  }

  accept(socket: WebSocket, auth: RealtimeVoiceGatewayAuthContext) {
    const connection: GatewayConnection = {
      socket,
      auth,
      connectionId: this.connectionIdFactory(),
      processing: Promise.resolve(),
      pendingFrames: 0,
      pendingBytes: 0,
      superseded: false,
      closed: false,
      readyTimer: setTimeout(() => {
        this.sendError(connection, "voice_realtime_gateway_ready_timeout", true);
        connection.superseded = true;
        socket.close(1008, "ready_timeout");
      }, READY_TIMEOUT_MS)
    };
    this.connections.add(connection);
    socket.on("message", (data, isBinary) => {
      const size = typeof data === "string"
        ? Buffer.byteLength(data)
        : Array.isArray(data)
          ? data.reduce((total, item) => total + item.byteLength, 0)
          : data.byteLength;
      connection.pendingFrames += 1;
      connection.pendingBytes += size;
      if (
        connection.pendingFrames > MAX_PENDING_INPUT_FRAMES ||
        connection.pendingBytes > MAX_PENDING_INPUT_BYTES
      ) {
        this.sendError(connection, "voice_realtime_gateway_input_backpressure", true);
        connection.superseded = true;
        socket.close(1013, "input_backpressure");
        return;
      }
      const run = async () => {
        if (connection.closed || connection.superseded) return;
        await this.handleMessage(connection, data, isBinary);
      };
      connection.processing = connection.processing
        .then(run)
        .catch((error: unknown) => {
          this.sendError(connection, publicErrorCode(error), true);
          // Fence queued old-epoch frames synchronously. In particular, a
          // Provider reconnect must not feed already queued PCM into the fresh
          // Provider session before the client resumes with a new input epoch.
          connection.superseded = true;
          socket.close(1008, "protocol_error");
        })
        .finally(() => {
          connection.pendingFrames -= 1;
          connection.pendingBytes -= size;
        });
    });
    socket.on("close", () => void this.handleClose(connection));
    socket.on("error", () => undefined);
  }

  async close() {
    clearInterval(this.cleanupTimer);
    for (const connection of this.connections) {
      connection.closed = true;
      clearTimeout(connection.readyTimer);
      connection.socket.close(1001, "gateway_close");
    }
    await Promise.all([...this.bindingsBySession.values()].map(async (binding) => {
      binding.unsubscribe();
      await this.runtimeManager.close(
        binding.runtime.sessionId,
        binding.runtime.userId
      ).catch(() => undefined);
    }));
    this.connections.clear();
    this.activeBySession.clear();
    this.bindingsBySession.clear();
  }

  private async handleMessage(
    connection: GatewayConnection,
    data: RawData,
    isBinary: boolean
  ) {
    if (isBinary) {
      await this.handleAudio(connection, data);
      return;
    }
    const message = parseControl(data);
    if (!connection.binding) {
      if (message.type === "session_start") {
        await this.startSession(connection, message);
        return;
      }
      if (message.type === "session_resume") {
        await this.resumeSession(connection, message);
        return;
      }
      throw new Error("voice_realtime_gateway_session_required");
    }
    if (message.type === "session_start" || message.type === "session_resume") {
      throw new Error("voice_realtime_gateway_session_already_attached");
    }
    await this.handleControl(connection, message);
  }

  private async startSession(
    connection: GatewayConnection,
    message: Extract<RealtimeVoiceGatewayClientControlV2, { type: "session_start" }>
  ) {
    await this.pruneExpired();
    const runtime = await this.runtimeManager.create({
      userId: connection.auth.userId,
      store: connection.auth.store,
      scope: message.scope,
      ...(message.uploadId ? { uploadId: message.uploadId } : {}),
      ...(message.referenceDate ? { referenceDate: message.referenceDate } : {}),
      ...(message.context ? { context: message.context as VoiceQaContext } : {}),
      ...(message.conversation
        ? { conversation: message.conversation as VoiceQaConversationMessage[] }
        : {})
    });
    try {
      this.requireOpenConnection(connection);
      await this.store.create({
        sessionId: runtime.sessionId,
        userId: runtime.userId,
        scope: message.scope,
        ...(message.uploadId ? { uploadId: message.uploadId } : {}),
        ...(message.referenceDate ? { referenceDate: message.referenceDate } : {})
      });
      this.requireOpenConnection(connection);
      const claimed = await this.store.claimConnection({
        sessionId: runtime.sessionId,
        userId: runtime.userId,
        connectionId: connection.connectionId
      });
      this.requireOpenConnection(connection);
      await this.attach(connection, runtime, claimed.fence, false, 0);
    } catch (error) {
      await this.store.delete(runtime.sessionId, runtime.userId)
        .catch(() => undefined);
      await this.runtimeManager.close(runtime.sessionId, runtime.userId)
        .catch(() => undefined);
      throw error;
    }
  }

  private async resumeSession(
    connection: GatewayConnection,
    message: Extract<RealtimeVoiceGatewayClientControlV2, { type: "session_resume" }>
  ) {
    const session = await this.store.get(message.sessionId, connection.auth.userId);
    const runtime = await this.runtimeManager.get(
      message.sessionId,
      connection.auth.userId
    );
    const existingBinding = this.bindingsBySession.get(message.sessionId);
    if (!session || !runtime || !existingBinding) {
      this.send(connection, {
        type: "resync_required",
        reason: "session_lost"
      });
      connection.socket.close(1008, "session_lost");
      if (existingBinding) await this.closeBinding(existingBinding);
      else {
        if (runtime) {
          await this.runtimeManager.close(message.sessionId, connection.auth.userId)
            .catch(() => undefined);
        }
        if (session) {
          await this.store.delete(message.sessionId, connection.auth.userId)
            .catch(() => undefined);
        }
      }
      return;
    }
    const latestSequence = session.nextOutboundSequence - 1;
    const availableAfter = Math.max(
      session.outboundAckSequence,
      session.outboundReplayFloorSequence
    );
    if (
      message.lastServerAck > latestSequence ||
      message.lastInputAck > session.audioAckSequence
    ) {
      this.sendError(connection, "voice_realtime_gateway_cursor_ahead", true);
      connection.socket.close(1008, "cursor_ahead");
      return;
    }
    if (message.lastServerAck < availableAfter) {
      this.send(connection, { type: "resync_required", reason: "replay_expired" });
      connection.socket.close(1008, "replay_expired");
      if (!this.activeBySession.has(message.sessionId)) {
        await this.closeBinding(existingBinding);
      }
      return;
    }
    const old = this.activeBySession.get(message.sessionId);
    if (old && old !== connection) {
      old.superseded = true;
      await old.processing.catch(() => undefined);
    }
    this.requireOpenConnection(connection);
    const claimed = await this.store.claimConnection({
      sessionId: message.sessionId,
      userId: connection.auth.userId,
      connectionId: connection.connectionId,
      expectedConnectionEpoch: session.connectionEpoch
    });
    this.requireOpenConnection(connection);
    if (old && old !== connection) old.socket.close(4001, "connection_replaced");
    await this.attach(
      connection,
      runtime,
      claimed.fence,
      true,
      message.lastServerAck,
      existingBinding
    );
  }

  private async attach(
    connection: GatewayConnection,
    runtime: RealtimeVoiceGatewayRuntime,
    fence: RealtimeVoiceConnectionFence,
    resumed: boolean,
    lastServerAck: number,
    existingBinding?: GatewayBinding
  ) {
    clearTimeout(connection.readyTimer);
    const binding: GatewayBinding = existingBinding ?? {
      runtime,
      fence,
      unsubscribe: () => undefined,
      providerEpoch: 1,
      itemOffsets: new Map(),
      commandResults: new Map(),
      forwarding: Promise.resolve(),
      deliveryReady: false,
      closing: false
    };
    binding.fence = fence;
    binding.deliveryReady = false;
    connection.binding = binding;
    if (!existingBinding) {
      this.bindingsBySession.set(runtime.sessionId, binding);
    }
    await binding.forwarding.catch(() => undefined);
    this.requireOpenConnection(connection);
    const session = await this.store.get(runtime.sessionId, runtime.userId);
    if (!session) throw new Error("voice_realtime_gateway_session_lost");
    const replay = await this.store.replayOutbound(fence, lastServerAck);
    if (replay.status === "too_old") {
      this.send(connection, { type: "resync_required", reason: "replay_expired" });
      connection.socket.close(1008, "replay_expired");
      return;
    }
    this.send(connection, {
      type: "ready",
      version: 2,
      sessionId: runtime.sessionId,
      connectionId: connection.connectionId,
      resumed,
      inputEpoch: session.audioEpoch,
      providerEpoch: binding.providerEpoch,
      inputAckThrough: session.audioAckSequence,
      replayFrom: lastServerAck + 1,
      serverSequence: replay.latestSequence
    });
    for (const frame of replay.frames) this.sendStoredFrame(connection, frame);
    // Events emitted while the replay snapshot was being read are serialized
    // behind forwarding. Catch up that tail before enabling live delivery.
    await binding.forwarding.catch(() => undefined);
    const tail = await this.store.replayOutbound(fence, replay.latestSequence);
    if (tail.status !== "ok") {
      throw new Error("voice_realtime_gateway_replay_expired");
    }
    for (const frame of tail.frames) this.sendStoredFrame(connection, frame);
    this.activeBySession.set(runtime.sessionId, connection);
    binding.deliveryReady = true;
    if (!existingBinding) {
      binding.unsubscribe = runtime.subscribe((event) => {
        this.enqueueRuntimeEvent(binding, event);
      });
    }
  }

  private async handleAudio(connection: GatewayConnection, data: RawData) {
    const binding = connection.binding;
    if (!binding) throw new Error("voice_realtime_gateway_session_required");
    const bytes = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    const frame = decodeRealtimeVoiceGatewayAudioFrameV2(bytes);
    if (frame.kind !== "input_pcm") {
      throw new Error("voice_realtime_gateway_input_audio_required");
    }
    const session = await this.store.get(
      binding.runtime.sessionId,
      binding.runtime.userId
    );
    if (!session) throw new Error("voice_realtime_gateway_session_lost");
    if (frame.inputEpoch !== session.audioEpoch) {
      this.send(connection, {
        type: "resync_required",
        reason: "provider_restarted"
      });
      return;
    }
    if (frame.sequence <= session.audioAckSequence) {
      this.send(connection, {
        type: "input_ack",
        throughSequence: session.audioAckSequence
      });
      return;
    }
    if (frame.sequence !== session.audioAckSequence + 1) {
      this.sendError(connection, "voice_realtime_gateway_audio_sequence_gap", false);
      return;
    }
    await binding.runtime.sendAudio(Buffer.from(frame.pcm16le));
    const ack = await this.store.acknowledgeAudio(binding.fence, {
      audioEpoch: frame.inputEpoch,
      sequence: frame.sequence
    });
    this.send(connection, {
      type: "input_ack",
      throughSequence: ack.acceptedThrough
    });
  }

  private async handleControl(
    connection: GatewayConnection,
    message: Exclude<
      RealtimeVoiceGatewayClientControlV2,
      { type: "session_start" | "session_resume" }
    >
  ) {
    const binding = connection.binding!;
    if (message.type === "server_ack") {
      await this.store.acknowledgeOutbound(
        binding.fence,
        message.throughSequence
      );
      return;
    }
    if (message.type === "ping") {
      await Promise.all([
        this.store.keepAlive(binding.fence),
        binding.runtime.keepAlive()
      ]);
      this.send(connection, { type: "pong", nonce: message.nonce });
      return;
    }
    if ("commandId" in message) {
      const prior = binding.commandResults.get(message.commandId);
      if (prior) {
        if (prior.fingerprint !== JSON.stringify(message)) {
          this.sendError(
            connection,
            "voice_realtime_gateway_command_id_conflict",
            true
          );
          connection.socket.close(1008, "command_id_conflict");
          return;
        }
        this.send(connection, {
          ...prior.response,
          ...(prior.response.type === "command_ack"
            ? {
                status: prior.response.status === "applied"
                  ? ("already_applied" as const)
                  : prior.response.status
              }
            : {})
        });
        return;
      }
    }
    let status: Extract<
      RealtimeVoiceGatewayServerControlV2,
      { type: "command_ack" }
    >["status"] = "applied";
    if (message.type === "start_turn") {
      await binding.runtime.startClientTurn();
    } else if (message.type === "interrupt") {
      status = await binding.runtime.cancelSessionTurn(message.turnSequence)
        ? "applied"
        : "stale";
    } else if (message.type === "browser_playback_start") {
      status = await binding.runtime.markBrowserPlaybackStarted(
        message.turnSequence
      ) ? "applied" : "stale";
    } else if (message.type === "conversation_truncate") {
      status = await binding.runtime.truncatePlayback(
        message.turnSequence,
        message.providerItemId,
        message.audioEndMs
      ) ? "applied" : "stale";
    } else if (message.type === "session_close") {
      const response = {
        type: "command_ack" as const,
        commandId: message.commandId,
        status: "applied" as const
      };
      binding.commandResults.set(message.commandId, {
        fingerprint: JSON.stringify(message),
        response
      });
      this.send(connection, response);
      await this.closeBinding(binding);
      connection.socket.close(1000, "session_close");
      return;
    }
    if ("commandId" in message) {
      const response = {
        type: "command_ack" as const,
        commandId: message.commandId,
        status
      };
      if (binding.commandResults.size >= MAX_COMMAND_RESULTS) {
        throw new Error("voice_realtime_gateway_command_history_full");
      }
      binding.commandResults.set(message.commandId, {
        fingerprint: JSON.stringify(message),
        response
      });
      this.send(connection, response);
    }
  }

  private enqueueRuntimeEvent(
    binding: GatewayBinding,
    event: RealtimeVoiceQaEvent
  ) {
    binding.forwarding = binding.forwarding
      .then(async () => {
        if (binding.closing) return;
        await this.forwardRuntimeEvent(binding, event);
      })
      .catch(async (error: unknown) => {
        await this.failBinding(binding, publicErrorCode(error));
      });
  }

  private async forwardRuntimeEvent(
    binding: GatewayBinding,
    event: RealtimeVoiceQaEvent
  ) {
    if (event.type === "session_reconnected") {
      binding.providerEpoch += 1;
      binding.itemOffsets.clear();
      const session = await this.store.get(
        binding.runtime.sessionId,
        binding.runtime.userId
      );
      if (session) {
        await this.store.patchState(binding.fence, {
          audioEpoch: session.audioEpoch + 1,
          providerSessionId: event.providerSessionId,
          status: "reconnecting"
        });
      }
      const connection = this.activeBySession.get(binding.runtime.sessionId);
      if (connection) {
        this.send(connection, {
          type: "resync_required",
          reason: "provider_restarted"
        });
        connection.socket.close(1012, "provider_restarted");
      }
      return;
    }
    const patch = eventStatePatch(event);
    if (patch) await this.store.patchState(binding.fence, patch);

    if (event.type === "audio_chunk") {
      if (!event.providerItemId) {
        throw new Error("voice_realtime_gateway_audio_item_missing");
      }
      const currentItem = binding.itemOffsets.get(event.providerItemId);
      if (currentItem && currentItem.turnSequence !== event.turnSequence) {
        throw new Error("voice_realtime_gateway_audio_item_turn_mismatch");
      }
      const itemOffsetSamples = currentItem?.offsetSamples ?? 0;
      const descriptor: StoredAudioDescriptor = {
        providerEpoch: binding.providerEpoch,
        turnSequence: event.turnSequence,
        sequence: event.sequence,
        sentenceSequence: event.sentenceSequence,
        itemOffsetSamples,
        providerItemId: event.providerItemId,
        pcmBase64: event.audio.toString("base64")
      };
      binding.itemOffsets.set(
        event.providerItemId,
        {
          turnSequence: event.turnSequence,
          offsetSamples: itemOffsetSamples + Math.floor(event.audio.byteLength / 2)
        }
      );
      if (binding.itemOffsets.size > MAX_PROVIDER_ITEMS) {
        throw new Error("voice_realtime_gateway_audio_item_limit");
      }
      const stored = await this.store.appendOutboundFrame(binding.fence, {
        kind: "audio",
        data: JSON.stringify(descriptor)
      });
      const connection = this.activeBySession.get(binding.runtime.sessionId);
      if (
        binding.deliveryReady &&
        connection &&
        connection.binding === binding
      ) {
        this.sendStoredFrame(connection, stored);
      }
      return;
    }

    const stored = await this.store.appendOutboundFrame(binding.fence, {
      kind: "control",
      data: JSON.stringify({ name: event.type, event: eventWithoutAudio(event) })
    });
    const connection = this.activeBySession.get(binding.runtime.sessionId);
    if (
      binding.deliveryReady &&
      connection &&
      connection.binding === binding
    ) {
      this.sendStoredFrame(connection, stored);
    }
    if (event.type === "turn_complete" || event.type === "turn_interrupted") {
      for (const [providerItemId, item] of binding.itemOffsets) {
        if (item.turnSequence === event.turnSequence) {
          binding.itemOffsets.delete(providerItemId);
        }
      }
    }
  }

  private sendStoredFrame(
    connection: GatewayConnection,
    frame: RealtimeVoiceOutboundFrame
  ) {
    if (frame.kind === "control") {
      const decoded = JSON.parse(String(frame.data)) as {
        name: string;
        event: unknown;
      };
      this.send(connection, {
        type: "event",
        serverSequence: frame.sequence,
        name: decoded.name,
        event: decoded.event
      });
      return;
    }
    const decoded = JSON.parse(String(frame.data)) as StoredAudioDescriptor;
    this.send(connection, encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "output_pcm",
      providerEpoch: decoded.providerEpoch,
      serverSequence: frame.sequence,
      turnSequence: decoded.turnSequence,
      sequence: decoded.sequence,
      sentenceSequence: decoded.sentenceSequence,
      itemOffsetSamples: decoded.itemOffsetSamples,
      providerItemId: decoded.providerItemId,
      pcm16le: Buffer.from(decoded.pcmBase64, "base64")
    }));
  }

  private send(
    connection: GatewayConnection,
    message: RealtimeVoiceGatewayServerControlV2 | Uint8Array
  ) {
    if (
      connection.closed ||
      connection.superseded ||
      connection.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    if (connection.socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      connection.socket.close(1013, "output_backpressure");
      return;
    }
    connection.socket.send(
      message instanceof Uint8Array ? message : JSON.stringify(message)
    );
  }

  private sendError(connection: GatewayConnection, code: string, fatal: boolean) {
    this.send(connection, { type: "error", code, fatal });
  }

  private async handleClose(connection: GatewayConnection) {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.readyTimer);
    this.connections.delete(connection);
    const binding = connection.binding;
    if (!binding) return;
    if (this.activeBySession.get(binding.runtime.sessionId) === connection) {
      this.activeBySession.delete(binding.runtime.sessionId);
      binding.deliveryReady = false;
      await this.store.patchState(binding.fence, { status: "reconnecting" })
        .catch(() => undefined);
    }
  }

  private async closeBinding(binding: GatewayBinding) {
    if (binding.closing) return;
    binding.closing = true;
    binding.deliveryReady = false;
    binding.unsubscribe();
    this.activeBySession.delete(binding.runtime.sessionId);
    this.bindingsBySession.delete(binding.runtime.sessionId);
    await this.runtimeManager.close(
      binding.runtime.sessionId,
      binding.runtime.userId
    ).catch(() => undefined);
    await this.store.delete(binding.runtime.sessionId, binding.runtime.userId)
      .catch(() => undefined);
  }

  private async failBinding(binding: GatewayBinding, code: string) {
    if (binding.closing) return;
    const connection = this.activeBySession.get(binding.runtime.sessionId);
    if (connection) {
      this.sendError(connection, code, true);
      connection.socket.close(1011, "runtime_failure");
    }
    await binding.runtime.cancelSessionTurn().catch(() => undefined);
    await this.closeBinding(binding);
  }

  private async pruneExpired() {
    const expiredIds = await this.store.expire();
    for (const sessionId of expiredIds) {
      const binding = this.bindingsBySession.get(sessionId);
      if (!binding) continue;
      binding.unsubscribe();
      this.bindingsBySession.delete(sessionId);
      const connection = this.activeBySession.get(sessionId);
      this.activeBySession.delete(sessionId);
      connection?.socket.close(1001, "session_expired");
      await this.runtimeManager.close(sessionId, binding.runtime.userId)
        .catch(() => undefined);
    }
  }

  private requireOpenConnection(connection: GatewayConnection) {
    if (
      connection.closed ||
      connection.superseded ||
      connection.socket.readyState !== WebSocket.OPEN
    ) {
      throw new Error("voice_realtime_gateway_connection_closed");
    }
  }
}

export type RealtimeVoiceGatewayServer = {
  server: Server;
  gateway: RealtimeVoiceWebSocketGateway;
  listen(input?: { host?: string; port?: number }): Promise<AddressInfo>;
  close(): Promise<void>;
};

export function createRealtimeVoiceGatewayServer(
  options: RealtimeVoiceWebSocketGatewayOptions
): RealtimeVoiceGatewayServer {
  const gateway = new RealtimeVoiceWebSocketGateway(options);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_GATEWAY_CONTROL_BYTES,
    handleProtocols(protocols) {
      return protocols.has(REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2)
        ? REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2
        : false;
    }
  });
  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (
        url.pathname !== REALTIME_VOICE_GATEWAY_PATH ||
        !originAllowed(request, options.allowedOrigins ?? [
          "http://127.0.0.1:3000",
          "http://localhost:3000"
        ]) ||
        !requestedProtocols(request).includes(REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      let auth: RealtimeVoiceGatewayAuthContext;
      try {
        auth = await options.authenticate(request);
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        gateway.accept(webSocket, auth);
      });
    })().catch(() => socket.destroy());
  });

  return {
    server,
    gateway,
    listen: ({ host = "127.0.0.1", port = 3011 } = {}) =>
      new Promise<AddressInfo>((resolve, reject) => {
        const handleError = (error: Error) => reject(error);
        server.once("error", handleError);
        server.listen(port, host, () => {
          server.off("error", handleError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("voice_realtime_gateway_address_unavailable"));
            return;
          }
          resolve(address);
        });
      }),
    close: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}
