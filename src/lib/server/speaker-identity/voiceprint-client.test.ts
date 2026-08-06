import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConfiguredVoiceprintProvider,
  HttpVoiceprintProvider,
  InMemoryVoiceprintProvider,
  VoiceprintCapabilityUnsupportedError,
  VoiceprintProviderError
} from "./voiceprint-client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("HttpVoiceprintProvider", () => {
  it("sends the documented voiceprint train body using the formal audio field", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ code: 0, message: "success" })
    );
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test/",
      fetcher: fetcher as typeof fetch
    });

    await expect(provider.train({
      userId: "user_1",
      requestId: "request_1",
      audio: [
        { url: "https://audio.example.test/current.wav", rule: [[0, 8_000]] },
        { url: "https://audio.example.test/history.wav", rule: [[1_000, 9_000]] }
      ]
    })).resolves.toEqual({ code: 0, message: "success", attemptCount: 1 });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://voiceprint.example.test/api/ai/voiceprint/train");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({
      user_id: "user_1",
      audio: [
        { url: "https://audio.example.test/current.wav", rule: [[0, 8_000]] },
        { url: "https://audio.example.test/history.wav", rule: [[1_000, 9_000]] }
      ],
      req_id: "request_1"
    });
  });

  it("sends the documented voiceprint save body", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ code: 0, message: "success" })
    );
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: fetcher as typeof fetch
    });

    await provider.save({
      userId: "user_1",
      recordId: "record_1",
      speakerId: "speaker_1",
      speakerName: "Partner",
      requestId: "request_2"
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://voiceprint.example.test/api/ai/voiceprint/save");
    expect(JSON.parse(String(init?.body))).toEqual({
      user_id: "user_1",
      record_id: "record_1",
      speaker_id: "speaker_1",
      speaker_name: "Partner",
      req_id: "request_2"
    });
  });

  it("accepts only a numeric provider code of zero", async () => {
    for (const response of [
      jsonResponse({ code: "0", message: "success" }),
      jsonResponse({ code: 2, message: "failed" }),
      jsonResponse({ message: "success" })
    ]) {
      const provider = new HttpVoiceprintProvider({
        baseUrl: "https://voiceprint.example.test",
        fetcher: vi.fn(async () => response) as typeof fetch
      });
      await expect(provider.save({
        userId: "user_1",
        recordId: "record_1",
        speakerId: "partner",
        speakerName: "Partner",
        requestId: "request_2"
      })).rejects.toBeInstanceOf(VoiceprintProviderError);
    }
  });

  it("does not expose an invented standalone identify request", async () => {
    const fetcher = vi.fn();
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: fetcher as typeof fetch
    });

    await expect(provider.identify({
      userId: "user_1",
      recordId: "record_1",
      localSpeakers: ["speaker_0"]
    })).rejects.toBeInstanceOf(VoiceprintCapabilityUnsupportedError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects oversized or invalid training input before fetch", async () => {
    const fetcher = vi.fn();
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: fetcher as typeof fetch
    });

    await expect(provider.train({
      userId: "user_1",
      requestId: "request_1",
      audio: [
        { url: "https://audio.example.test/1.wav", rule: [[0, 1_000]] },
        { url: "https://audio.example.test/2.wav", rule: [[0, 1_000]] },
        { url: "https://audio.example.test/3.wav", rule: [[0, 1_000]] }
      ]
    })).rejects.toMatchObject({ reason: "invalid_request" });
    await expect(provider.train({
      userId: "user_1",
      requestId: "request_many_ranges",
      audio: [{
        url: "https://audio.example.test/1.wav",
        rule: Array.from({ length: 101 }, (_, index) =>
          [index * 10, index * 10 + 5] as [number, number]
        )
      }]
    })).rejects.toMatchObject({ reason: "invalid_request" });
    await expect(provider.train({
      userId: "user_1",
      requestId: "request_fractional_range",
      audio: [{
        url: "https://audio.example.test/1.wav",
        rule: [[0.5, 1_000]]
      }]
    })).rejects.toMatchObject({ reason: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies network and retryable HTTP failures without exposing response bodies", async () => {
    const networkProvider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: vi.fn(async () => { throw new TypeError("private network detail"); }) as typeof fetch,
      maxRetries: 0
    });
    await expect(networkProvider.save({
      userId: "user_1",
      recordId: "record_1",
      speakerId: "partner",
      speakerName: "Partner",
      requestId: "request_network"
    })).rejects.toMatchObject({
      reason: "network_error",
      retryable: true,
      message: "voiceprint provider request failed"
    });

    const rateLimitedProvider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: vi.fn(async () => jsonResponse({ code: 9, message: "private detail" }, 429)) as typeof fetch,
      maxRetries: 0
    });
    await expect(rateLimitedProvider.save({
      userId: "user_1",
      recordId: "record_1",
      speakerId: "partner",
      speakerName: "Partner",
      requestId: "request_rate_limit"
    })).rejects.toMatchObject({
      reason: "http_error",
      status: 429,
      retryable: true,
      attemptCount: 1,
      message: "voiceprint provider request failed"
    });
  });

  it("retries one retryable failure with the same req_id and reports attempt count", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary network detail"))
      .mockResolvedValueOnce(jsonResponse({ code: 0, message: "success" }));
    const sleeper = vi.fn(async () => undefined);
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: fetcher as typeof fetch,
      retryDelayMs: 250,
      sleeper
    });

    await expect(provider.save({
      userId: "user_1",
      recordId: "record_1",
      speakerId: "partner",
      speakerName: "Partner",
      requestId: "request_retry"
    })).resolves.toEqual({
      code: 0,
      message: "success",
      attemptCount: 2
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleeper).toHaveBeenCalledOnce();
    expect(sleeper).toHaveBeenCalledWith(250);
    const requestBodies = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as Record<string, unknown>
    );
    expect(requestBodies.map((body) => body.req_id)).toEqual([
      "request_retry",
      "request_retry"
    ]);
    expect(requestBodies[1]).toEqual(requestBodies[0]);
  });

  it("honors bounded Retry-After without exceeding the retry limit", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ code: 9, message: "private detail" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "120"
          }
        }
      ))
      .mockResolvedValueOnce(jsonResponse({ code: 0, message: "success" }));
    const sleeper = vi.fn(async () => undefined);
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: fetcher as typeof fetch,
      retryDelayMs: 100,
      sleeper
    });

    await expect(provider.save({
      userId: "user_1",
      recordId: "record_1",
      speakerId: "partner",
      speakerName: "Partner",
      requestId: "request_retry_after"
    })).resolves.toMatchObject({ attemptCount: 2 });
    expect(sleeper).toHaveBeenCalledWith(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry provider rejection or malformed successful responses", async () => {
    for (const response of [
      jsonResponse({ code: 7, message: "private rejection" }),
      new Response("not-json", { status: 200 }),
      jsonResponse(null),
      jsonResponse([]),
      jsonResponse({ code: "0", message: "success" }),
      jsonResponse({ code: 0, message: { private: "value" } })
    ]) {
      const fetcher = vi.fn(async () => response);
      const sleeper = vi.fn(async () => undefined);
      const provider = new HttpVoiceprintProvider({
        baseUrl: "https://voiceprint.example.test",
        fetcher: fetcher as typeof fetch,
        sleeper
      });

      await expect(provider.save({
        userId: "user_1",
        recordId: "record_1",
        speakerId: "partner",
        speakerName: "Partner",
        requestId: "request_non_retryable"
      })).rejects.toMatchObject({
        retryable: false,
        attemptCount: 1
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(sleeper).not.toHaveBeenCalled();
    }
  });

  it.each([
    { status: 400, retryable: false },
    { status: 408, retryable: true },
    { status: 429, retryable: true },
    { status: 500, retryable: true }
  ])(
    "classifies HTTP $status retryable=$retryable without reading private details into errors",
    async ({ status, retryable }) => {
      const provider = new HttpVoiceprintProvider({
        baseUrl: "https://voiceprint.example.test",
        fetcher: vi.fn(async () =>
          new Response("PRIVATE_PROVIDER_BODY", { status })
        ) as typeof fetch,
        maxRetries: 0
      });

      await expect(provider.save({
        userId: "user_1",
        recordId: "record_1",
        speakerId: "partner",
        speakerName: "Partner",
        requestId: `request_http_${status}`
      })).rejects.toMatchObject({
        reason: "http_error",
        status,
        retryable,
        attemptCount: 1,
        message: "voiceprint provider request failed"
      });
    }
  );

  it("applies the deadline to a response body that never completes", async () => {
    vi.useFakeTimers();
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: vi.fn(async () =>
        new Response(new ReadableStream<Uint8Array>({
          start() {
            // Intentionally leave the body open to exercise the full deadline.
          }
        }), { status: 200 })
      ) as typeof fetch,
      timeoutMs: 1_000,
      maxRetries: 0
    });

    const request = provider.save({
      userId: "user_1",
      recordId: "record_1",
      speakerId: "partner",
      speakerName: "Partner",
      requestId: "request_stalled_body"
    });
    const assertion = expect(request).rejects.toMatchObject({
      reason: "timeout",
      retryable: true,
      attemptCount: 1
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("rejects an oversized response without retaining its content", async () => {
    const privateBody = JSON.stringify({
      code: 0,
      message: `PRIVATE_${"x".repeat(2_000)}`
    });
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: vi.fn(async () => new Response(privateBody, { status: 200 })) as typeof fetch,
      maxRetries: 0,
      maxResponseBytes: 1_024
    });

    await expect(provider.save({
      userId: "user_1",
      recordId: "record_1",
      speakerId: "partner",
      speakerName: "Partner",
      requestId: "request_oversized_response"
    })).rejects.toMatchObject({
      reason: "invalid_response",
      retryable: false,
      attemptCount: 1,
      message: "voiceprint provider response exceeded the size limit"
    });
  });

  it("uses the dedicated base URL override and otherwise reuses speaker ASR configuration", () => {
    vi.stubEnv("VOICEPRINT_BASE_URL", "");
    vi.stubEnv("SPEAKER_ASR_BASE_URL", "https://speaker.example.test");
    expect(createConfiguredVoiceprintProvider()).toBeInstanceOf(HttpVoiceprintProvider);

    vi.stubEnv("VOICEPRINT_BASE_URL", "https://voiceprint.example.test");
    expect(createConfiguredVoiceprintProvider()).toBeInstanceOf(HttpVoiceprintProvider);
  });

});

describe("InMemoryVoiceprintProvider", () => {
  it("records deterministic mock calls and returns configured identifications", async () => {
    const provider = new InMemoryVoiceprintProvider([{
      localSpeaker: "speaker_1",
      globalSpeakerId: "person_partner",
      displayName: "Partner",
      confidence: 0.96
    }]);

    await provider.train({
      userId: "user_1",
      requestId: "request_1",
      audio: [{ url: "https://audio.example.test/a.wav", rule: [[0, 1_000]] }]
    });
    await provider.save({
      userId: "user_1",
      recordId: "record_1",
      speakerId: "partner",
      speakerName: "Partner",
      requestId: "request_2"
    });

    await expect(provider.identify({
      userId: "user_1",
      recordId: "record_1",
      localSpeakers: ["speaker_1"]
    })).resolves.toEqual([expect.objectContaining({ globalSpeakerId: "person_partner" })]);
    expect(provider.trainCalls).toHaveLength(1);
    expect(provider.saveCalls).toHaveLength(1);
  });
});
