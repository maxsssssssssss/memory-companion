import { describe, expect, it, vi } from "vitest";
import { transcribeAudioFileWithOpenRouter } from "./openrouter-local";

describe("transcribeAudioFileWithOpenRouter", () => {
  it("sends audio directly to OpenRouter with the browser-owned API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "本地直连转写结果。", usage: { seconds: 12 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["audio"], "meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
    });

    const result = await transcribeAudioFileWithOpenRouter({
      file,
      apiKey: "sk-or-user",
      model: "openai/gpt-4o-transcribe"
    });

    expect(result).toEqual({ text: "本地直连转写结果。", durationSeconds: 12 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-or-user",
          "Content-Type": "application/json"
        })
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      input_audio: { data: string; format: string };
      model: string;
    };
    expect(body.model).toBe("openai/gpt-4o-transcribe");
    expect(body.input_audio.format).toBe("mp3");
    expect(body.input_audio.data).toBeTruthy();
  });

  it("includes OpenRouter provider metadata in transcription errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "Provider returned 400",
            code: 400,
            metadata: {
              provider_name: "OpenAI",
              raw: "audio file is too large"
            }
          }
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["audio"], "large-meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
    });

    await expect(
      transcribeAudioFileWithOpenRouter({
        file,
        apiKey: "sk-or-user",
        model: "openai/gpt-4o-transcribe"
      })
    ).rejects.toThrow("Provider returned 400 · code=400 · provider=OpenAI · raw=audio file is too large");
  });

  it("does not expose OpenRouter HTML error pages in browser-owned transcription failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<!DOCTYPE html><html><head><title>openrouter.ai | 502: Bad gateway</title></head><body>Cloudflare error page</body></html>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/html" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["audio"], "meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
    });

    try {
      await transcribeAudioFileWithOpenRouter({
        file,
        apiKey: "sk-or-user",
        model: "openai/gpt-4o-transcribe"
      });
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

  it("splits large mp3 files into multiple browser-side OpenRouter transcription requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "第一段转写。", usage: { seconds: 300 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "第二段转写。", usage: { seconds: 280 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const mp3Bytes = new Uint8Array([
      0x49, 0x44, 0x33, 0, 0, 0, 0xff, 0xfb, 1, 2, 3, 4, 0xff, 0xfb, 5, 6, 7, 8, 0xff, 0xfb, 9, 10
    ]);
    const file = new File([mp3Bytes], "long-meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(mp3Bytes.buffer)
    });

    const result = await transcribeAudioFileWithOpenRouter({
      file,
      apiKey: "sk-or-user",
      model: "openai/gpt-4o-transcribe",
      maxChunkBytes: 12
    });

    expect(result).toEqual({ text: "第一段转写。\n第二段转写。", durationSeconds: 580 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { input_audio: { data: string; format: string } };
    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as { input_audio: { data: string; format: string } };
    expect(firstBody.input_audio.format).toBe("mp3");
    expect(secondBody.input_audio.format).toBe("mp3");
    expect(firstBody.input_audio.data).not.toBe(secondBody.input_audio.data);
  });

  it("uses conservative default chunks for low-bitrate browser-owned mp3 transcription", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ text: "一段转写。", usage: { seconds: 60 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const mp3Bytes = new Uint8Array(500 * 1024);
    for (const offset of [0, 200 * 1024, 400 * 1024]) {
      mp3Bytes[offset] = 0xff;
      mp3Bytes[offset + 1] = 0xfb;
    }
    const file = new File([mp3Bytes], "low-bitrate-long-meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(mp3Bytes.buffer)
    });

    await transcribeAudioFileWithOpenRouter({
      file,
      apiKey: "sk-or-user",
      model: "openai/gpt-4o-transcribe"
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const formats = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse(call[1]?.body as string) as { input_audio: { format: string } };
      return body.input_audio.format;
    });
    expect(formats.every((format) => format === "mp3")).toBe(true);
  });
});
