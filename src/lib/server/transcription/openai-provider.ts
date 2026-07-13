import fs from "fs";
import { execFile } from "child_process";
import { tmpdir } from "os";
import { extname, join } from "path";
import { promisify } from "util";
import type { TranscriptSegment } from "@/lib/domain/types";
import { getOpenRouterErrorMessage } from "@/lib/openrouter/errors";
import { classifySegment } from "@/lib/processing/classifier";
import { getFfmpegExecutable, getFfprobeExecutable } from "@/lib/server/ffmpeg";
import type { TranscriptionProvider } from "./provider";
import { createOpenAIClient } from "@/lib/server/openai/client";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import type OpenAI from "openai";

type DiarizedSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
};
type OpenAITranscriptionRequest = Parameters<OpenAI["audio"]["transcriptions"]["create"]>[0];
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
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const OPENROUTER_BASE_URL_ENV = "OPENROUTER_BASE_URL";
const OPENROUTER_HTTP_REFERER_ENV = "OPENROUTER_HTTP_REFERER";
const OPENROUTER_APP_TITLE_ENV = "OPENROUTER_APP_TITLE";
const OPENROUTER_TRANSCRIBE_CHUNK_SECONDS_ENV = "OPENROUTER_TRANSCRIBE_CHUNK_SECONDS";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = 60;
const MAX_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = 60;
const MIN_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS = 30;
const TARGET_TRANSCRIPT_CHUNK_LENGTH = 180;
const ESTIMATED_TRANSCRIPT_CHARS_PER_SECOND = 4;
const execFileAsync = promisify(execFile);

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

function getOpenRouterChunkSeconds() {
  return Math.min(
    MAX_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS,
    Math.max(MIN_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS, readNumberEnv(OPENROUTER_TRANSCRIBE_CHUNK_SECONDS_ENV, DEFAULT_OPENROUTER_TRANSCRIBE_CHUNK_SECONDS))
  );
}

function isOpenRouterBaseURL(baseUrl: string | undefined) {
  return Boolean(baseUrl?.includes("openrouter.ai"));
}

function isFourOTranscribeModel(model: string) {
  const normalized = model.trim().toLowerCase();
  return normalized.includes("gpt-4o-transcribe");
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
    usesOpenRouter: usesOpenRouterKey || isOpenRouterBaseURL(selectedBaseUrl)
  };
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
  options?: { durationSeconds?: number; confidence?: number; startOffsetSeconds?: number; segmentIndexOffset?: number }
) {
  const chunks = splitTranscriptText(text);
  if (chunks.length === 0) {
    return [];
  }

  const totalDurationSeconds = getSyntheticDurationSeconds(text, chunks, options?.durationSeconds);
  const secondsPerChunk = totalDurationSeconds / chunks.length;
  const confidence = options?.confidence ?? 0.6;
  const startOffsetSeconds = options?.startOffsetSeconds ?? 0;
  const segmentIndexOffset = options?.segmentIndexOffset ?? 0;

  return chunks.map((chunk, index) => {
    const startSeconds = startOffsetSeconds + Math.floor(index * secondsPerChunk);
    const isLastChunk = index === chunks.length - 1;
    const endSeconds = isLastChunk
      ? startOffsetSeconds + Math.max(Math.floor(index * secondsPerChunk) + 1, Math.round(totalDurationSeconds))
      : startOffsetSeconds + Math.max(Math.floor(index * secondsPerChunk) + 1, Math.floor((index + 1) * secondsPerChunk));

    return classifySegment({
      id: `${input.uploadId}_seg_${segmentIndexOffset + index + 1}`,
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

function getTranscriptionRequestPayload(model: string, filePath: string) {
  if (isFourOTranscribeModel(model)) {
    return {
      file: fs.createReadStream(filePath),
      model,
      response_format: "json",
      chunking_strategy: "auto"
    } as unknown as OpenAITranscriptionRequest;
  }

  return {
    file: fs.createReadStream(filePath),
    model,
    response_format: "diarized_json",
    chunking_strategy: "auto"
  } as unknown as OpenAITranscriptionRequest;
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

async function probeAudioDurationSeconds(filePath: string) {
  try {
    const result = await execFileAsync(getFfprobeExecutable(), [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);
    const stdout = typeof result === "string" ? result : result.stdout;
    const durationSeconds = Number.parseFloat(String(stdout).trim());
    return Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
  } catch {
    return null;
  }
}

async function createAudioChunks(filePath: string, chunkSeconds: number) {
  const chunkDir = await fs.promises.mkdtemp(join(tmpdir(), "long-time-record-analyze-openrouter-"));
  const outputPattern = join(chunkDir, "chunk_%05d.mp3");

  try {
    await execFileAsync(getFfmpegExecutable(), [
      "-y",
      "-v",
      "error",
      "-i",
      filePath,
      "-vn",
      "-f",
      "segment",
      "-segment_time",
      String(chunkSeconds),
      "-reset_timestamps",
      "1",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "32k",
      outputPattern
    ]);

    const chunkFiles = (await fs.promises.readdir(chunkDir))
      .filter((fileName) => fileName.startsWith("chunk_"))
      .sort()
      .map((fileName) => join(chunkDir, fileName));

    if (chunkFiles.length === 0) {
      throw new Error("ffmpeg did not create any audio chunks");
    }

    return { chunkDir, chunkFiles };
  } catch (error) {
    await fs.promises.rm(chunkDir, { recursive: true, force: true });
    throw error;
  }
}

async function transcribeOpenRouterFile(input: { uploadId: string; filePath: string; mimeType: string }, model: string) {
  const payload = await requestOpenRouterTranscription(input, model);
  return buildSegmentsFromText(input, payload.text ?? "", {
    durationSeconds: payload.usage?.seconds,
    confidence: 0.55
  });
}

async function transcribeOpenRouterChunks(
  input: { uploadId: string; filePath: string; mimeType: string },
  model: string,
  chunkSeconds: number
) {
  const { chunkDir, chunkFiles } = await createAudioChunks(input.filePath, chunkSeconds);
  const segments: TranscriptSegment[] = [];

  try {
    for (const [chunkIndex, chunkFilePath] of chunkFiles.entries()) {
      const payload = await requestOpenRouterTranscription(
        {
          filePath: chunkFilePath,
          mimeType: "audio/mpeg"
        },
        model
      );
      segments.push(
        ...buildSegmentsFromText(input, payload.text ?? "", {
          durationSeconds: payload.usage?.seconds ?? chunkSeconds,
          confidence: 0.55,
          startOffsetSeconds: chunkIndex * chunkSeconds,
          segmentIndexOffset: segments.length
        })
      );
    }
  } finally {
    await fs.promises.rm(chunkDir, { recursive: true, force: true });
  }

  return segments;
}

async function transcribeWithOpenRouter(input: { uploadId: string; filePath: string; mimeType: string }, model: string) {
  const chunkSeconds = getOpenRouterChunkSeconds();
  const durationSeconds = await probeAudioDurationSeconds(input.filePath);

  if (durationSeconds !== null && durationSeconds > chunkSeconds) {
    return await transcribeOpenRouterChunks(input, model, chunkSeconds);
  }

  return await transcribeOpenRouterFile(input, model);
}

export const openaiTranscriptionProvider: TranscriptionProvider = {
  async transcribe(input) {
    const model = getTranscriptionModel();
    if ((await resolveOpenAICompatibleRouting()).usesOpenRouter) {
      return await transcribeWithOpenRouter(input, model);
    }

    const client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
    // Current OpenAI SDK types lag diarized_json support, so keep this cast scoped to the API request.
    const request = getTranscriptionRequestPayload(model, input.filePath);

    const response = await client.audio.transcriptions.create(request);

    const segments = ((response as { segments?: DiarizedSegment[] }).segments ?? []).map((segment, index): TranscriptSegment =>
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
      const text = (response as { text?: string }).text ?? "";
      return buildSegmentsFromText(input, text);
    }

    return segments;
  }
};
