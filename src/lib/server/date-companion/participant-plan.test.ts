import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";
import type { IdentityResolverAudit } from "@/lib/server/speaker-identity/identity-resolver";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";
import { JsonStore } from "@/lib/server/storage/json-store";

import { buildDateCompanionParticipantPlan } from "./participant-plan";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pendingProviderSegment(chunkIndex: number): TranscriptSegment {
  const chunk = chunkIndex.toString().padStart(5, "0");
  return {
    id: `upload_1_chunk_${chunk}_seg_00001`,
    uploadId: "upload_1",
    startSeconds: chunkIndex * 60,
    endSeconds: chunkIndex * 60 + 4,
    speaker: "partner_voice",
    identity: {
      globalSpeakerId: `unknown_chunk_${chunk}`,
      identityType: "unknown_person",
      confidence: null,
      source: "provider_speaker_result",
      evidence: {
        type: "provider_label",
        provider: "company_voiceprint",
        providerLabel: "partner_voice"
      }
    },
    text: `chunk ${chunkIndex}`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function auditFor(segments: TranscriptSegment[]): IdentityResolverAudit {
  return {
    version: 1,
    uploadId: "upload_1",
    generatedAt: "2026-08-05T00:00:00.000Z",
    chunksProcessed: segments.length,
    localSpeakerGroups: segments.length,
    globalSpeakers: segments.length,
    matched: 0,
    unknown: segments.length,
    averageConfidence: null,
    conflicts: 0,
    assignments: [],
    comparisons: [],
    structuralGate: { status: "healthy", reasons: [], chunks: [] },
    evidenceAvailability: { manualMapping: "unknown", voiceprint: "available" },
    resolutionStates: segments.map((segment, index) => ({
      candidateKey: `chunk_${index}::partner_voice`,
      chunkId: `chunk_${index}`,
      localSpeaker: "partner_voice",
      globalSpeakerId: segment.identity!.globalSpeakerId,
      ownerIdentityId: null,
      confidence: null,
      status: "pending",
      source: "provider_speaker_result",
      providerLabel: "partner_voice",
      evidence: {
        type: "provider_label",
        provider: "company_voiceprint",
        providerLabel: "partner_voice"
      },
      reason: "provider_label_review_required"
    }))
  };
}

describe("Date Companion participant plan", () => {
  it("keeps raw chunk candidates but uses one reviewed representative for audio", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-participant-plan-"));
    roots.push(root);
    const store = new JsonStore(root);
    const segments = [pendingProviderSegment(0), pendingProviderSegment(1)];
    await new JsonSpeakerIdentityRepository(store).saveProfile({
      globalSpeakerId: "contact_partner",
      userId: "user_1",
      contactName: "Ta",
      displayName: "Ta",
      identityType: "known_contact",
      status: "active",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: "partner_voice",
        lastRequestId: "save_1",
        operationType: "save"
      }
    });
    await store.write("speaker-identities", "upload_1", auditFor(segments));

    const plan = await buildDateCompanionParticipantPlan({
      store,
      uploadId: "upload_1",
      segments,
      userId: "user_1",
      options: { providerLabelContinuityEnabled: true }
    });

    expect(plan.participants).toHaveLength(2);
    expect(new Set(plan.participants.map((participant) => participant.continuityKey))).toEqual(
      new Set(["identity_contact_partner"])
    );
    const rawSpeakerIds = plan.participants.map((participant) => participant.speakerId);
    expect(new Set(rawSpeakerIds).size).toBe(2);
    expect(new Set(rawSpeakerIds.map(
      (speakerId) => plan.reviewSpeakerIdBySpeakerId.get(speakerId)
    )).size).toBe(1);
  });

  it("does not group chunk candidates when the continuity gate is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-participant-plan-off-"));
    roots.push(root);
    const store = new JsonStore(root);
    const segments = [pendingProviderSegment(0), pendingProviderSegment(1)];

    const plan = await buildDateCompanionParticipantPlan({
      store,
      uploadId: "upload_1",
      segments,
      userId: "user_1",
      options: { providerLabelContinuityEnabled: false }
    });

    expect(plan.participants).toHaveLength(2);
    expect(plan.participants.every((participant) => !participant.continuityKey)).toBe(true);
    expect(new Set(plan.reviewSpeakerIdBySpeakerId.values()).size).toBe(2);
  });

  it("rejects a raw participant when any of its segments lacks the same trusted match", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-participant-mixed-"));
    roots.push(root);
    const store = new JsonStore(root);
    await new JsonSpeakerIdentityRepository(store).saveProfile({
      globalSpeakerId: "contact_partner",
      userId: "user_1",
      contactName: "Ta",
      displayName: "Ta",
      identityType: "known_contact",
      status: "active",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: "partner_voice",
        lastRequestId: "save_1",
        operationType: "save"
      }
    });
    const valid = {
      ...pendingProviderSegment(0),
      id: "segment_a",
      identity: {
        ...pendingProviderSegment(0).identity!,
        globalSpeakerId: "unknown_shared"
      }
    };
    const invalid = {
      ...valid,
      id: "segment_b",
      identity: {
        ...valid.identity,
        evidence: {
          type: "provider_label" as const,
          provider: "company_voiceprint" as const,
          providerLabel: "different_voice"
        }
      }
    };
    await store.write("speaker-identities", "upload_1", auditFor([valid]));

    const plan = await buildDateCompanionParticipantPlan({
      store,
      uploadId: "upload_1",
      segments: [valid, invalid],
      userId: "user_1",
      options: { providerLabelContinuityEnabled: true }
    });

    expect(plan.participants).toEqual([{
      speakerId: "candidate_unknown_shared"
    }]);
  });
});
