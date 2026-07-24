// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { VoiceEvent, type ParsedVoiceServerEvent } from "./events";
import {
  streamTextToSpeech,
  type StreamingSpeechSentence,
  type StreamingTtsEvent
} from "./streaming-tts";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceSessionInfo
} from "./types";

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

function speechSentence(
  sequence: number,
  spokenSentence = `safe sentence ${sequence}`
): StreamingSpeechSentence {
  return {
    sequence,
    spokenSentence,
    supportIds: [`segment_${sequence}`],
    safeForSpeech: true
  };
}

class StreamingVoiceProvider implements VoiceProvider {
  readonly sentTexts: string[] = [];
  readonly eventCallbacks = new Set<(event: ParsedVoiceServerEvent) => void>();
  onSendText?: (text: string, call: number) => void | Promise<void>;

  async connect() {}

  async startSession(_config?: VoiceSessionConfig): Promise<VoiceSessionInfo> {
    return { sessionId: "voice-session" };
  }

  async sendAudio(_chunk: Buffer) {}

  async finishAudioInput() {}

  async sendText(text: string) {
    this.sentTexts.push(text);
    await this.onSendText?.(text, this.sentTexts.length);
  }

  async finishSession() {}

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

  async close() {}

  emit(event: ParsedVoiceServerEvent) {
    for (const callback of this.eventCallbacks) callback(event);
  }
}

function emitChatTts(
  provider: StreamingVoiceProvider,
  audio: readonly Buffer[],
  ids: { questionId: string; replyId: string }
) {
  const metadata = {
    tts_type: "chat_tts_text",
    question_id: ids.questionId,
    reply_id: ids.replyId
  };
  provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, metadata));
  for (const chunk of audio) {
    provider.emit({
      ...serverEvent(VoiceEvent.TTSResponse),
      audio: chunk
    });
  }
  provider.emit(serverEvent(VoiceEvent.TTSEnded, metadata));
}

async function collect(stream: AsyncIterable<StreamingTtsEvent>) {
  const events: StreamingTtsEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("streamTextToSpeech", () => {
  it("serializes sentences, preserves global audio order, and applies input backpressure", async () => {
    const provider = new StreamingVoiceProvider();
    const sourcePulls: number[] = [];
    provider.onSendText = (_text, call) => {
      expect(sourcePulls).toEqual(call === 1 ? [1] : [1, 2]);
      emitChatTts(
        provider,
        call === 1
          ? [Buffer.from([1]), Buffer.from([2])]
          : [Buffer.from([3])],
        { questionId: `question-${call}`, replyId: `reply-${call}` }
      );
    };
    async function* sentences() {
      sourcePulls.push(1);
      yield speechSentence(10, "first safe sentence");
      sourcePulls.push(2);
      yield speechSentence(20, "second safe sentence");
    }

    const events = await collect(streamTextToSpeech(sentences(), {
      provider,
      sessionId: "voice-session"
    }));

    expect(provider.sentTexts).toEqual(["first safe sentence", "second safe sentence"]);
    expect(events.filter((event) => event.type === "audio_chunk")).toEqual([
      expect.objectContaining({
        sequence: 1,
        sentenceSequence: 10,
        sentenceChunkSequence: 1,
        audio: Buffer.from([1])
      }),
      expect.objectContaining({
        sequence: 2,
        sentenceSequence: 10,
        sentenceChunkSequence: 2,
        audio: Buffer.from([2])
      }),
      expect.objectContaining({
        sequence: 3,
        sentenceSequence: 20,
        sentenceChunkSequence: 1,
        audio: Buffer.from([3])
      })
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "sentence_started",
      "audio_chunk",
      "audio_chunk",
      "sentence_completed",
      "sentence_started",
      "audio_chunk",
      "sentence_completed",
      "stream_completed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "stream_completed",
      sentenceCount: 2,
      audioChunkCount: 3
    });
    expect(provider.eventCallbacks.size).toBe(0);
  });

  it("filters autonomous default TTS and keeps only the active chat_tts_text stream", async () => {
    const provider = new StreamingVoiceProvider();
    provider.onSendText = () => {
      provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, {
        tts_type: "default",
        question_id: "default-question",
        reply_id: "default-reply"
      }));
      provider.emit({
        ...serverEvent(VoiceEvent.TTSResponse),
        audio: Buffer.from([9])
      });
      provider.emit(serverEvent(VoiceEvent.TTSEnded));
      emitChatTts(provider, [Buffer.from([1, 2])], {
        questionId: "qa-question",
        replyId: "qa-reply"
      });
    };

    const events = await collect(streamTextToSpeech([speechSentence(1)], {
      provider,
      sessionId: "voice-session"
    }));

    expect(events.filter((event) => event.type === "audio_chunk")).toEqual([
      expect.objectContaining({ audio: Buffer.from([1, 2]) })
    ]);
    expect(provider.eventCallbacks.size).toBe(0);
  });

  it("fails closed for an unsafe sentence before sending it to the provider", async () => {
    const provider = new StreamingVoiceProvider();

    await expect(collect(streamTextToSpeech([{
      ...speechSentence(1),
      safeForSpeech: false
    } as unknown as StreamingSpeechSentence], {
      provider,
      sessionId: "voice-session"
    }))).rejects.toMatchObject({ code: "unsafe_sentence" });

    expect(provider.sentTexts).toEqual([]);
    expect(provider.eventCallbacks.size).toBe(0);
  });

  it("rejects an empty sentence stream without invoking the provider", async () => {
    const provider = new StreamingVoiceProvider();

    await expect(collect(streamTextToSpeech([], {
      provider,
      sessionId: "voice-session"
    }))).rejects.toMatchObject({ code: "empty_stream" });

    expect(provider.sentTexts).toEqual([]);
    expect(provider.eventCallbacks.size).toBe(0);
  });

  it("rejects TTSEnded when the provider returned no audio", async () => {
    const provider = new StreamingVoiceProvider();
    provider.onSendText = () => emitChatTts(provider, [], {
      questionId: "question-empty",
      replyId: "reply-empty"
    });

    await expect(collect(streamTextToSpeech([speechSentence(1)], {
      provider,
      sessionId: "voice-session"
    }))).rejects.toMatchObject({ code: "empty_audio" });

    expect(provider.eventCallbacks.size).toBe(0);
  });

  it("propagates a safe provider failure and removes its listener", async () => {
    const provider = new StreamingVoiceProvider();
    provider.onSendText = () => {
      provider.emit({
        ...serverEvent(VoiceEvent.DialogCommonError),
        errorCode: 500001
      });
    };

    await expect(collect(streamTextToSpeech([speechSentence(1)], {
      provider,
      sessionId: "voice-session"
    }))).rejects.toMatchObject({ code: "provider_failure" });

    expect(provider.eventCallbacks.size).toBe(0);
  });

  it("normalizes a sendText rejection and removes its listener", async () => {
    const provider = new StreamingVoiceProvider();
    provider.onSendText = () => {
      throw new Error("PRIVATE PROVIDER BODY");
    };

    let failure: unknown;
    try {
      await collect(streamTextToSpeech([speechSentence(1)], {
        provider,
        sessionId: "voice-session"
      }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "provider_failure" });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("PRIVATE PROVIDER BODY");
    expect(provider.eventCallbacks.size).toBe(0);
  });

  it("supports AbortSignal cancellation and removes its listener", async () => {
    const provider = new StreamingVoiceProvider();
    const controller = new AbortController();
    provider.onSendText = () => {
      controller.abort();
    };

    await expect(collect(streamTextToSpeech([speechSentence(1)], {
      provider,
      sessionId: "voice-session",
      signal: controller.signal
    }))).rejects.toMatchObject({ code: "aborted" });

    expect(provider.eventCallbacks.size).toBe(0);
  });

  it("times out a stalled sentence and removes its listener", async () => {
    vi.useFakeTimers();
    try {
      const provider = new StreamingVoiceProvider();
      const result = collect(streamTextToSpeech([speechSentence(1)], {
        provider,
        sessionId: "voice-session",
        sentenceTimeoutMs: 1_000
      }));
      const rejection = expect(result).rejects.toMatchObject({ code: "timeout" });

      await vi.waitFor(() => expect(provider.sentTexts).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(provider.eventCallbacks.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds buffered provider audio and fails instead of growing without limit", async () => {
    const provider = new StreamingVoiceProvider();
    provider.onSendText = () => {
      const metadata = {
        tts_type: "chat_tts_text",
        question_id: "question-buffer",
        reply_id: "reply-buffer"
      };
      provider.emit(serverEvent(VoiceEvent.TTSSentenceStart, metadata));
      provider.emit({
        ...serverEvent(VoiceEvent.TTSResponse),
        audio: Buffer.from([1])
      });
      provider.emit({
        ...serverEvent(VoiceEvent.TTSResponse),
        audio: Buffer.from([2])
      });
    };

    await expect(collect(streamTextToSpeech([speechSentence(1)], {
      provider,
      sessionId: "voice-session",
      maxBufferedAudioChunks: 1
    }))).rejects.toMatchObject({ code: "buffer_overflow" });

    expect(provider.eventCallbacks.size).toBe(0);
  });
});
