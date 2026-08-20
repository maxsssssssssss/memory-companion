import type {
  SpeakerIdentity,
  VoiceIdentityHint
} from "./types";

export function toVoiceIdentityHint(
  identity: SpeakerIdentity | null | undefined
): VoiceIdentityHint {
  if (
    !identity ||
    identity.identityType === "unknown_person" ||
    !identity.globalSpeakerId.trim()
  ) {
    return {
      identityType: "unknown_person",
      confidence: 0,
      source: "unknown"
    };
  }

  return {
    identityType: identity.identityType,
    globalSpeakerId: identity.globalSpeakerId,
    ...(identity.displayName ? { contactName: identity.displayName } : {}),
    confidence: identity.confidence,
    source: identity.source,
    ...(identity.evidence ? { evidence: { ...identity.evidence } } : {})
  };
}
