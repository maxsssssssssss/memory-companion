import { VolcengineRealtimeVoiceProvider } from "./volcengine-realtime";

import type { VoiceProvider } from "./types";
import { VoiceProviderError } from "./types";

export const VOLCENGINE_REALTIME_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";

export type VolcengineRealtimeConfig = {
  endpoint: string;
  appId: string;
  accessKey: string;
  appKey: string;
  resourceId: string;
  connectTimeoutMs: number;
  eventTimeoutMs: number;
  model: "1.2.1.1" | "2.2.0.0";
  speaker?: string;
};

type VoiceEnvironment = Readonly<Record<string, string | undefined>>;

export type VoiceProviderName = "volcengine";

export function readVoiceProviderName(
  environment: VoiceEnvironment = process.env
): VoiceProviderName {
  const provider = environment.VOICE_PROVIDER?.trim().toLowerCase() || "volcengine";
  if (provider !== "volcengine") {
    throw new VoiceProviderError(
      "invalid_configuration",
      "VOICE_PROVIDER must be volcengine"
    );
  }
  return provider;
}

const REQUIRED_ENVIRONMENT_VARIABLES = [
  "VOLCENGINE_APP_ID",
  "VOLCENGINE_ACCESS_KEY",
  "VOLCENGINE_APP_KEY",
  "VOLCENGINE_RESOURCE_ID"
] as const;

function boundedInteger(
  environment: VoiceEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const value = environment[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/u.test(value)) {
    throw new VoiceProviderError(
      "invalid_configuration",
      `${name} must be an integer between ${minimum} and ${maximum}`
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new VoiceProviderError(
      "invalid_configuration",
      `${name} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return parsed;
}

function realtimeEndpoint(value: string | undefined) {
  const endpoint = value?.trim() || VOLCENGINE_REALTIME_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new VoiceProviderError("invalid_configuration", "VOLCENGINE_REALTIME_URL must be a valid wss:// URL");
  }
  if (parsed.protocol !== "wss:") {
    throw new VoiceProviderError("invalid_configuration", "VOLCENGINE_REALTIME_URL must use wss://");
  }
  return parsed.toString();
}

export function readVolcengineRealtimeConfig(
  environment: VoiceEnvironment = process.env
): VolcengineRealtimeConfig {
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new VoiceProviderError(
      "invalid_configuration",
      `Missing required Volcengine voice environment variables: ${missing.join(", ")}`
    );
  }

  const rawModel = environment.VOLCENGINE_REALTIME_MODEL?.trim() || "1.2.1.1";
  if (rawModel !== "1.2.1.1" && rawModel !== "2.2.0.0") {
    throw new VoiceProviderError(
      "invalid_configuration",
      "VOLCENGINE_REALTIME_MODEL must be 1.2.1.1 or 2.2.0.0"
    );
  }

  return {
    endpoint: realtimeEndpoint(environment.VOLCENGINE_REALTIME_URL),
    appId: environment.VOLCENGINE_APP_ID!.trim(),
    accessKey: environment.VOLCENGINE_ACCESS_KEY!.trim(),
    appKey: environment.VOLCENGINE_APP_KEY!.trim(),
    resourceId: environment.VOLCENGINE_RESOURCE_ID!.trim(),
    connectTimeoutMs: boundedInteger(
      environment,
      "VOLCENGINE_REALTIME_CONNECT_TIMEOUT_MS",
      15_000,
      1_000,
      120_000
    ),
    eventTimeoutMs: boundedInteger(
      environment,
      "VOLCENGINE_REALTIME_EVENT_TIMEOUT_MS",
      30_000,
      1_000,
      300_000
    ),
    model: rawModel,
    speaker: environment.VOLCENGINE_TTS_SPEAKER?.trim() || undefined
  };
}

export function createVoiceProvider(
  environment: VoiceEnvironment = process.env
): VoiceProvider {
  readVoiceProviderName(environment);
  return new VolcengineRealtimeVoiceProvider(readVolcengineRealtimeConfig(environment));
}
