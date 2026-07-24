import type OpenAI from "openai";

export type QaWireApi = "chat" | "responses";

type ResponsesTextCandidate = {
  output_text?: unknown;
  output?: unknown;
};

type StreamEvent = {
  type?: unknown;
  delta?: unknown;
  text?: unknown;
  response?: {
    status?: unknown;
  };
};

type ChatStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
    finish_reason?: unknown;
  }>;
};

export class QaProviderStreamError extends Error {
  constructor(readonly code: "unsupported_stream" | "incomplete_stream" | "provider_stream_error") {
    super(`QA provider stream failed: ${code}`);
    this.name = "QaProviderStreamError";
  }
}

export function getQaWireApi(): QaWireApi {
  const rawWireApi = (process.env.OPENAI_QA_WIRE_API ?? process.env.OPENAI_WIRE_API ?? "")
    .trim()
    .toLowerCase();
  return rawWireApi === "responses" ? "responses" : "chat";
}

function textFromResponsesOutput(response: ResponsesTextCandidate) {
  const outputText = typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (outputText) return outputText;

  if (!Array.isArray(response.output)) return "";

  return response.output
    .flatMap((outputItem) => {
      const content = outputItem && typeof outputItem === "object" && "content" in outputItem
        ? (outputItem as { content?: unknown }).content
        : undefined;
      if (!Array.isArray(content)) return [];

      return content.flatMap((contentItem) => {
        if (!contentItem || typeof contentItem !== "object") return [];
        const text = (contentItem as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("")
    .trim();
}

function qaInput(systemPrompt: string, userPrompt: string) {
  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt }
  ];
}

export async function requestQaAnswerText(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userPrompt: string
) {
  if (getQaWireApi() === "responses") {
    const response = await client.responses.create({
      model,
      temperature: 0.2,
      input: qaInput(systemPrompt, userPrompt)
    });
    return textFromResponsesOutput(response as ResponsesTextCandidate);
  }

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: qaInput(systemPrompt, userPrompt)
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

function requireAsyncIterable(value: unknown): AsyncIterable<unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
  ) {
    throw new QaProviderStreamError("unsupported_stream");
  }
  return value as AsyncIterable<unknown>;
}

/**
 * Produces raw provider text deltas. Callers must quarantine these deltas until
 * the accumulated response has passed the normal QA validation pipeline.
 */
export async function* requestQaAnswerTextStream(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userPrompt: string
): AsyncGenerator<string> {
  if (getQaWireApi() === "responses") {
    const responseStream = await client.responses.create({
      model,
      temperature: 0.2,
      input: qaInput(systemPrompt, userPrompt),
      stream: true
    });

    let emittedText = false;
    let completed = false;
    for await (const rawEvent of requireAsyncIterable(responseStream)) {
      const event = rawEvent as StreamEvent;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        if (event.delta.length > 0) {
          emittedText = true;
          yield event.delta;
        }
        continue;
      }
      if (
        event.type === "response.output_text.done" &&
        !emittedText &&
        typeof event.text === "string" &&
        event.text.length > 0
      ) {
        emittedText = true;
        yield event.text;
        continue;
      }
      if (event.type === "response.incomplete" || event.response?.status === "incomplete") {
        throw new QaProviderStreamError("incomplete_stream");
      }
      if (event.type === "response.failed" || event.type === "error") {
        throw new QaProviderStreamError("provider_stream_error");
      }
      if (event.type === "response.completed") {
        if (event.response?.status !== undefined && event.response.status !== "completed") {
          throw new QaProviderStreamError("incomplete_stream");
        }
        completed = true;
      }
    }
    if (!completed) throw new QaProviderStreamError("incomplete_stream");
    return;
  }

  const chatStream = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: qaInput(systemPrompt, userPrompt),
    stream: true
  });

  let completed = false;
  for await (const rawChunk of requireAsyncIterable(chatStream)) {
    const chunk = rawChunk as ChatStreamChunk;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta?.content;
      if (typeof delta === "string" && delta.length > 0) yield delta;
      if (choice.finish_reason === "stop") completed = true;
      if (choice.finish_reason === "length") {
        throw new QaProviderStreamError("incomplete_stream");
      }
      if (choice.finish_reason === "content_filter") {
        throw new QaProviderStreamError("provider_stream_error");
      }
    }
  }
  if (!completed) throw new QaProviderStreamError("incomplete_stream");
}
