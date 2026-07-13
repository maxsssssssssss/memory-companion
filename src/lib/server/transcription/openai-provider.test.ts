import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, getOpenAIClientRuntimeConfigMock, openAIMock, transcribeMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getOpenAIClientRuntimeConfigMock: vi.fn(),
  openAIMock: vi.fn(),
  transcribeMock: vi.fn()
}));

vi.mock("openai", () => ({
  default: function MockOpenAI(...args: unknown[]) {
    openAIMock(...args);
    return {
      audio: {
        transcriptions: {
          create: transcribeMock
        }
      }
    } as never;
  }
}));

vi.mock("child_process", () => ({
  default: {
    execFile: execFileMock
  },
  execFile: execFileMock
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: getOpenAIClientRuntimeConfigMock
}));

import { openaiTranscriptionProvider } from "./openai-provider";

const inputTemplate = {
  uploadId: "upload_test",
  mimeType: "audio/mp4"
};
let tempAudioPath: string | undefined;

describe("openai transcription provider", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
  const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  const originalOpenRouterBaseUrl = process.env.OPENROUTER_BASE_URL;
  const originalOpenRouterReferer = process.env.OPENROUTER_HTTP_REFERER;
  const originalOpenRouterAppTitle = process.env.OPENROUTER_APP_TITLE;
  const originalOpenRouterChunkSeconds = process.env.OPENROUTER_TRANSCRIBE_CHUNK_SECONDS;
  const originalTranscribeModel = process.env.OPENAI_TRANSCRIBE_MODEL;
  const originalTimeout = process.env.OPENAI_REQUEST_TIMEOUT_MS;
  const originalMaxRetries = process.env.OPENAI_MAX_RETRIES;
  const originalFfmpegPath = process.env.FFMPEG_PATH;
  const originalFfprobePath = process.env.FFPROBE_PATH;
  const originalFetch = globalThis.fetch;
  let tempDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "long-time-record-analyze-openai-"));
    tempAudioPath = join(tempDir, "audio.m4a");
    await writeFile(tempAudioPath, "audio-placeholder");
    process.env.OPENAI_API_KEY = "test_key";
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENROUTER_HTTP_REFERER;
    delete process.env.OPENROUTER_APP_TITLE;
    delete process.env.OPENROUTER_TRANSCRIBE_CHUNK_SECONDS;
    delete process.env.OPENAI_TRANSCRIBE_MODEL;
    process.env.FFMPEG_PATH = "ffmpeg";
    process.env.FFPROBE_PATH = "ffprobe";
    globalThis.fetch = originalFetch;
    transcribeMock.mockReset();
    openAIMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({});
    execFileMock.mockReset();
    execFileMock.mockImplementation((command: string, _args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(new Error(`${command} unavailable`), "", "");
    });
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
      tempAudioPath = undefined;
    }

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    if (originalOpenAiBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
    }
    if (originalOpenRouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
    }
    if (originalOpenRouterBaseUrl === undefined) {
      delete process.env.OPENROUTER_BASE_URL;
    } else {
      process.env.OPENROUTER_BASE_URL = originalOpenRouterBaseUrl;
    }
    if (originalOpenRouterReferer === undefined) {
      delete process.env.OPENROUTER_HTTP_REFERER;
    } else {
      process.env.OPENROUTER_HTTP_REFERER = originalOpenRouterReferer;
    }
    if (originalOpenRouterAppTitle === undefined) {
      delete process.env.OPENROUTER_APP_TITLE;
    } else {
      process.env.OPENROUTER_APP_TITLE = originalOpenRouterAppTitle;
    }
    if (originalOpenRouterChunkSeconds === undefined) {
      delete process.env.OPENROUTER_TRANSCRIBE_CHUNK_SECONDS;
    } else {
      process.env.OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = originalOpenRouterChunkSeconds;
    }
    if (originalTranscribeModel === undefined) {
      delete process.env.OPENAI_TRANSCRIBE_MODEL;
    } else {
      process.env.OPENAI_TRANSCRIBE_MODEL = originalTranscribeModel;
    }
    if (originalTimeout === undefined) {
      delete process.env.OPENAI_REQUEST_TIMEOUT_MS;
    } else {
      process.env.OPENAI_REQUEST_TIMEOUT_MS = originalTimeout;
    }
    if (originalMaxRetries === undefined) {
      delete process.env.OPENAI_MAX_RETRIES;
    } else {
      process.env.OPENAI_MAX_RETRIES = originalMaxRetries;
    }
    if (originalFfmpegPath === undefined) {
      delete process.env.FFMPEG_PATH;
    } else {
      process.env.FFMPEG_PATH = originalFfmpegPath;
    }
    if (originalFfprobePath === undefined) {
      delete process.env.FFPROBE_PATH;
    } else {
      process.env.FFPROBE_PATH = originalFfprobePath;
    }
    globalThis.fetch = originalFetch;
  });

  it("maps diarized segments to transcript segments", async () => {
    const input = {
      ...inputTemplate,
      filePath: tempAudioPath ?? "/tmp/audio.m4a"
    };

    transcribeMock.mockResolvedValue({
      segments: [
        { start: 0, end: 10, text: "先做个复盘", speaker: "speaker_1" },
        { start: 20, end: 30, text: "下周继续", speaker: "speaker_2" }
      ]
    });

    const segments = await openaiTranscriptionProvider.transcribe(input);

    expect(segments).toHaveLength(2);
    expect(segments[0].id).toBe("upload_test_seg_1");
    expect(segments[0].speaker).toBe("speaker_1");
    expect(segments[0].uploadId).toBe("upload_test");
    expect(segments.every((segment) => segment.sceneLabels.length > 0)).toBe(true);
  });

  it("falls back to the text field when segments are missing", async () => {
    const input = {
      ...inputTemplate,
      filePath: tempAudioPath ?? "/tmp/audio.m4a"
    };

    transcribeMock.mockResolvedValue({ text: "纯文本兜底" });

    const segments = await openaiTranscriptionProvider.transcribe(input);

    expect(segments).toEqual([
      expect.objectContaining({
        id: "upload_test_seg_1",
        uploadId: "upload_test",
        text: "纯文本兜底",
        confidence: expect.closeTo(0.6)
      })
    ]);
  });

  it("passes OpenAI client env config into SDK options", async () => {
    const input = {
      ...inputTemplate,
      filePath: tempAudioPath ?? "/tmp/audio.m4a"
    };

    process.env.OPENAI_REQUEST_TIMEOUT_MS = "90000";
    process.env.OPENAI_MAX_RETRIES = "4";
    transcribeMock.mockResolvedValue({ text: "ok" });

    await openaiTranscriptionProvider.transcribe(input);

    expect(openAIMock).toHaveBeenCalledWith({
      apiKey: "test_key",
      timeout: 90000,
      maxRetries: 4
    });
  });

  it("uses json response_format for gpt-4o-transcribe model", async () => {
    const input = {
      ...inputTemplate,
      filePath: tempAudioPath ?? "/tmp/audio.m4a"
    };

    process.env.OPENAI_TRANSCRIBE_MODEL = "openai/gpt-4o-transcribe";
    transcribeMock.mockResolvedValue({ text: "ok" });

    await openaiTranscriptionProvider.transcribe(input);

    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: "json"
      })
    );
    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-4o-transcribe"
      })
    );
  });

  it("uses OpenRouter STT JSON API instead of multipart SDK upload when configured with OpenRouter", async () => {
    const input = {
      ...inputTemplate,
      filePath: tempAudioPath ?? "/tmp/audio.m4a"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "第一句形成关键决策。第二句提出新的增长想法。第三句确认后续待办。",
          usage: { seconds: 90 }
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    process.env.OPENAI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "openrouter_key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENROUTER_HTTP_REFERER = "http://127.0.0.1:3200";
    process.env.OPENROUTER_APP_TITLE = "Founder Daily Brief";
    process.env.OPENAI_TRANSCRIBE_MODEL = "openai/gpt-4o-transcribe";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    transcribeMock.mockResolvedValue({ text: "SDK multipart result" });

    const segments = await openaiTranscriptionProvider.transcribe(input);

    expect(openAIMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer openrouter_key",
          "Content-Type": "application/json",
          "HTTP-Referer": "http://127.0.0.1:3200",
          "X-Title": "Founder Daily Brief"
        })
      })
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      input_audio: { data: string; format: string };
      model: string;
    };
    expect(requestBody).toEqual({
      input_audio: {
        data: Buffer.from("audio-placeholder").toString("base64"),
        format: "m4a"
      },
      model: "openai/gpt-4o-transcribe"
    });
    expect(segments).toEqual([
      expect.objectContaining({
        id: "upload_test_seg_1",
        startSeconds: 0,
        endSeconds: 30,
        text: "第一句形成关键决策。"
      }),
      expect.objectContaining({
        id: "upload_test_seg_2",
        startSeconds: 30,
        endSeconds: 60,
        text: "第二句提出新的增长想法。"
      }),
      expect.objectContaining({
        id: "upload_test_seg_3",
        startSeconds: 60,
        endSeconds: 90,
        text: "第三句确认后续待办。"
      })
    ]);
  });

  it("does not expose OpenRouter HTML error pages in transcription failures", async () => {
    const input = {
      ...inputTemplate,
      filePath: tempAudioPath ?? "/tmp/audio.m4a"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<!DOCTYPE html><html><head><title>openrouter.ai | 502: Bad gateway</title></head><body>Cloudflare error page</body></html>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/html" }
      })
    );

    process.env.OPENAI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "openrouter_key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_TRANSCRIBE_MODEL = "openai/gpt-4o-transcribe";
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await openaiTranscriptionProvider.transcribe(input);
      throw new Error("Expected OpenRouter transcription to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("OpenRouter transcription failed: 502");
      expect(message).toContain("OpenRouter 服务暂时不可用，请稍后重试。");
      expect(message).not.toContain("<!DOCTYPE");
      expect(message).not.toContain("<html");
      expect(message).not.toContain("Cloudflare error page");
    }
  });

  it("uses the OpenRouter key for OpenRouter STT when both default keys are configured", async () => {
    const input = {
      ...inputTemplate,
      filePath: tempAudioPath ?? "/tmp/audio.m4a"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "OpenRouter Key 被正确使用。", usage: { seconds: 20 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    process.env.OPENAI_API_KEY = "default_openai_key";
    process.env.OPENROUTER_API_KEY = "openrouter_key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_TRANSCRIBE_MODEL = "openai/gpt-4o-transcribe";
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await openaiTranscriptionProvider.transcribe(input);

    expect(openAIMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/audio/transcriptions",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer openrouter_key"
        })
      })
    );
  });

  it("uses the locally configured OpenRouter key for OpenRouter STT", async () => {
    const input = {
      ...inputTemplate,
      filePath: tempAudioPath ?? "/tmp/audio.m4a"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "本地配置 Key 生效。", usage: { seconds: 20 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    process.env.OPENAI_API_KEY = "default_openai_key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_TRANSCRIBE_MODEL = "openai/gpt-4o-transcribe";
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({
      openRouterApiKey: "user_openrouter_key",
      openRouterBaseUrl: "https://openrouter.ai/api/v1"
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await openaiTranscriptionProvider.transcribe(input);

    expect(openAIMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/audio/transcriptions",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer user_openrouter_key"
        })
      })
    );
  });

  it("chunks long OpenRouter audio before sending STT requests", async () => {
    const input = {
      uploadId: "upload_long",
      mimeType: "audio/mpeg",
      filePath: tempAudioPath ?? "/tmp/audio.mp3"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "第一段形成关键决策。", usage: { seconds: 60 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "第二段确认后续待办。", usage: { seconds: 60 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    process.env.OPENAI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "openrouter_key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_TRANSCRIBE_MODEL = "openai/gpt-4o-transcribe";
    process.env.OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = "60";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    execFileMock.mockImplementation(
      (command: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (command === "ffprobe") {
          callback(null, "120\n", "");
          return;
        }

        const outputPattern = args.at(-1);
        if (!outputPattern) {
          callback(new Error("missing output pattern"), "", "");
          return;
        }

        void Promise.all([
          writeFile(outputPattern.replace("%05d", "00000"), "chunk-audio-1"),
          writeFile(outputPattern.replace("%05d", "00001"), "chunk-audio-2")
        ])
          .then(() => callback(null, "", ""))
          .catch((error: Error) => callback(error, "", ""));
      }
    );

    const segments = await openaiTranscriptionProvider.transcribe(input);

    expect(execFileMock).toHaveBeenCalledWith("ffprobe", expect.any(Array), expect.any(Function));
    expect(execFileMock).toHaveBeenCalledWith("ffmpeg", expect.any(Array), expect.any(Function));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(segments).toEqual([
      expect.objectContaining({
        id: "upload_long_seg_1",
        startSeconds: 0,
        endSeconds: 60,
        text: "第一段形成关键决策。"
      }),
      expect.objectContaining({
        id: "upload_long_seg_2",
        startSeconds: 60,
        endSeconds: 120,
        text: "第二段确认后续待办。"
      })
    ]);
  });

  it("caps legacy OpenRouter STT chunk config and sends compressed mp3 chunks", async () => {
    if (!tempDir) {
      throw new Error("missing temp dir");
    }

    const wavPath = join(tempDir, "long-audio.wav");
    await writeFile(wavPath, "wav-audio-placeholder");
    const input = {
      uploadId: "upload_wav",
      mimeType: "audio/wav",
      filePath: wavPath
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "第一分钟有内容。", usage: { seconds: 60 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "第二分钟有内容。", usage: { seconds: 60 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    process.env.OPENAI_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "openrouter_key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_TRANSCRIBE_MODEL = "openai/gpt-4o-transcribe";
    process.env.OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = "600";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    execFileMock.mockImplementation(
      (command: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (command === "ffprobe") {
          callback(null, "120\n", "");
          return;
        }

        const outputPattern = args.at(-1);
        if (!outputPattern) {
          callback(new Error("missing output pattern"), "", "");
          return;
        }

        void Promise.all([
          writeFile(outputPattern.replace("%05d", "00000"), "compressed-chunk-1"),
          writeFile(outputPattern.replace("%05d", "00001"), "compressed-chunk-2")
        ])
          .then(() => callback(null, "", ""))
          .catch((error: Error) => callback(error, "", ""));
      }
    );

    await openaiTranscriptionProvider.transcribe(input);

    const ffmpegCall = execFileMock.mock.calls.find(([command]) => command === "ffmpeg");
    expect(ffmpegCall).toBeTruthy();
    const ffmpegArgs = ffmpegCall?.[1] as string[];
    expect(ffmpegArgs[ffmpegArgs.indexOf("-segment_time") + 1]).toBe("60");
    expect(ffmpegArgs).toEqual(expect.arrayContaining(["-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "32k"]));
    expect(ffmpegArgs.at(-1)).toMatch(/chunk_%05d\.mp3$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { input_audio: { format: string } };
    expect(firstBody.input_audio.format).toBe("mp3");
  });
});
