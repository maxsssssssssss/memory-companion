// @vitest-environment node

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2,
  decodeRealtimeVoiceGatewayAudioFrameV2,
  encodeRealtimeVoiceGatewayAudioFrameV2,
  type RealtimeVoiceGatewayServerControlV2
} from "@/lib/voice-realtime-gateway";

import {
  REALTIME_VOICE_GATEWAY_PATH,
  createRealtimeVoiceGatewayServer,
  type CreateRealtimeVoiceGatewayRuntimeInput,
  type RealtimeVoiceGatewayRuntime,
  type RealtimeVoiceGatewayRuntimeManager,
  type RealtimeVoiceGatewayServer
} from "./realtime-websocket-gateway";
import type { RealtimeVoiceQaEvent } from "./realtime-controller";
import {
  MemoryRealtimeVoiceSessionStore,
  type SessionStore
} from "./realtime-session-store";

class FakeRuntime implements RealtimeVoiceGatewayRuntime {
  readonly listeners = new Set<(event: RealtimeVoiceQaEvent) => unknown>();
  readonly audio: Buffer[] = [];
  readonly startClientTurn = vi.fn(async () => undefined);
  readonly cancelSessionTurn = vi.fn(async () => true);
  readonly keepAlive = vi.fn(async () => undefined);
  readonly markBrowserPlaybackStarted = vi.fn(async () => true);
  readonly truncatePlayback = vi.fn(async () => true);
  readonly close = vi.fn(async () => undefined);
  readonly sendAudio = vi.fn(async (chunk: Buffer) => {
    this.audio.push(Buffer.from(chunk));
  });

  constructor(
    readonly sessionId: string,
    readonly userId: string
  ) {}

  subscribe(listener: (event: RealtimeVoiceQaEvent) => unknown) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RealtimeVoiceQaEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeRuntimeManager implements RealtimeVoiceGatewayRuntimeManager {
  readonly runtimes = new Map<string, FakeRuntime>();
  readonly createInputs: CreateRealtimeVoiceGatewayRuntimeInput[] = [];

  async create(input: CreateRealtimeVoiceGatewayRuntimeInput) {
    this.createInputs.push(input);
    const runtime = new FakeRuntime(randomUUID(), input.userId);
    this.runtimes.set(runtime.sessionId, runtime);
    return runtime;
  }

  async get(sessionId: string, userId: string) {
    const runtime = this.runtimes.get(sessionId);
    return runtime?.userId === userId ? runtime : undefined;
  }

  async close(sessionId: string, userId: string) {
    const runtime = await this.get(sessionId, userId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.close();
  }
}

type InboxMessage =
  | { kind: "json"; value: RealtimeVoiceGatewayServerControlV2 }
  | { kind: "binary"; value: ReturnType<typeof decodeRealtimeVoiceGatewayAudioFrameV2> };

class SocketInbox {
  readonly messages: InboxMessage[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      this.messages.push(isBinary
        ? {
            kind: "binary",
            value: decodeRealtimeVoiceGatewayAudioFrameV2(Buffer.from(data as Buffer))
          }
        : {
            kind: "json",
            value: JSON.parse(Buffer.from(data as Buffer).toString("utf8"))
          });
    });
  }

  async take(predicate: (message: InboxMessage) => boolean) {
    await vi.waitFor(() => {
      expect(this.messages.some(predicate)).toBe(true);
    });
    const index = this.messages.findIndex(predicate);
    return this.messages.splice(index, 1)[0]!;
  }
}

async function openSocket(url: string, origin = "http://localhost:3000") {
  const socket = new WebSocket(url, REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2, {
    origin
  });
  const inbox = new SocketInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, inbox };
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.close(1000, "test_close");
  });
}

describe("Realtime Voice v2 WebSocket gateway", () => {
  const servers: RealtimeVoiceGatewayServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map(closeSocket));
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function setup(sessionStore?: SessionStore) {
    const manager = new FakeRuntimeManager();
    const server = createRealtimeVoiceGatewayServer({
      authenticate: vi.fn(async () => ({
        userId: "user-1",
        store: {} as CreateRealtimeVoiceGatewayRuntimeInput["store"]
      })),
      runtimeManager: manager,
      ...(sessionStore ? { sessionStore } : {}),
      allowedOrigins: ["http://localhost:3000"]
    });
    servers.push(server);
    const address = await server.listen({ port: 0 });
    const url = `ws://127.0.0.1:${address.port}${REALTIME_VOICE_GATEWAY_PATH}`;
    return { manager, server, url };
  }

  it("authenticates an upgrade and ACKs each accepted PCM sequence once", async () => {
    const { manager, url } = await setup();
    const { socket, inbox } = await openSocket(url);
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "session_start", version: 2, scope: "all" }));
    const ready = await inbox.take((message) =>
      message.kind === "json" && message.value.type === "ready"
    );
    expect(ready.kind).toBe("json");
    const runtime = [...manager.runtimes.values()][0]!;

    const input = encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "input_pcm",
      inputEpoch: 1,
      sequence: 1,
      timestampMs: 10,
      pcm16le: new Uint8Array([1, 2, 3, 4])
    });
    socket.send(input);
    await inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "input_ack" &&
      message.value.throughSequence === 1
    );
    socket.send(input);
    await inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "input_ack" &&
      message.value.throughSequence === 1
    );
    expect(runtime.audio).toEqual([Buffer.from([1, 2, 3, 4])]);

    socket.send(encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "input_pcm",
      inputEpoch: 1,
      sequence: 3,
      timestampMs: 30,
      pcm16le: new Uint8Array([5, 6])
    }));
    await inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "error" &&
      message.value.code === "voice_realtime_gateway_audio_sequence_gap" &&
      !message.value.fatal
    );
    expect(runtime.audio).toHaveLength(1);
  });

  it("replays unacknowledged control and bound audio after reconnect", async () => {
    const { manager, url } = await setup();
    const first = await openSocket(url);
    sockets.push(first.socket);
    first.socket.send(JSON.stringify({
      type: "session_start",
      version: 2,
      scope: "all"
    }));
    const readyMessage = await first.inbox.take((message) =>
      message.kind === "json" && message.value.type === "ready"
    );
    const ready = readyMessage.kind === "json" && readyMessage.value.type === "ready"
      ? readyMessage.value
      : undefined;
    expect(ready).toBeDefined();
    const runtime = manager.runtimes.get(ready!.sessionId)!;
    runtime.emit({ type: "asr_partial", transcript: "测试" });
    const partial = await first.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "event" &&
      message.value.name === "asr_partial"
    );
    const partialSequence = partial.kind === "json" && partial.value.type === "event"
      ? partial.value.serverSequence
      : 0;
    first.socket.send(JSON.stringify({
      type: "server_ack",
      throughSequence: partialSequence
    }));
    await closeSocket(first.socket);

    runtime.emit({
      type: "audio_chunk",
      turnSequence: 1,
      sequence: 1,
      sentenceSequence: 1,
      sentenceChunkSequence: 1,
      supportIds: ["E1"],
      providerItemId: "reply-1",
      audio: Buffer.from([9, 8, 7, 6])
    });
    runtime.emit({
      type: "turn_complete",
      turnSequence: 1,
      status: "completed"
    });

    const second = await openSocket(url);
    sockets.push(second.socket);
    second.socket.send(JSON.stringify({
      type: "session_resume",
      version: 2,
      sessionId: ready!.sessionId,
      lastInputAck: 0,
      lastServerAck: partialSequence
    }));
    const resumed = await second.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "ready" &&
      message.value.resumed
    );
    expect(resumed.kind).toBe("json");
    const audio = await second.inbox.take((message) => message.kind === "binary");
    const decodedAudio = audio.kind === "binary" ? audio.value : undefined;
    expect(decodedAudio).toMatchObject({
      kind: "output_pcm",
      turnSequence: 1,
      providerItemId: "reply-1",
      itemOffsetSamples: 0
    });
    expect(Array.from(decodedAudio?.pcm16le ?? [])).toEqual([9, 8, 7, 6]);
    await second.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "event" &&
      message.value.name === "turn_complete"
    );
  });

  it("deduplicates interrupt commands and isolates concurrent sessions", async () => {
    const { manager, url } = await setup();
    const first = await openSocket(url);
    const second = await openSocket(url);
    sockets.push(first.socket, second.socket);
    for (const item of [first, second]) {
      item.socket.send(JSON.stringify({
        type: "session_start",
        version: 2,
        scope: "all"
      }));
      await item.inbox.take((message) =>
        message.kind === "json" && message.value.type === "ready"
      );
    }
    const command = {
      type: "interrupt",
      commandId: "interrupt-1",
      turnSequence: 1
    };
    first.socket.send(JSON.stringify(command));
    first.socket.send(JSON.stringify(command));
    const acknowledgements = await Promise.all([1, 2].map(() =>
      first.inbox.take((message) =>
        message.kind === "json" &&
        message.value.type === "command_ack" &&
        message.value.commandId === "interrupt-1"
      )
    ));
    expect(acknowledgements.map((message) =>
      message.kind === "json" && message.value.type === "command_ack"
        ? message.value.status
        : undefined
    )).toEqual(["applied", "already_applied"]);
    const runtimes = [...manager.runtimes.values()];
    expect(runtimes[0]?.cancelSessionTurn).toHaveBeenCalledWith(1);
    expect(runtimes[1]?.cancelSessionTurn).not.toHaveBeenCalled();

    runtimes[0]!.cancelSessionTurn.mockResolvedValueOnce(false);
    first.socket.send(JSON.stringify({
      type: "interrupt",
      commandId: "interrupt-stale",
      turnSequence: 2
    }));
    const stale = await first.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "command_ack" &&
      message.value.commandId === "interrupt-stale"
    );
    expect(stale.kind === "json" && stale.value.type === "command_ack"
      ? stale.value.status
      : undefined).toBe("stale");
  });

  it("requires a fresh input epoch after the Provider session restarts", async () => {
    const { manager, url } = await setup();
    const first = await openSocket(url);
    sockets.push(first.socket);
    first.socket.send(JSON.stringify({
      type: "session_start",
      version: 2,
      scope: "all"
    }));
    const readyMessage = await first.inbox.take((message) =>
      message.kind === "json" && message.value.type === "ready"
    );
    const ready = readyMessage.kind === "json" && readyMessage.value.type === "ready"
      ? readyMessage.value
      : undefined;
    const runtime = manager.runtimes.get(ready!.sessionId)!;
    runtime.emit({
      type: "session_reconnected",
      providerSessionId: "provider-session-2"
    });
    await first.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "resync_required" &&
      message.value.reason === "provider_restarted"
    );
    if (first.socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
    }

    const second = await openSocket(url);
    sockets.push(second.socket);
    second.socket.send(JSON.stringify({
      type: "session_resume",
      version: 2,
      sessionId: ready!.sessionId,
      lastInputAck: 0,
      lastServerAck: 0
    }));
    const resumed = await second.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "ready" &&
      message.value.resumed
    );
    expect(resumed.kind === "json" && resumed.value.type === "ready"
      ? resumed.value.inputEpoch
      : undefined).toBe(2);
    expect(resumed.kind === "json" && resumed.value.type === "ready"
      ? resumed.value.providerEpoch
      : undefined).toBe(2);
  });

  it("forwards heartbeat, playback start, and millisecond truncate controls", async () => {
    const { manager, url } = await setup();
    const client = await openSocket(url);
    sockets.push(client.socket);
    client.socket.send(JSON.stringify({
      type: "session_start",
      version: 2,
      scope: "all"
    }));
    await client.inbox.take((message) =>
      message.kind === "json" && message.value.type === "ready"
    );
    const runtime = [...manager.runtimes.values()][0]!;

    client.socket.send(JSON.stringify({ type: "ping", nonce: "heartbeat-1" }));
    await client.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "pong" &&
      message.value.nonce === "heartbeat-1"
    );
    client.socket.send(JSON.stringify({
      type: "browser_playback_start",
      commandId: "playback-1",
      turnSequence: 3
    }));
    await client.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "command_ack" &&
      message.value.commandId === "playback-1"
    );
    client.socket.send(JSON.stringify({
      type: "conversation_truncate",
      commandId: "truncate-1",
      turnSequence: 3,
      providerItemId: "reply-3",
      audioEndMs: 460
    }));
    await client.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "command_ack" &&
      message.value.commandId === "truncate-1"
    );

    expect(runtime.keepAlive).toHaveBeenCalledOnce();
    expect(runtime.markBrowserPlaybackStarted).toHaveBeenCalledWith(3);
    expect(runtime.truncatePlayback).toHaveBeenCalledWith(3, "reply-3", 460);
  });

  it("drops queued old-epoch PCM as soon as Provider input reset is required", async () => {
    const { manager, url } = await setup();
    const client = await openSocket(url);
    sockets.push(client.socket);
    client.socket.send(JSON.stringify({
      type: "session_start",
      version: 2,
      scope: "all"
    }));
    await client.inbox.take((message) =>
      message.kind === "json" && message.value.type === "ready"
    );
    const runtime = [...manager.runtimes.values()][0]!;
    runtime.sendAudio.mockImplementationOnce(async () => {
      runtime.emit({
        type: "session_reconnected",
        providerSessionId: "provider-session-2"
      });
      throw new Error("voice_realtime_gateway_input_reset_required");
    });
    for (const sequence of [1, 2]) {
      client.socket.send(encodeRealtimeVoiceGatewayAudioFrameV2({
        kind: "input_pcm",
        inputEpoch: 1,
        sequence,
        timestampMs: sequence * 20,
        pcm16le: new Uint8Array([sequence, sequence])
      }));
    }
    await new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.sendAudio).toHaveBeenCalledTimes(1);
  });

  it("serializes state patches before later audio frames", async () => {
    class DelayedPatchStore extends MemoryRealtimeVoiceSessionStore {
      override async patchState(
        ...args: Parameters<MemoryRealtimeVoiceSessionStore["patchState"]>
      ) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return await super.patchState(...args);
      }
    }
    const { manager, url } = await setup(new DelayedPatchStore());
    const client = await openSocket(url);
    sockets.push(client.socket);
    client.socket.send(JSON.stringify({
      type: "session_start",
      version: 2,
      scope: "all"
    }));
    await client.inbox.take((message) =>
      message.kind === "json" && message.value.type === "ready"
    );
    const runtime = [...manager.runtimes.values()][0]!;
    runtime.emit({ type: "turn_state", turnSequence: 1, state: "speaking" });
    runtime.emit({
      type: "audio_chunk",
      turnSequence: 1,
      sequence: 1,
      sentenceSequence: 1,
      sentenceChunkSequence: 1,
      supportIds: ["E1"],
      providerItemId: "reply-1",
      audio: Buffer.from([1, 2])
    });
    const state = await client.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "event" &&
      message.value.name === "turn_state"
    );
    const audio = await client.inbox.take((message) => message.kind === "binary");
    expect(state.kind === "json" && state.value.type === "event"
      ? state.value.serverSequence
      : undefined).toBe(1);
    expect(
      audio.kind === "binary" && audio.value.kind === "output_pcm"
        ? audio.value.serverSequence
        : undefined
    ).toBe(2);
  });

  it("fails closed instead of playing Provider audio without an item binding", async () => {
    const { manager, url } = await setup();
    const client = await openSocket(url);
    sockets.push(client.socket);
    client.socket.send(JSON.stringify({
      type: "session_start",
      version: 2,
      scope: "all"
    }));
    const readyMessage = await client.inbox.take((message) =>
      message.kind === "json" && message.value.type === "ready"
    );
    const ready = readyMessage.kind === "json" && readyMessage.value.type === "ready"
      ? readyMessage.value
      : undefined;
    const runtime = manager.runtimes.get(ready!.sessionId)!;
    runtime.emit({
      type: "audio_chunk",
      turnSequence: 1,
      sequence: 1,
      sentenceSequence: 1,
      sentenceChunkSequence: 1,
      supportIds: ["E1"],
      audio: Buffer.from([1, 2])
    });
    await client.inbox.take((message) =>
      message.kind === "json" &&
      message.value.type === "error" &&
      message.value.code === "voice_realtime_gateway_audio_item_missing" &&
      message.value.fatal
    );
    expect(runtime.cancelSessionTurn).toHaveBeenCalledOnce();
    expect(client.inbox.messages.some((message) => message.kind === "binary"))
      .toBe(false);
  });

  it("rejects an upgrade from an unapproved browser origin", async () => {
    const { url } = await setup();
    const socket = new WebSocket(url, REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2, {
      origin: "https://untrusted.example"
    });
    sockets.push(socket);
    await expect(new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    })).rejects.toBeDefined();
  });

  it("rejects the WebSocket upgrade before acceptance when authentication fails", async () => {
    const manager = new FakeRuntimeManager();
    const server = createRealtimeVoiceGatewayServer({
      authenticate: vi.fn(async () => {
        throw new Error("unauthenticated");
      }),
      runtimeManager: manager,
      allowedOrigins: ["http://localhost:3000"]
    });
    servers.push(server);
    const address = await server.listen({ port: 0 });
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}${REALTIME_VOICE_GATEWAY_PATH}`,
      REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2,
      { origin: "http://localhost:3000" }
    );
    sockets.push(socket);
    await expect(new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    })).rejects.toBeDefined();
    expect(manager.runtimes.size).toBe(0);
  });
});
