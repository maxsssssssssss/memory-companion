// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTask } from "@/lib/domain/agent";
import { createAgentDecisionProvider } from "./model";
import type { AgentContext, AgentDecisionInput } from "./types";

afterEach(() => vi.unstubAllGlobals());

function fixture(responseValue: unknown) {
  // Capture the actual SDK request at fetch; no socket or Provider is involved.
  const requests: Array<{ input: Array<{ role: string; content: string }> }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://synthetic-provider.invalid/v1/responses");
    requests.push(await request.json());
    const event = { type: "response.completed", response: {
      status: "completed", error: null, incomplete_details: null,
      usage: { input_tokens: 9, output_tokens: 4 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(responseValue) }] }]
    } };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
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
    model: "synthetic-model", maxInputChars: 48000, maxOutputTokens: 1000, requestTimeoutMs: 1000 }));
  return { invoke: () => decide(input, ctx), requests, fetch, call };
}

describe("Agent structured action request contract", () => {
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
  ])("rejects invalid action shape %j without schema relaxation or retry", async (action) => {
    const h = fixture(action);
    await expect(h.invoke()).rejects.toMatchObject({ code: "known_failure", message: "agent_action_invalid_result" });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.call).toHaveBeenCalledOnce();
  });
});
