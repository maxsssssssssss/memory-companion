import OpenAI from "openai";
import { z } from "zod";

import { parseStructuredJsonResponse } from "./structured-json";

export const TOKENHUB_DEEPSEEK_FLASH_BASE_URL = "https://tokenhub.vision-intelligence.tech/v1";

/** The three Flash adapters share only this wire transport. Their source and
 * output validators remain product-owned and run after the completed response. */
export async function requestTokenHubDeepseekFlashJson(input: {
  apiKey: string;
  timeoutMs: number;
  maxOutputTokens: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
  jsonRootField?: "items" | "results";
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const client = new OpenAI({
    apiKey: input.apiKey,
    baseURL: TOKENHUB_DEEPSEEK_FLASH_BASE_URL,
    timeout: input.timeoutMs,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
    logLevel: "off",
    organization: null,
    project: null,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(process.env.OPENAI_AUTH_HEADER_MODE?.trim().toLowerCase() === "raw"
      ? { defaultHeaders: { Authorization: input.apiKey } } : {})
  });
  let responseText = "";
  await parseStructuredJsonResponse({
    client, model: "deepseek-v4-flash", name: "tokenhub_deepseek_flash_json",
    schema: z.record(z.unknown()), mode: "json", stream: true,
    requestInput: input.messages,
    jsonInstruction: "Return only the JSON object specified in the system and user instructions.",
    jsonRootField: input.jsonRootField,
    maxOutputTokens: input.maxOutputTokens,
    reasoning: { effort: "none" } as unknown as NonNullable<Parameters<typeof parseStructuredJsonResponse>[0]["reasoning"]>,
    requestOptions: { timeout: input.timeoutMs, maxRetries: 0,
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]) : AbortSignal.timeout(input.timeoutMs) },
    onResponseText: (value) => { responseText = value.rawResponse; }
  });
  return responseText;
}
