import OpenAI from "openai";
import { z } from "zod";

import { normalizeAiAudioInsightItems } from "@/lib/processing/ai-audio-insights";
import {
  parseJsonObjectFromModelText,
  StructuredJsonResponseError
} from "@/lib/server/openai/structured-json";

import type { AudioInsightProvider } from "./provider";

import type { TranscriptSegment } from "@/lib/domain/types";

export type DeepseekAudioInsightFailureCode =
  | "missing_api_key"
  | "invalid_base_url"
  | "invalid_model"
  | "empty_response"
  | "incomplete_response"
  | "invalid_json"
  | "invalid_schema"
  | "invalid_evidence"
  | "timeout"
  | "api_error";

export class DeepseekAudioInsightError extends Error {
  constructor(public readonly code: DeepseekAudioInsightFailureCode) {
    super(`DeepSeek audio insight failed: ${code}`);
    this.name = "DeepseekAudioInsightError";
  }
}

type DeepseekClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<{
        choices?: Array<{
          finish_reason?: string | null;
          message?: {
            content?: string | Array<{ type?: string; text?: string }> | null;
          };
        }>;
      }>;
    };
  };
};

type DeepseekClientConfig = {
  apiKey: string;
  baseURL: string;
  timeout: number;
  maxRetries: number;
};

type Logger = Pick<Console, "info" | "warn">;

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
const allowedModels = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const DeepseekAudioInsightResponseSchema = z.object({
  items: z.array(z.unknown()).default([])
});

function readStringEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readPositiveIntEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(readStringEnv(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveBaseUrl() {
  return (readStringEnv("DEEPSEEK_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function resolveTimeoutMs() {
  return Math.min(readPositiveIntEnv("AUDIO_INSIGHT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
}

function resolveFallbackName() {
  return readStringEnv("AUDIO_INSIGHT_FALLBACK_PROVIDER") ?? "rule";
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "APIUserAbortError" ||
      error.name === "APIConnectionTimeoutError")
  );
}

function segmentPrompt(segments: TranscriptSegment[]) {
  return segments
    .map(
      (segment) =>
        `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${segment.speaker ?? "speaker_unknown"} ` +
        `scene=${segment.sceneLabels.join(",")} value=${segment.valueLabels.join(",")}: ${segment.text}`
    )
    .join("\n");
}

function responseContentText(content: string | Array<{ type?: string; text?: string }> | null | undefined) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((item) => (typeof item?.text === "string" ? [item.text] : []))
    .join("\n")
    .trim();
}

function hasFabricatedSourceId(items: unknown[], segments: TranscriptSegment[]) {
  const allowed = new Set(segments.map((segment) => segment.id));
  return items.some((item) => {
    if (!item || typeof item !== "object" || !("sourceSegmentIds" in item)) {
      return false;
    }
    const ids = (item as { sourceSegmentIds?: unknown }).sourceSegmentIds;
    return Array.isArray(ids) && ids.some((id) => typeof id !== "string" || !allowed.has(id));
  });
}

function promptFor(segments: TranscriptSegment[]) {
  const exampleSegmentId = segments[0]?.id ?? "source_segment_id";
  const example = {
    items: [
      {
        sourceSegmentIds: [exampleSegmentId],
        speaker: { id: "speaker_1", role: "unknown", confidence: 0.6 },
        voice: {
          pace: "normal",
          volume: "unknown",
          pause: "unknown",
          overlap: false,
          confidence: 0.5
        },
        toneLabels: ["explaining"],
        emotionLabels: ["neutral"],
        interactionLabels: ["unknown"],
        summary: "A short evidence-grounded observation.",
        evidence: "The cited segment contains the described interaction clue.",
        confidence: 0.65
      }
    ]
  };
  const system = [
    "You analyze interaction clues in transcript segments.",
    "Return exactly one JSON object with an items array. Do not use Markdown or explanatory text.",
    "Every item must cite only supplied sourceSegmentIds.",
    "Treat tone and emotion as uncertain clues, not diagnoses or personality conclusions.",
    "Do not recommend ending a relationship and do not invent timestamps, speakers, or evidence.",
    "Use these enums:",
    "speaker.role: self | other | customer | teammate | teacher | unknown",
    "voice.pace: slow | normal | fast | unknown",
    "voice.volume: low | normal | high | unknown",
    "voice.pause: few | normal | many | unknown",
    "toneLabels: firm | hesitant | explaining | questioning | pushing_back | comforting | excited | perfunctory | playful | serious | unknown",
    "emotionLabels: relaxed | happy | interested | neutral | tense | anxious | confused | dissatisfied | tired | unknown",
    "interactionLabels: agreement | disagreement | follow_up_question | interruption | silence | topic_shift | tension | rapport | flirtation_or_testing | decision_moment | unknown"
  ].join("\n");
  const user = [
    "Return only high-value observations, at most 12 items for this chunk.",
    "Each item must contain:",
    "sourceSegmentIds, speaker{id,displayName?,role,confidence}, voice{pace,volume,pause,overlap,confidence},",
    "toneLabels, emotionLabels, interactionLabels, summary, evidence, confidence.",
    "If evidence is weak, use unknown/neutral labels or return fewer items.",
    "Follow this exact JSON shape and replace values only with evidence-grounded values:",
    JSON.stringify(example, null, 2),
    "Transcript segments:",
    segmentPrompt(segments)
  ].join("\n");

  return { system, user };
}

function defaultClientFactory(config: DeepseekClientConfig): DeepseekClient {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeout,
    maxRetries: config.maxRetries
  }) as unknown as DeepseekClient;
}

export function createDeepseekAudioInsightProvider(deps: {
  clientFactory?: (config: DeepseekClientConfig) => DeepseekClient;
  now?: () => number;
  logger?: Logger;
} = {}): AudioInsightProvider {
  const clientFactory = deps.clientFactory ?? defaultClientFactory;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? console;

  return {
    async analyze(uploadId, segments, options) {
      const startedAt = now();
      const model = readStringEnv("DEEPSEEK_AUDIO_INSIGHT_MODEL") ?? DEFAULT_MODEL;
      const fallback = resolveFallbackName();
      const chunkIndex = options?.diagnostics?.chunkIndex ?? -1;
      const attempt = options?.diagnostics?.attempt ?? 1;
      const concurrency = options?.diagnostics?.concurrency ?? 1;
      const attemptTimeoutMs = options?.diagnostics?.attemptTimeoutMs ?? resolveTimeoutMs();
      let inputCharacterCount = 0;
      let responseTextLength = 0;
      let finishReason = "unknown";
      let parseResult = "not_started";
      let validationResult = "not_started";
      const fail = (code: DeepseekAudioInsightFailureCode): never => {
        logger.warn(
          `[audio-insight] upload_id=${uploadId} chunk_index=${chunkIndex} provider=deepseek model=${model} segments=${segments.length} input_chars=${inputCharacterCount} attempt=${attempt} concurrency=${concurrency} attempt_timeout_ms=${attemptTimeoutMs} provider_status=failed response_text_length=${responseTextLength} finish_reason=${finishReason} parse_result=${parseResult} validation_result=${validationResult} retry_reason=${code} fallback=${fallback} elapsed_ms=${Math.max(0, now() - startedAt)}`
        );
        throw new DeepseekAudioInsightError(code);
      };

      if (segments.length === 0) {
        logger.info(
          `[audio-insight] provider=deepseek model=${model} segments=0 completed=true elapsed_ms=${Math.max(0, now() - startedAt)} fallback=false`
        );
        return [];
      }

      const apiKey = readStringEnv("DEEPSEEK_API_KEY");
      if (!apiKey) {
        return fail("missing_api_key");
      }
      const baseURL = resolveBaseUrl();
      if (baseURL !== DEFAULT_BASE_URL) {
        return fail("invalid_base_url");
      }
      if (!allowedModels.has(model) || model.includes("/")) {
        return fail("invalid_model");
      }

      try {
        const client = clientFactory({
          apiKey,
          baseURL,
          timeout: resolveTimeoutMs(),
          maxRetries: 0
        });
        const prompt = promptFor(segments);
        inputCharacterCount = prompt.system.length + prompt.user.length;
        logger.info(
          `[audio-insight] upload_id=${uploadId} chunk_index=${chunkIndex} provider=deepseek model=${model} segments=${segments.length} input_chars=${inputCharacterCount} attempt=${attempt} concurrency=${concurrency} attempt_timeout_ms=${attemptTimeoutMs} provider_status=started`
        );
        const request = {
          model,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          max_tokens: readPositiveIntEnv(
            "AUDIO_INSIGHT_MAX_OUTPUT_TOKENS",
            DEFAULT_MAX_OUTPUT_TOKENS
          ),
          thinking: { type: "disabled" }
        };
        const response = options?.signal
          ? await (client.chat.completions.create as (
              request: Record<string, unknown>,
              options: { signal: AbortSignal }
            ) => ReturnType<DeepseekClient["chat"]["completions"]["create"]>)(request, {
              signal: options.signal
            })
          : await client.chat.completions.create(request);
        const choice = response.choices?.[0];
        finishReason = choice?.finish_reason ?? "unknown";
        const content = responseContentText(choice?.message?.content);
        responseTextLength = content.length;
        if (finishReason === "length") {
          return fail("incomplete_response");
        }
        if (!content) {
          return fail("empty_response");
        }

        let raw: unknown;
        try {
          raw = parseJsonObjectFromModelText(content);
          parseResult = "success";
        } catch (error) {
          parseResult = "failed";
          return fail(
            error instanceof StructuredJsonResponseError && error.code === "incomplete_json"
              ? "incomplete_response"
              : "invalid_json"
          );
        }
        const parsed = DeepseekAudioInsightResponseSchema.safeParse(raw);
        if (!parsed.success) {
          validationResult = "failed";
          return fail("invalid_schema");
        }
        if (hasFabricatedSourceId(parsed.data.items, segments)) {
          validationResult = "failed";
          return fail("invalid_evidence");
        }
        const insights = normalizeAiAudioInsightItems({
          uploadId,
          segments,
          items: parsed.data.items
        });
        if (insights.length === 0) {
          validationResult = "failed";
          return fail("invalid_schema");
        }
        validationResult = "success";

        logger.info(
          `[audio-insight] upload_id=${uploadId} chunk_index=${chunkIndex} provider=deepseek model=${model} segments=${segments.length} input_chars=${inputCharacterCount} attempt=${attempt} concurrency=${concurrency} attempt_timeout_ms=${attemptTimeoutMs} provider_status=success response_text_length=${responseTextLength} finish_reason=${finishReason} parse_result=${parseResult} validation_result=${validationResult} completed=true accepted=${insights.length} rejected=${Math.max(0, parsed.data.items.length - insights.length)} elapsed_ms=${Math.max(0, now() - startedAt)} fallback=false`
        );
        return insights;
      } catch (error) {
        if (error instanceof DeepseekAudioInsightError) {
          throw error;
        }
        return fail(isTimeoutError(error) ? "timeout" : "api_error");
      }
    }
  };
}

export const deepseekAudioInsightProvider = createDeepseekAudioInsightProvider();
