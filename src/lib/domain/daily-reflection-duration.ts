import { z } from "zod";

import {
  DailyReflectionV2InputAdapterSchema,
  DailyReflectionDurationSourceSchema,
  InputMethodSchema,
  ProcessingProfileSchema,
  type ProcessingProfile
} from "./daily-reflection";

export const DAILY_REFLECTION_DURATION_POLICY = Object.freeze({
  minimumSeconds: null,
  quickReflectionThresholdSeconds: 180,
  browserSafetyLimitSeconds: null
} as const);

export const DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT = 3 as const;
export const DAILY_REFLECTION_FULL_CANDIDATE_DEFAULT = 5 as const;
export const DAILY_REFLECTION_FULL_CANDIDATE_LIMIT = 7 as const;

const MILLISECONDS_PER_SECOND = 1_000;

export const DailyReflectionEffectiveDurationMsSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const DailyReflectionClientReportedDurationMsSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export { DailyReflectionDurationSourceSchema } from "./daily-reflection";

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
  inputMethod: z.unknown().optional(),
  inputAdapter: z.unknown().optional(),
  effectiveDurationMs: z.unknown().optional()
}).strict();

export type DailyReflectionProcessingProfileInput = z.input<
  typeof DailyReflectionProcessingProfileInputSchema
>;

/**
 * Resolves the immutable processing profile from a server-authoritative
 * duration for every V2 input adapter. Client-selected profiles are ignored.
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

  const inputMethod = parsedInput.data.inputMethod === undefined
    ? null
    : InputMethodSchema.safeParse(parsedInput.data.inputMethod);
  const inputAdapter = parsedInput.data.inputAdapter === undefined
    ? null
    : DailyReflectionV2InputAdapterSchema.safeParse(parsedInput.data.inputAdapter);
  if (
    (!inputMethod && !inputAdapter)
    || (inputMethod && !inputMethod.success)
    || (inputAdapter && !inputAdapter.success)
  ) {
    throw new DailyReflectionDurationPolicyError(
      "daily_reflection_input_method_invalid"
    );
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
  inputAdapter: DailyReflectionV2InputAdapterSchema,
  effectiveDurationMs: DailyReflectionEffectiveDurationMsSchema,
  clientReportedDurationMs: DailyReflectionClientReportedDurationMsSchema.nullable(),
  durationSource: DailyReflectionDurationSourceSchema,
  requiresAudioExtraction: z.literal(true).optional(),
  processingProfile: ProcessingProfileSchema
}).strict().superRefine((resolution, context) => {
  try {
    const expectedProfile = resolveDailyReflectionProcessingProfile({
      inputMethod: resolution.inputMethod,
      inputAdapter: resolution.inputAdapter,
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
