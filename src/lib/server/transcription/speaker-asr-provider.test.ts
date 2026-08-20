import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAudioChunkId, type AudioChunk } from "@/lib/domain/chunks";
import { createTranscriptionAudioAccessCapability } from "./audio-access-capability";
import { speakerAsrChunkTranscriptionAdapter, speakerAsrTranscriptionProvider } from "./speaker-asr-provider";

const originalEnv = { ...process.env };
const capabilitySecret = "daily-reflection-capability-secret-test-only";
const bearerSentinel = "speaker-asr-bearer-must-not-leave-process";

function expectedTranscriptionAudioUrl(input: {
  userId: string;
  uploadId: string;
  chunkId?: string;
}) {
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 300;
  const url = new URL(
    `https://daydiary.example.com/api/internal/audio/${input.userId}/${input.uploadId}`
  );
  if (input.chunkId) url.searchParams.set("chunkId", input.chunkId);
  url.searchParams.set("purpose", "transcription");
  url.searchParams.set("expires", String(expiresAtSeconds));
  url.searchParams.set(
    "capability",
    createTranscriptionAudioAccessCapability(capabilitySecret, {
      ...input,
      expiresAtSeconds
    })
  );
  return url.toString();
}

function restoreEnv() {
  process.env = { ...originalEnv };
}

describe("speaker-asr transcription provider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreEnv();
  });

  it("submits Daily Reflection audio through a capability without exposing either secret", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = bearerSentinel;
    process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = capabilitySecret;
    process.env.SPEAKER_ASR_SPEAKER = "0";
    process.env.SPEAKER_ASR_LANGUAGE = "cn";

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://speaker-asr.test:8300/api/ai/non-realtime-asr") {
        return new Response(JSON.stringify({ code: 0, message: "success" }), { status: 200 });
      }

      if (url.startsWith("http://speaker-asr.test:8300/api/ai/non-realtime-asr/query")) {
        return new Response(
          JSON.stringify({
            code: 0,
            message: "success",
            data: {
              asr_result: {
                detected_language: "zh",
                total_sentences: 2,
                sentences: [
                  {
                    text: "预算是不是还有风险？",
                    timestamp: [{ start: 1_000, end: 3_000 }],
                    language: "zh",
                    emotion: "neutral",
                    event: "speech"
                  },
                  {
                    text: "我们先确认方案。",
                    timestamp: [{ start: 3_500, end: 5_000 }],
                    language: "zh",
                    emotion: "neutral",
                    event: "speech"
                  }
                ]
              },
              speaker_result: [
                { speaker: "speaker_1", text: "预算是不是还有风险？" },
                { speaker: "speaker_2", text: "我们先确认方案。" }
              ]
            }
          }),
          { status: 200 }
        );
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const segments = await speakerAsrTranscriptionProvider.transcribe({
      uploadId: "upload_1",
      filePath: "/var/data/daily-brief/users/user_1/uploads/upload_1.mp3",
      mimeType: "audio/mpeg",
      audioAccessPolicy: "daily_reflection_capability"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, submitInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(submitInit?.body));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(bearerSentinel);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(capabilitySecret);

    expect(body).toMatchObject({
      audio_url: expectedTranscriptionAudioUrl({
        userId: "user_1",
        uploadId: "upload_1"
      }),
      record_id: "upload_1",
      user_id: "user_1",
      language: ["cn"],
      speaker: 0
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      uploadId: "upload_1",
      startSeconds: 1,
      endSeconds: 3,
      speaker: "speaker_1",
      text: "预算是不是还有风险？"
    });
    expect(segments[1]).toMatchObject({
      speaker: "speaker_2",
      text: "我们先确认方案。"
    });
  });

  it("keeps the legacy bearer URL contract by default without requiring a Daily Reflection secret", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "audio token";
    delete process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: { speaker_result: [{ speaker: "speaker_1", text: "legacy transcript" }] }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await speakerAsrTranscriptionProvider.transcribe({
      uploadId: "upload_legacy",
      filePath: "/var/data/daily-brief/users/user_1/uploads/upload_legacy.mp3",
      mimeType: "audio/mpeg"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.audio_url).toBe(
      "https://daydiary.example.com/api/internal/audio/user_1/upload_legacy?token=audio%20token"
    );
    expect(body.audio_url).not.toContain("capability=");
  });

  it("preserves legacy audio URL template token substitution", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_URL_TEMPLATE =
      "https://audio.example.test/{userId}/{uploadId}?access_token={token}";
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "template token";
    delete process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: { speaker_result: [{ speaker: "speaker_1", text: "template transcript" }] }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await speakerAsrTranscriptionProvider.transcribe({
      uploadId: "upload_template",
      filePath: "/var/data/daily-brief/users/user_1/uploads/upload_template.mp3",
      mimeType: "audio/mpeg",
      audioAccessPolicy: "legacy_bearer"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.audio_url).toBe(
      "https://audio.example.test/user_1/upload_template?access_token=template%20token"
    );
  });

  it("rejects a legacy token placeholder under the Daily Reflection capability policy", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_URL_TEMPLATE =
      "https://audio.example.test/{userId}/{uploadId}?token={token}";
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = bearerSentinel;
    process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = capabilitySecret;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(speakerAsrTranscriptionProvider.transcribe({
      uploadId: "upload_capability_template",
      filePath: "/var/data/daily-brief/users/user_1/uploads/upload_capability_template.mp3",
      mimeType: "audio/mpeg",
      audioAccessPolicy: "daily_reflection_capability"
    })).rejects.toMatchObject({
      code: "speaker_asr_audio_url_template_secret_exposure",
      retryable: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects missing audio URL configuration before submitting a task", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      speakerAsrTranscriptionProvider.transcribe({
        uploadId: "upload_1",
        filePath: "/tmp/upload_1.mp3",
        mimeType: "audio/mpeg"
      })
    ).rejects.toThrow("SPEAKER_ASR_AUDIO_BASE_URL");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when legacy bearer configuration is missing", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    delete process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN;
    process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = capabilitySecret;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(speakerAsrTranscriptionProvider.transcribe({
      uploadId: "upload_missing_legacy_token",
      filePath: "/var/data/daily-brief/users/user_1/uploads/upload.mp3",
      mimeType: "audio/mpeg"
    })).rejects.toThrow("SPEAKER_ASR_AUDIO_ACCESS_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when only the legacy bearer exists and the capability secret is missing", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = bearerSentinel;
    delete process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(speakerAsrTranscriptionProvider.transcribe({
      uploadId: "upload_missing_capability_secret",
      filePath: "/var/data/daily-brief/users/user_1/uploads/upload.mp3",
      mimeType: "audio/mpeg",
      audioAccessPolicy: "daily_reflection_capability"
    })).rejects.toThrow("DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed speaker_result before it reaches Transcript", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = capabilitySecret;
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            speaker_result: [{ speaker: 1, text: "must not reach Transcript" }]
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      speakerAsrTranscriptionProvider.transcribe({
        uploadId: "upload_invalid_response",
        filePath: "/var/data/daily-brief/users/user_1/uploads/upload_invalid_response.mp3",
        mimeType: "audio/mpeg",
        audioAccessPolicy: "daily_reflection_capability"
      })
    ).rejects.toThrow("speaker-asr provider returned an invalid response");
  });

  it("submits a chunk URL and returns a global-timeline TranscriptChunk", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = capabilitySecret;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/ai/non-realtime-asr")) {
        const body = JSON.parse(String(init?.body));
        expect(body.audio_url).toBe(expectedTranscriptionAudioUrl({
          userId: "user_1",
          uploadId: "upload_1",
          chunkId: "upload_1_audio_chunk_00001"
        }));
        expect(body.record_id).toBe("upload_1_audio_chunk_00001");
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              asr_result: {
                sentences: [{ text: "chunk text", timestamp: [{ start: 1_000, end: 4_000 }] }]
              },
              speaker_result: [{ speaker: "speaker_1", text: "chunk text" }]
            }
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const chunk: AudioChunk = {
      id: buildAudioChunkId("upload_1", 1),
      uploadId: "upload_1",
      index: 1,
      startSeconds: 300,
      endSeconds: 600,
      durationSeconds: 300,
      source: { type: "generated_chunk", path: "C:/data/users/user_1/uploads/upload_1-chunks/chunk_00001.mp3" },
      status: "processing",
      retryCount: 0,
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
      startedAt: "2026-07-14T08:00:00.000Z",
      metadata: { mimeType: "audio/mpeg" }
    };

    const result = await speakerAsrChunkTranscriptionAdapter.transcribeChunk({
      chunk,
      userId: "user_1",
      audioAccessPolicy: "daily_reflection_capability",
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      uploadId: "upload_1",
      audioChunkId: chunk.id,
      index: 1,
      status: "completed",
      metadata: { provider: "speaker-asr" }
    });
    expect(result.segments[0]).toMatchObject({
      id: "upload_1_chunk_00001_seg_00001",
      startSeconds: 301,
      endSeconds: 304,
      speaker: "speaker_1"
    });
  });

  it("keeps legacy bearer access for standard and Date Companion chunks without a DR secret", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "legacy_chunk_token";
    delete process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.audio_url).toBe(
        "https://daydiary.example.com/api/internal/audio/user_1/upload_legacy_chunk"
        + "?token=legacy_chunk_token&chunkId=upload_legacy_chunk_audio_chunk_00001"
      );
      return new Response(JSON.stringify({
        code: 0,
        data: { speaker_result: [{ speaker: "speaker_1", text: "legacy chunk" }] }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const chunk: AudioChunk = {
      id: buildAudioChunkId("upload_legacy_chunk", 1),
      uploadId: "upload_legacy_chunk",
      index: 1,
      startSeconds: 300,
      endSeconds: 600,
      durationSeconds: 300,
      source: {
        type: "generated_chunk",
        path: "C:/data/users/user_1/uploads/upload_legacy_chunk-chunks/chunk_00001.mp3"
      },
      status: "processing",
      retryCount: 0,
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
      startedAt: "2026-07-14T08:00:00.000Z",
      metadata: { mimeType: "audio/mpeg" }
    };

    await speakerAsrChunkTranscriptionAdapter.transcribeChunk({
      chunk,
      userId: "user_1",
      signal: new AbortController().signal
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps polling when code=0 contains no usable transcript text", async () => {
    vi.useFakeTimers();
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = capabilitySecret;
    process.env.SPEAKER_ASR_POLL_INTERVAL_MS = "500";
    process.env.SPEAKER_ASR_EMPTY_RESULT_GRACE_MS = "1000";
    let queryCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/ai/non-realtime-asr")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              asr_result: { sentences: [] },
              speaker_result: []
            }
          }),
          { status: 200 }
        );
      }
      queryCount += 1;
      if (queryCount === 1) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              asr_result: { sentences: [] },
              speaker_result: []
            }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            asr_result: {
              sentences: [{ text: "late transcript", timestamp: [{ start: 0, end: 1_000 }] }]
            },
            speaker_result: [{ speaker: "speaker_1", text: "late transcript" }]
          }
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = speakerAsrTranscriptionProvider.transcribe({
      uploadId: "upload_late_result",
      filePath: "/var/data/daily-brief/users/user_1/uploads/upload_late_result.mp3",
      mimeType: "audio/mpeg",
      audioAccessPolicy: "daily_reflection_capability"
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(queryCount).toBe(2);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("late transcript");
  });

  it("returns a retryable empty-transcript error after the code=0 grace expires", async () => {
    vi.useFakeTimers();
    process.env.SPEAKER_ASR_BASE_URL = "http://speaker-asr.test:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = capabilitySecret;
    process.env.SPEAKER_ASR_POLL_INTERVAL_MS = "500";
    process.env.SPEAKER_ASR_EMPTY_RESULT_GRACE_MS = "500";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            asr_result: { sentences: [] },
            speaker_result: []
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = speakerAsrTranscriptionProvider.transcribe({
      uploadId: "upload_permanently_empty",
      filePath: "/var/data/daily-brief/users/user_1/uploads/upload_permanently_empty.mp3",
      mimeType: "audio/mpeg",
      audioAccessPolicy: "daily_reflection_capability"
    });
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "speaker_asr_empty_transcript",
      retryable: true
    });
    await vi.advanceTimersByTimeAsync(500);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
