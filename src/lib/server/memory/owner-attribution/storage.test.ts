import { describe, expect, it } from "vitest";
import {
  aggregateMemoryOwnerObservations,
  createPersistedMemoryOwnerObservation,
  filterMemoryOwnerMetadataByEvidence,
  memoryOwnerMergeCompatible,
  rekeyMemoryOwnerObservations
} from "./storage";
import type { MemoryOwnerResolution } from "./types";

function resolution(input: {
  memoryId: string;
  identityId?: string;
  scope?: "individual" | "shared" | "unknown";
}): MemoryOwnerResolution {
  const owner = input.identityId
    ? { type: "known_identity" as const, identityId: input.identityId, confidence: 0.95, source: "explicit_statement" as const }
    : { type: "unknown" as const, confidence: 0, source: "unknown" as const };
  return {
    version: 1,
    memoryId: input.memoryId,
    memoryType: "preference",
    scope: input.scope ?? (input.identityId ? "individual" : "unknown"),
    owner,
    participants: input.identityId ? [{
      role: "owner",
      attribution: owner,
      evidenceSegmentIds: [`${input.memoryId}_segment`]
    }] : [],
    evidenceSegmentIds: [`${input.memoryId}_segment`],
    observations: [],
    reasons: [input.identityId ? "explicit_owner" : "no_trusted_identity"]
  };
}

describe("memory owner attribution storage helpers", () => {
  it("persists only owner evidence that survived Evidence First validation", () => {
    const value = resolution({ memoryId: "memory_a", identityId: "person_a" });
    const dropped = createPersistedMemoryOwnerObservation({
      uploadId: "upload_1",
      resolution: value,
      allowedEvidenceSegmentIds: new Set(["different_segment"]),
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    expect(dropped).toBeNull();
  });

  it("aggregates repeated observations for the same owner and can rekey a merge", () => {
    const first = createPersistedMemoryOwnerObservation({
      uploadId: "upload_1",
      resolution: resolution({ memoryId: "memory_a", identityId: "person_a" }),
      allowedEvidenceSegmentIds: new Set(["memory_a_segment"]),
      createdAt: "2026-07-20T00:00:00.000Z"
    })!;
    const second = createPersistedMemoryOwnerObservation({
      uploadId: "upload_2",
      resolution: resolution({ memoryId: "memory_b", identityId: "person_a" }),
      allowedEvidenceSegmentIds: new Set(["memory_b_segment"]),
      createdAt: "2026-07-21T00:00:00.000Z"
    })!;
    const observations = [first, ...rekeyMemoryOwnerObservations([second], "memory_a")];
    const metadata = aggregateMemoryOwnerObservations({
      memoryId: "memory_a",
      memoryType: "preference",
      observations
    });

    expect(metadata).toMatchObject({
      memoryId: "memory_a",
      scope: "individual",
      owner: { type: "known_identity", identityId: "person_a" }
    });
    expect(metadata?.evidenceSegmentIds).toEqual(["memory_a_segment", "memory_b_segment"]);
  });

  it("allows owner-aware preference merges only for the same resolved identity", () => {
    const knownA = {
      ...resolution({ memoryId: "memory_a", identityId: "person_a" }),
      observations: undefined
    };
    const knownB = {
      ...resolution({ memoryId: "memory_b", identityId: "person_b" }),
      observations: undefined
    };
    const unknown = {
      ...resolution({ memoryId: "memory_unknown" }),
      observations: undefined
    };

    expect(memoryOwnerMergeCompatible("preference", knownA, { ...knownA, memoryId: "repeat" })).toBe(true);
    expect(memoryOwnerMergeCompatible("preference", knownA, knownB)).toBe(false);
    expect(memoryOwnerMergeCompatible("preference", knownA, unknown)).toBe(false);
    expect(memoryOwnerMergeCompatible("event", knownA, knownB)).toBe(false);
  });

  it("requires the same known participant set before merging events", () => {
    const eventMetadata = (memoryId: string, identityIds: string[]) => ({
      version: 1 as const,
      memoryId,
      memoryType: "event" as const,
      scope: "shared" as const,
      owner: { type: "unknown" as const, confidence: 0, source: "unknown" as const },
      participants: identityIds.map((identityId) => ({
        role: "participant" as const,
        attribution: {
          type: "known_identity" as const,
          identityId,
          confidence: 0.95,
          source: "speaker_identity" as const
        },
        evidenceSegmentIds: [`${memoryId}_${identityId}`]
      })),
      evidenceSegmentIds: identityIds.map((identityId) => `${memoryId}_${identityId}`),
      reasons: ["shared_context" as const]
    });
    const first = eventMetadata("event_a", ["person_a", "person_b"]);

    expect(memoryOwnerMergeCompatible(
      "event",
      first,
      eventMetadata("event_repeat", ["person_b", "person_a"])
    )).toBe(true);
    expect(memoryOwnerMergeCompatible(
      "event",
      first,
      eventMetadata("event_other", ["person_a", "person_c"])
    )).toBe(false);
  });

  it("filters participants and owner support to selected evidence", () => {
    const metadata = {
      version: 1 as const,
      memoryId: "memory_scoped",
      memoryType: "event" as const,
      scope: "shared" as const,
      owner: { type: "unknown" as const, confidence: 0, source: "unknown" as const },
      participants: ["person_current", "person_old"].map((identityId) => ({
        role: "participant" as const,
        attribution: {
          type: "known_identity" as const,
          identityId,
          confidence: 0.95,
          source: "speaker_identity" as const
        },
        evidenceSegmentIds: [identityId === "person_current" ? "segment_current" : "segment_old"]
      })),
      evidenceSegmentIds: ["segment_current", "segment_old"],
      reasons: ["shared_context" as const]
    };

    expect(filterMemoryOwnerMetadataByEvidence(metadata, new Set(["segment_current"])))
      .toMatchObject({
        evidenceSegmentIds: ["segment_current"],
        participants: [{ attribution: { identityId: "person_current" } }]
      });
  });
});
