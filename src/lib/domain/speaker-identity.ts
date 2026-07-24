import type { TranscriptSegment, TranscriptSpeakerIdentity } from "./types";

export const DEFAULT_TRUSTED_SPEAKER_IDENTITY_CONFIDENCE = 0.8;

export function trustedTranscriptSpeakerIdentity(
  segment: Pick<TranscriptSegment, "identity">,
  minimumConfidence = DEFAULT_TRUSTED_SPEAKER_IDENTITY_CONFIDENCE
): TranscriptSpeakerIdentity | undefined {
  const identity = segment.identity;
  return identity && identity.confidence >= minimumConfidence ? identity : undefined;
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
        source: identity.source
      }
    : null;
}
