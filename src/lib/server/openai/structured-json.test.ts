// @vitest-environment node
import OpenAI from "openai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { jsonOnlyInstruction, parseJsonObjectFromModelText, parseStructuredJsonResponse } from "./structured-json";

const Schema = z.object({ items: z.array(z.object({ value: z.string() })) });

function streamingClient(events: unknown[], beforeEvent?: (index: number) => void) {
  const controller = new AbortController();
  const closed = vi.fn();
  const tail = vi.fn();
  const create = vi.fn().mockImplementation((_request, options: { signal: AbortSignal }) => {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    return {
      async asResponse() {
        let index = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(reader) {
            if (index >= events.length) {
              tail();
              closed();
              reader.close();
              return;
            }
            beforeEvent?.(index);
            reader.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events[index])}\n\n`));
            index += 1;
          },
          cancel() { closed(); }
        }, { highWaterMark: 0 });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
    };
  });
  const parse = vi.fn();
  const withOptions = vi.fn();
  const client = { responses: { create, parse }, withOptions } as unknown as OpenAI;
  withOptions.mockReturnValue(client);
  return { client, create, parse, withOptions, controller, closed, tail };
}

const completedEvent = (overrides: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: {
    status: "completed", error: null, incomplete_details: null,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"items":[{"value":"final"}]}' }] }],
    ...overrides
  }
});

const streamingInput = {
  model: "test-model", name: "test_schema", schema: Schema,
  requestInput: "input", jsonInstruction: "Return JSON.", mode: "json" as const, stream: true
};

describe("JSON root field instruction", () => {
  it("preserves the legacy items instruction exactly", () => {
    expect(jsonOnlyInstruction("Return JSON.")).toBe("Return JSON.\n只输出一个合法 JSON 对象，不要输出 Markdown，不要输出解释文字。JSON 根对象必须包含 items 字段。");
  });

  it.each(["text", "messages"])("uses the results contract in the actual %s request", async (kind) => {
    const fixture = streamingClient([completedEvent({ output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"results":[]}' }] }
    ] })]);
    const result = await parseStructuredJsonResponse({ ...streamingInput, client: fixture.client,
      schema: z.object({ results: z.array(z.unknown()) }).strict(), jsonRootField: "results",
      requestInput: kind === "text" ? "input" : [{ role: "user", content: "input" }]
    });
    expect(result).toEqual({ results: [] });
    const request = fixture.create.mock.calls[0]![0];
    expect(JSON.stringify(request.input)).toContain("JSON 根对象必须包含 results 字段。");
    expect(JSON.stringify(request.input)).not.toContain("JSON 根对象必须包含 items 字段。");
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });
});

describe("evaluation answer text observation", () => {
  it.each([
    ["schema", '  {"items":[{"value":42}]}\n', "success"],
    ["JSON", '  {"items":[\n', "failed"]
  ])("retains exact completed answer on %s failure without logging it", async (_label, text, parseResult) => {
    const onResponseText = vi.fn();
    const onDiagnostics = vi.fn();
    const fixture = streamingClient([completedEvent({ output: [
      { type: "reasoning", content: [{ type: "output_text", text: "PRIVATE_REASONING" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] }
    ] })]);
    await expect(parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, onResponseText, onDiagnostics
    })).rejects.toBeDefined();
    expect(onResponseText).toHaveBeenCalledExactlyOnceWith({ rawResponse: text, state: "complete" });
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ parseResult }));
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain(text);
    expect(JSON.stringify(onResponseText.mock.calls)).not.toContain("PRIVATE_REASONING");
    expect(fixture.create).toHaveBeenCalledOnce();
  });

  it("retains partial answer deltas on interrupted streams, never reasoning deltas", async () => {
    const onResponseText = vi.fn();
    const fixture = streamingClient([
      { type: "response.reasoning_text.delta", delta: "PRIVATE_REASONING" },
      { type: "response.output_text.delta", delta: ' {"items":' },
      { type: "response.output_text.delta", delta: "[" }
    ]);
    await expect(parseStructuredJsonResponse({ ...streamingInput, client: fixture.client, onResponseText }))
      .rejects.toMatchObject({ code: "incomplete_response" });
    expect(onResponseText).toHaveBeenCalledExactlyOnceWith({ rawResponse: ' {"items":[', state: "partial" });
  });

  it("uses partial terminal assistant text when an incomplete response has no deltas", async () => {
    const onResponseText = vi.fn();
    const fixture = streamingClient([{ type: "response.incomplete", response: {
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }]
    } }]);
    await expect(parseStructuredJsonResponse({ ...streamingInput, client: fixture.client, onResponseText }))
      .rejects.toMatchObject({ code: "incomplete_response" });
    expect(onResponseText).toHaveBeenCalledExactlyOnceWith({ rawResponse: "partial", state: "partial" });
  });

  it("records no answer on an empty stream without manufacturing content", async () => {
    const onResponseText = vi.fn();
    const fixture = streamingClient([]);
    await expect(parseStructuredJsonResponse({ ...streamingInput, client: fixture.client, onResponseText }))
      .rejects.toMatchObject({ code: "incomplete_response" });
    expect(onResponseText).toHaveBeenCalledExactlyOnceWith({ rawResponse: "", state: "partial" });
  });

  it("does not change valid output when the optional observer throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fixture = streamingClient([completedEvent()]);
      await expect(parseStructuredJsonResponse({
        ...streamingInput, client: fixture.client,
        onResponseText() { throw new Error("PRIVATE_CAPTURE_ERROR"); }
      })).resolves.toEqual({ items: [{ value: "final" }] });
      expect(warn).toHaveBeenCalledExactlyOnceWith("[provider-response-text-observer] capture_failed");
    } finally { warn.mockRestore(); }
  });
});

describe("parseStructuredJsonResponse", () => {
  it.each([
    ["code fence", "```json\n{\"items\":[{\"value\":\"ok\"}]}\n```"],
    ["surrounding prose", "Here is the result: {\"items\":[{\"value\":\"ok\"}]} done."],
    ["trailing comma", "{\"items\":[{\"value\":\"ok\"},],}"]
  ])("extracts conservative JSON from %s", (_label, text) => {
    expect(parseJsonObjectFromModelText(text)).toEqual({ items: [{ value: "ok" }] });
  });

  it("joins multiple Responses API content blocks before parsing", async () => {
    const create = vi.fn().mockResolvedValue({
      output: [{ content: [{ text: "prefix " }, { text: '{\"items\":[{\"value\":\"ok\"}]}' }] }]
    });
    const client = { responses: { parse: vi.fn(), create } } as unknown as OpenAI;

    await expect(parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json"
    })).resolves.toEqual({ items: [{ value: "ok" }] });
  });

  it.each([
    ["truncated", '{"items":[{"value":"ok"}'],
    ["non-json", "plain text only"]
  ])("classifies %s model output without inventing fields", async (_label, outputText) => {
    const client = {
      responses: { parse: vi.fn(), create: vi.fn().mockResolvedValue({ output_text: outputText }) }
    } as unknown as OpenAI;

    await expect(parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json"
    })).rejects.toMatchObject({ code: _label === "truncated" ? "incomplete_json" : "no_json" });
  });

  it("uses one plain JSON Responses request with request-level limits in json mode", async () => {
    const parse = vi.fn();
    const create = vi.fn().mockResolvedValue({
      output_text: JSON.stringify({ items: [{ value: "ok" }] })
    });
    const client = { responses: { parse, create } } as unknown as OpenAI;

    const result = await parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: [{ role: "user", content: "input" }],
      jsonInstruction: "Return JSON.",
      mode: "json",
      maxOutputTokens: 3_000,
      reasoning: { effort: "minimal" },
      requestOptions: { timeout: 45_000, maxRetries: 1 }
    });

    expect(result).toEqual({ items: [{ value: "ok" }] });
    expect(parse).not.toHaveBeenCalled();
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("stream");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        max_output_tokens: 3_000,
        reasoning: { effort: "minimal" }
      }),
      { timeout: 45_000, maxRetries: 1 }
    );
  });

  it("reports response completion, parse, validation and total timing for JSON success", async () => {
    const onDiagnostics = vi.fn();
    const client = {
      responses: {
        parse: vi.fn(),
        create: vi.fn().mockResolvedValue({
          status: "completed",
          usage: { input_tokens: 41, output_tokens: 17, total_tokens: 58 },
          output_text: JSON.stringify({ items: [{ value: "ok" }] })
        })
      }
    } as unknown as OpenAI;

    await parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json",
      onDiagnostics
    });

    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      responseStatus: "completed",
      responseTextLength: expect.any(Number),
      responseCompleteDurationMs: expect.any(Number),
      parseDurationMs: expect.any(Number),
      validationDurationMs: expect.any(Number),
      totalDurationMs: expect.any(Number),
      parseResult: "success",
      validationResult: "success",
      inputTokens: 41,
      outputTokens: 17,
      totalTokens: 58
    }));
  });

  it("reports parse failure before validation starts", async () => {
    const onDiagnostics = vi.fn();
    const client = {
      responses: { parse: vi.fn(), create: vi.fn().mockResolvedValue({ output_text: "not json" }) }
    } as unknown as OpenAI;

    await expect(parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json",
      onDiagnostics
    })).rejects.toMatchObject({ code: "no_json" });

    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      parseResult: "failed",
      validationResult: "not_started",
      parseDurationMs: expect.any(Number),
      totalDurationMs: expect.any(Number)
    }));
  });

  it("reports validation failure after JSON parsing succeeds", async () => {
    const onDiagnostics = vi.fn();
    const client = {
      responses: {
        parse: vi.fn(),
        create: vi.fn().mockResolvedValue({ output_text: JSON.stringify({ items: [{ value: 123 }] }) })
      }
    } as unknown as OpenAI;

    await expect(parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json",
      onDiagnostics
    })).rejects.toBeInstanceOf(z.ZodError);

    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      parseResult: "success",
      validationResult: "failed",
      validationDurationMs: expect.any(Number),
      totalDurationMs: expect.any(Number),
      validationIssueCount: 1,
      validationIssues: [
        {
          path: "items[0].value",
          code: "invalid_type",
          message: "Invalid value type"
        }
      ],
      validationIssueSummary: [{ code: "invalid_type", count: 1 }],
      validationIssuesTruncated: false
    }));
  });

  it("exposes exact raw JSON only through the validation-failure capture hook", async () => {
    const rawResponse = '{"items":[{"value":123,"private":"raw-marker"}]}';
    const onValidationFailureRawResponse = vi.fn();
    const client = {
      responses: {
        parse: vi.fn(),
        create: vi.fn().mockResolvedValue({ output_text: rawResponse })
      }
    } as unknown as OpenAI;

    await expect(parseStructuredJsonResponse({
      client,
      model: "capture-model",
      name: "capture_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json",
      onValidationFailureRawResponse
    })).rejects.toBeInstanceOf(z.ZodError);

    expect(onValidationFailureRawResponse).toHaveBeenCalledOnce();
    expect(onValidationFailureRawResponse).toHaveBeenCalledWith(expect.objectContaining({
      rawResponse,
      model: "capture-model",
      schemaName: "capture_schema",
      validationIssueCount: 1,
      validationIssues: [
        { path: "items[0].value", code: "invalid_type", message: "Invalid value type" }
      ]
    }));
  });

  it("does not invoke the raw hook for success or JSON parse failure", async () => {
    const onValidationFailureRawResponse = vi.fn();
    const successClient = {
      responses: {
        parse: vi.fn(),
        create: vi.fn().mockResolvedValue({ output_text: '{"items":[{"value":"ok"}]}' })
      }
    } as unknown as OpenAI;
    const parseFailureClient = {
      responses: { parse: vi.fn(), create: vi.fn().mockResolvedValue({ output_text: "not json" }) }
    } as unknown as OpenAI;

    await parseStructuredJsonResponse({
      client: successClient,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json",
      onValidationFailureRawResponse
    });
    await expect(parseStructuredJsonResponse({
      client: parseFailureClient,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json",
      onValidationFailureRawResponse
    })).rejects.toMatchObject({ code: "no_json" });

    expect(onValidationFailureRawResponse).not.toHaveBeenCalled();
  });

  it("keeps the original Zod failure when the capture hook fails", async () => {
    const client = {
      responses: {
        parse: vi.fn(),
        create: vi.fn().mockResolvedValue({ output_text: '{"items":[{"value":123}]}' })
      }
    } as unknown as OpenAI;
    const onValidationFailureRawResponse = vi.fn().mockRejectedValue(new Error("capture storage unavailable"));

    await expect(parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json",
      onValidationFailureRawResponse
    })).rejects.toBeInstanceOf(z.ZodError);
    expect(onValidationFailureRawResponse).toHaveBeenCalledOnce();
  });

  it("limits validation issue detail to ten entries and reports truncation", async () => {
    const onDiagnostics = vi.fn();
    const client = {
      responses: {
        parse: vi.fn(),
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            items: Array.from({ length: 12 }, (_, value) => ({ value }))
          })
        })
      }
    } as unknown as OpenAI;

    await expect(parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: Schema,
      requestInput: "input",
      jsonInstruction: "Return JSON.",
      mode: "json",
      onDiagnostics
    })).rejects.toBeInstanceOf(z.ZodError);

    const diagnostics = onDiagnostics.mock.calls.at(-1)?.[0];
    expect(diagnostics.validationIssueCount).toBe(12);
    expect(diagnostics.validationIssues).toHaveLength(10);
    expect(diagnostics.validationIssues.at(-1)?.path).toBe("items[9].value");
    expect(diagnostics.validationIssueSummary).toEqual([{ code: "invalid_type", count: 12 }]);
    expect(diagnostics.validationIssuesTruncated).toBe(true);
  });

  it("does not retry with a JSON request after structured mode is aborted", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const parse = vi.fn().mockRejectedValue(abortError);
    const create = vi.fn();
    const client = { responses: { parse, create } } as unknown as OpenAI;

    await expect(
      parseStructuredJsonResponse({
        client,
        model: "test-model",
        name: "test_schema",
        schema: Schema,
        requestInput: [{ role: "user", content: "input" }],
        jsonInstruction: "Return JSON.",
        mode: "auto"
      })
    ).rejects.toBe(abortError);

    expect(create).not.toHaveBeenCalled();
  });

  it("normalizes parsed JSON before strict schema validation", async () => {
    const parse = vi.fn();
    const create = vi.fn().mockResolvedValue({
      output_text: JSON.stringify({ items: [{ value: "ok" }] })
    });
    const client = { responses: { parse, create } } as unknown as OpenAI;

    const result = await parseStructuredJsonResponse({
      client,
      model: "test-model",
      name: "test_schema",
      schema: z.object({ items: z.array(z.object({ value: z.array(z.string()) })) }),
      requestInput: [{ role: "user", content: "input" }],
      jsonInstruction: "Return JSON.",
      mode: "json",
      normalize: (value) => {
        const document = value as { items: Array<{ value: unknown }> };
        return {
          items: document.items.map((item) => ({
            value: typeof item.value === "string" ? [item.value] : item.value
          }))
        };
      }
    });

    expect(result).toEqual({ items: [{ value: ["ok"] }] });
  });

  it("validates only the completed stream response and closes without waiting for further events", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fixture = streamingClient([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: '{"items":[{"value":"untrusted-delta"}]}' },
      completedEvent({
        reasoning: { effort: "medium" },
        usage: { input_tokens: 41, output_tokens: 17, total_tokens: 58, output_tokens_details: { reasoning_tokens: 12 } }
      }),
      { type: "error", message: "must-never-be-consumed-after-completion" }
    ], (index) => { now = 1_000 + (index + 1) * 10; });
    const onDiagnostics = vi.fn();
    const normalize = vi.fn((value: unknown) => {
      const document = value as z.infer<typeof Schema>;
      return { items: document.items.map((item) => ({ value: item.value.toUpperCase() })) };
    });
    try {
      await expect(parseStructuredJsonResponse({
        ...streamingInput, client: fixture.client, maxOutputTokens: 4_000,
        requestOptions: { timeout: 90_000, maxRetries: 4 }, normalize, onDiagnostics
      })).resolves.toEqual({ items: [{ value: "FINAL" }] });
      expect(normalize).toHaveBeenCalledExactlyOnceWith({ items: [{ value: "final" }] });
      expect(fixture.parse).not.toHaveBeenCalled();
      expect(fixture.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ stream: true, max_output_tokens: 4_000 }),
        expect.objectContaining({ timeout: 90_000, maxRetries: 0, signal: expect.any(AbortSignal) })
      );
      expect(fixture.withOptions).toHaveBeenCalledWith({ logLevel: "off", maxRetries: 0 });
      expect(fixture.controller.signal.aborted).toBe(true);
      expect(fixture.closed).toHaveBeenCalledOnce();
      expect(fixture.tail).not.toHaveBeenCalled();
      expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
        firstEventMs: 10, firstTextDeltaMs: 20, responseCompleteDurationMs: 30,
        parseResult: "success", validationResult: "success", reasoningEffort: "medium", reasoningTokens: 12
      }));
      expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("untrusted-delta");
    } finally { clock.mockRestore(); }
  });

  it.each([
    ["empty stream", []],
    ["complete JSON delta without terminal event", [{ type: "response.output_text.delta", delta: '{"items":[{"value":"delta"}]}' }]],
    ["failed event", [{ type: "response.failed", response: completedEvent().response }]],
    ["incomplete event", [{ type: "response.incomplete", response: completedEvent().response }]],
    ["error event", [{ type: "error", message: "private-error-body" }]],
    ["missing status", [completedEvent({ status: undefined })]],
    ["incomplete status", [completedEvent({ status: "incomplete" })]],
    ["completed with error", [completedEvent({ error: { message: "private-error-body" } })]],
    ["completed with incomplete details", [completedEvent({ incomplete_details: {} })]],
    ["missing terminal response", [{ type: "response.completed" }]]
  ])("rejects %s before parsing and never falls back", async (_label, events) => {
    const fixture = streamingClient(events);
    const onDiagnostics = vi.fn();
    const onValidationFailureRawResponse = vi.fn();
    const failure = await parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, onDiagnostics, onValidationFailureRawResponse
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "incomplete_response" });
    expect(String(failure)).not.toContain("private-error-body");
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.parse).not.toHaveBeenCalled();
    expect(fixture.controller.signal.aborted).toBe(true);
    expect(fixture.closed).toHaveBeenCalledOnce();
    expect(onValidationFailureRawResponse).not.toHaveBeenCalled();
    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      responseTextLength: 0, parseResult: "not_started", validationResult: "not_started"
    }));
  });

  it.each([
    ["truncated final JSON", completedEvent({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"items":[' }] }] }), "incomplete_json"],
    ["schema-invalid final JSON", completedEvent({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"items":[{"value":123}]}' }] }] }), undefined]
  ])("applies existing parsing and schema validation to %s", async (_label, event, code) => {
    const fixture = streamingClient([event]);
    const onDiagnostics = vi.fn();
    const promise = parseStructuredJsonResponse({ ...streamingInput, client: fixture.client, onDiagnostics });
    if (code) await expect(promise).rejects.toMatchObject({ code });
    else await expect(promise).rejects.toBeInstanceOf(z.ZodError);
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.controller.signal.aborted).toBe(true);
    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      parseResult: code ? "failed" : "success", validationResult: code ? "not_started" : "failed"
    }));
  });

  it.each([
    ["response.incomplete", "incomplete", "max_output_tokens", undefined],
    ["response.failed", "failed", undefined, "server_error"]
  ])("retains terminal %s metadata without accepting or capturing its unfinished output", async (type, status, reason, providerErrorCode) => {
    const fixture = streamingClient([{ type, response: {
      status, incomplete_details: reason ? { reason } : null,
      error: providerErrorCode ? { code: providerErrorCode, message: "PRIVATE_PROVIDER_ERROR" } : null,
      reasoning: { effort: "low" },
      usage: { input_tokens: 850, output_tokens: 4_000, total_tokens: 4_850, output_tokens_details: { reasoning_tokens: 3_980 } },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "PRIVATE_UNFINISHED_OUTPUT" }] }]
    } }]);
    const onDiagnostics = vi.fn();
    const onValidationFailureRawResponse = vi.fn();
    await expect(parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, onDiagnostics, onValidationFailureRawResponse
    })).rejects.toMatchObject({ code: "incomplete_response" });
    expect(onDiagnostics).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      responseStatus: status, ...(reason ? { incompleteReason: reason } : {}),
      ...(providerErrorCode ? { providerErrorCode } : {}),
      inputTokens: 850, outputTokens: 4_000, totalTokens: 4_850, reasoningTokens: 3_980, reasoningEffort: "low",
      responseCompleteDurationMs: expect.any(Number), totalDurationMs: expect.any(Number),
      responseTextLength: 0, parseResult: "not_started", validationResult: "not_started"
    }));
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("PRIVATE_");
    expect(onValidationFailureRawResponse).not.toHaveBeenCalled();
    expect(fixture.create).toHaveBeenCalledOnce();
  });

  it("redacts unknown terminal status, incomplete reason and error fields before diagnostics", async () => {
    const fixture = streamingClient([{ type: "response.incomplete", response: {
      status: "PRIVATE_STATUS", incomplete_details: { reason: "PRIVATE_REASON" },
      error: { code: "PRIVATE_ERROR_CODE", message: "PRIVATE_ERROR_MESSAGE" },
      reasoning: { effort: "PRIVATE_EFFORT" },
      usage: { input_tokens: "PRIVATE_TOKENS", output_tokens: -1 },
      output_text: "PRIVATE_BODY"
    } }]);
    const onDiagnostics = vi.fn();
    const failure = await parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, onDiagnostics
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "incomplete_response" });
    expect(onDiagnostics).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      responseStatus: "other", incompleteReason: "other", responseTextLength: 0
    }));
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("PRIVATE_");
    expect(String(failure)).not.toContain("PRIVATE_");
    expect(onDiagnostics.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
  });

  it("selects the final assistant answer when DeepSeek reasoning and a top-level alias contain different valid JSON", async () => {
    const event = completedEvent({
      output_text: '{"items":[{"value":"TOP_LEVEL_ALIAS"}]}',
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: 'Draft: {"items":[{"value":"PRIVATE_REASONING_DRAFT"}]}' }] },
        { type: "message", role: "system", content: [{ type: "output_text", text: '{"items":[{"value":"SYSTEM_MESSAGE"}]}' }] },
        ...completedEvent().response.output
      ]
    });
    const fixture = streamingClient([event]);
    const onDiagnostics = vi.fn();
    const normalize = vi.fn((value: unknown) => value);
    await expect(parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, normalize, onDiagnostics
    })).resolves.toEqual({ items: [{ value: "final" }] });
    expect(normalize).toHaveBeenCalledExactlyOnceWith({ items: [{ value: "final" }] });
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toMatch(/PRIVATE_REASONING_DRAFT|TOP_LEVEL_ALIAS|SYSTEM_MESSAGE/u);
  });

  it.each([
    ["reasoning only", []],
    ["assistant refusal", [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "PRIVATE_REFUSAL" }] }]],
    ["assistant reasoning content", [{ type: "message", role: "assistant", content: [{ type: "reasoning_text", text: '{"items":[{"value":"PRIVATE_REASONING_DRAFT"}]}' }] }]],
    ["non-assistant message", [{ type: "message", role: "user", content: [{ type: "output_text", text: '{"items":[{"value":"USER_MESSAGE"}]}' }] }]]
  ])("does not substitute reasoning JSON for %s", async (_label, messages) => {
    const fixture = streamingClient([completedEvent({
      output_text: '{"items":[{"value":"TOP_LEVEL_ALIAS"}]}',
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: '{"items":[{"value":"PRIVATE_REASONING_DRAFT"}]}' }] },
        ...messages
      ]
    })]);
    const normalize = vi.fn();
    const onDiagnostics = vi.fn();
    await expect(parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, normalize, onDiagnostics
    })).rejects.toMatchObject({ code: "empty_response" });
    expect(normalize).not.toHaveBeenCalled();
    expect(onDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      responseTextLength: 0, parseResult: "failed", validationResult: "not_started"
    }));
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toMatch(/PRIVATE_|TOP_LEVEL_ALIAS|USER_MESSAGE/u);
  });

  it("does not accept reasoning JSON when the final assistant answer fails schema validation", async () => {
    const fixture = streamingClient([completedEvent({ output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: '{"items":[{"value":"PRIVATE_REASONING_DRAFT"}]}' }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"items":[{"value":123}]}' }] }
    ] })]);
    const onValidationFailureRawResponse = vi.fn();
    await expect(parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, onValidationFailureRawResponse
    })).rejects.toBeInstanceOf(z.ZodError);
    expect(onValidationFailureRawResponse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      rawResponse: '{"items":[{"value":123}]}'
    }));
    expect(JSON.stringify(onValidationFailureRawResponse.mock.calls)).not.toContain("PRIVATE_REASONING_DRAFT");
  });

  it.each([
    ["response.failed", "server_error", "server_error"],
    ["response.failed", "rate_limit_exceeded", "rate_limit_exceeded"],
    ["response.failed", "invalid_prompt", "invalid_prompt"],
    ["response.failed", "PRIVATE_ERROR_PAYLOAD", "other"],
    ["response.failed", "server_error ", "other"],
    ["response.failed", "SERVER_ERROR", "other"],
    ["response.failed", null, "other"],
    ["error", "server_error", "server_error"],
    ["error", "rate_limit_exceeded", "rate_limit_exceeded"],
    ["error", "invalid_prompt", "invalid_prompt"],
    ["error", "PRIVATE_ERROR_PAYLOAD", "other"],
    ["error", { text: "PRIVATE_ERROR_PAYLOAD" }, "other"],
    ["error", undefined, "other"]
  ])("records only an exact safe provider error code for %s (%j)", async (type, code, expectedCode) => {
    const detail = { code, message: "PRIVATE_ERROR_PAYLOAD", param: "PRIVATE_ERROR_PAYLOAD" };
    const event = type === "error" ? { type, ...detail } : { type, response: { status: "failed", error: detail } };
    const fixture = streamingClient([event]);
    const onDiagnostics = vi.fn();
    const normalize = vi.fn();
    const onValidationFailureRawResponse = vi.fn();
    const failure = await parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, onDiagnostics, normalize, onValidationFailureRawResponse
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "incomplete_response" });
    expect(String(failure)).not.toContain("PRIVATE_ERROR_PAYLOAD");
    expect(onDiagnostics).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      providerErrorCode: expectedCode, responseTextLength: 0,
      parseResult: "not_started", validationResult: "not_started"
    }));
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("PRIVATE_ERROR_PAYLOAD");
    expect(normalize).not.toHaveBeenCalled();
    expect(onValidationFailureRawResponse).not.toHaveBeenCalled();
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.parse).not.toHaveBeenCalled();
    expect(fixture.closed).toHaveBeenCalledOnce();
  });

  it.each(["before dispatch", "before completion"])("rejects parent abort %s without accepting late output", async (phase) => {
    const parent = new AbortController();
    if (phase === "before dispatch") parent.abort();
    const fixture = streamingClient([completedEvent()], () => parent.abort());
    await expect(parseStructuredJsonResponse({
      ...streamingInput, client: fixture.client, requestOptions: { signal: parent.signal }
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.create).toHaveBeenCalledTimes(phase === "before dispatch" ? 0 : 1);
    expect(fixture.parse).not.toHaveBeenCalled();
    if (phase !== "before dispatch") expect(fixture.controller.signal.aborted).toBe(true);
  });

  it("rejects SDK abort that ends iteration without a terminal event", async () => {
    const parent = new AbortController();
    const controller = new AbortController();
    const create = vi.fn().mockImplementation((_request, options: { signal: AbortSignal }) => {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      return { async asResponse() {
        const body = new ReadableStream({
          start(reader) {
            reader.enqueue(new TextEncoder().encode('data: {"type":"response.in_progress"}\n\n'));
            parent.abort();
            reader.close();
          }
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      } };
    });
    const client = { responses: { create }, withOptions: vi.fn() } as unknown as OpenAI;
    vi.mocked(client.withOptions).mockReturnValue(client);
    await expect(parseStructuredJsonResponse({
      ...streamingInput, client, requestOptions: { signal: parent.signal }
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });

  it.each([
    ["default event", "data: private-invalid-json\n\n"],
    ["legacy thread event", "event: thread.message.delta\ndata: PRIVATE_INVALID\n\n"]
  ])("never logs malformed SDK %s content and classifies it as an incomplete transport", async (_label, data) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValue(new Response(data, {
      headers: { "content-type": "text/event-stream" }
    }));
    const client = new OpenAI({ apiKey: "fixture", baseURL: "https://fixture.invalid", fetch, logLevel: "debug" });
    try {
      await expect(parseStructuredJsonResponse({ ...streamingInput, client })).rejects.toMatchObject({ code: "incomplete_response" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it("aborts a real SDK SSE body immediately at completion even when the body never closes", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(completedEvent())}\n\n`)); },
      cancel
    });
    const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const client = new OpenAI({ apiKey: "fixture", baseURL: "https://fixture.invalid", fetch });
    await expect(parseStructuredJsonResponse({ ...streamingInput, client })).resolves.toEqual({ items: [{ value: "final" }] });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not expose unrecognized reasoning effort or invalid token counts", async () => {
    const fixture = streamingClient([completedEvent({
      reasoning: { effort: "private-model-text" },
      usage: { output_tokens_details: { reasoning_tokens: -1 } }
    })]);
    const onDiagnostics = vi.fn();
    await parseStructuredJsonResponse({ ...streamingInput, client: fixture.client, onDiagnostics });
    const diagnostics = onDiagnostics.mock.calls[0]?.[0];
    expect(diagnostics).not.toHaveProperty("reasoningEffort");
    expect(diagnostics).not.toHaveProperty("reasoningTokens");
    expect(JSON.stringify(diagnostics)).not.toContain("private-model-text");
  });

  it("requires explicit json mode for streaming so auto cannot create a fallback request", async () => {
    const fixture = streamingClient([completedEvent()]);
    await expect(parseStructuredJsonResponse({ ...streamingInput, client: fixture.client, mode: "auto" })).rejects.toThrow("explicit json mode");
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.parse).not.toHaveBeenCalled();
  });
});
