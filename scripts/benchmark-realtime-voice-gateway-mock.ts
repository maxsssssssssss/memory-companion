import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import {
  REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2,
  decodeRealtimeVoiceGatewayAudioFrameV2,
  encodeRealtimeVoiceGatewayAudioFrameV2
} from "@/lib/voice-realtime-gateway";
import {
  REALTIME_VOICE_GATEWAY_PATH,
  createRealtimeVoiceGatewayServer,
  type CreateRealtimeVoiceGatewayRuntimeInput,
  type RealtimeVoiceGatewayRuntime,
  type RealtimeVoiceGatewayRuntimeManager
} from "@/lib/server/voice-qa/realtime-websocket-gateway";
import type { RealtimeVoiceQaEvent } from "@/lib/server/voice-qa/realtime-controller";

class MockRuntime implements RealtimeVoiceGatewayRuntime {
  readonly listeners = new Set<(event: RealtimeVoiceQaEvent) => unknown>();
  readonly audio: Buffer[] = [];
  cancelCount = 0;

  constructor(readonly sessionId: string, readonly userId: string) {}
  subscribe(listener: (event: RealtimeVoiceQaEvent) => unknown) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async sendAudio(chunk: Buffer) { this.audio.push(Buffer.from(chunk)); }
  async startClientTurn() {}
  async cancelSessionTurn() {
    this.cancelCount += 1;
    return true;
  }
  async keepAlive() {}
  async markBrowserPlaybackStarted() { return true; }
  async truncatePlayback() { return true; }
  async close() {}
  emit(event: RealtimeVoiceQaEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

class MockRuntimeManager implements RealtimeVoiceGatewayRuntimeManager {
  readonly runtimes = new Map<string, MockRuntime>();
  async create(input: CreateRealtimeVoiceGatewayRuntimeInput) {
    const runtime = new MockRuntime(randomUUID(), input.userId);
    this.runtimes.set(runtime.sessionId, runtime);
    return runtime;
  }
  async get(sessionId: string, userId: string) {
    const runtime = this.runtimes.get(sessionId);
    return runtime?.userId === userId ? runtime : undefined;
  }
  async close(sessionId: string, userId: string) {
    const runtime = await this.get(sessionId, userId);
    if (runtime) this.runtimes.delete(sessionId);
  }
}

class Inbox {
  readonly json: Array<Record<string, unknown>> = [];
  readonly audio: ReturnType<typeof decodeRealtimeVoiceGatewayAudioFrameV2>[] = [];
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      if (binary) this.audio.push(decodeRealtimeVoiceGatewayAudioFrameV2(Buffer.from(data as Buffer)));
      else this.json.push(
        JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as Record<string, unknown>
      );
    });
  }
  async wait(predicate: (value: Record<string, unknown>) => boolean) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 2_000) {
      const index = this.json.findIndex(predicate);
      if (index >= 0) return this.json.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("mock gateway benchmark timed out");
  }
}

const manager = new MockRuntimeManager();
const gateway = createRealtimeVoiceGatewayServer({
  authenticate: async () => ({
    userId: "mock-user",
    store: {} as CreateRealtimeVoiceGatewayRuntimeInput["store"]
  }),
  runtimeManager: manager,
  allowedOrigins: ["http://localhost:3000"]
});
const address = await gateway.listen({ port: 0 });
const url = `ws://127.0.0.1:${address.port}${REALTIME_VOICE_GATEWAY_PATH}`;
const sockets: WebSocket[] = [];

async function connect() {
  const socket = new WebSocket(url, REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2, {
    origin: "http://localhost:3000"
  });
  sockets.push(socket);
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, inbox };
}

const results: Array<{ id: string; passed: boolean }> = [];
function progress(id: string, passed: boolean) {
  results.push({ id, passed });
  console.error(`[realtime-gateway-mock] ${results.length}/5 ${id} ${passed ? "passed" : "failed"}`);
}

try {
  const first = await connect();
  first.socket.send(JSON.stringify({ type: "session_start", version: 2, scope: "all" }));
  const ready = await first.inbox.wait((value) => value.type === "ready") as {
    sessionId: string;
  };
  const runtime = manager.runtimes.get(ready.sessionId)!;
  first.socket.send(encodeRealtimeVoiceGatewayAudioFrameV2({
    kind: "input_pcm",
    inputEpoch: 1,
    sequence: 1,
    timestampMs: 1,
    pcm16le: new Uint8Array([1, 2])
  }));
  await first.inbox.wait((value) => value.type === "input_ack" && value.throughSequence === 1);
  progress("normal_turn_transport", runtime.audio.length === 1);

  first.socket.send(encodeRealtimeVoiceGatewayAudioFrameV2({
    kind: "input_pcm",
    inputEpoch: 1,
    sequence: 1,
    timestampMs: 1,
    pcm16le: new Uint8Array([1, 2])
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  progress("duplicate_audio_dedup", runtime.audio.length === 1);

  runtime.emit({
    type: "audio_chunk",
    turnSequence: 1,
    sequence: 1,
    sentenceSequence: 1,
    sentenceChunkSequence: 1,
    supportIds: ["E1"],
    providerItemId: "mock-reply-1",
    audio: Buffer.from([3, 4])
  });
  const startedAt = Date.now();
  while (first.inbox.audio.length === 0 && Date.now() - startedAt < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  progress(
    "bound_client_playback",
    first.inbox.audio[0]?.kind === "output_pcm" &&
      first.inbox.audio[0].providerItemId === "mock-reply-1"
  );

  first.socket.send(JSON.stringify({ type: "interrupt", commandId: "cancel-1" }));
  first.socket.send(JSON.stringify({ type: "interrupt", commandId: "cancel-1" }));
  const firstInterruptAck = await first.inbox.wait(
    (value) => value.type === "command_ack" && value.commandId === "cancel-1"
  );
  const secondInterruptAck = await first.inbox.wait(
    (value) => value.type === "command_ack" && value.commandId === "cancel-1"
  );
  progress(
    "interrupt_idempotency",
    runtime.cancelCount === 1 &&
      firstInterruptAck.status === "applied" &&
      secondInterruptAck.status === "already_applied"
  );

  first.socket.close(1000, "reconnect");
  await new Promise((resolve) => setTimeout(resolve, 20));
  runtime.emit({ type: "turn_complete", turnSequence: 1, status: "completed" });
  const resumed = await connect();
  resumed.socket.send(JSON.stringify({
    type: "session_resume",
    version: 2,
    sessionId: ready.sessionId,
    lastInputAck: 1,
    lastServerAck: 0
  }));
  await resumed.inbox.wait(
    (value) => value.type === "ready" && value.resumed === true
  );
  await resumed.inbox.wait((value) => value.type === "event" && value.name === "turn_complete");
  progress("disconnect_reconnect_replay", true);

  console.log(JSON.stringify({
    benchmarkMode: "local_websocket_transport_contract",
    providerCalls: 0,
    realApiCalls: 0,
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    results
  }, null, 2));
  if (results.some((item) => !item.passed)) process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.close(1000, "benchmark_complete");
  await gateway.close();
}
