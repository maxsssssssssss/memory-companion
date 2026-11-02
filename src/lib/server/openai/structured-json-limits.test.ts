// @vitest-environment node
import OpenAI from "openai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { parseStructuredJsonResponse, type StructuredJsonDiagnostics } from "./structured-json";
import { responseStreamFixture } from "./structured-json-stream.test-fixture";

const schema = z.object({ text: z.string() }).strict();
const completed = (text = "合成".repeat(1600)) => ({ status: "completed", error: null, incomplete_details: null,
  output: [{ id: "msg_synthetic_0000000000000000000000", type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ text }) }] }],
  usage: { input_tokens: 6102, output_tokens: 1365, total_tokens: 7467 } });
const input = { model: "offline", name: "offline", schema, mode: "json" as const, stream: true, requestInput: "synthetic", jsonInstruction: "JSON" };
function sdk(body: string) {
  const fetch = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  return { fetch, client: new OpenAI({ apiKey: "offline", baseURL: "https://offline.invalid/v1", fetch }) };
}
describe("bounded JSON stream accounting through the real SDK decoder", () => {
  it("accepts the same bounded answer independently of delta fragmentation and repeated done snapshots", async () => {
    const response = completed(), fragmented = responseStreamFixture(response, 2);
    expect(fragmented.eventBytes).toBeGreaterThan(200_000);
    expect(fragmented.responseBytes).toBeLessThan(20_000);
    for (const fragmentChars of [100_000, 2]) {
      const { client, fetch } = sdk(responseStreamFixture(response, fragmentChars).body);
      const onDiagnostics = vi.fn<(value: StructuredJsonDiagnostics) => void>();
      // Keep each event and all generated deltas bounded separately from protocol repetition.
      const limits = { streamLimits: { maxEventBytes: 200_000, maxDeltaBytes: 200_000, maxTotalBytes: 800_000 } };
      await expect(parseStructuredJsonResponse({ ...input, client, ...limits, onDiagnostics })).resolves.toEqual({ text: "合成".repeat(1600) });
      expect(fetch).toHaveBeenCalledOnce();
      expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 6102, outputTokens: 1365, parseResult: "success",
        stream: expect.objectContaining({ phase: "complete", completionReceived: true }) }));
    }
  });
  it("preserves existing callers' legacy aggregate limit", async () => {
    const { client, fetch } = sdk(responseStreamFixture(completed(), 2).body);
    const onDiagnostics = vi.fn();
    await expect(parseStructuredJsonResponse({ ...input, client, maxResponseBytes: 200_000, onDiagnostics })).rejects.toMatchObject({ code: "incomplete_response" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ parseResult: "not_started" }));
  });
  it.each([
    ["event", { maxEventBytes: 100, maxDeltaBytes: 200_000, maxTotalBytes: 800_000 }],
    ["delta", { maxEventBytes: 200_000, maxDeltaBytes: 100, maxTotalBytes: 800_000 }],
    ["total", { maxEventBytes: 200_000, maxDeltaBytes: 200_000, maxTotalBytes: 1000 }]
  ] as const)("enforces the independent %s limit without parsing partial output", async (limitKind, streamLimits) => {
    const { client, fetch } = sdk(responseStreamFixture(completed(), 2).body), onDiagnostics = vi.fn();
    await expect(parseStructuredJsonResponse({ ...input, client, streamLimits, onDiagnostics })).rejects.toMatchObject({ code: "incomplete_response" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ parseResult: "not_started", validationResult: "not_started",
      stream: expect.objectContaining({ completionReceived: false, failureReason: "byte_limit", limitKind }) }));
  });
  it("rejects invalid limits before dispatch", async () => {
    const { client, fetch } = sdk("");
    await expect(parseStructuredJsonResponse({ ...input, client, streamLimits: { maxEventBytes: NaN, maxDeltaBytes: 20, maxTotalBytes: 20 } })).rejects.toThrow("stream limits");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["malformed", "unsupported", "eof"])("diagnoses %s without exposing any event body", async kind => {
    const body = kind === "malformed" ? "data: PRIVATE_SSE_BODY\n\n" : kind === "unsupported"
      ? "event: PRIVATE_EVENT\ndata: PRIVATE_SSE_BODY\n\n" : 'data: {"type":"response.output_text.delta","delta":"PRIVATE_SSE_BODY"}\n\n';
    const { client, fetch } = sdk(body), onDiagnostics = vi.fn();
    await expect(parseStructuredJsonResponse({ ...input, client, onDiagnostics })).rejects.toMatchObject({ code: "incomplete_response" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ stream: expect.objectContaining({
      failureReason: kind === "malformed" ? "invalid_event" : kind === "unsupported" ? "unsupported_event" : "missing_completion" }) }));
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("PRIVATE");
  });
});
