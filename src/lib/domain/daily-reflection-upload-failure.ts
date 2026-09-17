import { z } from "zod";

export const DailyReflectionUploadFailureCodeSchema = z.enum([
  "daily_reflection_audio_no_track",
  "daily_reflection_audio_invalid",
  "daily_reflection_audio_codec_unsupported",
  "daily_reflection_duration_probe_timeout",
  "daily_reflection_duration_decode_timeout",
  "daily_reflection_duration_tool_unavailable",
  "daily_reflection_duration_probe_failed",
  "daily_reflection_upload_persist_failed",
  "daily_reflection_upload_lease_lost",
  "daily_reflection_upload_interrupted",
  "daily_reflection_profile_input_invalid",
  "daily_reflection_input_method_invalid",
  "daily_reflection_duration_missing",
  "daily_reflection_duration_invalid",
  "daily_reflection_duration_too_short"
]);
export type DailyReflectionUploadFailureCode = z.infer<typeof DailyReflectionUploadFailureCodeSchema>;

export function dailyReflectionUploadFailure(code: unknown) {
  const parsed = DailyReflectionUploadFailureCodeSchema.safeParse(code);
  if (!parsed.success) return null;
  return {
    code: parsed.data,
    retryable: [
      "daily_reflection_duration_probe_timeout", "daily_reflection_duration_decode_timeout",
      "daily_reflection_duration_tool_unavailable", "daily_reflection_duration_probe_failed",
      "daily_reflection_upload_persist_failed", "daily_reflection_upload_lease_lost",
      "daily_reflection_upload_interrupted"
    ].includes(parsed.data)
  };
}

export const DailyReflectionUploadFailureSchema = z.object({
  code: DailyReflectionUploadFailureCodeSchema,
  retryable: z.boolean()
}).strict().refine((value) => dailyReflectionUploadFailure(value.code)?.retryable === value.retryable, {
  message: "retryable must match the safe upload failure classification"
});
export type DailyReflectionUploadFailure = z.infer<typeof DailyReflectionUploadFailureSchema>;
