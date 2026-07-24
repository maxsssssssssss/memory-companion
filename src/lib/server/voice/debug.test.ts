// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { logVoiceDebug, voiceDebugEnabled } from "./debug";

describe("voice debug logging", () => {
  it("is disabled unless VOICE_DEBUG is explicitly true", () => {
    expect(voiceDebugEnabled({})).toBe(false);
    expect(voiceDebugEnabled({ VOICE_DEBUG: "false" })).toBe(false);
    expect(voiceDebugEnabled({ VOICE_DEBUG: " TRUE " })).toBe(true);
  });

  it("writes bounded structural fields without implicit payload data", () => {
    const logger = vi.fn();
    logVoiceDebug("asr_event", {
      event_id: 451,
      final: true,
      result_count: 1
    }, {
      environment: { VOICE_DEBUG: "true" },
      logger
    });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0]?.[0]).toBe(
      'VOICE_DEBUG {"event":"asr_event","event_id":451,"final":true,"result_count":1}'
    );
    expect(logger.mock.calls[0]?.[0]).not.toContain("transcript");
    expect(logger.mock.calls[0]?.[0]).not.toContain("token");
  });

  it("does nothing while disabled", () => {
    const logger = vi.fn();
    logVoiceDebug("tts_event", { bytes: 10 }, {
      environment: { VOICE_DEBUG: "false" },
      logger
    });
    expect(logger).not.toHaveBeenCalled();
  });
});
