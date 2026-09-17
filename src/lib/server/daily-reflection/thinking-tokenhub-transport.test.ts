// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  DailyReflectionThinkingProviderTimeoutError,
  TokenHubThinkingConversationProvider
} from "./thinking-provider";

const environment = {
  NODE_ENV: "test" as const,
  OPENAI_BASE_URL: "http://tokenhub.vision-intelligence.tech",
  OPENAI_API_KEY: "PRIVATE_TOKENHUB_KEY",
  OPENAI_QA_MODEL: "gpt-5.5",
  OPENAI_TEXT_MODEL: "gpt-4.1-mini",
  OPENAI_QA_WIRE_API: "chat"
};
const output = {
  answer: "先用一个小实验验证这个方向。",
  personalContextClaims: [],
  interpretations: [],
  hypotheses: []
};
const input = {
  mode: "brainstorm" as const,
  contextMode: "none" as const,
  message: "PRIVATE_USER_TEXT，一起想想下一步。",
  history: [],
  sources: [],
  settingsStore: {} as JsonStore
};

function completed(value: unknown = output) {
  return {
    type: "response.completed",
    response: {
      status: "completed",
      error: null,
      incomplete_details: null,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }]
    }
  };
}

function stream(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Thinking TokenHub transport", () => {
  it.each([
    "brainstorm", "clarify_decision", "compare_directions", "extend_idea", "past_clues"
  ] as const)("routes %s through HTTPS Pro Responses with its exact JSON contract", async (mode) => {
    vi.stubEnv("OPENAI_ORG_ID", "PRIVATE_ORG");
    vi.stubEnv("OPENAI_PROJECT_ID", "PRIVATE_PROJECT");
    vi.stubEnv("OPENAI_LOG", "debug");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => stream([completed()]));
    const provider = new TokenHubThinkingConversationProvider({ environment, fetch });
    await expect(provider.generate({ ...input, mode })).resolves.toEqual(output);
    expect(provider.model).toBe("deepseek-v4-pro");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://tokenhub.vision-intelligence.tech/v1/responses");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer PRIVATE_TOKENHUB_KEY");
    expect(headers.has("openai-organization")).toBe(false);
    expect(headers.has("openai-project")).toBe(false);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "deepseek-v4-pro", stream: true, reasoning: { effort: "none" } });
    expect(body.input).toHaveLength(2);
    expect(body.input[0].content).toContain("answer、personalContextClaims、interpretations、hypotheses");
    expect(body.input[0].content).not.toMatch(/根对象必须包含 (?:items|results)/u);
  });

  it.each([
    undefined,
    "https://api.openai.com/v1",
    "https://tokenhub.vision-intelligence.tech/wrong",
    "https://PRIVATE:SECRET@tokenhub.vision-intelligence.tech",
    "https://tokenhub.vision-intelligence.tech?secret=PRIVATE",
    "https://tokenhub.vision-intelligence.tech/#PRIVATE",
    "https://tokenhub.vision-intelligence.tech:9999"
  ])("rejects an unbound endpoint before sending credentials: %s", async (baseURL) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new TokenHubThinkingConversationProvider({
      environment: { ...environment, OPENAI_BASE_URL: baseURL }, fetch
    });
    await expect(provider.generate(input)).rejects.toMatchObject({ name: "DailyReflectionThinkingProviderUnavailableError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not substitute other credentials or read saved provider settings", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const read = vi.fn();
    const provider = new TokenHubThinkingConversationProvider({ environment: {
      ...environment, OPENAI_API_KEY: " ", OPENROUTER_API_KEY: "PRIVATE_OTHER", DEEPSEEK_API_KEY: "PRIVATE_OTHER"
    }, fetch });
    await expect(provider.generate({ ...input, settingsStore: { read } as unknown as JsonStore }))
      .rejects.toMatchObject({ name: "DailyReflectionThinkingProviderUnavailableError" });
    expect(fetch).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves explicitly configured raw authorization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => stream([completed()]));
    const provider = new TokenHubThinkingConversationProvider({
      environment: { ...environment, OPENAI_AUTH_HEADER_MODE: "raw" }, fetch
    });
    await provider.generate(input);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe("PRIVATE_TOKENHUB_KEY");
  });

  it("uses only completed assistant text, ignoring reasoning and partial deltas", async () => {
    const event = completed();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => stream([
      { type: "response.output_text.delta", delta: "PRIVATE_PARTIAL" },
      { ...event, response: { ...event.response, output: [
        { type: "reasoning", content: [{ type: "output_text", text: "PRIVATE_REASONING" }] },
        ...event.response.output
      ] } }
    ]));
    const provider = new TokenHubThinkingConversationProvider({ environment, fetch });
    await expect(provider.generate(input)).resolves.toEqual(output);
  });

  it.each([
    ["partial", [{ type: "response.output_text.delta", delta: JSON.stringify(output) }]],
    ["failed", [{ type: "response.failed", response: { error: { message: "PRIVATE_ERROR" } } }]],
    ["incomplete", [{ type: "response.incomplete", response: { status: "incomplete" } }]],
    ["error", [{ type: "error", message: "PRIVATE_ERROR" }]],
    ["false completion", [{ type: "response.completed", response: { status: "incomplete", output: [] } }]],
    ["empty completion", [{ type: "response.completed", response: { status: "completed", output: [] } }]],
    ["extra root", [completed({ ...output, items: [] })]],
    ["invented source", [completed({ ...output, personalContextClaims: [{ text: "编造的过去", sourceIds: ["invented"] }] })]]
  ])("rejects %s without accepting a fallback answer", async (_label, events) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => stream(events as unknown[]));
    const provider = new TokenHubThinkingConversationProvider({ environment, fetch });
    await expect(provider.generate(input)).rejects.toMatchObject({ name: "DailyReflectionThinkingProviderUnavailableError" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 302, "malformed SSE"])("caps %s at two attempts with no SDK retry or sensitive logging", async (status) => {
    const logs = ["debug", "info", "warn", "error", "log"].map((method) => (
      vi.spyOn(console, method as "log").mockImplementation(() => {})
    ));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typeof status === "number"
      ? new Response("PRIVATE_PROVIDER_BODY", { status })
      : new Response("data: PRIVATE_INVALID_JSON\n\n", { headers: { "content-type": "text/event-stream" } }));
    const provider = new TokenHubThinkingConversationProvider({ environment, fetch });
    await expect(provider.generate(input)).rejects.toThrow("Daily Reflection Thinking Provider is unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("propagates abort to the HTTP request and never retries a timeout", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const provider = new TokenHubThinkingConversationProvider({ environment, fetch, timeoutMs: 20 });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(provider.generate({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(provider.generate(input)).rejects.toBeInstanceOf(DailyReflectionThinkingProviderTimeoutError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
});
