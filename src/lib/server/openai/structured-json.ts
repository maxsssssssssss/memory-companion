import type OpenAI from "openai";
import { _iterSSEMessages } from "openai/core/streaming";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseError, ResponseStreamEvent } from "openai/resources/responses/responses";
import { ZodError, type z } from "zod";

type ResponseInput = Parameters<OpenAI["responses"]["parse"]>[0]["input"];
type ResponseRequestOptions = Exclude<Parameters<OpenAI["responses"]["create"]>[1], undefined>;
type ResponseReasoning = Parameters<OpenAI["responses"]["create"]>[0]["reasoning"];

export type StructuredJsonResponseMode = "auto" | "structured" | "json";

export type StructuredJsonValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type StructuredJsonValidationIssueSummary = {
  code: string;
  count: number;
};

type ResponseTextCandidate = {
  output_text?: unknown;
  output?: unknown;
  status?: unknown;
  incomplete_details?: unknown;
  usage?: unknown;
  reasoning?: unknown;
};

export type StructuredJsonFailureCode =
  | "no_json"
  | "empty_response"
  | "incomplete_json"
  | "invalid_json"
  | "incomplete_response";

export class StructuredJsonResponseError extends Error {
  constructor(
    public readonly code: StructuredJsonFailureCode,
    message: string
  ) {
    super(message);
    this.name = "StructuredJsonResponseError";
  }
}

export type StructuredJsonDiagnostics = {
  responseStatus?: string;
  incompleteReason?: string;
  responseTextLength: number;
  parseResult: "not_started" | "success" | "failed";
  validationResult: "not_started" | "success" | "failed";
  responseCompleteDurationMs?: number;
  firstEventMs?: number;
  firstTextDeltaMs?: number;
  parseDurationMs?: number;
  validationDurationMs?: number;
  totalDurationMs?: number;
  validationIssueCount?: number;
  validationIssues?: StructuredJsonValidationIssue[];
  validationIssueSummary?: StructuredJsonValidationIssueSummary[];
  validationIssuesTruncated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  providerErrorCode?: ResponseError["code"] | "other";
};

export type StructuredJsonValidationFailureRawResponse = {
  rawResponse: string;
  model: string;
  schemaName: string;
  capturedAt: string;
  validationIssueCount: number;
  validationIssues: StructuredJsonValidationIssue[];
  validationIssueSummary: StructuredJsonValidationIssueSummary[];
  validationIssuesTruncated: boolean;
};

/** Opt-in local evaluation observation. Never sent to ordinary diagnostics. */
export type StructuredJsonResponseText = {
  rawResponse: string;
  state: "complete" | "partial";
};

const MAX_VALIDATION_ISSUES = 10;

const RESPONSE_ERROR_CODES = [
  "server_error", "rate_limit_exceeded", "invalid_prompt", "vector_store_timeout",
  "invalid_image", "invalid_image_format", "invalid_base64_image", "invalid_image_url",
  "image_too_large", "image_too_small", "image_parse_error", "image_content_policy_violation",
  "invalid_image_mode", "image_file_too_large", "unsupported_image_media_type", "empty_image_file",
  "failed_to_download_image", "image_file_not_found"
] as const satisfies readonly ResponseError["code"][];

type ZodValidationIssue = ZodError["issues"][number];

function validationIssueCode(issue: ZodValidationIssue) {
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return "missing_field";
  }
  return issue.code;
}

function validationIssueMessage(code: string) {
  switch (code) {
    case "missing_field":
      return "Required field is missing";
    case "invalid_enum_value":
      return "Invalid enum value";
    case "invalid_type":
      return "Invalid value type";
    case "too_small":
      return "Value is below the minimum size";
    case "too_big":
      return "Value exceeds the maximum size";
    case "invalid_string":
      return "Invalid string value";
    case "unrecognized_keys":
      return "Object contains unrecognized fields";
    case "invalid_union":
    case "invalid_union_discriminator":
      return "Value does not match an allowed variant";
    case "invalid_literal":
      return "Invalid literal value";
    case "not_multiple_of":
      return "Number is not an allowed multiple";
    case "not_finite":
      return "Number must be finite";
    case "custom":
      return "Custom validation failed";
    default:
      return "Schema validation failed";
  }
}

function validationIssuePath(path: ZodValidationIssue["path"]) {
  if (path.length === 0) {
    return "$";
  }

  let result = "";
  for (const part of path) {
    if (typeof part === "number") {
      result += `[${Math.max(0, Math.trunc(part))}]`;
      continue;
    }
    const safePart = part.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "unknown";
    result += result ? `.${safePart}` : safePart;
  }
  return result.slice(0, 240);
}

function validationIssueDiagnostics(error: ZodError) {
  const codeCounts = new Map<string, number>();
  for (const issue of error.issues) {
    const code = validationIssueCode(issue);
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }

  return {
    validationIssueCount: error.issues.length,
    validationIssues: error.issues.slice(0, MAX_VALIDATION_ISSUES).map((issue) => {
      const code = validationIssueCode(issue);
      return {
        path: validationIssuePath(issue.path),
        code,
        message: validationIssueMessage(code)
      };
    }),
    validationIssueSummary: [...codeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
    validationIssuesTruncated: error.issues.length > MAX_VALIDATION_ISSUES
  };
}

function isAbortError(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return false;
  }

  const name = String(error.name);
  return name === "AbortError" || name === "APIUserAbortError";
}

export function textFromResponse(response: ResponseTextCandidate, preserveWhitespace = false) {
  if (typeof response.output_text === "string" && (preserveWhitespace || response.output_text.trim())) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return "";
  }

  const text = response.output
    .flatMap((item: unknown) => {
      if (!item || typeof item !== "object" || !("content" in item) || !Array.isArray(item.content)) {
        return [];
      }

      return item.content.flatMap((contentItem: unknown) => {
        if (
          contentItem &&
          typeof contentItem === "object" &&
          "text" in contentItem &&
          typeof contentItem.text === "string"
        ) {
          return [contentItem.text];
        }
        return [];
      });
    })
    .join("\n");
  return preserveWhitespace ? text : text.trim();
}

function assistantAnswerCandidate(response: ResponseTextCandidate): ResponseTextCandidate {
  const output = Array.isArray(response.output) ? response.output.flatMap((item) => {
    if (!item || typeof item !== "object" || item.type !== "message" || item.role !== "assistant"
      || !Array.isArray(item.content)) return [];
    return [{ content: item.content.filter((part: { type?: unknown; text?: unknown } | null) =>
      part && part.type === "output_text" && typeof part.text === "string"
    ) }];
  }) : [];
  return { ...response, output_text: undefined, output };
}

function extractBalancedJson(text: string) {
  const start = text.search(/[\[{]/);
  if (start < 0) {
    throw new StructuredJsonResponseError("no_json", "Structured response did not contain JSON");
  }

  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new StructuredJsonResponseError("incomplete_json", "Structured response JSON was incomplete");
}

function removeTrailingCommas(text: string) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      result += char;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      result += char;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    if (!inString && char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/u.test(text[lookahead])) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        continue;
      }
    }
    result += char;
  }

  return result;
}

export function parseJsonObjectFromModelText(text: string) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new StructuredJsonResponseError("empty_response", "Structured response was empty");
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(removeTrailingCommas(candidate));
  } catch (initialError) {
    let balanced: string;
    try {
      balanced = extractBalancedJson(candidate);
    } catch (error) {
      throw error;
    }
    try {
      return JSON.parse(removeTrailingCommas(balanced));
    } catch {
      throw new StructuredJsonResponseError(
        "invalid_json",
        initialError instanceof Error ? initialError.message : "Structured response contained invalid JSON"
      );
    }
  }
}

function responseMetadata(response: ResponseTextCandidate, safeLabelsOnly = false) {
  const rawStatus = typeof response.status === "string" ? response.status : undefined;
  const responseStatus = safeLabelsOnly && rawStatus !== undefined
    && !["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"].includes(rawStatus)
    ? "other" : rawStatus;
  const details = response.incomplete_details;
  const rawIncompleteReason =
    details && typeof details === "object" && "reason" in details && typeof details.reason === "string"
      ? details.reason
      : undefined;
  const incompleteReason = safeLabelsOnly && rawIncompleteReason !== undefined
    && !["max_output_tokens", "content_filter"].includes(rawIncompleteReason) ? "other" : rawIncompleteReason;
  const usage = response.usage && typeof response.usage === "object"
    ? response.usage as Record<string, unknown>
    : null;
  const tokenCount = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : undefined;
  const inputTokens = tokenCount(usage?.input_tokens);
  const outputTokens = tokenCount(usage?.output_tokens);
  const totalTokens = tokenCount(usage?.total_tokens);
  const outputTokenDetails = usage?.output_tokens_details;
  const reasoningTokens = outputTokenDetails && typeof outputTokenDetails === "object"
    && "reasoning_tokens" in outputTokenDetails ? tokenCount(outputTokenDetails.reasoning_tokens) : undefined;
  const reasoning = response.reasoning;
  const effort = reasoning && typeof reasoning === "object" && "effort" in reasoning ? reasoning.effort : undefined;
  const reasoningEffort = typeof effort === "string"
    && ["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)
    ? effort as StructuredJsonDiagnostics["reasoningEffort"] : undefined;
  return {
    responseStatus,
    incompleteReason,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort })
  };
}

export function jsonOnlyInstruction(instruction: string) {
  return (
    `${instruction}\n` +
    "只输出一个合法 JSON 对象，不要输出 Markdown，不要输出解释文字。JSON 根对象必须包含 items 字段。"
  );
}

function withJsonInstruction(input: ResponseInput, instruction: string): ResponseInput {
  const jsonInstruction = jsonOnlyInstruction(instruction);

  if (Array.isArray(input)) {
    return [
      {
        role: "system",
        content: jsonInstruction
      },
      ...input
    ] as ResponseInput;
  }

  return `${jsonInstruction}\n\n${String(input)}` as ResponseInput;
}

export async function parseStructuredJsonResponse<TSchema extends z.ZodTypeAny>(input: {
  client: OpenAI;
  model: string;
  name: string;
  schema: TSchema;
  requestInput: ResponseInput;
  jsonInstruction: string;
  mode?: StructuredJsonResponseMode;
  /** JSON mode only; accept the terminal completed response, never accumulated deltas. */
  stream?: boolean;
  maxOutputTokens?: number;
  reasoning?: ResponseReasoning;
  requestOptions?: ResponseRequestOptions;
  normalize?: (value: unknown) => unknown;
  onDiagnostics?: (diagnostics: StructuredJsonDiagnostics) => void;
  onResponseText?: (response: StructuredJsonResponseText) => void;
  onValidationFailureRawResponse?: (
    capture: StructuredJsonValidationFailureRawResponse
  ) => void | Promise<void>;
}): Promise<z.infer<TSchema>> {
  if (input.stream && input.mode !== "json") {
    throw new Error("Streaming structured JSON requires explicit json mode");
  }
  const outputLimit =
    input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens };
  const reasoning = input.reasoning === undefined ? {} : { reasoning: input.reasoning };
  const validate = (value: unknown) => input.schema.parse(input.normalize ? input.normalize(value) : value);
  const parseStructured = async () => {
    const request = {
      model: input.model,
      input: input.requestInput,
      ...outputLimit,
      ...reasoning,
      text: {
        format: zodTextFormat(input.schema, input.name)
      }
    };
    const response = input.requestOptions
      ? await input.client.responses.parse(request, input.requestOptions)
      : await input.client.responses.parse(request);

    return validate(response.output_parsed);
  };
  const parseJsonText = async () => {
    const requestStartedAt = Date.now();
    const diagnostics: StructuredJsonDiagnostics = {
      responseTextLength: 0,
      parseResult: "not_started",
      validationResult: "not_started"
    };
    const request = {
      model: input.model,
      input: withJsonInstruction(input.requestInput, input.jsonInstruction),
      ...outputLimit,
      ...reasoning
    };
    const observeText = (rawResponse: string, state: StructuredJsonResponseText["state"]) => {
      // Observation must not change parsing, retry, cancellation or publication.
      try { input.onResponseText?.({ rawResponse, state }); }
      catch { console.warn("[provider-response-text-observer] capture_failed"); }
    };
    const streamCompletedResponse = async () => {
      let partialText = "";
      const assertNotAborted = () => {
        if (input.requestOptions?.signal?.aborted) {
          throw new DOMException("Structured response request was aborted", "AbortError");
        }
      };
      try {
        assertNotAborted();
        // Keep SDK HTTP handling, but avoid its legacy thread-event decoder's raw console logging.
        const client = input.client.withOptions({ logLevel: "off", maxRetries: 0 });
        const controller = new AbortController();
        let completed: ResponseTextCandidate | undefined;
        try {
          const response = await client.responses.create({ ...request, stream: true }, {
            ...input.requestOptions,
            maxRetries: 0,
            signal: input.requestOptions?.signal
              ? AbortSignal.any([input.requestOptions.signal, controller.signal]) : controller.signal
          }).asResponse();
          // Reuse SDK SSE framing once; event JSON is decoded here without logging raw data.
          for await (const message of _iterSSEMessages(response, controller)) {
            assertNotAborted();
            diagnostics.firstEventMs ??= Date.now() - requestStartedAt;
            if (message.data.trim() === "[DONE]") break;
            if (message.event && message.event !== "error" && !message.event.startsWith("response.")) {
              throw new StructuredJsonResponseError("incomplete_response", "Structured response stream event was unsupported");
            }
            const event = JSON.parse(message.data) as ResponseStreamEvent;
            if (!event || typeof event !== "object" || typeof event.type !== "string"
              || (message.event && message.event !== event.type)) {
              throw new StructuredJsonResponseError("incomplete_response", "Structured response stream event was invalid");
            }
            if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.length > 0) {
              diagnostics.firstTextDeltaMs ??= Date.now() - requestStartedAt;
              if (input.onResponseText) partialText += event.delta;
            }
            if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
              if (event.type !== "error" && event.response && typeof event.response === "object") {
                if (input.onResponseText) {
                  const answer = textFromResponse(assistantAnswerCandidate(event.response), true);
                  if (answer) partialText = answer;
                }
                Object.assign(diagnostics, responseMetadata(event.response, true), {
                  responseCompleteDurationMs: Date.now() - requestStartedAt
                });
              }
              if (event.type !== "response.incomplete") {
                const code = event.type === "error" ? event.code : event.response?.error?.code;
                diagnostics.providerErrorCode = typeof code === "string"
                  && RESPONSE_ERROR_CODES.includes(code as ResponseError["code"])
                  ? code as ResponseError["code"] : "other";
              }
              throw new StructuredJsonResponseError("incomplete_response", "Structured response stream did not complete");
            }
            if (event.type === "response.completed") {
              const response = event.response;
              if (!response || typeof response !== "object" || response.status !== "completed"
                || response.error != null || response.incomplete_details != null) {
                throw new StructuredJsonResponseError("incomplete_response", "Structured response stream completion was invalid");
              }
              // Raw streamed responses have not received the SDK's output_text projection.
              // Reasoning may itself contain valid JSON; only final assistant output is answer text.
              completed = assistantAnswerCandidate(response);
              // Returning the iterator cancels the body without waiting for EOF.
              // Abort only after iterator cleanup: aborting first errors the body
              // and can turn a valid completion into an AbortError on return().
              break;
            }
          }
        } finally {
          controller.abort();
        }
        assertNotAborted();
        if (!completed) {
          throw new StructuredJsonResponseError("incomplete_response", "Structured response stream ended without completion");
        }
        return completed;
      } catch (error) {
        if (input.onResponseText) observeText(partialText, "partial");
        diagnostics.totalDurationMs = Date.now() - requestStartedAt;
        input.onDiagnostics?.(diagnostics);
        // A malformed SSE envelope is a transport failure, not repairable model JSON.
        if (error instanceof SyntaxError) {
          throw new StructuredJsonResponseError("incomplete_response", "Structured response stream contained an invalid event");
        }
        throw error;
      }
    };
    const response = input.stream
      ? await streamCompletedResponse()
      : input.requestOptions
        ? await input.client.responses.create(request, input.requestOptions)
        : await input.client.responses.create(request);
    const responseReceivedAt = Date.now();
    const candidate = response as ResponseTextCandidate;
    const rawText = textFromResponse(candidate);
    const metadata = responseMetadata(candidate);
    observeText(textFromResponse(candidate, true), metadata.responseStatus === "incomplete" || metadata.incompleteReason ? "partial" : "complete");
    Object.assign(diagnostics, {
      ...metadata,
      responseTextLength: rawText.length,
      responseCompleteDurationMs: responseReceivedAt - requestStartedAt
    });
    if (metadata.responseStatus === "incomplete" || metadata.incompleteReason) {
      diagnostics.totalDurationMs = Date.now() - requestStartedAt;
      input.onDiagnostics?.(diagnostics);
      throw new StructuredJsonResponseError(
        "incomplete_response",
        `Structured response was incomplete${metadata.incompleteReason ? `: ${metadata.incompleteReason}` : ""}`
      );
    }
    let parsed: unknown;
    const parseStartedAt = Date.now();
    try {
      parsed = parseJsonObjectFromModelText(rawText);
      diagnostics.parseResult = "success";
      diagnostics.parseDurationMs = Date.now() - parseStartedAt;
    } catch (error) {
      diagnostics.parseResult = "failed";
      diagnostics.parseDurationMs = Date.now() - parseStartedAt;
      diagnostics.totalDurationMs = Date.now() - requestStartedAt;
      input.onDiagnostics?.(diagnostics);
      throw error;
    }
    const validationStartedAt = Date.now();
    try {
      const result = validate(parsed);
      diagnostics.validationResult = "success";
      diagnostics.validationDurationMs = Date.now() - validationStartedAt;
      diagnostics.totalDurationMs = Date.now() - requestStartedAt;
      input.onDiagnostics?.(diagnostics);
      return result;
    } catch (error) {
      diagnostics.validationResult = "failed";
      diagnostics.validationDurationMs = Date.now() - validationStartedAt;
      diagnostics.totalDurationMs = Date.now() - requestStartedAt;
      if (error instanceof ZodError) {
        const issues = validationIssueDiagnostics(error);
        Object.assign(diagnostics, issues);
        if (input.onValidationFailureRawResponse) {
          try {
            await input.onValidationFailureRawResponse({
              rawResponse: rawText,
              model: input.model,
              schemaName: input.name,
              capturedAt: new Date().toISOString(),
              ...issues
            });
          } catch {
            console.warn("[provider-raw-response-capture] write_failed");
          }
        }
      }
      input.onDiagnostics?.(diagnostics);
      throw error;
    }
  };

  if (input.mode === "json") {
    return parseJsonText();
  }
  if (input.mode === "structured") {
    return parseStructured();
  }

  try {
    return await parseStructured();
  } catch (error) {
    if (input.requestOptions?.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    return parseJsonText();
  }
}
