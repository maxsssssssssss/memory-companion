import { describe, expect, it, vi } from "vitest";
import type { TranscriptChunk } from "@/lib/domain/chunks";
import { trustedTranscriptSpeakerIdentity } from "@/lib/domain/speaker-identity";
import type { TranscriptSegment } from "@/lib/domain/types";
import { speakerIdentityCandidateKey } from "./matching";
import { resolveSpeakerIdentities } from "./resolver";
import type { SpeakerIdentityMatcher } from "./types";

const timestamp = "2026-07-17T00:00:00.000Z";

function segment(input: {
  uploadId?: string;
  id: string;
  speaker?: string;
  text?: string;
  startSeconds: number;
  endSeconds: number;
}): TranscriptSegment {
  return {
    id: input.id,
    uploadId: input.uploadId ?? "upload_1",
    startSeconds: input.startSeconds,
    endSeconds: input.endSeconds,
    ...(input.speaker ? { speaker: input.speaker } : {}),
    text: input.text ?? `text_${input.id}`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function chunk(index: number, segments: TranscriptSegment[]): TranscriptChunk {
  const id = `upload_1_transcript_chunk_${String(index).padStart(5, "0")}`;
  return {
    id,
    uploadId: "upload_1",
    audioChunkId: `upload_1_audio_chunk_${String(index).padStart(5, "0")}`,
    index,
    startSeconds: index * 300,
    endSeconds: (index + 1) * 300,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries(
      segments.flatMap((item) => item.speaker ? [[item.speaker, item.speaker]] : [])
    ),
    segments,
    status: "completed",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: { provider: "test" }
  };
}

function identityMatcher(): SpeakerIdentityMatcher {
  return {
    score({ left, right }) {
      const leftIdentity = (left.matcherFeatures as { identity?: string } | undefined)?.identity;
      const rightIdentity = (right.matcherFeatures as { identity?: string } | undefined)?.identity;
      return leftIdentity && rightIdentity && leftIdentity === rightIdentity ? 0.96 : 0.1;
    }
  };
}

function identityOf(result: Awaited<ReturnType<typeof resolveSpeakerIdentities>>, chunkIndex: number, speaker: string) {
  return result.assignmentsByCandidateKey[
    speakerIdentityCandidateKey(result.chunks[chunkIndex].id, speaker)
  ].identity;
}

describe("resolveSpeakerIdentities", () => {
  it("matches the same person across chunks when an injected matcher supplies evidence", async () => {
    const chunks = [
      chunk(0, [segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })]),
      chunk(1, [segment({ id: "s1", speaker: "speaker_0", startSeconds: 301, endSeconds: 304 })])
    ];
    const matcher: SpeakerIdentityMatcher = { score: vi.fn(() => 0.94) };

    const result = await resolveSpeakerIdentities({ uploadId: "upload_1", chunks, matcher });

    expect(identityOf(result, 0, "speaker_0").globalSpeakerId)
      .toBe(identityOf(result, 1, "speaker_0").globalSpeakerId);
    expect(result.assignments.map((item) => item.matched)).toEqual([false, true]);
    expect(matcher.score).toHaveBeenCalledOnce();
  });

  it("recovers a cross-chunk local-label swap from injected matcher features", async () => {
    const chunks = [
      chunk(0, [
        segment({ id: "a0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 }),
        segment({ id: "b0", speaker: "speaker_1", startSeconds: 5, endSeconds: 8 })
      ]),
      chunk(1, [
        segment({ id: "b1", speaker: "speaker_0", startSeconds: 301, endSeconds: 304 }),
        segment({ id: "a1", speaker: "speaker_1", startSeconds: 305, endSeconds: 308 })
      ])
    ];
    const features = Object.fromEntries([
      [speakerIdentityCandidateKey(chunks[0].id, "speaker_0"), { identity: "a" }],
      [speakerIdentityCandidateKey(chunks[0].id, "speaker_1"), { identity: "b" }],
      [speakerIdentityCandidateKey(chunks[1].id, "speaker_0"), { identity: "b" }],
      [speakerIdentityCandidateKey(chunks[1].id, "speaker_1"), { identity: "a" }]
    ]);

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      matcher: identityMatcher(),
      matcherFeatures: features
    });

    expect(identityOf(result, 0, "speaker_0").globalSpeakerId)
      .toBe(identityOf(result, 1, "speaker_1").globalSpeakerId);
    expect(identityOf(result, 0, "speaker_1").globalSpeakerId)
      .toBe(identityOf(result, 1, "speaker_0").globalSpeakerId);
    expect(identityOf(result, 0, "speaker_0").globalSpeakerId)
      .not.toBe(identityOf(result, 0, "speaker_1").globalSpeakerId);
  });

  it("keeps a low-confidence comparison as a separate unknown identity", async () => {
    const chunks = [
      chunk(0, [segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })]),
      chunk(1, [segment({ id: "s1", speaker: "speaker_0", startSeconds: 301, endSeconds: 304 })])
    ];

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      matcher: { score: () => 0.62 },
      matchThreshold: 0.8
    });

    expect(identityOf(result, 0, "speaker_0").globalSpeakerId)
      .not.toBe(identityOf(result, 1, "speaker_0").globalSpeakerId);
    expect(result.assignments[1]).toMatchObject({
      matched: false,
      reason: "below_confidence_threshold",
      identity: { identityType: "unknown_person", confidence: 0 }
    });
  });

  it("rejects an ambiguous best match that does not clear the configured margin", async () => {
    const chunks = [
      chunk(0, [
        segment({ id: "a0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 }),
        segment({ id: "b0", speaker: "speaker_1", startSeconds: 5, endSeconds: 8 })
      ]),
      chunk(1, [segment({ id: "c1", speaker: "speaker_9", startSeconds: 301, endSeconds: 304 })])
    ];

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      matcher: {
        score({ right }) {
          return right.localSpeaker === "speaker_0" ? 0.91 : 0.88;
        }
      },
      matchThreshold: 0.8,
      matchMargin: 0.05
    });

    const assignment = result.assignmentsByCandidateKey[
      speakerIdentityCandidateKey(chunks[1].id, "speaker_9")
    ];
    expect(assignment).toMatchObject({
      matched: false,
      reason: "ambiguous_match",
      identity: { identityType: "unknown_person", confidence: 0 }
    });
    expect(result.audit.comparisons).toEqual(expect.arrayContaining([
      expect.objectContaining({ score: 0.91, accepted: false, reason: "ambiguous_match" })
    ]));
    expect(trustedTranscriptSpeakerIdentity(result.chunks[1].segments[0])).toBeUndefined();
  });

  it("uses an accepted voiceprint hint before consulting the matcher for that group", async () => {
    const chunks = [chunk(0, [
      segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })
    ])];
    const matcher: SpeakerIdentityMatcher = { score: vi.fn(() => 0.99) };

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      voiceprintHints: [{
        chunkId: chunks[0].id,
        localSpeaker: "speaker_0",
        globalSpeakerId: "contact_voiceprint",
        displayName: "Known contact",
        identityType: "known_contact",
        confidence: 0.93
      }],
      matcher
    });

    expect(identityOf(result, 0, "speaker_0")).toMatchObject({
      globalSpeakerId: "contact_voiceprint",
      displayName: "Known contact",
      confidence: 0.93,
      source: "voiceprint"
    });
    expect(result.audit.assignments[0].identity).not.toHaveProperty("displayName");
    expect(JSON.stringify(result.audit)).not.toContain("Known contact");
    expect(matcher.score).not.toHaveBeenCalled();
  });

  it("preserves a provider-confirmed known-user identity without changing the local label", async () => {
    const chunks = [chunk(0, [
      segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })
    ])];

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      voiceprintHints: [{
        chunkId: chunks[0].id,
        localSpeaker: "speaker_0",
        globalSpeakerId: "user_user_1",
        identityType: "known_user",
        confidence: 0.94
      }]
    });

    expect(result.chunks[0].segments[0]).toMatchObject({
      speaker: "speaker_0",
      identity: {
        globalSpeakerId: "user_user_1",
        identityType: "known_user",
        confidence: 0.94,
        source: "voiceprint"
      }
    });
  });

  it("gives a manual mapping priority over voiceprint and matcher evidence", async () => {
    const chunks = [
      chunk(0, [segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })]),
      chunk(1, [segment({ id: "s1", speaker: "speaker_7", startSeconds: 301, endSeconds: 304 })])
    ];

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      manualMappings: [{
        chunkId: chunks[1].id,
        localSpeaker: "speaker_7",
        globalSpeakerId: "contact_partner",
        displayName: "Partner"
      }],
      voiceprintHints: [{
        chunkId: chunks[1].id,
        localSpeaker: "speaker_7",
        globalSpeakerId: "wrong_voiceprint",
        identityType: "known_contact",
        confidence: 0.99
      }],
      matcher: { score: () => 0.95 }
    });

    expect(identityOf(result, 1, "speaker_7")).toEqual({
      globalSpeakerId: "contact_partner",
      displayName: "Partner",
      identityType: "known_contact",
      confidence: 1,
      source: "manual_mapping"
    });
    expect(identityOf(result, 0, "speaker_0").globalSpeakerId).toBe("contact_partner");
    expect(identityOf(result, 0, "speaker_0").source).toBe("cross_chunk_matching");
  });

  it("does not merge different people and prevents one identity occupying two groups in one chunk", async () => {
    const first = chunk(0, [
      segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 }),
      segment({ id: "s1", speaker: "speaker_1", startSeconds: 5, endSeconds: 8 })
    ]);
    const second = chunk(1, [
      segment({ id: "s2", speaker: "speaker_0", startSeconds: 301, endSeconds: 304 })
    ]);

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks: [first, second],
      manualMappings: [
        { chunkId: first.id, localSpeaker: "speaker_0", globalSpeakerId: "person_a" },
        { chunkId: first.id, localSpeaker: "speaker_1", globalSpeakerId: "person_a", confidence: 0.9 }
      ],
      matcher: { score: () => 0.2 }
    });

    expect(identityOf(result, 0, "speaker_0").globalSpeakerId).toBe("person_a");
    expect(identityOf(result, 0, "speaker_1").globalSpeakerId).not.toBe("person_a");
    expect(result.assignmentsByCandidateKey[
      speakerIdentityCandidateKey(first.id, "speaker_1")
    ]).toMatchObject({
      matched: false,
      reason: "same_chunk_identity_conflict",
      identity: { identityType: "unknown_person", confidence: 0 }
    });
    expect(trustedTranscriptSpeakerIdentity(result.chunks[0].segments[1])).toBeUndefined();
    expect(identityOf(result, 1, "speaker_0").globalSpeakerId).not.toBe("person_a");
  });

  it("fails closed when one local speaker has conflicting voiceprint identities", async () => {
    const chunks = [chunk(0, [
      segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })
    ])];

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      voiceprintHints: [
        {
          chunkId: chunks[0].id,
          localSpeaker: "speaker_0",
          globalSpeakerId: "contact_alice",
          identityType: "known_contact",
          confidence: 0.95
        },
        {
          chunkId: chunks[0].id,
          localSpeaker: "speaker_0",
          globalSpeakerId: "contact_bob",
          identityType: "known_contact",
          confidence: 0.94
        }
      ]
    });

    expect(result.assignments[0]).toMatchObject({
      matched: false,
      reason: "ambiguous_match",
      identity: { identityType: "unknown_person", confidence: 0 }
    });
    expect(result.audit.conflicts).toBe(1);
  });

  it("rejects a voiceprint hint that omits an explicit known identity type", async () => {
    const chunks = [chunk(0, [
      segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })
    ])];

    await expect(resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      voiceprintHints: [{
        chunkId: chunks[0].id,
        localSpeaker: "speaker_0",
        globalSpeakerId: "contact_alice",
        confidence: 0.95
      } as never]
    })).rejects.toThrow("explicit known_user or known_contact");
  });

  it("fails closed when the same voiceprint id has conflicting identity types", async () => {
    const chunks = [chunk(0, [
      segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })
    ])];

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      voiceprintHints: [
        {
          chunkId: chunks[0].id,
          localSpeaker: "speaker_0",
          globalSpeakerId: "identity_1",
          identityType: "known_user",
          confidence: 0.95
        },
        {
          chunkId: chunks[0].id,
          localSpeaker: "speaker_0",
          globalSpeakerId: "identity_1",
          identityType: "known_contact",
          confidence: 0.95
        }
      ]
    });

    expect(result.assignments[0]).toMatchObject({
      matched: false,
      reason: "ambiguous_match",
      identity: { identityType: "unknown_person", confidence: 0 }
    });
  });

  it("fails closed when two speakers in one chunk receive the same voiceprint identity", async () => {
    const chunks = [chunk(0, [
      segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 }),
      segment({ id: "s1", speaker: "speaker_1", startSeconds: 5, endSeconds: 8 })
    ])];

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      voiceprintHints: ["speaker_0", "speaker_1"].map((localSpeaker) => ({
        chunkId: chunks[0].id,
        localSpeaker,
        globalSpeakerId: "contact_alice",
        identityType: "known_contact" as const,
        confidence: 0.95
      }))
    });

    expect(result.assignments).toEqual([
      expect.objectContaining({
        matched: false,
        reason: "same_chunk_identity_conflict",
        identity: expect.objectContaining({ identityType: "unknown_person" })
      }),
      expect.objectContaining({
        matched: false,
        reason: "same_chunk_identity_conflict",
        identity: expect.objectContaining({ identityType: "unknown_person" })
      })
    ]);
    expect(result.audit.conflicts).toBe(2);
  });

  it("keeps a high-score same-chunk conflict untrusted while retaining its comparison score", async () => {
    const first = chunk(0, [
      segment({ id: "s0", speaker: "speaker_0", startSeconds: 1, endSeconds: 4 })
    ]);
    const second = chunk(1, [
      segment({ id: "s1", speaker: "speaker_0", startSeconds: 301, endSeconds: 304 }),
      segment({ id: "s2", speaker: "speaker_1", startSeconds: 305, endSeconds: 308 })
    ]);

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks: [first, second],
      manualMappings: [{
        chunkId: first.id,
        localSpeaker: "speaker_0",
        globalSpeakerId: "person_a"
      }],
      matcher: { score: () => 0.95 }
    });

    const conflictedKey = speakerIdentityCandidateKey(second.id, "speaker_1");
    const conflicted = result.assignmentsByCandidateKey[conflictedKey];
    expect(conflicted).toMatchObject({
      matched: false,
      reason: "same_chunk_identity_conflict",
      identity: { identityType: "unknown_person", confidence: 0 }
    });
    expect(result.audit.comparisons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        leftCandidateKey: conflictedKey,
        score: 0.95,
        accepted: false,
        reason: "same_chunk_identity_conflict"
      })
    ]));
    expect(trustedTranscriptSpeakerIdentity(result.chunks[1].segments[1])).toBeUndefined();
  });

  it("preserves transcript integrity, does not mutate input, and keeps audit free of text and matcher features", async () => {
    const sensitiveText = "PRIVATE_TRANSCRIPT_TEXT";
    const sensitiveFeature = "PRIVATE_EMBEDDING_VALUE";
    const chunks = [chunk(0, [
      segment({
        id: "stable_segment_id",
        speaker: "speaker_0",
        text: sensitiveText,
        startSeconds: 10.125,
        endSeconds: 19.875
      }),
      segment({ id: "no_speaker", text: "other", startSeconds: 20, endSeconds: 24 })
    ])];
    const original = structuredClone(chunks);
    const key = speakerIdentityCandidateKey(chunks[0].id, "speaker_0");

    const result = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      matcherFeatures: { [key]: { embedding: sensitiveFeature } },
      now: () => timestamp
    });

    expect(chunks).toEqual(original);
    expect(result.chunks[0].segments.map(({ identity: _identity, ...item }) => item))
      .toEqual(original[0].segments);
    expect(result.chunks[0].segments[0].identity).toBeDefined();
    expect(result.chunks[0].segments[1]).not.toHaveProperty("identity");
    expect(result.chunks[0].speakerMap.speaker_0).toMatch(/^unknown_/);
    expect(JSON.stringify(result.audit)).not.toContain(sensitiveText);
    expect(JSON.stringify(result.audit)).not.toContain(sensitiveFeature);
    expect(result.audit).toMatchObject({
      chunksProcessed: 1,
      localSpeakerGroups: 1,
      globalSpeakers: 1,
      matched: 0,
      unknown: 1,
      conflicts: 0
    });
  });
});
