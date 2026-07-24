import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import {
  resolveMemoryOwnerAttribution,
  resolveMemoryOwnerAttributions
} from "./resolver";

const timestamp = "2026-07-20T00:00:00.000Z";

function segment(input: {
  id: string;
  text: string;
  speaker?: string;
  globalSpeakerId?: string;
  displayName?: string;
  identityType?: "known_user" | "known_contact" | "unknown_person";
  identityConfidence?: number;
  identitySource?: "voiceprint" | "cross_chunk_matching" | "manual_mapping";
  startSeconds?: number;
}): TranscriptSegment {
  const startSeconds = input.startSeconds ?? 0;
  return {
    id: input.id,
    uploadId: "upload_owner_test",
    startSeconds,
    endSeconds: startSeconds + 5,
    ...(input.speaker ? { speaker: input.speaker } : {}),
    ...(input.globalSpeakerId ? {
      identity: {
        globalSpeakerId: input.globalSpeakerId,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        identityType: input.identityType ?? "known_contact",
        confidence: input.identityConfidence ?? 0.95,
        source: input.identitySource ?? "voiceprint"
      }
    } : {}),
    text: input.text,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

describe("resolveMemoryOwnerAttribution", () => {
  it("treats a trusted known-user voiceprint identity as a known owner", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_known_user",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_known_user",
        text: "我更喜欢安静的位置。",
        speaker: "speaker_0",
        globalSpeakerId: "user_user_1",
        identityType: "known_user",
        identityConfidence: 0.95
      })]
    });

    expect(result.owner).toMatchObject({
      type: "known_identity",
      identityId: "user_user_1",
      confidence: 0.95,
      source: "explicit_statement"
    });
  });

  it("attributes an explicit first-person preference to a trusted known identity", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_preference_a",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_preference_a",
        text: "我不吃香菜，平时也会主动避开。",
        speaker: "speaker_0",
        globalSpeakerId: "person_a",
        displayName: "Private display name",
        identityConfidence: 0.92
      })]
    });

    expect(result.scope).toBe("individual");
    expect(result.owner).toEqual({
      type: "known_identity",
      identityId: "person_a",
      confidence: 0.92,
      source: "explicit_statement"
    });
    expect(result.participants).toEqual([
      expect.objectContaining({
        role: "owner",
        attribution: expect.objectContaining({ identityId: "person_a" }),
        evidenceSegmentIds: ["seg_preference_a"]
      })
    ]);
    expect(JSON.stringify(result)).not.toContain("Private display name");
    expect(JSON.stringify(result)).not.toContain("香菜");
  });

  it("does not attribute a third-person preference to the reporting speaker", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_third_person",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_third_person",
        text: "她不吃香菜，我只是帮她确认菜单。",
        speaker: "speaker_0",
        globalSpeakerId: "person_reporter"
      })]
    });

    expect(result.scope).toBe("unknown");
    expect(result.owner).toEqual({ type: "unknown", confidence: 0, source: "unknown" });
    expect(result.participants).toEqual([]);
    expect(result.observations[0]).toMatchObject({
      statementKind: "third_person_reference",
      eligible: false,
      reason: "third_person_reference"
    });
  });

  it("does not attribute a second-person preference to the reporting speaker", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_second_person",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_second_person",
        text: "你之前说不喜欢太甜，更倾向无糖饮料。",
        globalSpeakerId: "person_reporter"
      })]
    });

    expect(result.owner.type).toBe("unknown");
    expect(result.reasons).toContain("third_person_only");
  });

  it("uses a single trusted speaker identity for a direct preference without a pronoun", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_direct_preference",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_direct_preference",
        text: "无糖拿铁最好，实在没有的话低糖也可以。",
        globalSpeakerId: "person_a",
        identitySource: "voiceprint"
      })]
    });

    expect(result.owner).toEqual({
      type: "known_identity",
      identityId: "person_a",
      confidence: 0.95,
      source: "speaker_identity"
    });
    expect(result.reasons).toContain("speaker_identity_owner");
  });

  it("does not assign a shared preference to the speaker who happened to say it", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_shared_preference",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_shared_preference",
        text: "我们平时都更喜欢安静的位置。",
        globalSpeakerId: "person_a"
      })]
    });

    expect(result.owner.type).toBe("unknown");
    expect(result.reasons).toContain("shared_context");
  });

  it("does not let a leading first-person reporting clause override a third-person owner", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_reported_preference",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_reported_preference",
        text: "我知道她更喜欢安静的位置。",
        speaker: "speaker_0",
        globalSpeakerId: "person_reporter"
      })]
    });

    expect(result.owner.type).toBe("unknown");
    expect(result.observations[0]).toMatchObject({
      statementKind: "third_person_reference",
      eligible: false
    });
  });

  it("keeps low-confidence known-contact identity unknown", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_low_confidence",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_low_confidence",
        text: "我喜欢安静的位置。",
        speaker: "speaker_0",
        globalSpeakerId: "person_low",
        identityConfidence: 0.79
      })]
    });

    expect(result.owner.type).toBe("unknown");
    expect(result.observations[0]).toMatchObject({
      eligible: false,
      reason: "identity_below_threshold"
    });
  });

  it("represents a trusted anonymous resolved identity as local_speaker", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_anonymous",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_anonymous",
        text: "我通常喜欢清淡一点。",
        speaker: "speaker_1",
        globalSpeakerId: "anonymous_person_1",
        identityType: "unknown_person",
        identityConfidence: 0.9,
        identitySource: "cross_chunk_matching"
      })]
    });

    expect(result.owner).toEqual({
      type: "local_speaker",
      identityId: "anonymous_person_1",
      confidence: 0.9,
      source: "explicit_statement"
    });
  });

  it("never falls back to the raw local speaker label when identity is absent", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_no_identity",
      memoryType: "preference",
      evidenceSegments: [segment({
        id: "seg_no_identity",
        text: "我不太能吃辣。",
        speaker: "speaker_0"
      })]
    });

    expect(result.owner).toEqual({ type: "unknown", confidence: 0, source: "unknown" });
    expect(result.participants).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("speaker_0");
  });

  it("attributes a commitment actor and only the unique trusted receiver", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_commitment",
      memoryType: "commitment",
      evidenceSegments: [
        segment({
          id: "seg_actor",
          text: "我周二晚上陪你排练，也会帮你计时。",
          speaker: "speaker_1",
          globalSpeakerId: "person_partner",
          identitySource: "manual_mapping",
          startSeconds: 10
        }),
        segment({
          id: "seg_receiver",
          text: "好，那就按这个安排。",
          speaker: "speaker_0",
          globalSpeakerId: "person_user",
          startSeconds: 16
        })
      ]
    });

    expect(result.owner).toEqual({
      type: "known_identity",
      identityId: "person_partner",
      confidence: 0.95,
      source: "explicit_statement"
    });
    expect(result.scope).toBe("individual");
    expect(result.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "actor",
        attribution: expect.objectContaining({ identityId: "person_partner" })
      }),
      expect.objectContaining({
        role: "receiver",
        attribution: expect.objectContaining({ identityId: "person_user" })
      })
    ]));
  });

  it("does not invent a commitment receiver without a unique other identity", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_commitment_no_receiver",
      memoryType: "commitment",
      evidenceSegments: [segment({
        id: "seg_actor_only",
        text: "我周二晚上陪你排练。",
        speaker: "speaker_1",
        globalSpeakerId: "person_partner"
      })]
    });

    expect(result.participants.map((participant) => participant.role)).toEqual(["actor"]);
  });

  it("keeps the actor unknown when evidence contains commitments from multiple identities", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_mutual_commitments",
      memoryType: "commitment",
      evidenceSegments: [
        segment({
          id: "seg_mutual_a",
          text: "我会陪你排练。",
          globalSpeakerId: "person_a"
        }),
        segment({
          id: "seg_mutual_b",
          text: "我会提前准备提纲。",
          globalSpeakerId: "person_b",
          startSeconds: 6
        })
      ]
    });

    expect(result.scope).toBe("unknown");
    expect(result.owner.type).toBe("unknown");
    expect(result.participants).toEqual([]);
    expect(result.reasons).toContain("ambiguous_owner");
  });

  it("models a shared event with participants instead of forcing an owner", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_shared_event",
      memoryType: "event",
      evidenceSegments: [
        segment({
          id: "seg_event_a",
          text: "我们周日下午一起去陶艺体验课。",
          speaker: "speaker_0",
          globalSpeakerId: "person_a"
        }),
        segment({
          id: "seg_event_b",
          text: "好，我也会按时到。",
          speaker: "speaker_1",
          globalSpeakerId: "person_b",
          startSeconds: 6
        })
      ]
    });

    expect(result.scope).toBe("shared");
    expect(result.owner.type).toBe("unknown");
    expect(result.participants.map((participant) => participant.attribution.identityId).sort())
      .toEqual(["person_a", "person_b"]);
    expect(result.participants.every((participant) => participant.role === "participant")).toBe(true);
  });

  it("models a bilateral relationship rule as shared", () => {
    const result = resolveMemoryOwnerAttribution({
      memoryId: "memory_shared_relationship",
      memoryType: "relationship_signal",
      evidenceSegments: [
        segment({
          id: "seg_rule_a",
          text: "我们约定计划变化时提前通知。",
          speaker: "speaker_0",
          globalSpeakerId: "person_a"
        }),
        segment({
          id: "seg_rule_b",
          text: "这个规则双方都可以接受。",
          speaker: "speaker_1",
          globalSpeakerId: "person_b",
          startSeconds: 6
        })
      ]
    });

    expect(result.scope).toBe("shared");
    expect(result.owner.type).toBe("unknown");
    expect(result.participants).toHaveLength(2);
  });
});

describe("resolveMemoryOwnerAttributions audit", () => {
  it("reports structural counts without transcript, quote, or display names", () => {
    const privateQuote = "PRIVATE_TRANSCRIPT_QUOTE";
    const privateDisplayName = "PRIVATE_DISPLAY_NAME";
    const result = resolveMemoryOwnerAttributions({
      memories: [
        {
          memoryId: "memory_known",
          memoryType: "preference",
          evidenceSegments: [segment({
            id: "seg_known",
            text: `我喜欢清淡食物。${privateQuote}`,
            globalSpeakerId: "person_known",
            displayName: privateDisplayName
          })]
        },
        {
          memoryId: "memory_unknown",
          memoryType: "preference",
          evidenceSegments: [segment({
            id: "seg_unknown",
            text: "我喜欢辣。",
            speaker: "speaker_7"
          })]
        }
      ],
      now: () => timestamp
    });

    expect(result.audit).toMatchObject({
      version: 1,
      generatedAt: timestamp,
      memoriesProcessed: 2,
      knownOwners: 1,
      localSpeakerOwners: 0,
      unknownOwners: 1,
      individualMemories: 1,
      sharedMemories: 0,
      unknownScopeMemories: 1,
      explicitDerived: 1
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privateQuote);
    expect(serialized).not.toContain(privateDisplayName);
    expect(serialized).not.toContain("speaker_7");
  });
});
