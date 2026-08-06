import { describe, expect, it } from "vitest";

import type { TranscriptSegment } from "./types";
import {
  dateCompanionParticipantKey,
  dateCompanionParticipantLabel
} from "./date-companion-speaker";

function segment(
  id: string,
  speaker: string,
  identity?: TranscriptSegment["identity"]
): Pick<TranscriptSegment, "id" | "speaker" | "identity"> {
  return { id, speaker, ...(identity ? { identity } : {}) };
}

describe("dateCompanionParticipantKey", () => {
  it("does not merge the same chunk-local label from different chunks", () => {
    expect(dateCompanionParticipantKey(segment("upload_chunk_00000_seg_1", "speaker_1")))
      .toBe("local_chunk_00000_speaker_1");
    expect(dateCompanionParticipantKey(segment("upload_chunk_00001_seg_1", "speaker_1")))
      .toBe("local_chunk_00001_speaker_1");
  });

  it("scopes arbitrary Provider-local labels by chunk", () => {
    expect(dateCompanionParticipantKey(segment("upload_chunk_00000_seg_1", "spk_1")))
      .toBe("local_chunk_00000_spk_1");
    expect(dateCompanionParticipantKey(segment("upload_chunk_00001_seg_1", "spk_1")))
      .toBe("local_chunk_00001_spk_1");
  });

  it("uses anonymous candidate keys without treating them as a person identity", () => {
    expect(dateCompanionParticipantKey(segment("segment_1", "speaker_1", {
      globalSpeakerId: "unknown_chunk_a_speaker_1",
      identityType: "unknown_person",
      confidence: 0,
      source: "cross_chunk_matching"
    }))).toBe("candidate_unknown_chunk_a_speaker_1");
  });

  it("keeps an unknown candidate isolated between chunks even when its upstream id repeats", () => {
    const identity = {
      globalSpeakerId: "repeated_unknown",
      identityType: "unknown_person" as const,
      confidence: 0,
      source: "cross_chunk_matching" as const
    };
    expect(dateCompanionParticipantKey(segment(
      "upload_chunk_00000_seg_1",
      "spk_1",
      identity
    ))).toBe("candidate_chunk_00000_repeated_unknown");
    expect(dateCompanionParticipantKey(segment(
      "upload_chunk_00001_seg_1",
      "spk_1",
      identity
    ))).toBe("candidate_chunk_00001_repeated_unknown");
  });

  it("groups a known identity and preserves its friendly label", () => {
    const input = segment("segment_1", "saved_partner", {
      globalSpeakerId: "contact_partner",
      displayName: "Ta",
      identityType: "known_contact",
      confidence: 0.9,
      source: "voiceprint"
    });
    expect(dateCompanionParticipantKey(input)).toBe("identity_contact_partner");
    expect(dateCompanionParticipantLabel(input)).toBe("Ta");
  });

  it("requires at least 0.90 confidence for an acoustic voiceprint identity", () => {
    const input = segment("segment_1", "saved_partner", {
      globalSpeakerId: "contact_partner",
      displayName: "Ta",
      identityType: "known_contact",
      confidence: 0.899,
      source: "voiceprint"
    });
    expect(dateCompanionParticipantKey(input)).toBe("local_saved_partner");
    expect(dateCompanionParticipantLabel(input)).toBeUndefined();
  });

  it("keeps non-local Provider labels stable within an upload without exposing them as keys", () => {
    const first = dateCompanionParticipantKey(segment("segment_1", "林澄"));
    const second = dateCompanionParticipantKey(segment("segment_2", "林澄"));
    expect(first).toBe(second);
    expect(first).toMatch(/^local_h_[0-9a-f]{16}$/u);
  });

  it("namespaces candidate, identity and local keys and bounds long labels", () => {
    const raw = "same_key";
    expect(dateCompanionParticipantKey(segment("segment_1", raw))).toBe("local_same_key");
    expect(dateCompanionParticipantKey(segment("segment_1", raw, {
      globalSpeakerId: raw,
      identityType: "unknown_person",
      confidence: 0,
      source: "cross_chunk_matching"
    }))).toBe("candidate_same_key");
    const longKey = dateCompanionParticipantKey(segment("segment_1", "x".repeat(512)));
    expect(longKey?.length).toBeLessThanOrEqual(512);
    expect(longKey).toMatch(/^local_h_[0-9a-f]{16}$/u);
  });
});
