// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { VoiceProvider } from "@/lib/server/voice/types";

import { VoiceErrorHandler, type ReconnectableVoiceProvider } from "./error-handler";

function provider(overrides: Partial<ReconnectableVoiceProvider> = {}): ReconnectableVoiceProvider {
  const base: VoiceProvider = {
    connect: vi.fn(async () => undefined),
    startSession: vi.fn(async () => ({ sessionId: "provider-session" })),
    sendAudio: vi.fn(async () => undefined),
    finishAudioInput: vi.fn(async () => undefined),
    sendText: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => undefined),
    onTranscript: vi.fn(() => () => undefined),
    onAudio: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined)
  };
  return { ...base, ...overrides };
}

describe("VoiceErrorHandler", () => {
  it("returns a repeat prompt for an ASR timeout", () => {
    expect(new VoiceErrorHandler().asrTimeout()).toMatchObject({
      code: "VOICE_ASR_TIMEOUT",
      preserveSession: true,
      returnText: true
    });
  });

  it("uses a context-aware but non-invented QA timeout fallback", () => {
    const handler = new VoiceErrorHandler();
    expect(handler.qaTimeout(true)).toMatchObject({ code: "VOICE_QA_TIMEOUT" });
    expect(handler.qaTimeout(true).message).toContain("刚才的话题");
    expect(handler.qaTimeout(false).message).not.toContain("刚才的话题");
  });

  it("preserves the text answer when TTS fails", () => {
    expect(new VoiceErrorHandler().ttsFailed("  已有文字回答  ")).toEqual({
      code: "VOICE_TTS_FAILED",
      message: "已有文字回答",
      preserveSession: true,
      returnText: true,
      reconnectRecommended: false
    });
  });

  it("marks connection loss as session-preserving and reconnectable", () => {
    expect(new VoiceErrorHandler().connectionLost()).toMatchObject({
      code: "VOICE_CONNECTION_LOST",
      preserveSession: true,
      reconnectRecommended: true
    });
  });

  it("reconnects once and restores the caller state", async () => {
    const reconnect = vi.fn(async () => ({ sessionId: "restored-provider-session" }));
    const restore = vi.fn();

    await expect(new VoiceErrorHandler().reconnect(provider({ reconnect }), restore)).resolves.toEqual({
      sessionId: "restored-provider-session"
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith({ sessionId: "restored-provider-session" });
  });

  it("degrades gracefully when reconnect is unavailable", async () => {
    await expect(new VoiceErrorHandler().reconnect(provider())).resolves.toBeNull();
  });
});
