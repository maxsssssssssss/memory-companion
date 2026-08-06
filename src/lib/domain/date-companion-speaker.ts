import {
  normalizeSpeakerIdentityLabel,
  verifiedTranscriptSpeakerIdentity
} from "./speaker-identity";
import type { TranscriptSegment } from "./types";

const CHUNK_INDEX_PATTERN = /(?:^|_)chunk_(\d+)(?:_|$)/u;
const SAFE_KEY_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_INLINE_KEY_TOKEN_LENGTH = 470;
export const DATE_COMPANION_TRUSTED_SPEAKER_CONFIDENCE = 0.9;

function stableTokenHash(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x5bd1e995);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function scopedKey(namespace: "identity" | "candidate" | "local", value: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return undefined;
  const token = normalized.length <= MAX_INLINE_KEY_TOKEN_LENGTH && SAFE_KEY_TOKEN_PATTERN.test(normalized)
    ? normalized
    : `h_${stableTokenHash(normalized)}`;
  return `${namespace}_${token}`;
}

function normalizedIdentityKey(segment: Pick<TranscriptSegment, "speaker" | "identity">) {
  const identity = verifiedTranscriptSpeakerIdentity(
    segment,
    DATE_COMPANION_TRUSTED_SPEAKER_CONFIDENCE
  );
  if (!identity) return undefined;
  return scopedKey("identity", identity.globalSpeakerId);
}

export function dateCompanionIdentityContinuityKey(globalSpeakerId: string) {
  return scopedKey("identity", globalSpeakerId);
}

/**
 * Date Companion participants are recording-local review candidates, not
 * long-term identities. A verified/explicit identity may provide a stable key,
 * while anonymous chunk-local labels must stay separated by chunk.
 */
export function dateCompanionParticipantKey(
  segment: Pick<TranscriptSegment, "id" | "speaker" | "identity">
) {
  const knownIdentityKey = normalizedIdentityKey(segment);
  if (knownIdentityKey) return knownIdentityKey;

  const speaker = normalizeSpeakerIdentityLabel(segment.speaker);
  if (!speaker) return undefined;
  const chunkIndex = CHUNK_INDEX_PATTERN.exec(segment.id)?.[1];

  const anonymousIdentityKey = segment.identity?.identityType === "unknown_person"
    ? scopedKey(
        "candidate",
        chunkIndex
          ? `chunk_${chunkIndex}_${segment.identity.globalSpeakerId}`
          : segment.identity.globalSpeakerId
      )
    : undefined;
  if (anonymousIdentityKey) {
    return anonymousIdentityKey;
  }

  return scopedKey("local", chunkIndex ? `chunk_${chunkIndex}_${speaker}` : speaker);
}

export function dateCompanionParticipantLabel(
  segment: Pick<TranscriptSegment, "speaker" | "identity">
) {
  const identity = verifiedTranscriptSpeakerIdentity({
    speaker: segment.speaker,
    identity: segment.identity
  }, DATE_COMPANION_TRUSTED_SPEAKER_CONFIDENCE);
  const displayName = identity?.displayName?.normalize("NFKC").trim();
  if (displayName) {
    return displayName;
  }
  return undefined;
}
