// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { QuestionAnswer } from "@/lib/domain/types";
import type { QaAnswerStreamEvent } from "@/lib/server/retrieval/qa-streaming";
import { VoiceEvent, type ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceSessionInfo
} from "@/lib/server/voice/types";
import { VoiceProviderError } from "@/lib/server/voice/types";

import {
  RealtimeVoiceQaController,
  type RealtimeVoiceQaEvent
} from "./realtime-controller";
import type { VoiceQaAnswerer, VoiceQARequest } from "./types";

function serverEvent(
  eventId: VoiceEvent,
  payload?: unknown,
  sessionId = "provider-session"
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

class RealtimeTestProvider implements VoiceProvider {
  readonly sentAudio: Buffer[] = [];
  readonly sentAudioSessions: Array<{ sessionId: string; audio: Buffer }> = [];
  readonly sentTexts: string[] = [];
  readonly truncated: Array<{ itemId: string; audioEndMs: number }> = [];
  readonly calls: string[] = [];
  startConfig?: VoiceSessionConfig;
  sessionId = "provider-session";
  failNextAudio = false;
  reconnectFailures = 0;
  failTextAt?: number;
  private readonly eventCallbacks =
    new Set<(event: ParsedVoiceServerEvent) => void>();

  async connect() {
    this.calls.push("connect");
  }

  async startSession(config?: VoiceSessionConfig): Promise<VoiceSessionInfo> {
    this.calls.push("start");
    this.startConfig = config;
    return { sessionId: this.sessionId, dialogId: "dialog-1" };
  }

  async sendAudio(chunk: Buffer) {
    if (this.failNextAudio) {
      this.failNextAudio = false;
      throw new VoiceProviderError(
        "connection_closed",
        "simulated realtime disconnect"
      );
    }
    const audio = Buffer.from(chunk);
    this.sentAudio.push(audio);
    this.sentAudioSessions.push({ sessionId: this.sessionId, audio });
  }

  async reconnect() {
    this.calls.push("reconnect");
    if (this.reconnectFailures > 0) {
      this.reconnectFailures -= 1;
      throw new VoiceProviderError("connection_failed", "simulated reconnect failure");
    }
    this.sessionId = "provider-session-reconnected";
    return { sessionId: this.sessionId, dialogId: "dialog-2" };
  }

  async finishAudioInput() {
    this.calls.push("finish-audio");
  }

  async interruptResponse() {
    this.calls.push("interrupt");
  }

  async cancelSessionTurn() {
    this.calls.push("cancel-turn");
  }

  async sendText(text: string) {
    this.sentTexts.push(text);
    const index = this.sentTexts.length;
    if (this.failTextAt === index) {
      throw new VoiceProviderError("provider_error", "simulated TTS failure");
    }
    const metadata = {
      tts_type: "chat_tts_text",
      question_id: `question-${index}`,
      reply_id: `reply-${index}`
    };
    this.emit(serverEvent(VoiceEvent.TTSSentenceStart, metadata));
    this.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([index, index + 1])
    });
    this.emit(serverEvent(VoiceEvent.TTSEnded, metadata));
  }

  async truncateConversation(itemId: string, audioEndMs: number) {
    this.truncated.push({ itemId, audioEndMs });
  }

  async finishSession() {
    this.calls.push("finish-session");
  }

  onTranscript(_callback: (text: string) => void) {
    return () => undefined;
  }

  onAudio(_callback: (audio: Buffer) => void) {
    return () => undefined;
  }

  onEvent(callback: (event: ParsedVoiceServerEvent) => void) {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  async close() {
    this.calls.push("close");
  }

  emit(event: ParsedVoiceServerEvent) {
    for (const callback of this.eventCallbacks) callback(event);
  }
}

function canonicalAnswer(
  question = "What happened today?"
): QuestionAnswer {
  return {
    id: "answer-1",
    uploadId: "all_memory",
    question,
    answer: "Today has one confirmed event. [E1]",
    citedSegmentIds: ["segment-1"],
    citations: [{
      id: "E1",
      title: "Confirmed event",
      startSeconds: 10,
      endSeconds: 20,
      excerpt: "The event was confirmed.",
      sourceSegmentIds: ["segment-1"]
    }],
    createdAt: "2026-07-31T00:00:00.000Z"
  };
}

function groundedSentence(
  sequence: number,
  sentence: string
): Extract<QaAnswerStreamEvent, { type: "sentence_completed" }> {
  return {
    type: "sentence_completed",
    sequence,
    sentence,
    text: sentence,
    citationIds: ["E1"],
    supportIds: ["segment-1"],
    citedSegmentIds: ["segment-1"],
    groundingValidated: true,
    safeForSpeech: false,
    safeForPersistence: false,
    requiresResponseOptimization: true,
    validated: true,
    status: "committed",
    reason: "grounded"
  };
}

function emitAsr(
  provider: RealtimeTestProvider,
  transcript: string,
  isInterim: boolean
) {
  provider.emit(serverEvent(VoiceEvent.ASRResponse, {
    results: [{ text: transcript, is_interim: isInterim }]
  }));
}

async function waitForEvent(
  events: RealtimeVoiceQaEvent[],
  predicate: (event: RealtimeVoiceQaEvent) => boolean,
  timeoutMs = 2_000
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for realtime Voice QA event");
}

describe("RealtimeVoiceQaController", () => {
  it("keeps one server-VAD session, uses canonical grounded speech, and preserves the answer", async () => {
    const provider = new RealtimeTestProvider();
    const requests: VoiceQARequest[] = [];
    const answerer: VoiceQaAnswerer = {
      answerMode: "agent",
      answer: vi.fn(async (request) => {
        requests.push(request);
        request.onQaMilestone?.("retrieval_complete");
        request.onQaMilestone?.("llm_started");
        request.onQaMilestone?.("llm_first_token");
        await request.onQaStreamEvent?.({
          type: "sentence_completed",
          sequence: 1,
          sentence: "Today has one confirmed event. [E1]",
          text: "Today has one confirmed event. [E1]",
          citationIds: ["E1"],
          supportIds: ["segment-1"],
          citedSegmentIds: ["segment-1"],
          groundingValidated: true,
          safeForSpeech: false,
          safeForPersistence: false,
          requiresResponseOptimization: true,
          validated: true,
          status: "committed",
          reason: "grounded"
        } satisfies Extract<QaAnswerStreamEvent, { type: "sentence_completed" }>);
        return canonicalAnswer(request.transcript);
      })
    };
    const controller = new RealtimeVoiceQaController({ provider, answerer });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));

    await controller.start();
    await controller.sendAudio(Buffer.from([1, 2]));
    await controller.sendAudio(Buffer.from([3, 4]));

    provider.emit(serverEvent(VoiceEvent.ChatResponse, {
      content: "Provider autonomous answer must stay shadowed."
    }));
    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "default",
      question_id: "default-question",
      reply_id: "default-reply"
    }));
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: Buffer.from([99])
    });
    provider.emit(serverEvent(VoiceEvent.TTSEnded, {
      tts_type: "default",
      question_id: "default-question",
      reply_id: "default-reply"
    }));

    provider.emit(serverEvent(VoiceEvent.ASRInfo, { speaking: true }));
    provider.emit(serverEvent(VoiceEvent.ASRInfo, { speaking: true }));
    emitAsr(provider, "What happened", true);
    provider.emit(serverEvent(VoiceEvent.ASRInfo, { speaking: false }));
    emitAsr(provider, "What happened today?", false);
    provider.emit(serverEvent(VoiceEvent.ASREnded));

    await waitForEvent(
      events,
      (event) => event.type === "turn_complete" &&
        event.status === "completed"
    );

    expect(provider.startConfig).toMatchObject({
      inputMode: "server_vad",
      vad: {
        endSmoothWindowMs: 700,
        enableCustomVad: true
      },
      dialog: {
        enableConversationTruncate: true
      }
    });
    expect(provider.sentAudio).toEqual([
      Buffer.from([1, 2]),
      Buffer.from([3, 4])
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      transcript: "What happened today?",
      mode: "VOICE"
    });
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(provider.sentTexts).toEqual(["Today has one confirmed event."]);
    expect(events.filter((event) => event.type === "audio_chunk")).toEqual([
      expect.objectContaining({
        turnSequence: 1,
        providerItemId: "reply-1",
        audio: Buffer.from([1, 2])
      })
    ]);
    expect(events.filter((event) => event.type === "answer")).toEqual([
      expect.objectContaining({
        text: "Today has one confirmed event.",
        answer: canonicalAnswer("What happened today?")
      })
    ]);
    expect(events.filter((event) =>
      event.type === "turn_complete" && event.turnSequence === 1
    )).toHaveLength(1);
    const latencyMarkers = events.filter((event) => event.type === "latency_marker").map(
      (event) => event.type === "latency_marker" ? event.marker : ""
    );
    expect(latencyMarkers).toEqual(expect.arrayContaining([
      "speech_start",
      "first_partial_asr",
      "speech_end",
      "asr_final",
      "retrieval_start",
      "retrieval_complete",
      "qa_start",
      "llm_first_token",
      "qa_complete",
      "answer_ready",
      "tts_start",
      "first_audio",
      "complete"
    ]));
    expect(latencyMarkers.indexOf("retrieval_complete")).toBeLessThan(
      latencyMarkers.indexOf("qa_start")
    );
    expect(latencyMarkers.indexOf("qa_start")).toBeLessThan(
      latencyMarkers.indexOf("qa_complete")
    );
    const terminalIndex = events.findIndex((event) =>
      event.type === "turn_complete" && event.turnSequence === 1
    );
    expect(events.slice(terminalIndex + 1).some((event) =>
      "turnSequence" in event && event.turnSequence === 1
    )).toBe(false);
    expect(await controller.markBrowserPlaybackStarted(1)).toBe(true);
    expect(controller.latencySnapshot(1)?.timestamps.browser_playback_start)
      .toEqual(expect.any(Number));
    expect(events.slice(terminalIndex + 1).some((event) =>
      "turnSequence" in event && event.turnSequence === 1
    )).toBe(false);
    provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
      tts_type: "default",
      question_id: "late-default-question",
      reply_id: "late-default-reply"
    }));
    expect(await controller.truncatePlayback(1, "default-reply", 240)).toBe(false);
    expect(await controller.truncatePlayback(1, "reply-1", 240)).toBe(true);
    expect(provider.truncated).toEqual([
      { itemId: "reply-1", audioEndMs: 240 }
    ]);

    await controller.close();
  });

  it("restores a disconnected Provider without replaying an old-epoch tail chunk", async () => {
    const provider = new RealtimeTestProvider();
    const controller = new RealtimeVoiceQaController({
      provider,
      answerer: {
        answer: vi.fn(async () => canonicalAnswer())
      }
    });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));
    await controller.start();

    await controller.sendAudio(Buffer.from([1, 2]));
    provider.failNextAudio = true;
    await expect(controller.sendAudio(Buffer.from([7, 8]))).rejects.toMatchObject({
      reason: "connection_closed",
      message: "voice_realtime_gateway_input_reset_required"
    });

    expect(provider.calls.filter((call) => call === "reconnect")).toHaveLength(1);
    expect(provider.sentAudio).toEqual([Buffer.from([1, 2])]);
    expect(provider.sentAudioSessions.filter(
      ({ sessionId }) => sessionId === "provider-session-reconnected"
    )).toEqual([]);
    expect(events).toContainEqual({
      type: "session_reconnected",
      providerSessionId: "provider-session-reconnected"
    });

    await controller.close();
  });

  it("aborts stale QA on barge-in and emits exactly one terminal event per turn", async () => {
    const provider = new RealtimeTestProvider();
    let resolveFirst!: (answer: QuestionAnswer) => void;
    const firstAnswer = new Promise<QuestionAnswer>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    const answerer: VoiceQaAnswerer = {
      answer: vi.fn(async (request) => {
        call += 1;
        if (call === 1) return firstAnswer;
        return canonicalAnswer(request.transcript);
      })
    };
    const controller = new RealtimeVoiceQaController({ provider, answerer });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));
    await controller.start();

    emitAsr(provider, "First question", false);
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await waitForEvent(
      events,
      (event) => event.type === "asr_final" && event.turnSequence === 1
    );

    expect(await controller.cancelSessionTurn("barge_in", 2)).toBe(false);
    expect(events.some((event) =>
      event.type === "turn_complete" && event.turnSequence === 1
    )).toBe(false);

    provider.emit(serverEvent(VoiceEvent.ASRInfo, { speaking: true }));
    await waitForEvent(
      events,
      (event) => event.type === "turn_complete" &&
        event.turnSequence === 1 &&
        event.status === "interrupted"
    );

    emitAsr(provider, "Second question", false);
    emitAsr(provider, "stale partial revision", true);
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await waitForEvent(
      events,
      (event) => event.type === "turn_complete" &&
        event.turnSequence === 2 &&
        event.status === "completed"
    );
    resolveFirst(canonicalAnswer("First question"));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const terminal = events.filter((event) => event.type === "turn_complete");
    expect(terminal).toEqual([
      expect.objectContaining({
        turnSequence: 1,
        status: "interrupted"
      }),
      expect.objectContaining({
        turnSequence: 2,
        status: "completed"
      })
    ]);
    expect(events.filter((event) =>
      event.type === "answer" && event.turnSequence === 1
    )).toHaveLength(0);
    expect(events.filter((event) =>
      event.type === "audio_chunk" && event.turnSequence === 1
    )).toHaveLength(0);
    expect(provider.sentTexts).toEqual(["Today has one confirmed event."]);
    expect(provider.calls.filter((call) => call === "cancel-turn")).toHaveLength(1);
    expect(provider.calls.filter((call) => call === "interrupt")).toHaveLength(0);

    await controller.close();
  });

  it("buffers a later grounded sentence until canonical ordering is known", async () => {
    const provider = new RealtimeTestProvider();
    const answerer: VoiceQaAnswerer = {
      answer: vi.fn(async (request) => {
        await request.onQaStreamEvent?.(groundedSentence(2, "Second confirmed fact. [E1]"));
        await request.onQaStreamEvent?.(groundedSentence(3, "Third confirmed fact. [E1]"));
        expect(provider.sentTexts).toEqual([]);
        await request.onQaStreamEvent?.(groundedSentence(1, "First confirmed fact. [E1]"));
        return canonicalAnswer(request.transcript);
      })
    };
    const controller = new RealtimeVoiceQaController({ provider, answerer });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));
    await controller.start();

    emitAsr(provider, "Lifecycle question", false);
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await waitForEvent(events, (event) =>
      event.type === "turn_complete" && event.status === "completed"
    );

    expect(provider.sentTexts).toEqual([
      "First confirmed fact.",
      "Second confirmed fact.",
      "Third confirmed fact."
    ]);
    expect(events.filter((event) => event.type === "speech_sentence").map((event) =>
      event.type === "speech_sentence" ? event.sentenceSequence : 0
    )).toEqual([1, 2, 3]);
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
    await controller.close();
  });

  it("keeps partial audio failed and emits exactly one terminal after later TTS failure", async () => {
    const provider = new RealtimeTestProvider();
    provider.failTextAt = 2;
    const answerer: VoiceQaAnswerer = {
      answer: vi.fn(async (request) => {
        await request.onQaStreamEvent?.(groundedSentence(1, "First confirmed fact. [E1]"));
        await request.onQaStreamEvent?.(groundedSentence(2, "Second confirmed fact. [E1]"));
        return canonicalAnswer(request.transcript);
      })
    };
    const controller = new RealtimeVoiceQaController({ provider, answerer });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));
    await controller.start();

    emitAsr(provider, "TTS failure question", false);
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await waitForEvent(events, (event) =>
      event.type === "turn_complete" && event.status === "failed"
    );

    expect(events.some((event) => event.type === "audio_chunk")).toBe(true);
    expect(events.some((event) => event.type === "answer")).toBe(false);
    expect(events.filter((event) => event.type === "turn_complete")).toEqual([
      expect.objectContaining({ status: "failed" })
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
    await controller.close();
  });

  it("propagates one AbortSignal and makes repeated interrupts idempotent", async () => {
    const provider = new RealtimeTestProvider();
    vi.stubEnv("VOICE_DEBUG", "true");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let observedSignal: AbortSignal | undefined;
    const answerer: VoiceQaAnswerer = {
      answer: vi.fn(async (request) => {
        observedSignal = request.signal;
        request.onQaMilestone?.("llm_started");
        return await new Promise<QuestionAnswer>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true
          });
        });
      })
    };
    const controller = new RealtimeVoiceQaController({ provider, answerer });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));
    await controller.start();
    expect(await controller.cancelSessionTurn("barge_in")).toBe(false);

    emitAsr(provider, "Cancel question", false);
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await waitForEvent(events, (event) => event.type === "asr_final");
    expect(await controller.cancelSessionTurn("barge_in", 1)).toBe(true);
    expect(await controller.cancelSessionTurn("barge_in", 1)).toBe(false);
    expect(observedSignal?.aborted).toBe(true);
    expect(provider.calls.filter((call) => call === "cancel-turn")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_complete")).toEqual([
      expect.objectContaining({ turnSequence: 1, status: "interrupted" })
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      '"provider_generation_completed":false,"aborted_generation_count":1'
    ));
    await controller.close();
  });

  it("cancels a speaking turn without allowing late answer or audio events", async () => {
    const provider = new RealtimeTestProvider();
    const answerer: VoiceQaAnswerer = {
      answer: vi.fn(async (request) => {
        request.onQaMilestone?.("llm_started");
        await request.onQaStreamEvent?.(
          groundedSentence(1, "Speaking cancellation fixture. [E1]")
        );
        return await new Promise<QuestionAnswer>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true
          });
        });
      })
    };
    const controller = new RealtimeVoiceQaController({ provider, answerer });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));
    await controller.start();
    emitAsr(provider, "Speaking cancel fixture", false);
    provider.emit(serverEvent(VoiceEvent.ASREnded));
    await waitForEvent(events, (event) =>
      event.type === "turn_state" && event.state === "speaking"
    );

    expect(await controller.cancelSessionTurn("barge_in", 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(provider.calls.filter((call) => call === "cancel-turn")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_complete")).toEqual([
      expect.objectContaining({ turnSequence: 1, status: "interrupted" })
    ]);
    expect(events.filter((event) => event.type === "answer")).toHaveLength(0);
    expect(controller.snapshot).toMatchObject({
      state: "listening",
      activeTurnSequence: undefined,
      abortedGenerationCount: 1
    });
    await controller.close();
  });

  it("keeps one Provider session across five canonical turns with one terminal and trace each", async () => {
    const provider = new RealtimeTestProvider();
    const requests: VoiceQARequest[] = [];
    const answerer: VoiceQaAnswerer = {
      answerMode: "agent",
      answer: vi.fn(async (request) => {
        requests.push(request);
        request.onQaMilestone?.("retrieval_complete");
        request.onQaMilestone?.("llm_started");
        request.onQaMilestone?.("llm_first_token");
        await request.onQaStreamEvent?.(
          groundedSentence(1, `Confirmed fixture ${requests.length}. [E1]`)
        );
        return canonicalAnswer(request.transcript);
      })
    };
    const controller = new RealtimeVoiceQaController({ provider, answerer });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));
    await controller.start();

    for (let turnSequence = 1; turnSequence <= 5; turnSequence += 1) {
      provider.emit(serverEvent(VoiceEvent.ASRInfo, { speaking: true }));
      emitAsr(provider, `Fixture question ${turnSequence}`, false);
      provider.emit(serverEvent(VoiceEvent.ASRInfo, { speaking: false }));
      provider.emit(serverEvent(VoiceEvent.ASREnded));
      await waitForEvent(events, (event) =>
        event.type === "turn_complete" && event.turnSequence === turnSequence
      );
      expect(controller.snapshot).toMatchObject({
        state: "listening",
        activeTurnSequence: undefined,
        turnSequence
      });
    }

    expect(provider.calls.filter((call) => call === "start")).toHaveLength(1);
    expect(provider.calls.filter((call) => call === "reconnect")).toHaveLength(0);
    expect(requests).toHaveLength(5);
    expect(new Set(requests.map((request) => request.signal)).size).toBe(5);
    expect(requests.every((request) => request.signal?.aborted === false)).toBe(true);
    expect(provider.sentTexts).toHaveLength(5);
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(5);
    expect(events.filter((event) => event.type === "turn_trace")).toHaveLength(5);
    expect(events.filter((event) => event.type === "turn_trace").every((event) =>
      event.type === "turn_trace" &&
      event.terminalStatus === "completed" &&
      event.abortedGenerationCount === 0 &&
      event.wastedTokenCount === null &&
      event.latency.timestamps.sentence_commit !== undefined
    )).toBe(true);
    expect(events.filter((event) => event.type === "turn_state").map((event) =>
      event.type === "turn_state" ? event.state : ""
    )).toEqual([
      "thinking", "speaking", "listening",
      "thinking", "speaking", "listening",
      "thinking", "speaking", "listening",
      "thinking", "speaking", "listening",
      "thinking", "speaking", "listening"
    ]);
    await controller.close();
  });

  it("bounds Provider reconnect retries and restores only a fresh listening session", async () => {
    const provider = new RealtimeTestProvider();
    provider.failNextAudio = true;
    provider.reconnectFailures = 2;
    const controller = new RealtimeVoiceQaController({
      provider,
      answerer: { answer: vi.fn(async (request) => canonicalAnswer(request.transcript)) },
      providerReconnectAttempts: 3,
      providerReconnectDelayMs: 0
    });
    await controller.start();

    await expect(controller.sendAudio(Buffer.from([1, 2]))).rejects.toMatchObject({
      reason: "connection_closed",
      message: "voice_realtime_gateway_input_reset_required"
    });
    expect(provider.calls.filter((call) => call === "reconnect")).toHaveLength(3);
    expect(controller.snapshot).toMatchObject({
      state: "listening",
      reconnectCount: 1,
      activeTurnSequence: undefined
    });
    expect(provider.sentAudio).toHaveLength(0);
    await controller.close();
  });

  it("closes safely after Provider reconnect attempts are exhausted", async () => {
    const provider = new RealtimeTestProvider();
    provider.failNextAudio = true;
    provider.reconnectFailures = 3;
    const controller = new RealtimeVoiceQaController({
      provider,
      answerer: { answer: vi.fn(async (request) => canonicalAnswer(request.transcript)) },
      providerReconnectAttempts: 3,
      providerReconnectDelayMs: 0
    });
    const events: RealtimeVoiceQaEvent[] = [];
    controller.onEvent((event) => events.push(event));
    await controller.start();

    await expect(controller.sendAudio(Buffer.from([1, 2]))).rejects.toMatchObject({
      reason: "connection_failed"
    });
    expect(provider.calls.filter((call) => call === "reconnect")).toHaveLength(3);
    expect(controller.snapshot.state).toBe("closed");
    expect(events.filter((event) => event.type === "session_closed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  it("cancels the Provider generation when a turn deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const provider = new RealtimeTestProvider();
      let signal: AbortSignal | undefined;
      const answerer: VoiceQaAnswerer = {
        answer: vi.fn(async (request) => {
          signal = request.signal;
          request.onQaMilestone?.("llm_started");
          return await new Promise<QuestionAnswer>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
              once: true
            });
          });
        })
      };
      const controller = new RealtimeVoiceQaController({
        provider,
        answerer,
        turnTimeoutMs: 1_000
      });
      const events: RealtimeVoiceQaEvent[] = [];
      controller.onEvent((event) => events.push(event));
      await controller.start();
      emitAsr(provider, "Timeout fixture", false);
      provider.emit(serverEvent(VoiceEvent.ASREnded));
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(signal?.aborted).toBe(true);
      expect(provider.calls.filter((call) => call === "cancel-turn")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_complete")).toEqual([
        expect.objectContaining({ status: "failed", errorCode: "timeout" })
      ]);
      expect(events.filter((event) => event.type === "turn_trace")).toEqual([
        expect.objectContaining({
          terminalStatus: "failed",
          terminalReason: "timeout",
          abortedGenerationCount: 1,
          wastedTokenCount: null
        })
      ]);
      expect(controller.snapshot).toMatchObject({
        state: "listening",
        activeTurnSequence: undefined,
        abortedGenerationCount: 1
      });
      await controller.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
