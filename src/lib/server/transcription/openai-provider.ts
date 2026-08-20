import fs from "fs";
import { extname } from "path";
import {
  AudioChunkSchema,
  buildAudioChunkId,
  type AudioChunk,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";
import { getOpenRouterErrorMessage } from "@/lib/openrouter/errors";
import { classifySegment } from "@/lib/processing/classifier";
import type { TranscriptionProvider } from "./provider";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import {
  cleanupGeneratedAudioChunks,
  planAudioChunks,
  probeAudioDurationSeconds
} from "./chunks/audio-planner";
import {
  createTranscriptChunkFromLocalSegments,
  mergeTranscriptChunks,
  type TranscriptMergeResult
} from "./chunks/transcript-merge";
import {
  OpenAICompatibleTranscriptionError,
  requestOpenAICompatibleTranscription,
  safeOpenAITranscriptionErrorLog,
  type OpenAICompatibleTranscriptionResponse
} from "./openai-compatible-transcription";

type OpenRouterTranscriptionResponse = {
  text?: string;
  usage?: {
    seconds?: number;
  };
  error?: {
    code?: number | string;
    message?: string;
    metadata?: {
      provider_name?: string;
      raw?: string;
    };
  };
  message?: string;
};

const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";
const OPENAI_TRANSCRIBE_API_KEY_ENV = "OPENAI_TRANSCRIBE_API_KEY";
const OPENAI_TRANSCRIBE_BASE_URL_ENV = "OPENAI_TRANSCRIBE_BASE_URL";
const OPENAI_TRANSCRIBE_LANGUAGE_ENV = "OPENAI_TRANSCRIBE_LANGUAGE";
const OPENAI_AUTH_HEADER_MODE_ENV = "OPENAI_AUTH_HEADER_MODE";
const OPENAI_REQUEST_TIMEOUT_MS_ENV = "OPENAI_REQUEST_TIMEOUT_MS";
const OPENAI_MAX_RETRIES_ENV = "OPENAI_MAX_RETRIES";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const OPENROUTER_BASE_URL_ENV = "OPENROUTER_BASE_URL";
const OPENROUTER_HTTP_REFERER_ENV = "OPENROUTER_HTTP_REFERER";
const OPENROUTER_APP_TITLE_ENV = "OPENROUTER_APP_TITLE";
const OPENROUTER_TRANSCRIBE_CHUNK_SECONDS_ENV = "OPENROUTER_TRANSCRIBE_CHUNK_SECONDS";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = 60;
const MAX_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = 60;
const MIN_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = 30;
const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OPENAI_MAX_RETRIES = 2;
const TARGET_TRANSCRIPT_CHUNK_LENGTH = 180;
const ESTIMATED_TRANSCRIPT_CHARS_PER_SECOND = 4;
const mimeTypeToOpenRouterFormat: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/mpga": "mpga",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-pcm": "wav",
  "video/mp4": "mp4"
};

function readStringEnv(variableName: string): string | undefined {
  const rawValue = process.env[variableName];
  if (rawValue === undefined) {
    return undefined;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumberEnv(variableName: string, defaultValue: number) {
  const rawValue = readStringEnv(variableName);
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 30) {
    return defaultValue;
  }

  return parsed;
}

function readNonNegativeNumberEnv(variableName: string, defaultValue: number) {
  const rawValue = readStringEnv(variableName);
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function readPositiveNumberEnv(variableName: string, defaultValue: number) {
  const rawValue = readStringEnv(variableName);
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function getOpenRouterChunkSeconds() {
  return Math.min(
    MAX_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS,
    Math.max(MIN_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS, readNumberEnv(OPENROUTER_TRANSCRIBE_CHUNK_SECONDS_ENV, DEFAULT_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS))
  );
}

function isOpenRouterBaseURL(baseUrl: string | undefined) {
  return Boolean(baseUrl?.includes("openrouter.ai"));
}

function getOpenAIResponseFormat(model: string) {
  const normalized = model.trim().toLowerCase();
  if (normalized === "gpt-4o-transcribe-diarize" || normalized.endsWith("/gpt-4o-transcribe-diarize")) {
    return "diarized_json" as const;
  }
  if (normalized === "gpt-4o-transcribe" || normalized.endsWith("/gpt-4o-transcribe")) {
    return "json" as const;
  }
  return undefined;
}

function getTranscriptionModel() {
  return process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe-diarize";
}

async function resolveOpenAICompatibleRouting() {
  const runtimeConfig = await getOpenAIClientRuntimeConfig();
  const runtimeOpenRouterApiKey = runtimeConfig.openRouterApiKey?.trim() || undefined;
  const openAiApiKey = runtimeConfig.openAiApiKey?.trim() || readStringEnv("OPENAI_API_KEY");
  const openRouterApiKey = runtimeOpenRouterApiKey ?? readStringEnv(OPENROUTER_API_KEY_ENV);
  const openAiBaseUrl = runtimeConfig.openAiBaseUrl?.trim() || readStringEnv(OPENAI_BASE_URL_ENV);
  const openRouterBaseUrl = runtimeConfig.openRouterBaseUrl?.trim() || readStringEnv(OPENROUTER_BASE_URL_ENV);
  const usesOpenRouterKey =
    Boolean(runtimeOpenRouterApiKey) ||
    Boolean(openRouterApiKey && (!openAiApiKey || (!openAiBaseUrl && openRouterBaseUrl) || isOpenRouterBaseURL(openAiBaseUrl)));
  const selectedBaseUrl = usesOpenRouterKey ? openRouterBaseUrl || openAiBaseUrl : openAiBaseUrl || openRouterBaseUrl;

  return {
    apiKey: usesOpenRouterKey ? openRouterApiKey : openAiApiKey ?? openRouterApiKey,
    baseUrl: selectedBaseUrl,
    openAiApiKey,
    openAiBaseUrl,
    usesOpenRouter: usesOpenRouterKey || isOpenRouterBaseURL(selectedBaseUrl)
  };
}

function transcriptionConfigError(requiredEnvironmentVariables: string[]) {
  return new OpenAICompatibleTranscriptionError("provider_config_error", {
    method: "POST",
    path: "/v1/audio/transcriptions",
    attempts: 0,
    requiredEnvironmentVariables
  });
}

function getDirectTranscriptionCredentials(openAiApiKey: string | undefined, genericOpenAiBaseUrl: string | undefined) {
  const baseUrl = readStringEnv(OPENAI_TRANSCRIBE_BASE_URL_ENV);
  const dedicatedApiKey = readStringEnv(OPENAI_TRANSCRIBE_API_KEY_ENV);

  if (genericOpenAiBaseUrl && (!baseUrl || !dedicatedApiKey)) {
    throw transcriptionConfigError([
      ...(!baseUrl ? [OPENAI_TRANSCRIBE_BASE_URL_ENV] : []),
      ...(!dedicatedApiKey ? [OPENAI_TRANSCRIBE_API_KEY_ENV] : [])
    ]);
  }

  if (baseUrl && !dedicatedApiKey) {
    throw transcriptionConfigError([OPENAI_TRANSCRIBE_API_KEY_ENV]);
  }

  const apiKey = dedicatedApiKey ?? openAiApiKey;
  if (!apiKey) {
    throw transcriptionConfigError([OPENAI_TRANSCRIBE_API_KEY_ENV, "OPENAI_API_KEY"]);
  }

  return { apiKey, baseUrl };
}

function getOpenRouterAudioFormat(mimeType: string, filePath: string) {
  const mappedFormat = mimeTypeToOpenRouterFormat[mimeType];
  if (mappedFormat) {
    return mappedFormat;
  }

  const extension = extname(filePath).slice(1).toLowerCase();
  return extension || "mp3";
}

function splitLongSentence(sentence: string) {
  const chunks: string[] = [];
  for (let index = 0; index < sentence.length; index += TARGET_TRANSCRIPT_CHUNK_LENGTH) {
    const chunk = sentence.slice(index, index + TARGET_TRANSCRIPT_CHUNK_LENGTH).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

function splitTranscriptText(text: string) {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    return [];
  }

  const sentences = normalizedText.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [normalizedText];
  return sentences
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((sentence) => (sentence.length > TARGET_TRANSCRIPT_CHUNK_LENGTH ? splitLongSentence(sentence) : [sentence]));
}

function estimateTextDurationSeconds(text: string) {
  const effectiveLength = text.replace(/\s/g, "").length;
  return Math.max(1, Math.ceil(effectiveLength / ESTIMATED_TRANSCRIPT_CHARS_PER_SECOND));
}

function getSyntheticDurationSeconds(text: string, chunks: string[], reportedSeconds?: number) {
  if (typeof reportedSeconds === "number" && Number.isFinite(reportedSeconds) && reportedSeconds > 0) {
    return reportedSeconds;
  }

  return Math.max(chunks.length, estimateTextDurationSeconds(text));
}

function buildSegmentsFromText(
  input: { uploadId: string },
  text: string,
  options?: { durationSeconds?: number; confidence?: number }
) {
  const chunks = splitTranscriptText(text);
  if (chunks.length === 0) {
    return [];
  }

  const totalDurationSeconds = getSyntheticDurationSeconds(text, chunks, options?.durationSeconds);
  const secondsPerChunk = totalDurationSeconds / chunks.length;
  const confidence = options?.confidence ?? 0.6;

  return chunks.map((chunk, index) => {
    const startSeconds = Math.floor(index * secondsPerChunk);
    const isLastChunk = index === chunks.length - 1;
    const endSeconds = isLastChunk
      ? Math.max(Math.floor(index * secondsPerChunk) + 1, Math.round(totalDurationSeconds))
      : Math.max(Math.floor(index * secondsPerChunk) + 1, Math.floor((index + 1) * secondsPerChunk));

    return classifySegment({
      id: `${input.uploadId}_seg_${index + 1}`,
      uploadId: input.uploadId,
      startSeconds,
      endSeconds,
      text: chunk,
      confidence,
      sceneLabels: [],
      valueLabels: []
    });
  });
}

function getOpenRouterTranscriptionUrl(baseUrl: string | undefined) {
  return `${(baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "")}/audio/transcriptions`;
}

async function parseOpenRouterResponse(response: Response): Promise<OpenRouterTranscriptionResponse> {
  const rawBody = await response.text();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody) as OpenRouterTranscriptionResponse;
  } catch {
    return { message: rawBody };
  }
}

async function requestOpenRouterTranscription(input: { filePath: string; mimeType: string }, model: string) {
  const routing = await resolveOpenAICompatibleRouting();
  if (!routing.apiKey) {
    throw new Error("OPENAI_API_KEY (or OPENROUTER_API_KEY) is required when using OpenRouter transcription provider");
  }

  const audioBuffer = await fs.promises.readFile(input.filePath);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${routing.apiKey}`,
    "Content-Type": "application/json"
  };
  const httpReferer = readStringEnv(OPENROUTER_HTTP_REFERER_ENV);
  const appTitle = readStringEnv(OPENROUTER_APP_TITLE_ENV);

  if (httpReferer) {
    headers["HTTP-Referer"] = httpReferer;
  }
  if (appTitle) {
    headers["X-Title"] = appTitle;
  }

  const response = await fetch(getOpenRouterTranscriptionUrl(routing.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      input_audio: {
        data: audioBuffer.toString("base64"),
        format: getOpenRouterAudioFormat(input.mimeType, input.filePath)
      },
      model
    })
  });
  const payload = await parseOpenRouterResponse(response);

  if (!response.ok) {
    const message = getOpenRouterErrorMessage(payload, response);
    throw new Error(`OpenRouter transcription failed: ${response.status} ${message}`);
  }

  return payload;
}

async function tryProbeAudioDurationSeconds(filePath: string) {
  try {
    return await probeAudioDurationSeconds(filePath);
  } catch {
    return null;
  }
}

function chunkMimeType(chunk: AudioChunk, fallback: string) {
  const mimeType = chunk.metadata.mimeType;
  return typeof mimeType === "string" && mimeType.trim() ? mimeType : fallback;
}

async function transcribeOpenRouterChunk(chunk: AudioChunk, model: string) {
  const filePath = chunk.source.path;
  if (!filePath) {
    throw new Error(`OpenRouter audio chunk ${chunk.id} has no local path`);
  }
  const payload = await requestOpenRouterTranscription(
    { filePath, mimeType: chunkMimeType(chunk, "audio/mpeg") },
    model
  );
  const reportedDuration = payload.usage?.seconds;
  const localSegments = buildSegmentsFromText({ uploadId: chunk.uploadId }, payload.text ?? "", {
    durationSeconds:
      typeof reportedDuration === "number" && Number.isFinite(reportedDuration)
        ? Math.min(reportedDuration, chunk.durationSeconds)
        : chunk.durationSeconds,
    confidence: 0.55
  });

  return createTranscriptChunkFromLocalSegments({
    chunk,
    localSegments,
    providerMetadata: {
      provider: "openrouter",
      model
    }
  });
}

function uploadedAudioChunk(input: { uploadId: string; filePath: string; mimeType: string }, durationSeconds: number) {
  const createdAt = new Date().toISOString();
  return AudioChunkSchema.parse({
    id: buildAudioChunkId(input.uploadId, 0),
    uploadId: input.uploadId,
    index: 0,
    startSeconds: 0,
    endSeconds: durationSeconds,
    durationSeconds,
    source: { type: "uploaded_audio", path: input.filePath },
    status: "created",
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      strategy: "single_file_fallback",
      mimeType: input.mimeType,
      originalMimeType: input.mimeType
    }
  });
}

async function transcribeOpenRouterWithoutDuration(
  input: { uploadId: string; filePath: string; mimeType: string },
  model: string
) {
  const payload = await requestOpenRouterTranscription(input, model);
  const localSegments = buildSegmentsFromText(input, payload.text ?? "", {
    durationSeconds: payload.usage?.seconds,
    confidence: 0.55
  });
  const durationSeconds = Math.max(
    1,
    payload.usage?.seconds ?? 0,
    ...localSegments.map((segment) => segment.endSeconds)
  );
  const chunk = uploadedAudioChunk(input, durationSeconds);
  return createTranscriptChunkFromLocalSegments({
    chunk,
    localSegments,
    providerMetadata: { provider: "openrouter", model, durationSource: "response_or_text" }
  });
}

export async function transcribeOpenRouterToMergeResult(
  input: { uploadId: string; filePath: string; mimeType: string },
  model: string
): Promise<TranscriptMergeResult> {
  const chunkSeconds = getOpenRouterChunkSeconds();
  const durationSeconds = await tryProbeAudioDurationSeconds(input.filePath);
  let audioChunks: AudioChunk[] = [];

  try {
    const transcriptChunks: TranscriptChunk[] = [];
    if (durationSeconds === null) {
      transcriptChunks.push(await transcribeOpenRouterWithoutDuration(input, model));
    } else {
      audioChunks = await planAudioChunks(
        {
          uploadId: input.uploadId,
          filePath: input.filePath,
          mimeType: input.mimeType,
          chunkDurationSeconds: chunkSeconds
        },
        { probeDurationSeconds: async () => durationSeconds }
      );
      for (const chunk of audioChunks) {
        transcriptChunks.push(await transcribeOpenRouterChunk(chunk, model));
      }
    }

    const merged = mergeTranscriptChunks(transcriptChunks);
    console.info(
      `[openrouter-transcript-merge] upload_id=${input.uploadId} chunks=${merged.stats.chunkCount} input_segments=${merged.stats.inputSegmentCount} segments=${merged.stats.segmentCount} duplicates_removed=${merged.stats.duplicateRemoved} warnings=${merged.warnings.length}`
    );
    return merged;
  } finally {
    await cleanupGeneratedAudioChunks(audioChunks);
  }
}

export const openaiTranscriptionProvider: TranscriptionProvider = {
  async transcribe(input) {
    const model = getTranscriptionModel();
    const routing = await resolveOpenAICompatibleRouting();
    if (routing.usesOpenRouter) {
      return (await transcribeOpenRouterToMergeResult(input, model)).segments;
    }

    let response: OpenAICompatibleTranscriptionResponse;
    try {
      const credentials = getDirectTranscriptionCredentials(routing.openAiApiKey, routing.openAiBaseUrl);
      const responseFormat = getOpenAIResponseFormat(model);
      response = await requestOpenAICompatibleTranscription({
        filePath: input.filePath,
        mimeType: input.mimeType,
        apiKey: credentials.apiKey,
        model,
        baseUrl: credentials.baseUrl,
        language: readStringEnv(OPENAI_TRANSCRIBE_LANGUAGE_ENV),
        responseFormat,
        chunkingStrategy: responseFormat === "diarized_json" ? "auto" : undefined,
        authHeaderMode: readStringEnv(OPENAI_AUTH_HEADER_MODE_ENV)?.toLowerCase() === "raw" ? "raw" : "bearer",
        timeoutMs: readPositiveNumberEnv(OPENAI_REQUEST_TIMEOUT_MS_ENV, DEFAULT_OPENAI_REQUEST_TIMEOUT_MS),
        maxRetries: readNonNegativeNumberEnv(OPENAI_MAX_RETRIES_ENV, DEFAULT_OPENAI_MAX_RETRIES)
      });
    } catch (error) {
      if (error instanceof OpenAICompatibleTranscriptionError) {
        console.error(safeOpenAITranscriptionErrorLog(error));
      }
      throw error;
    }

    const segments = (response.segments ?? []).map((segment, index): TranscriptSegment =>
      classifySegment({
        id: `${input.uploadId}_seg_${index + 1}`,
        uploadId: input.uploadId,
        startSeconds: segment.start,
        endSeconds: segment.end,
        speaker: segment.speaker,
        text: segment.text,
        confidence: 0.8,
        sceneLabels: [],
        valueLabels: []
      })
    );

    if (segments.length === 0) {
      return buildSegmentsFromText(input, response.text);
    }

    return segments;
  }
};
