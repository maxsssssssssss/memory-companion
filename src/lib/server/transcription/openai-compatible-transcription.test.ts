// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleTranscriptionError,
  normalizeOpenAITranscriptionUrl,
  requestOpenAICompatibleTranscription,
  safeOpenAITranscriptionErrorLog
} from "./openai-compatible-transcription";

describe("OpenAI-compatible transcription HTTP contract", () => {
  let tempDir: string;
  let audioPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openai-transcription-contract-"));
    audioPath = join(tempDir, "recording.webm");
    await writeFile(audioPath, Buffer.from("webm-audio-bytes"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function requestInput(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
    return {
      filePath: audioPath,
      mimeType: "audio/webm;codecs=opus",
      apiKey: "contract_test_key",
      model: "gpt-4o-transcribe-diarize",
      responseFormat: "diarized_json" as const,
      chunkingStrategy: "auto" as const,
      timeoutMs: 1_000,
      maxRetries: 0,
      fetchImpl,
      ...overrides
    };
  }

  it.each([
    [undefined, "https://api.openai.com/v1/audio/transcriptions"],
    ["https://stt.example", "https://stt.example/v1/audio/transcriptions"],
    ["https://stt.example/", "https://stt.example/v1/audio/transcriptions"],
    ["https://stt.example/v1", "https://stt.example/v1/audio/transcriptions"],
    ["https://stt.example/v1/", "https://stt.example/v1/audio/transcriptions"],
    ["https://stt.example/v1/audio/transcriptions", "https://stt.example/v1/audio/transcriptions"],
    ["https://stt.example/v1/v1", "https://stt.example/v1/audio/transcriptions"],
    ["https://stt.example/v1/v1/audio/transcriptions", "https://stt.example/v1/audio/transcriptions"]
  ])("normalizes transcription base %s", (baseUrl, expected) => {
    expect(normalizeOpenAITranscriptionUrl(baseUrl)).toBe(expected);
  });

  it.each([
    "ftp://stt.example/v1",
    "file:///tmp/stt",
    "https://user:password@stt.example/v1",
    "https://stt.example/v1?api_key=secret",
    "https://stt.example/v1#fragment",
    "not a url"
  ])("rejects unsafe transcription base %s", (baseUrl) => {
    expect(() => normalizeOpenAITranscriptionUrl(baseUrl)).toThrowError(
      expect.objectContaining({ code: "provider_config_error" })
    );
  });

  it("sends exact POST multipart fields while FormData owns the boundary", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://stt.example/v1/audio/transcriptions");
      expect(request.headers.get("authorization")).toBe("Bearer contract_test_key");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();

      const form = await request.formData();
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("recording.webm");
      expect((file as File).type).toBe("audio/webm;codecs=opus");
      expect(Buffer.from(await (file as File).arrayBuffer())).toEqual(Buffer.from("webm-audio-bytes"));
      expect(form.get("model")).toBe("gpt-4o-transcribe-diarize");
      expect(form.get("language")).toBe("zh");
      expect(form.get("response_format")).toBe("diarized_json");
      expect(form.get("chunking_strategy")).toBe("auto");
      expect([...form.keys()].sort()).toEqual([
        "chunking_strategy",
        "file",
        "language",
        "model",
        "response_format"
      ]);

      return new Response(JSON.stringify({ text: "测试内容" }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    });

    const result = await requestOpenAICompatibleTranscription(
      requestInput(fetchMock as unknown as typeof fetch, {
        baseUrl: "https://stt.example/v1/",
        language: "zh"
      })
    );

    expect(result).toEqual({ text: "测试内容" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports explicitly configured raw Authorization without query credentials", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      expect(request.headers.get("authorization")).toBe("contract_test_key");
      expect(new URL(request.url).search).toBe("");
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    await requestOpenAICompatibleTranscription(
      requestInput(fetchMock as unknown as typeof fetch, { authHeaderMode: "raw" })
    );
  });

  it("accepts verified diarized JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "先计划，后完成。",
          segments: [
            { start: 0, end: 2.5, text: "先计划", speaker: "speaker_1" },
            { start: 2.5, end: 5, text: "后完成", speaker: "speaker_2" }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      requestOpenAICompatibleTranscription(requestInput(fetchMock as unknown as typeof fetch))
    ).resolves.toEqual({
      text: "先计划，后完成。",
      segments: [
        { start: 0, end: 2.5, text: "先计划", speaker: "speaker_1" },
        { start: 2.5, end: 5, text: "后完成", speaker: "speaker_2" }
      ]
    });
  });

  it.each([
    ["empty text", { text: "" }, "provider_empty_transcript"],
    ["whitespace text", { text: "   " }, "provider_empty_transcript"],
    ["empty segments", { text: "not accepted", segments: [] }, "provider_empty_transcript"],
    ["missing text", { segments: [{ start: 0, end: 1, text: "x" }] }, "provider_response_schema_error"],
    ["unknown JSON", { transcript: "unverified" }, "provider_response_schema_error"],
    ["nested text", { data: { text: "unverified" } }, "provider_response_schema_error"],
    ["invalid segment", { text: "x", segments: [{ start: 1, end: 0, text: "x" }] }, "provider_response_schema_error"]
  ])("rejects %s", async (_label, payload, code) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(
      requestOpenAICompatibleTranscription(requestInput(fetchMock as unknown as typeof fetch))
    ).rejects.toMatchObject({ code });
  });

  it.each([
    ["text/plain", "plain transcript"],
    ["text/html", "<!doctype html><html>gateway</html>"]
  ])("rejects successful %s responses", async (contentType, body) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { "Content-Type": contentType } })
    );
    await expect(
      requestOpenAICompatibleTranscription(requestInput(fetchMock as unknown as typeof fetch))
    ).rejects.toMatchObject({ code: "provider_response_schema_error" });
  });

  it("rejects malformed successful JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{malformed", { status: 200, headers: { "Content-Type": "application/json" } })
    );
    await expect(
      requestOpenAICompatibleTranscription(requestInput(fetchMock as unknown as typeof fetch))
    ).rejects.toMatchObject({ code: "provider_response_schema_error" });
  });

  it.each([
    [401, "provider_auth_error"],
    [403, "provider_auth_error"],
    [404, "provider_not_found"],
    [415, "provider_unsupported_audio"],
    [400, "provider_invalid_request"],
    [422, "provider_invalid_request"],
    [429, "provider_http_error"],
    [500, "provider_http_error"]
  ])("maps HTTP %i to %s", async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "provider_error", code: "request_failed" } }), {
        status,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(
      requestOpenAICompatibleTranscription(requestInput(fetchMock as unknown as typeof fetch))
    ).rejects.toMatchObject({
      code,
      metadata: { status }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed non-2xx JSON in the HTTP error taxonomy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{malformed", { status: 401, headers: { "Content-Type": "application/json" } })
    );
    await expect(
      requestOpenAICompatibleTranscription(requestInput(fetchMock as unknown as typeof fetch))
    ).rejects.toMatchObject({ code: "provider_auth_error", metadata: { status: 401 } });
  });

  it("classifies an aborted request as timeout", async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    await expect(
      requestOpenAICompatibleTranscription(
        requestInput(fetchMock as unknown as typeof fetch, { timeoutMs: 1 })
      )
    ).rejects.toMatchObject({ code: "provider_timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies fetch failure as network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network failed with secret transcript"));
    await expect(
      requestOpenAICompatibleTranscription(requestInput(fetchMock as unknown as typeof fetch))
    ).rejects.toMatchObject({ code: "provider_network_error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors explicitly configured retries without hidden extra attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("temporary", { status: 500, headers: { "Content-Type": "text/plain" } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "recovered" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    await expect(
      requestOpenAICompatibleTranscription(
        requestInput(fetchMock as unknown as typeof fetch, { maxRetries: 1 })
      )
    ).resolves.toEqual({ text: "recovered" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never stores or logs response bodies, keys, transcript text, query strings, or full URLs", async () => {
    const secret = "super_secret_transcript_and_key";
    const tokenLikeProviderCode = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: tokenLikeProviderCode,
            code: tokenLikeProviderCode,
            message: `${secret} https://internal.example/path?api_key=${secret}`
          },
          transcript: secret
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    );

    let caught: unknown;
    try {
      await requestOpenAICompatibleTranscription(requestInput(fetchMock as unknown as typeof fetch));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenAICompatibleTranscriptionError);
    const error = caught as OpenAICompatibleTranscriptionError;
    const serialized = JSON.stringify(error);
    const logLine = safeOpenAITranscriptionErrorLog(error);
    expect(serialized).not.toContain(secret);
    expect(logLine).not.toContain(secret);
    expect(serialized).not.toContain(tokenLikeProviderCode);
    expect(logLine).not.toContain(tokenLikeProviderCode);
    expect(logLine).not.toContain("https://");
    expect(logLine).not.toContain("api_key");
    expect(Buffer.byteLength(logLine, "utf8")).toBeLessThanOrEqual(2_048);
    expect(logLine).toContain("path=/v1/audio/transcriptions");
  });

  it("fails before I/O when credentials or bounded request config are invalid", async () => {
    const fetchMock = vi.fn();
    await expect(
      requestOpenAICompatibleTranscription(
        requestInput(fetchMock as unknown as typeof fetch, { apiKey: "" })
      )
    ).rejects.toMatchObject({ code: "provider_config_error" });
    await expect(
      requestOpenAICompatibleTranscription(
        requestInput(fetchMock as unknown as typeof fetch, { timeoutMs: 0 })
      )
    ).rejects.toMatchObject({ code: "provider_config_error" });
    await expect(
      requestOpenAICompatibleTranscription(
        requestInput(fetchMock as unknown as typeof fetch, { maxRetries: 11 })
      )
    ).rejects.toMatchObject({ code: "provider_config_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
