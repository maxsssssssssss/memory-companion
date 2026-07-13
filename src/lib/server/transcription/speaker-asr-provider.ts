import { randomUUID } from "crypto";
import { sep } from "path";
import type { TranscriptSegment } from "@/lib/domain/types";
import { classifySegment } from "@/lib/processing/classifier";
import type { TranscriptionProvider } from "./provider";

type SpeakerAsrSubmitResponse = {
  code?: number;
  message?: string;
  data?: SpeakerAsrResultData;
};

type SpeakerAsrQueryResponse = SpeakerAsrSubmitResponse;

type SpeakerAsrSentence = {
  text?: string;
  timestamp?: Array<{ start?: number; end?: number }>;
  timestamps?: Array<{ start?: number; end?: number }> | { start?: number; end?: number };
  language?: string;
  emotion?: string;
  event?: string;
};

type SpeakerAsrResultData = {
  asr_result?: {
    detected_language?: string;
    total_sentences?: number;
    sentences?: SpeakerAsrSentence[];
  };
  speaker_result?: Array<{
    speaker?: string;
    text?: string;
  }>;
};

const BASE_URL_ENV = "SPEAKER_ASR_BASE_URL";
const AUDIO_BASE_URL_ENV = "SPEAKER_ASR_AUDIO_BASE_URL";
const AUDIO_URL_TEMPLATE_ENV = "SPEAKER_ASR_AUDIO_URL_TEMPLATE";
const AUDIO_ACCESS_TOKEN_ENV = "SPEAKER_ASR_AUDIO_ACCESS_TOKEN";
const SPEAKER_COUNT_ENV = "SPEAKER_ASR_SPEAKER";
const LANGUAGE_ENV = "SPEAKER_ASR_LANGUAGE";
const TIMEOUT_MS_ENV = "SPEAKER_ASR_TIMEOUT_MS";
const POLL_INTERVAL_MS_ENV = "SPEAKER_ASR_POLL_INTERVAL_MS";
const DEFAULT_LANGUAGE = "cn";
const DEFAULT_SPEAKER_COUNT = 0;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function readStringEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readNumberEnv(name: string, defaultValue: number) {
  const value = readStringEnv(name);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function requireBaseUrl() {
  const baseUrl = readStringEnv(BASE_URL_ENV);
  if (!baseUrl) {
    throw new Error(`${BASE_URL_ENV} is required when using speaker-asr transcription provider`);
  }

  return trimBaseUrl(baseUrl);
}

function getSpeakerCount() {
  const speakerCount = readNumberEnv(SPEAKER_COUNT_ENV, DEFAULT_SPEAKER_COUNT);
  if (speakerCount === -1 || speakerCount === 0 || (speakerCount >= 1 && speakerCount <= 10)) {
    return speakerCount;
  }

  return DEFAULT_SPEAKER_COUNT;
}

function getLanguageList() {
  const rawLanguage = readStringEnv(LANGUAGE_ENV) ?? DEFAULT_LANGUAGE;
  return rawLanguage
    .split(",")
    .map((language) => language.trim())
    .filter(Boolean);
}

function parseUserIdFromUploadPath(filePath: string) {
  const parts = filePath.split(sep);
  const usersIndex = parts.lastIndexOf("users");
  const userId = usersIndex >= 0 ? parts[usersIndex + 1] : undefined;

  return userId && SAFE_ID_PATTERN.test(userId) ? userId : undefined;
}

function buildAudioUrl(input: { uploadId: string; filePath: string }) {
  const userId = parseUserIdFromUploadPath(input.filePath);
  const accessToken = readStringEnv(AUDIO_ACCESS_TOKEN_ENV);
  const template = readStringEnv(AUDIO_URL_TEMPLATE_ENV);

  if (template) {
    return template
      .replaceAll("{uploadId}", encodeURIComponent(input.uploadId))
      .replaceAll("{userId}", encodeURIComponent(userId ?? ""))
      .replaceAll("{token}", encodeURIComponent(accessToken ?? ""));
  }

  const audioBaseUrl = readStringEnv(AUDIO_BASE_URL_ENV);
  if (!audioBaseUrl || !accessToken || !userId) {
    throw new Error(
      `${AUDIO_BASE_URL_ENV}, ${AUDIO_ACCESS_TOKEN_ENV}, and a user-scoped upload file path are required to build speaker-asr audio_url`
    );
  }

  return `${trimBaseUrl(audioBaseUrl)}/api/internal/audio/${encodeURIComponent(userId)}/${encodeURIComponent(input.uploadId)}?token=${encodeURIComponent(accessToken)}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const rawBody = await response.text();
  if (!rawBody) {
    return {} as T;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error(`speaker-asr provider returned non-JSON response: ${rawBody.slice(0, 180)}`);
  }
}

function assertAccepted(payload: SpeakerAsrSubmitResponse, action: string) {
  if (payload.code !== 0) {
    throw new Error(`speaker-asr ${action} failed: code=${payload.code ?? "unknown"} message=${payload.message ?? "unknown"}`);
  }
}

async function submitSpeakerAsr(input: { uploadId: string; filePath: string; userId?: string; reqId: string }) {
  const response = await fetch(`${requireBaseUrl()}/api/ai/non-realtime-asr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      req_id: input.reqId,
      audio_url: buildAudioUrl(input),
      record_id: input.uploadId,
      user_id: input.userId ?? parseUserIdFromUploadPath(input.filePath) ?? input.uploadId,
      language: getLanguageList(),
      speaker: getSpeakerCount()
    })
  });
  const payload = await parseJsonResponse<SpeakerAsrSubmitResponse>(response);

  if (!response.ok) {
    throw new Error(`speaker-asr submit failed: http=${response.status} message=${payload.message ?? response.statusText}`);
  }
  assertAccepted(payload, "submit");

  return payload;
}

async function querySpeakerAsr(reqId: string) {
  const response = await fetch(`${requireBaseUrl()}/api/ai/non-realtime-asr/query?reqid=${encodeURIComponent(reqId)}`);
  const payload = await parseJsonResponse<SpeakerAsrQueryResponse>(response);

  if (!response.ok) {
    throw new Error(`speaker-asr query failed: http=${response.status} message=${payload.message ?? response.statusText}`);
  }

  return payload;
}

async function waitForSpeakerAsr(reqId: string) {
  const startedAt = Date.now();
  const timeoutMs = Math.max(30_000, readNumberEnv(TIMEOUT_MS_ENV, DEFAULT_TIMEOUT_MS));
  const pollIntervalMs = Math.max(500, readNumberEnv(POLL_INTERVAL_MS_ENV, DEFAULT_POLL_INTERVAL_MS));

  while (Date.now() - startedAt <= timeoutMs) {
    const payload = await querySpeakerAsr(reqId);
    if (payload.code === 0) {
      return payload.data ?? {};
    }
    if (payload.code === 2) {
      await sleep(pollIntervalMs);
      continue;
    }

    throw new Error(`speaker-asr query failed: code=${payload.code ?? "unknown"} message=${payload.message ?? "unknown"}`);
  }

  throw new Error(`speaker-asr query timed out after ${timeoutMs}ms`);
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, "").replace(/[，。！？；、,.!?;:"“”‘’'（）()]/g, "").trim();
}

function timestampRange(sentence: SpeakerAsrSentence, fallbackIndex: number) {
  const rawTimestamps = sentence.timestamp ?? sentence.timestamps;
  const points = Array.isArray(rawTimestamps)
    ? rawTimestamps
    : rawTimestamps && typeof rawTimestamps === "object"
      ? [rawTimestamps]
      : [];
  const starts = points.map((point) => point.start).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const ends = points.map((point) => point.end).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const startMs = starts.length > 0 ? Math.min(...starts) : fallbackIndex * 1_000;
  const endMs = ends.length > 0 ? Math.max(...ends) : startMs + 1_000;
  const startSeconds = Math.max(0, startMs / 1_000);
  const endSeconds = Math.max(startSeconds + 0.1, endMs / 1_000);

  return { startSeconds, endSeconds };
}

function speakerMatcher(speakerResult: NonNullable<SpeakerAsrResultData["speaker_result"]>) {
  const spans = speakerResult
    .map((item) => ({
      speaker: item.speaker?.trim() || undefined,
      remainingText: normalizeText(item.text ?? "")
    }))
    .filter((item) => item.speaker && item.remainingText.length > 0);
  let cursor = 0;

  return (text: string) => {
    const normalized = normalizeText(text);
    if (!normalized) {
      return spans[cursor]?.speaker;
    }

    while (cursor < spans.length && spans[cursor].remainingText.length === 0) {
      cursor += 1;
    }

    const current = spans[cursor];
    if (!current) {
      return undefined;
    }

    const matchIndex = current.remainingText.indexOf(normalized);
    if (matchIndex >= 0) {
      current.remainingText = current.remainingText.slice(matchIndex + normalized.length);
      return current.speaker;
    }

    const laterIndex = spans.findIndex((span, index) => index > cursor && span.remainingText.includes(normalized));
    if (laterIndex >= 0) {
      cursor = laterIndex;
      spans[cursor].remainingText = spans[cursor].remainingText.replace(normalized, "");
      return spans[cursor].speaker;
    }

    return current.speaker;
  };
}

function segmentsFromSpeakerResult(uploadId: string, speakerResult: NonNullable<SpeakerAsrResultData["speaker_result"]>) {
  return speakerResult
    .filter((item) => item.text?.trim())
    .map((item, index) =>
      classifySegment({
        id: `${uploadId}_seg_${index + 1}`,
        uploadId,
        startSeconds: index,
        endSeconds: index + 1,
        speaker: item.speaker?.trim(),
        text: item.text?.trim() ?? "",
        confidence: 0.68,
        sceneLabels: [],
        valueLabels: []
      })
    );
}

function buildSegmentsFromSpeakerAsr(uploadId: string, data: SpeakerAsrResultData): TranscriptSegment[] {
  const sentences = data.asr_result?.sentences?.filter((sentence) => sentence.text?.trim()) ?? [];
  const speakerResult = data.speaker_result ?? [];
  const matchSpeaker = speakerMatcher(speakerResult);

  if (sentences.length === 0) {
    return segmentsFromSpeakerResult(uploadId, speakerResult);
  }

  return sentences.map((sentence, index) => {
    const text = sentence.text?.trim() ?? "";
    const { startSeconds, endSeconds } = timestampRange(sentence, index);

    return classifySegment({
      id: `${uploadId}_seg_${index + 1}`,
      uploadId,
      startSeconds,
      endSeconds,
      speaker: matchSpeaker(text),
      text,
      confidence: 0.72,
      sceneLabels: [],
      valueLabels: []
    });
  });
}

export const speakerAsrTranscriptionProvider: TranscriptionProvider = {
  async transcribe(input) {
    const reqId = `daily_brief_${input.uploadId}_${randomUUID()}`;
    const submitted = await submitSpeakerAsr({
      ...input,
      userId: parseUserIdFromUploadPath(input.filePath),
      reqId
    });
    const data = submitted.data?.asr_result || submitted.data?.speaker_result ? submitted.data : await waitForSpeakerAsr(reqId);
    const segments = buildSegmentsFromSpeakerAsr(input.uploadId, data ?? {});

    if (segments.length === 0) {
      throw new Error("speaker-asr provider returned no transcript segments");
    }

    return segments;
  }
};
