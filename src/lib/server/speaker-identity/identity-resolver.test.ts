import { describe, expect, it } from "vitest";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";
import { resolveMemoryOwnerAttribution } from "@/lib/server/memory/owner-attribution/resolver";

import {
  CompositeIdentityResolver,
  ManualMappingResolver,
  VoiceprintResolver
} from "./identity-resolver";
import { VoiceprintProviderError } from "./voiceprint-client";

const timestamp = "2026-07-28T00:00:00.000Z";

function segment(input: {
  id: string;
  speaker: string;
  startSeconds: number;
}): TranscriptSegment {
  return {
    id: input.id,
    uploadId: "upload_identity_interface",
    startSeconds: input.startSeconds,
    endSeconds: input.startSeconds + 2,
    speaker: input.speaker,
    text: `statement ${input.id}`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function chunk(segments: TranscriptSegment[]): TranscriptChunk {
  return {
    id: "upload_identity_interface_transcript_chunk_00000",
    uploadId: "upload_identity_interface",
    audioChunkId: "upload_identity_interface_audio_chunk_00000",
    index: 0,
    startSeconds: 0,
    endSeconds: 300,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries(
      segments.map((item) => [item.speaker!, item.speaker!])
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

describe("IdentityResolver interface", () => {
  it("does not auto-verify even when the structural gate is healthy", async () => {
    const transcriptChunk = {
      ...chunk([
        segment({ id: "segment_self", speaker: "我", startSeconds: 1 }),
        segment({ id: "segment_alice", speaker: "Alice", startSeconds: 4 }),
        segment({ id: "segment_bob", speaker: "Bob", startSeconds: 7 })
      ]),
      metadata: {
        requestedSpeakerCount: 3,
        speakerResultItemCount: 3
      }
    };
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => []
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () =>
          ["我", "Alice", "Bob"].map((localSpeaker, index) => ({
            identityStatus: "verified" as const,
            chunkId: transcriptChunk.id,
            localSpeaker,
            globalSpeakerId: `identity_${index}`,
            identityType: index === 0 ? "known_user" as const : "known_contact" as const,
            evidence: {
              type: "provider_label" as const,
              provider: "company_voiceprint" as const,
              providerLabel: localSpeaker
            }
          }))
      })
    });

    const result = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(result.audit.structuralGate).toMatchObject({
      status: "healthy",
      chunks: [expect.objectContaining({
        requestedSpeakerCount: 3,
        distinctLabelCount: 3,
        knownLabelRatio: 1
      })]
    });
    expect(result.resolutions).toHaveLength(3);
    expect(result.resolutions.every((resolution) =>
      resolution.status === "pending" && resolution.ownerIdentityId === null
    )).toBe(true);
  });

  it("blocks structurally missing speaker_result without throwing", async () => {
    const transcriptChunk = {
      ...chunk([segment({ id: "segment_missing_result", speaker: "speaker_1", startSeconds: 1 })]),
      metadata: {
        requestedSpeakerCount: 2,
        speakerResultItemCount: 0
      }
    };
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => []
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () => []
      })
    });

    const result = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(result.audit.structuralGate).toMatchObject({
      status: "blocked",
      reasons: expect.arrayContaining(["speaker_result_missing"])
    });
    expect(result.resolutions[0]).toMatchObject({
      status: "unknown",
      ownerIdentityId: null
    });
  });

  it("keeps a Provider label pending until a Memory owner review", async () => {
    const transcriptChunk = chunk([
      segment({ id: "segment_verified", speaker: "我", startSeconds: 1 })
    ]);
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => []
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () => [{
          identityStatus: "verified",
          chunkId: transcriptChunk.id,
          localSpeaker: "我",
          globalSpeakerId: "user_a",
          identityType: "known_user",
          evidence: {
            type: "provider_label",
            provider: "company_voiceprint",
            providerLabel: "我"
          }
        }]
      })
    });

    const result = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(result.resolutions).toEqual([
      expect.objectContaining({
        localSpeaker: "我",
        globalSpeakerId: expect.stringMatching(/^unknown_/),
        ownerIdentityId: null,
        confidence: null,
        status: "pending",
        source: "provider_speaker_result",
        providerLabel: "我",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "我"
        }
      })
    ]);
    const owner = resolveMemoryOwnerAttribution({
      memoryId: "memory_verified",
      memoryType: "preference",
      evidenceSegments: result.chunks[0].segments
    });
    expect(owner.owner).toEqual({
      type: "unknown",
      confidence: 0,
      source: "unknown"
    });
  });

  it("keeps an exact saved-contact Provider label pending without an owner", async () => {
    const transcriptChunk = chunk([
      segment({ id: "segment_contact", speaker: "Alice", startSeconds: 1 })
    ]);
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => []
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () => [{
          identityStatus: "verified",
          chunkId: transcriptChunk.id,
          localSpeaker: "Alice",
          globalSpeakerId: "contact_alice",
          displayName: "Alice",
          identityType: "known_contact",
          evidence: {
            type: "provider_label",
            provider: "company_voiceprint",
            providerLabel: "Alice"
          }
        }]
      })
    });

    const result = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(result.resolutions[0]).toMatchObject({
      localSpeaker: "Alice",
      ownerIdentityId: null,
      confidence: null,
      status: "pending",
      source: "provider_speaker_result",
      providerLabel: "Alice"
    });
  });

  it("marks contradictory Provider-label identities as conflict without an owner", async () => {
    const transcriptChunk = chunk([
      segment({ id: "segment_conflict", speaker: "Alice", startSeconds: 1 })
    ]);
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => []
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () => [{
          identityStatus: "conflict",
          chunkId: transcriptChunk.id,
          localSpeaker: "Alice",
          conflictingGlobalSpeakerIds: ["contact_alice", "contact_bob"],
          evidence: {
            type: "provider_label",
            provider: "company_voiceprint",
            providerLabel: "Alice"
          }
        }]
      })
    });

    const result = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(result.resolutions[0]).toMatchObject({
      localSpeaker: "Alice",
      ownerIdentityId: null,
      confidence: 0,
      status: "conflict",
      source: "provider_speaker_result",
      providerLabel: "Alice",
      evidence: {
        type: "provider_label",
        provider: "company_voiceprint",
        providerLabel: "Alice"
      },
      reason: "ambiguous_match"
    });
  });

  it("fails closed to unknown when Voiceprint evidence loading fails", async () => {
    const transcriptChunk = chunk([
      segment({ id: "segment_failure", speaker: "speaker_1", startSeconds: 1 })
    ]);
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => []
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () => {
          throw new Error("provider unavailable");
        }
      })
    });

    const result = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(result.evidenceAvailability.voiceprint).toBe("unknown");
    expect(result.resolutions[0]).toMatchObject({
      localSpeaker: "speaker_1",
      ownerIdentityId: null,
      confidence: 0,
      status: "unknown",
      source: "fallback"
    });
    expect(result.chunks[0].segments[0].identity).toMatchObject({
      identityType: "unknown_person",
      confidence: 0
    });
  });

  it("keeps a manual mapping unverified until Voiceprint supplies trusted evidence", async () => {
    const transcriptChunk = chunk([
      segment({ id: "segment_manual", speaker: "speaker_1", startSeconds: 1 })
    ]);
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => [{
          chunkId: transcriptChunk.id,
          localSpeaker: "speaker_1",
          globalSpeakerId: "contact_a",
          displayName: "Contact A",
          identityType: "known_contact",
          confidence: 1
        }]
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () => []
      })
    });

    const result = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(result.resolutions[0]).toMatchObject({
      globalSpeakerId: "contact_a",
      ownerIdentityId: null,
      status: "pending",
      source: "manual_mapping"
    });
    const owner = resolveMemoryOwnerAttribution({
      memoryId: "memory_manual",
      memoryType: "preference",
      evidenceSegments: result.chunks[0].segments
    });
    expect(owner.owner).toEqual({
      type: "unknown",
      confidence: 0,
      source: "unknown"
    });
  });

  it("returns pending without crashing when the Voiceprint Provider times out", async () => {
    const transcriptChunk = chunk([
      segment({ id: "segment_timeout", speaker: "speaker_1", startSeconds: 1 })
    ]);
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => []
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () => {
          throw new VoiceprintProviderError(
            "timeout",
            "voiceprint provider request timed out"
          );
        }
      })
    });

    const result = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(result.evidenceAvailability.voiceprint).toBe("pending");
    expect(result.resolutions[0]).toMatchObject({
      localSpeaker: "speaker_1",
      ownerIdentityId: null,
      status: "pending",
      source: "fallback"
    });
    expect(result.chunks[0].segments[0].identity).toMatchObject({
      identityType: "unknown_person",
      confidence: 0
    });
  });

  it("keeps multiple speaker ids deterministic without manufacturing owners", async () => {
    const transcriptChunk = chunk([
      segment({ id: "segment_a", speaker: "speaker_1", startSeconds: 1 }),
      segment({ id: "segment_b", speaker: "speaker_2", startSeconds: 4 })
    ]);
    const identityResolver = new CompositeIdentityResolver({
      manualMappingResolver: new ManualMappingResolver({
        loadDirectMappings: async () => []
      }),
      voiceprintResolver: new VoiceprintResolver({
        loadVoiceprintHints: async () => []
      })
    });

    const first = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });
    const second = await identityResolver.resolve({
      uploadId: transcriptChunk.uploadId,
      chunks: [transcriptChunk]
    });

    expect(first.resolutions.map((item) => item.localSpeaker)).toEqual([
      "speaker_1",
      "speaker_2"
    ]);
    expect(first.resolutions.map((item) => item.globalSpeakerId)).toEqual(
      second.resolutions.map((item) => item.globalSpeakerId)
    );
    expect(new Set(first.resolutions.map((item) => item.globalSpeakerId)).size).toBe(2);
    expect(first.resolutions.every((item) =>
      item.status === "unknown" &&
      item.ownerIdentityId === null
    )).toBe(true);
  });
});
