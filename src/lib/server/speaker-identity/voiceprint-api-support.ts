import { createHash } from "node:crypto";

import { VoiceprintProviderError } from "./voiceprint-client";

type VoiceprintApiOperation = "train" | "save";

function digest(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function createVoiceprintProviderRequestId(input: {
  operation: VoiceprintApiOperation;
  userId: string;
  clientRequestId: string;
}) {
  const requestKey = input.clientRequestId.trim();
  if (!requestKey) {
    throw new VoiceprintProviderError(
      "invalid_request",
      "voiceprint client request id is required"
    );
  }
  return [
    "voiceprint",
    input.operation,
    digest(input.userId.trim(), 16),
    digest(requestKey, 32)
  ].join("_");
}

export function buildVoiceprintTrainingAudioUrl(input: {
  userId: string;
  uploadId: string;
}) {
  const rawBaseUrl = process.env.SPEAKER_ASR_AUDIO_BASE_URL?.trim();
  const accessToken = process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN?.trim();
  if (!rawBaseUrl || !accessToken) {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      "speaker ASR audio delivery configuration is required for voiceprint training"
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      "SPEAKER_ASR_AUDIO_BASE_URL must be an absolute URL"
    );
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      "SPEAKER_ASR_AUDIO_BASE_URL must use http or https"
    );
  }

  baseUrl.search = "";
  baseUrl.hash = "";
  const normalizedBaseUrl = baseUrl.toString().replace(/\/+$/, "");
  return `${normalizedBaseUrl}/api/internal/audio/${encodeURIComponent(
    input.userId
  )}/${encodeURIComponent(input.uploadId)}?token=${encodeURIComponent(accessToken)}`;
}

export function buildVoiceprintTrainingCandidateAudioUrl(input: {
  userId: string;
  candidateId: string;
}) {
  const rawBaseUrl = process.env.SPEAKER_ASR_AUDIO_BASE_URL?.trim();
  const accessToken = process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN?.trim();
  if (!rawBaseUrl || !accessToken) {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      "speaker ASR audio delivery configuration is required for voiceprint training"
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      "SPEAKER_ASR_AUDIO_BASE_URL must be an absolute URL"
    );
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      "SPEAKER_ASR_AUDIO_BASE_URL must use http or https"
    );
  }
  baseUrl.search = "";
  baseUrl.hash = "";
  const normalizedBaseUrl = baseUrl.toString().replace(/\/+$/, "");
  return `${normalizedBaseUrl}/api/internal/voiceprint-candidates/${encodeURIComponent(
    input.userId
  )}/${encodeURIComponent(input.candidateId)}?token=${encodeURIComponent(accessToken)}`;
}
