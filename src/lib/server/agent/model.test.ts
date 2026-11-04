// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTask } from "@/lib/domain/agent";
import { createAgentDecisionProvider } from "./model";
import type { AgentContext, AgentDecisionInput } from "./types";

afterEach(() => vi.unstubAllGlobals());

function fixture(responseValue: unknown, eventType = "response.completed", options: {
  defaultHeaders?: Record<string, string>; status?: number; wire?: (event: unknown) => BodyInit;
} = {}) {
  // Capture the actual SDK request at fetch; no socket or Provider is involved.
  const requests: Array<{ input: Array<{ role: string; content: string }> }> = [];
  const requestHeaders: Headers[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://synthetic-provider.invalid/v1/responses");
    requests.push(await request.json());
    requestHeaders.push(request.headers);
    if (options.status) return new Response('{"error":{"message":"synthetic server failure"}}', {
      status: options.status, headers: { "content-type": "application/json" }
    });
    const event = { type: eventType, response: {
      status: "completed", error: null, incomplete_details: null,
      usage: { input_tokens: 9, output_tokens: 4 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(responseValue) }] }]
    } };
    return new Response(options.wire?.(event) ?? `data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  const task: AgentTask = {
    id: "synthetic-task", accountId: "synthetic-account", scenario: "synthetic-review", resourceId: "record",
    goal: "Review the authorized synthetic record", scope: { recordId: "allowed" }, status: "running", actions: [],
    usage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0, computeMs: 0, steps: 0 },
    budget: { maxCalls: 4, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 120000, maxSteps: 4, maxNoProgress: 2 },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };
  const input: AgentDecisionInput = { task, observation: { available: true }, results: [], tools: [{
    name: "synthetic.read", description: "Read the authorized synthetic record", parameters: z.object({ id: z.literal("allowed") }).strict()
  }] };
  const call = vi.fn();
  const ctx: AgentContext = { task, actionId: "decision:1", signal: new AbortController().signal, assertActive: async () => {},
    call: async (request, invoke) => { call(request); return (await invoke()).value; } };
  const decide = createAgentDecisionProvider(() => ({ baseURL: "https://synthetic-provider.invalid/v1", apiKey: "synthetic-key",
    defaultHeaders: options.defaultHeaders,
    model: "synthetic-model", maxInputChars: 48000, maxOutputTokens: 1000, requestTimeoutMs: 1000 }));
  return { invoke: () => decide(input, ctx), requests, requestHeaders, fetch, call };
}

describe("Agent structured action request contract", () => {
  it("bounds answer bytes separately from token-sized SSE protocol overhead", async () => {
    const action = { tool: "synthetic.read", args: { id: "allowed", note: "synthetic comparison detail ".repeat(100) } };
    const h = fixture(action, "response.completed", { wire: event => {
      const deltas = [...JSON.stringify(action)].map((delta, sequence_number) => ({ type: "response.output_text.delta",
        sequence_number, item_id: "synthetic_assistant_message", output_index: 0, content_index: 0, delta }));
      const body = [...deltas, event].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
      expect(Buffer.byteLength(body)).toBeGreaterThan(200_000);
      expect(Buffer.byteLength(JSON.stringify(action))).toBeLessThan(200_000);
      return body;
    } });
    await expect(h.invoke()).resolves.toEqual(action);
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.call).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "unterminated completion frame", wire: (event: unknown) => `data: ${JSON.stringify(event)}`,
      phase: "events", failureReason: "missing_completion", completionReceived: false },
    { name: "missing completion", wire: () => 'data: {"type":"response.output_text.delta","delta":"private_partial"}\n\n',
      phase: "events", failureReason: "missing_completion", completionReceived: false },
    { name: "invalid completion", wire: () => 'data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n',
      phase: "events", failureReason: "invalid_event", completionReceived: false },
    { name: "cleanup failure", wire: (event: unknown) => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
      cancel() { throw new Error("PRIVATE_CLEANUP_MUST_NOT_PERSIST"); },
    }), phase: "cleanup", failureReason: "cleanup_error", completionReceived: true },
  ])("keeps $name unknown with safe pre-parse stream evidence and no retry", async ({ wire, phase, failureReason, completionReceived }) => {
    const h = fixture({ finish: "Synthetic reply" }, "response.completed", { wire });
    let failure: unknown;
    try { await h.invoke(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "unknown", decisionDiagnostic: {
      layer: "response", reasonCode: "response_not_completed", response: {
        parseResult: "not_started", validationResult: "not_started", stream: { phase, failureReason, completionReceived },
      },
    } });
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_CLEANUP|private_partial/);
    if (completionReceived) expect(failure).toMatchObject({ usage: { inputTokens: 9, outputTokens: 4 } });
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.call).toHaveBeenCalledOnce();
  });

  it.each(["event", "delta", "total"] as const)("keeps the finite %s stream bound and does not retry oversized input", async limitKind => {
    const h = fixture({ finish: "Synthetic reply" }, "response.completed", { wire: event => {
      if (limitKind === "event") return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(200_001) })}\n\n`;
      const events = limitKind === "delta"
        ? Array.from({ length: 2 }, () => ({ type: "response.output_text.delta", delta: "x".repeat(110_000) }))
        : Array.from({ length: 12 }, () => ({ type: "response.in_progress", metadata: "x".repeat(100_000) }));
      return [...events, event].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
    } });
    await expect(h.invoke()).rejects.toMatchObject({ code: "unknown", decisionDiagnostic: { response: {
      parseResult: "not_started", stream: { failureReason: "byte_limit", limitKind, completionReceived: false },
    } } });
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.call).toHaveBeenCalledOnce();
  });

  it("preserves raw Authorization and makes one attempt when the provider fails", async () => {
    const h = fixture(null, "response.completed", { defaultHeaders: { Authorization: "synthetic-raw-token" }, status: 500 });
    await expect(h.invoke()).rejects.toMatchObject({ code: "unknown", message: "agent_decision_result_unknown" });
    expect(h.requestHeaders[0].get("authorization")).toBe("synthetic-raw-token");
    expect(h.requestHeaders[0].get("x-stainless-retry-count")).toBe("0");
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.call).toHaveBeenCalledOnce();
  });

  it.each([
    { tool: "synthetic.read", args: { id: "allowed" }, reason: "Read the current authorized record." },
    { wait: { kind: "feedback", message: "What should this review focus on?" } },
    { finish: "Hand control back; no business success is claimed." }
  ])("accepts the strict action %j without a conflicting root field", async (action) => {
    const h = fixture(action);
    await expect(h.invoke()).resolves.toEqual(action);
    expect(h.requests[0].input[0]).toEqual({ role: "system",
      content: "按受限行动协议只输出JSON。\n只输出一个合法 JSON 对象，不要输出 Markdown，不要输出解释文字。" });
    const instructions = h.requests[0].input.filter(message => message.role === "system").map(message => message.content).join("\n");
    expect(instructions).toContain('{"tool":');
    expect(instructions).toContain('{"wait":');
    expect(instructions).toContain('{"finish":');
    expect(instructions).not.toContain("JSON 根对象必须包含");
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.call).toHaveBeenCalledOnce();
  });

  it.each([
    { items: [] },
    { tool: "synthetic.read", args: {}, items: [] },
    { tool: "synthetic.read", args: {}, finish: "Two actions are forbidden." },
    { wait: { kind: "feedback", message: "Question", extra: true } },
    { tool: "synthetic.read", args: "invalid parameters shape" }
  ])("retains known usage while rejecting invalid action shape %j without retry", async (action) => {
    const h = fixture(action);
    await expect(h.invoke()).rejects.toMatchObject({ code: "known_failure", message: "agent_action_invalid_result",
      usage: { inputTokens: 9, outputTokens: 4 } });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.call).toHaveBeenCalledOnce();
  });

  it.each(["response.failed", "response.incomplete"])("keeps %s with misleading completed metadata unknown", async (eventType) => {
    const h = fixture({ finish: "This malformed terminal event must not be accepted." }, eventType);
    await expect(h.invoke()).rejects.toMatchObject({ code: "unknown", message: "agent_decision_result_unknown",
      usage: { inputTokens: 9, outputTokens: 4 } });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.call).toHaveBeenCalledOnce();
  });
});
