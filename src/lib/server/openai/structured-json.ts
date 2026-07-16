import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

type ResponseInput = Parameters<OpenAI["responses"]["parse"]>[0]["input"];
type ResponseRequestOptions = Exclude<Parameters<OpenAI["responses"]["create"]>[1], undefined>;

export type StructuredJsonResponseMode = "auto" | "structured" | "json";

type ResponseTextCandidate = {
  output_text?: unknown;
  output?: unknown;
  status?: unknown;
  incomplete_details?: unknown;
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
  parseDurationMs?: number;
  validationDurationMs?: number;
  totalDurationMs?: number;
};

function isAbortError(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return false;
  }

  const name = String(error.name);
  return name === "AbortError" || name === "APIUserAbortError";
}

export function textFromResponse(response: ResponseTextCandidate) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return "";
  }

  return response.output
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
    .join("\n")
    .trim();
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

function responseMetadata(response: ResponseTextCandidate) {
  const responseStatus = typeof response.status === "string" ? response.status : undefined;
  const details = response.incomplete_details;
  const incompleteReason =
    details && typeof details === "object" && "reason" in details && typeof details.reason === "string"
      ? details.reason
      : undefined;
  return { responseStatus, incompleteReason };
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
  maxOutputTokens?: number;
  requestOptions?: ResponseRequestOptions;
  normalize?: (value: unknown) => unknown;
  onDiagnostics?: (diagnostics: StructuredJsonDiagnostics) => void;
}): Promise<z.infer<TSchema>> {
  const outputLimit =
    input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens };
  const validate = (value: unknown) => input.schema.parse(input.normalize ? input.normalize(value) : value);
  const parseStructured = async () => {
    const request = {
      model: input.model,
      input: input.requestInput,
      ...outputLimit,
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
    const request = {
      model: input.model,
      input: withJsonInstruction(input.requestInput, input.jsonInstruction),
      ...outputLimit
    };
    const response = input.requestOptions
      ? await input.client.responses.create(request, input.requestOptions)
      : await input.client.responses.create(request);
    const responseReceivedAt = Date.now();
    const candidate = response as ResponseTextCandidate;
    const rawText = textFromResponse(candidate);
    const metadata = responseMetadata(candidate);
    const diagnostics: StructuredJsonDiagnostics = {
      ...metadata,
      responseTextLength: rawText.length,
      parseResult: "not_started",
      validationResult: "not_started",
      responseCompleteDurationMs: responseReceivedAt - requestStartedAt
    };
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
