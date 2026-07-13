import type OpenAI from "openai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { parseStructuredJsonResponse } from "./structured-json";

const Schema = z.object({ items: z.array(z.object({ value: z.string() })) });

describe("parseStructuredJsonResponse", () => {
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
});
