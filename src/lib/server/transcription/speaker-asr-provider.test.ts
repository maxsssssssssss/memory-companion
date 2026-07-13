import { afterEach, describe, expect, it, vi } from "vitest";
import { speakerAsrTranscriptionProvider } from "./speaker-asr-provider";

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
});
