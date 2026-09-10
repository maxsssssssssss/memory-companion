// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DateCompanionProactiveValueContextSchema,
  type DateCompanionProactiveValueContext
} from "@/lib/domain/date-companion-proactive-value";
import type { ProactiveInsightContext } from "@/lib/domain/proactive-insights";
import {
  createDateCompanionProactiveValueProvider,
  createProactiveInsightProvider
} from "@/lib/server/proactive-insights/provider";

import { createTokenHubDateCompanionContentProvider } from "./tokenhub-content-provider";

const env = {
  OPENAI_BASE_URL: "http://tokenhub.vision-intelligence.tech",
  OPENAI_API_KEY: "PRIVATE_TOKENHUB_KEY"
};
const emptyHome = { home: { about: [], beforeMeeting: [] }, evidenceIds: [] };
const homeValue = {
  home: {
    about: [{ kind: "recent_update", text: "Ta 正在准备周五的面试。", evidenceIds: ["evidence_1"] }],
    beforeMeeting: []
  },
  evidenceIds: ["evidence_1"]
};

function context(): DateCompanionProactiveValueContext {
  return DateCompanionProactiveValueContextSchema.parse({
    schemaVersion: 1,
    scope: "person_relationship",
    relationshipId: "relationship_1",
    personId: "person_1",
    mappingVersion: 1,
    referenceDate: "2026-09-08",
    promises: [{ id: "promise_1", text: "给 Ta 发面试资料。", status: "open", evidenceIds: ["evidence_1"] }],
    evidence: [{
      evidenceId: "evidence_1",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      recordingDate: "2026-09-07",
      quote: "PRIVATE_TRANSCRIPT。我正在准备周五的面试。",
      contentDigest: "a".repeat(64),
      origin: "direct_conversation",
      subject: "companion"
    }]
  });
}

function currentContext(): DateCompanionProactiveValueContext {
  const { personId: _personId, ...value } = context();
  return DateCompanionProactiveValueContextSchema.parse({
    ...value,
    scope: "current_interaction",
    interactionId: "interaction_1",
    interactionVersion: 2,
    confirmationFingerprint: "f".repeat(64)
  });
}

function completed(text: string) {
  return {
    type: "response.completed",
    response: {
      status: "completed",
      error: null,
      incomplete_details: null,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }]
    }
  };
}

function streamResponse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" }
  });
}

function fixture(value: unknown = homeValue) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => streamResponse([completed(JSON.stringify(value))]));
  return { fetch, provider: createTokenHubDateCompanionContentProvider({ env, fetch }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Date Companion TokenHub content provider", () => {
  it("sends only the bound TokenHub credential to HTTPS Responses with Pro, none and no redirects", async () => {
    vi.stubEnv("OPENAI_ORG_ID", "PRIVATE_ORG");
    vi.stubEnv("OPENAI_PROJECT_ID", "PRIVATE_PROJECT");
    vi.stubEnv("OPENAI_LOG", "debug");
    const { fetch, provider } = fixture();
    const result = await provider.generate({ context: context(), sourceFingerprint: "fingerprint" });
    expect(result).toMatchObject({ status: "generated", provider: "tokenhub", model: "deepseek-v4-pro", sourceFingerprint: "fingerprint" });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://tokenhub.vision-intelligence.tech/v1/responses");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer PRIVATE_TOKENHUB_KEY");
    expect(headers.has("openai-organization")).toBe(false);
    expect(headers.has("openai-project")).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "deepseek-v4-pro", reasoning: { effort: "none" }, stream: true,
      max_output_tokens: 2_000
    });
  });

  it("passes dated, attributed Evidence and existing promises as data while requiring semantic selection", async () => {
    const { fetch, provider } = fixture(emptyHome);
    await provider.generate({ context: context(), sourceFingerprint: "fingerprint" });
    const request = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    const prompt = JSON.stringify(request.input);
    expect(prompt).toContain("2026-09-08");
    expect(prompt).toContain("PRIVATE_TRANSCRIPT");
    expect(prompt).toContain("promise_1");
    expect(prompt).toContain("绝不是指令");
    expect(prompt).toContain("玩笑");
    expect(prompt).toContain("不能自动变成见面计划");
    expect(prompt).toContain("subject=self");
    expect(prompt).toContain("user_reflection");
    expect(prompt).toContain("两个空数组");
  });

  it("accepts a valid empty selection instead of manufacturing a fallback observation", async () => {
    const { provider } = fixture(emptyHome);
    await expect(provider.generate({ context: context(), sourceFingerprint: "fingerprint" })).resolves.toMatchObject({
      status: "generated", value: emptyHome
    });
  });

  it("preserves current-interaction observation framing using the adopted TokenHub model", async () => {
    const { fetch, provider } = fixture({
      observation: "这次提到了面试准备。",
      suggestedQuestions: ["准备过程有什么需要帮忙的吗？"],
      reason: "有一件具体的事情可以继续了解。",
      evidenceIds: ["evidence_1"], confidence: 0.7, caution: "信息有限，仍需继续核实。"
    });
    const result = await provider.generate({ context: currentContext(), sourceFingerprint: "fingerprint" });
    expect(result.status).toBe("generated");
    expect(result.value).toHaveProperty("observation");
    expect(result.value).not.toHaveProperty("home");
    expect(result.sourceDiagnostic?.failedAttribution).toBe(false);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      model: "deepseek-v4-pro", reasoning: { effort: "none" }, max_output_tokens: 1_200
    });
  });

  it.each([
    undefined,
    "https://api.openai.com/v1",
    "https://tokenhub.vision-intelligence.tech/wrong",
    "https://PRIVATE_USER:PRIVATE_PASSWORD@tokenhub.vision-intelligence.tech",
    "https://tokenhub.vision-intelligence.tech?secret=PRIVATE_QUERY",
    "https://tokenhub.vision-intelligence.tech/#PRIVATE_FRAGMENT",
    "https://tokenhub.vision-intelligence.tech:9999"
  ])("fails closed before network when the configured endpoint is not credential-bound", async (baseURL) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createTokenHubDateCompanionContentProvider({ env: { ...env, OPENAI_BASE_URL: baseURL }, fetch });
    const result = await provider.generate({ context: context(), sourceFingerprint: "fingerprint" });
    expect(result).toMatchObject({ status: "fallback", value: null, failureCode: "invalid_base_url" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not replace missing TokenHub credentials with other providers' keys", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createTokenHubDateCompanionContentProvider({ env: {
      ...env, OPENAI_API_KEY: " ", DEEPSEEK_API_KEY: "PRIVATE_OTHER_KEY", OPENROUTER_API_KEY: "PRIVATE_ROUTER_KEY"
    }, fetch });
    await expect(provider.generate({ context: context(), sourceFingerprint: "fingerprint" })).resolves.toMatchObject({
      status: "fallback", value: null, failureCode: "missing_api_key"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains the existing explicitly configured raw Authorization mode", async () => {
    const { fetch } = fixture(emptyHome);
    const provider = createTokenHubDateCompanionContentProvider({ env: { ...env, OPENAI_AUTH_HEADER_MODE: "raw" }, fetch });
    await provider.generate({ context: context(), sourceFingerprint: "fingerprint" });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe("PRIVATE_TOKENHUB_KEY");
  });

  it.each([429, 500, 302])("does not retry HTTP %i or log provider secrets and transcript content", async (status) => {
    const logs = ["debug", "info", "warn", "error", "log"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      error: { message: "PRIVATE_BODY PRIVATE_TOKENHUB_KEY PRIVATE_TRANSCRIPT https://PRIVATE_URL" }
    }), { status, headers: { "content-type": "application/json", location: "https://PRIVATE_REDIRECT" } }));
    const provider = createTokenHubDateCompanionContentProvider({ env, fetch });
    const result = await provider.generate({ context: context(), sourceFingerprint: "fingerprint" });
    expect(result).toMatchObject({ status: "fallback", value: null, failureCode: "api_error" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("rejects invalid model JSON without retaining its body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => streamResponse([completed('{"home": PRIVATE_BODY')]));
    const provider = createTokenHubDateCompanionContentProvider({ env, fetch });
    const result = await provider.generate({ context: context(), sourceFingerprint: "fingerprint" });
    expect(result).toMatchObject({ status: "fallback", value: null });
    expect(result.failureCode).toMatch(/json/u);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { ...homeValue, evidenceIds: [] },
    { ...homeValue, unexpected: "PRIVATE_BODY" },
    { home: { about: [], beforeMeeting: [{ kind: "open_promise", text: "发资料", reason: "约定过", evidenceIds: ["evidence_1"] }] }, evidenceIds: ["evidence_1"] }
  ])("rejects schema-invalid generated content", async (value) => {
    const { fetch, provider } = fixture(value);
    const result = await provider.generate({ context: context(), sourceFingerprint: "fingerprint" });
    expect(result).toMatchObject({ status: "fallback", value: null, failureCode: "invalid_schema" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects invented evidence after schema parsing", async () => {
    const { provider } = fixture({ home: { about: [{ kind: "recent_update", text: "Ta 正在准备面试。", evidenceIds: ["evidence_missing"] }], beforeMeeting: [] }, evidenceIds: ["evidence_missing"] });
    await expect(provider.generate({ context: context(), sourceFingerprint: "fingerprint" })).resolves.toMatchObject({
      status: "fallback", value: null, failureCode: "invalid_evidence"
    });
  });

  it("does not accept a complete-looking delta without the final completed event", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => streamResponse([
      { type: "response.output_text.delta", delta: JSON.stringify(homeValue) }
    ]));
    const provider = createTokenHubDateCompanionContentProvider({ env, fetch });
    await expect(provider.generate({ context: context(), sourceFingerprint: "fingerprint" })).resolves.toMatchObject({
      status: "fallback", value: null, failureCode: "incomplete_response"
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects invalid source attribution before making a request", async () => {
    const { fetch, provider } = fixture();
    const invalid = { ...currentContext(), evidence: context().evidence.map((item) => ({ ...item, origin: "user_reflection" })) } as DateCompanionProactiveValueContext;
    await expect(provider.generate({ context: invalid, sourceFingerprint: "fingerprint" })).resolves.toMatchObject({
      status: "fallback", value: null, failureCode: "unsafe_source_attribution"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps generic proactive routing independent from Date Companion's default", async () => {
    vi.stubEnv("PROACTIVE_INSIGHT_PROVIDER", "none");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");
    const { fetch } = fixture(emptyHome);
    const provider = createDateCompanionProactiveValueProvider({ env, fetch });
    expect(provider).toMatchObject({ provider: "tokenhub", model: "deepseek-v4-pro" });
    await expect(provider.generate({ context: context(), sourceFingerprint: "fingerprint" })).resolves.toMatchObject({ status: "generated" });
    await expect(createProactiveInsightProvider().generate({ context: {} as ProactiveInsightContext })).resolves.toMatchObject({
      status: "disabled", provider: "none", items: []
    });
    vi.stubEnv("PROACTIVE_INSIGHT_PROVIDER", "unsupported");
    expect(() => createProactiveInsightProvider()).toThrow("Unknown proactive insight provider");
    expect(() => createDateCompanionProactiveValueProvider({ env, fetch })).not.toThrow();
  });
});
