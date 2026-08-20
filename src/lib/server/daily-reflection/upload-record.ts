import type { ProcessingProfile } from "@/lib/domain/daily-reflection";
import type {
  DailyReflectionDurationResolution
} from "@/lib/domain/daily-reflection-duration";
import type { AudioUpload } from "@/lib/domain/types";

const DAILY_REFLECTION_STORAGE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function buildDailyReflectionUploadId(reflectionId: string) {
  if (!DAILY_REFLECTION_STORAGE_KEY_PATTERN.test(reflectionId)) {
    throw new Error("invalid_daily_reflection_storage_key");
  }
  const uploadId = `daily-reflection-${reflectionId}`;
  if (uploadId.length > 512) {
    throw new Error("invalid_daily_reflection_storage_key");
  }
  return uploadId;
}

export type StoredDailyReflectionUpload = AudioUpload & {
  filePath: string;
  ingestionContext: "daily_reflection";
  reflectionId: string;
  uploadFingerprint?: string;
  persistenceAttemptVersion?: number;
  effectiveDurationMs?: DailyReflectionDurationResolution["effectiveDurationMs"];
  clientReportedDurationMs?: DailyReflectionDurationResolution["clientReportedDurationMs"];
  durationSource?: DailyReflectionDurationResolution["durationSource"];
  processingProfile?: ProcessingProfile;
  errorCode?: string;
  errorMessage?: string;
};

export function isDailyReflectionUpload(
  value: unknown
): value is StoredDailyReflectionUpload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ingestionContext === "daily_reflection"
    && typeof record.reflectionId === "string"
    && record.reflectionId.trim().length > 0;
}

// Compatibility alias for staging internals that historically used the more
// verbose name. Legacy upload consumers should use the shared guard above.
export const isDailyReflectionUploadRecord = isDailyReflectionUpload;
