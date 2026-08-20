import { describe, expect, it, vi } from "vitest";

import {
  DAILY_REFLECTION_DURATION_POLICY,
  DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT,
  DailyReflectionDurationResolutionSchema
} from "@/lib/domain/daily-reflection-duration";

import {
  DailyReflectionDurationProbeError,
  parseDailyReflectionFfprobeDurationSeconds,
  resolveDailyReflectionAuthoritativeDuration,
  resolveDailyReflectionProcessingProfile
} from "./duration-resolver";

describe("resolveDailyReflectionProcessingProfile", () => {
  it("freezes the Stage 3 duration policy", () => {
    expect(DAILY_REFLECTION_DURATION_POLICY).toEqual({
      minimumSeconds: 30,
      quickReflectionThresholdSeconds: 180,
      browserSafetyLimitSeconds: null
    });
    expect(Object.isFrozen(DAILY_REFLECTION_DURATION_POLICY)).toBe(true);
    expect(DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT).toBe(3);
  });

  it.each([
    [30_000, "quick_reflection"],
    [179_000, "quick_reflection"],
    [180_000, "quick_reflection"],
    [180_001, "full_recording"],
    [181_000, "full_recording"],
    [300_000, "full_recording"]
  ] as const)(
    "resolves browser duration %i ms as %s",
    (effectiveDurationMs, expectedProfile) => {
      expect(resolveDailyReflectionProcessingProfile({
        inputMethod: "browser_recording",
        effectiveDurationMs
      })).toBe(expectedProfile);
    }
  );

  it("rejects a 29-second browser recording without changing the file-upload rule", () => {
    expect(() => resolveDailyReflectionProcessingProfile({
      inputMethod: "browser_recording",
      effectiveDurationMs: 29_000
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_duration_too_short",
      retryable: false
    }));

    expect(resolveDailyReflectionProcessingProfile({
      inputMethod: "file_upload",
      effectiveDurationMs: 29_000
    })).toBe("full_recording");
    expect(resolveDailyReflectionProcessingProfile({
      inputMethod: "file_upload",
      effectiveDurationMs: undefined
    })).toBe("full_recording");
    expect(resolveDailyReflectionProcessingProfile({
      inputMethod: "file_upload",
      effectiveDurationMs: "client-spoofed"
    })).toBe("full_recording");
    expect(resolveDailyReflectionProcessingProfile({
      inputMethod: "file_upload",
      effectiveDurationMs: 300_000
    })).toBe("full_recording");
  });

  it.each([undefined, null])("rejects a missing authoritative duration (%s)", (value) => {
    expect(() => resolveDailyReflectionProcessingProfile({
      inputMethod: "browser_recording",
      effectiveDurationMs: value
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_duration_missing"
    }));
  });

  it.each([
    0,
    -1,
    30_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "30000"
  ])(
    "rejects invalid authoritative duration %s",
    (value) => {
      expect(() => resolveDailyReflectionProcessingProfile({
        inputMethod: "browser_recording",
        effectiveDurationMs: value
      })).toThrowError(expect.objectContaining({
        code: "daily_reflection_duration_invalid"
      }));
    }
  );

  it("rejects an unknown input method", () => {
    expect(() => resolveDailyReflectionProcessingProfile({
      inputMethod: "client_selected_profile",
      effectiveDurationMs: 60_000
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_input_method_invalid",
      retryable: false
    }));
  });

  it("rejects a client-selected profile", () => {
    expect(() => resolveDailyReflectionProcessingProfile({
      inputMethod: "browser_recording",
      effectiveDurationMs: 60_000,
      processingProfile: "full_recording"
    } as Parameters<typeof resolveDailyReflectionProcessingProfile>[0] & {
      processingProfile: string;
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_profile_input_invalid",
      retryable: false
    }));
  });
});

describe("resolveDailyReflectionAuthoritativeDuration", () => {
  it.each([
    ["29.9996\n", 29.9996],
    ["180.0004\r\n", 180.0004]
  ] as const)(
    "preserves the default ffprobe precision for %s seconds",
    (stdout, expected) => {
      expect(parseDailyReflectionFfprobeDurationSeconds(stdout)).toBe(expected);
    }
  );

  it("applies sub-millisecond thresholds through the default ffprobe parser", async () => {
    const shortRead = vi.fn(async () => "29.9996\n");
    await expect(resolveDailyReflectionAuthoritativeDuration({
      filePath: "just-short.webm",
      inputMethod: "browser_recording"
    }, {
      readFfprobeStdout: shortRead
    })).rejects.toMatchObject({
      code: "daily_reflection_duration_too_short",
      retryable: false
    });
    expect(shortRead).toHaveBeenCalledWith("just-short.webm");

    const longRead = vi.fn(async () => "180.0004\n");
    await expect(resolveDailyReflectionAuthoritativeDuration({
      filePath: "just-full.webm",
      inputMethod: "browser_recording"
    }, {
      readFfprobeStdout: longRead
    })).resolves.toMatchObject({
      effectiveDurationMs: 180_001,
      processingProfile: "full_recording"
    });
    expect(longRead).toHaveBeenCalledWith("just-full.webm");
  });

  it.each([
    [29, "daily_reflection_duration_too_short"],
    [29.9999, "daily_reflection_duration_too_short"],
    [30, "quick_reflection"],
    [179, "quick_reflection"],
    [180, "quick_reflection"],
    [180.0001, "full_recording"],
    [180.001, "full_recording"],
    [181, "full_recording"],
    [300, "full_recording"]
  ] as const)(
    "applies the policy after probing %s seconds",
    async (durationSeconds, expected) => {
      const request = resolveDailyReflectionAuthoritativeDuration({
        filePath: "recording.webm",
        inputMethod: "browser_recording"
      }, {
        probeDurationSeconds: async () => durationSeconds
      });

      if (expected === "daily_reflection_duration_too_short") {
        await expect(request).rejects.toMatchObject({
          code: expected,
          retryable: false
        });
      } else {
        await expect(request).resolves.toMatchObject({
          effectiveDurationMs: Math.ceil(durationSeconds * 1_000),
          processingProfile: expected
        });
      }
    }
  );

  it("uses ffprobe duration rather than a spoofed client duration", async () => {
    const probeDurationSeconds = vi.fn(async () => 60);

    await expect(resolveDailyReflectionAuthoritativeDuration({
      filePath: "C:\\recordings with spaces\\reflection.webm",
      inputMethod: "browser_recording",
      clientReportedDurationMs: 300_000
    }, { probeDurationSeconds })).resolves.toEqual({
      inputMethod: "browser_recording",
      effectiveDurationMs: 60_000,
      clientReportedDurationMs: 300_000,
      durationSource: "server_ffprobe",
      processingProfile: "quick_reflection"
    });
    expect(probeDurationSeconds).toHaveBeenCalledWith(
      "C:\\recordings with spaces\\reflection.webm"
    );
    expect(probeDurationSeconds).toHaveBeenCalledTimes(1);
  });

  it("keeps a short client claim from downgrading a long server duration", async () => {
    await expect(resolveDailyReflectionAuthoritativeDuration({
      filePath: "long-browser-recording.webm",
      inputMethod: "browser_recording",
      clientReportedDurationMs: 30_000
    }, {
      probeDurationSeconds: async () => 181
    })).resolves.toMatchObject({
      effectiveDurationMs: 181_000,
      clientReportedDurationMs: 30_000,
      processingProfile: "full_recording"
    });
  });

  it.each([undefined, "181000", 0, Number.NaN, -1])(
    "keeps an invalid client duration audit value from affecting the result (%s)",
    async (clientReportedDurationMs) => {
      await expect(resolveDailyReflectionAuthoritativeDuration({
        filePath: "recording.webm",
        inputMethod: "browser_recording",
        clientReportedDurationMs
      }, {
        probeDurationSeconds: async () => 180.001
      })).resolves.toMatchObject({
        effectiveDurationMs: 180_001,
        clientReportedDurationMs: null,
        processingProfile: "full_recording"
      });
    }
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails closed when ffprobe returns an invalid duration (%s)",
    async (durationSeconds) => {
      await expect(resolveDailyReflectionAuthoritativeDuration({
        filePath: "broken.webm",
        inputMethod: "browser_recording"
      }, {
        probeDurationSeconds: async () => durationSeconds
      })).rejects.toMatchObject({
        code: "daily_reflection_duration_probe_failed",
        retryable: true
      });
    }
  );

  it("turns an ffprobe failure into a retryable, content-free error", async () => {
    const privateProbeMessage = "private path and ffprobe stderr";
    let thrown: unknown;
    try {
      await resolveDailyReflectionAuthoritativeDuration({
        filePath: "broken.webm",
        inputMethod: "browser_recording"
      }, {
        probeDurationSeconds: async () => {
          throw new Error(privateProbeMessage);
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DailyReflectionDurationProbeError);
    expect(thrown).toMatchObject({
      message: "daily_reflection_duration_probe_failed",
      retryable: true
    });
    expect(thrown).not.toMatchObject({ message: privateProbeMessage });
    expect("cause" in (thrown as object)).toBe(false);
  });

  it("publishes a strict resolution DTO that rejects a client-selected profile", () => {
    expect(DailyReflectionDurationResolutionSchema.safeParse({
      inputMethod: "browser_recording",
      effectiveDurationMs: 60_000,
      clientReportedDurationMs: 300_000,
      durationSource: "server_ffprobe",
      processingProfile: "full_recording"
    }).success).toBe(false);
  });

  it("rejects unknown fields in the duration resolution DTO", () => {
    expect(DailyReflectionDurationResolutionSchema.safeParse({
      inputMethod: "browser_recording",
      effectiveDurationMs: 60_000,
      clientReportedDurationMs: null,
      durationSource: "server_ffprobe",
      processingProfile: "quick_reflection",
      clientSelectedProfile: "full_recording"
    }).success).toBe(false);
  });
});
