import OpenAI from "openai";
import { _iterSSEMessages } from "openai/core/streaming";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

const TOKENHUB_BASE_URL = "https://tokenhub.vision-intelligence.tech/v1";
export const THINKING_MODEL = "deepseek-v4-pro";

export function createThinkingTokenHubClient(input: {
  environment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}) {
  const env = input.environment;
  let configured: URL | undefined;
  try { configured = new URL(env.OPENAI_BASE_URL?.trim() ?? ""); } catch { /* Fail closed below. */ }
  if (!configured || !["http:", "https:"].includes(configured.protocol)
    || configured.hostname !== "tokenhub.vision-intelligence.tech"
    || configured.username || configured.password || configured.port || configured.search || configured.hash
    || !["/", "/v1", "/v1/"].includes(configured.pathname)) {
    throw new Error("Thinking TokenHub endpoint is not configured");
  }
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("Thinking TokenHub credential is not configured");
  return new OpenAI({
    apiKey,
    baseURL: TOKENHUB_BASE_URL,
    timeout: input.timeoutMs,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
    logLevel: "off",
    organization: null,
    project: null,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(env.OPENAI_AUTH_HEADER_MODE?.trim().toLowerCase() === "raw"
      ? { defaultHeaders: { Authorization: apiKey } } : {})
  });
}

/** Keep Thinking's strict four-field JSON contract; the shared JSON helper
 * injects an items/results root that belongs to other product contracts. */
export async function requestThinkingTokenHubText(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
) {
  const controller = new AbortController();
  try {
    signal.throwIfAborted();
    const response = await client.responses.create({
      model,
      stream: true,
      // The installed SDK predates TokenHub's adopted none wire value.
      reasoning: { effort: "none" } as unknown as NonNullable<
        Parameters<OpenAI["responses"]["create"]>[0]["reasoning"]
      >,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    }, {
      signal: AbortSignal.any([signal, controller.signal]),
      maxRetries: 0
    }).asResponse();
    // Reuse SDK framing without its legacy decoder's raw error logging.
    for await (const message of _iterSSEMessages(response, controller)) {
      signal.throwIfAborted();
      if (message.data.trim() === "[DONE]") break;
      if (message.event && message.event !== "error" && !message.event.startsWith("response.")) {
        throw new Error("Thinking Provider stream event is unsupported");
      }
      const event = JSON.parse(message.data) as ResponseStreamEvent;
      if (!event || typeof event !== "object" || typeof event.type !== "string"
        || (message.event && message.event !== event.type)) {
        throw new Error("Thinking Provider stream event is invalid");
      }
      if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
        throw new Error("Thinking Provider stream did not complete");
      }
      if (event.type === "response.completed") {
        const completed = event.response;
        if (!completed || completed.status !== "completed"
          || completed.error != null || completed.incomplete_details != null
          || !Array.isArray(completed.output)) {
          throw new Error("Thinking Provider stream completion is invalid");
        }
        const text = completed.output.flatMap((item) => (
          item?.type === "message" && item.role === "assistant" && Array.isArray(item.content)
            ? item.content.flatMap((part) => (
              part?.type === "output_text" && typeof part.text === "string" ? [part.text] : []
            ))
            : []
        )).join("").trim();
        if (!text) throw new Error("Thinking Provider answer is empty");
        // Only terminal assistant output is accepted, never deltas or reasoning.
        return text;
      }
    }
    throw new Error("Thinking Provider stream ended without completion");
  } finally {
    // Iterator cleanup runs before abort, including successful early return.
    controller.abort();
  }
}
