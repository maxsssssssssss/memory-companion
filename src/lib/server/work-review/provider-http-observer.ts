import { createHash, randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { ClientOptions } from "openai";

type ProviderFetch = NonNullable<ClientOptions["fetch"]>;

export type WorkProviderHttpDiagnostics = {
  requestTraceId: string;
  httpStatus?: number;
  headersMs?: number;
  firstBodyByteMs?: number;
  lastBodyByteMs?: number;
  bodyBytes: number;
  requestIdHash?: string;
  rejectionClass?: "invalid_request" | "authentication" | "permission" | "route_not_found"
    | "request_timeout" | "conflict" | "rate_limited" | "server_error" | "other_http_error";
  failurePhase?: "before_headers" | "before_body" | "during_body" | "after_body";
};

function rejectionClass(status: number): WorkProviderHttpDiagnostics["rejectionClass"] {
  if (status < 400) return undefined;
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "route_not_found";
  if (status === 408) return "request_timeout";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "server_error" : "other_http_error";
}

/** One HTTP observation scope per analysis request; no content leaves this scope. */
export function observeWorkProviderHttp(input: {
  client: OpenAI;
  startedAt: number;
  now: () => number;
}) {
  const diagnostics: WorkProviderHttpDiagnostics = {
    requestTraceId: randomUUID(),
    bodyBytes: 0
  };
  let bodyComplete = false;
  const elapsed = () => Math.max(0, Math.round(input.now() - input.startedAt));
  // The installed SDK stores the configured fetch on this instance. Preserve
  // it (including custom routing) instead of replacing it with global fetch.
  const originalFetch = (input.client as unknown as { fetch: ProviderFetch }).fetch;
  const observedFetch: ProviderFetch = async (url, init) => {
    const response = await originalFetch.call(undefined, url, init);
    diagnostics.httpStatus = response.status;
    diagnostics.headersMs = elapsed();
    const rejected = rejectionClass(response.status);
    if (rejected) diagnostics.rejectionClass = rejected;
    const requestId = response.headers.get("x-request-id");
    if (requestId) diagnostics.requestIdHash = createHash("sha256").update(requestId).digest("hex");
    if (!response.body) {
      bodyComplete = true;
      return response;
    }

    const reader = response.body.getReader();
    const signal = init?.signal;
    let stopped = false;
    let downstream: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const release = () => reader.releaseLock();
    const cancel = async (reason?: unknown) => {
      if (stopped) return;
      stopped = true;
      cleanup();
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    };
    const abort = () => {
      if (stopped) return;
      const error = new DOMException("Work Review provider request aborted", "AbortError");
      downstream.error(error);
      void cancel(error).catch(() => undefined);
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        downstream = controller;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      },
      async pull(controller) {
        try {
          const result = await reader.read();
          if (stopped) return;
          if (result.done) {
            stopped = true;
            bodyComplete = true;
            cleanup();
            release();
            controller.close();
            return;
          }
          if (result.value.byteLength > 0) {
            const receivedAt = elapsed();
            diagnostics.firstBodyByteMs ??= receivedAt;
            diagnostics.lastBodyByteMs = receivedAt;
            diagnostics.bodyBytes = Math.min(
              Number.MAX_SAFE_INTEGER, diagnostics.bodyBytes + result.value.byteLength
            );
          }
          controller.enqueue(result.value);
        } catch (error) {
          if (stopped) return;
          stopped = true;
          cleanup();
          release();
          controller.error(error);
        }
      },
      cancel
    }, { highWaterMark: 0 });
    // A pull-through stream preserves backpressure and cancellation without
    // cloning/buffering a second copy of the Provider response.
    const observedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    for (const property of ["url", "redirected", "type"] as const) {
      Object.defineProperty(observedResponse, property, { value: response[property] });
    }
    return observedResponse;
  };

  return {
    client: input.client.withOptions({ fetch: observedFetch }),
    snapshot(failed = false): WorkProviderHttpDiagnostics {
      return {
        ...diagnostics,
        ...(failed ? {
          failurePhase: diagnostics.headersMs === undefined ? "before_headers" as const
            : bodyComplete ? "after_body" as const
              : diagnostics.firstBodyByteMs === undefined ? "before_body" as const
                : "during_body" as const
        } : {})
      };
    }
  };
}
