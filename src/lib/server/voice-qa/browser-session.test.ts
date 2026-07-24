import { describe, expect, it, vi } from "vitest";

import type { QuestionAnswer } from "@/lib/domain/types";
import type { VoiceQAResponse, VoiceQaSessionSnapshot } from "./types";
import type { VoiceSessionTraceRecorder } from "./trace";
import {
  BrowserVoiceQaSessionError,
  runBrowserVoiceQaSession,
  type BrowserVoiceQaBridgeLike
} from "./browser-session";

const answer: QuestionAnswer = {
  id: "answer_1",
  uploadId: "all_memory",
  question: "今天有什么重要事情？",
  answer: "今天有一件值得留意的事情。[E1]",
  citedSegmentIds: ["segment_1"],
  citations: [
    {
      id: "citation_1",
      title: "当天片段",
      startSeconds: 10,
      endSeconds: 12,
      excerpt: "一段可追溯证据",
      sourceSegmentIds: ["segment_1"]
    }
  ],
  createdAt: "2026-07-20T10:00:00.000Z"
};

const voiceResponse: VoiceQAResponse = {
  sessionId: "provider_session_1",
  transcript: "今天有什么重要事情？",
  mode: "VOICE",
  text: "今天有一件值得留意的事情。",
  answer,
  audio: Buffer.from([0, 0, 1, 0])
};

class FakeBridge implements BrowserVoiceQaBridgeLike {
  private listener?: (response: VoiceQAResponse) => void;
  private state: VoiceQaSessionSnapshot["state"] = "idle";
  readonly order: string[] = [];
  readonly start = vi.fn(async () => {
    this.order.push("start");
    return this.snapshot();
  });
  readonly sendAudio = vi.fn(async () => undefined);
  readonly finishAudioInput = vi.fn(async () => {
    this.order.push("finish-audio-input");
  });
  readonly handleAsrTimeout = vi.fn(async (): Promise<VoiceQAResponse | null> => null);
  readonly abort = vi.fn(async () => {
    this.order.push("abort");
    this.state = "closed";
  });
  readonly close = vi.fn(async () => {
    this.order.push("close");
    this.state = "closed";
  });

  onResponse(listener: (response: VoiceQAResponse) => void) {
    this.order.push("listen");
    this.listener = listener;
    return () => {
      this.order.push("unsubscribe");
      this.listener = undefined;
    };
  }

  emit(response: VoiceQAResponse) {
    this.listener?.(response);
  }

  snapshot(): VoiceQaSessionSnapshot {
    return {
      id: "provider_session_1",
      state: this.state,
      userId: "user_1",
      startedAt: "2026-07-20T10:00:00.000Z",
      history: []
    };
  }
}

function dependencies(bridge = new FakeBridge()) {
  const provider = { provider: true };
  const answerer = { answer: vi.fn() };
  const createVoiceProvider = vi.fn(() => provider);
  const createMemoryVoiceQaAnswerer = vi.fn(() => answerer);
  const createBridge = vi.fn(() => bridge);
  const convertBrowserAudioToPcm16 = vi.fn(async () => Buffer.alloc(1_280, 1));
  const streamBrowserPcmToVoiceBridge = vi.fn(async () => {
    bridge.emit(voiceResponse);
    return { bytesSent: 1_280, packetCount: 2, durationMs: 40 };
  });

  return {
    bridge,
    provider,
    answerer,
    createVoiceProvider,
    createMemoryVoiceQaAnswerer,
    createBridge,
    convertBrowserAudioToPcm16,
    streamBrowserPcmToVoiceBridge
  };
}

function traceRecorder() {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    mark: vi.fn(() => true),
    setProviderSessionId: vi.fn(),
    recordFailure: vi.fn(),
    complete: vi.fn(),
    snapshot: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined)
  } as unknown as VoiceSessionTraceRecorder;
}

describe("runBrowserVoiceQaSession", () => {
  it("converts one browser recording and runs it through one existing Voice QA bridge", async () => {
    const deps = dependencies();
    const store = { read: vi.fn() } as never;
    const trace = traceRecorder();

    const result = await runBrowserVoiceQaSession({
      audio: Buffer.from([1, 2, 3]),
      mimeType: "audio/webm;codecs=opus",
      userId: "user_1",
      store,
      scope: "all",
      trace
    }, deps as never);

    expect(deps.convertBrowserAudioToPcm16).toHaveBeenCalledOnce();
    expect(deps.convertBrowserAudioToPcm16).toHaveBeenCalledWith({
      audio: Buffer.from([1, 2, 3]),
      mimeType: "audio/webm;codecs=opus",
      signal: expect.any(AbortSignal)
    });
    expect(deps.createVoiceProvider).toHaveBeenCalledOnce();
    expect(deps.createMemoryVoiceQaAnswerer).toHaveBeenCalledWith({
      userId: "user_1",
      store,
      scope: "all"
    });
    expect(deps.createBridge).toHaveBeenCalledWith(expect.objectContaining({
      provider: deps.provider,
      answerer: deps.answerer,
      userId: "user_1",
      scope: "all",
      responseMode: "VOICE",
      trace,
      sessionConfig: {
        inputMode: "push_to_talk",
        audioOutput: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
      }
    }));
    expect(deps.bridge.order.slice(0, 2)).toEqual(["listen", "start"]);
    expect(deps.streamBrowserPcmToVoiceBridge).toHaveBeenCalledWith(
      Buffer.alloc(1_280, 1),
      deps.bridge,
      { signal: expect.any(AbortSignal) }
    );
    expect(deps.bridge.close).toHaveBeenCalledOnce();
    expect(deps.bridge.finishAudioInput).toHaveBeenCalledOnce();
    expect(deps.bridge.order.indexOf("finish-audio-input"))
      .toBeLessThan(deps.bridge.order.indexOf("close"));
    expect(trace.setProviderSessionId).toHaveBeenCalledWith("provider_session_1");
    expect(vi.mocked(trace.mark).mock.calls.map((call) => call[0])).toEqual([
      "speech_started",
      "speech_ended"
    ]);
    expect(trace.flush).toHaveBeenCalledOnce();
    expect(result.response).toEqual(voiceResponse);
    expect(result.session.state).toBe("closed");
    expect(result.response.answer?.citations).toEqual(answer.citations);
  });

  it("passes the opt-in streaming callback and the turn deadline signal to the bridge", async () => {
    const deps = dependencies();
    const onStreamingEvent = vi.fn();

    await runBrowserVoiceQaSession({
      audio: Buffer.from([1, 2, 3]),
      mimeType: "audio/webm",
      userId: "user_1",
      store: {} as never,
      scope: "all",
      onStreamingEvent
    }, deps as never);

    expect(deps.createBridge).toHaveBeenCalledWith(expect.objectContaining({
      onStreamingEvent,
      streamingSignal: expect.any(AbortSignal)
    }));
  });

  it("passes current upload and week reference date only through the existing answerer", async () => {
    const currentDeps = dependencies();
    const context = {
      contextId: "upload_1",
      segments: [],
      audioInsights: [],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: []
    };
    await runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/wav",
      userId: "user_1",
      store: {} as never,
      scope: "current",
      uploadId: "upload_1",
      context
    }, currentDeps as never);
    expect(currentDeps.createMemoryVoiceQaAnswerer).toHaveBeenCalledWith(expect.objectContaining({
      scope: "current",
      uploadId: "upload_1",
      context
    }));

    const weekDeps = dependencies();
    const referenceDate = new Date("2026-07-20T00:00:00.000Z");
    await runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/wav",
      userId: "user_1",
      store: {} as never,
      scope: "week",
      referenceDate
    }, weekDeps as never);
    expect(weekDeps.createMemoryVoiceQaAnswerer).toHaveBeenCalledWith(expect.objectContaining({
      scope: "week",
      referenceDate
    }));
  });

  it("passes the per-request Direct mode only to the existing answer strategy adapter", async () => {
    const deps = dependencies();

    await runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/wav",
      userId: "user_1",
      store: {} as never,
      scope: "all",
      answerMode: "direct"
    }, deps as never);

    expect(deps.createMemoryVoiceQaAnswerer).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      scope: "all",
      answerMode: "direct"
    }));
  });

  it("passes the managed session context and lifecycle hooks into the bridge", async () => {
    const deps = dependencies();
    const onLifecycleStateChange = vi.fn();
    const onTurnCompleted = vi.fn();
    const conversation = [{ role: "user" as const, content: "刚才在说经理沟通" }];

    await runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/wav",
      userId: "user_1",
      store: {} as never,
      scope: "all",
      applicationSessionId: "conversation-session",
      conversation,
      onLifecycleStateChange,
      onTurnCompleted
    }, deps as never);

    expect(deps.createBridge).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "conversation-session",
      initialConversation: conversation,
      onLifecycleStateChange,
      onTurnCompleted
    }));
  });

  it("forwards an explicitly empty initial conversation without synthesizing history", async () => {
    const deps = dependencies();

    await runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/wav",
      userId: "user_1",
      store: {} as never,
      scope: "all",
      conversation: []
    }, deps as never);

    expect(deps.createBridge).toHaveBeenCalledWith(expect.objectContaining({
      initialConversation: []
    }));
  });

  it("uses the bounded ASR timeout fallback instead of hanging the whole request", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      bridge.handleAsrTimeout.mockResolvedValue({
        ...voiceResponse,
        audio: undefined,
        text: "没听清楚，可以再说一遍吗？",
        errors: ["asr_failed"],
        errorCodes: ["VOICE_ASR_TIMEOUT"]
      });
      const deps = dependencies(bridge);
      deps.streamBrowserPcmToVoiceBridge.mockResolvedValue({
        bytesSent: 1_280,
        packetCount: 2,
        durationMs: 40
      });

      const resultPromise = runBrowserVoiceQaSession({
        audio: Buffer.from([1]),
        mimeType: "audio/wav",
        userId: "user_1",
        store: {} as never,
        scope: "all",
        asrTimeoutMs: 1_000
      }, deps as never);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(bridge.handleAsrTimeout).toHaveBeenCalledOnce();
      expect(result.response.errorCodes).toEqual(["VOICE_ASR_TIMEOUT"]);
      expect(result.response.text).toContain("再说一遍");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting for slow QA after ASR has already finalized", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      const deps = dependencies(bridge);
      deps.streamBrowserPcmToVoiceBridge.mockResolvedValue({
        bytesSent: 1_280,
        packetCount: 2,
        durationMs: 40
      });
      setTimeout(() => bridge.emit(voiceResponse), 1_500);

      const resultPromise = runBrowserVoiceQaSession({
        audio: Buffer.from([1]),
        mimeType: "audio/wav",
        userId: "user_1",
        store: {} as never,
        scope: "all",
        asrTimeoutMs: 1_000,
        responseTimeoutMs: 5_000
      }, deps as never);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(bridge.handleAsrTimeout).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(500);

      await expect(resultPromise).resolves.toMatchObject({ response: voiceResponse });
      expect(bridge.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns text without audio when the existing bridge reports TTS fallback", async () => {
    const deps = dependencies();
    const response = { ...voiceResponse, audio: undefined, errors: ["tts_failed" as const] };
    deps.streamBrowserPcmToVoiceBridge.mockImplementationOnce(async () => {
      deps.bridge.emit(response);
      return { bytesSent: 1_280, packetCount: 2, durationMs: 40 };
    });

    const result = await runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/webm",
      userId: "user_1",
      store: {} as never,
      scope: "all"
    }, deps as never);

    expect(result.response.text).toBe(voiceResponse.text);
    expect(result.response.audio).toBeUndefined();
    expect(result.response.errors).toEqual(["tts_failed"]);
  });

  it("logs one safe aggregate PCM summary after every packet is sent", async () => {
    vi.stubEnv("VOICE_DEBUG", "true");
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const deps = dependencies();
      const pcm = Buffer.alloc(1_280);
      for (let index = 0; index < pcm.byteLength / 2; index += 1) {
        pcm.writeInt16LE(index % 2 === 0 ? 0 : 8_192, index * 2);
      }
      deps.convertBrowserAudioToPcm16.mockResolvedValueOnce(pcm);
      const privateInput = "private browser recording bytes";

      await runBrowserVoiceQaSession({
        audio: Buffer.from(privateInput),
        mimeType: "audio/webm",
        userId: "user_1",
        store: {} as never,
        scope: "all"
      }, deps as never);

      expect(logger).toHaveBeenCalledOnce();
      expect(logger.mock.calls[0]?.[0]).toBe(
        "VOICE_DEBUG {\"event\":\"browser_pcm_stream_completed\",\"duration_ms\":40," +
        "\"pcm_bytes\":1280,\"packet_count\":2,\"peak_dbfs\":-12,\"rms_dbfs\":-15.1," +
        "\"non_silent_ratio\":0.5,\"likely_silent\":false}"
      );
      expect(logger.mock.calls[0]?.[0]).not.toContain(privateInput);
      expect(logger.mock.calls[0]?.[0]).not.toContain(voiceResponse.transcript);
      expect(logger.mock.calls[0]?.[0]).not.toContain(voiceResponse.text);
    } finally {
      logger.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("does not log PCM diagnostics while VOICE_DEBUG is disabled", async () => {
    vi.stubEnv("VOICE_DEBUG", "false");
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const deps = dependencies();
      await runBrowserVoiceQaSession({
        audio: Buffer.from([1]),
        mimeType: "audio/webm",
        userId: "user_1",
        store: {} as never,
        scope: "all"
      }, deps as never);

      expect(logger).not.toHaveBeenCalled();
    } finally {
      logger.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("closes the bridge when streaming fails", async () => {
    const deps = dependencies();
    deps.streamBrowserPcmToVoiceBridge.mockRejectedValueOnce(new Error("audio send failed"));

    await expect(runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/webm",
      userId: "user_1",
      store: {} as never,
      scope: "all"
    }, deps as never)).rejects.toThrow("audio send failed");
    expect(deps.bridge.close).toHaveBeenCalledOnce();
    expect(deps.bridge.finishAudioInput).not.toHaveBeenCalled();
    expect(deps.bridge.order).toContain("unsubscribe");
  });

  it("closes the bridge when provider session startup fails", async () => {
    const deps = dependencies();
    deps.bridge.start.mockRejectedValueOnce(new Error("connection failed"));

    await expect(runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/webm",
      userId: "user_1",
      store: {} as never,
      scope: "all"
    }, deps as never)).rejects.toThrow("connection failed");
    expect(deps.bridge.close).toHaveBeenCalledOnce();
    expect(deps.streamBrowserPcmToVoiceBridge).not.toHaveBeenCalled();
  });

  it("aborts without opening a provider session when the request is already cancelled", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    controller.abort();

    await expect(runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/webm",
      userId: "user_1",
      store: {} as never,
      scope: "all",
      signal: controller.signal
    }, deps as never)).rejects.toMatchObject({ code: "request_aborted" });
    expect(deps.convertBrowserAudioToPcm16).not.toHaveBeenCalled();
    expect(deps.createVoiceProvider).not.toHaveBeenCalled();
  });

  it("hard-aborts on timeout without waiting for a draining close", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      deps.bridge.close.mockImplementationOnce(() => new Promise<void>(() => undefined));
      deps.streamBrowserPcmToVoiceBridge.mockResolvedValueOnce({
        bytesSent: 1_280,
        packetCount: 2,
        durationMs: 40
      });
      const pending = runBrowserVoiceQaSession({
        audio: Buffer.from([1]),
        mimeType: "audio/webm",
        userId: "user_1",
        store: {} as never,
        scope: "all",
        responseTimeoutMs: 1_000
      }, deps as never);

      const assertion = expect(pending).rejects.toBeInstanceOf(BrowserVoiceQaSessionError);
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
      expect(deps.bridge.abort).toHaveBeenCalledOnce();
      expect(deps.bridge.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard-aborts a live session when the request is cancelled", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    deps.bridge.close.mockImplementationOnce(() => new Promise<void>(() => undefined));
    deps.streamBrowserPcmToVoiceBridge.mockResolvedValueOnce({
      bytesSent: 1_280,
      packetCount: 2,
      durationMs: 40
    });

    const pending = runBrowserVoiceQaSession({
      audio: Buffer.from([1]),
      mimeType: "audio/webm",
      userId: "user_1",
      store: {} as never,
      scope: "all",
      signal: controller.signal,
      responseTimeoutMs: 5_000
    }, deps as never);

    await vi.waitFor(() => expect(deps.bridge.start).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "request_aborted" });
    expect(deps.bridge.abort).toHaveBeenCalledOnce();
    expect(deps.bridge.close).not.toHaveBeenCalled();
  });
});
