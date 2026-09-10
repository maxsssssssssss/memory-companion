// @vitest-environment node
import type OpenAI from "openai";
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
  WorkWeeklySynthesizerResponseSchema
} from "./weekly-ai-provider";
import { WORK_WEEKLY_TEST_REFS, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";

const TOKENHUB_BASE_URL = "https://tokenhub.vision-intelligence.tech/v1";
const finalAnswer = {
  items: [{
    id: "item_decision",
    section: "decisions",
    text: "采用方案 B",
    itemType: "evidence_backed_fact",
    claims: [{
      id: "claim_decision",
      text: "采用方案 B",
      claimType: "decision",
      sourceRefs: ["work:finding:decision"]
    }]
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
    schema: WorkWeeklySynthesizerResponseSchema,
    requestInput: "Fictional local weekly source pack.",
    jsonInstruction: "Return the weekly items as JSON."
  });
}

beforeEach(() => {
  mocks.createClient.mockReset();
  mocks.runtimeConfig.mockReset();
});

describe("Work Weekly TokenHub transport", () => {
  it("assigns unique verifier IDs without changing claims or source references", async () => {
    const wireItems = [WORK_WEEKLY_TEST_REFS.decision, WORK_WEEKLY_TEST_REFS.proposal].map((ref, index) => ({
      ...finalAnswer.items[0], id: "same_item", text: `来源事实 ${index + 1}`,
      claims: [{ ...finalAnswer.items[0].claims[0], id: "same_claim", text: `原始事实 ${index + 1}`, sourceRefs: [ref] }]
    }));
    clientFixture(TOKENHUB_BASE_URL, [{ type: "response.completed", response: {
      ...completedResponse, output: [{ type: "message", role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ items: wireItems }) }] }]
    } }]);
    const synthesizer = createStructuredWorkWeeklySynthesizer({
      profile: resolveWorkWeeklyProviderProfile("synthesizer", { WORK_REVIEW_WEEKLY_SYNTHESIZER_MODEL: "deepseek-v4-pro" })
    });
    const items = await synthesizer.synthesize({ accountId: "account_a", snapshot: workWeeklyTestSnapshot() });
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(new Set(items.flatMap((item) => item.claims.map((claim) => claim.id))).size).toBe(2);
    items.forEach((item, index) => {
      expect(item.text).toBe(wireItems[index].text);
      expect(item.claims[0]).toMatchObject({ text: wireItems[index].claims[0].text,
        claimType: wireItems[index].claims[0].claimType, sourceRefs: wireItems[index].claims[0].sourceRefs });
    });
  });

  it("does not repair missing, empty, oversized or non-string model IDs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const invalidId of [undefined, "", " ", "x".repeat(513), 123]) {
        const item = { ...finalAnswer.items[0], claims: [{ ...finalAnswer.items[0].claims[0],
          id: invalidId, sourceRefs: [WORK_WEEKLY_TEST_REFS.decision] }] };
        const fixture = clientFixture(TOKENHUB_BASE_URL, [{ type: "response.completed", response: {
          ...completedResponse, output: [{ type: "message", role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify({ items: [item] }) }] }]
        } }]);
        const synthesizer = createStructuredWorkWeeklySynthesizer({
          profile: resolveWorkWeeklyProviderProfile("synthesizer", { WORK_REVIEW_WEEKLY_SYNTHESIZER_MODEL: "deepseek-v4-pro" })
        });
        await expect(synthesizer.synthesize({ accountId: "account_a", snapshot: workWeeklyTestSnapshot() }))
          .rejects.toMatchObject({ code: "work_weekly_provider_schema_invalid" });
        expect(fixture.create).toHaveBeenCalledTimes(1);
      }
    } finally { consoleError.mockRestore(); }
  });

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
        schema: WorkWeeklySynthesizerResponseSchema,
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
