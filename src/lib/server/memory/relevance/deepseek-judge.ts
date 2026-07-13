import OpenAI from "openai";

import { parseJsonObjectFromModelText } from "@/lib/server/openai/structured-json";

import {
  MemoryRelevanceResponseSchema,
  type MemoryRelevanceJudge,
  type MemoryRelevanceJudgeRunResult
} from "./types";

type DeepseekClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<{
        choices?: Array<{ message?: { content?: string | null } }>;
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

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_600;
const allowedModels = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

function readStringEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readPositiveIntEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(readStringEnv(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerEnabled() {
  const configured = (readStringEnv("MEMORY_RELEVANCE_PROVIDER") ?? "auto").toLowerCase();
  if (configured === "none") {
    return false;
  }
  if (configured === "deepseek") {
    return true;
  }
  return configured === "auto" && (readStringEnv("PROACTIVE_INSIGHT_PROVIDER") ?? "none").toLowerCase() === "deepseek";
}

function normalizeBaseUrl(value: string | undefined) {
  return (value ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.name === "APIUserAbortError" ||
    error.name === "APIConnectionTimeoutError"
  );
}

function defaultClientFactory(config: DeepseekClientConfig): DeepseekClient {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeout,
    maxRetries: config.maxRetries
  }) as unknown as DeepseekClient;
}

function buildPrompt(input: Parameters<MemoryRelevanceJudge["judge"]>[0]) {
  const systemPrompt = [
    "You are a memory relevance judge, not a user-facing assistant and not a relationship analyst.",
    "Decide whether each historical memory can help a proactive companion assistant offer a useful reminder for the current recording.",
    "High importance alone is never a reason to use a memory.",
    "Do not invent facts, infer relationship status, judge personality, diagnose, or expand the meaning of history.",
    "A memory shouldUse=true only when it is topically relevant to the current context and useful to mention now.",
    "A related but non-actionable or generic memory shouldUse=false.",
    "Return one result for every supplied memoryId.",
    "Return JSON only, without Markdown, comments, or extra fields.",
    "Each result must contain exactly: memoryId, shouldUse, relevanceScore, usefulnessScore, reason, and optional caution.",
    "relevanceScore and usefulnessScore must be numbers from 0 to 1. Keep reason factual and brief."
  ].join("\n");

  const userPrompt = JSON.stringify({
    currentContext: input.current,
    candidateMemories: input.candidates,
    outputExample: {
      results: [
        {
          memoryId: "memory_example",
          shouldUse: false,
          relevanceScore: 0.18,
          usefulnessScore: 0.12,
          reason: "The earlier travel plan does not help with the current game interaction.",
          caution: "Do not force an unrelated historical topic into the reminder."
        }
      ]
    }
  });

  return { systemPrompt, userPrompt };
}

export function createDeepseekMemoryRelevanceJudge(deps: {
  clientFactory?: (config: DeepseekClientConfig) => DeepseekClient;
  now?: () => number;
} = {}): MemoryRelevanceJudge {
  const clientFactory = deps.clientFactory ?? defaultClientFactory;
  const now = deps.now ?? (() => Date.now());

  return {
    async judge(input): Promise<MemoryRelevanceJudgeRunResult> {
      const startedAt = now();
      const complete = (result: Omit<MemoryRelevanceJudgeRunResult, "elapsedMs">) => ({
        ...result,
        elapsedMs: Math.max(0, now() - startedAt)
      });

      if (!providerEnabled()) {
        return complete({ status: "disabled", rawResults: [], provider: "none", failureCode: "disabled" });
      }

      const model = readStringEnv("DEEPSEEK_MODEL") ?? DEFAULT_MODEL;
      const apiKey = readStringEnv("DEEPSEEK_API_KEY");
      if (!apiKey) {
        return complete({ status: "fallback", rawResults: [], provider: "deepseek", model, failureCode: "missing_api_key" });
      }
      const baseURL = normalizeBaseUrl(readStringEnv("DEEPSEEK_BASE_URL"));
      if (baseURL !== DEFAULT_BASE_URL) {
        return complete({ status: "fallback", rawResults: [], provider: "deepseek", model, failureCode: "invalid_base_url" });
      }
      if (model.includes("/") || !allowedModels.has(model)) {
        return complete({ status: "fallback", rawResults: [], provider: "deepseek", model, failureCode: "invalid_model" });
      }

      try {
        const timeout = Math.min(
          readPositiveIntEnv("MEMORY_RELEVANCE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
          MAX_TIMEOUT_MS
        );
        const client = clientFactory({ apiKey, baseURL, timeout, maxRetries: 0 });
        const prompt = buildPrompt(input);
        const response = await client.chat.completions.create({
          model,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt.systemPrompt },
            { role: "user", content: prompt.userPrompt }
          ],
          max_tokens: readPositiveIntEnv("MEMORY_RELEVANCE_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
          thinking: { type: "disabled" }
        });
        const content = response.choices?.[0]?.message?.content?.trim();
        if (!content) {
          return complete({ status: "fallback", rawResults: [], provider: "deepseek", model, failureCode: "empty_response" });
        }

        let parsed: unknown;
        try {
          parsed = parseJsonObjectFromModelText(content);
        } catch {
          return complete({ status: "fallback", rawResults: [], provider: "deepseek", model, failureCode: "invalid_json" });
        }
        const responseDocument = MemoryRelevanceResponseSchema.safeParse(parsed);
        if (!responseDocument.success) {
          return complete({ status: "fallback", rawResults: [], provider: "deepseek", model, failureCode: "invalid_schema" });
        }

        return complete({
          status: "judged",
          rawResults: responseDocument.data.results,
          provider: "deepseek",
          model
        });
      } catch (error) {
        return complete({
          status: "fallback",
          rawResults: [],
          provider: "deepseek",
          model,
          failureCode: isTimeoutError(error) ? "timeout" : "api_error"
        });
      }
    }
  };
}

export function getMemoryRelevanceJudge() {
  return createDeepseekMemoryRelevanceJudge();
}

