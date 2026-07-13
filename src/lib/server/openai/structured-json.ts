import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

type ResponseInput = Parameters<OpenAI["responses"]["parse"]>[0]["input"];
type ResponseRequestOptions = Exclude<Parameters<OpenAI["responses"]["create"]>[1], undefined>;

export type StructuredJsonResponseMode = "auto" | "structured" | "json";

type ResponseTextCandidate = {
  output_text?: unknown;
  output?: unknown;
};

function isAbortError(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return false;
  }

  const name = String(error.name);
  return name === "AbortError" || name === "APIUserAbortError";
}

function textFromResponse(response: ResponseTextCandidate) {
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
    throw new Error("Structured response did not contain JSON");
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

  throw new Error("Structured response JSON was incomplete");
}

export function parseJsonObjectFromModelText(text: string) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(extractBalancedJson(candidate));
  }
}

function withJsonInstruction(input: ResponseInput, instruction: string): ResponseInput {
  const jsonOnlyInstruction =
    `${instruction}\n` +
    "只输出一个合法 JSON 对象，不要输出 Markdown，不要输出解释文字。JSON 根对象必须包含 items 字段。";

  if (Array.isArray(input)) {
    return [
      {
        role: "system",
        content: jsonOnlyInstruction
      },
      ...input
    ] as ResponseInput;
  }

  return `${jsonOnlyInstruction}\n\n${String(input)}` as ResponseInput;
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
}): Promise<z.infer<TSchema>> {
  const outputLimit =
    input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens };
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

    return input.schema.parse(response.output_parsed);
  };
  const parseJsonText = async () => {
    const request = {
      model: input.model,
      input: withJsonInstruction(input.requestInput, input.jsonInstruction),
      ...outputLimit
    };
    const response = input.requestOptions
      ? await input.client.responses.create(request, input.requestOptions)
      : await input.client.responses.create(request);
    const rawText = textFromResponse(response as ResponseTextCandidate);
    return input.schema.parse(parseJsonObjectFromModelText(rawText));
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
