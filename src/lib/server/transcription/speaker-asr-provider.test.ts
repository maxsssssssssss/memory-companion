import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAudioChunkId, type AudioChunk } from "@/lib/domain/chunks";
import { speakerAsrChunkTranscriptionAdapter, speakerAsrTranscriptionProvider } from "./speaker-asr-provider";

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
}

describe("speaker-asr transcription provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  it("submits audio_url tasks and maps diarized ASR results to transcript segments", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://14.103.196.9:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "audio_token";
    process.env.SPEAKER_ASR_SPEAKER = "0";
    process.env.SPEAKER_ASR_LANGUAGE = "cn";

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://14.103.196.9:8300/api/ai/non-realtime-asr") {
        return new Response(JSON.stringify({ code: 0, message: "success" }), { status: 200 });
      }

      if (url.startsWith("http://14.103.196.9:8300/api/ai/non-realtime-asr/query")) {
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
      mimeType: "audio/mpeg"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, submitInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(submitInit?.body));

    expect(body).toMatchObject({
      audio_url: "https://daydiary.example.com/api/internal/audio/user_1/upload_1?token=audio_token",
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

  it("rejects missing audio URL configuration before submitting a task", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://14.103.196.9:8300";
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

  it("submits a chunk URL and returns a global-timeline TranscriptChunk", async () => {
    process.env.SPEAKER_ASR_BASE_URL = "http://14.103.196.9:8300";
    process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://daydiary.example.com";
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "audio_token";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/ai/non-realtime-asr")) {
        const body = JSON.parse(String(init?.body));
        expect(body.audio_url).toBe(
          "https://daydiary.example.com/api/internal/audio/user_1/upload_1?token=audio_token&chunkId=upload_1_audio_chunk_00001"
        );
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
});
