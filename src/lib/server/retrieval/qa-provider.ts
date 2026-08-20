import type OpenAI from "openai";

export type QaWireApi = "chat" | "responses";

export type QaProviderUsage = {
  outputTokenCount: number | null;
  totalTokenCount: number | null;
};

export type QaProviderRequestOptions = {
  wireApi?: QaWireApi;
  chatTemplateKwargs?: Record<string, boolean | number | string>;
  onUsage?: (usage: QaProviderUsage) => unknown;
  /** Internal cancellation propagated to the OpenAI-compatible HTTP request. */
  signal?: AbortSignal;
};

function throwIfProviderAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("QA Provider request aborted", "AbortError");
}

type ResponsesTextCandidate = {
  output_text?: unknown;
  output?: unknown;
  usage?: {
    output_tokens?: unknown;
    total_tokens?: unknown;
  };
};

type StreamEvent = {
  type?: unknown;
  delta?: unknown;
  text?: unknown;
  response?: {
    status?: unknown;
    usage?: {
      output_tokens?: unknown;
      total_tokens?: unknown;
    };
  };
};

type ChatStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    completion_tokens?: unknown;
    total_tokens?: unknown;
  } | null;
};

type ChatResponseCandidate = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    completion_tokens?: unknown;
    total_tokens?: unknown;
  } | null;
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

function usageCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function notifyUsage(
  observer: QaProviderRequestOptions["onUsage"],
  usage: QaProviderUsage
) {
  if (!observer || (usage.outputTokenCount === null && usage.totalTokenCount === null)) return;
  try {
    const result = observer(usage);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Metrics are evaluation-only and must never alter QA generation.
  }
}

function chatRequestBody(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: QaProviderRequestOptions,
  stream: boolean
) {
  return {
    model,
    temperature: 0.2,
    messages: qaInput(systemPrompt, userPrompt),
    ...(stream ? { stream: true as const } : {}),
    ...(stream && options.onUsage
      ? { stream_options: { include_usage: true } }
      : {}),
    ...(options.chatTemplateKwargs
      ? { chat_template_kwargs: options.chatTemplateKwargs }
      : {})
  };
}

export async function requestQaAnswerText(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: QaProviderRequestOptions = {}
) {
  throwIfProviderAborted(options.signal);
  if ((options.wireApi ?? getQaWireApi()) === "responses") {
    const body = {
      model,
      temperature: 0.2,
      input: qaInput(systemPrompt, userPrompt)
    };
    const response = await (options.signal
      ? client.responses.create(body, { signal: options.signal })
      : client.responses.create(body));
    throwIfProviderAborted(options.signal);
    const candidate = response as ResponsesTextCandidate;
    notifyUsage(options.onUsage, {
      outputTokenCount: usageCount(candidate.usage?.output_tokens),
      totalTokenCount: usageCount(candidate.usage?.total_tokens)
    });
    return textFromResponsesOutput(candidate);
  }

  const body = chatRequestBody(model, systemPrompt, userPrompt, options, false);
  const response = await (options.signal
    ? client.chat.completions.create(body, { signal: options.signal })
    : client.chat.completions.create(body));
  throwIfProviderAborted(options.signal);
  const candidate = response as ChatResponseCandidate;
  notifyUsage(options.onUsage, {
    outputTokenCount: usageCount(candidate.usage?.completion_tokens),
    totalTokenCount: usageCount(candidate.usage?.total_tokens)
  });
  const content = candidate.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
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
  userPrompt: string,
  options: QaProviderRequestOptions = {}
): AsyncGenerator<string> {
  throwIfProviderAborted(options.signal);
  if ((options.wireApi ?? getQaWireApi()) === "responses") {
    const body = {
      model,
      temperature: 0.2,
      input: qaInput(systemPrompt, userPrompt),
      stream: true as const
    };
    const responseStream = await (options.signal
      ? client.responses.create(body, { signal: options.signal })
      : client.responses.create(body));

    let emittedText = false;
    let completed = false;
    for await (const rawEvent of requireAsyncIterable(responseStream)) {
      throwIfProviderAborted(options.signal);
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
        notifyUsage(options.onUsage, {
          outputTokenCount: usageCount(event.response?.usage?.output_tokens),
          totalTokenCount: usageCount(event.response?.usage?.total_tokens)
        });
        completed = true;
      }
    }
    if (!completed) throw new QaProviderStreamError("incomplete_stream");
    return;
  }

  const body = chatRequestBody(model, systemPrompt, userPrompt, options, true);
  const chatStream = await (options.signal
    ? client.chat.completions.create(body, { signal: options.signal })
    : client.chat.completions.create(body));

  let completed = false;
  for await (const rawChunk of requireAsyncIterable(chatStream)) {
    throwIfProviderAborted(options.signal);
    const chunk = rawChunk as ChatStreamChunk;
    notifyUsage(options.onUsage, {
      outputTokenCount: usageCount(chunk.usage?.completion_tokens),
      totalTokenCount: usageCount(chunk.usage?.total_tokens)
    });
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        yield delta;
      }
      if (choice.finish_reason === "stop") completed = true;
      if (choice.finish_reason === "length") {
        throw new QaProviderStreamError("incomplete_stream");
      }
      if (choice.finish_reason === "content_filter") {
        throw new QaProviderStreamError("provider_stream_error");
      }
    }
  }
  throwIfProviderAborted(options.signal);
  if (!completed) throw new QaProviderStreamError("incomplete_stream");
}
