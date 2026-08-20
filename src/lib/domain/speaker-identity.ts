import type { TranscriptSegment, TranscriptSpeakerIdentity } from "./types";

export const DEFAULT_TRUSTED_SPEAKER_IDENTITY_CONFIDENCE = 0.8;
const CHUNK_LOCAL_SPEAKER_LABEL_PATTERN = /^speaker[_-]?\d+$/iu;

export function normalizeSpeakerIdentityLabel(value: string | null | undefined) {
  const normalized = value?.normalize("NFKC").trim();
  return normalized || undefined;
}

export function isChunkLocalSpeakerLabel(value: string | null | undefined) {
  const normalized = normalizeSpeakerIdentityLabel(value);
  return normalized !== undefined && CHUNK_LOCAL_SPEAKER_LABEL_PATTERN.test(normalized);
}

export function isVerifiedProviderSpeakerIdentity(
  segment: Pick<TranscriptSegment, "speaker" | "identity">
) {
  const identity = segment.identity;
  const localSpeaker = normalizeSpeakerIdentityLabel(segment.speaker);
  const providerLabel = normalizeSpeakerIdentityLabel(identity?.evidence?.providerLabel);
  return Boolean(
    identity &&
    identity.identityType !== "unknown_person" &&
    identity.source === "provider_speaker_result" &&
    identity.confidence === null &&
    identity.evidence?.type === "provider_label" &&
    localSpeaker &&
    !isChunkLocalSpeakerLabel(localSpeaker) &&
    providerLabel === localSpeaker
  );
}

export function trustedTranscriptSpeakerIdentity(
  segment: Pick<TranscriptSegment, "speaker" | "identity">,
  minimumConfidence = DEFAULT_TRUSTED_SPEAKER_IDENTITY_CONFIDENCE
): TranscriptSpeakerIdentity | undefined {
  const identity = segment.identity;
  if (!identity || identity.identityType === "unknown_person") {
    return undefined;
  }
  if (isVerifiedProviderSpeakerIdentity(segment)) {
    return identity;
  }
  return (
    identity.source === "voiceprint" &&
    typeof identity.confidence === "number" &&
    identity.confidence >= minimumConfidence
  )
    ? identity
    : undefined;
}

export function transcriptSpeakerLabel(
  segment: Pick<TranscriptSegment, "speaker" | "identity">,
  minimumConfidence = DEFAULT_TRUSTED_SPEAKER_IDENTITY_CONFIDENCE
) {
  const identity = trustedTranscriptSpeakerIdentity(segment, minimumConfidence);
  return identity?.displayName ?? identity?.globalSpeakerId ?? segment.speaker;
}

export function transcriptSpeakerIdentityKey(
  segment: Pick<TranscriptSegment, "speaker" | "identity">,
  minimumConfidence = DEFAULT_TRUSTED_SPEAKER_IDENTITY_CONFIDENCE
) {
  const identity = trustedTranscriptSpeakerIdentity(segment, minimumConfidence);
  return identity?.globalSpeakerId ?? segment.speaker;
}

export function transcriptSpeakerIdentityFingerprint(
  segment: Pick<TranscriptSegment, "identity">
) {
  const identity = segment.identity;
  return identity
    ? {
        globalSpeakerId: identity.globalSpeakerId,
        displayName: identity.displayName ?? null,
        identityType: identity.identityType,
        confidence: identity.confidence,
        source: identity.source,
        evidence: identity.evidence ?? null
      }
    : null;
}
