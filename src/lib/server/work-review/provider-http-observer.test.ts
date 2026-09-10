// @vitest-environment node
import { createHash } from "node:crypto";
import OpenAI, { type ClientOptions } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkStructuredJsonRequest, WorkExtractorWireEnvelopeSchema } from "./analysis-provider";
import { observeWorkProviderHttp, type WorkProviderHttpDiagnostics } from "./provider-http-observer";
import type { WorkReviewAnalysisProviderProfile } from "./runtime-config";

type ProviderFetch = NonNullable<ClientOptions["fetch"]>;
const encoder = new TextEncoder();
const profile: WorkReviewAnalysisProviderProfile = {
  profileId: "work-meeting-extractor",
  provider: "openai-compatible-structured-json",
  model: "test-model",
  reasoningEffort: "provider_default",
  timeoutMs: 100,
  maxOutputTokens: 4_000,
  promptVersion: "test-prompt",
  schemaVersion: "test-schema"
};
const wireResponse = `data: ${JSON.stringify({ type: "response.completed", response: {
  status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text: '{"items":[]}' }] }]
} })}\n\n`;

function client(fetch: ProviderFetch) {
  return new OpenAI({
    apiKey: "PRIVATE_API_KEY",
    baseURL: "https://private-route.example/v1",
    fetch,
    maxRetries: 0,
    logLevel: "off"
  });
}

function harness(fetch: ProviderFetch, now = Date.now) {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const createClient = vi.fn(() => client(fetch));
  const request = createWorkStructuredJsonRequest({
    getRuntimeConfig: async () => ({}),
    createClient,
    now,
    log: (event, fields) => logs.push({ event, fields })
  });
  return {
    logs,
    createClient,
    run(signal?: AbortSignal) {
      return request({
        stage: "extractor",
        profile,
        name: "test-schema",
        schema: WorkExtractorWireEnvelopeSchema,
        requestInput: "PRIVATE_TRANSCRIPT",
        jsonInstruction: "return JSON",
        signal
      });
    },
    finished() {
      const entries = logs.filter(({ event }) => event === "request_finished");
      expect(entries).toHaveLength(1);
      return entries[0]!.fields as {
        state: string;
        requestTraceId: string;
        diagnostics: { http: WorkProviderHttpDiagnostics };
      };
    }
  };
}

function stalledBody(prefix?: string) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) controller.enqueue(encoder.encode(prefix));
    },
    cancel
  });
  return { body, cancel };
}

afterEach(() => vi.useRealTimers());

describe("Work Review HTTP observation", () => {
  it("preserves the original SDK fetch and request while measuring streamed body bytes safely", async () => {
    let clock = 1_000;
    const chunks = [wireResponse.slice(0, 14), wireResponse.slice(14)];
    const requestId = "PRIVATE_REMOTE_REQUEST_ID";
    const fetch = vi.fn<ProviderFetch>(async () => {
      clock = 1_010;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) return controller.close();
          clock += 5;
          controller.enqueue(encoder.encode(chunk));
        }
      }, { highWaterMark: 0 }), {
        headers: { "content-type": "text/event-stream", "x-request-id": requestId,
          "x-private-header": "PRIVATE_HEADER" }
      });
    });
    const test = harness(fetch, () => clock);
    await expect(test.run()).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(test.createClient).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, timeoutMs: 100 }));
    const init = fetch.mock.calls[0]![1]!;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: profile.model, max_output_tokens: 4_000 });
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("reasoning");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer PRIVATE_API_KEY");
    const finished = test.finished();
    expect(finished.state).toBe("completed");
    expect(finished.diagnostics.http).toEqual({
      requestTraceId: finished.requestTraceId,
      httpStatus: 200,
      headersMs: 10,
      firstBodyByteMs: 15,
      lastBodyByteMs: 20,
      bodyBytes: encoder.encode(wireResponse).byteLength,
      requestIdHash: createHash("sha256").update(requestId).digest("hex")
    });
    expect(test.logs[0]!.fields.requestTraceId).toBe(finished.requestTraceId);
    for (const secret of ["PRIVATE_API_KEY", "PRIVATE_TRANSCRIPT", requestId, "PRIVATE_HEADER",
      "private-route.example", wireResponse]) {
      expect(JSON.stringify(test.logs)).not.toContain(secret);
    }
  });

  it("records pre-header timeout without retrying or leaking the abort cause", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<ProviderFetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("PRIVATE_ABORT", "AbortError")));
    }));
    const test = harness(fetch);
    const result = test.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ code: "work_analysis_provider_timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(test.finished().diagnostics.http).toMatchObject({ bodyBytes: 0, failurePhase: "before_headers" });
    expect(test.finished().diagnostics.http).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(test.logs)).not.toContain("PRIVATE_ABORT");
  });

  it.each([
    [undefined, "before_body"],
    ['{"status":', "during_body"]
  ] as const)("records body timeout after headers with prefix %s and cancels the original reader", async (prefix, phase) => {
    vi.useFakeTimers();
    const stalled = stalledBody(prefix);
    const fetch = vi.fn<ProviderFetch>(async () => new Response(stalled.body, {
      headers: { "content-type": "application/json" }
    }));
    const test = harness(fetch);
    const result = test.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ code: "work_analysis_provider_timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(test.finished().diagnostics.http).toMatchObject({
      httpStatus: 200,
      failurePhase: phase,
      bodyBytes: prefix ? encoder.encode(prefix).byteLength : 0
    });
  });

  it.each([[400, "invalid_request"], [401, "authentication"], [404, "route_not_found"], [429, "rate_limited"],
    [503, "server_error"]] as const)("records rejection %s without retaining the error body", async (status, category) => {
    const fetch = vi.fn<ProviderFetch>(async () => new Response(JSON.stringify({
      error: { message: "PRIVATE_ERROR_BODY", code: "PRIVATE_ERROR_CODE" }
    }), { status, headers: { "content-type": "application/json", "x-request-id": "PRIVATE_REQUEST_ID" } }));
    const test = harness(fetch);
    await test.run().catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(test.finished().diagnostics.http).toMatchObject({
      httpStatus: status, rejectionClass: category, failurePhase: "after_body"
    });
    expect(JSON.stringify(test.logs)).not.toMatch(/PRIVATE_|private-route/u);
  });

  it("retains the HTTP rejection class when the rejection body itself times out", async () => {
    vi.useFakeTimers();
    const stalled = stalledBody();
    const fetch = vi.fn<ProviderFetch>(async () => new Response(stalled.body, { status: 400 }));
    const test = harness(fetch);
    const result = test.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ code: "work_analysis_provider_timeout" });
    expect(test.finished().diagnostics.http).toMatchObject({
      httpStatus: 400, rejectionClass: "invalid_request", failurePhase: "before_body", bodyBytes: 0
    });
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
  });

  it("logs exactly one cancelled finish for parent abort and cancels the original body", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const stalled = stalledBody("partial");
    const fetch = vi.fn<ProviderFetch>(async () => new Response(stalled.body));
    const test = harness(fetch);
    const result = test.run(parent.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    parent.abort(new Error("PRIVATE_PARENT_ABORT"));
    await result;
    expect(test.finished()).toMatchObject({ state: "cancelled", diagnostics: {
      http: { httpStatus: 200, failurePhase: "during_body", bodyBytes: 7 }
    } });
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(test.logs)).not.toContain("PRIVATE_PARENT_ABORT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start HTTP for an already aborted parent and still records a cancelled finish", async () => {
    const parent = new AbortController();
    parent.abort(new Error("PRIVATE_EARLY_ABORT"));
    const fetch = vi.fn<ProviderFetch>();
    const test = harness(fetch);
    await expect(test.run(parent.signal)).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(test.finished()).toMatchObject({ state: "cancelled", diagnostics: {
      http: { bodyBytes: 0, failurePhase: "before_headers" }
    } });
    expect(JSON.stringify(test.logs)).not.toContain("PRIVATE_EARLY_ABORT");
  });

  it("does not pre-read or clone the body and propagates consumer cancellation", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(encoder.encode("next chunk"));
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }));
    const clone = vi.spyOn(response, "clone");
    const observed = observeWorkProviderHttp({ client: client(async () => response), now: Date.now, startedAt: Date.now() });
    const raw = await observed.client.responses.create({ model: "test", input: "test" }).asResponse();
    expect(pull).not.toHaveBeenCalled();
    const reader = raw.body!.getReader();
    await reader.read();
    expect(pull).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(clone).not.toHaveBeenCalled();
    expect(observed.snapshot().bodyBytes).toBe(10);
  });

  it("keeps concurrent observations independent even when they share a base client", async () => {
    const responseBodies = ["first", "second is longer"];
    const fetch = vi.fn<ProviderFetch>(async () => new Response(responseBodies.shift()));
    const baseClient = client(fetch);
    const first = observeWorkProviderHttp({ client: baseClient, startedAt: Date.now(), now: Date.now });
    const second = observeWorkProviderHttp({ client: baseClient, startedAt: Date.now(), now: Date.now });
    const responses = await Promise.all([first, second].map((observer) => observer.client.responses.create({
      model: "test", input: "test"
    }).asResponse()));
    await Promise.all(responses.map((response) => response.text()));
    expect(first.snapshot().bodyBytes).toBe(5);
    expect(second.snapshot().bodyBytes).toBe(16);
    expect(first.snapshot().requestTraceId).not.toBe(second.snapshot().requestTraceId);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
