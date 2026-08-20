// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

type RecordedShadowReviewVoiceOutcome = {
  caseId: string;
  userId: string;
  traceId: string;
  metrics: {
    asrLatencyMs: number | null;
    llmFirstTokenLatencyMs: number | null;
    firstPlayableSentenceLatencyMs: number | null;
    firstAudioLatencyMs: number | null;
    completeLatencyMs: number | null;
    streamingComplete: boolean;
    ttsFailure: string | null;
  };
};

const recordVoiceQaShadowReviewVoiceOutcome = vi.hoisted(() =>
  vi.fn(async (_input: RecordedShadowReviewVoiceOutcome) => undefined)
);
vi.mock("@/lib/server/evaluation/voice-qa-shadow-review", () => ({
  recordVoiceQaShadowReviewVoiceOutcome
}));

import type { QuestionAnswer } from "@/lib/domain/types";
import type { QaAnswerStreamEvent } from "@/lib/server/retrieval/qa-streaming";
import { VoiceEvent, type ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceSessionInfo
} from "@/lib/server/voice/types";
import { VoiceProviderError } from "@/lib/server/voice/types";
import type { VoiceQaAnswerer, VoiceQARequest, VoiceQAResponse } from "./types";
import type { VoiceSessionTraceRecorder } from "./trace";
import { VoiceQaBridge, type VoiceQaStreamingOutputEvent } from "./bridge";

function serverEvent(
  eventId: VoiceEvent,
  payload?: unknown,
  sessionId = "voice-session"
): ParsedVoiceServerEvent {
  return {
    eventId,
    eventName: VoiceEvent[eventId],
    sessionId,
    ...(payload === undefined ? {} : { payload }),
    rawPayload: Buffer.alloc(0),
    compressed: false,
    serialization: "json",
    unknown: false
  };
}

class BridgeVoiceProvider implements VoiceProvider {
  readonly sentTexts: string[] = [];
  readonly calls: string[] = [];
  failTts = false;
  failAudio = false;
  autoCompleteTts = true;
  stallSendText = false;
  stallSendAudio = false;
  stallClose = false;
  rejectPendingAudio?: (error: Error) => void;
  failAudioWithConnectionOnce = false;
  failFinishAudioWithConnectionOnce = false;
  failTtsWithConnectionOnce = false;
  failReconnect = false;
  autoCompleteTtsAfterReconnect = false;
  reconnectCount = 0;
  startConfig?: VoiceSessionConfig;
  currentSessionId = "voice-session";
  private readonly audioCallbacks = new Set<(audio: Buffer) => void>();
  private readonly eventCallbacks = new Set<(event: ParsedVoiceServerEvent) => void>();

  async connect() {
    this.calls.push("connect");
  }

  async startSession(config?: VoiceSessionConfig): Promise<VoiceSessionInfo> {
    this.calls.push("start");
    this.startConfig = config;
    this.currentSessionId = "voice-session";
    return { sessionId: this.currentSessionId };
  }

  async sendAudio(_chunk: Buffer) {
    this.calls.push("send-audio");
    if (this.failAudioWithConnectionOnce) {
      this.failAudioWithConnectionOnce = false;
      throw new VoiceProviderError("connection_closed", "socket lost");
    }
    if (this.failAudio) throw new Error("asr unavailable");
    if (this.stallSendAudio) {
      return new Promise<void>((_resolve, reject) => {
        this.rejectPendingAudio = reject;
      });
    }
  }

  async finishAudioInput() {
    this.calls.push("finish-audio-input");
    if (this.failFinishAudioWithConnectionOnce) {
      this.failFinishAudioWithConnectionOnce = false;
      throw new VoiceProviderError("connection_closed", "socket lost while ending ASR");
    }
  }

  async interruptResponse() {
    this.calls.push("interrupt-response");
    this.emit(serverEvent(VoiceEvent.TTSEnded, {
      tts_type: "default",
      question_id: "provider-question",
      reply_id: "provider-reply"
    }, this.currentSessionId));
  }

  async sendText(text: string) {
    this.calls.push("send-text");
    this.sentTexts.push(text);
    if (this.failTtsWithConnectionOnce) {
      this.failTtsWithConnectionOnce = false;
      throw new VoiceProviderError("connection_closed", "socket lost during TTS");
    }
    if (this.failTts) throw new Error("tts unavailable");
    if (this.stallSendText) return new Promise<void>(() => undefined);
    if (!this.autoCompleteTts) return;
    this.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      question_id: "question-1",
      reply_id: "reply-1"
    }, this.currentSessionId));
    this.emit({
      ...serverEvent(VoiceEvent.TTSResponse, undefined, this.currentSessionId),
      audio: Buffer.from([1, 2, 3, 4])
    });
    this.emit(serverEvent(VoiceEvent.TTSEnded, undefined, this.currentSessionId));
  }

  async finishSession() {
    this.calls.push("finish");
  }

  async reconnect() {
    this.calls.push("reconnect");
    this.reconnectCount += 1;
    if (this.failReconnect) {
      throw new VoiceProviderError("connection_failed", "reconnect unavailable");
    }
    this.currentSessionId = "voice-session-restored";
    if (this.autoCompleteTtsAfterReconnect) this.autoCompleteTts = true;
    return { sessionId: this.currentSessionId };
  }

  onTranscript(_callback: (text: string) => void) {
    return () => undefined;
  }

  onAudio(callback: (audio: Buffer) => void) {
    this.audioCallbacks.add(callback);
    return () => this.audioCallbacks.delete(callback);
  }

  onEvent(callback: (event: ParsedVoiceServerEvent) => void) {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  async close() {
    this.calls.push("close");
    if (this.stallClose) return new Promise<void>(() => undefined);
  }

  emit(event: ParsedVoiceServerEvent) {
    for (const callback of this.eventCallbacks) callback(event);
  }
}

function answer(question = "今天有什么重要事情？"): QuestionAnswer {
  return {
    id: "answer-1",
    uploadId: "all_memory",
    question,
    answer: "你今天主要确认了排练安排。[E1]",
    citedSegmentIds: ["segment-1"],
    citations: [{
      id: "E1",
      title: "排练安排",
      startSeconds: 10,
      endSeconds: 20,
      excerpt: "周二晚上七点排练",
      sourceSegmentIds: ["segment-1"]
    }],
    createdAt: "2026-07-20T00:00:00.000Z"
  };
}

function traceRecorder() {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    mark: vi.fn(() => true),
    setProviderSessionId: vi.fn(),
    recordFailure: vi.fn(),
    recordQaBreakdown: vi.fn(),
    complete: vi.fn(),
    snapshot: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined)
  } as unknown as VoiceSessionTraceRecorder;
}

function bridgeWith(answerer: VoiceQaAnswerer, trace?: VoiceSessionTraceRecorder) {
  const provider = new BridgeVoiceProvider();
  const bridge = new VoiceQaBridge({
    provider,
    answerer,
    userId: "user-1",
    scope: "all",
    ttsTimeoutMs: 1_000,
    ...(trace ? { trace } : {})
  });
  return { bridge, provider };
}

function committedSentence(
  overrides: Partial<Extract<QaAnswerStreamEvent, { type: "sentence_completed" }>> = {}
): Extract<QaAnswerStreamEvent, { type: "sentence_completed" }> {
  return {
    type: "sentence_completed",
    sequence: 1,
    sentence: "你今天主要确认了排练安排。",
    text: "你今天主要确认了排练安排。",
    citationIds: ["E1"],
    supportIds: ["segment-1"],
    citedSegmentIds: ["segment-1"],
    groundingValidated: true,
    safeForSpeech: false,
    safeForPersistence: false,
    requiresResponseOptimization: true,
    validated: true,
    status: "committed",
    reason: "grounded",
    ...overrides
  };
}

function streamingBridgeWith(input: {
  provider?: BridgeVoiceProvider;
  sentence?: Extract<QaAnswerStreamEvent, { type: "sentence_completed" }>;
  emitSentence?: boolean;
  finalAnswer?: QuestionAnswer;
  finalGate?: Promise<void>;
  trace?: VoiceSessionTraceRecorder;
  onStreamingEvent: (event: VoiceQaStreamingOutputEvent) => void | Promise<void>;
}) {
  const provider = input.provider ?? new BridgeVoiceProvider();
  const finalAnswer = input.finalAnswer ?? answer();
  const answerer: VoiceQaAnswerer = {
    answer: async (request) => {
      request.onQaMilestone?.("retrieval_complete");
      request.onQaMilestone?.("llm_first_token");
      if (input.emitSentence !== false) {
        await request.onQaStreamEvent?.(input.sentence ?? committedSentence());
      }
      await input.finalGate;
      return finalAnswer;
    }
  };
  const bridge = new VoiceQaBridge({
    provider,
    answerer,
    userId: "user-1",
    scope: "all",
    ttsTimeoutMs: 1_000,
    onStreamingEvent: input.onStreamingEvent,
    ...(input.trace ? { trace: input.trace } : {})
  });
  return { bridge, provider, finalAnswer };
}

describe("VoiceQaBridge", () => {
  it("forwards one trace-linked shadow review context for duplicate final ASR", async () => {
    const qa = vi.fn(async (_request: VoiceQARequest) => answer());
    const trace = traceRecorder();
    const provider = new BridgeVoiceProvider();
    const bridge = new VoiceQaBridge({
      provider,
      answerer: { answer: qa },
      userId: "user-1",
      scope: "all",
      applicationSessionId: "conversation-session",
      trace,
      ttsTimeoutMs: 1_000
    });
    await bridge.start();

    await expect(bridge.acceptTranscript({
      transcript: "What did I decide?",
      finality: "final",
      sessionId: "voice-session"
    })).resolves.toMatchObject({ transcript: "What did I decide?" });
    await expect(bridge.acceptTranscript({
      transcript: "What did I decide?",
      finality: "final",
      sessionId: "voice-session"
    })).resolves.toBeNull();

    expect(qa).toHaveBeenCalledOnce();
    const request = qa.mock.calls[0][0];
    expect(request).toMatchObject({
      sessionId: "conversation-session",
      traceId: trace.sessionId,
      shadowReviewContext: {
        voiceSessionId: "conversation-session",
        traceId: trace.sessionId
      }
    });
    await bridge.close();
  });

  it("keeps collector Voice metrics isolated across two turns in one session", async () => {
    recordVoiceQaShadowReviewVoiceOutcome.mockClear();
    let turn = 0;
    const qa = vi.fn(async (request: VoiceQARequest) => {
      turn += 1;
      if (request.shadowReviewContext) {
        request.shadowReviewContext.caseId = `case-${turn}`;
      }
      request.onQaMilestone?.("retrieval_complete");
      if (turn === 1) request.onQaMilestone?.("llm_first_token");
      return answer(request.transcript);
    });
    const trace = traceRecorder();
    const { bridge, provider } = bridgeWith({ answer: qa }, trace);
    await bridge.start();

    provider.failTts = true;
    await bridge.submitTextQuery("first question");
    provider.failTts = false;
    await bridge.submitTextQuery("second question");

    await vi.waitFor(() => {
      expect(recordVoiceQaShadowReviewVoiceOutcome).toHaveBeenCalledTimes(2);
    });
    const first = recordVoiceQaShadowReviewVoiceOutcome.mock.calls[0]![0];
    const second = recordVoiceQaShadowReviewVoiceOutcome.mock.calls[1]![0];
    expect(first).toMatchObject({
      caseId: "case-1",
      traceId: trace.sessionId,
      metrics: {
        llmFirstTokenLatencyMs: expect.any(Number),
        ttsFailure: "tts_failed"
      }
    });
    expect(second).toMatchObject({
      caseId: "case-2",
      traceId: trace.sessionId,
      metrics: {
        asrLatencyMs: null,
        llmFirstTokenLatencyMs: null,
        ttsFailure: null
      }
    });
    expect(second.metrics).not.toBe(first.metrics);
    await bridge.close();
  });

  it("completes Voice playback when shadow outcome persistence throws", async () => {
    recordVoiceQaShadowReviewVoiceOutcome.mockReset();
    recordVoiceQaShadowReviewVoiceOutcome.mockRejectedValueOnce(
      new Error("collector unavailable")
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(
      () => undefined
    );
    const qa = vi.fn(async (request: VoiceQARequest) => {
      if (request.shadowReviewContext) {
        request.shadowReviewContext.caseId = "case-collector-throws";
      }
      return answer(request.transcript);
    });
    const trace = traceRecorder();
    const { bridge, provider } = bridgeWith({ answer: qa }, trace);
    await bridge.start();

    const response = await bridge.submitTextQuery(
      "collector failure question"
    );
    expect(response.answer?.answer).toBe(
      "你今天主要确认了排练安排。[E1]"
    );
    expect(response.errors ?? []).toEqual([]);
    expect(provider.sentTexts).toEqual([
      "你今天主要确认了排练安排。"
    ]);
    await vi.waitFor(() => {
      expect(recordVoiceQaShadowReviewVoiceOutcome)
        .toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "voice_outcome_persistence_failed"
        )
      );
    });
    await bridge.close();
  });

  it("ignores partial ASR and invokes QA once for the final transcript", async () => {
    const qa = vi.fn(async () => answer());
    const trace = traceRecorder();
    const { bridge, provider } = bridgeWith({ answer: qa }, trace);
    await bridge.start();

    await expect(bridge.acceptTranscript({
      transcript: "今天有什么",
      finality: "partial",
      sessionId: "voice-session"
    })).resolves.toBeNull();
    expect(qa).not.toHaveBeenCalled();

    const response = await bridge.acceptTranscript({
      transcript: "今天有什么重要事情？",
      finality: "final",
      sessionId: "voice-session"
    });

    expect(qa).toHaveBeenCalledTimes(1);
    expect(qa).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "voice-session",
      transcript: "今天有什么重要事情？",
      userId: "user-1",
      mode: "VOICE"
    }));
    expect(provider.sentTexts).toEqual(["你今天主要确认了排练安排。"]);
    expect(response).toMatchObject({
      text: "你今天主要确认了排练安排。",
      audio: Buffer.from([1, 2, 3, 4]),
      answer: expect.objectContaining({
        citedSegmentIds: ["segment-1"],
        citations: [expect.objectContaining({ id: "E1" })]
      })
    });
    expect(bridge.snapshot().state).toBe("idle");
    expect(trace.mark).toHaveBeenCalledWith("asr_first_partial");
    expect(trace.mark).toHaveBeenCalledWith("asr_final_received");
    expect(trace.mark).toHaveBeenCalledWith("qa_started");
    expect(trace.mark).toHaveBeenCalledWith("qa_completed");
    expect(trace.mark).toHaveBeenCalledWith("tts_started");
    await bridge.close();
  });

  it("records a partial hypothesis without inventing final, QA, or TTS events", async () => {
    const qa = vi.fn(async () => answer());
    const trace = traceRecorder();
    const { bridge, provider } = bridgeWith({ answer: qa }, trace);
    await bridge.start();

    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "今天有什么", is_interim: true }]
    }));
    await Promise.resolve();

    expect(trace.mark).toHaveBeenCalledWith("asr_first_partial");
    expect(trace.mark).not.toHaveBeenCalledWith("asr_final_received");
    expect(trace.mark).not.toHaveBeenCalledWith("qa_started");
    expect(trace.mark).not.toHaveBeenCalledWith("tts_started");
    expect(qa).not.toHaveBeenCalled();
    expect(provider.sentTexts).toEqual([]);
    await bridge.close();
  });

  it("records content-free QA stage diagnostics without changing the answer", async () => {
    const qa = vi.fn(async (request: VoiceQARequest) => {
      request.onQaDiagnostics?.({
        answerMode: "agent",
        memoryRetrievalMs: null,
        relationshipContextBuildingMs: 1,
        rerankingMs: 3,
        promptConstructionMs: 2,
        llmGenerationMs: 20,
        responseValidationMs: 1,
        totalMs: 27,
        promptCharacters: 1_000,
        responseCharacters: 80,
        evidenceCount: 4,
        providerCallCount: 1,
        fallbackReason: "none"
      });
      return answer();
    });
    const trace = traceRecorder();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { bridge } = bridgeWith({ answerMode: "agent", answer: qa }, trace);

    try {
      await bridge.start();
      const response = await bridge.acceptTranscript({
        transcript: "What happened today?",
        finality: "final",
        sessionId: "voice-session"
      });

      expect(response?.answer?.id).toBe("answer-1");
      expect(trace.recordQaBreakdown).toHaveBeenCalledWith(expect.objectContaining({
        answerMode: "agent",
        llmGenerationMs: 20,
        evidenceCount: 4
      }));
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/^VOICE_QA_BENCHMARK: \{/u));
      const benchmarkLine = info.mock.calls
        .map(([message]) => message)
        .find((message) => typeof message === "string" && message.startsWith("VOICE_QA_BENCHMARK: "));
      expect(JSON.parse(benchmarkLine!.slice("VOICE_QA_BENCHMARK: ".length))).toMatchObject({
        session_id: trace.sessionId,
        answer_mode: "agent"
      });
    } finally {
      await bridge.close();
      info.mockRestore();
    }
  });

  it("filters ChatResponse and processes only final ASR provider events", async () => {
    const qa = vi.fn(async () => answer());
    const { bridge, provider } = bridgeWith({ answer: qa });
    const responses: VoiceQAResponse[] = [];
    bridge.onResponse((response) => responses.push(response));
    await bridge.start();

    provider.emit(serverEvent(VoiceEvent.ChatResponse, { content: "provider answer" }));
    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "今天有什么", is_interim: true }]
    }));
    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "今天有什么重要事情？", is_interim: false }]
    }));
    expect(qa).not.toHaveBeenCalled();
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await bridge.waitForIdle();

    expect(qa).toHaveBeenCalledTimes(1);
    expect(responses).toHaveLength(1);
    expect(responses[0].transcript).toBe("今天有什么重要事情？");
    await bridge.close();
  });

  it("uses ASREnded as the boundary for an ASR result with unknown finality", async () => {
    const qa = vi.fn(async () => answer("我今天发生了什么？"));
    const { bridge, provider } = bridgeWith({ answer: qa });
    await bridge.start();

    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "我今天发生了什么？" }]
    }));
    expect(qa).not.toHaveBeenCalled();
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await bridge.waitForIdle();

    expect(qa).toHaveBeenCalledTimes(1);
    expect(qa).toHaveBeenCalledWith(expect.objectContaining({
      transcript: "我今天发生了什么？"
    }));
    await bridge.close();
  });

  it("does not invoke QA twice for a duplicated final event", async () => {
    const qa = vi.fn(async () => answer());
    const { bridge, provider } = bridgeWith({ answer: qa });
    await bridge.start();
    const event = serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "今天有什么重要事情？", is_interim: false }]
    });

    provider.emit(event);
    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "今天到底有什么重要事情？", is_interim: false }]
    }));
    expect(qa).not.toHaveBeenCalled();
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await bridge.waitForIdle();

    expect(qa).toHaveBeenCalledTimes(1);
    await bridge.close();
  });

  it("uses the latest final hypothesis when one ASR response contains revisions", async () => {
    const qa = vi.fn(async () => answer("最终问题"));
    const { bridge, provider } = bridgeWith({ answer: qa });
    await bridge.start();

    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [
        { text: "较早的问题", is_interim: false },
        { text: "最终问题", is_interim: false }
      ]
    }));
    expect(qa).not.toHaveBeenCalled();
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await bridge.waitForIdle();

    expect(qa).toHaveBeenCalledTimes(1);
    expect(qa).toHaveBeenCalledWith(expect.objectContaining({ transcript: "最终问题" }));
    await bridge.close();
  });

  it("preserves a buffered final hypothesis over a later partial before ASREnded", async () => {
    const qa = vi.fn(async () => answer("最终问题"));
    const { bridge, provider } = bridgeWith({ answer: qa });
    await bridge.start();

    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "最终问题", is_interim: false }]
    }));
    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "较晚但未完成的问题", is_interim: true }]
    }));
    expect(qa).not.toHaveBeenCalled();
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await bridge.waitForIdle();

    expect(qa).toHaveBeenCalledTimes(1);
    expect(qa).toHaveBeenCalledWith(expect.objectContaining({ transcript: "最终问题" }));
    await bridge.close();
  });

  it("accepts TTS audio and completion only from the active session", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.autoCompleteTts = false;
    await bridge.start();

    let settled = false;
    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？").finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse, undefined, "other-session"),
      audio: Buffer.from([9, 9])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded, undefined, "other-session"));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse, undefined, ""),
      sessionId: undefined,
      audio: Buffer.from([8, 8])
    });
    provider.emit({
      ...serverEvent(VoiceEvent.TTSEnded, undefined, ""),
      sessionId: undefined
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      question_id: "question-1",
      reply_id: "reply-1"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([1, 2, 3, 4])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded));
    await expect(responsePromise).resolves.toMatchObject({
      audio: Buffer.from([1, 2, 3, 4])
    });
    await bridge.close();
  });

  it("collects only ChatTTSText audio when autonomous default TTS is interleaved", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.autoCompleteTts = false;
    await bridge.start();

    let settled = false;
    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？").finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));

    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "default",
      question_id: "provider-question",
      reply_id: "provider-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([9, 9])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded));
    await Promise.resolve();
    expect(settled).toBe(false);

    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      question_id: "qa-question",
      reply_id: "qa-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([1, 2])
    });

    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "default",
      question_id: "provider-question-2",
      reply_id: "provider-reply-2"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([8, 8])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded));
    await Promise.resolve();
    expect(settled).toBe(false);

    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      question_id: "qa-question",
      reply_id: "qa-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([3, 4])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded));

    await expect(responsePromise).resolves.toMatchObject({
      audio: Buffer.from([1, 2, 3, 4])
    });
    await bridge.close();
  });

  it("interrupts a pre-existing autonomous TTS stream before canonical TTS", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.autoCompleteTts = false;
    await bridge.start();
    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "default",
      question_id: "provider-question",
      reply_id: "provider-reply"
    }));

    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？");
    await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));
    expect(provider.calls.indexOf("interrupt-response")).toBeGreaterThan(-1);
    expect(provider.calls.indexOf("interrupt-response")).toBeLessThan(
      provider.calls.indexOf("send-text")
    );

    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      question_id: "qa-question",
      reply_id: "qa-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([1, 2, 3, 4])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded, {
      tts_type: "chat_tts_text",
      question_id: "qa-question",
      reply_id: "qa-reply"
    }));

    await expect(responsePromise).resolves.toMatchObject({
      audio: Buffer.from([1, 2, 3, 4])
    });
    await bridge.close();
  });

  it("keeps buffered ChatTTSText active after an interleaved default stream without another chat start", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.autoCompleteTts = false;
    await bridge.start();

    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？");
    await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));
    const chat = {
      tts_type: "chat_tts_text",
      question_id: "qa-question",
      reply_id: "qa-reply"
    };
    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, chat));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([1, 2])
    });
    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "default",
      question_id: "provider-question",
      reply_id: "provider-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([9, 9])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([3, 4])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded, chat));

    await expect(responsePromise).resolves.toMatchObject({
      audio: Buffer.from([1, 2, 3, 4])
    });
    await bridge.close();
  });

  it("does not finish the active ChatTTSText turn for a different reply id", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.autoCompleteTts = false;
    await bridge.start();

    let settled = false;
    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？").finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));
    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      question_id: "qa-question",
      reply_id: "qa-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([1, 2])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded, {
      tts_type: "chat_tts_text",
      question_id: "qa-question",
      reply_id: "other-reply"
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      question_id: "qa-question",
      reply_id: "qa-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([3, 4])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded));

    await expect(responsePromise).resolves.toMatchObject({
      audio: Buffer.from([1, 2, 3, 4])
    });
    await bridge.close();
  });

  it("handles a TTS provider error while sendText is still pending", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.stallSendText = true;
    await bridge.start();

    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？");
    await Promise.resolve();
    provider.emit({
      ...serverEvent(VoiceEvent.DialogCommonError),
      errorCode: 500001
    });

    await expect(responsePromise).resolves.toMatchObject({
      text: "你今天主要确认了排练安排。",
      errors: ["tts_failed"]
    });
    await bridge.close();
  });

  it("cancels an active TTS turn before waiting for graceful close", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.autoCompleteTts = false;
    await bridge.start();

    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？");
    await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));

    await expect(bridge.close()).resolves.toBeUndefined();
    await expect(responsePromise).resolves.toMatchObject({ errors: ["tts_failed"] });
    expect(bridge.snapshot().state).toBe("closed");
  });

  it("speaks a bounded fallback when QA fails without closing the session", async () => {
    const { bridge, provider } = bridgeWith({
      answer: async () => { throw new Error("qa unavailable"); }
    });
    await bridge.start();

    const response = await bridge.acceptTranscript({
      transcript: "今天有什么重要事情？",
      finality: "final"
    });

    expect(response).toMatchObject({
      text: "暂时无法获取相关记录",
      errors: ["qa_failed"]
    });
    expect(provider.sentTexts).toEqual(["暂时无法获取相关记录"]);
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });

  it("returns QA text when TTS fails and keeps the session reusable", async () => {
    const trace = traceRecorder();
    const { bridge, provider } = bridgeWith({ answer: async () => answer() }, trace);
    provider.failTts = true;
    await bridge.start();

    const response = await bridge.acceptTranscript({
      transcript: "今天有什么重要事情？",
      finality: "final"
    });

    expect(response).toMatchObject({
      text: "你今天主要确认了排练安排。",
      errors: ["tts_failed"]
    });
    expect(response?.audio).toBeUndefined();
    expect(trace.mark).toHaveBeenCalledWith("tts_started");
    expect(trace.recordFailure).toHaveBeenCalledWith("tts", "tts_failed");
    expect(trace.mark).not.toHaveBeenCalledWith("audio_play_started");
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });

  it("turns an ASR provider failure into a retry prompt without invoking QA", async () => {
    const qa = vi.fn(async () => answer());
    const { bridge, provider } = bridgeWith({ answer: qa });
    const responses: VoiceQAResponse[] = [];
    bridge.onResponse((response) => responses.push(response));
    await bridge.start();
    await bridge.sendAudio(Buffer.from([1, 2]));

    provider.emit({
      ...serverEvent(VoiceEvent.DialogCommonError),
      errorCode: 450001
    });
    await bridge.waitForIdle();

    expect(qa).not.toHaveBeenCalled();
    expect(provider.sentTexts).toEqual(["无法识别，请再说一次"]);
    expect(responses[0]).toMatchObject({
      text: "无法识别，请再说一次",
      errors: ["asr_failed"]
    });
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });

  it("recovers to idle when sending an audio chunk fails", async () => {
    const qa = vi.fn(async () => answer());
    const { bridge, provider } = bridgeWith({ answer: qa });
    provider.failAudio = true;
    const responses: VoiceQAResponse[] = [];
    bridge.onResponse((response) => responses.push(response));
    await bridge.start();

    await bridge.sendAudio(Buffer.from([1, 2]));

    expect(qa).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({ errors: ["asr_failed"] });
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });

  it("forwards audio only while listening and closes gracefully", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    await bridge.start();

    await bridge.sendAudio(Buffer.from([1, 2]));
    expect(bridge.snapshot().state).toBe("listening");
    expect(provider.startConfig).toMatchObject({ inputMode: "server_vad" });
    await bridge.close();

    expect(bridge.snapshot().state).toBe("closed");
    expect(provider.calls).toEqual(["connect", "start", "send-audio", "finish", "close"]);
  });

  it("finishes one push-to-talk audio turn exactly once", async () => {
    const provider = new BridgeVoiceProvider();
    const bridge = new VoiceQaBridge({
      provider,
      answerer: { answer: async () => answer() },
      sessionConfig: { inputMode: "push_to_talk" }
    });
    await bridge.start();
    await bridge.sendAudio(Buffer.from([1, 2]));

    await bridge.finishAudioInput();
    await bridge.finishAudioInput();

    expect(provider.calls.filter((call) => call === "finish-audio-input")).toHaveLength(1);
    await bridge.close();
  });

  it("replays buffered audio before ending ASR after a connection loss", async () => {
    const provider = new BridgeVoiceProvider();
    provider.failFinishAudioWithConnectionOnce = true;
    const bridge = new VoiceQaBridge({
      provider,
      answerer: { answer: async () => answer() },
      sessionConfig: { inputMode: "push_to_talk" }
    });
    await bridge.start();
    await bridge.sendAudio(Buffer.from([1, 2, 3]));

    await bridge.finishAudioInput();

    expect(provider.reconnectCount).toBe(1);
    expect(provider.calls.filter((call) => call === "send-audio")).toHaveLength(2);
    expect(provider.calls.filter((call) => call === "finish-audio-input")).toHaveLength(2);
    expect(provider.calls.slice(-2)).toEqual(["send-audio", "finish-audio-input"]);
    await bridge.close();
  });

  it("makes concurrent close calls single-flight", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    await bridge.start();

    await Promise.all([bridge.close(), bridge.close()]);

    expect(provider.calls.filter((call) => call === "finish")).toHaveLength(1);
    expect(provider.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(bridge.snapshot().state).toBe("closed");
  });

  it("aborts without draining a long-running QA answer", async () => {
    let resolveAnswer!: (value: QuestionAnswer) => void;
    const pendingAnswer = new Promise<QuestionAnswer>((resolve) => {
      resolveAnswer = resolve;
    });
    const qa = vi.fn(() => pendingAnswer);
    const { bridge, provider } = bridgeWith({ answer: qa });
    await bridge.start();

    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？");
    void responsePromise.catch(() => undefined);
    await vi.waitFor(() => expect(qa).toHaveBeenCalledTimes(1));

    await expect(bridge.abort()).resolves.toBeUndefined();
    expect(provider.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(provider.calls).not.toContain("finish");
    expect(bridge.snapshot().state).toBe("closed");

    resolveAnswer(answer());
    await bridge.waitForIdle();
    await expect(responsePromise).rejects.toMatchObject({ reason: "invalid_state" });
  });

  it("makes concurrent abort calls single-flight", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    await bridge.start();

    await Promise.all([bridge.abort(), bridge.abort()]);

    expect(provider.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(provider.calls).not.toContain("finish");
    expect(bridge.snapshot().state).toBe("closed");
  });

  it("returns from abort without waiting for a stalled provider close", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.stallClose = true;
    await bridge.start();

    await expect(Promise.race([
      bridge.abort().then(() => "aborted" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50))
    ])).resolves.toBe("aborted");

    expect(provider.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(bridge.snapshot().state).toBe("closed");
  });

  it("does not enqueue an ASR fallback when an in-flight audio send fails during close", async () => {
    const qa = vi.fn(async () => answer());
    const { bridge, provider } = bridgeWith({ answer: qa });
    provider.stallSendAudio = true;
    await bridge.start();

    const send = bridge.sendAudio(Buffer.from([1, 2]));
    await Promise.resolve();
    const close = bridge.close();
    await close;
    provider.rejectPendingAudio?.(new Error("closed"));
    await send;

    expect(qa).not.toHaveBeenCalled();
    expect(provider.sentTexts).toEqual([]);
    expect(bridge.snapshot().state).toBe("closed");
  });

  it("turns an ASR timeout into a repeat prompt without invoking QA", async () => {
    const qa = vi.fn(async () => answer());
    const trace = traceRecorder();
    const { bridge, provider } = bridgeWith({ answer: qa }, trace);
    await bridge.start();
    await bridge.sendAudio(Buffer.from([1, 2]));

    const response = await bridge.handleAsrTimeout();

    expect(qa).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      errors: ["asr_failed"],
      errorCodes: ["VOICE_ASR_TIMEOUT"]
    });
    expect(response?.text).toContain("再说一遍");
    expect(response?.audio).toBeUndefined();
    expect(provider.sentTexts).toEqual([]);
    expect(provider.calls).not.toContain("finish");
    expect(trace.mark).not.toHaveBeenCalledWith("tts_started");
    expect(bridge.snapshot().state).toBe("idle");
    expect(bridge.snapshot().history.map((entry) => entry.to)).toEqual([
      "idle",
      "listening",
      "thinking",
      "speaking",
      "idle"
    ]);
    await bridge.close();
  });

  it("ignores a late ASREnded after the text-only ASR timeout fallback", async () => {
    const qa = vi.fn(async () => answer());
    const { bridge, provider } = bridgeWith({ answer: qa });
    const responses: VoiceQAResponse[] = [];
    bridge.onResponse((response) => responses.push(response));
    await bridge.start();
    await bridge.sendAudio(Buffer.from([1, 2]));

    await bridge.handleAsrTimeout();
    await Promise.resolve();
    expect(responses).toHaveLength(1);

    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await Promise.resolve();
    await Promise.resolve();

    expect(qa).not.toHaveBeenCalled();
    expect(provider.sentTexts).toEqual([]);
    expect(responses).toHaveLength(1);
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });

  it("bounds QA waiting and keeps the logical session usable", async () => {
    vi.useFakeTimers();
    try {
      const qa = vi.fn(() => new Promise<QuestionAnswer | null>(() => undefined));
      const provider = new BridgeVoiceProvider();
      const trace = traceRecorder();
      const bridge = new VoiceQaBridge({
        provider,
        answerer: { answer: qa },
        trace,
        qaTimeoutMs: 1_000,
        ttsTimeoutMs: 1_000,
        initialConversation: [{ role: "user", content: "刚才在说经理沟通" }]
      });
      await bridge.start();

      const responsePromise = bridge.submitTextQuery("明天还要再谈一次");
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await responsePromise;

      expect(response).toMatchObject({
        errors: ["qa_failed"],
        errorCodes: ["VOICE_QA_TIMEOUT"]
      });
      expect(response.text).toContain("刚才的话题");
      expect(trace.recordQaBreakdown).toHaveBeenCalledWith(expect.objectContaining({
        answerMode: "agent",
        memoryRetrievalMs: null,
        llmGenerationMs: null,
        fallbackReason: "diagnostics_unavailable"
      }));
      expect(trace.mark).not.toHaveBeenCalledWith("qa_completed");
      expect(bridge.snapshot().state).toBe("idle");
      await bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("injects persisted context and publishes the completed turn", async () => {
    const qa = vi.fn(async () => answer("明天还要再谈一次"));
    const lifecycle: string[] = [];
    const onTurnCompleted = vi.fn();
    const provider = new BridgeVoiceProvider();
    const bridge = new VoiceQaBridge({
      provider,
      answerer: { answer: qa },
      applicationSessionId: "conversation-session",
      initialConversation: [
        { role: "user", content: "我今天和经理争论了。" },
        { role: "assistant", content: "听起来这件事让你有些压力。" }
      ],
      onLifecycleStateChange: (state) => {
        lifecycle.push(state);
      },
      onTurnCompleted
    });
    await bridge.start();

    await bridge.submitTextQuery("明天还要再谈一次");

    expect(qa).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "conversation-session",
      conversation: [
        { role: "user", content: "我今天和经理争论了。" },
        { role: "assistant", content: "听起来这件事让你有些压力。" }
      ]
    }));
    expect(onTurnCompleted).toHaveBeenCalledWith(expect.objectContaining({
      transcript: "明天还要再谈一次",
      response: expect.stringContaining("排练安排")
    }));
    expect(lifecycle).toEqual(["PROCESSING", "RESPONDING", "IDLE"]);
    await bridge.close();
  });

  it("reconnects and replays buffered audio once after a connection loss", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.failAudioWithConnectionOnce = true;
    await bridge.start();

    await bridge.sendAudio(Buffer.from([1, 2, 3]));

    expect(provider.reconnectCount).toBe(1);
    expect(provider.calls.filter((call) => call === "send-audio")).toHaveLength(2);
    expect(bridge.snapshot().state).toBe("listening");
    await bridge.close();
  });

  it("reports connection loss when audio recovery cannot reconnect", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    const responses: VoiceQAResponse[] = [];
    bridge.onResponse((response) => responses.push(response));
    provider.failAudioWithConnectionOnce = true;
    provider.failReconnect = true;
    await bridge.start();

    await bridge.sendAudio(Buffer.from([1, 2, 3]));
    await bridge.waitForIdle();

    expect(responses.at(-1)).toMatchObject({
      errors: ["connection_lost"],
      errorCodes: ["VOICE_CONNECTION_LOST"]
    });
    expect(responses.at(-1)?.audio).toBeUndefined();
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });

  it("reports both connection and TTS failure when TTS recovery cannot reconnect", async () => {
    const { bridge, provider } = bridgeWith({ answer: async () => answer() });
    provider.failTtsWithConnectionOnce = true;
    provider.failReconnect = true;
    await bridge.start();

    const response = await bridge.submitTextQuery("连接中断时的问题");

    expect(response).toMatchObject({
      errors: ["connection_lost", "tts_failed"],
      errorCodes: ["VOICE_CONNECTION_LOST", "VOICE_TTS_FAILED"]
    });
    expect(response.audio).toBeUndefined();
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });

  it("accepts ASR final events and subsequent text queries after an audio reconnect", async () => {
    const qa = vi.fn(async () => answer());
    const { bridge, provider } = bridgeWith({ answer: qa });
    const responses: VoiceQAResponse[] = [];
    bridge.onResponse((response) => responses.push(response));
    provider.failAudioWithConnectionOnce = true;
    await bridge.start();

    await bridge.sendAudio(Buffer.from([1, 2, 3]));
    provider.emit(serverEvent(VoiceEvent.ASRResponse, {
      results: [{ text: "重连后的最终问题", is_interim: false }]
    }, "voice-session-restored"));
    provider.emit(serverEvent(
      VoiceEvent.ASREnded,
      undefined,
      "voice-session-restored"
    ));
    await bridge.waitForIdle();

    expect(qa).toHaveBeenCalledTimes(1);
    expect(responses.at(-1)).toMatchObject({ transcript: "重连后的最终问题" });

    await expect(bridge.submitTextQuery("后续文字问题")).resolves.toMatchObject({
      transcript: "后续文字问题"
    });
    expect(qa).toHaveBeenCalledTimes(2);
    await bridge.close();
  });

  it("keeps subsequent text queries usable after a TTS reconnect", async () => {
    const qa = vi.fn(async () => answer());
    const { bridge, provider } = bridgeWith({ answer: qa });
    provider.failTtsWithConnectionOnce = true;
    await bridge.start();

    await expect(bridge.submitTextQuery("第一次问题")).resolves.toMatchObject({
      transcript: "第一次问题",
      audio: Buffer.from([1, 2, 3, 4])
    });
    expect(provider.reconnectCount).toBe(1);

    await expect(bridge.submitTextQuery("重连后的问题")).resolves.toMatchObject({
      transcript: "重连后的问题",
      audio: Buffer.from([1, 2, 3, 4])
    });
    expect(qa).toHaveBeenCalledTimes(2);
    await bridge.close();
  });

  it("streams only preflighted speech-safe sentences through bounded TTS", async () => {
    const trace = traceRecorder();
    const events: VoiceQaStreamingOutputEvent[] = [];
    let releaseFinal!: () => void;
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const { bridge, provider } = streamingBridgeWith({
      trace,
      finalGate,
      onStreamingEvent: (event) => {
        events.push(event);
      }
    });
    await bridge.start();

    let qaFinalReturned = false;
    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？")
      .then((response) => {
        qaFinalReturned = true;
        return response;
      });

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "audio_chunk")).toBe(true);
    });
    expect(qaFinalReturned).toBe(false);
    releaseFinal();
    const response = await responsePromise;

    expect(provider.sentTexts).toEqual(["你今天主要确认了排练安排。"]);
    expect(events.map((event) => event.type)).toEqual([
      "speech_sentence",
      "sentence_started",
      "audio_chunk",
      "sentence_completed",
      "stream_completed"
    ]);
    expect(events.find((event) => event.type === "speech_sentence")).toMatchObject({
      spokenSentence: "你今天主要确认了排练安排。",
      supportIds: ["segment-1"],
      safeForSpeech: true
    });
    expect(response).toMatchObject({
      text: "你今天主要确认了排练安排。",
      streamedAudio: true
    });
    expect(response.audio).toBeUndefined();
    expect(trace.mark).toHaveBeenCalledWith("voice_question_received");
    expect(trace.mark).toHaveBeenCalledWith("retrieval_complete");
    expect(trace.mark).toHaveBeenCalledWith("llm_first_token");
    expect(trace.mark).toHaveBeenCalledWith("first_sentence_committed");
    expect(trace.mark).toHaveBeenCalledWith("first_safe_sentence");
    expect(trace.mark).toHaveBeenCalledWith("tts_stream_started");
    expect(trace.mark).toHaveBeenCalledWith("tts_request_start");
    expect(trace.mark).toHaveBeenCalledWith("first_audio_chunk_received");
    expect(trace.mark).toHaveBeenCalledWith("tts_stream_complete");
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });

  it("streams the final canonical projection when QA emits no early safe sentence", async () => {
    const events: VoiceQaStreamingOutputEvent[] = [];
    const { bridge, provider } = streamingBridgeWith({
      emitSentence: false,
      onStreamingEvent: (event) => {
        events.push(event);
      }
    });
    await bridge.start();

    const response = await bridge.submitTextQuery("今天有什么重要事情？");

    expect(provider.sentTexts).toEqual(["你今天主要确认了排练安排。"]);
    expect(events.map((event) => event.type)).toEqual([
      "speech_sentence",
      "sentence_started",
      "audio_chunk",
      "sentence_completed",
      "stream_completed"
    ]);
    expect(events[0]).toMatchObject({
      source: "final_projection",
      spokenSentence: "你今天主要确认了排练安排。"
    });
    expect(response).toMatchObject({
      text: "你今天主要确认了排练安排。",
      streamedAudio: true
    });
    expect(response.audio).toBeUndefined();
    await bridge.close();
  });

  it("streams only the final canonical projection when early sentence support fails preflight", async () => {
    const events: VoiceQaStreamingOutputEvent[] = [];
    const { bridge, provider } = streamingBridgeWith({
      sentence: committedSentence({ supportIds: ["segment-outside-answer"] }),
      onStreamingEvent: (event) => {
        events.push(event);
      }
    });
    await bridge.start();

    const response = await bridge.submitTextQuery("今天有什么重要事情？");

    expect(provider.sentTexts).toEqual(["你今天主要确认了排练安排。"]);
    expect(events[0]).toMatchObject({
      type: "speech_sentence",
      source: "final_projection",
      supportIds: ["segment-1"]
    });
    expect(response.audio).toBeUndefined();
    expect(response.streamedAudio).toBe(true);
    await bridge.close();
  });

  it("falls back to full-text TTS when streaming fails before its first audio chunk", async () => {
    const events: VoiceQaStreamingOutputEvent[] = [];
    const provider = new BridgeVoiceProvider();
    provider.failTtsWithConnectionOnce = true;
    const { bridge } = streamingBridgeWith({
      provider,
      onStreamingEvent: (event) => {
        events.push(event);
      }
    });
    await bridge.start();

    const response = await bridge.submitTextQuery("今天有什么重要事情？");

    expect(provider.sentTexts).toEqual([
      "你今天主要确认了排练安排。",
      "你今天主要确认了排练安排。"
    ]);
    expect(events).toContainEqual({
      type: "stream_error",
      code: "tts_failed",
      afterAudio: false
    });
    expect(events.some((event) => event.type === "audio_chunk")).toBe(false);
    expect(response).toMatchObject({
      audio: Buffer.from([1, 2, 3, 4])
    });
    expect(response.streamedAudio).toBeUndefined();
    expect(response.errors).toBeUndefined();
    await bridge.close();
  });

  it("streams an evidence-free safe uncertainty projection without sending citation metadata", async () => {
    const events: VoiceQaStreamingOutputEvent[] = [];
    const uncertainty: QuestionAnswer = {
      ...answer(),
      answer: "没有找到足够证据确认这个信息。",
      citedSegmentIds: [],
      citations: []
    };
    const { bridge, provider } = streamingBridgeWith({
      emitSentence: false,
      finalAnswer: uncertainty,
      onStreamingEvent: (event) => {
        events.push(event);
      }
    });
    await bridge.start();

    const response = await bridge.submitTextQuery("有没有相关证据？");

    expect(provider.sentTexts).toEqual(["没有找到足够证据确认这个信息。"]);
    expect(events[0]).toMatchObject({
      type: "speech_sentence",
      source: "final_projection",
      supportIds: []
    });
    expect(response).toMatchObject({
      text: "没有找到足够证据确认这个信息。",
      streamedAudio: true
    });
    await bridge.close();
  });

  it("reconnects once and uses bounded buffered audio recovery after a no-audio timeout", async () => {
    vi.useFakeTimers();
    try {
      const events: VoiceQaStreamingOutputEvent[] = [];
      const provider = new BridgeVoiceProvider();
      provider.autoCompleteTts = false;
      provider.autoCompleteTtsAfterReconnect = true;
      const trace = traceRecorder();
      const { bridge } = streamingBridgeWith({
        provider,
        trace,
        onStreamingEvent: (event) => {
          events.push(event);
        }
      });
      await bridge.start();

      const responsePromise = bridge.submitTextQuery("今天有什么重要事情？");
      await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await responsePromise;

      expect(provider.sentTexts).toEqual([
        "你今天主要确认了排练安排。",
        "你今天主要确认了排练安排。"
      ]);
      expect(provider.reconnectCount).toBe(1);
      expect(events).toContainEqual({
        type: "stream_error",
        code: "tts_failed",
        afterAudio: false
      });
      expect(response).toMatchObject({
        text: "你今天主要确认了排练安排。",
        audio: Buffer.from([1, 2, 3, 4])
      });
      expect(response.errors).toBeUndefined();
      expect(response.streamedAudio).toBeUndefined();
      expect(trace.mark).toHaveBeenCalledWith("fallback_audio_complete");
      expect(bridge.snapshot().state).toBe("idle");
      await bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay the full response after partial streaming audio was delivered", async () => {
    const events: VoiceQaStreamingOutputEvent[] = [];
    const provider = new BridgeVoiceProvider();
    provider.autoCompleteTts = false;
    const trace = traceRecorder();
    const { bridge } = streamingBridgeWith({
      provider,
      trace,
      onStreamingEvent: (event) => {
        events.push(event);
      }
    });
    await bridge.start();

    const responsePromise = bridge.submitTextQuery("今天有什么重要事情？");
    await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));
    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      question_id: "stream-question",
      reply_id: "stream-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([7, 8, 9])
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "audio_chunk")).toBe(true);
    });
    provider.emit({
      ...serverEvent(VoiceEvent.DialogCommonError),
      errorCode: 500
    });

    const response = await responsePromise;

    expect(provider.sentTexts).toEqual(["你今天主要确认了排练安排。"]);
    expect(events).toContainEqual({
      type: "stream_error",
      code: "tts_failed",
      afterAudio: true
    });
    expect(response).toMatchObject({
      streamedAudio: true,
      errors: ["tts_failed"],
      errorCodes: ["VOICE_TTS_FAILED"]
    });
    expect(response.audio).toBeUndefined();
    expect(trace.mark).toHaveBeenCalledWith("tts_partial_audio_failure");
    expect(bridge.snapshot().state).toBe("idle");
    await bridge.close();
  });
});
