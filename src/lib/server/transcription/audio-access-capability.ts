import { createHmac, timingSafeEqual } from "node:crypto";

export const TRANSCRIPTION_AUDIO_ACCESS_PURPOSE = "transcription";
export const TRANSCRIPTION_AUDIO_ACCESS_TTL_SECONDS = 5 * 60;
export const DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET_ENV =
  "DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET";

export function getDailyReflectionAudioCapabilitySecret() {
  const value = process.env[DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET_ENV]?.trim();
  return value ? value : undefined;
}

type TranscriptionAudioCapabilityInput = {
  userId: string;
  uploadId: string;
  chunkId?: string;
  expiresAtSeconds: number;
};

function capabilityPayload(input: TranscriptionAudioCapabilityInput) {
  return [
    "v1",
    TRANSCRIPTION_AUDIO_ACCESS_PURPOSE,
    input.userId,
    input.uploadId,
    input.chunkId ?? "",
    String(input.expiresAtSeconds)
  ].join("\u0000");
}

export function createTranscriptionAudioAccessCapability(
  secret: string,
  input: TranscriptionAudioCapabilityInput
) {
  return createHmac("sha256", secret)
    .update(capabilityPayload(input))
    .digest("base64url");
}

export function verifyTranscriptionAudioAccessCapability(input: {
  secret: string;
  capability: string | null | undefined;
  purpose: string | null | undefined;
  userId: string;
  uploadId: string;
  chunkId?: string;
  expiresAtSeconds: number;
  nowSeconds?: number;
}) {
  if (
    input.purpose !== TRANSCRIPTION_AUDIO_ACCESS_PURPOSE
    || !input.capability
  ) {
    return false;
  }
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(input.expiresAtSeconds)
    || input.expiresAtSeconds <= nowSeconds
    || input.expiresAtSeconds > nowSeconds + TRANSCRIPTION_AUDIO_ACCESS_TTL_SECONDS
  ) {
    return false;
  }
  const expected = createTranscriptionAudioAccessCapability(input.secret, input);
  const actualBytes = Buffer.from(input.capability);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}
