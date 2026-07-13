import OpenAI from "openai";

const OPENAI_REQUEST_TIMEOUT_MS_ENV = "OPENAI_REQUEST_TIMEOUT_MS";
const OPENAI_MAX_RETRIES_ENV = "OPENAI_MAX_RETRIES";
const OPENAI_ORG_ID_ENV = "OPENAI_ORG_ID";
const OPENAI_PROJECT_ID_ENV = "OPENAI_PROJECT_ID";
const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const OPENROUTER_BASE_URL_ENV = "OPENROUTER_BASE_URL";
const OPENROUTER_HTTP_REFERER_ENV = "OPENROUTER_HTTP_REFERER";
const OPENROUTER_APP_TITLE_ENV = "OPENROUTER_APP_TITLE";
const OPENAI_AUTH_HEADER_MODE_ENV = "OPENAI_AUTH_HEADER_MODE";

const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OPENAI_MAX_RETRIES = 2;

export type OpenAIClientRuntimeConfig = {
  openAiApiKey?: string;
  openRouterApiKey?: string;
  openAiBaseUrl?: string;
  openRouterBaseUrl?: string;
  openRouterHttpReferer?: string;
  openRouterAppTitle?: string;
};

export type OpenAIClientProvider = "openrouter" | "openai-compatible";

function readStringEnv(variableName: string): string | undefined {
  const rawValue = process.env[variableName];
  if (rawValue === undefined) {
    return undefined;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumberEnv(variableName: string, defaultValue: number): number {
  const rawValue = readStringEnv(variableName);
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }

  return parsed;
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isOpenRouterBaseURL(baseURL: string | undefined) {
  return Boolean(baseURL?.includes("openrouter.ai"));
}

export function resolveOpenAIClientProvider(runtimeConfig: OpenAIClientRuntimeConfig = {}): OpenAIClientProvider {
  const runtimeOpenRouterKey = normalizeString(runtimeConfig.openRouterApiKey);
  const openAiApiKey = normalizeString(runtimeConfig.openAiApiKey) ?? readStringEnv("OPENAI_API_KEY");
  const openRouterApiKey = runtimeOpenRouterKey ?? readStringEnv(OPENROUTER_API_KEY_ENV);
  const openAiBaseURL = normalizeString(runtimeConfig.openAiBaseUrl) ?? readStringEnv(OPENAI_BASE_URL_ENV);
  const openRouterBaseURL = normalizeString(runtimeConfig.openRouterBaseUrl) ?? readStringEnv(OPENROUTER_BASE_URL_ENV);
  const usesOpenRouter =
    Boolean(runtimeOpenRouterKey) ||
    isOpenRouterBaseURL(openAiBaseURL) ||
    Boolean(openRouterApiKey && (!openAiApiKey || (!openAiBaseURL && openRouterBaseURL)));

  return usesOpenRouter ? "openrouter" : "openai-compatible";
}

export function createOpenAIClient(runtimeConfig: OpenAIClientRuntimeConfig = {}) {
  const runtimeOpenRouterKey = normalizeString(runtimeConfig.openRouterApiKey);
  const openAiApiKey = normalizeString(runtimeConfig.openAiApiKey) ?? readStringEnv("OPENAI_API_KEY");
  const openRouterApiKey = runtimeOpenRouterKey ?? readStringEnv(OPENROUTER_API_KEY_ENV);
  const openAiBaseURL = normalizeString(runtimeConfig.openAiBaseUrl) ?? readStringEnv(OPENAI_BASE_URL_ENV);
  const openRouterBaseURL = normalizeString(runtimeConfig.openRouterBaseUrl) ?? readStringEnv(OPENROUTER_BASE_URL_ENV);
  const usesOpenRouter = resolveOpenAIClientProvider(runtimeConfig) === "openrouter";
  const apiKey = usesOpenRouter ? openRouterApiKey ?? openAiApiKey : openAiApiKey ?? openRouterApiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY (or OPENROUTER_API_KEY) is required when using OpenAI-compatible provider");
  }

  const baseURL = usesOpenRouter ? openRouterBaseURL ?? openAiBaseURL : openAiBaseURL ?? openRouterBaseURL;

  const defaultHeaders: Record<string, string> = {};
  const httpReferer = normalizeString(runtimeConfig.openRouterHttpReferer) ?? readStringEnv(OPENROUTER_HTTP_REFERER_ENV);
  const appTitle = normalizeString(runtimeConfig.openRouterAppTitle) ?? readStringEnv(OPENROUTER_APP_TITLE_ENV);

  if (httpReferer) {
    defaultHeaders["HTTP-Referer"] = httpReferer;
  }
  if (appTitle) {
    defaultHeaders["X-Title"] = appTitle;
  }
  if (readStringEnv(OPENAI_AUTH_HEADER_MODE_ENV)?.toLowerCase() === "raw") {
    defaultHeaders.Authorization = apiKey;
  }

  const clientOptions: Record<string, unknown> = {
    apiKey,
    organization: process.env[OPENAI_ORG_ID_ENV],
    project: process.env[OPENAI_PROJECT_ID_ENV],
    timeout: readNumberEnv(OPENAI_REQUEST_TIMEOUT_MS_ENV, DEFAULT_OPENAI_REQUEST_TIMEOUT_MS),
    maxRetries: readNumberEnv(OPENAI_MAX_RETRIES_ENV, DEFAULT_OPENAI_MAX_RETRIES)
  };

  if (baseURL) {
    clientOptions.baseURL = baseURL;
  }

  if (Object.keys(defaultHeaders).length > 0) {
    clientOptions.defaultHeaders = defaultHeaders;
  }

  return new OpenAI(clientOptions);
}
