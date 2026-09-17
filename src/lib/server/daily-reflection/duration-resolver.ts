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
import {
  DailyReflectionDurationProbeError,
  measureDailyReflectionAudio,
  type DurationToolOptions
} from "./duration-audio-tools";
export { DailyReflectionDurationProbeError } from "./duration-audio-tools";

export { resolveDailyReflectionProcessingProfile };

export const DAILY_REFLECTION_DURATION_PROBE_ERROR_CODE =
  "daily_reflection_duration_probe_failed" as const;

export type ResolveDailyReflectionDurationInput = DurationToolOptions & {
  filePath: string;
  inputMethod: InputMethod;
  inputAdapter?: DailyReflectionV2InputAdapter;
  clientReportedDurationMs?: unknown;
};

export type DailyReflectionDurationResolverDependencies = {
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  readFfprobeStdout?: (filePath: string) => Promise<unknown>;
};

export function parseDailyReflectionFfprobeDurationSeconds(stdout: unknown) {
  const durationSeconds = Number(String(stdout).trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new DailyReflectionDurationProbeError();
  }
  return durationSeconds;
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
  let durationSeconds: number;
  let durationSource: DailyReflectionDurationResolution["durationSource"] = "server_ffprobe";
  let requiresAudioExtraction: true | undefined;
  if (dependencies.probeDurationSeconds || dependencies.readFfprobeStdout) {
    // Existing deterministic policy-test seams; production always measures audio.
    try {
      durationSeconds = dependencies.probeDurationSeconds
        ? await dependencies.probeDurationSeconds(input.filePath)
        : parseDailyReflectionFfprobeDurationSeconds(await dependencies.readFfprobeStdout!(input.filePath));
    } catch { throw new DailyReflectionDurationProbeError(); }
  } else {
    const measured = await measureDailyReflectionAudio(input.filePath, input);
    durationSeconds = measured.durationSeconds;
    durationSource = measured.durationSource;
    requiresAudioExtraction = measured.requiresAudioExtraction;
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
    durationSource,
    ...(requiresAudioExtraction ? { requiresAudioExtraction } : {}),
    processingProfile
  });
}
