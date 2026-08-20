import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeRealtimeVoiceGatewayAudioFrameV2,
  encodeRealtimeVoiceGatewayAudioFrameV2,
  type RealtimeVoiceGatewayClientControlV2,
  type RealtimeVoiceGatewayServerControlV2
} from "@/lib/voice-realtime-gateway";

import {
  BrowserRealtimeVoiceWebSocketTransport,
  type BrowserWebSocketLike
} from "./browser-realtime-websocket";

class FakeWebSocket extends EventTarget implements BrowserWebSocketLike {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  onSend?: (value: string | Uint8Array) => void;

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const normalized = typeof value === "string"
      ? value
      : value instanceof Uint8Array
        ? value
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array(value as ArrayBuffer);
    this.sent.push(normalized);
    this.onSend?.(normalized);
  }

  receive(value: RealtimeVoiceGatewayServerControlV2 | Uint8Array) {
    const data = value instanceof Uint8Array
      ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      : JSON.stringify(value);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

function control(value: string | Uint8Array) {
  return typeof value === "string"
    ? JSON.parse(value) as RealtimeVoiceGatewayClientControlV2
    : undefined;
}

describe("BrowserRealtimeVoiceWebSocketTransport", () => {
  const transports: BrowserRealtimeVoiceWebSocketTransport[] = [];

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.close()));
    vi.restoreAllMocks();
  });

  it("keeps PCM until the cumulative server ACK and sends monotonic sequences", async () => {
    const socket = new FakeWebSocket();
    socket.onSend = (value) => {
      const message = control(value);
      if (message?.type === "session_start") {
        socket.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      webSocketFactory: () => socket
    });
    transports.push(transport);
    const connecting = transport.connect();
    socket.open();
    await connecting;

    await transport.sendAudio(new Uint8Array([1, 2]), 100);
    await transport.sendAudio(new Uint8Array([3, 4]), 120);
    const frames = socket.sent
      .filter((value): value is Uint8Array => value instanceof Uint8Array)
      .map((value) => decodeRealtimeVoiceGatewayAudioFrameV2(value));
    expect(frames).toMatchObject([
      { kind: "input_pcm", sequence: 1, timestampMs: 100 },
      { kind: "input_pcm", sequence: 2, timestampMs: 120 }
    ]);
    expect(transport.snapshot.unackedAudioFrames).toBe(2);
    socket.receive({ type: "input_ack", throughSequence: 2 });
    await vi.waitFor(() => {
      expect(transport.snapshot).toMatchObject({
        inputAckThrough: 2,
        unackedAudioFrames: 0
      });
    });
  });

  it("keeps the default unacknowledged-audio window aligned with the gateway bound", async () => {
    const socket = new FakeWebSocket();
    socket.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        socket.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      webSocketFactory: () => socket
    });
    transports.push(transport);
    const connecting = transport.connect();
    socket.open();
    await connecting;

    for (let sequence = 1; sequence <= 101; sequence += 1) {
      await transport.sendAudio(
        new Uint8Array([sequence & 0xff, (sequence >> 8) & 0xff]),
        sequence
      );
    }

    expect(transport.snapshot.unackedAudioFrames).toBe(101);
  });

  it("uses an application close code for browser-side protocol failures", async () => {
    const socket = new FakeWebSocket();
    const errors: string[] = [];
    socket.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        socket.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          inputEpoch: 1,
          providerEpoch: 1,
          resumed: false,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://127.0.0.1:3011/api/voice/realtime/gateway",
      session: { scope: "all" },
      reconnectDelayMs: 5_000,
      webSocketFactory: () => socket,
      onError: (error) => errors.push(error)
    });
    transports.push(transport);
    const connecting = transport.connect();
    socket.open();
    await connecting;

    socket.receive(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(socket.closeCalls).toContainEqual({
      code: 4003,
      reason: "protocol_error"
    }));
    expect(socket.closeCalls.some(({ code }) => code === 1002)).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("uses browser-legal application close codes for connection and transport failures", async () => {
    const connectionSocket = new FakeWebSocket();
    const connectionTransport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://127.0.0.1:3011/api/voice/realtime/gateway",
      session: { scope: "all" },
      maxReconnectAttempts: 0,
      webSocketFactory: () => connectionSocket
    });
    transports.push(connectionTransport);
    const connecting = connectionTransport.connect();
    connectionSocket.dispatchEvent(new Event("error"));
    await expect(connecting).rejects.toThrow(
      "voice_realtime_gateway_connection_failed"
    );
    expect(connectionSocket.closeCalls).toContainEqual({
      code: 4004,
      reason: "connection_failed"
    });

    const transportSocket = new FakeWebSocket();
    transportSocket.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        transportSocket.receive({
          type: "ready",
          version: 2,
          sessionId: "22222222-2222-4222-8222-222222222222",
          connectionId: "connection-2",
          inputEpoch: 1,
          providerEpoch: 1,
          resumed: false,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://127.0.0.1:3011/api/voice/realtime/gateway",
      session: { scope: "all" },
      maxReconnectAttempts: 0,
      webSocketFactory: () => transportSocket
    });
    transports.push(transport);
    const transportConnecting = transport.connect();
    transportSocket.open();
    await transportConnecting;
    transportSocket.onSend = (value) => {
      if (value instanceof Uint8Array) throw new Error("socket_send_failed");
    };
    await transport.sendAudio(new Uint8Array([1, 2]), 1);
    await vi.waitFor(() => expect(transportSocket.closeCalls).toContainEqual({
      code: 4005,
      reason: "transport_failure"
    }));

    for (const { code } of [
      ...connectionSocket.closeCalls,
      ...transportSocket.closeCalls
    ]) {
      expect(code === 1000 || (code >= 3000 && code <= 4999)).toBe(true);
    }
  });

  it("resumes with both cursors and replays only unacknowledged input", async () => {
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    const sockets = [first, second];
    let factoryCalls = 0;
    first.onSend = (value) => {
      const message = control(value);
      if (message?.type === "session_start") {
        first.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    second.onSend = (value) => {
      const message = control(value);
      if (message?.type === "session_resume") {
        second.receive({
          type: "ready",
          version: 2,
          sessionId: message.sessionId,
          connectionId: "connection-2",
          resumed: true,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 1,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      reconnectDelayMs: 0,
      webSocketFactory: () => sockets[factoryCalls++]!
    });
    transports.push(transport);
    const connecting = transport.connect();
    first.open();
    await connecting;
    await transport.sendAudio(new Uint8Array([1, 2]), 10);
    first.receive({ type: "input_ack", throughSequence: 1 });
    await vi.waitFor(() => expect(transport.snapshot.inputAckThrough).toBe(1));
    await transport.sendAudio(new Uint8Array([3, 4]), 20);

    first.close(1006, "network");
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    second.open();
    await vi.waitFor(() => expect(transport.snapshot.connectionId).toBe("connection-2"));
    const resume = second.sent
      .map(control)
      .find((message) => message?.type === "session_resume");
    expect(resume).toMatchObject({
      type: "session_resume",
      lastInputAck: 1,
      lastServerAck: 0
    });
    const replayed = second.sent
      .filter((value): value is Uint8Array => value instanceof Uint8Array)
      .map((value) => decodeRealtimeVoiceGatewayAudioFrameV2(value));
    expect(replayed).toMatchObject([{ kind: "input_pcm", sequence: 2 }]);
  });

  it("ACKs ordered server events and output audio only after callbacks settle", async () => {
    const socket = new FakeWebSocket();
    const observed: string[] = [];
    socket.onSend = (value) => {
      const message = control(value);
      if (message?.type === "session_start") {
        socket.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      webSocketFactory: () => socket,
      onEvent: async () => { observed.push("event"); },
      onAudio: async () => { observed.push("audio"); }
    });
    transports.push(transport);
    const connecting = transport.connect();
    socket.open();
    await connecting;
    socket.receive({
      type: "event",
      serverSequence: 1,
      name: "asr_partial",
      event: { type: "asr_partial", transcript: "测试" }
    });
    socket.receive(encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "output_pcm",
      providerEpoch: 1,
      serverSequence: 2,
      turnSequence: 1,
      sequence: 1,
      sentenceSequence: 1,
      itemOffsetSamples: 0,
      providerItemId: "reply-1",
      pcm16le: new Uint8Array([1, 2])
    }));
    await vi.waitFor(() => expect(observed).toEqual(["event", "audio"]));
    const acknowledgements = socket.sent
      .map(control)
      .filter((message) => message?.type === "server_ack");
    expect(acknowledgements).toMatchObject([
      { type: "server_ack", throughSequence: 1 },
      { type: "server_ack", throughSequence: 2 }
    ]);
  });

  it("drops the old unacknowledged utterance when the Provider input epoch changes", async () => {
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    let factoryCalls = 0;
    first.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        first.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    second.onSend = (value) => {
      const message = control(value);
      if (message?.type === "session_resume") {
        second.receive({
          type: "ready",
          version: 2,
          sessionId: message.sessionId,
          connectionId: "connection-2",
          resumed: true,
          inputEpoch: 2,
          providerEpoch: 2,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      reconnectDelayMs: 0,
      webSocketFactory: () => [first, second][factoryCalls++]!
    });
    transports.push(transport);
    const connecting = transport.connect();
    first.open();
    await connecting;
    await transport.sendAudio(new Uint8Array([1, 2]), 10);
    expect(transport.snapshot.unackedAudioFrames).toBe(1);
    first.close(1012, "provider_restarted");
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    second.open();
    await vi.waitFor(() => expect(transport.snapshot.inputEpoch).toBe(2));
    expect(transport.snapshot.unackedAudioFrames).toBe(0);
    await transport.sendAudio(new Uint8Array([3, 4]), 20);
    const frames = second.sent
      .filter((value): value is Uint8Array => value instanceof Uint8Array)
      .map((value) => decodeRealtimeVoiceGatewayAudioFrameV2(value));
    expect(frames).toMatchObject([
      { kind: "input_pcm", inputEpoch: 2, sequence: 1 }
    ]);
  });

  it("closes and reconnects after an active protocol reset, ignoring the old socket", async () => {
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    let factoryCalls = 0;
    const events: unknown[] = [];
    const errors: string[] = [];
    first.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        first.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    second.onSend = (value) => {
      const message = control(value);
      if (message?.type === "session_resume") {
        second.receive({
          type: "ready",
          version: 2,
          sessionId: message.sessionId,
          connectionId: "connection-2",
          resumed: true,
          inputEpoch: 2,
          providerEpoch: 2,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      reconnectDelayMs: 0,
      webSocketFactory: () => [first, second][factoryCalls++]!,
      onEvent: (event) => { events.push(event); },
      onError: (error) => { errors.push(error); }
    });
    transports.push(transport);
    const connecting = transport.connect();
    first.open();
    await connecting;

    first.receive({ type: "resync_required", reason: "provider_restarted" });
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    first.receive({
      type: "event",
      serverSequence: 1,
      name: "asr_partial",
      event: { type: "asr_partial", transcript: "stale" }
    });
    second.open();
    await vi.waitFor(() => expect(transport.snapshot.providerEpoch).toBe(2));
    expect(events).toEqual([]);
    expect(errors).toContain("voice_realtime_gateway_provider_restarted");
  });

  it("consumes retired Provider replay frames without admitting them to playback", async () => {
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    let factoryCalls = 0;
    const playedEpochs: number[] = [];
    first.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        first.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    second.onSend = (value) => {
      const message = control(value);
      if (message?.type === "session_resume") {
        second.receive({
          type: "ready",
          version: 2,
          sessionId: message.sessionId,
          connectionId: "connection-2",
          resumed: true,
          inputEpoch: 2,
          providerEpoch: 2,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 1
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      reconnectDelayMs: 0,
      webSocketFactory: () => [first, second][factoryCalls++]!,
      onAudio: (frame) => { playedEpochs.push(frame.providerEpoch); }
    });
    transports.push(transport);
    const connecting = transport.connect();
    first.open();
    await connecting;
    first.close(1012, "provider_restarted");
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    second.open();
    await vi.waitFor(() => expect(transport.snapshot.providerEpoch).toBe(2));

    second.receive(encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "output_pcm",
      providerEpoch: 1,
      serverSequence: 1,
      turnSequence: 1,
      sequence: 1,
      sentenceSequence: 1,
      itemOffsetSamples: 0,
      providerItemId: "retired-reply",
      pcm16le: new Uint8Array([1, 2])
    }));
    second.receive(encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "output_pcm",
      providerEpoch: 2,
      serverSequence: 2,
      turnSequence: 2,
      sequence: 1,
      sentenceSequence: 1,
      itemOffsetSamples: 0,
      providerItemId: "fresh-reply",
      pcm16le: new Uint8Array([3, 4])
    }));
    await vi.waitFor(() => expect(transport.snapshot.serverAckThrough).toBe(2));
    expect(playedEpochs).toEqual([2]);
  });

  it("fails closed when ready claims an input ACK the browser never allocated", async () => {
    const socket = new FakeWebSocket();
    socket.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        socket.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 1,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      maxReconnectAttempts: 0,
      webSocketFactory: () => socket
    });
    transports.push(transport);
    const connecting = transport.connect();
    socket.open();
    await expect(connecting).rejects.toThrow(
      "voice_realtime_gateway_input_ack_ahead"
    );
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("closes promptly while an exponential reconnect delay is pending", async () => {
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    let factoryCalls = 0;
    first.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        first.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      reconnectDelayMs: 5_000,
      webSocketFactory: () => [first, second][factoryCalls++]!
    });
    transports.push(transport);
    const connecting = transport.connect();
    first.open();
    await connecting;
    first.close(1006, "network");
    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    const startedAt = Date.now();
    await transport.close();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(factoryCalls).toBe(1);
  });

  it("fails once after bounded reconnect attempts are exhausted", async () => {
    const first = new FakeWebSocket();
    const sockets: FakeWebSocket[] = [first];
    first.onSend = (value) => {
      if (control(value)?.type === "session_start") {
        first.receive({
          type: "ready",
          version: 2,
          sessionId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-1",
          resumed: false,
          inputEpoch: 1,
          providerEpoch: 1,
          inputAckThrough: 0,
          replayFrom: 1,
          serverSequence: 0
        });
      }
    };
    let factoryCalls = 0;
    const states: string[] = [];
    const errors: string[] = [];
    const transport = new BrowserRealtimeVoiceWebSocketTransport({
      url: "ws://localhost/gateway",
      session: { scope: "all" },
      reconnectDelayMs: 0,
      maxReconnectAttempts: 2,
      onStateChange: (state) => states.push(state),
      onError: (code) => errors.push(code),
      webSocketFactory: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) return first;
        const socket = new FakeWebSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          socket.close(1006, "network");
        });
        return socket;
      }
    });
    transports.push(transport);
    const connecting = transport.connect();
    first.open();
    await connecting;

    first.close(1006, "network");
    await vi.waitFor(() => expect(states.filter((state) => state === "failed")).toHaveLength(1));

    expect(factoryCalls).toBe(3);
    expect(states.filter((state) => state === "reconnecting")).toHaveLength(2);
    expect(errors.filter((code) => code === "voice_realtime_gateway_reconnect_exhausted"))
      .toHaveLength(1);
    expect(sockets.slice(1).every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
  });
});
