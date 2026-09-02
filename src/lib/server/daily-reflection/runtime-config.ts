export function isDailyReflectionUploadEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return env.DAILY_REFLECTION_UPLOAD_ENABLED?.trim().toLowerCase() === "true";
}

export type DailyReflectionAiReviewMode = "off" | "shadow" | "on";

/**
 * AI review is deliberately independent from the core Daily Reflection gate.
 * `shadow` runs and persists validated results without exposing generated copy
 * to the client; `on` enables the user-facing async upgrade.
 */
export function getDailyReflectionAiReviewMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): DailyReflectionAiReviewMode {
  const value = env.DAILY_REFLECTION_AI_REVIEW_MODE?.trim().toLowerCase();
  return value === "shadow" || value === "on" ? value : "off";
}

/**
 * Browser recordings are a separately staged server capability. Keeping this
 * switch independent from the upload switch prevents enabling the existing
 * file-upload path from also exposing microphone-originated ingestion.
 */
export function isDailyReflectionBrowserRecordingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED
    ?.trim()
    .toLowerCase() === "true";
}

function isStrictlyEnabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

/**
 * Toy Sync is a shared browser audio-input surface. The cross-module flag wins
 * when explicitly configured; the Daily Reflection name remains a compatibility
 * fallback for existing local environments and the first POC.
 */
export function isToySyncEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (env.DAILY_BRIEF_TOY_SYNC_ENABLED !== undefined) {
    return isStrictlyEnabled(env.DAILY_BRIEF_TOY_SYNC_ENABLED);
  }
  return isStrictlyEnabled(env.DAILY_REFLECTION_TOY_SYNC_ENABLED);
}

export function isDailyReflectionToySyncEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return isToySyncEnabled(env);
}
