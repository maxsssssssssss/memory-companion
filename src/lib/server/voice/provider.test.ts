// @vitest-environment node

import { describe, expect, it } from "vitest";

import { readVoiceProviderName, readVolcengineRealtimeConfig } from "./provider";

const validEnvironment = {
  VOLCENGINE_APP_ID: "app-id",
  VOLCENGINE_ACCESS_KEY: "access-key",
  VOLCENGINE_APP_KEY: "app-key",
  VOLCENGINE_RESOURCE_ID: "volc.speech.dialog"
};

describe("readVolcengineRealtimeConfig", () => {
  it("selects only the configured production voice provider", () => {
    expect(readVoiceProviderName({})).toBe("volcengine");
    expect(readVoiceProviderName({ VOICE_PROVIDER: " VOLCENGINE " })).toBe("volcengine");
    expect(() => readVoiceProviderName({ VOICE_PROVIDER: "unknown" })).toThrow(
      "VOICE_PROVIDER must be volcengine"
    );
  });

  it("fails closed and names every missing required variable without exposing values", () => {
    expect(() => readVolcengineRealtimeConfig({
      VOLCENGINE_APP_ID: " ",
      VOLCENGINE_ACCESS_KEY: "secret-access"
    })).toThrow(
      "Missing required Volcengine voice environment variables: VOLCENGINE_APP_ID, VOLCENGINE_APP_KEY, VOLCENGINE_RESOURCE_ID"
    );

    try {
      readVolcengineRealtimeConfig({ VOLCENGINE_ACCESS_KEY: "secret-access" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-access");
    }
  });

  it("reads the documented endpoint and bounded defaults", () => {
    expect(readVolcengineRealtimeConfig(validEnvironment)).toEqual({
      endpoint: "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
      appId: "app-id",
      accessKey: "access-key",
      appKey: "app-key",
      resourceId: "volc.speech.dialog",
      connectTimeoutMs: 15_000,
      eventTimeoutMs: 30_000,
      model: "1.2.1.1",
      speaker: undefined
    });
  });

  it("accepts supported model and timeout overrides", () => {
    expect(readVolcengineRealtimeConfig({
      ...validEnvironment,
      VOLCENGINE_REALTIME_MODEL: "2.2.0.0",
      VOLCENGINE_TTS_SPEAKER: "voice-id",
      VOLCENGINE_REALTIME_CONNECT_TIMEOUT_MS: "20000",
      VOLCENGINE_REALTIME_EVENT_TIMEOUT_MS: "45000"
    })).toMatchObject({
      model: "2.2.0.0",
      speaker: "voice-id",
      connectTimeoutMs: 20_000,
      eventTimeoutMs: 45_000
    });
  });

  it("rejects unsupported models, non-wss endpoints, and invalid timeouts", () => {
    expect(() => readVolcengineRealtimeConfig({
      ...validEnvironment,
      VOLCENGINE_REALTIME_MODEL: "future"
    })).toThrow("VOLCENGINE_REALTIME_MODEL");
    expect(() => readVolcengineRealtimeConfig({
      ...validEnvironment,
      VOLCENGINE_REALTIME_URL: "https://example.test"
    })).toThrow("VOLCENGINE_REALTIME_URL must use wss://");
    expect(() => readVolcengineRealtimeConfig({
      ...validEnvironment,
      VOLCENGINE_REALTIME_EVENT_TIMEOUT_MS: "0"
    })).toThrow("VOLCENGINE_REALTIME_EVENT_TIMEOUT_MS");
  });
});
