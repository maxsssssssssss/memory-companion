import { NextResponse } from "next/server";
import { resolve } from "path";
import {
  getProviderSettingsView,
  QA_PROMPT_PRESETS,
  readApiProviderConfig,
  saveApiProviderConfig,
  type ApiKeyMode,
  type QaPromptPresetId
} from "@/lib/server/settings/provider-config";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";

type SettingsRequestBody = {
  apiKeyMode?: unknown;
  openRouterApiKey?: unknown;
  qaModel?: unknown;
  qaPromptPresetId?: unknown;
  customQaPrompt?: unknown;
};

function isApiKeyMode(value: unknown): value is ApiKeyMode {
  return value === "default" || value === "custom";
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModel(value: unknown): string | undefined {
  return normalizeString(value)?.replace(/\s+/g, "");
}

function isQaPromptPresetId(value: unknown): value is QaPromptPresetId {
  return QA_PROMPT_PRESETS.some((preset) => preset.id === value);
}

function userLocalDataPaths(authContext: Awaited<ReturnType<typeof requireAuthContext>>) {
  return {
    dataDirectory: resolve(authContext.dataRootDir),
    uploadsDirectory: resolve(authContext.uploadsRootDir),
    apiKeyStoragePath: resolve(authContext.dataRootDir, "settings", "provider-config.json")
  };
}

export async function GET(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  return NextResponse.json(await getProviderSettingsView(authContext.store, userLocalDataPaths(authContext)));
}

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  let body: SettingsRequestBody;

  try {
    body = (await request.json()) as SettingsRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const hasApiKeyMode = body.apiKeyMode !== undefined;
  const qaModel = normalizeModel(body.qaModel);
  const hasQaPromptPresetId = body.qaPromptPresetId !== undefined;
  const hasCustomQaPrompt = body.customQaPrompt !== undefined;

  if (!hasApiKeyMode && !qaModel && !hasQaPromptPresetId && !hasCustomQaPrompt) {
    return NextResponse.json({ error: "invalid_api_key_mode" }, { status: 400 });
  }

  if (hasApiKeyMode && !isApiKeyMode(body.apiKeyMode)) {
    return NextResponse.json({ error: "invalid_api_key_mode" }, { status: 400 });
  }

  if (hasQaPromptPresetId && !isQaPromptPresetId(body.qaPromptPresetId)) {
    return NextResponse.json({ error: "invalid_qa_prompt_preset" }, { status: 400 });
  }

  const currentConfig = await readApiProviderConfig(authContext.store);
  const apiKeyMode = hasApiKeyMode && isApiKeyMode(body.apiKeyMode) ? body.apiKeyMode : currentConfig.apiKeyMode;
  const openRouterApiKey = normalizeString(body.openRouterApiKey) ?? currentConfig.openRouterApiKey;
  const qaPromptPresetId =
    hasQaPromptPresetId && isQaPromptPresetId(body.qaPromptPresetId) ? body.qaPromptPresetId : currentConfig.qaPromptPresetId;
  const customQaPrompt = hasCustomQaPrompt ? normalizeString(body.customQaPrompt) : currentConfig.customQaPrompt;

  if (apiKeyMode === "custom" && !openRouterApiKey) {
    return NextResponse.json({ error: "missing_openrouter_api_key" }, { status: 400 });
  }

  if (qaPromptPresetId === "custom" && !customQaPrompt) {
    return NextResponse.json({ error: "missing_custom_qa_prompt" }, { status: 400 });
  }

  await saveApiProviderConfig({
    apiKeyMode,
    openRouterApiKey,
    qaModel: qaModel ?? currentConfig.qaModel,
    ...(qaPromptPresetId ? { qaPromptPresetId } : {}),
    ...(hasCustomQaPrompt || Boolean(currentConfig.customQaPrompt) ? { customQaPrompt: customQaPrompt ?? "" } : {})
  }, authContext.store);

  return NextResponse.json(await getProviderSettingsView(authContext.store, userLocalDataPaths(authContext)));
}
