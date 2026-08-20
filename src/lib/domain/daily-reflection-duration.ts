import { z } from "zod";

import {
  InputMethodSchema,
  ProcessingProfileSchema,
  type ProcessingProfile
} from "./daily-reflection";

export const DAILY_REFLECTION_DURATION_POLICY = Object.freeze({
  minimumSeconds: 30,
  quickReflectionThresholdSeconds: 180,
  browserSafetyLimitSeconds: null
} as const);

export const DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT = 3 as const;

const MILLISECONDS_PER_SECOND = 1_000;

export const DailyReflectionEffectiveDurationMsSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const DailyReflectionClientReportedDurationMsSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const DailyReflectionDurationSourceSchema = z.literal("server_ffprobe");

export type DailyReflectionDurationPolicyErrorCode =
  | "daily_reflection_profile_input_invalid"
  | "daily_reflection_input_method_invalid"
  | "daily_reflection_duration_missing"
  | "daily_reflection_duration_invalid"
  | "daily_reflection_duration_too_short";

export class DailyReflectionDurationPolicyError extends Error {
  readonly name = "DailyReflectionDurationPolicyError";
  readonly retryable = false;

  constructor(readonly code: DailyReflectionDurationPolicyErrorCode) {
    super(code);
  }
}

export const DailyReflectionProcessingProfileInputSchema = z.object({
  inputMethod: z.unknown(),
  effectiveDurationMs: z.unknown().optional()
}).strict();

export type DailyReflectionProcessingProfileInput = z.input<
  typeof DailyReflectionProcessingProfileInputSchema
>;

/**
 * Resolves the immutable processing profile from a server-authoritative
 * duration. The 30-second minimum is a browser-recording admission check; it
 * is not an upload, ASR chunking, or global media limit.
 */
export function resolveDailyReflectionProcessingProfile(
  input: DailyReflectionProcessingProfileInput
): ProcessingProfile {
  const parsedInput = DailyReflectionProcessingProfileInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new DailyReflectionDurationPolicyError(
      "daily_reflection_profile_input_invalid"
    );
  }

  const inputMethod = InputMethodSchema.safeParse(parsedInput.data.inputMethod);
  if (!inputMethod.success) {
    throw new DailyReflectionDurationPolicyError(
      "daily_reflection_input_method_invalid"
    );
  }
  if (inputMethod.data === "file_upload") {
    return "full_recording";
  }
  if (
    parsedInput.data.effectiveDurationMs === null
    || parsedInput.data.effectiveDurationMs === undefined
  ) {
    throw new DailyReflectionDurationPolicyError(
      "daily_reflection_duration_missing"
    );
  }

  const duration = DailyReflectionEffectiveDurationMsSchema.safeParse(
    parsedInput.data.effectiveDurationMs
  );
  if (!duration.success) {
    throw new DailyReflectionDurationPolicyError(
      "daily_reflection_duration_invalid"
    );
  }

  const minimumDurationMs =
    DAILY_REFLECTION_DURATION_POLICY.minimumSeconds * MILLISECONDS_PER_SECOND;
  if (duration.data < minimumDurationMs) {
    throw new DailyReflectionDurationPolicyError(
      "daily_reflection_duration_too_short"
    );
  }

  const quickReflectionThresholdMs =
    DAILY_REFLECTION_DURATION_POLICY.quickReflectionThresholdSeconds
    * MILLISECONDS_PER_SECOND;
  return duration.data <= quickReflectionThresholdMs
    ? "quick_reflection"
    : "full_recording";
}

export function normalizeDailyReflectionClientReportedDurationMs(
  value: unknown
) {
  const parsed = DailyReflectionClientReportedDurationMsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const DailyReflectionDurationResolutionSchema = z.object({
  inputMethod: InputMethodSchema,
  effectiveDurationMs: DailyReflectionEffectiveDurationMsSchema,
  clientReportedDurationMs: DailyReflectionClientReportedDurationMsSchema.nullable(),
  durationSource: DailyReflectionDurationSourceSchema,
  processingProfile: ProcessingProfileSchema
}).strict().superRefine((resolution, context) => {
  try {
    const expectedProfile = resolveDailyReflectionProcessingProfile({
      inputMethod: resolution.inputMethod,
      effectiveDurationMs: resolution.effectiveDurationMs
    });
    if (resolution.processingProfile !== expectedProfile) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processingProfile"],
        message: "processingProfile must match the authoritative duration policy"
      });
    }
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveDurationMs"],
      message: error instanceof DailyReflectionDurationPolicyError
        ? error.code
        : "daily_reflection_duration_invalid"
    });
  }
});

export type DailyReflectionDurationResolution = z.infer<
  typeof DailyReflectionDurationResolutionSchema
>;
