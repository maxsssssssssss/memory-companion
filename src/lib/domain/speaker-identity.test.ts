import { describe, expect, it } from "vitest";
import {
  transcriptSpeakerIdentityKey,
  transcriptSpeakerLabel,
  trustedTranscriptSpeakerIdentity,
  verifiedTranscriptSpeakerIdentity
} from "./speaker-identity";

describe("transcript speaker identity display", () => {
  it("uses a trusted display name without changing the local speaker", () => {
    const segment = {
      speaker: "speaker_0",
      identity: {
        globalSpeakerId: "person_1",
        displayName: "Contact A",
        identityType: "known_contact" as const,
        confidence: 0.91,
        source: "voiceprint" as const
      }
    };

    expect(transcriptSpeakerLabel(segment)).toBe("Contact A");
    expect(segment.speaker).toBe("speaker_0");
  });

  it("falls back to the local label when identity confidence is low", () => {
    const segment = {
      speaker: "speaker_1",
      identity: {
        globalSpeakerId: "unknown_1",
        identityType: "unknown_person" as const,
        confidence: 0.42,
        source: "cross_chunk_matching" as const
      }
    };

    expect(trustedTranscriptSpeakerIdentity(segment)).toBeUndefined();
    expect(transcriptSpeakerLabel(segment)).toBe("speaker_1");
    expect(transcriptSpeakerIdentityKey(segment)).toBe("speaker_1");
  });

  it("uses global IDs as stable keys even when display names collide", () => {
    const first = {
      speaker: "speaker_0",
      identity: {
        globalSpeakerId: "person_1",
        displayName: "Same display name",
        identityType: "known_contact" as const,
        confidence: 0.91,
        source: "voiceprint" as const
      }
    };
    const second = {
      speaker: "speaker_1",
      identity: {
        globalSpeakerId: "person_2",
        displayName: "Same display name",
        identityType: "known_contact" as const,
        confidence: 0.93,
        source: "voiceprint" as const
      }
    };

    expect(transcriptSpeakerLabel(first)).toBe(transcriptSpeakerLabel(second));
    expect(transcriptSpeakerIdentityKey(first)).toBe("person_1");
    expect(transcriptSpeakerIdentityKey(second)).toBe("person_2");
    expect(transcriptSpeakerIdentityKey(first)).not.toBe(transcriptSpeakerIdentityKey(second));
  });

  it("keeps an anonymous cross-chunk identity outside the strict verified boundary", () => {
    const segment = {
      speaker: "speaker_3",
      identity: {
        globalSpeakerId: "person_3",
        identityType: "unknown_person" as const,
        confidence: 0.88,
        source: "cross_chunk_matching" as const
      }
    };

    expect(verifiedTranscriptSpeakerIdentity(segment)).toBeUndefined();
  });

  it("trusts an exact Provider speaker_result label without an acoustic score", () => {
    const segment = {
      speaker: "Alice",
      identity: {
        globalSpeakerId: "contact_alice",
        displayName: "Alice",
        identityType: "known_contact" as const,
        confidence: null,
        source: "provider_speaker_result" as const,
        evidence: {
          type: "provider_label" as const,
          provider: "company_voiceprint" as const,
          providerLabel: "Alice"
        }
      }
    };

    expect(verifiedTranscriptSpeakerIdentity(segment)).toEqual(segment.identity);
  });

  it("rejects Provider evidence when its label differs from speaker_result", () => {
    const segment = {
      speaker: "speaker_1",
      identity: {
        globalSpeakerId: "contact_alice",
        identityType: "known_contact" as const,
        confidence: null,
        source: "provider_speaker_result" as const,
        evidence: {
          type: "provider_label" as const,
          provider: "company_voiceprint" as const,
          providerLabel: "Alice"
        }
      }
    };

    expect(verifiedTranscriptSpeakerIdentity(segment)).toBeUndefined();
  });

  it("rejects an exact chunk-local label even when it is marked Provider-verified", () => {
    const segment = {
      speaker: "speaker_1",
      identity: {
        globalSpeakerId: "contact_invalid",
        identityType: "known_contact" as const,
        confidence: null,
        source: "provider_speaker_result" as const,
        evidence: {
          type: "provider_label" as const,
          provider: "company_voiceprint" as const,
          providerLabel: "speaker_1"
        }
      }
    };

    expect(verifiedTranscriptSpeakerIdentity(segment)).toBeUndefined();
  });

  it("does not treat a manual-only mapping as Provider-verified identity", () => {
    const segment = {
      speaker: "speaker_4",
      identity: {
        globalSpeakerId: "person_4",
        identityType: "known_contact" as const,
        confidence: 1,
        source: "manual_mapping" as const
      }
    };

    expect(verifiedTranscriptSpeakerIdentity(segment)).toBeUndefined();
  });
});
