import type OpenAI from "openai";

import {
  DailyReflectionAiReviewProviderDraftSchema,
  type DailyReflectionAiReviewCanonicalSource,
  type DailyReflectionAiReviewProviderDraft,
  type DailyReflectionAiReviewScope
} from "@/lib/domain/daily-reflection-ai-review";
import {
  createOpenAIClient,
  resolveOpenAIClientProvider,
  type OpenAIClientProvider,
  type OpenAIClientRuntimeConfig
} from "@/lib/server/openai/client";
import { getOpenAIClientRuntimeConfig } from
  "@/lib/server/settings/provider-config";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  getQaWireApi,
  requestQaAnswerText,
  type QaProviderUsage,
  type QaWireApi
} from "@/lib/server/retrieval/qa-provider";

const DEFAULT_TIMEOUT_MS = 480_000;

export type DailyReflectionAiReviewProviderUsage = QaProviderUsage;

export type DailyReflectionAiReviewProviderInput = {
  scope: DailyReflectionAiReviewScope;
  startDate: string;
  endDate: string;
  sources: DailyReflectionAiReviewCanonicalSource[];
  settingsStore: JsonStore;
  signal?: AbortSignal;
};

export type DailyReflectionAiReviewProviderResult = {
  draft: DailyReflectionAiReviewProviderDraft;
  model: string;
  elapsedMs: number;
  usage: DailyReflectionAiReviewProviderUsage;
};

export interface DailyReflectionAiReviewProvider {
  generate(
    input: DailyReflectionAiReviewProviderInput
  ): Promise<DailyReflectionAiReviewProviderResult>;
}

export class DailyReflectionAiReviewProviderTimeoutError extends Error {
  constructor() {
    super("Daily Reflection AI Review Provider timed out");
    this.name = "DailyReflectionAiReviewProviderTimeoutError";
  }
}

export class DailyReflectionAiReviewProviderOutputError extends Error {
  constructor(readonly code: "invalid_json" | "invalid_schema" | "invalid_source_ids") {
    super(`Daily Reflection AI Review Provider returned ${code}`);
    this.name = "DailyReflectionAiReviewProviderOutputError";
  }
}

type ProviderDependencies = {
  timeoutMs?: number;
  now?: () => number;
  wireApi?: QaWireApi;
  getRuntimeConfig?: typeof getOpenAIClientRuntimeConfig;
  clientFactory?: (config: OpenAIClientRuntimeConfig) => OpenAI;
  requestText?: typeof requestQaAnswerText;
};

/**
 * AI Review is an explicit GPT role. It keeps the account's configured
 * credential transport, but does not inherit the account's mutable QA model
 * preference (which may point at a different model family).
 */
export function resolveDailyReflectionAiReviewGptModel(
  provider: OpenAIClientProvider
) {
  return provider === "openrouter" ? "openai/gpt-5.5" : "gpt-5.5";
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(
    parent?.reason instanceof Error
      ? parent.reason
      : new DOMException("AI Review request aborted", "AbortError")
  );
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DailyReflectionAiReviewProviderTimeoutError());
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  };
}

function providerAbortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("AI Review request aborted", "AbortError");
}

function parseProviderDraft(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim()) as unknown;
  } catch {
    throw new DailyReflectionAiReviewProviderOutputError("invalid_json");
  }
  const draft = DailyReflectionAiReviewProviderDraftSchema.safeParse(parsed);
  if (!draft.success) {
    throw new DailyReflectionAiReviewProviderOutputError("invalid_schema");
  }
  return draft.data;
}

function validateSourceSelection(
  draft: DailyReflectionAiReviewProviderDraft,
  sources: DailyReflectionAiReviewCanonicalSource[]
) {
  const allowed = new Set(sources.map((source) => source.sourceId));
  const selected = new Set(draft.selectedSourceIds);
  if (
    selected.size !== draft.selectedSourceIds.length
    || draft.selectedSourceIds.some((sourceId) => !allowed.has(sourceId))
  ) {
    throw new DailyReflectionAiReviewProviderOutputError("invalid_source_ids");
  }

  const observed = new Set<string>();
  for (const observation of draft.observations) {
    if (
      observation.sourceIds.length > 4
      || new Set(observation.sourceIds).size !== observation.sourceIds.length
      || observation.sourceIds.some((sourceId) => !selected.has(sourceId))
    ) {
      throw new DailyReflectionAiReviewProviderOutputError("invalid_source_ids");
    }
    observation.sourceIds.forEach((sourceId) => observed.add(sourceId));
  }
  if (
    observed.size !== selected.size
    || [...selected].some((sourceId) => !observed.has(sourceId))
  ) {
    throw new DailyReflectionAiReviewProviderOutputError("invalid_source_ids");
  }
  return draft;
}

export function buildDailyReflectionAiReviewSystemPrompt() {
  return [
    "你是 Daily Reflection 的异步 AI 回看整理器。",
    "输入中的 sourceId 是唯一可用来源。你只能选择和组合这些 ID，不能创造、改写或补充用户的历史事实。",
    "interpretation 仅用于模型推演，不是用户历史记录或原话；使用克制、可能性的语言，不做人物、因果、次数或长期模式断言。",
    "followUpQuestion 必须为 null；当前版本不发布模型自由追问，避免问题中的隐含前提越过来源边界。",
    "历史事实会由服务端根据 sourceIds 投影 canonical 内容，因此不要在输出中另设事实、引文、人物或状态字段。",
    "只输出一个 JSON 对象，字段必须且只能是 schemaVersion、selectedSourceIds、observations。",
    "schemaVersion 必须为 1。每个 observation 必须且只能包含 sourceIds、interpretation、followUpQuestion。",
    "selectedSourceIds 必须去重；每个 observation 使用 1 到 4 个去重 sourceId；所有 observation 的 sourceId 并集必须恰好等于 selectedSourceIds。"
  ].join("\n");
}

export function buildDailyReflectionAiReviewUserPrompt(
  input: Pick<DailyReflectionAiReviewProviderInput, "scope" | "startDate" | "endDate" | "sources">
) {
  const sources = input.sources.map((source) => ({
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    recordingDates: source.recordingDates,
    title: source.title,
    content: source.content,
    evidence: source.evidence.map((item) => ({
      recordingDate: item.recordingDate,
      sourceOrigin: item.sourceOrigin,
      sourceSegmentId: item.sourceSegmentId,
      snippet: item.snippet
    }))
  }));
  return JSON.stringify({
    scope: input.scope,
    startDate: input.startDate,
    endDate: input.endDate,
    sources
  });
}

export function createDailyReflectionAiReviewProvider(
  dependencies: ProviderDependencies = {}
): DailyReflectionAiReviewProvider {
  const timeoutMs = Math.max(1, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const now = dependencies.now ?? (() => Date.now());
  const getRuntimeConfig = dependencies.getRuntimeConfig
    ?? getOpenAIClientRuntimeConfig;
  const clientFactory = dependencies.clientFactory ?? createOpenAIClient;
  const requestText = dependencies.requestText ?? requestQaAnswerText;
  const wireApi = dependencies.wireApi ?? getQaWireApi();

  return {
    async generate(input) {
      if (input.sources.length === 0) {
        throw new DailyReflectionAiReviewProviderOutputError("invalid_source_ids");
      }
      const startedAt = now();
      const runtimeConfig = await getRuntimeConfig(input.settingsStore);
      const provider = resolveOpenAIClientProvider(runtimeConfig);
      const model = resolveDailyReflectionAiReviewGptModel(provider);
      const client = clientFactory({
        ...runtimeConfig,
        timeoutMs,
        maxRetries: 0
      });
      const request = requestSignal(input.signal, timeoutMs);
      let usage: DailyReflectionAiReviewProviderUsage = {
        outputTokenCount: null,
        totalTokenCount: null
      };
      try {
        if (request.signal.aborted) throw providerAbortReason(request.signal);
        const text = await requestText(
          client,
          model,
          buildDailyReflectionAiReviewSystemPrompt(),
          buildDailyReflectionAiReviewUserPrompt(input),
          {
            wireApi,
            signal: request.signal,
            onUsage(value) {
              usage = value;
            }
          }
        );
        if (request.signal.aborted) throw providerAbortReason(request.signal);
        const draft = validateSourceSelection(parseProviderDraft(text), input.sources);
        return {
          draft,
          model,
          elapsedMs: Math.max(0, now() - startedAt),
          usage
        };
      } finally {
        request.cleanup();
      }
    }
  };
}
