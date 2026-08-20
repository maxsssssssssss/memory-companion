import { openAsBlob } from "node:fs";
import { basename } from "node:path";

const DEFAULT_OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_CONFIGURED_RETRIES = 10;

export type OpenAICompatibleTranscriptionErrorCode =
  | "provider_config_error"
  | "provider_auth_error"
  | "provider_not_found"
  | "provider_unsupported_audio"
  | "provider_invalid_request"
  | "provider_timeout"
  | "provider_network_error"
  | "provider_http_error"
  | "provider_empty_transcript"
  | "provider_response_schema_error";

export type OpenAICompatibleTranscriptionErrorMetadata = {
  method: "POST";
  path: string;
  attempts: number;
  status?: number;
  contentType?: string;
  responseBytes?: number;
  requiredEnvironmentVariables?: string[];
};

export class OpenAICompatibleTranscriptionError extends Error {
  constructor(
    public readonly code: OpenAICompatibleTranscriptionErrorCode,
    public readonly metadata: OpenAICompatibleTranscriptionErrorMetadata
  ) {
    super(code);
    this.name = "OpenAICompatibleTranscriptionError";
  }
}

export type OpenAICompatibleDiarizedSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
};

export type OpenAICompatibleTranscriptionResponse = {
  text: string;
  segments?: OpenAICompatibleDiarizedSegment[];
};

type RequestInput = {
  filePath: string;
  mimeType: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  language?: string;
  responseFormat?: "json" | "diarized_json";
  chunkingStrategy?: "auto";
  authHeaderMode?: "bearer" | "raw";
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
};

function configError(requiredEnvironmentVariables: string[] = []) {
  return new OpenAICompatibleTranscriptionError("provider_config_error", {
    method: "POST",
    path: "/v1/audio/transcriptions",
    attempts: 0,
    ...(requiredEnvironmentVariables.length > 0 ? { requiredEnvironmentVariables } : {})
  });
}

function normalizePath(pathname: string) {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .filter((segment, index, values) => {
      return !(segment.toLowerCase() === "v1" && values[index - 1]?.toLowerCase() === "v1");
    });
  const endsInTranscriptionPath =
    segments.at(-2)?.toLowerCase() === "audio" && segments.at(-1)?.toLowerCase() === "transcriptions";

  if (!endsInTranscriptionPath) {
    if (segments.at(-1)?.toLowerCase() !== "v1") {
      segments.push("v1");
    }
    segments.push("audio", "transcriptions");
  }

  return `/${segments.join("/")}`;
}

export function normalizeOpenAITranscriptionUrl(baseUrl?: string) {
  if (!baseUrl?.trim()) {
    return DEFAULT_OPENAI_TRANSCRIPTION_URL;
  }

  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw configError(["OPENAI_TRANSCRIBE_BASE_URL"]);
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw configError(["OPENAI_TRANSCRIBE_BASE_URL"]);
  }

  url.pathname = normalizePath(url.pathname);
  return url.toString();
}

function responseContentType(response: Response) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isJsonContentType(contentType: string) {
  return contentType === "application/json" || contentType.endsWith("+json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapHttpError(status: number): OpenAICompatibleTranscriptionErrorCode {
  if (status === 401 || status === 403) {
    return "provider_auth_error";
  }
  if (status === 404) {
    return "provider_not_found";
  }
  if (status === 415) {
    return "provider_unsupported_audio";
  }
  if (status === 400 || status === 422) {
    return "provider_invalid_request";
  }
  return "provider_http_error";
}

function parseDiarizedSegments(value: unknown): OpenAICompatibleDiarizedSegment[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parsed: OpenAICompatibleDiarizedSegment[] = [];
  for (const segment of value) {
    if (
      !isRecord(segment) ||
      typeof segment.start !== "number" ||
      !Number.isFinite(segment.start) ||
      segment.start < 0 ||
      typeof segment.end !== "number" ||
      !Number.isFinite(segment.end) ||
      segment.end <= segment.start ||
      typeof segment.text !== "string" ||
      !segment.text.trim() ||
      (segment.speaker !== undefined && typeof segment.speaker !== "string")
    ) {
      return null;
    }

    parsed.push({
      start: segment.start,
      end: segment.end,
      text: segment.text.trim(),
      ...(typeof segment.speaker === "string" && segment.speaker.trim()
        ? { speaker: segment.speaker.trim() }
        : {})
    });
  }

  return parsed;
}

async function parseResponse(response: Response, path: string, attempt: number) {
  const contentType = responseContentType(response);
  const rawBody = await response.text();
  const responseBytes = Buffer.byteLength(rawBody, "utf8");
  const baseMetadata = {
    method: "POST" as const,
    path,
    attempts: attempt,
    status: response.status,
    contentType,
    responseBytes
  };

  if (!response.ok) {
    throw new OpenAICompatibleTranscriptionError(mapHttpError(response.status), baseMetadata);
  }

  let payload: unknown;
  if (isJsonContentType(contentType)) {
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      throw new OpenAICompatibleTranscriptionError("provider_response_schema_error", baseMetadata);
    }
  }

  if (!isJsonContentType(contentType) || !isRecord(payload)) {
    throw new OpenAICompatibleTranscriptionError("provider_response_schema_error", baseMetadata);
  }

  if (typeof payload.text !== "string") {
    throw new OpenAICompatibleTranscriptionError("provider_response_schema_error", baseMetadata);
  }
  const text = payload.text.trim();
  if (!text) {
    throw new OpenAICompatibleTranscriptionError("provider_empty_transcript", baseMetadata);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "segments")) {
    if (Array.isArray(payload.segments) && payload.segments.length === 0) {
      throw new OpenAICompatibleTranscriptionError("provider_empty_transcript", baseMetadata);
    }
    const segments = parseDiarizedSegments(payload.segments);
    if (!segments) {
      throw new OpenAICompatibleTranscriptionError("provider_response_schema_error", baseMetadata);
    }
    return { text, segments };
  }

  return { text };
}

function isRetryable(error: OpenAICompatibleTranscriptionError) {
  return (
    error.code === "provider_timeout" ||
    error.code === "provider_network_error" ||
    (error.code === "provider_http_error" &&
      (error.metadata.status === 408 ||
        error.metadata.status === 409 ||
        error.metadata.status === 429 ||
        (error.metadata.status !== undefined && error.metadata.status >= 500)))
  );
}

function validateInput(input: RequestInput) {
  if (!input.apiKey.trim()) {
    throw configError(["OPENAI_API_KEY", "OPENAI_TRANSCRIBE_API_KEY"]);
  }
  if (!input.model.trim() || !input.filePath.trim() || !input.mimeType.trim()) {
    throw configError();
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw configError(["OPENAI_REQUEST_TIMEOUT_MS"]);
  }
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > MAX_CONFIGURED_RETRIES) {
    throw configError(["OPENAI_MAX_RETRIES"]);
  }
}

function timeoutError(path: string, attempt: number) {
  return new OpenAICompatibleTranscriptionError("provider_timeout", {
    method: "POST",
    path,
    attempts: attempt
  });
}

function networkError(path: string, attempt: number) {
  return new OpenAICompatibleTranscriptionError("provider_network_error", {
    method: "POST",
    path,
    attempts: attempt
  });
}

function safePath(url: string) {
  return new URL(url).pathname;
}

export async function requestOpenAICompatibleTranscription(
  input: RequestInput
): Promise<OpenAICompatibleTranscriptionResponse> {
  validateInput(input);
  const url = normalizeOpenAITranscriptionUrl(input.baseUrl);
  const path = safePath(url);
  const fetchImpl = input.fetchImpl ?? fetch;
  const blob = await openAsBlob(input.filePath, { type: input.mimeType });

  for (let attempt = 1; attempt <= input.maxRetries + 1; attempt += 1) {
    const form = new FormData();
    form.append("file", blob, basename(input.filePath));
    form.append("model", input.model.trim());
    if (input.language?.trim()) {
      form.append("language", input.language.trim());
    }
    if (input.responseFormat) {
      form.append("response_format", input.responseFormat);
    }
    if (input.chunkingStrategy) {
      form.append("chunking_strategy", input.chunkingStrategy);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: input.authHeaderMode === "raw" ? input.apiKey : `Bearer ${input.apiKey}`
        },
        body: form,
        signal: controller.signal
      });
      return await parseResponse(response, path, attempt);
    } catch (error) {
      const classified =
        error instanceof OpenAICompatibleTranscriptionError
          ? error
          : controller.signal.aborted ||
              (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
            ? timeoutError(path, attempt)
            : networkError(path, attempt);

      if (attempt <= input.maxRetries && isRetryable(classified)) {
        continue;
      }
      throw classified;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw networkError(path, input.maxRetries + 1);
}

export function safeOpenAITranscriptionErrorLog(error: OpenAICompatibleTranscriptionError) {
  const metadata = error.metadata;
  return (
    `[openai-transcription] code=${error.code} method=${metadata.method} path=${metadata.path} attempts=${metadata.attempts}` +
    (metadata.status === undefined ? "" : ` status=${metadata.status}`) +
    (metadata.contentType ? ` content_type=${metadata.contentType}` : "") +
    (metadata.responseBytes === undefined ? "" : ` response_bytes=${metadata.responseBytes}`) +
    (metadata.requiredEnvironmentVariables?.length
      ? ` required_env=${metadata.requiredEnvironmentVariables.join(",")}`
      : "")
  );
}
