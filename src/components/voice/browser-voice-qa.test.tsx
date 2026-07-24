import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceQaContext } from "@/lib/domain/voice-qa-context";
import type { VoiceAudioChunk, VoiceAudioQueueOptions } from "@/lib/client/voice-audio-queue";
import type { VoiceBrowserStreamEvent } from "@/lib/voice-browser-stream";
import { BrowserVoiceQa } from "./browser-voice-qa";
import type { VoiceRecorderPort } from "./voice-recorder";

function recorder(overrides: Partial<VoiceRecorderPort> = {}): VoiceRecorderPort {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(new Blob(["recorded"], { type: "audio/webm" })),
    dispose: vi.fn(),
    ...overrides
  };
}

function apiResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      sessionId: "voice-session-1",
      transcript: "今天有什么重要事情？",
      text: "今天主要确认了一项安排。",
      ...overrides
    })
  } as Response;
}

function ndjsonResponse(events: VoiceBrowserStreamEvent[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    }
  }), {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" }
  });
}

function streamingAudioQueue() {
  let playbackStarted = false;
  const queue = {
    prepare: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn(async (_chunk: VoiceAudioChunk, _options?: { signal?: AbortSignal }) => {
      if (!playbackStarted) {
        playbackStarted = true;
        options?.onPlaybackStarted?.();
      }
      return "accepted" as const;
    }),
    finish: vi.fn().mockResolvedValue({ status: "completed" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
    pauseForReconnect: vi.fn(),
    resumeAfterReconnect: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn(() => ({ playbackStarted }))
  };
  let options: VoiceAudioQueueOptions | undefined;
  const factory = vi.fn((nextOptions: VoiceAudioQueueOptions) => {
    options = nextOptions;
    return queue;
  });
  return { factory, queue };
}

const retainedContext: VoiceQaContext = {
  contextId: "upload_1",
  segments: [],
  audioInsights: [],
  semanticSegments: [],
  briefItems: [],
  relationshipSignals: []
};

describe("BrowserVoiceQa", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows permission denial and returns to idle", async () => {
    const permissionError = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const microphone = recorder({ start: vi.fn().mockRejectedValue(permissionError) });
    render(<BrowserVoiceQa recorderFactory={() => microphone} />);

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));

    expect(await screen.findByText("没有麦克风权限，请在浏览器设置中允许访问。"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始语音提问" })).toBeEnabled();
  });

  it("does not start the microphone when the current QA context is unavailable", () => {
    const microphone = recorder();
    const reason = "当前范围还没有可用于语音问答的记忆。";
    render(<BrowserVoiceQa disabledReason={reason} recorderFactory={() => microphone} />);

    const button = screen.getByRole("button", { name: "开始语音提问" });
    expect(button).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
    fireEvent.click(button);
    expect(microphone.start).not.toHaveBeenCalled();
  });

  it("records, submits one multipart request, and displays transcript and answer", async () => {
    const microphone = recorder();
    const fetcher = vi.fn().mockResolvedValue(apiResponse());
    render(<BrowserVoiceQa recorderFactory={() => microphone} fetcher={fetcher} scope="all" />);

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    expect(await screen.findByText("正在听你说话")) .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/voice/qa");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("scope")).toBe("all");
    expect((init.body as FormData).get("answerMode")).toBe("agent");
    expect((init.body as FormData).get("audio")).toBeInstanceOf(Blob);
    expect(await screen.findByText("今天有什么重要事情？")).toBeInTheDocument();
    expect(screen.getByText("今天主要确认了一项安排。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始语音提问" })).toBeEnabled();
  });

  it("renders as a composer button, submits shared conversation, and emits one grounded turn", async () => {
    const microphone = recorder();
    const onTurnCompleted = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(apiResponse({
      answer: {
        id: "answer_voice_1",
        citedSegmentIds: ["segment_1"],
        citations: [{
          id: "E1",
          title: "确认安排",
          startSeconds: 10,
          endSeconds: 16,
          excerpt: "已经确认好了。",
          sourceSegmentIds: ["segment_1"]
        }]
      }
    }));
    render(
      <BrowserVoiceQa
        variant="composer"
        conversation={[
          { role: "user", content: "上一轮问题" },
          { role: "assistant", content: "上一轮回答" }
        ]}
        onTurnCompleted={onTurnCompleted}
        recorderFactory={() => microphone}
        fetcher={fetcher}
        scope="all"
      />
    );

    expect(screen.queryByRole("heading", { name: "语音问答" })).not.toBeInTheDocument();
    expect(document.querySelector(".voice-qa-card")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    fireEvent.click(await screen.findByRole("button", { name: "结束录音" }));

    await waitFor(() => expect(onTurnCompleted).toHaveBeenCalledTimes(1));
    const body = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(JSON.parse(String(body.get("conversation")))).toEqual([
      { role: "user", content: "上一轮问题" },
      { role: "assistant", content: "上一轮回答" }
    ]);
    expect(onTurnCompleted).toHaveBeenCalledWith({
      id: "answer_voice_1",
      question: "今天有什么重要事情？",
      answer: "今天主要确认了一项安排。",
      citedSegmentIds: ["segment_1"],
      citations: [{
        id: "E1",
        title: "确认安排",
        startSeconds: 10,
        endSeconds: 16,
        excerpt: "已经确认好了。",
        sourceSegmentIds: ["segment_1"]
      }]
    });
    expect(screen.queryByText("今天有什么重要事情？")).not.toBeInTheDocument();
    expect(screen.queryByText("今天主要确认了一项安排。")).not.toBeInTheDocument();
  });

  it("labels and submits the isolated Direct comparison mode", async () => {
    const microphone = recorder();
    const fetcher = vi.fn().mockResolvedValue(apiResponse());
    render(
      <BrowserVoiceQa
        answerMode="direct"
        recorderFactory={() => microphone}
        fetcher={fetcher}
        scope="all"
      />
    );

    expect(screen.getByRole("heading", { name: "Direct 实验问答" })).toBeInTheDocument();
    expect(screen.getByText("临时对比 · DIRECT")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    await screen.findByText("正在听你说话");
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    const body = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get("answerMode")).toBe("direct");
  });

  it("submits the retained browser QA context with the current-scope recording", async () => {
    const microphone = recorder();
    const fetcher = vi.fn().mockResolvedValue(apiResponse());
    render(
      <BrowserVoiceQa
        recorderFactory={() => microphone}
        fetcher={fetcher}
        scope="current"
        uploadId="upload_1"
        context={retainedContext}
      />
    );

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(microphone.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    const body = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get("uploadId")).toBe("upload_1");
    expect(JSON.parse(String(body.get("context")))).toEqual(retainedContext);
  });

  it("reuses the logical conversation session across push-to-talk turns", async () => {
    const microphone = recorder();
    const fetcher = vi.fn().mockResolvedValue(apiResponse({
      conversationSessionId: "conversation-session-1"
    }));
    render(<BrowserVoiceQa recorderFactory={() => microphone} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    await screen.findByText("正在听你说话");
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect((fetcher.mock.calls[0]?.[1]?.body as FormData).get("conversationSessionId")).toBeNull();

    await waitFor(() => expect(screen.getByRole("button", { name: "开始语音提问" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    await screen.findByText("正在听你说话");
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    expect((fetcher.mock.calls[1]?.[1]?.body as FormData).get("conversationSessionId"))
      .toBe("conversation-session-1");
  });

  it("keeps the logical session after a transient busy response", async () => {
    const microphone = recorder();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(apiResponse({ conversationSessionId: "conversation-session-1" }))
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "voice_session_unavailable" })
      } as Response)
      .mockResolvedValueOnce(apiResponse({ conversationSessionId: "conversation-session-1" }));
    render(<BrowserVoiceQa recorderFactory={() => microphone} fetcher={fetcher} />);

    const submitTurn = async (expectedCalls: number) => {
      fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
      await screen.findByText("正在听你说话");
      fireEvent.click(screen.getByRole("button", { name: "结束录音" }));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(expectedCalls));
      await waitFor(() => expect(screen.getByRole("button", { name: "开始语音提问" })).toBeEnabled());
    };

    await submitTurn(1);
    await submitTurn(2);
    await submitTurn(3);

    expect((fetcher.mock.calls[1]?.[1]?.body as FormData).get("conversationSessionId"))
      .toBe("conversation-session-1");
    expect((fetcher.mock.calls[2]?.[1]?.body as FormData).get("conversationSessionId"))
      .toBe("conversation-session-1");
  });

  it("remains usable after the StrictMode effect replay", async () => {
    const microphone = recorder();
    render(
      <StrictMode>
        <BrowserVoiceQa recorderFactory={() => microphone} fetcher={vi.fn()} />
      </StrictMode>
    );

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));

    expect(await screen.findByText("正在听你说话")).toBeInTheDocument();
    expect(microphone.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the default fetcher stable across listening state renders", async () => {
    const microphone = recorder();
    render(<BrowserVoiceQa recorderFactory={() => microphone} />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(microphone.start).toHaveBeenCalledTimes(1));
    expect(microphone.dispose).not.toHaveBeenCalled();
  });

  it("uses a WAV filename when the browser recorder returns WAV", async () => {
    const microphone = recorder({
      stop: vi.fn().mockResolvedValue(new Blob(["recorded"], { type: "audio/wav" }))
    });
    const fetcher = vi.fn().mockResolvedValue(apiResponse());
    render(<BrowserVoiceQa recorderFactory={() => microphone} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    await screen.findByText("正在听你说话");
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const body = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect((body.get("audio") as File).name).toBe("voice-question.wav");
  });

  it("plays returned WAV audio and returns to idle after playback", async () => {
    const microphone = recorder();
    const fetcher = vi.fn().mockResolvedValue(apiResponse({
      traceId: "11111111-1111-4111-8111-111111111111",
      audioBase64: "AQIDBA==",
      audioMimeType: "audio/wav"
    }));
    const createObjectURL = vi.fn(() => "blob:voice-answer");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    render(<BrowserVoiceQa recorderFactory={() => microphone} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    await screen.findByText("正在听你说话");
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));

    const player = await screen.findByLabelText("AI 语音回答");
    fireEvent.play(player);
    await waitFor(() => expect(screen.getByText("正在播放回答")).toBeInTheDocument());
    fireEvent.ended(player);

    expect(await screen.findByText("可以开始提问")).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/voice/trace");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      traceId: "11111111-1111-4111-8111-111111111111",
      event: "audio_play_started"
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      traceId: "11111111-1111-4111-8111-111111111111",
      event: "session_completed",
      outcome: "completed"
    });
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice-answer"));
  });

  it("opts into NDJSON, queues ordered PCM chunks, and reports streaming playback", async () => {
    const microphone = recorder();
    const audioQueue = streamingAudioQueue();
    const traceId = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === "/api/voice/qa") {
        return ndjsonResponse([
          {
            type: "meta",
            version: 1,
            conversationSessionId: "conversation_1",
            traceId,
            audio: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
          },
          {
            type: "audio_chunk",
            sequence: 1,
            sentenceSequence: 1,
            chunkSequence: 1,
            audioBase64: "AQI="
          },
          {
            type: "audio_chunk",
            sequence: 2,
            sentenceSequence: 1,
            chunkSequence: 2,
            audioBase64: "AwQ="
          },
          {
            type: "answer",
            sessionId: "voice_session_1",
            transcript: "streamed question",
            text: "streamed answer"
          },
          { type: "complete", status: "completed", errors: [] }
        ]);
      }
      return Response.json({ ok: true });
    });
    render(
      <BrowserVoiceQa
        recorderFactory={() => microphone}
        audioQueueFactory={audioQueue.factory}
        fetcher={fetcher}
      />
    );

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(microphone.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("streamed question")).toBeInTheDocument();
    expect(screen.getByText("streamed answer")).toBeInTheDocument();
    await waitFor(() => expect(audioQueue.queue.finish).toHaveBeenCalledWith(2));
    expect(audioQueue.queue.enqueue.mock.calls.map((call) => call[0])).toEqual([
      { sequence: 1, pcm16le: new Uint8Array([1, 2]) },
      { sequence: 2, pcm16le: new Uint8Array([3, 4]) }
    ]);
    const requestInit = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get("Accept")).toBe("application/x-ndjson");
    expect(audioQueue.factory).toHaveBeenCalledWith(expect.objectContaining({
      startSequence: 1,
      onPlaybackStarted: expect.any(Function)
    }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      traceId,
      event: "playback_started"
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
      traceId,
      event: "session_completed",
      outcome: "completed"
    });
  });

  it("preserves partial streamed audio but reports a completed-with-errors turn as failed", async () => {
    const microphone = recorder();
    const audioQueue = streamingAudioQueue();
    const traceId = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === "/api/voice/qa") {
        return ndjsonResponse([
          {
            type: "meta",
            version: 1,
            conversationSessionId: "conversation_1",
            traceId,
            audio: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
          },
          {
            type: "audio_chunk",
            sequence: 1,
            sentenceSequence: 1,
            chunkSequence: 1,
            audioBase64: "AQI="
          },
          {
            type: "answer",
            sessionId: "voice_session_1",
            transcript: "partial question",
            text: "完整文字回答",
            errors: ["tts_failed"]
          },
          {
            type: "complete",
            status: "completed_with_errors",
            errors: ["tts_failed"]
          }
        ]);
      }
      return Response.json({ ok: true });
    });
    render(
      <BrowserVoiceQa
        recorderFactory={() => microphone}
        audioQueueFactory={audioQueue.factory}
        fetcher={fetcher}
      />
    );

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(microphone.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("完整文字回答")).toBeInTheDocument();
    expect(await screen.findByText("语音播放可能不完整，文字回答仍可查看。"))
      .toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
      traceId,
      event: "session_completed",
      outcome: "failed"
    });
  });

  it("cancels an active streaming request and audio queue", async () => {
    const microphone = recorder();
    const audioQueue = streamingAudioQueue();
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input !== "/api/voice/qa") return Response.json({ ok: true });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          responseController = controller;
          controller.enqueue(encoder.encode(`${JSON.stringify({
            type: "meta",
            version: 1,
            conversationSessionId: "conversation_1",
            traceId: "11111111-1111-4111-8111-111111111111",
            audio: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
          })}\n`));
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/x-ndjson" }
      });
    });
    render(
      <BrowserVoiceQa
        recorderFactory={() => microphone}
        audioQueueFactory={audioQueue.factory}
        fetcher={fetcher}
      />
    );

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(microphone.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(responseController).toBeDefined());
    fireEvent.click(await screen.findByRole("button", { name: "取消语音回答" }));

    expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    expect(audioQueue.queue.cancel).toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("button")[0]).toBeEnabled());
  });

  it("plays fallback_audio with the legacy VoicePlayer", async () => {
    const microphone = recorder();
    const audioQueue = streamingAudioQueue();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input !== "/api/voice/qa") return Response.json({ ok: true });
      return ndjsonResponse([
        {
          type: "meta",
          version: 1,
          conversationSessionId: "conversation_1",
          traceId: "11111111-1111-4111-8111-111111111111",
          audio: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
        },
        {
          type: "answer",
          sessionId: "voice_session_1",
          transcript: "fallback question",
          text: "fallback answer",
          errors: ["tts_failed"]
        },
        {
          type: "fallback_audio",
          audioBase64: "AQIDBA==",
          audioMimeType: "audio/wav"
        },
        {
          type: "complete",
          status: "completed_with_errors",
          errors: ["tts_failed"]
        }
      ]);
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:fallback-answer"),
      revokeObjectURL: vi.fn()
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    render(
      <BrowserVoiceQa
        recorderFactory={() => microphone}
        audioQueueFactory={audioQueue.factory}
        fetcher={fetcher}
      />
    );

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(microphone.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button"));

    const fallbackPlayer = await screen.findByLabelText("AI 语音回答");
    await waitFor(() => expect(fallbackPlayer).toHaveAttribute(
      "src",
      "blob:fallback-answer"
    ));
    expect(audioQueue.queue.cancel).toHaveBeenCalled();
    expect(screen.getByText("fallback answer")).toBeInTheDocument();
  });

  it("retries transient playback telemetry failures without failing the voice turn", async () => {
    const microphone = recorder();
    let traceRequests = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/voice/qa") {
        return apiResponse({
          traceId: "11111111-1111-4111-8111-111111111111",
          audioBase64: "AQIDBA==",
          audioMimeType: "audio/wav"
        });
      }
      traceRequests += 1;
      return traceRequests === 1
        ? new Response(null, { status: 503 })
        : Response.json({ ok: true });
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:voice-answer"),
      revokeObjectURL: vi.fn()
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    render(<BrowserVoiceQa recorderFactory={() => microphone} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(microphone.start).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(document.querySelector("audio")).toBeInstanceOf(HTMLAudioElement));
    const player = document.querySelector("audio") as HTMLAudioElement;
    fireEvent.play(player);

    await waitFor(() => expect(traceRequests).toBe(2), { timeout: 2_000 });
    fireEvent.ended(player);
    await waitFor(() => expect(traceRequests).toBe(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("automatically stops a recording after 60 seconds", async () => {
    vi.useFakeTimers();
    const microphone = recorder();
    const fetcher = vi.fn().mockResolvedValue(apiResponse());
    render(
      <BrowserVoiceQa
        recorderFactory={() => microphone}
        fetcher={fetcher}
        maxRecordingMs={60_000}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(microphone.stop).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the player available when autoplay is blocked", async () => {
    const microphone = recorder();
    const fetcher = vi.fn().mockResolvedValue(apiResponse({
      audioBase64: "AQIDBA==",
      audioMimeType: "audio/wav"
    }));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:voice-answer"),
      revokeObjectURL: vi.fn()
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(
      new DOMException("autoplay blocked", "NotAllowedError")
    );
    render(<BrowserVoiceQa recorderFactory={() => microphone} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    await screen.findByText("正在听你说话");
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));

    expect(await screen.findByText("浏览器没有自动播放语音，请点击播放器上的播放按钮。"))
      .toBeInTheDocument();
    expect(screen.getByLabelText("AI 语音回答")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始语音提问" })).toBeEnabled();
  });

  it("aborts an in-flight request and disposes the recorder on unmount", async () => {
    const microphone = recorder();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const { unmount } = render(<BrowserVoiceQa recorderFactory={() => microphone} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    await screen.findByText("正在听你说话");
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const signal = (fetcher.mock.calls[0]?.[1] as RequestInit).signal;
    unmount();

    expect(signal?.aborted).toBe(true);
    expect(microphone.dispose).toHaveBeenCalled();
  });

  it("disposes the microphone when the page closes while recording stop is pending", async () => {
    const microphone = recorder({ stop: vi.fn(() => new Promise<Blob>(() => undefined)) });
    const { unmount } = render(
      <BrowserVoiceQa recorderFactory={() => microphone} fetcher={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: "开始语音提问" }));
    await screen.findByText("正在听你说话");
    fireEvent.click(screen.getByRole("button", { name: "结束录音" }));
    unmount();

    expect(microphone.dispose).toHaveBeenCalled();
  });
});
