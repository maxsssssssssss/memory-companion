// @vitest-environment node

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";

import type { QuestionAnswer } from "@/lib/domain/types";
import { VoiceEvent, type ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceSessionInfo
} from "@/lib/server/voice/types";
import {
  BrowserRealtimeVoiceWebSocketTransport,
  type BrowserWebSocketLike
} from "@/components/voice/browser-realtime-websocket";

import {
  RealtimeVoiceQaController,
  type RealtimeVoiceQaEvent
} from "./realtime-controller";
import {
  REALTIME_VOICE_GATEWAY_PATH,
  createRealtimeVoiceGatewayServer,
  type CreateRealtimeVoiceGatewayRuntimeInput,
  type RealtimeVoiceGatewayRuntime,
  type RealtimeVoiceGatewayRuntimeManager,
  type RealtimeVoiceGatewayServer
} from "./realtime-websocket-gateway";
import type { VoiceQaAnswerer } from "./types";

function providerEvent(
  eventId: VoiceEvent,
  payload?: unknown
): ParsedVoiceServerEvent {
  return {
    eventId,
    eventName: VoiceEvent[eventId],
    sessionId: "mock-provider-session",
    ...(payload === undefined ? {} : { payload }),
    rawPayload: Buffer.alloc(0),
    compressed: false,
    serialization: "json",
    unknown: false
  };
}

class MockRealtimeVoiceProvider implements VoiceProvider {
  readonly sentAudio: Buffer[] = [];
  readonly spokenText: string[] = [];
  private readonly listeners = new Set<(event: ParsedVoiceServerEvent) => void>();

  async connect() {}

  async startSession(_config?: VoiceSessionConfig): Promise<VoiceSessionInfo> {
    return { sessionId: "mock-provider-session", dialogId: "mock-dialog" };
  }

  async sendAudio(chunk: Buffer) {
    this.sentAudio.push(Buffer.from(chunk));
  }

  async finishAudioInput() {}
  async interruptResponse() {}
  async cancelSessionTurn() {}

  async sendText(text: string) {
    this.spokenText.push(text);
    const metadata = {
      tts_type: "chat_tts_text",
      question_id: "question-1",
      reply_id: "reply-1"
    };
    this.emit(providerEvent(VoiceEvent.TTSSentenceStart, metadata));
    this.emit({
      ...providerEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([1, 2])
    });
    this.emit(providerEvent(VoiceEvent.TTSEnded, metadata));
  }

  async finishSession() {}
  async close() {}
  onTranscript() { return () => undefined; }
  onAudio() { return () => undefined; }

  onEvent(listener: (event: ParsedVoiceServerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ParsedVoiceServerEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function canonicalAnswer(question: string): QuestionAnswer {
  return {
    id: "answer-1",
    uploadId: "all_memory",
    question,
    answer: "The confirmed event happened today. [E1]",
    citedSegmentIds: ["segment-1"],
    citations: [{
      id: "E1",
      title: "Confirmed event",
      startSeconds: 1,
      endSeconds: 2,
      excerpt: "The event was confirmed.",
      sourceSegmentIds: ["segment-1"]
    }],
    createdAt: "2026-08-03T00:00:00.000Z"
  };
}

class ControllerRuntime implements RealtimeVoiceGatewayRuntime {
  readonly listeners = new Set<(event: RealtimeVoiceQaEvent) => unknown>();
  readonly controller: RealtimeVoiceQaController;

  constructor(
    readonly sessionId: string,
    readonly userId: string,
    readonly provider: MockRealtimeVoiceProvider,
    answerer: VoiceQaAnswerer
  ) {
    this.controller = new RealtimeVoiceQaController({ provider, answerer });
    this.controller.onEvent((event) => {
      for (const listener of this.listeners) listener(event);
    });
  }

  async start() { await this.controller.start(); }
  subscribe(listener: (event: RealtimeVoiceQaEvent) => unknown) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async sendAudio(chunk: Buffer) { await this.controller.sendAudio(chunk); }
  async startClientTurn() { await this.controller.startClientTurn(); }
  async cancelSessionTurn(expectedTurnSequence?: number) {
    return await this.controller.cancelSessionTurn(
      "barge_in",
      expectedTurnSequence
    );
  }
  async keepAlive() {}
  async markBrowserPlaybackStarted(turnSequence: number) {
    return this.controller.markBrowserPlaybackStarted(turnSequence);
  }
  async truncatePlayback(
    turnSequence: number,
    providerItemId: string,
    audioEndMs: number
  ) {
    return this.controller.truncatePlayback(
      turnSequence,
      providerItemId,
      audioEndMs
    );
  }
  async close() { await this.controller.close(); }
}

class ControllerRuntimeManager implements RealtimeVoiceGatewayRuntimeManager {
  readonly runtimes = new Map<string, ControllerRuntime>();

  async create(input: CreateRealtimeVoiceGatewayRuntimeInput) {
    const runtime = new ControllerRuntime(
      randomUUID(),
      input.userId,
      new MockRealtimeVoiceProvider(),
      { answer: async (request) => canonicalAnswer(request.transcript) }
    );
    this.runtimes.set(runtime.sessionId, runtime);
    await runtime.start();
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

describe("Realtime Voice browser-to-controller WebSocket integration", () => {
  let server: RealtimeVoiceGatewayServer | undefined;
  let transport: BrowserRealtimeVoiceWebSocketTransport | undefined;

  afterEach(async () => {
    await transport?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  });

  it("relays PCM into the controller and returns grounded projection audio", async () => {
    const manager = new ControllerRuntimeManager();
    server = createRealtimeVoiceGatewayServer({
      authenticate: vi.fn(async () => ({
        userId: "user-1",
        store: {} as CreateRealtimeVoiceGatewayRuntimeInput["store"]
      })),
      runtimeManager: manager,
      allowedOrigins: ["http://localhost:3000"]
    });
    const address = await server.listen({ port: 0 });
    const events: RealtimeVoiceQaEvent[] = [];
    const audio: Uint8Array[] = [];
    transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: `ws://127.0.0.1:${address.port}${REALTIME_VOICE_GATEWAY_PATH}`,
      session: { scope: "all" },
      webSocketFactory: (url, protocols) => new NodeWebSocket(
        url,
        protocols,
        { origin: "http://localhost:3000" }
      ) as unknown as BrowserWebSocketLike,
      onEvent: (event) => { events.push(event as RealtimeVoiceQaEvent); },
      onAudio: (frame) => { audio.push(frame.pcm16le); }
    });
    await transport.connect();
    await transport.sendAudio(new Uint8Array([7, 8]), 100);
    const runtime = [...manager.runtimes.values()][0]!;
    await vi.waitFor(() => expect(runtime.provider.sentAudio).toEqual([
      Buffer.from([7, 8])
    ]));

    runtime.provider.emit(providerEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "What happened today?", is_interim: false }]
    }));
    runtime.provider.emit(providerEvent(VoiceEvent.ASREnded));

    await vi.waitFor(() => expect(events.some((event) =>
      event.type === "turn_complete" && event.status === "completed"
    )).toBe(true));
    expect(audio).toEqual([new Uint8Array([1, 2])]);
    expect(runtime.provider.spokenText).toEqual([
      "The confirmed event happened today."
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "answer",
      answer: expect.objectContaining({
        citedSegmentIds: ["segment-1"],
        citations: [expect.objectContaining({ id: "E1" })]
      })
    }));
  });
});
