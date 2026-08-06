// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { JsonStore } from "@/lib/server/storage/json-store";

import { startDateCompanionSensitiveAudioCleanupRuntime } from "./sensitive-audio-cleanup-runtime";

describe("Date Companion sensitive-audio cleanup runtime", () => {
  it("cleans staging and participant samples when voice enrollment is disabled", async () => {
    const cleanupExpiredParticipantAudioSamples = vi.fn(() => 3);
    const cleanupStaging = vi.fn(async () => 2);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = startDateCompanionSensitiveAudioCleanupRuntime({
      env: {
        DATE_COMPANION_VOICE_ENROLLMENT_ENABLED: "false",
        DATE_COMPANION_SENSITIVE_AUDIO_CLEANUP_INTERVAL_MS: "60000"
      },
      repository: { cleanupExpiredParticipantAudioSamples },
      now: () => Date.parse("2026-08-05T12:00:00.000Z"),
      logger,
      listUserIds: async () => ["user_1", "user_2"],
      getUserStore: () => ({}) as JsonStore,
      cleanupStaging,
      startImmediately: false
    });

    await expect(runtime.cleanupNow()).resolves.toEqual({
      users: 2,
      failedUsers: 0,
      stagingDeleted: 4,
      participantAudioDeleted: 3,
      participantCleanupFailed: false
    });
    expect(cleanupStaging).toHaveBeenCalledTimes(2);
    expect(cleanupExpiredParticipantAudioSamples).toHaveBeenCalledWith(
      "2026-08-05T12:00:00.000Z"
    );
    const logs = [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .flat()
      .join(" ");
    expect(logs).not.toContain("user_1");
    expect(logs).not.toContain("user_2");
    await Promise.all([runtime.close(), runtime.close(), runtime.runPromise]);
  });

  it("deduplicates overlapping cleanup cycles", async () => {
    let resolveCleanup: ((value: number) => void) | undefined;
    const cleanupStaging = vi.fn(() => new Promise<number>((resolve) => {
      resolveCleanup = resolve;
    }));
    const runtime = startDateCompanionSensitiveAudioCleanupRuntime({
      intervalMs: 60_000,
      repository: { cleanupExpiredParticipantAudioSamples: vi.fn(() => 0) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      listUserIds: async () => ["user_1"],
      getUserStore: () => ({}) as JsonStore,
      cleanupStaging,
      startImmediately: false
    });

    const first = runtime.cleanupNow();
    const second = runtime.cleanupNow();
    await vi.waitFor(() => expect(cleanupStaging).toHaveBeenCalledOnce());
    resolveCleanup?.(1);
    await Promise.all([first, second]);
    expect(cleanupStaging).toHaveBeenCalledOnce();
    await runtime.close();
  });
});
