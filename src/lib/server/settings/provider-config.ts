import { resolve } from "path";
import {
  DEFAULT_QA_PROMPT_PRESET_ID,
  normalizeCustomQaPrompt,
  normalizeQaPromptPresetId,
  QA_PROMPT_PRESETS,
  resolveQaPromptInstruction,
  type QaPromptPreset,
  type QaPromptPresetId
} from "@/lib/domain/qa-prompts";
import {
  resolveOpenAIClientProvider,
  type OpenAIClientProvider,
  type OpenAIClientRuntimeConfig
} from "@/lib/server/openai/client";
import { appStore, type JsonStore } from "@/lib/server/storage/json-store";
import { getResolvedStoragePaths, getStorageMode, type StorageMode } from "@/lib/server/storage/paths";

export type ApiKeyMode = "default" | "custom";
export { QA_PROMPT_PRESETS, type QaPromptPreset, type QaPromptPresetId };

type StoredProviderConfig = {
  apiKeyMode: ApiKeyMode;
  openRouterApiKey?: string;
  qaModel?: string;
  qaPromptPresetId?: QaPromptPresetId;
  customQaPrompt?: string;
  updatedAt?: string;
};

export type QaModelPreset = {
  label: string;
  value: string;
};

export type ProviderSettingsView = {
  apiKeyMode: ApiKeyMode;
  hasCustomApiKey: boolean;
  defaultApiKeyAvailable: boolean;
  activeApiKeySource: "custom" | "default" | "missing";
  providerDisplayName: string;
  qaModel: string;
  qaModelPresets: QaModelPreset[];
  qaPromptPresetId: QaPromptPresetId;
  customQaPrompt: string;
  qaPromptPresets: QaPromptPreset[];
  storageMode: StorageMode;
  canOpenDataFolder: boolean;
  dataDirectory: string;
  uploadsDirectory: string;
  apiKeyStoragePath: string;
};

const SETTINGS_COLLECTION = "settings";
const PROVIDER_CONFIG_ID = "provider-config";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_QA_MODEL = "openai/gpt-5.5";
const DEFAULT_OPENAI_COMPATIBLE_QA_MODEL = "gpt-5.5";

export const QA_MODEL_PRESETS: QaModelPreset[] = [
  { label: "opus-4.8", value: "anthropic/claude-opus-4.8" },
  { label: "gemini-3.5", value: "google/gemini-3.5-flash" },
  { label: "grok-4.3", value: "x-ai/grok-4.3" },
  { label: "gpt-5.5", value: "openai/gpt-5.5" }
];

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringEnv(variableName: string) {
  return normalizeString(process.env[variableName]);
}

function normalizeQaModel(value: unknown): string | undefined {
  const model = normalizeString(value);
  return model?.replace(/\s+/g, "");
}

export class QaModelProviderMismatchError extends Error {
  constructor(
    public readonly provider: OpenAIClientProvider,
    public readonly model: string,
    public readonly expectedEnvironmentVariable: "OPENAI_QA_MODEL" | "OPENROUTER_QA_MODEL"
  ) {
    super(
      `QA model provider mismatch: provider=${provider} model=${model} expected_env=${expectedEnvironmentVariable}`
    );
    this.name = "QaModelProviderMismatchError";
  }
}

function throwQaModelProviderMismatch(
  provider: OpenAIClientProvider,
  model: string,
  expectedEnvironmentVariable: "OPENAI_QA_MODEL" | "OPENROUTER_QA_MODEL"
): never {
  const error = new QaModelProviderMismatchError(provider, model, expectedEnvironmentVariable);
  console.warn(`[qa config] ${error.message}`);
  throw error;
}

function isModelCompatibleWithProvider(model: string, provider: OpenAIClientProvider) {
  const isOpenRouterStyle = model.includes("/");
  return provider === "openrouter" ? isOpenRouterStyle : !isOpenRouterStyle;
}

function warnAboutInactiveModelEnvironment(input: {
  provider: OpenAIClientProvider;
  selectedModel: string;
  selectedEnvironmentVariable: "OPENAI_QA_MODEL" | "OPENROUTER_QA_MODEL";
  ignoredModel: string;
  ignoredEnvironmentVariable: "OPENAI_QA_MODEL" | "OPENROUTER_QA_MODEL";
}) {
  console.warn(
    `[qa config] provider=${input.provider} selected_model=${input.selectedModel} selected_env=${input.selectedEnvironmentVariable} ` +
      `ignored_model=${input.ignoredModel} ignored_env=${input.ignoredEnvironmentVariable}`
  );
}

export function selectQaModelForProvider(input: {
  provider: OpenAIClientProvider;
  storedModel?: string;
  openAiModel?: string;
  openRouterModel?: string;
}) {
  const openAiModel = normalizeQaModel(input.openAiModel);
  const openRouterModel = normalizeQaModel(input.openRouterModel);
  const selectedEnvironmentVariable = input.provider === "openrouter" ? "OPENROUTER_QA_MODEL" : "OPENAI_QA_MODEL";
  const ignoredEnvironmentVariable = input.provider === "openrouter" ? "OPENAI_QA_MODEL" : "OPENROUTER_QA_MODEL";
  const providerModel = input.provider === "openrouter" ? openRouterModel : openAiModel;
  const ignoredModel = input.provider === "openrouter" ? openAiModel : openRouterModel;

  if (providerModel && ignoredModel && providerModel !== ignoredModel) {
    warnAboutInactiveModelEnvironment({
      provider: input.provider,
      selectedModel: providerModel,
      selectedEnvironmentVariable,
      ignoredModel,
      ignoredEnvironmentVariable
    });
  }

  const storedModel = normalizeQaModel(input.storedModel);
  if (storedModel) {
    if (isModelCompatibleWithProvider(storedModel, input.provider)) {
      return storedModel;
    }

    console.warn(
      `[qa config] provider=${input.provider} ignored_model=${storedModel} ignored_source=saved_provider_config ` +
        `expected_env=${selectedEnvironmentVariable}`
    );
    if (!providerModel) {
      throwQaModelProviderMismatch(input.provider, storedModel, selectedEnvironmentVariable);
    }
  }

  if (providerModel) {
    if (!isModelCompatibleWithProvider(providerModel, input.provider)) {
      throwQaModelProviderMismatch(input.provider, providerModel, selectedEnvironmentVariable);
    }
    return providerModel;
  }

  return input.provider === "openrouter" ? DEFAULT_QA_MODEL : DEFAULT_OPENAI_COMPATIBLE_QA_MODEL;
}

function runtimeConfigFromProviderConfig(config: StoredProviderConfig): OpenAIClientRuntimeConfig {
  if (config.apiKeyMode !== "custom" || !config.openRouterApiKey) {
    return {};
  }

  return {
    openRouterApiKey: config.openRouterApiKey,
    openRouterBaseUrl: readStringEnv("OPENROUTER_BASE_URL") ?? DEFAULT_OPENROUTER_BASE_URL
  };
}

export function getLocalDataPaths() {
  const paths = getResolvedStoragePaths();

  return {
    ...paths,
    apiKeyStoragePath: resolve(paths.dataDirectory, SETTINGS_COLLECTION, `${PROVIDER_CONFIG_ID}.json`)
  };
}

export async function readApiProviderConfig(store: JsonStore = appStore): Promise<StoredProviderConfig> {
  const storedConfig = await store.read<Partial<StoredProviderConfig>>(SETTINGS_COLLECTION, PROVIDER_CONFIG_ID);
  const qaModel = normalizeQaModel(storedConfig?.qaModel);
  const qaPromptPresetId = normalizeQaPromptPresetId(storedConfig?.qaPromptPresetId);
  const customQaPrompt = normalizeCustomQaPrompt(storedConfig?.customQaPrompt);
  const promptConfig = {
    ...(qaPromptPresetId ? { qaPromptPresetId } : {}),
    ...(customQaPrompt ? { customQaPrompt } : {})
  };

  if (!storedConfig || storedConfig.apiKeyMode !== "custom") {
    return {
      apiKeyMode: "default",
      qaModel,
      ...promptConfig,
      updatedAt: normalizeString(storedConfig?.updatedAt)
    };
  }

  const openRouterApiKey = normalizeString(storedConfig.openRouterApiKey);

  return {
    apiKeyMode: openRouterApiKey ? "custom" : "default",
    openRouterApiKey,
    qaModel,
    ...promptConfig,
    updatedAt: normalizeString(storedConfig.updatedAt)
  };
}

export async function saveApiProviderConfig(
  input: { apiKeyMode: ApiKeyMode; openRouterApiKey?: string; qaModel?: string; qaPromptPresetId?: unknown; customQaPrompt?: unknown },
  store: JsonStore = appStore
) {
  const openRouterApiKey = normalizeString(input.openRouterApiKey);
  const qaModel = normalizeQaModel(input.qaModel);
  const qaPromptPresetId = normalizeQaPromptPresetId(input.qaPromptPresetId);
  const customQaPrompt = normalizeCustomQaPrompt(input.customQaPrompt);
  const promptConfig = {
    ...(qaPromptPresetId ? { qaPromptPresetId } : {}),
    ...(input.customQaPrompt !== undefined ? { customQaPrompt: customQaPrompt ?? "" } : {})
  };
  const storedConfig: StoredProviderConfig =
    input.apiKeyMode === "custom"
      ? {
          apiKeyMode: "custom",
          openRouterApiKey,
          ...(qaModel ? { qaModel } : {}),
          ...promptConfig,
          updatedAt: new Date().toISOString()
        }
      : {
          apiKeyMode: "default",
          ...(qaModel ? { qaModel } : {}),
          ...promptConfig,
          updatedAt: new Date().toISOString()
        };

  await store.write(SETTINGS_COLLECTION, PROVIDER_CONFIG_ID, storedConfig);
}

export async function getProviderSettingsView(
  store: JsonStore = appStore,
  localDataPaths = getLocalDataPaths()
): Promise<ProviderSettingsView> {
  const config = await readApiProviderConfig(store);
  const hasCustomApiKey = config.apiKeyMode === "custom" && Boolean(config.openRouterApiKey);
  const provider = resolveOpenAIClientProvider(runtimeConfigFromProviderConfig(config));
  const qaModel = selectQaModelForProvider({
    provider,
    storedModel: config.qaModel,
    openAiModel: readStringEnv("OPENAI_QA_MODEL"),
    openRouterModel: readStringEnv("OPENROUTER_QA_MODEL")
  });
  const defaultApiKeyAvailable = Boolean(readStringEnv("OPENAI_API_KEY") ?? readStringEnv("OPENROUTER_API_KEY"));
  const activeApiKeySource = hasCustomApiKey ? "custom" : defaultApiKeyAvailable ? "default" : "missing";

  return {
    apiKeyMode: hasCustomApiKey ? "custom" : "default",
    hasCustomApiKey,
    defaultApiKeyAvailable,
    activeApiKeySource,
    providerDisplayName: "OpenRouter / OpenAI compatible",
    qaModel,
    qaModelPresets: provider === "openrouter" ? QA_MODEL_PRESETS : [{ label: qaModel, value: qaModel }],
    qaPromptPresetId: normalizeQaPromptPresetId(config.qaPromptPresetId) ?? DEFAULT_QA_PROMPT_PRESET_ID,
    customQaPrompt: config.customQaPrompt ?? "",
    qaPromptPresets: QA_PROMPT_PRESETS,
    storageMode: getStorageMode(),
    canOpenDataFolder: getStorageMode() === "local",
    ...localDataPaths
  };
}

export async function getQaModelPreference(store: JsonStore = appStore, providerOverride?: OpenAIClientProvider) {
  const config = await readApiProviderConfig(store);
  const provider = providerOverride ?? resolveOpenAIClientProvider(runtimeConfigFromProviderConfig(config));
  return selectQaModelForProvider({
    provider,
    storedModel: config.qaModel,
    openAiModel: readStringEnv("OPENAI_QA_MODEL"),
    openRouterModel: readStringEnv("OPENROUTER_QA_MODEL")
  });
}

export async function getQaPromptPreference(store: JsonStore = appStore) {
  const config = await readApiProviderConfig(store);
  return resolveQaPromptInstruction({
    qaPromptPresetId: config.qaPromptPresetId,
    customQaPrompt: config.customQaPrompt
  });
}

export async function getOpenAIClientRuntimeConfig(store: JsonStore = appStore): Promise<OpenAIClientRuntimeConfig> {
  const config = await readApiProviderConfig(store);
  return runtimeConfigFromProviderConfig(config);
}
