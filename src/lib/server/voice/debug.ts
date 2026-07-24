export type VoiceDebugFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

type VoiceDebugEnvironment = Readonly<Record<string, string | undefined>>;

export function voiceDebugEnabled(environment: VoiceDebugEnvironment = process.env) {
  return environment.VOICE_DEBUG?.trim().toLowerCase() === "true";
}
/**
 * Emits only caller-supplied structural metadata. Transcript text, provider
 * payloads, audio bytes, credentials and answer bodies must never be passed in.
 */
export function logVoiceDebug(
  event: string,
  fields: VoiceDebugFields = {},
  options: {
    environment?: VoiceDebugEnvironment;
    logger?: (message: string) => void;
  } = {}
) {
  if (!voiceDebugEnabled(options.environment)) return;
  const safeEvent = event.trim().slice(0, 80) || "unknown";
  const safeFields = Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .slice(0, 24)
      .map(([key, value]) => [key.slice(0, 80), value])
  );
  (options.logger ?? console.info)(`VOICE_DEBUG ${JSON.stringify({
    event: safeEvent,
    ...safeFields
  })}`);
}
