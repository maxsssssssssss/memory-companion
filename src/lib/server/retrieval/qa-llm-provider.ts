import type OpenAI from "openai";
import { createHash } from "node:crypto";

import {
  createOpenAIClient,
  resolveOpenAIClientProvider,
  type OpenAIClientProvider
} from "@/lib/server/openai/client";
import {
  getOpenAIClientRuntimeConfig,
  getQaModelPreference
} from "@/lib/server/settings/provider-config";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  getQaWireApi,
  requestQaAnswerText,
  requestQaAnswerTextStream,
  type QaProviderRequestOptions,
  type QaProviderUsage,
  type QaWireApi
} from "./qa-provider";

const DEFAULT_VLLM_BASE_URL = "http://127.0.0.1:8700/v1";
const DEFAULT_VLLM_MODEL = "Qwen/Qwen3.6-27B";

export type QaLlmProviderId = "gpt-5.5" | "qwen-vllm";

export type QaLlmProviderMetrics = QaProviderUsage & {
  providerId: QaLlmProviderId;
  model: string;
  reasoningEnabled: boolean | null;
};

export type QaLlmProviderMetricsObserver = (metrics: QaLlmProviderMetrics) => unknown;

export interface QaLlmProvider {
  readonly id: QaLlmProviderId;
  readonly logProvider: OpenAIClientProvider | "qwen-vllm";
  readonly model: string;
  readonly wireApi: QaWireApi;
  readonly reasoningEnabled: boolean | null;
  readonly endpointFingerprint: string;
  answerText(
    systemPrompt: string,
    userPrompt: string,
    onMetrics?: QaLlmProviderMetricsObserver,
    signal?: AbortSignal
  ): Promise<string>;
  answerTextStream(
    systemPrompt: string,
    userPrompt: string,
    onMetrics?: QaLlmProviderMetricsObserver,
    signal?: AbortSignal
  ): AsyncGenerator<string>;
}

type QaLlmProviderConstructor = {
  client: OpenAI;
  model: string;
  wireApi: QaWireApi;
  logProvider: QaLlmProvider["logProvider"];
  endpointFingerprint?: string;
};

function usageObserver(
  provider: QaLlmProvider,
  observer?: QaLlmProviderMetricsObserver
): QaProviderRequestOptions["onUsage"] {
  if (!observer) return undefined;
  return (usage) => observer({
    ...usage,
    providerId: provider.id,
    model: provider.model,
    reasoningEnabled: provider.reasoningEnabled
  });
}

export class GPT55Provider implements QaLlmProvider {
  readonly id = "gpt-5.5" as const;
  readonly reasoningEnabled = null;
  readonly endpointFingerprint: string;
  readonly client: OpenAI;
  readonly model: string;
  readonly wireApi: QaWireApi;
  readonly logProvider: OpenAIClientProvider;

  constructor(input: QaLlmProviderConstructor) {
    this.client = input.client;
    this.model = input.model;
    this.wireApi = input.wireApi;
    this.logProvider = input.logProvider === "qwen-vllm"
      ? "openai-compatible"
      : input.logProvider;
    this.endpointFingerprint =
      input.endpointFingerprint ?? endpointFingerprint("unresolved");
  }

  answerText(
    systemPrompt: string,
    userPrompt: string,
    onMetrics?: QaLlmProviderMetricsObserver,
    signal?: AbortSignal
  ) {
    return requestQaAnswerText(this.client, this.model, systemPrompt, userPrompt, {
      wireApi: this.wireApi,
      onUsage: usageObserver(this, onMetrics),
      ...(signal ? { signal } : {})
    });
  }

  answerTextStream(
    systemPrompt: string,
    userPrompt: string,
    onMetrics?: QaLlmProviderMetricsObserver,
    signal?: AbortSignal
  ) {
    return requestQaAnswerTextStream(this.client, this.model, systemPrompt, userPrompt, {
      wireApi: this.wireApi,
      onUsage: usageObserver(this, onMetrics),
      ...(signal ? { signal } : {})
    });
  }
}

export class VLLMQwenProvider implements QaLlmProvider {
  readonly id = "qwen-vllm" as const;
  readonly logProvider = "qwen-vllm" as const;
  readonly wireApi = "chat" as const;
  readonly client: OpenAI;
  readonly model: string;
  readonly reasoningEnabled: boolean;
  readonly endpointFingerprint: string;

  constructor(input: {
    client: OpenAI;
    model: string;
    reasoningEnabled: boolean;
    endpointFingerprint?: string;
  }) {
    this.client = input.client;
    this.model = input.model;
    this.reasoningEnabled = input.reasoningEnabled;
    this.endpointFingerprint =
      input.endpointFingerprint ?? endpointFingerprint("unresolved");
  }

  private requestOptions(
    onMetrics?: QaLlmProviderMetricsObserver,
    signal?: AbortSignal
  ): QaProviderRequestOptions {
    return {
      wireApi: this.wireApi,
      chatTemplateKwargs: { enable_thinking: this.reasoningEnabled },
      onUsage: usageObserver(this, onMetrics),
      ...(signal ? { signal } : {})
    };
  }

  answerText(
    systemPrompt: string,
    userPrompt: string,
    onMetrics?: QaLlmProviderMetricsObserver,
    signal?: AbortSignal
  ) {
    return requestQaAnswerText(
      this.client,
      this.model,
      systemPrompt,
      userPrompt,
      this.requestOptions(onMetrics, signal)
    );
  }

  answerTextStream(
    systemPrompt: string,
    userPrompt: string,
    onMetrics?: QaLlmProviderMetricsObserver,
    signal?: AbortSignal
  ) {
    return requestQaAnswerTextStream(
      this.client,
      this.model,
      systemPrompt,
      userPrompt,
      this.requestOptions(onMetrics, signal)
    );
  }
}

function nonEmpty(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function endpointFingerprint(endpoint: string) {
  return createHash("sha256")
    .update(endpoint.trim().replace(/\/+$/u, "").toLowerCase())
    .digest("hex");
}

function booleanEnvironment(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("VLLM_ENABLE_THINKING must be true or false");
}

function assertLoopbackVllmBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("VLLM_BASE_URL must be a valid URL");
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("VLLM_BASE_URL must use an HTTP loopback address");
  }
  return parsed.toString().replace(/\/$/u, "");
}

export type VllmQwenDevelopmentConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEnabled: boolean;
};

export function resolveVllmQwenDevelopmentConfig(
  environment: NodeJS.ProcessEnv = process.env,
  options: { allowProductionLoopback?: boolean } = {}
): VllmQwenDevelopmentConfig {
  if (
    environment.NODE_ENV?.trim().toLowerCase() === "production" &&
    options.allowProductionLoopback !== true
  ) {
    throw new Error("qwen-vllm is development/evaluation-only and cannot run with NODE_ENV=production");
  }
  return {
    baseUrl: assertLoopbackVllmBaseUrl(
      nonEmpty(environment.VLLM_BASE_URL) ?? DEFAULT_VLLM_BASE_URL
    ),
    apiKey: nonEmpty(environment.VLLM_API_KEY) ?? "dummy",
    model: nonEmpty(environment.VLLM_MODEL) ?? DEFAULT_VLLM_MODEL,
    reasoningEnabled: booleanEnvironment(environment.VLLM_ENABLE_THINKING, false)
  };
}

export function isVllmQwenProviderSelected(environment: NodeJS.ProcessEnv = process.env) {
  return environment.LLM_PROVIDER?.trim().toLowerCase() === "qwen-vllm";
}

export async function resolveQaLlmProvider(input: {
  settingsStore?: JsonStore;
  environment?: NodeJS.ProcessEnv;
  providerId?: QaLlmProviderId;
  allowQwenInProduction?: boolean;
} = {}): Promise<QaLlmProvider> {
  const environment = input.environment ?? process.env;
  const qwenSelected = input.providerId === "qwen-vllm" ||
    (input.providerId === undefined && isVllmQwenProviderSelected(environment));
  if (qwenSelected) {
    const config = resolveVllmQwenDevelopmentConfig(environment, {
      allowProductionLoopback: input.allowQwenInProduction === true
    });
    return new VLLMQwenProvider({
      client: createOpenAIClient({
        openAiApiKey: config.apiKey,
        openAiBaseUrl: config.baseUrl
      }),
      model: config.model,
      reasoningEnabled: config.reasoningEnabled,
      endpointFingerprint: endpointFingerprint(config.baseUrl)
    });
  }

  const runtimeConfig = await getOpenAIClientRuntimeConfig(input.settingsStore);
  const logProvider = resolveOpenAIClientProvider(runtimeConfig);
  const model = await getQaModelPreference(input.settingsStore, logProvider);
  const endpoint =
    logProvider === "openrouter"
      ? runtimeConfig.openRouterBaseUrl ??
        runtimeConfig.openAiBaseUrl ??
        "https://openrouter.ai/api/v1"
      : runtimeConfig.openAiBaseUrl ??
        runtimeConfig.openRouterBaseUrl ??
        "https://api.openai.com/v1";
  return new GPT55Provider({
    client: createOpenAIClient(runtimeConfig),
    model,
    wireApi: getQaWireApi(),
    logProvider,
    endpointFingerprint: endpointFingerprint(endpoint)
  });
}

export class VoiceQaLlmProviderConfigurationError extends Error {
  constructor(value: string) {
    super(
      `VOICE_QA_LLM_PROVIDER must be qwen-vllm or gpt-5.5; received ${JSON.stringify(value)}`
    );
    this.name = "VoiceQaLlmProviderConfigurationError";
  }
}

/**
 * Voice owns an explicit Provider choice so Text QA and saved QA preferences
 * remain unchanged. Qwen is the Voice default; GPT-5.5 remains an explicit
 * operational rollback without introducing a sequential fallback.
 */
export function resolveVoiceQaLlmProviderId(
  environment: Readonly<Record<string, string | undefined>> = process.env
): QaLlmProviderId {
  const normalized = environment.VOICE_QA_LLM_PROVIDER?.trim().toLowerCase();
  if (!normalized) return "qwen-vllm";
  if (normalized === "qwen-vllm" || normalized === "gpt-5.5") return normalized;
  throw new VoiceQaLlmProviderConfigurationError(normalized);
}
