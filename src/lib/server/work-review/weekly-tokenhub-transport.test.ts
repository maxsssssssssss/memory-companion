// @vitest-environment node
import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StructuredJsonResponseError } from "@/lib/server/openai/structured-json";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  runtimeConfig: vi.fn()
}));

vi.mock("@/lib/server/openai/client", () => ({
  createOpenAIClient: mocks.createClient
}));
vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: mocks.runtimeConfig
}));

import {
  createStructuredWorkWeeklySynthesizer,
  requestWorkWeeklyStructuredJson,
  resolveWorkWeeklyProviderProfile,
  WorkWeeklyClaimTypeSchema,
  WorkWeeklySynthesizerModelResponseSchema,
  WorkWeeklyVerifierResponseSchema
} from "./weekly-ai-provider";
import { WORK_WEEKLY_TEST_REFS, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";
import { WorkWeeklyQaAnswerDraftSchema, WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION } from "./weekly-qa-provider";

const TOKENHUB_BASE_URL = "https://tokenhub.vision-intelligence.tech/v1";
const finalAnswer = {
  items: [{
    section: "decisions",
    text: "采用方案 B",
    claimType: "decision",
    isInterpretation: false,
    sourceRefs: ["work:finding:decision"]
  }]
};

const completedResponse = {
  status: "completed",
  error: null,
  incomplete_details: null,
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify(finalAnswer) }]
  }]
};

function clientFixture(baseURL: string, events?: unknown[]) {
  // Match the shared parser's SSE fixture: decode framed bytes through the real SDK iterator.
  const create = events === undefined
    ? vi.fn().mockResolvedValue(completedResponse)
    : vi.fn().mockImplementation(() => ({
      async asResponse() {
        const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
    }));
  const parse = vi.fn();
  const withOptions = vi.fn();
  const client = { baseURL, responses: { create, parse }, withOptions } as unknown as OpenAI;
  withOptions.mockReturnValue(client);
  mocks.runtimeConfig.mockResolvedValue({
    openAiApiKey: "fixture-key-never-sent",
    openAiBaseUrl: baseURL
  });
  mocks.createClient.mockReturnValue(client);
  return { create, parse };
}

function request(model = "deepseek-v4-pro") {
  const profile = resolveWorkWeeklyProviderProfile("synthesizer", {
    WORK_REVIEW_WEEKLY_SYNTHESIZER_MODEL: model
  });
  return requestWorkWeeklyStructuredJson({
    profile,
    schema: WorkWeeklySynthesizerModelResponseSchema,
    requestInput: "Fictional local weekly source pack.",
    jsonInstruction: "Return the weekly items as JSON."
  });
}

beforeEach(() => {
  mocks.createClient.mockReset();
  mocks.runtimeConfig.mockReset();
});

describe("Work Weekly TokenHub transport", () => {
  it.each([
    { role: "qa_answerer" as const, prefix: "WORK_REVIEW_WEEKLY_QA_ANSWERER", timeoutMs: 60_000, model: "deepseek-v4-pro" },
    { role: "qa_verifier" as const, prefix: "WORK_REVIEW_WEEKLY_QA_VERIFIER", timeoutMs: 30_000, model: "deepseek-v4-pro" },
    { role: "qa_answerer" as const, prefix: "WORK_REVIEW_WEEKLY_QA_ANSWERER", timeoutMs: 30_000, model: "deepseek-v4-flash" },
    { role: "qa_verifier" as const, prefix: "WORK_REVIEW_WEEKLY_QA_VERIFIER", timeoutMs: 30_000, model: "deepseek-v4-flash" }
  ])("carries $model $role into SDK and product timers without retries", async ({ role, prefix, timeoutMs, model }) => {
    const answer = role === "qa_answerer"
      ? { status: "insufficient_evidence", answer: "没有足够依据。", claims: [], relevantSourceRefs: [] }
      : { items: [] };
    const transport = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => {
      const event = { type: "response.completed", response: { ...completedResponse,
        usage: { input_tokens: 512, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } },
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    mocks.runtimeConfig.mockResolvedValue({ openAiApiKey: "fixture-key-never-sent", openAiBaseUrl: TOKENHUB_BASE_URL });
    mocks.createClient.mockImplementation((config) => new OpenAI({ apiKey: "fixture-key-never-sent", baseURL: TOKENHUB_BASE_URL,
      timeout: config.timeoutMs, maxRetries: 2, fetch: transport }));
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clientOptions = vi.spyOn(OpenAI.prototype, "withOptions");
    try {
      const profile = resolveWorkWeeklyProviderProfile(role, { OPENAI_QA_MODEL: "gpt-5.5",
        [`${prefix}_MODEL`]: model, [`${prefix}_REASONING_EFFORT`]: "none", [`${prefix}_TIMEOUT_MS`]: String(timeoutMs) });
      expect(profile).toMatchObject({ role, model, reasoningEffort: "none", timeoutMs, maxOutputTokens: 4_000 });
      const onUsage = vi.fn();
      expect(await requestWorkWeeklyStructuredJson({ profile,
        onUsage,
        schema: role === "qa_answerer" ? WorkWeeklyQaAnswerDraftSchema : WorkWeeklyVerifierResponseSchema,
        requestInput: [{ role: "user", content: "本地合成来源：保留原始文字。" }],
        jsonInstruction: role === "qa_answerer" ? WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION : "输出严格 JSON {items:[]}。"
      })).toEqual(answer);
      expect(transport).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(transport.mock.calls[0]![1]?.body));
      expect(body).toMatchObject({ model, stream: true, reasoning: { effort: "none" }, max_output_tokens: 4_000 });
      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 512, outputTokens: 100, reasoningTokens: 0 });
      expect(body.input[0].content.includes("JSON 根对象必须包含 items 字段")).toBe(role === "qa_verifier");
      expect(body.input[1]).toEqual({ role: "user", content: "本地合成来源：保留原始文字。" });
      expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs }));
      expect(timers.mock.calls.filter(([, delay]) => delay === timeoutMs).length).toBeGreaterThanOrEqual(2);
      expect(clientOptions).toHaveBeenCalledTimes(2);
      expect(clientOptions.mock.calls.every(([options]) => options.maxRetries === 0)).toBe(true);
    } finally { timers.mockRestore(); clientOptions.mockRestore(); }
  });

  describe.each(["qa_answerer", "qa_verifier"] as const)("default GPT %s endpoint", (role) => {
    it.each([
      "http://tokenhub.vision-intelligence.tech",
      "https://tokenhub.vision-intelligence.tech/",
      "http://tokenhub.vision-intelligence.tech/v1",
      "http://tokenhub.vision-intelligence.tech/v1/",
      TOKENHUB_BASE_URL,
      `${TOKENHUB_BASE_URL}/`
    ])("normalizes only the known base %s through the actual SDK", async (baseURL) => {
      const answer = role === "qa_answerer"
        ? { status: "insufficient_evidence", answer: "没有足够依据。", claims: [], relevantSourceRefs: [] }
        : { items: [] };
      const transport = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) =>
        new Response(JSON.stringify({ ...completedResponse, output_text: JSON.stringify(answer),
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] }),
        { headers: { "content-type": "application/json" } }));
      const client = new OpenAI({ apiKey: "fixture-key-never-sent", baseURL, fetch: transport, maxRetries: 0 });
      const options = vi.spyOn(client, "withOptions");
      mocks.runtimeConfig.mockResolvedValue({ openAiApiKey: "fixture-key-never-sent", openAiBaseUrl: baseURL });
      mocks.createClient.mockReturnValue(client);
      const profile = resolveWorkWeeklyProviderProfile(role, { OPENAI_QA_MODEL: "gpt-5.5" });
      expect(profile).toMatchObject({ role, model: "gpt-5.5", reasoningEffort: "provider_default", timeoutMs: 30_000, maxOutputTokens: 4_000 });
      const before = JSON.stringify(profile);
      expect(await requestWorkWeeklyStructuredJson({ profile,
        schema: role === "qa_answerer" ? WorkWeeklyQaAnswerDraftSchema : WorkWeeklyVerifierResponseSchema,
        requestInput: [{ role: "user", content: "本地虚构 QA 来源" }],
        jsonInstruction: role === "qa_answerer" ? WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION : "输出严格 JSON {items:[]}。"
      })).toEqual(answer);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(String(transport.mock.calls[0]![0])).toBe(`${TOKENHUB_BASE_URL}/responses`);
      const body = JSON.parse(String(transport.mock.calls[0]![1]?.body));
      expect(body).toMatchObject({ model: "gpt-5.5", max_output_tokens: 4_000 });
      expect(body).not.toHaveProperty("stream");
      expect(body).not.toHaveProperty("reasoning");
      expect(body.input[0].content.includes("JSON 根对象必须包含 items 字段")).toBe(role === "qa_verifier");
      expect(options).toHaveBeenCalledExactlyOnceWith({ baseURL: TOKENHUB_BASE_URL });
      expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
      expect(client.baseURL).toBe(baseURL);
      expect(JSON.stringify(profile)).toBe(before);
    });
  });

  it.each([
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://tokenhub.vision-intelligence.tech.example.test/v1",
    "https://tokenhub.vision-intelligence.tech/custom/v1",
    "http://tokenhub.vision-intelligence.tech/custom",
    "http://tokenhub.vision-intelligence.tech:9100/v1"
  ])("preserves the actual GPT QA SDK address for other providers or custom bases: %s", async (baseURL) => {
    const qa = { status: "insufficient_evidence", answer: "没有足够依据。", claims: [], relevantSourceRefs: [] };
    const transport = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) =>
      new Response(JSON.stringify({ ...completedResponse, output_text: JSON.stringify(qa),
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(qa) }] }] }),
      { headers: { "content-type": "application/json" } }));
    const client = new OpenAI({ apiKey: "fixture-key-never-sent", baseURL, fetch: transport, maxRetries: 0 });
    const options = vi.spyOn(client, "withOptions");
    mocks.runtimeConfig.mockResolvedValue({ openAiApiKey: "fixture-key-never-sent", openAiBaseUrl: baseURL });
    mocks.createClient.mockReturnValue(client);
    expect(await requestWorkWeeklyStructuredJson({
      profile: resolveWorkWeeklyProviderProfile("qa_answerer", { OPENAI_QA_MODEL: "gpt-5.5" }),
      schema: WorkWeeklyQaAnswerDraftSchema, requestInput: "本地虚构问题", jsonInstruction: WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION
    })).toEqual(qa);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0]![0])).toBe(`${baseURL}/responses`);
    expect(options).not.toHaveBeenCalled();
    expect(client.baseURL).toBe(baseURL);
  });

  it.each([
    "https://tokenhub.vision-intelligence.tech/custom/v1",
    "https://tokenhub.vision-intelligence.tech:9100/v1",
    "https://tokenhub.vision-intelligence.tech/v1?route=custom",
    "https://tokenhub.vision-intelligence.tech/v1#custom"
  ])("keeps the existing stricter DeepSeek rejection for %s", async (baseURL) => {
    const fixture = clientFixture(baseURL);
    await expect(request()).rejects.toMatchObject({ code: "work_weekly_tokenhub_base_url_invalid" });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it.each(["messages", "string"])("uses the QA root without changing original %s or the shared client", async (format) => {
    const qa = { status: "insufficient_evidence", answer: "本周没有足够依据。", claims: [], relevantSourceRefs: [] };
    const events = [{ type: "response.completed", response: { ...completedResponse,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(qa) }] }] } }];
    const fixture = clientFixture(TOKENHUB_BASE_URL, events);
    const original = format === "messages" ? [{ role: "system" as const, content: "产品QA语义指令" },
      { role: "user" as const, content: "问题与来源原文：JSON 根对象必须包含 items 字段。保留 open API 标题。" }]
      : "问题与来源原文：JSON 根对象必须包含 items 字段。保留 open API 标题。";
    const before = JSON.stringify(original);
    const profile = resolveWorkWeeklyProviderProfile("qa_answerer", { WORK_REVIEW_WEEKLY_QA_ANSWERER_MODEL: "deepseek-v4-pro" });
    expect(await requestWorkWeeklyStructuredJson({ profile, schema: WorkWeeklyQaAnswerDraftSchema,
      requestInput: original, jsonInstruction: WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION })).toEqual(qa);
    const body = fixture.create.mock.calls[0]![0];
    const prefix = `${WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION}\n只输出一个合法 JSON 对象，不要输出 Markdown，不要输出解释文字。`;
    expect(prefix).not.toContain("JSON 根对象必须包含 items 字段");
    expect(body.input).toEqual(Array.isArray(original)
      ? [{ role: "system", content: prefix }, ...original] : `${prefix}\n\n${original}`);
    expect(body).toMatchObject({ stream: true, model: "deepseek-v4-pro", max_output_tokens: 4000, reasoning: { effort: "none" } });
    expect(fixture.create.mock.calls[0]![1]).toMatchObject({ maxRetries: 0, signal: expect.any(AbortSignal) });
    expect(JSON.stringify(original)).toBe(before); expect(fixture.parse).not.toHaveBeenCalled();
    events[0] = { type: "response.completed", response: completedResponse };
    expect(await request()).toEqual(finalAnswer);
    expect(String(fixture.create.mock.calls[1]![0].input)).toContain("JSON 根对象必须包含 items 字段");
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });

  it.each(["messages", "string"])("preserves QA %s input through actual SDK client cloning and a local fetch", async (format) => {
    const qa = { status: "insufficient_evidence", answer: "本周没有足够依据。", claims: [], relevantSourceRefs: [] };
    let output: unknown = qa;
    const bodies: Record<string, unknown>[] = [];
    const transport = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      bodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
      const event = { type: "response.completed", response: { ...completedResponse,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }] } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const client = new OpenAI({ apiKey: "fixture-key-never-sent", baseURL: TOKENHUB_BASE_URL, fetch: transport });
    const originalCreate = client.responses.create;
    mocks.runtimeConfig.mockResolvedValue({ openAiApiKey: "fixture-key-never-sent", openAiBaseUrl: TOKENHUB_BASE_URL });
    mocks.createClient.mockReturnValue(client);
    const content = "来源原文：JSON 根对象必须包含 items 字段。保留 open API 标题。";
    const original = format === "messages" ? [{ role: "user" as const, content }] : content;
    const before = JSON.stringify(original);
    const profile = resolveWorkWeeklyProviderProfile("qa_answerer", { WORK_REVIEW_WEEKLY_QA_ANSWERER_MODEL: "deepseek-v4-pro" });
    expect(await requestWorkWeeklyStructuredJson({ profile, schema: WorkWeeklyQaAnswerDraftSchema,
      requestInput: original, jsonInstruction: WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION })).toEqual(qa);
    const prefix = `${WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION}\n只输出一个合法 JSON 对象，不要输出 Markdown，不要输出解释文字。`;
    expect(bodies[0]!.input).toEqual(Array.isArray(original)
      ? [{ role: "system", content: prefix }, ...original] : `${prefix}\n\n${original}`);
    expect(bodies[0]).toMatchObject({ stream: true, model: "deepseek-v4-pro", max_output_tokens: 4000, reasoning: { effort: "none" } });
    expect(String(transport.mock.calls[0]![0])).toBe(`${TOKENHUB_BASE_URL}/responses`);
    expect(transport.mock.calls[0]![1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    expect(JSON.stringify(original)).toBe(before);
    expect(client.responses.create).toBe(originalCreate);
    output = finalAnswer;
    expect(await request()).toEqual(finalAnswer);
    expect(String(bodies[1]!.input)).toContain("JSON 根对象必须包含 items 字段");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["extra_items", "wrong_root"])("keeps strict QA schema rejection after removing the conflicting hint: %s", async (mode) => {
    const value = mode === "wrong_root" ? { items: [] }
      : { status: "insufficient_evidence", answer: "", claims: [], relevantSourceRefs: [], items: [] };
    const fixture = clientFixture(TOKENHUB_BASE_URL, [{ type: "response.completed", response: { ...completedResponse,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] } }]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(requestWorkWeeklyStructuredJson({ profile: resolveWorkWeeklyProviderProfile("qa_answerer", {
        WORK_REVIEW_WEEKLY_QA_ANSWERER_MODEL: "deepseek-v4-pro" }), schema: WorkWeeklyQaAnswerDraftSchema,
        requestInput: [{ role: "user", content: "本地虚构问题" }], jsonInstruction: WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION
      })).rejects.toMatchObject({ code: "work_weekly_provider_schema_invalid" });
      expect(fixture.create).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });

  it.each(["verifier", "qa_verifier"] as const)("keeps the items instruction and wire for %s", async (role) => {
    const fixture = clientFixture(TOKENHUB_BASE_URL, [{ type: "response.completed", response: { ...completedResponse,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"items":[]}' }] }] } }]);
    const profile = resolveWorkWeeklyProviderProfile(role, { [`WORK_REVIEW_WEEKLY_${role.toUpperCase()}_MODEL`]: "deepseek-v4-pro" });
    expect(await requestWorkWeeklyStructuredJson({ profile, schema: WorkWeeklyVerifierResponseSchema,
      requestInput: [{ role: "user", content: "虚构Claim集合" }], jsonInstruction: "输出严格JSON {items:[]}。" })).toEqual({ items: [] });
    expect(fixture.create.mock.calls[0]![0].input[0].content).toContain("JSON 根对象必须包含 items 字段");
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  function synthesize(wires: unknown[], snapshot = workWeeklyTestSnapshot()) {
    const fixture = clientFixture(TOKENHUB_BASE_URL, [{ type: "response.completed", response: {
      ...completedResponse, output: [{ type: "message", role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ items: wires }) }] }]
    } }]);
    const result = createStructuredWorkWeeklySynthesizer({
      profile: resolveWorkWeeklyProviderProfile("synthesizer", { WORK_REVIEW_WEEKLY_SYNTHESIZER_MODEL: "deepseek-v4-pro" })
    }).synthesize({ accountId: snapshot.accountId, snapshot });
    return { fixture, result };
  }

  it("maps the five-field model contract without guessing stance or losing qualifications", async () => {
    const snapshot = workWeeklyTestSnapshot();
    const wires = [
      { ...finalAnswer.items[0], section: "open_questions", claimType: "fact", isInterpretation: false,
        text: "提议观察确认率；只有采集可行且不涉及敏感正文时考虑，没有指定负责人或日期。",
        sourceRefs: [WORK_WEEKLY_TEST_REFS.evidenceProposal] },
      { ...finalAnswer.items[0], section: "overview", claimType: "fact", isInterpretation: true,
        text: "来源记录的安排仍有待观察。", sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] },
      ...[false, true].map((isInterpretation) => ({ ...finalAnswer.items[0], section: "next_week", claimType: "fact",
        text: "记录中的日期尚无截止依据。", isInterpretation, sourceRefs: [WORK_WEEKLY_TEST_REFS.dated] }))
    ];
    const before = JSON.stringify({ wires, snapshot });
    expect(WorkWeeklySynthesizerModelResponseSchema.safeParse({ items: wires }).success).toBe(true);
    const { fixture, result } = synthesize(wires, snapshot);
    const items = await result;
    expect(items.map((item) => item.itemType)).toEqual(["evidence_backed_fact", "interpretation", "suggestion", "suggestion"]);
    expect(items.map((item) => item.id)).toEqual(["item_001", "item_002", "item_003", "item_004"]);
    expect(new Set(items.flatMap((item) => item.claims.map((claim) => claim.id))).size).toBe(4);
    items.forEach((item, index) => {
      expect(item.text).toBe(wires[index].text);
      expect(item.claims).toEqual([{ id: `claim_${String(index + 1).padStart(3, "0")}_001`,
        text: wires[index].text, claimType: wires[index].claimType, sourceRefs: wires[index].sourceRefs }]);
    });
    expect(JSON.stringify({ wires, snapshot })).toBe(before);
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it.each(WorkWeeklyClaimTypeSchema.options)("preserves semantic claimType %s for the existing verifier", async (claimType) => {
    const wire = { ...finalAnswer.items[0], section: "overview", claimType };
    const { fixture, result } = synthesize([wire]);
    expect((await result)[0].claims[0]).toMatchObject({ claimType, text: wire.text, sourceRefs: wire.sourceRefs });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    "missing_boolean", "string_boolean", "null_boolean", "missing_text", "empty_text", "oversized_text",
    "missing_claim_type", "unknown_claim_type", "unknown_section", "empty_refs", "invalid_refs",
    "model_id", "item_type", "nested_claims", "second_summary"
  ])("strictly rejects malformed model wire without repair: %s", async (failure) => {
    const wire: Record<string, unknown> = { ...finalAnswer.items[0] };
    if (failure === "missing_boolean") delete wire.isInterpretation;
    if (failure === "string_boolean") wire.isInterpretation = "false";
    if (failure === "null_boolean") wire.isInterpretation = null;
    if (failure === "missing_text") delete wire.text;
    if (failure === "empty_text") wire.text = " ";
    if (failure === "oversized_text") wire.text = "x".repeat(20_001);
    if (failure === "missing_claim_type") delete wire.claimType;
    if (failure === "unknown_claim_type") wire.claimType = "proposal";
    if (failure === "unknown_section") wire.section = "decision";
    if (failure === "empty_refs") wire.sourceRefs = [];
    if (failure === "invalid_refs") wire.sourceRefs = null;
    if (failure === "model_id") wire.id = "model_item";
    if (failure === "item_type") wire.itemType = "evidence_backed_fact";
    if (failure === "nested_claims") wire.claims = [{ id: "c", text: "detached qualification" }];
    if (failure === "second_summary") wire.summary = "a different claim";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fixture, result } = synthesize([wire]);
      await expect(result).rejects.toMatchObject({ code: "work_weekly_provider_schema_invalid" });
      expect(fixture.create).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });

  it("normalizes repeated citations after decoding a complete SSE response", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const wire = { ...finalAnswer.items[0], sourceRefs: [...finalAnswer.items[0].sourceRefs, ...finalAnswer.items[0].sourceRefs] };
      const { fixture, result } = synthesize([wire]);
      const items = await result;
      expect(items[0]!.claims[0]!.sourceRefs).toEqual(finalAnswer.items[0].sourceRefs);
      expect(items[0]!.claims[0]!.text).toBe(finalAnswer.items[0].text);
      expect(fixture.create).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });

  it.each(["foreign_ref", "unsupported_completed", "legacy_wire"])(
    "retains internal validation and allowlist boundaries after decoding: %s", async (failure) => {
      let wire: Record<string, unknown> = { ...finalAnswer.items[0] };
      if (failure === "foreign_ref") wire.sourceRefs = ["work:finding:outside_scope"];
      if (failure === "unsupported_completed") wire.section = "completed";
      if (failure === "legacy_wire") wire = { id: "old_item", section: "decisions", text: "old summary", itemType: "evidence_backed_fact",
        claims: [{ id: "old_claim", text: "采用方案 B", claimType: "decision", sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }] };
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { fixture, result } = synthesize([wire]);
        await expect(result).rejects.toMatchObject({ code: failure === "foreign_ref" ? "work_weekly_source_not_allowlisted"
          : failure === "legacy_wire" ? "work_weekly_provider_schema_invalid" : "work_weekly_synthesizer_output_invalid" });
        expect(fixture.create).toHaveBeenCalledTimes(1);
      } finally { log.mockRestore(); }
    }
  );

  it("parses final SSE JSON with none reasoning and no retry for TokenHub DeepSeek Pro", async () => {
    const fixture = clientFixture(TOKENHUB_BASE_URL, [
      { type: "response.output_text.delta", delta: '{"items":[]}' },
      { type: "response.completed", response: completedResponse }
    ]);

    await expect(request()).resolves.toEqual(finalAnswer);

    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        model: "deepseek-v4-pro",
        stream: true,
        reasoning: { effort: "none" }
      }),
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) })
    );
    expect(fixture.parse).not.toHaveBeenCalled();
    expect(resolveWorkWeeklyProviderProfile("verifier", {
      WORK_REVIEW_WEEKLY_VERIFIER_MODEL: "deepseek-v4-pro",
      WORK_REVIEW_WEEKLY_VERIFIER_REASONING_EFFORT: "none"
    }).reasoningEffort).toBe("none");
  });

  it("rejects a missing completion or incomplete terminal event even with valid JSON", async () => {
    const delta = { type: "response.output_text.delta", delta: JSON.stringify(finalAnswer) };
    for (const events of [
      [delta],
      [delta, {
        type: "response.incomplete",
        response: {
          ...completedResponse,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" }
        }
      }]
    ]) {
      const fixture = clientFixture(TOKENHUB_BASE_URL, events);
      await expect(request()).rejects.toMatchObject({ code: "incomplete_response" });
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.parse).not.toHaveBeenCalled();
    }
  });

  it("rejects truncated final SSE JSON without repair, retry or private diagnostic text", async () => {
    const privateText = "PRIVATE_TRUNCATED_RESPONSE_TEXT";
    const rawResponse = JSON.stringify({
      items: [{ ...finalAnswer.items[0], text: privateText }]
    }).slice(0, -1);
    const fixture = clientFixture(TOKENHUB_BASE_URL, [{
      type: "response.completed",
      response: {
        ...completedResponse,
        usage: { input_tokens: 32, output_tokens: 16 },
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: rawResponse }]
        }]
      }
    }]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failure = await request().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(StructuredJsonResponseError);
      expect(failure).toMatchObject({ code: "incomplete_json" });
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.parse).not.toHaveBeenCalled();
      expect(consoleError.mock.calls.map(([message]) => JSON.parse(message as string))).toEqual([
        {
          component: "work-weekly-provider",
          role: "synthesizer",
          parseResult: "failed",
          validationResult: "not_started",
          responseStatus: "completed",
          responseTextLength: rawResponse.length,
          inputTokens: 32,
          outputTokens: 16
        },
        { component: "work-weekly-provider", role: "synthesizer", errorCode: "incomplete_json" }
      ]);
      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).not.toContain(privateText);
      expect(logged).not.toContain(rawResponse);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("classifies an invalid SSE schema without logging private input, output or credentials", async () => {
    const privateInput = "PRIVATE_USER_BODY";
    const privateOutput = "PRIVATE_RETURNED_TEXT";
    const invalidEnum = "PRIVATE_INVALID_ENUM";
    const privateKey = "PRIVATE_FIXTURE_API_KEY";
    const rawResponse = JSON.stringify({
      items: [{ ...finalAnswer.items[0], section: invalidEnum, text: privateOutput }]
    });
    const fixture = clientFixture(TOKENHUB_BASE_URL, [{
      type: "response.completed",
      response: {
        ...completedResponse,
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: rawResponse }]
        }]
      }
    }]);
    mocks.runtimeConfig.mockResolvedValue({
      openAiApiKey: privateKey,
      openAiBaseUrl: TOKENHUB_BASE_URL
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(requestWorkWeeklyStructuredJson({
        profile: resolveWorkWeeklyProviderProfile("synthesizer", {
          WORK_REVIEW_WEEKLY_SYNTHESIZER_MODEL: "deepseek-v4-pro"
        }),
        schema: WorkWeeklySynthesizerModelResponseSchema,
        requestInput: privateInput,
        jsonInstruction: "Return the weekly items as JSON."
      })).rejects.toMatchObject({
        code: "work_weekly_provider_schema_invalid",
        message: "work_weekly_provider_schema_invalid"
      });

      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const diagnostics = JSON.parse(consoleError.mock.calls[0][0] as string);
      expect(diagnostics).toEqual({
        component: "work-weekly-provider",
        role: "synthesizer",
        parseResult: "success",
        validationResult: "failed",
        responseStatus: "completed",
        validationIssueSummary: [{ code: "invalid_enum_value", count: 1 }],
        validationPaths: [{ path: "items[0].section", code: "invalid_enum_value" }]
      });
      const logged = JSON.stringify(consoleError.mock.calls);
      for (const privateValue of [privateInput, privateOutput, invalidEnum, privateKey, rawResponse]) {
        expect(logged).not.toContain(privateValue);
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  it("redacts an unknown non-streaming response status when schema validation fails", async () => {
    const privateStatus = "PRIVATE_PROVIDER_STATUS_WITH_SECRET";
    const fixture = clientFixture("https://api.openai.com/v1");
    fixture.create.mockResolvedValue({
      ...completedResponse,
      status: privateStatus,
      output_text: JSON.stringify({
        items: [{ ...finalAnswer.items[0], section: "invalid-section" }]
      })
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(request()).rejects.toMatchObject({ code: "work_weekly_provider_schema_invalid" });
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.create.mock.calls[0][0]).not.toHaveProperty("stream");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(consoleError.mock.calls[0][0] as string)).toMatchObject({
        responseStatus: "other",
        parseResult: "success",
        validationResult: "failed",
        validationPaths: [{ path: "items[0].section", code: "invalid_enum_value" }]
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(privateStatus);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preserves non-streaming provider defaults for other hosts or models", async () => {
    for (const [baseURL, model] of [
      ["https://api.openai.com/v1", "deepseek-v4-pro"],
      ["https://tokenhub.vision-intelligence.tech.example.test/v1", "deepseek-v4-pro"],
      [TOKENHUB_BASE_URL, "other-model"]
    ]) {
      const fixture = clientFixture(baseURL);
      await expect(request(model)).resolves.toEqual(finalAnswer);
      expect(fixture.create).toHaveBeenCalledTimes(1);
      const [body] = fixture.create.mock.calls[0];
      expect(body).toMatchObject({ model });
      expect(body).not.toHaveProperty("stream");
      expect(body).not.toHaveProperty("reasoning");
      expect(fixture.parse).not.toHaveBeenCalled();
    }
  });
});
