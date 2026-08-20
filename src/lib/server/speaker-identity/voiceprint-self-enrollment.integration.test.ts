import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import type { AudioUpload } from "@/lib/domain/types";
import type { MemoryWriteInput } from "@/lib/server/memory/types";
import { evaluateMemoryAdmission } from "@/lib/server/memory/admission";
import { resolveMemoryOwnerAttribution } from "@/lib/server/memory/owner-attribution/resolver";
import { JsonStore } from "@/lib/server/storage/json-store";

import { JsonSpeakerIdentityRepository } from "./repository";
import { resolveSpeakerIdentities } from "./resolver";
import { InMemoryVoiceprintProvider } from "./voiceprint-client";
import { JsonVoiceprintOperationRepository } from "./voiceprint-operation-repository";
import {
  createVoiceprintSelfEnrollment,
  processVoiceprintSelfEnrollment
} from "./voiceprint-self-enrollment";
import { VoiceprintService } from "./voiceprint-service";
import {
  VoiceprintTrainingCandidateRepository,
  VoiceprintTrainingCandidateSchema
} from "./voiceprint-training-candidates";

const timestamp = "2026-07-29T00:00:00.000Z";
let tempDir: string;
let originalBaseUrl: string | undefined;
let originalToken: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "voiceprint-self-enrollment-integration-"));
  originalBaseUrl = process.env.SPEAKER_ASR_AUDIO_BASE_URL;
  originalToken = process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN;
  process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://audio.example.test";
  process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "secret";
});

afterEach(async () => {
  if (originalBaseUrl === undefined) delete process.env.SPEAKER_ASR_AUDIO_BASE_URL;
  else process.env.SPEAKER_ASR_AUDIO_BASE_URL = originalBaseUrl;
  if (originalToken === undefined) delete process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN;
  else process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = originalToken;
  await rm(tempDir, { recursive: true, force: true });
});

function chunk(uploadId: string, speaker: string): TranscriptChunk {
  return {
    id: `${uploadId}_transcript_chunk_00000`,
    uploadId,
    audioChunkId: `${uploadId}_audio_chunk_00000`,
    index: 0,
    startSeconds: 0,
    endSeconds: 40,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: { [speaker]: speaker },
    segments: [{
      id: `${uploadId}_chunk_00000_seg_00001`,
      uploadId,
      startSeconds: 0,
      endSeconds: 35,
      speaker,
      text: "Project launch needs legal review before release",
      confidence: 0.9,
      sceneLabels: ["unknown"],
      valueLabels: []
    }],
    status: "completed",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: {}
  };
}

function memory(uploadId: string): MemoryWriteInput {
  return {
    id: `memory_${uploadId}`,
    type: "summary",
    title: "Project launch constraint",
    summary: "Project launch needs legal review before release",
    importance: 0.7,
    date: "2026-07-29",
    createdAt: timestamp,
    updatedAt: timestamp,
    evidence: [{
      id: `evidence_${uploadId}`,
      sourceType: "transcript",
      sourceId: `${uploadId}_chunk_00000_seg_00001`,
      uploadId,
      date: "2026-07-29",
      quote: "Project launch needs legal review before release",
      createdAt: timestamp
    }]
  };
}

describe("self enrollment continuity into Memory", () => {
  it("keeps both recordings unowned until a future Memory owner review", async () => {
    const store = new JsonStore(join(tempDir, "store"));
    const uploadsRootDir = join(tempDir, "uploads");
    const candidateId = "candidate_recording_a";
    const candidatePath = join(
      uploadsRootDir,
      "voiceprint-training",
      "upload_a",
      `${candidateId}.mp3`
    );
    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, "mp3");
    const parentUpload: AudioUpload = {
      id: "upload_a",
      originalName: "recording-a.wav",
      mimeType: "audio/wav",
      sizeBytes: 10,
      recordingDate: "2026-07-29",
      status: "ready",
      durationSeconds: 40
    };
    await store.write("uploads", parentUpload.id, parentUpload);
    await new VoiceprintTrainingCandidateRepository(store).save(
      VoiceprintTrainingCandidateSchema.parse({
        version: 1,
        candidateId,
        uploadId: "upload_a",
        candidateKey: "upload_a_transcript_chunk_00000::speaker_1",
        chunkId: "upload_a_transcript_chunk_00000",
        chunkIndex: 0,
        localSpeaker: "speaker_1",
        segmentIds: ["upload_a_chunk_00000_seg_00001"],
        sourceRanges: [{ startMilliseconds: 100, endMilliseconds: 34_900 }],
        durationMilliseconds: 34_800,
        audioFilePath: candidatePath,
        identityState: "unknown",
        status: "available",
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: "2099-08-05T00:00:00.000Z"
      })
    );
    const profiles = new JsonSpeakerIdentityRepository(store, () => timestamp);
    const providerOperations = new JsonVoiceprintOperationRepository(
      store,
      () => timestamp
    );
    const provider = new InMemoryVoiceprintProvider();
    const service = new VoiceprintService(
      provider,
      profiles,
      providerOperations
    );
    const recordingA = chunk("upload_a", "speaker_1");
    const beforeHints = await profiles.loadVoiceprintHints([recordingA]);
    const before = await resolveSpeakerIdentities({
      uploadId: recordingA.uploadId,
      chunks: [recordingA],
      voiceprintHints: beforeHints
    });
    const created = await createVoiceprintSelfEnrollment({
      store,
      userId: "user_1",
      uploadsRootDir,
      requestId: "enroll_recording_a",
      candidateId
    });
    await processVoiceprintSelfEnrollment({
      store,
      userId: "user_1",
      uploadsRootDir,
      operationId: created.operation.operationId,
      createService: () => service
    });

    const afterHints = await profiles.loadVoiceprintHints([recordingA]);
    const after = await resolveSpeakerIdentities({
      uploadId: recordingA.uploadId,
      chunks: [recordingA],
      voiceprintHints: afterHints
    });
    const recordingB = chunk("upload_b", "我");
    const futureHints = await profiles.loadVoiceprintHints([recordingB]);
    const future = await resolveSpeakerIdentities({
      uploadId: recordingB.uploadId,
      chunks: [recordingB],
      voiceprintHints: futureHints
    });
    const recordingAOwner = resolveMemoryOwnerAttribution({
      memoryId: "memory_upload_a",
      memoryType: "summary",
      evidenceSegments: after.chunks[0].segments
    });
    const recordingBOwner = resolveMemoryOwnerAttribution({
      memoryId: "memory_upload_b",
      memoryType: "summary",
      evidenceSegments: future.chunks[0].segments
    });

    expect(provider.trainCalls).toHaveLength(1);
    expect(beforeHints).toEqual([]);
    expect(afterHints).toEqual([]);
    expect(before.assignments[0].identity.identityType).toBe("unknown_person");
    expect(after.assignments[0].identity.identityType).toBe("unknown_person");
    expect(recordingAOwner.owner.type).toBe("unknown");
    expect(evaluateMemoryAdmission({
      memory: memory("upload_a"),
      ownerAttribution: recordingAOwner
    })).toMatchObject({
      shouldPersist: false,
      memoryTier: "daily_only"
    });

    expect(futureHints).toEqual([
      expect.objectContaining({
        identityStatus: "verified",
        localSpeaker: "我",
        identityType: "known_user",
        evidence: expect.objectContaining({
          type: "provider_label",
          providerLabel: "我"
        })
      })
    ]);
    expect(future.chunks[0].segments[0].identity).toMatchObject({
      identityType: "unknown_person",
      source: "provider_speaker_result",
      confidence: null
    });
    expect(recordingBOwner).toMatchObject({
      scope: "unknown",
      owner: { type: "unknown" },
      participants: []
    });
    expect(evaluateMemoryAdmission({
      memory: memory("upload_b"),
      ownerAttribution: recordingBOwner
    })).toMatchObject({
      shouldPersist: false,
      memoryTier: "daily_only"
    });
  });
});
