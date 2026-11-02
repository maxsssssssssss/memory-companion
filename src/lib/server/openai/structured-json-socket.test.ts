// @vitest-environment node
import { createServer } from "node:http";
import OpenAI from "openai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { parseStructuredJsonResponse, type StructuredJsonDiagnostics } from "./structured-json";

// Real loopback sockets and native fetch, no Provider, credentials or product data.
describe("structured JSON with actual socket interruption", { timeout: 5000 }, () => {
  it.each(["disconnect", "timeout", "cancel", "complete_without_eof"] as const)("handles %s through native fetch and SDK cleanup", async mode => {
    let requests = 0, diagnostics: StructuredJsonDiagnostics | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const parent = new AbortController();
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      if (mode === "complete_without_eof") {
        res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", error: null, incomplete_details: null,
          usage: { input_tokens: 13, output_tokens: 8 }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}' }] }] } })}\n\n`);
      } else {
        res.write('data: {"type":"response.output_text.delta","delta":"PRIVATE_PARTIAL"}\n\n');
        if (mode === "disconnect") timer = setTimeout(() => res.destroy(), 40);
        if (mode === "cancel") timer = setTimeout(() => parent.abort(), 40);
        if (mode === "timeout") timer = setTimeout(() => parent.abort(new DOMException("deadline", "TimeoutError")), 40);
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("loopback bind failed");
    try {
      const client = new OpenAI({ apiKey: "offline", baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 });
      const result = parseStructuredJsonResponse({ client, model: "offline", schema: z.object({ ok: z.boolean() }), name: "offline", mode: "json", stream: true,
        requestInput: "synthetic", jsonInstruction: "JSON", requestOptions: { maxRetries: 0, signal: parent.signal },
        streamLimits: { maxEventBytes: 200_000, maxDeltaBytes: 200_000, maxTotalBytes: 800_000 }, onDiagnostics: d => { diagnostics = d; } });
      if (mode === "complete_without_eof") {
        await expect(result).resolves.toEqual({ ok: true });
        expect(diagnostics).toMatchObject({ parseResult: "success", inputTokens: 13, outputTokens: 8, stream: { phase: "complete", completionReceived: true } });
      } else {
        await expect(result).rejects.toThrow();
        expect(diagnostics).toMatchObject({ parseResult: "not_started", validationResult: "not_started", stream: {
          phase: "events", completionReceived: false, failureReason: mode === "disconnect" ? "transport_error" : mode === "timeout" ? "timeout" : "aborted" } });
        expect(diagnostics?.stream?.eventCount).toBe(1);
      }
      expect(requests).toBe(1); expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE");
    } finally {
      clearTimeout(timer); parent.abort(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
