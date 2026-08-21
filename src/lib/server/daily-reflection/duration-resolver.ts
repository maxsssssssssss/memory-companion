import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DailyReflectionDurationResolutionSchema,
  normalizeDailyReflectionClientReportedDurationMs,
  resolveDailyReflectionProcessingProfile,
  type DailyReflectionDurationResolution
} from "@/lib/domain/daily-reflection-duration";
import type {
  InputMethod,
  DailyReflectionV2InputAdapter
} from "@/lib/domain/daily-reflection";
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
  inputMethod: InputMethod;
  inputAdapter?: DailyReflectionV2InputAdapter;
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
 * Probes every persisted V2 input and keeps any client-reported duration as
 * audit-only metadata. The immutable ProcessingPlan V2 is derived exclusively
 * from this server result.
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
  const inputAdapter = input.inputAdapter ?? (
    input.inputMethod === "browser_recording" ? "browser_recorder" : "file_picker"
  );

  const processingProfile = resolveDailyReflectionProcessingProfile({
    inputMethod: input.inputMethod,
    inputAdapter,
    effectiveDurationMs
  });

  return DailyReflectionDurationResolutionSchema.parse({
    inputMethod: input.inputMethod,
    inputAdapter,
    effectiveDurationMs,
    clientReportedDurationMs: normalizeDailyReflectionClientReportedDurationMs(
      input.clientReportedDurationMs
    ),
    durationSource: "server_ffprobe",
    processingProfile
  });
}
