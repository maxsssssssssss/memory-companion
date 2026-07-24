import { describe, expect, it } from "vitest";

import { toVoiceIdentityHint } from "./identity-hint";

describe("toVoiceIdentityHint", () => {
  it("projects a trusted known contact without changing identity facts", () => {
    expect(toVoiceIdentityHint({
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      identityType: "known_contact",
      confidence: 0.93,
      source: "voiceprint"
    })).toEqual({
      globalSpeakerId: "contact_alice",
      contactName: "Alice",
      identityType: "known_contact",
      confidence: 0.93,
      source: "voiceprint"
    });
  });

  it("keeps missing and unresolved identities unknown", () => {
    expect(toVoiceIdentityHint(undefined)).toEqual({
      identityType: "unknown_person",
      confidence: 0,
      source: "unknown"
    });
    expect(toVoiceIdentityHint({
      globalSpeakerId: "unknown_upload_chunk_speaker_1",
      identityType: "unknown_person",
      confidence: 0,
      source: "cross_chunk_matching"
    })).toEqual({
      identityType: "unknown_person",
      confidence: 0,
      source: "unknown"
    });
  });
});
