import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VoiceAudioQueueError,
  type VoiceAudioQueueOptions
} from "@/lib/client/voice-audio-queue";
import { calculateRealtimeVoiceLatencyMetrics } from "@/lib/voice-realtime-latency";

import { BrowserRealtimeVoiceSession } from "./browser-realtime-voice";

const encoder = new TextEncoder();

class FakeAudioWorkletNode {
  readonly port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: vi.fn()
  };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeCaptureContext {
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  readonly destination = {};
  readonly resume = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly source = {
    connect: vi.fn(),
    disconnect: vi.fn()
  };
  createMediaStreamSource() {
    return this.source;
  }
}

function ndjson(value: unknown) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

describe("BrowserRealtimeVoiceSession", () => {
  const originalAudioContext = globalThis.AudioContext;
  const originalAudioWorkletNode = globalThis.AudioWorkletNode;
  const originalMediaDevices = globalThis.navigator.mediaDevices;

  afterEach(() => {
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: originalAudioContext
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: originalAudioWorkletNode
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices
    });
    vi.restoreAllMocks();
  });

  it("prioritizes VAD barge-in over blocked audio and truncates the exact played item", async () => {
    let eventController!: ReadableStreamDefaultController<Uint8Array>;
    const eventStream = new ReadableStream<Uint8Array>({
      start(controller) {
        eventController = controller;
      }
    });
    const mediaTrack = { stop: vi.fn() };
    const captureContext = new FakeCaptureContext();
    function MockAudioContext() {
      return captureContext;
    }
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: MockAudioContext
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: FakeAudioWorkletNode
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [mediaTrack] }))
      }
    });

    let resolveEnqueue!: () => void;
    const blockedEnqueue = new Promise<void>((resolve) => {
      resolveEnqueue = resolve;
    });
    const queues: Array<{
      options: VoiceAudioQueueOptions;
      prepare: ReturnType<typeof vi.fn>;
      enqueue: ReturnType<typeof vi.fn>;
      finish: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      playbackPosition: ReturnType<typeof vi.fn>;
    }> = [];
    const audioQueueFactory = (options: VoiceAudioQueueOptions) => {
      let playbackReported = false;
      const queue = {
        options,
        prepare: vi.fn(async () => undefined),
        enqueue: vi.fn(async () => {
          if (!playbackReported) {
            playbackReported = true;
            options.onPlaybackStarted?.();
          }
          await blockedEnqueue;
          return "accepted" as const;
        }),
        finish: vi.fn(async () => ({ status: "completed" as const })),
        cancel: vi.fn(async () => undefined),
        playbackPosition: vi.fn(() => ({
          playbackItemId: "reply-7",
          audioEndMs: 240
        }))
      };
      queues.push(queue);
      return queue;
    };
    const playbackBodies: unknown[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/voice/realtime/session") {
        return Response.json({ sessionId: "session-1" }, { status: 201 });
      }
      if (url.endsWith("/events")) return new Response(eventStream);
      if (url.endsWith("/audio")) return new Response(null, { status: 204 });
      if (url.endsWith("/playback")) {
        playbackBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    });
    const session = new BrowserRealtimeVoiceSession({
      scope: "all",
      fetcher,
      audioQueueFactory
    });
    await session.start();

    eventController.enqueue(ndjson({
      type: "asr_final",
      turnSequence: 7,
      transcript: "fixture question"
    }));
    eventController.enqueue(ndjson({
      type: "audio_chunk",
      turnSequence: 7,
      sequence: 1,
      sentenceSequence: 1,
      sentenceChunkSequence: 1,
      providerItemId: "reply-7",
      audioBase64: btoa(String.fromCharCode(1, 2))
    }));
    await vi.waitFor(() => {
      expect(queues[0]?.enqueue).toHaveBeenCalledTimes(1);
    });
    eventController.enqueue(ndjson({ type: "voice_activity" }));

    await vi.waitFor(() => {
      expect(playbackBodies).toContainEqual({
        event: "truncate",
        turnSequence: 7,
        providerItemId: "reply-7",
        audioEndMs: 240
      });
    });
    expect(playbackBodies).toContainEqual({
      event: "browser_playback_start",
      turnSequence: 7
    });
    expect(queues[0]?.cancel).toHaveBeenCalledTimes(1);

    eventController.enqueue(ndjson({
      type: "turn_interrupted",
      turnSequence: 7,
      reason: "barge_in"
    }));
    eventController.enqueue(ndjson({
      type: "audio_chunk",
      turnSequence: 7,
      sequence: 2,
      sentenceSequence: 1,
      sentenceChunkSequence: 2,
      providerItemId: "reply-7",
      audioBase64: btoa(String.fromCharCode(3, 4))
    }));
    resolveEnqueue();
    await Promise.resolve();
    expect(queues.flatMap((queue) => queue.enqueue.mock.calls)).toHaveLength(1);

    await session.stop();
    expect(mediaTrack.stop).toHaveBeenCalledOnce();
  });

  it("re-subscribes after an unexpected event-stream EOF with bounded backoff", async () => {
    let secondController!: ReadableStreamDefaultController<Uint8Array>;
    let eventCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith("/events")) {
        throw new Error("unexpected non-event request");
      }
      eventCalls += 1;
      if (eventCalls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(ndjson({
              type: "session_started",
              providerSessionId: "provider-1"
            }));
            controller.close();
          }
        }));
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          secondController = controller;
        }
      }));
    });
    const session = new BrowserRealtimeVoiceSession({
      scope: "all",
      fetcher,
      reconnectDelayMs: 0
    });
    const internals = session as unknown as {
      sessionId?: string;
      stopping: boolean;
      eventsAbortController?: AbortController;
      startEventStream(): void;
    };
    internals.sessionId = "session-1";
    internals.startEventStream();

    await vi.waitFor(() => expect(eventCalls).toBe(2));
    internals.stopping = true;
    internals.eventsAbortController?.abort();
    secondController.close();
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reopens the streaming audio upload after one transport failure", async () => {
    let audioCalls = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      audioCalls += 1;
      if (audioCalls === 1) {
        return Response.json(
          { error: "voice_realtime_audio_failed" },
          { status: 503 }
        );
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });
    const session = new BrowserRealtimeVoiceSession({
      scope: "all",
      fetcher,
      reconnectDelayMs: 0
    });
    const internals = session as unknown as {
      sessionId?: string;
      stopping: boolean;
      uploadGeneration: number;
      uploadAbortController?: AbortController;
      uploadWriter?: WritableStreamDefaultWriter<Uint8Array>;
      startAudioUpload(): void;
    };
    internals.sessionId = "session-1";
    internals.startAudioUpload();

    await vi.waitFor(() => expect(audioCalls).toBe(2));
    internals.stopping = true;
    internals.uploadGeneration += 1;
    internals.uploadAbortController?.abort();
    await internals.uploadWriter?.abort().catch(() => undefined);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects non-loopback development gateways before opening a WebSocket", async () => {
    const mediaTrack = { stop: vi.fn() };
    const captureContext = new FakeCaptureContext();
    function MockAudioContext() { return captureContext; }
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: MockAudioContext
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: FakeAudioWorkletNode
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [mediaTrack] }))
      }
    });
    const webSocketFactory = vi.fn();
    const session = new BrowserRealtimeVoiceSession({
      scope: "all",
      gatewayUrl: "wss://voice.example.com/realtime",
      webSocketFactory,
      audioQueueFactory: () => ({
        prepare: vi.fn(async () => undefined),
        enqueue: vi.fn(async () => "accepted" as const),
        finish: vi.fn(async () => ({ status: "completed" as const })),
        cancel: vi.fn(async () => undefined)
      })
    });

    await expect(session.start()).rejects.toThrow(
      "voice_realtime_gateway_url_not_allowed"
    );
    expect(webSocketFactory).not.toHaveBeenCalled();
    expect(mediaTrack.stop).toHaveBeenCalledOnce();
  });

  it("releases the microphone before a session-close network handshake settles", async () => {
    const mediaTrack = { stop: vi.fn() };
    let resolveGatewayClose!: () => void;
    const gatewayClose = new Promise<void>((resolve) => {
      resolveGatewayClose = resolve;
    });
    const session = new BrowserRealtimeVoiceSession({ scope: "all" });
    const internals = session as unknown as {
      sessionId?: string;
      mediaStream?: { getTracks(): Array<{ stop(): void }> };
      gatewayTransport?: { close(): Promise<void> };
      stopping: boolean;
      handleEvent(event: { type: "session_closed" }): Promise<void>;
    };
    internals.sessionId = "session-1";
    internals.mediaStream = { getTracks: () => [mediaTrack] };
    internals.gatewayTransport = { close: () => gatewayClose };

    await internals.handleEvent({ type: "session_closed" });
    await vi.waitFor(() => expect(mediaTrack.stop).toHaveBeenCalledOnce());
    expect(internals.stopping).toBe(true);
    resolveGatewayClose();
    await vi.waitFor(() => expect(internals.stopping).toBe(false));
  });

  it("runs five grounded turns in one session and rejects duplicate or stale turn events", async () => {
    let eventController!: ReadableStreamDefaultController<Uint8Array>;
    const eventStream = new ReadableStream<Uint8Array>({
      start(controller) {
        eventController = controller;
      }
    });
    const mediaTrack = { stop: vi.fn() };
    const captureContext = new FakeCaptureContext();
    function MockAudioContext() { return captureContext; }
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: MockAudioContext
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: FakeAudioWorkletNode
    });
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [mediaTrack] }));
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });

    const queues: Array<{
      enqueue: ReturnType<typeof vi.fn>;
      finish: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
    }> = [];
    const audioQueueFactory = (options: VoiceAudioQueueOptions) => {
      let started = false;
      const queue = {
        prepare: vi.fn(async () => undefined),
        enqueue: vi.fn(async () => {
          if (!started) {
            started = true;
            options.onPlaybackStarted?.();
          }
          return "accepted" as const;
        }),
        finish: vi.fn(async () => ({ status: "completed" as const })),
        cancel: vi.fn(async () => undefined)
      };
      queues.push(queue);
      return queue;
    };
    const sessionCreates: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/voice/realtime/session") {
        sessionCreates.push(url);
        return Response.json({ sessionId: "session-5-turns" }, { status: 201 });
      }
      if (url.endsWith("/events")) return new Response(eventStream);
      if (url.endsWith("/audio")) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      if (url.endsWith("/playback")) return Response.json({ ok: true });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    });
    const states: string[] = [];
    const traces: Array<{ turnSequence: number; terminalStatus: string; stateTransitions: unknown[] }> = [];
    const completed: Array<{ id: string; citedSegmentIds: string[] }> = [];
    const session = new BrowserRealtimeVoiceSession({
      scope: "all",
      fetcher,
      audioQueueFactory,
      onStateChange: (state) => states.push(state),
      onTurnTrace: (trace) => traces.push(trace),
      onTurnCompleted: (turn) => completed.push(turn)
    });
    await session.start();

    for (let turnSequence = 1; turnSequence <= 5; turnSequence += 1) {
      const base = turnSequence * 1_000;
      const timestamps = {
        speech_start: base,
        speech_end: base + 120,
        asr_final: base + 140,
        retrieval_start: base + 145,
        retrieval_complete: base + 180,
        qa_start: base + 181,
        llm_first_token: base + 220,
        sentence_commit: base + 240,
        tts_start: base + 245,
        first_audio: base + 260,
        complete: base + 300
      } as const;
      eventController.enqueue(ndjson({
        type: "asr_final",
        turnSequence,
        transcript: `fixture question ${turnSequence}`
      }));
      eventController.enqueue(ndjson({
        type: "turn_state",
        turnSequence,
        state: "speaking"
      }));
      eventController.enqueue(ndjson({
        type: "audio_chunk",
        turnSequence,
        sequence: 1,
        sentenceSequence: 1,
        sentenceChunkSequence: 1,
        providerItemId: `reply-${turnSequence}`,
        audioBase64: btoa(String.fromCharCode(turnSequence, turnSequence + 1))
      }));
      eventController.enqueue(ndjson({
        type: "answer",
        turnSequence,
        transcript: `fixture question ${turnSequence}`,
        text: `grounded answer ${turnSequence}`,
        answer: {
          id: `answer-${turnSequence}`,
          citedSegmentIds: [`segment-${turnSequence}`],
          citations: []
        }
      }));
      eventController.enqueue(ndjson({
        type: "turn_trace",
        turnSequence,
        terminalStatus: "completed",
        terminalReason: "completed",
        latency: {
          version: 1,
          turnSequence,
          timestamps,
          metrics: calculateRealtimeVoiceLatencyMetrics(timestamps)
        },
        reconnectCount: 0,
        interruptLatencyMs: null,
        abortedGenerationCount: 0,
        providerGenerationStarted: true,
        providerGenerationCompleted: true,
        audioChunkCount: 1,
        wastedTokenCount: null
      }));
      eventController.enqueue(ndjson({
        type: "turn_complete",
        turnSequence,
        status: "completed"
      }));
      await vi.waitFor(() => expect(traces).toHaveLength(turnSequence));
      expect(session.snapshot).toMatchObject({
        sessionId: "session-5-turns",
        sessionEpoch: 1,
        state: "listening",
        activeTurnSequence: undefined,
        lastTurnSequence: turnSequence
      });
    }

    eventController.enqueue(ndjson({
      type: "audio_chunk",
      turnSequence: 1,
      sequence: 2,
      sentenceSequence: 1,
      sentenceChunkSequence: 2,
      providerItemId: "reply-1",
      audioBase64: btoa(String.fromCharCode(9, 9))
    }));
    eventController.enqueue(ndjson({
      type: "turn_complete",
      turnSequence: 5,
      status: "completed"
    }));
    await Promise.resolve();

    expect(sessionCreates).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(completed.map((turn) => turn.id)).toEqual([
      "answer-1",
      "answer-2",
      "answer-3",
      "answer-4",
      "answer-5"
    ]);
    expect(completed.every((turn) => turn.citedSegmentIds.length === 1)).toBe(true);
    expect(traces).toHaveLength(5);
    expect(traces.every((trace) => trace.terminalStatus === "completed")).toBe(true);
    expect(traces.every((trace) => JSON.stringify(trace.stateTransitions).includes("speaking")))
      .toBe(true);
    expect(queues).toHaveLength(5);
    expect(queues.flatMap((queue) => queue.enqueue.mock.calls)).toHaveLength(5);
    expect(states).toEqual([
      "listening",
      "thinking", "speaking", "listening",
      "thinking", "speaking", "listening",
      "thinking", "speaking", "listening",
      "thinking", "speaking", "listening",
      "thinking", "speaking", "listening"
    ]);

    await session.stop();
    expect(mediaTrack.stop).toHaveBeenCalledOnce();
  });

  it("ends on semantic idle timeout, resets only for voice activity, and releases resources", async () => {
    vi.useFakeTimers();
    try {
      const mediaTrack = { stop: vi.fn() };
      const captureContext = new FakeCaptureContext();
      function MockAudioContext() { return captureContext; }
      Object.defineProperty(globalThis, "AudioContext", {
        configurable: true,
        value: MockAudioContext
      });
      Object.defineProperty(globalThis, "AudioWorkletNode", {
        configurable: true,
        value: FakeAudioWorkletNode
      });
      Object.defineProperty(globalThis.navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [mediaTrack] }))
        }
      });
      const events = new ReadableStream<Uint8Array>();
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/voice/realtime/session") {
          return Response.json({ sessionId: "idle-session" }, { status: 201 });
        }
        if (url.endsWith("/events")) return new Response(events);
        if (url.endsWith("/audio")) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          });
        }
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        throw new Error(`unexpected fetch ${url}`);
      });
      const ended = vi.fn();
      const session = new BrowserRealtimeVoiceSession({
        scope: "all",
        fetcher,
        idleTimeoutMs: 100,
        audioQueueFactory: () => ({
          prepare: vi.fn(async () => undefined),
          enqueue: vi.fn(async () => "accepted" as const),
          finish: vi.fn(async () => ({ status: "completed" as const })),
          cancel: vi.fn(async () => undefined)
        }),
        onSessionEnded: ended
      });
      await session.start();
      const internals = session as unknown as {
        handleEvent(
          event: { type: "asr_partial"; transcript: string },
          sessionEpoch?: number
        ): Promise<void>;
      };

      await vi.advanceTimersByTimeAsync(80);
      await internals.handleEvent({ type: "asr_partial", transcript: "fixture" }, 1);
      await vi.advanceTimersByTimeAsync(80);
      expect(mediaTrack.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30);
      await Promise.resolve();

      expect(mediaTrack.stop).toHaveBeenCalledOnce();
      expect(session.snapshot).toMatchObject({ state: "idle", lifecycleState: "idle" });
      expect(ended).toHaveBeenCalledWith({
        reason: "idle_timeout",
        sessionId: "idle-session",
        sessionEpoch: 1
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a cancelled startup before transport or worklet creation", async () => {
    const mediaTrack = { stop: vi.fn() };
    const captureContext = new FakeCaptureContext();
    function MockAudioContext() { return captureContext; }
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: MockAudioContext
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: FakeAudioWorkletNode
    });
    let resolveMedia!: (value: { getTracks(): Array<{ stop(): void }> }) => void;
    const getUserMedia = vi.fn(() => new Promise<{ getTracks(): Array<{ stop(): void }> }>(
      (resolve) => { resolveMedia = resolve; }
    ));
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });
    const fetcher = vi.fn();
    const session = new BrowserRealtimeVoiceSession({
      scope: "all",
      fetcher,
      audioQueueFactory: () => ({
        prepare: vi.fn(async () => undefined),
        enqueue: vi.fn(async () => "accepted" as const),
        finish: vi.fn(async () => ({ status: "completed" as const })),
        cancel: vi.fn(async () => undefined)
      })
    });

    const starting = session.start();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await session.stop();
    resolveMedia({ getTracks: () => [mediaTrack] });

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(mediaTrack.stop).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    expect(captureContext.audioWorklet.addModule).not.toHaveBeenCalled();
    expect(session.snapshot).toMatchObject({ state: "idle", lifecycleState: "idle" });
  });

  it("completes a no-audio turn and reports playback failure without a false completion", async () => {
    const traces: Array<{ turnSequence: number; terminalStatus: string; terminalReason: string }> = [];
    const completed = vi.fn();
    const errors: string[] = [];
    const session = new BrowserRealtimeVoiceSession({
      scope: "all",
      fetcher: vi.fn(async () => new Response(null, { status: 204 })),
      audioQueueFactory: (options) => ({
        prepare: vi.fn(async () => undefined),
        enqueue: vi.fn(async () => {
          options.onPlaybackStarted?.();
          return "accepted" as const;
        }),
        finish: vi.fn(async () => ({
          status: "failed" as const,
          error: new VoiceAudioQueueError("closed", "fixture playback failed")
        })),
        cancel: vi.fn(async () => undefined)
      }),
      onTurnTrace: (trace) => traces.push(trace),
      onTurnCompleted: completed,
      onError: (code) => errors.push(code)
    });
    const internals = session as unknown as {
      sessionId?: string;
      sessionEpoch: number;
      lifecycleState: string;
      productState: string;
      handleEvent(event: RealtimeWireEventForTest, sessionEpoch?: number): Promise<void>;
    };
    internals.sessionId = "local-session";
    internals.sessionEpoch = 1;
    internals.lifecycleState = "listening";
    internals.productState = "listening";

    await internals.handleEvent({
      type: "asr_final",
      turnSequence: 1,
      transcript: "no audio fixture"
    }, 1);
    await internals.handleEvent({
      type: "answer",
      turnSequence: 1,
      transcript: "no audio fixture",
      text: "grounded",
      answer: { id: "answer-1", citedSegmentIds: ["segment-1"], citations: [] }
    }, 1);
    await internals.handleEvent({
      type: "turn_complete",
      turnSequence: 1,
      status: "completed"
    }, 1);
    expect(traces).toEqual([
      expect.objectContaining({ turnSequence: 1, terminalStatus: "completed" })
    ]);
    expect(completed).toHaveBeenCalledOnce();

    await internals.handleEvent({
      type: "asr_final",
      turnSequence: 2,
      transcript: "playback failure fixture"
    }, 1);
    await internals.handleEvent({
      type: "audio_chunk",
      turnSequence: 2,
      sequence: 1,
      sentenceSequence: 1,
      sentenceChunkSequence: 1,
      providerItemId: "reply-2",
      audioBase64: btoa(String.fromCharCode(1, 2))
    }, 1);
    await internals.handleEvent({
      type: "turn_complete",
      turnSequence: 2,
      status: "completed"
    }, 1);
    await vi.waitFor(() => expect(traces).toHaveLength(2));

    expect(traces[1]).toMatchObject({
      turnSequence: 2,
      terminalStatus: "failed",
      terminalReason: "playback_failed"
    });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(errors).toContain("voice_realtime_playback_failed");
    expect(session.snapshot).toMatchObject({ state: "listening", activeTurnSequence: undefined });
    await session.stop();
  });
});

type RealtimeWireEventForTest = {
  type: string;
  [key: string]: unknown;
};
