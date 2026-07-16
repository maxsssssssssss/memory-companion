import type OpenAI from "openai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { parseJsonObjectFromModelText, parseStructuredJsonResponse } from "./structured-json";

const Schema = z.object({ items: z.array(z.object({ value: z.string() })) });

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
      requestOptions: { timeout: 45_000, maxRetries: 1 }
    });

    expect(result).toEqual({ items: [{ value: "ok" }] });
    expect(parse).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        max_output_tokens: 3_000
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
      validationResult: "success"
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
      totalDurationMs: expect.any(Number)
    }));
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
});
