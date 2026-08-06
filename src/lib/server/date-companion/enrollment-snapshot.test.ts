import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildTranscriptChunkId, type TranscriptChunk } from "@/lib/domain/chunks";
import { dateCompanionParticipantKey } from "@/lib/domain/date-companion-speaker";
import type { TranscriptSegment } from "@/lib/domain/types";
import { speakerIdentityCandidateKey } from "@/lib/server/speaker-identity/matching";
import type { IdentityResolverAudit } from "@/lib/server/speaker-identity/identity-resolver";
import { JsonStore } from "@/lib/server/storage/json-store";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";
import { buildChunkSegmentId } from "@/lib/server/transcription/chunks/transcript-merge";

import { buildDateCompanionVoiceEnrollmentSnapshots } from "./enrollment-snapshot";

const roots: string[] = [];
const uploadId = "upload_voice_enrollment";
const timestamp = "2026-08-05T06:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function segment(id: string): TranscriptSegment {
  return {
    id,
    uploadId,
    startSeconds: 0,
    endSeconds: 2,
    speaker: "speaker_1",
    text: "provider text must not enter the snapshot",
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function checkpoint(): TranscriptChunk {
  return {
    id: buildTranscriptChunkId(uploadId, 0),
    uploadId,
    audioChunkId: "provider_record_123",
    index: 0,
    startSeconds: 0,
    endSeconds: 10,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: { speaker_1: "speaker_1" },
    segments: [segment("provider_local_segment_id")],
    status: "completed",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: {}
  };
}

function audit(chunk: TranscriptChunk): IdentityResolverAudit {
  const candidateKey = speakerIdentityCandidateKey(chunk.id, "speaker_1");
  return {
    version: 1,
    uploadId,
    generatedAt: timestamp,
    chunksProcessed: 1,
    localSpeakerGroups: 1,
    globalSpeakers: 1,
    matched: 0,
    unknown: 1,
    averageConfidence: null,
    conflicts: 0,
    assignments: [],
    comparisons: [],
    structuralGate: {
      status: "healthy",
      reasons: [],
      chunks: [{
        chunkId: chunk.id,
        requestedSpeakerCount: 1,
        speakerResultItemCount: 1,
        distinctLabelCount: 1,
        labelCoverage: 1,
        dominantLabelRatio: 1,
        knownLabelRatio: 0,
        unknownLabelRatio: 1,
        status: "healthy",
        reasons: []
      }]
    },
    evidenceAvailability: { manualMapping: "unknown", voiceprint: "available" },
    resolutionStates: [{
      candidateKey,
      chunkId: chunk.id,
      localSpeaker: "speaker_1",
      globalSpeakerId: "unknown_local",
      ownerIdentityId: null,
      confidence: null,
      status: "unknown",
      source: "fallback",
      providerLabel: null,
      evidence: null,
      reason: "no_matching_evidence"
    }]
  };
}

describe("Date Companion voice enrollment snapshot", () => {
  it("maps provider-local ids through the canonical merged id and stores provenance only", async () => {
    const root = await mkdtemp(join(tmpdir(), "dc-enrollment-snapshot-"));
    roots.push(root);
    const store = new JsonStore(root);
    const rawChunk = checkpoint();
    await new JsonChunkCheckpointStore(store).saveTranscriptChunk(rawChunk);
    await store.write("speaker-identities", uploadId, audit(rawChunk));
    const merged = segment(buildChunkSegmentId(uploadId, 0, 0));
    const speakerId = dateCompanionParticipantKey(merged)!;

    const snapshots = await buildDateCompanionVoiceEnrollmentSnapshots({
      store,
      uploadId,
      segments: [merged],
      participantPlan: {
        participants: [{ speakerId }],
        reviewSpeakerIdBySpeakerId: new Map([[speakerId, speakerId]])
      },
      now: () => timestamp
    });

    expect(snapshots).toEqual([expect.objectContaining({
      reviewGroupId: speakerId,
      speakerIds: [speakerId],
      providerRecordId: "provider_record_123",
      chunkId: rawChunk.id,
      localSpeaker: "speaker_1",
      auditStatus: "unknown",
      auditDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      expiresAt: "2026-08-06T06:00:00.000Z"
    })]);
    expect(JSON.stringify(snapshots)).not.toContain("provider text");
    expect(JSON.stringify(snapshots)).not.toContain("audio");
  });

  it("fails closed unless the chunk gate, unique resolution, and canonical segment all exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "dc-enrollment-snapshot-gates-"));
    roots.push(root);
    const store = new JsonStore(root);
    const rawChunk = checkpoint();
    await new JsonChunkCheckpointStore(store).saveTranscriptChunk(rawChunk);
    const merged = segment(buildChunkSegmentId(uploadId, 0, 0));
    const speakerId = dateCompanionParticipantKey(merged)!;
    const participantPlan = {
      participants: [{ speakerId }],
      reviewSpeakerIdBySpeakerId: new Map([[speakerId, speakerId]])
    };

    await store.write("speaker-identities", uploadId, audit(rawChunk));
    await expect(buildDateCompanionVoiceEnrollmentSnapshots({
      store, uploadId, segments: [], participantPlan
    })).resolves.toEqual([]);

    const duplicateAudit = audit(rawChunk);
    duplicateAudit.resolutionStates.push({ ...duplicateAudit.resolutionStates[0] });
    await store.write("speaker-identities", uploadId, duplicateAudit);
    await expect(buildDateCompanionVoiceEnrollmentSnapshots({
      store, uploadId, segments: [merged], participantPlan
    })).resolves.toEqual([]);

    const blockedAudit = audit(rawChunk);
    blockedAudit.structuralGate.chunks[0].status = "blocked";
    await store.write("speaker-identities", uploadId, blockedAudit);
    await expect(buildDateCompanionVoiceEnrollmentSnapshots({
      store, uploadId, segments: [merged], participantPlan
    })).resolves.toEqual([]);
  });
});
