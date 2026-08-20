// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  isDailyReflectionBrowserRecordingEnabled,
  isDailyReflectionToySyncEnabled,
  isDailyReflectionUploadEnabled,
  isToySyncEnabled
} from "./runtime-config";

describe("Daily Reflection runtime configuration", () => {
  function env(values: Record<string, string | undefined> = {}) {
    return { NODE_ENV: "test", ...values } as NodeJS.ProcessEnv;
  }

  it("keeps both upload capabilities disabled by default", () => {
    expect(isDailyReflectionUploadEnabled(env())).toBe(false);
    expect(isDailyReflectionBrowserRecordingEnabled(env())).toBe(false);
    expect(isDailyReflectionToySyncEnabled(env())).toBe(false);
  });

  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["1", false],
    ["yes", false],
    [" TRUE ", true]
  ] as const)("parses the browser recording flag %s as %s", (value, expected) => {
    expect(isDailyReflectionBrowserRecordingEnabled(env({
      DAILY_REFLECTION_BROWSER_RECORDING_ENABLED: value
    }))).toBe(expected);
  });

  it("does not implicitly enable browser recordings with file uploads", () => {
    const configured = env({ DAILY_REFLECTION_UPLOAD_ENABLED: "true" });
    expect(isDailyReflectionUploadEnabled(configured)).toBe(true);
    expect(isDailyReflectionBrowserRecordingEnabled(configured)).toBe(false);
    expect(isDailyReflectionToySyncEnabled(configured)).toBe(false);
  });

  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["1", false],
    ["yes", false],
    [" TRUE ", true]
  ] as const)("parses the toy sync flag %s as %s", (value, expected) => {
    expect(isDailyReflectionToySyncEnabled(env({
      DAILY_REFLECTION_TOY_SYNC_ENABLED: value
    }))).toBe(expected);
  });

  it("uses the shared toy flag across modules while preserving the legacy fallback", () => {
    expect(isToySyncEnabled(env({
      DAILY_BRIEF_TOY_SYNC_ENABLED: "true"
    }))).toBe(true);
    expect(isToySyncEnabled(env({
      DAILY_REFLECTION_TOY_SYNC_ENABLED: "true"
    }))).toBe(true);
    expect(isDailyReflectionToySyncEnabled(env({
      DAILY_BRIEF_TOY_SYNC_ENABLED: "false",
      DAILY_REFLECTION_TOY_SYNC_ENABLED: "true"
    }))).toBe(false);
  });
});
