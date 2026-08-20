import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DAILY_REFLECTION_DURATION_POLICY,
  DailyReflectionDurationPolicyError,
  DailyReflectionDurationResolutionSchema,
  normalizeDailyReflectionClientReportedDurationMs,
  resolveDailyReflectionProcessingProfile,
  type DailyReflectionDurationResolution
} from "@/lib/domain/daily-reflection-duration";
import type { InputMethod } from "@/lib/domain/daily-reflection";
import { getFfprobeExecutable } from "@/lib/server/ffmpeg";

export { resolveDailyReflectionProcessingProfile };

export const DAILY_REFLECTION_DURATION_PROBE_ERROR_CODE =
  "daily_reflection_duration_probe_failed" as const;

export class DailyReflectionDurationProbeError extends Error {
  readonly name = "DailyReflectionDurationProbeError";
  readonly code = DAILY_REFLECTION_DURATION_PROBE_ERROR_CODE;
  readonly retryable = true;

  constructor() {
    super(DAILY_REFLECTION_DURATION_PROBE_ERROR_CODE);
  }
}

export type ResolveDailyReflectionDurationInput = {
  filePath: string;
  inputMethod: Extract<InputMethod, "browser_recording">;
  clientReportedDurationMs?: unknown;
};

export type DailyReflectionDurationResolverDependencies = {
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  readFfprobeStdout?: (filePath: string) => Promise<unknown>;
};

const execFileAsync = promisify(execFile);

export function parseDailyReflectionFfprobeDurationSeconds(stdout: unknown) {
  const durationSeconds = Number(String(stdout).trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new DailyReflectionDurationProbeError();
  }
  return durationSeconds;
}

async function readDailyReflectionFfprobeStdout(filePath: string) {
  const result = await execFileAsync(getFfprobeExecutable(), [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  return typeof result === "string" ? result : result.stdout;
}

async function probeDailyReflectionDurationSeconds(
  filePath: string,
  readFfprobeStdout: (filePath: string) => Promise<unknown> =
    readDailyReflectionFfprobeStdout
) {
  return parseDailyReflectionFfprobeDurationSeconds(
    await readFfprobeStdout(filePath)
  );
}

function durationSecondsToMilliseconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new DailyReflectionDurationProbeError();
  }
  // Preserve the contract at sub-millisecond ffprobe precision: a value just
  // above 180 seconds must not be rounded down into the quick profile.
  const milliseconds = Math.ceil(value * 1_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new DailyReflectionDurationProbeError();
  }
  return milliseconds;
}

/**
 * Probes a persisted browser recording and keeps any browser-reported duration
 * as audit-only metadata. File uploads retain their existing full-recording
 * path and must not acquire this new probe precondition. Callers must persist
 * the returned processing profile in the immutable ProcessingPlan before
 * candidate extraction begins.
 */
export async function resolveDailyReflectionAuthoritativeDuration(
  input: ResolveDailyReflectionDurationInput,
  dependencies: DailyReflectionDurationResolverDependencies = {}
): Promise<DailyReflectionDurationResolution> {
  const probeDuration =
    dependencies.probeDurationSeconds
    ?? ((filePath: string) => probeDailyReflectionDurationSeconds(
      filePath,
      dependencies.readFfprobeStdout
    ));

  let durationSeconds: number;
  try {
    durationSeconds = await probeDuration(input.filePath);
  } catch {
    throw new DailyReflectionDurationProbeError();
  }

  const effectiveDurationMs = durationSecondsToMilliseconds(durationSeconds);

  // Conversely, never round a valid browser recording just below the
  // 30-second admission boundary up to an accepted duration.
  if (durationSeconds < DAILY_REFLECTION_DURATION_POLICY.minimumSeconds) {
    throw new DailyReflectionDurationPolicyError(
      "daily_reflection_duration_too_short"
    );
  }

  const processingProfile = resolveDailyReflectionProcessingProfile({
    inputMethod: input.inputMethod,
    effectiveDurationMs
  });

  return DailyReflectionDurationResolutionSchema.parse({
    inputMethod: input.inputMethod,
    effectiveDurationMs,
    clientReportedDurationMs: normalizeDailyReflectionClientReportedDurationMs(
      input.clientReportedDurationMs
    ),
    durationSource: "server_ffprobe",
    processingProfile
  });
}
