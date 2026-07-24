import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildVoiceprintTrainingAudioUrl,
  createVoiceprintProviderRequestId
} from "./voiceprint-api-support";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("voiceprint API support", () => {
  it("scopes stable client request ids to the authenticated user", () => {
    const first = createVoiceprintProviderRequestId({
      operation: "train",
      userId: "user_1",
      clientRequestId: "request_1"
    });
    const repeated = createVoiceprintProviderRequestId({
      operation: "train",
      userId: "user_1",
      clientRequestId: "request_1"
    });
    const anotherUser = createVoiceprintProviderRequestId({
      operation: "train",
      userId: "user_2",
      clientRequestId: "request_1"
    });

    expect(repeated).toBe(first);
    expect(anotherUser).not.toBe(first);
    expect(first).not.toContain("user_1");
    expect(first).not.toContain("request_1");
  });

  it("builds a provider URL only from trusted server configuration", () => {
    vi.stubEnv("SPEAKER_ASR_AUDIO_BASE_URL", "https://audio.example.test/");
    vi.stubEnv("SPEAKER_ASR_AUDIO_ACCESS_TOKEN", "secret token");

    expect(buildVoiceprintTrainingAudioUrl({
      userId: "user_1",
      uploadId: "upload_1"
    })).toBe(
      "https://audio.example.test/api/internal/audio/user_1/upload_1?token=secret%20token"
    );
  });

  it("fails closed when the internal audio gateway is not configured", () => {
    vi.stubEnv("SPEAKER_ASR_AUDIO_BASE_URL", "");
    vi.stubEnv("SPEAKER_ASR_AUDIO_ACCESS_TOKEN", "");

    expect(() => buildVoiceprintTrainingAudioUrl({
      userId: "user_1",
      uploadId: "upload_1"
    })).toThrow("audio delivery configuration");
  });
});
