import { describe, expect, it } from "vitest";

import {
  armCaptureContextIntent,
  armVoiceAutostartIntent,
  consumeCaptureContextIntent,
  consumeVoiceAutostartIntent
} from "./reflection-capture-intent";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value)
  };
}

describe("reflection voice autostart intent", () => {
  it("is session-scoped, short-lived, and consumed exactly once", () => {
    const storage = memoryStorage();
    expect(armVoiceAutostartIntent(storage, () => 1_000)).toBe(true);
    expect(consumeVoiceAutostartIntent(storage, () => 2_000)).toBe(true);
    expect(consumeVoiceAutostartIntent(storage, () => 2_001)).toBe(false);

    expect(armVoiceAutostartIntent(storage, () => 5_000)).toBe(true);
    expect(consumeVoiceAutostartIntent(storage, () => 21_000)).toBe(false);
  });

  it("fails closed for malformed, future, or unavailable session storage", () => {
    const storage = memoryStorage();
    storage.setItem("daily-reflection:voice-autostart:v1", "{not-json");
    expect(consumeVoiceAutostartIntent(storage, () => 1_000)).toBe(false);

    expect(armVoiceAutostartIntent(storage, () => 2_000)).toBe(true);
    expect(consumeVoiceAutostartIntent(storage, () => 1_999)).toBe(false);

    const unavailable = {
      getItem: () => { throw new DOMException("blocked"); },
      removeItem: () => undefined,
      setItem: () => { throw new DOMException("blocked"); }
    };
    expect(armVoiceAutostartIntent(unavailable)).toBe(false);
    expect(consumeVoiceAutostartIntent(unavailable)).toBe(false);
  });
});

describe("reflection capture context intent", () => {
  it("keeps private context out of navigation and consumes the normalized prompt once", () => {
    const storage = memoryStorage();
    expect(armCaptureContextIntent("  **一个想法**  ", storage, () => 1_000)).toBe(true);
    expect(consumeCaptureContextIntent(storage, () => 2_000)).toBe("**一个想法**");
    expect(consumeCaptureContextIntent(storage, () => 2_001)).toBeNull();
  });

  it("fails closed for empty, expired, or malformed context", () => {
    const storage = memoryStorage();
    expect(armCaptureContextIntent("   ", storage, () => 1_000)).toBe(false);
    expect(armCaptureContextIntent("继续想", storage, () => 1_000)).toBe(true);
    expect(consumeCaptureContextIntent(storage, () => 301_001)).toBeNull();

    storage.setItem("daily-reflection:capture-context:v1", "{not-json");
    expect(consumeCaptureContextIntent(storage, () => 1_000)).toBeNull();
  });
});
