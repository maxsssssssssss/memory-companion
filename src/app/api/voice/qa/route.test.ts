import { beforeEach, describe, expect, it, vi } from "vitest";

const authContextMock = vi.hoisted(() => ({
  isUnauthenticatedError: vi.fn((error: unknown) => error instanceof Error && error.message === "unauthenticated"),
  requireAuthContext: vi.fn(),
  unauthorizedResponse: vi.fn(() => Response.json({ error: "unauthenticated" }, { status: 401 }))
}));
const runBrowserVoiceQaSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/auth/request-context", () => authContextMock);
vi.mock("@/lib/server/voice-qa/browser-session", () => ({
  MAX_BROWSER_VOICE_AUDIO_BYTES: 12 * 1024 * 1024,
  BrowserVoiceQaSessionError: class BrowserVoiceQaSessionError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
      this.name = "BrowserVoiceQaSessionError";
    }
  },
  runBrowserVoiceQaSession: runBrowserVoiceQaSessionMock
}));

import { BrowserVoiceQaSessionError } from "@/lib/server/voice-qa/browser-session";
import { VoiceBrowserStreamEventSchema } from "@/lib/voice-browser-stream";

import { POST } from "./route";

const store = {
  list: vi.fn(),
  listIds: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn()
};
const storeRecords = new Map<string, unknown>();

function storeRecordKey(collection: string, id: string) {
  return `${collection}/${id}`;
}

function voiceForm(input: {
  bytes?: Uint8Array;
  mimeType?: string;
  scope?: string;
  uploadId?: string;
  referenceDate?: string;
  userId?: string;
  conversationSessionId?: string;
  conversation?: unknown;
  answerMode?: string;
  context?: unknown;
}) {
  const form = new FormData();
  const bytes = input.bytes ?? new Uint8Array([1, 2, 3, 4]);
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const file = new File([arrayBuffer], "question.webm", {
    type: input.mimeType ?? "audio/webm;codecs=opus"
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: vi.fn().mockResolvedValue(arrayBuffer)
  });
  form.set(
    "audio",
    file
  );
  if (input.scope !== undefined) form.set("scope", input.scope);
  if (input.uploadId !== undefined) form.set("uploadId", input.uploadId);
  if (input.referenceDate !== undefined) form.set("referenceDate", input.referenceDate);
  if (input.userId !== undefined) form.set("userId", input.userId);
  if (input.conversationSessionId !== undefined) {
    form.set("conversationSessionId", input.conversationSessionId);
  }
  if (input.conversation !== undefined) {
    form.set(
      "conversation",
      typeof input.conversation === "string"
        ? input.conversation
        : JSON.stringify(input.conversation)
    );
  }
  if (input.answerMode !== undefined) form.set("answerMode", input.answerMode);
  if (input.context !== undefined) {
    form.set("context", typeof input.context === "string" ? input.context : JSON.stringify(input.context));
  }
  return form;
}

function voiceContext(contextId = "upload_1") {
  return {
    contextId,
    segments: [{
      id: "segment_1",
      uploadId: contextId,
      startSeconds: 0,
      endSeconds: 1,
      speaker: "speaker_0",
      text: "A retained browser context fact.",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }],
    audioInsights: [],
    semanticSegments: [],
    briefItems: [],
    relationshipSignals: []
  };
}

function request(
  form: FormData,
  options: { accept?: string; signal?: AbortSignal } = {}
) {
  return {
    headers: new Headers({
      "Content-Type": "multipart/form-data; boundary=voice-test",
      ...(options.accept ? { Accept: options.accept } : {})
    }),
    formData: vi.fn().mockResolvedValue(form),
    signal: options.signal ?? new AbortController().signal
  } as unknown as Request;
}

async function ndjsonEvents(response: Response) {
  const body = await response.text();
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => VoiceBrowserStreamEventSchema.parse(JSON.parse(line)));
}

function successfulSession(overrides: Record<string, unknown> = {}) {
  return {
    response: {
      sessionId: "provider_session_1",
      transcript: "今天有什么重要事情？",
      mode: "VOICE",
      text: "今天有一件值得留意的事情。",
      answer: {
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
      },
      audio: Buffer.from([0, 0, 1, 0])
    },
    session: {
      id: "provider_session_1",
      state: "closed",
      startedAt: "2026-07-20T10:00:00.000Z",
      history: []
    },
    ...overrides
  };
}

function largeCanonicalAnswerMetadata() {
  const sourceGroups = Array.from({ length: 6 }, (_, evidenceIndex) =>
    Array.from(
      { length: 24 },
      (_, sourceIndex) => `segment:${evidenceIndex + 1}:${sourceIndex + 1}`
    )
  );
  return {
    id: "answer:canonical/long-recording",
    citedSegmentIds: sourceGroups.flat(),
    citations: sourceGroups.map((sourceSegmentIds, index) => ({
      id: `E${index + 1}`,
      title: `Evidence ${index + 1}`,
      startSeconds: index * 60,
      endSeconds: (index + 1) * 60,
      excerpt: `Grounded excerpt ${index + 1}`,
      sourceSegmentIds
    }))
  };
}

describe("POST /api/voice/qa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRecords.clear();
    store.read.mockImplementation(async (collection: string, id: string) =>
      storeRecords.get(storeRecordKey(collection, id)) ?? null
    );
    store.write.mockImplementation(async (collection: string, id: string, value: unknown) => {
      storeRecords.set(storeRecordKey(collection, id), value);
    });
    store.delete.mockImplementation(async (collection: string, id: string) => {
      storeRecords.delete(storeRecordKey(collection, id));
    });
    store.list.mockImplementation(async (collection: string) => [...storeRecords.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([key, value]) => ({ id: key.slice(collection.length + 1), value }))
    );
    authContextMock.requireAuthContext.mockResolvedValue({
      user: { id: "user_1", email: "voice@example.test" },
      store,
      dataRootDir: "unused",
      uploadsRootDir: "unused"
    });
    runBrowserVoiceQaSessionMock.mockResolvedValue(successfulSession());
  });

  it("authenticates before parsing or validating the audio body", async () => {
    authContextMock.requireAuthContext.mockRejectedValue(new Error("unauthenticated"));
    const response = await POST(new Request("http://localhost/api/voice/qa", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not audio"
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
  });

  it("uses the authenticated user store and returns playable WAV plus an unspoken citation trace", async () => {
    const response = await POST(request(voiceForm({ scope: "all" })));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.version).toBe(1);
    expect(payload.traceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(runBrowserVoiceQaSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      store,
      scope: "all",
      answerMode: "agent",
      mimeType: "audio/webm;codecs=opus",
      audio: expect.any(Buffer),
      signal: expect.any(AbortSignal)
    }));
    expect(payload.text).not.toContain("[E1]");
    expect(payload.answer).toEqual({
      id: "answer_1",
      citedSegmentIds: ["segment_1"],
      citations: expect.arrayContaining([expect.objectContaining({ id: "citation_1" })])
    });
    expect(payload.audioMimeType).toBe("audio/wav");
    expect(Buffer.from(payload.audioBase64, "base64").subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("returns an opt-in NDJSON stream immediately and forwards ordered audio before answer/complete", async () => {
    let finishSession: ((value: ReturnType<typeof successfulSession>) => void) | undefined;
    runBrowserVoiceQaSessionMock.mockImplementation(async (input: {
      onStreamingEvent?: (event: unknown) => Promise<void>;
    }) => {
      await input.onStreamingEvent?.({
        type: "audio_chunk",
        sequence: 1,
        sentenceSequence: 1,
        sentenceChunkSequence: 1,
        supportIds: ["segment_1"],
        audio: Buffer.from([1, 2]),
        format: { encoding: "pcm_s16le", sampleRate: 24_000, channels: 1 }
      });
      await input.onStreamingEvent?.({
        type: "audio_chunk",
        sequence: 2,
        sentenceSequence: 1,
        sentenceChunkSequence: 2,
        supportIds: ["segment_1"],
        audio: Buffer.from([3, 4]),
        format: { encoding: "pcm_s16le", sampleRate: 24_000, channels: 1 }
      });
      return await new Promise((resolve) => {
        finishSession = resolve;
      });
    });

    const response = await POST(request(
      voiceForm({ scope: "all" }),
      { accept: "application/x-ndjson" }
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const eventsPromise = ndjsonEvents(response);
    await vi.waitFor(() => expect(finishSession).toBeTypeOf("function"));
    finishSession!(successfulSession({
      response: {
        ...successfulSession().response,
        audio: undefined,
        streamedAudio: true
      }
    }));
    const events = await eventsPromise;

    expect(events.map((event) => event.type)).toEqual([
      "meta",
      "audio_chunk",
      "audio_chunk",
      "answer",
      "complete"
    ]);
    expect(events.slice(1, 3)).toEqual([
      expect.objectContaining({
        type: "audio_chunk",
        sequence: 1,
        sentenceSequence: 1,
        chunkSequence: 1,
        audioBase64: Buffer.from([1, 2]).toString("base64")
      }),
      expect.objectContaining({
        type: "audio_chunk",
        sequence: 2,
        sentenceSequence: 1,
        chunkSequence: 2,
        audioBase64: Buffer.from([3, 4]).toString("base64")
      })
    ]);
    expect(events.at(-2)).toMatchObject({
      type: "answer",
      sessionId: "provider_session_1",
      answer: {
        id: "answer_1",
        citedSegmentIds: ["segment_1"]
      }
    });
    expect(events.at(-1)).toEqual({
      type: "complete",
      status: "completed",
      errors: []
    });
    const traceId = (events[0] as { traceId: string }).traceId;
    await vi.waitFor(() => {
      expect(storeRecords.get(`voice-session-traces/${traceId}`)).toMatchObject({
        timestamps: expect.objectContaining({
          transport_complete_written: expect.any(String)
        })
      });
    });
    expect(runBrowserVoiceQaSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      onStreamingEvent: expect.any(Function),
      signal: expect.any(AbortSignal)
    }));
  });

  it("preserves a large canonical source mapping after streamed audio and completes normally", async () => {
    const answerMetadata = largeCanonicalAnswerMetadata();
    runBrowserVoiceQaSessionMock.mockImplementation(async (input: {
      onStreamingEvent?: (event: unknown) => Promise<void>;
    }) => {
      await input.onStreamingEvent?.({
        type: "audio_chunk",
        sequence: 1,
        sentenceSequence: 1,
        sentenceChunkSequence: 1,
        supportIds: answerMetadata.citedSegmentIds,
        audio: Buffer.from([1, 2]),
        format: { encoding: "pcm_s16le", sampleRate: 24_000, channels: 1 }
      });
      const base = successfulSession().response;
      return successfulSession({
        response: {
          ...base,
          audio: undefined,
          streamedAudio: true,
          answer: {
            ...base.answer,
            ...answerMetadata
          }
        }
      });
    });

    const response = await POST(request(
      voiceForm({ scope: "all" }),
      { accept: "application/x-ndjson" }
    ));
    const events = await ndjsonEvents(response);
    const answerEvent = events.find((event) => event.type === "answer");

    expect(answerMetadata.citedSegmentIds.length).toBeGreaterThan(128);
    expect(events.map((event) => event.type)).toEqual([
      "meta",
      "audio_chunk",
      "answer",
      "complete"
    ]);
    expect(answerEvent).toMatchObject({
      type: "answer",
      answer: {
        id: answerMetadata.id,
        citedSegmentIds: answerMetadata.citedSegmentIds,
        citations: answerMetadata.citations
      }
    });
    expect(events.at(-1)).toEqual({
      type: "complete",
      status: "completed",
      errors: []
    });
  });

  it("terminates a Provider-backed TTS failure with one completed-with-errors event", async () => {
    const base = successfulSession().response;
    runBrowserVoiceQaSessionMock.mockResolvedValue(successfulSession({
      response: {
        ...base,
        audio: undefined,
        streamedAudio: undefined,
        errors: ["tts_failed"],
        errorCodes: ["VOICE_TTS_FAILED"]
      }
    }));

    const response = await POST(request(
      voiceForm({ scope: "all" }),
      { accept: "application/x-ndjson" }
    ));
    const events = await ndjsonEvents(response);

    expect(events.map((event) => event.type)).toEqual([
      "meta",
      "answer",
      "complete"
    ]);
    expect(events.filter((event) => event.type === "complete")).toEqual([{
      type: "complete",
      status: "completed_with_errors",
      errors: ["tts_failed"]
    }]);
    expect(events.at(-2)).toMatchObject({
      type: "answer",
      text: base.text,
      errors: ["tts_failed"],
      errorCodes: ["VOICE_TTS_FAILED"]
    });
  });

  it("logs only safe issue codes and paths when a stream event fails schema validation", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = successfulSession().response;
    runBrowserVoiceQaSessionMock.mockResolvedValue(successfulSession({
      response: {
        ...base,
        text: "PRIVATE_ANSWER_BODY",
        audio: undefined,
        streamedAudio: true,
        answer: {
          ...base.answer,
          id: "",
          citedSegmentIds: ["private:source/content"],
          citations: [{
            ...base.answer.citations[0],
            excerpt: "PRIVATE_EVIDENCE_BODY",
            sourceSegmentIds: ["private:source/content"]
          }]
        }
      }
    }));

    try {
      const response = await POST(request(
        voiceForm({ scope: "all" }),
        { accept: "application/x-ndjson" }
      ));
      const events = await ndjsonEvents(response);
      const prefix = "VOICE_STREAM_SCHEMA_VALIDATION ";
      const diagnosticLine = warnSpy.mock.calls
        .flatMap((call) => call)
        .find((value): value is string =>
          typeof value === "string" && value.startsWith(prefix)
        );

      expect(events.map((event) => event.type)).toEqual(["meta", "error", "complete"]);
      expect(diagnosticLine).toBeDefined();
      expect(JSON.parse(diagnosticLine!.slice(prefix.length))).toEqual({
        event_type: "answer",
        issue_codes: ["too_small"],
        issue_paths: ["answer.id"]
      });
      expect(diagnosticLine).not.toContain("PRIVATE_ANSWER_BODY");
      expect(diagnosticLine).not.toContain("PRIVATE_EVIDENCE_BODY");
      expect(diagnosticLine).not.toContain("private:source/content");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps the legacy JSON/WAV response when NDJSON is not explicitly accepted", async () => {
    const response = await POST(request(
      voiceForm({ scope: "all" }),
      { accept: "application/json" }
    ));
    const payload = await response.json();

    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(payload.version).toBe(1);
    expect(payload.audioMimeType).toBe("audio/wav");
    expect(runBrowserVoiceQaSessionMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ onStreamingEvent: expect.anything() })
    );
  });

  it("returns only sanitized NDJSON failure metadata when the streaming session fails", async () => {
    runBrowserVoiceQaSessionMock.mockRejectedValue(
      new Error("access-key=PRIVATE_PROVIDER_CREDENTIAL transcript=PRIVATE_USER_TEXT")
    );

    const response = await POST(request(
      voiceForm({ scope: "all" }),
      { accept: "application/x-ndjson" }
    ));
    const body = await response.text();
    const events = body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => VoiceBrowserStreamEventSchema.parse(JSON.parse(line)));

    expect(response.status).toBe(200);
    expect(events.map((event) => event.type)).toEqual(["meta", "error", "complete"]);
    expect(events.at(-2)).toEqual({
      type: "error",
      code: "voice_session_failed",
      textAvailable: false
    });
    expect(events.at(-1)).toEqual({
      type: "complete",
      status: "failed",
      errors: ["voice_session_failed"]
    });
    expect(body).not.toContain("PRIVATE_PROVIDER_CREDENTIAL");
    expect(body).not.toContain("PRIVATE_USER_TEXT");
  });

  it("aborts an in-flight NDJSON session through the request signal", async () => {
    const controller = new AbortController();
    runBrowserVoiceQaSessionMock.mockImplementation(async (input: { signal: AbortSignal }) =>
      await new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(
          new BrowserVoiceQaSessionError("request_aborted", "aborted")
        ), { once: true });
      })
    );

    const response = await POST(request(
      voiceForm({ scope: "all" }),
      { accept: "application/x-ndjson", signal: controller.signal }
    ));
    const eventsPromise = ndjsonEvents(response);
    await vi.waitFor(() => expect(runBrowserVoiceQaSessionMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const events = await eventsPromise;

    expect(events.map((event) => event.type)).toEqual(["meta", "error", "complete"]);
    expect(events.at(-2)).toEqual({
      type: "error",
      code: "voice_request_aborted",
      textAvailable: false
    });
    expect(events.at(-1)).toEqual({
      type: "complete",
      status: "aborted",
      errors: ["voice_request_aborted"]
    });
    const meta = events[0];
    expect(meta?.type).toBe("meta");
    const conversationSessionId = meta?.type === "meta" ? meta.conversationSessionId : "";
    const stored = storeRecords.get(`voice-sessions/${conversationSessionId}`) as {
      state?: string;
      activeTraceId?: string;
    };
    expect(stored.state).toBe("IDLE");
    expect(stored.activeTraceId).toBeUndefined();
  });

  it("passes an explicit Direct answer mode without changing the authenticated context", async () => {
    const response = await POST(request(voiceForm({ scope: "all", answerMode: "direct" })));

    expect(response.status).toBe(200);
    expect(runBrowserVoiceQaSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      store,
      scope: "all",
      answerMode: "direct"
    }));
  });

  it.each(["DIRECT", "fallback", ""])(
    "rejects an invalid answer mode before opening the Provider (%s)",
    async (answerMode) => {
      const response = await POST(request(voiceForm({ scope: "all", answerMode })));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_answer_mode" });
      expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
    }
  );

  it("rejects duplicate answer mode values", async () => {
    const form = voiceForm({ scope: "all", answerMode: "agent" });
    form.append("answerMode", "direct");

    const response = await POST(request(form));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "duplicate_answer_mode" });
    expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
  });

  it("passes valid current and week scope context without accepting a client user id", async () => {
    const context = voiceContext();
    await POST(request(voiceForm({ scope: "current", uploadId: "upload_1", context })));
    expect(runBrowserVoiceQaSessionMock).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: "user_1",
      scope: "current",
      uploadId: "upload_1",
      context
    }));

    await POST(request(voiceForm({ scope: "week", referenceDate: "2026-07-20" })));
    expect(runBrowserVoiceQaSessionMock).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: "user_1",
      scope: "week",
      referenceDate: expect.any(Date)
    }));
  });

  it.each([
    ["not-json", "invalid_voice_context"],
    [JSON.stringify({ contextId: "upload_1" }), "invalid_voice_context"],
    [JSON.stringify(voiceContext("another_upload")), "voice_context_upload_mismatch"]
  ])("rejects unsafe browser context before opening the provider (%s)", async (context, error) => {
    const response = await POST(request(voiceForm({
      scope: "current",
      uploadId: "upload_1",
      context
    })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not-json"],
    [JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`
    })))],
    [JSON.stringify([{ role: "system", content: "unsafe role" }])],
    [JSON.stringify([{ role: "user", content: "x".repeat(1_201) }])],
    [JSON.stringify([{ role: "user", content: "valid", extra: true }])]
  ])("rejects an invalid bounded browser conversation before opening the provider (%s)", async (conversation) => {
    const response = await POST(request(voiceForm({
      scope: "all",
      conversation
    })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_conversation" });
    expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate browser conversation fields", async () => {
    const form = voiceForm({ scope: "all" });
    form.append("conversation", "[]");
    form.append("conversation", "[]");

    const response = await POST(request(form));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "duplicate_conversation" });
    expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
  });

  it("persists and reinjects short-term context for the same browser conversation session", async () => {
    runBrowserVoiceQaSessionMock.mockImplementation(async (input: {
      onLifecycleStateChange?: (state: string) => Promise<void>;
      onTurnCompleted?: (turn: {
        transcript: string;
        response: string;
        retrievedMemoryIds: string[];
      }) => Promise<void>;
    }) => {
      await input.onLifecycleStateChange?.("PROCESSING");
      await input.onTurnCompleted?.({
        transcript: "我今天和经理争论了。",
        response: "听起来这件事让你有些压力。",
        retrievedMemoryIds: ["memory_manager_conversation"]
      });
      await input.onLifecycleStateChange?.("RESPONDING");
      await input.onLifecycleStateChange?.("IDLE");
      return successfulSession();
    });

    const first = await POST(request(voiceForm({ scope: "all" })));
    const firstPayload = await first.json();
    expect(first.status).toBe(200);
    expect(firstPayload.conversationSessionId).toMatch(/^[0-9a-f-]{36}$/u);

    const second = await POST(request(voiceForm({
      scope: "all",
      conversationSessionId: firstPayload.conversationSessionId
    })));
    expect(second.status).toBe(200);
    expect(runBrowserVoiceQaSessionMock).toHaveBeenLastCalledWith(expect.objectContaining({
      applicationSessionId: firstPayload.conversationSessionId,
      conversation: [
        { role: "user", content: "我今天和经理争论了。" },
        { role: "assistant", content: "听起来这件事让你有些压力。" }
      ]
    }));

    const stored = storeRecords.get(`voice-sessions/${firstPayload.conversationSessionId}`) as {
      retrievedMemoryIds: string[];
      currentTopic?: string;
      state: string;
    };
    expect(stored.retrievedMemoryIds).toEqual(["memory_manager_conversation"]);
    expect(stored.currentTopic).toBe("我今天和经理争论了");
    expect(stored.state).toBe("IDLE");
  });

  it("uses a client-supplied bounded conversation instead of stacking managed session context", async () => {
    runBrowserVoiceQaSessionMock.mockImplementation(async (input: {
      onLifecycleStateChange?: (state: string) => Promise<void>;
      onTurnCompleted?: (turn: {
        transcript: string;
        response: string;
        retrievedMemoryIds: string[];
      }) => Promise<void>;
    }) => {
      await input.onLifecycleStateChange?.("PROCESSING");
      await input.onTurnCompleted?.({
        transcript: "managed user turn",
        response: "managed assistant turn",
        retrievedMemoryIds: []
      });
      await input.onLifecycleStateChange?.("RESPONDING");
      await input.onLifecycleStateChange?.("IDLE");
      return successfulSession();
    });

    const first = await POST(request(voiceForm({ scope: "all" })));
    const firstPayload = await first.json();
    const clientConversation = [
      { role: "user", content: "shared text conversation" },
      { role: "assistant", content: "shared text answer" }
    ];

    const second = await POST(request(voiceForm({
      scope: "all",
      conversationSessionId: firstPayload.conversationSessionId,
      conversation: clientConversation
    })));

    expect(second.status).toBe(200);
    expect(runBrowserVoiceQaSessionMock).toHaveBeenLastCalledWith(expect.objectContaining({
      applicationSessionId: firstPayload.conversationSessionId,
      conversation: clientConversation
    }));
  });

  it("treats an explicitly empty client conversation as authoritative", async () => {
    const response = await POST(request(voiceForm({
      scope: "all",
      conversation: []
    })));

    expect(response.status).toBe(200);
    expect(runBrowserVoiceQaSessionMock).toHaveBeenLastCalledWith(expect.objectContaining({
      conversation: []
    }));
  });

  it("returns a text-only successful response when TTS failed", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    runBrowserVoiceQaSessionMock.mockResolvedValue(successfulSession({
      response: {
        sessionId: "provider_session_1",
        transcript: "今天有什么重要事情？",
        mode: "VOICE",
        text: "暂时无法播放语音，但文字还在。",
        errors: ["tts_failed"]
      }
    }));

    const response = await POST(request(voiceForm({ scope: "all" })));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.audioBase64).toBeUndefined();
    expect(payload.audioMimeType).toBeUndefined();
    expect(payload.errors).toEqual(["tts_failed"]);
    expect(payload.text).toBe("暂时无法播放语音，但文字还在。");
    expect(store.write).toHaveBeenLastCalledWith(
      "voice-session-traces",
      payload.traceId,
      expect.objectContaining({
        status: "completed_with_errors",
        failures: [{ stage: "tts", code: "tts_failed" }],
        timestamps: expect.not.objectContaining({ audio_play_started: expect.anything() })
      })
    );
  });

  it("returns the ASR timeout prompt without audio or a TTS trace", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    runBrowserVoiceQaSessionMock.mockImplementation(async (input: {
      trace: { recordFailure(stage: "asr", code: "asr_timeout"): void };
    }) => {
      input.trace.recordFailure("asr", "asr_timeout");
      return successfulSession({
        response: {
          sessionId: "provider_session_1",
          transcript: "",
          mode: "VOICE",
          text: "没听清楚，可以再说一遍吗？",
          errors: ["asr_failed"],
          errorCodes: ["VOICE_ASR_TIMEOUT"]
        }
      });
    });

    const response = await POST(request(voiceForm({ scope: "all" })));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.audioBase64).toBeUndefined();
    expect(payload.audioMimeType).toBeUndefined();
    expect(payload.errors).toEqual(["asr_failed"]);
    expect(payload.errorCodes).toEqual(["VOICE_ASR_TIMEOUT"]);
    expect(payload.text).toBe("没听清楚，可以再说一遍吗？");
    expect(store.write).toHaveBeenLastCalledWith(
      "voice-session-traces",
      payload.traceId,
      expect.objectContaining({
        status: "completed_with_errors",
        failures: expect.arrayContaining([
          { stage: "asr", code: "asr_timeout" },
          { stage: "asr", code: "asr_failed" }
        ]),
        timestamps: expect.not.objectContaining({ tts_started: expect.anything() })
      })
    );
  });

  it.each([
    ["missing current upload", { scope: "current" }, "current_upload_required"],
    ["upload on all scope", { scope: "all", uploadId: "upload_1" }, "upload_not_allowed"],
    ["invalid scope", { scope: "forever" }, "invalid_scope"],
    ["invalid upload id", { scope: "current", uploadId: "../other-user" }, "invalid_upload_id"],
    ["reference date on all", { scope: "all", referenceDate: "2026-07-20" }, "reference_date_not_allowed"],
    ["invalid week reference date", { scope: "week", referenceDate: "2026-02-30" }, "invalid_reference_date"],
    ["client supplied user id", { scope: "all", userId: "other_user" }, "user_id_not_allowed"]
  ])("rejects %s", async (_name, fields, expectedError) => {
    const response = await POST(request(voiceForm(fields)));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expectedError });
    expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
  });

  it.each(["text/plain", "video/webm", "application/octet-stream"])(
    "rejects unsupported media type %s",
    async (mimeType) => {
      const response = await POST(request(voiceForm({ scope: "all", mimeType })));
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "unsupported_audio_format" });
      expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
    }
  );

  it("rejects empty and oversized audio before starting a provider session", async () => {
    const empty = await POST(request(voiceForm({ scope: "all", bytes: new Uint8Array() })));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "empty_audio" });

    const oversized = await POST(request(voiceForm({
      scope: "all",
      bytes: new Uint8Array(12 * 1024 * 1024 + 1)
    })));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "audio_too_large" });
    expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized Content-Length before parsing multipart data", async () => {
    const formData = vi.fn();
    const response = await POST({
      headers: new Headers({
        "Content-Type": "multipart/form-data; boundary=voice-test",
        "Content-Length": String(
          12 * 1024 * 1024 +
          4 * 1024 * 1024 +
          16 * 1024 +
          256 * 1024 +
          1
        )
      }),
      formData,
      signal: new AbortController().signal
    } as unknown as Request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "audio_too_large" });
    expect(formData).not.toHaveBeenCalled();
  });

  it("does not open a provider session for an already aborted browser request", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedRequest = request(voiceForm({ scope: "all" })) as Request & { signal: AbortSignal };
    Object.defineProperty(abortedRequest, "signal", { value: controller.signal });

    const response = await POST(abortedRequest);
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "voice_request_aborted" });
    expect(runBrowserVoiceQaSessionMock).not.toHaveBeenCalled();
  });

  it("keeps the answer when returned TTS bytes cannot be wrapped as PCM WAV", async () => {
    runBrowserVoiceQaSessionMock.mockResolvedValue(successfulSession({
      response: {
        ...successfulSession().response,
        audio: Buffer.from([1, 2, 3])
      }
    }));

    const response = await POST(request(voiceForm({ scope: "all" })));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.text).toBe("今天有一件值得留意的事情。");
    expect(payload.audioBase64).toBeUndefined();
    expect(payload.errors).toEqual(["tts_failed"]);
    expect(payload.errorCodes).toEqual(["VOICE_TTS_FAILED"]);
  });

  it.each([
    {
      stage: "asr",
      marks: [] as const,
      expectedFailure: { stage: "asr", code: "asr_final_missing" }
    },
    {
      stage: "qa",
      marks: ["asr_final_received", "qa_started"] as const,
      expectedFailure: { stage: "qa", code: "qa_timeout" }
    },
    {
      stage: "tts",
      marks: ["asr_final_received", "qa_started", "qa_completed", "tts_started"] as const,
      expectedFailure: { stage: "tts", code: "tts_timeout" }
    }
  ])("classifies a whole-session timeout at the $stage stage", async ({ marks, expectedFailure }) => {
    runBrowserVoiceQaSessionMock.mockImplementation(async (input) => {
      for (const event of marks) input.trace.mark(event);
      throw new BrowserVoiceQaSessionError("response_timeout", "timed out");
    });

    const response = await POST(request(voiceForm({ scope: "all" })));
    expect(response.status).toBe(504);

    const traceWrites = store.write.mock.calls.filter(([collection]) => collection === "voice-session-traces");
    const trace = traceWrites[traceWrites.length - 1]?.[2];
    expect(trace).toMatchObject({
      status: "incomplete",
      failures: expect.arrayContaining([
        expectedFailure,
        { stage: "session", code: "response_timeout" }
      ])
    });
    if (expectedFailure.stage !== "asr") {
      expect(trace.failures).not.toContainEqual({ stage: "asr", code: "asr_final_missing" });
    }
  });

  it("does not expose provider errors or credentials", async () => {
    runBrowserVoiceQaSessionMock.mockRejectedValue(new Error("access-key=secret-provider-value"));
    const response = await POST(request(voiceForm({ scope: "all" })));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("voice_session_failed");
    expect(body).not.toContain("secret-provider-value");
  });
});
