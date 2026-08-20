import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import { JsonStore } from "@/lib/server/storage/json-store";
import { JsonSpeakerIdentityRepository } from "./repository";
import { resolveSpeakerIdentities } from "./resolver";
import { InMemoryVoiceprintProvider } from "./voiceprint-client";
import { JsonVoiceprintOperationRepository } from "./voiceprint-operation-repository";
import { VoiceprintService } from "./voiceprint-service";

const timestamp = "2026-07-24T00:00:00.000Z";

function diarizedChunk(
  uploadId: string,
  chunkId: string,
  localSpeakers: string[]
): TranscriptChunk {
  return {
    id: chunkId,
    uploadId,
    audioChunkId: `${chunkId}_audio`,
    index: 0,
    startSeconds: 0,
    endSeconds: 300,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries(
      localSpeakers.map((speaker) => [speaker, speaker])
    ),
    segments: localSpeakers.map((speaker, index) => ({
      id: `${chunkId}_segment_${index}`,
      uploadId,
      startSeconds: index,
      endSeconds: index + 0.5,
      speaker,
      text: `utterance ${index}`,
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    })),
    status: "completed",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: { provider: "speaker-asr" }
  };
}

describe("voiceprint cross-recording continuity integration", () => {
  let rootDir: string;
  let store: JsonStore;
  let repository: JsonSpeakerIdentityRepository;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "voiceprint-continuity-"));
    store = new JsonStore(rootDir);
    repository = new JsonSpeakerIdentityRepository(store, () => timestamp);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("keeps a saved-contact Provider label pending until Memory owner review", async () => {
    const provider = new InMemoryVoiceprintProvider();
    const service = new VoiceprintService(
      provider,
      repository,
      new JsonVoiceprintOperationRepository(store, () => timestamp)
    );
    const recordingA = diarizedChunk(
      "upload_a",
      "upload_a_transcript_chunk_00000",
      ["speaker_1"]
    );

    await service.saveContact({
      userId: "user_1",
      requestId: "save_alice_from_upload_a",
      recordId: recordingA.audioChunkId,
      uploadId: recordingA.uploadId,
      chunkId: recordingA.id,
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    });

    const recordingB = diarizedChunk(
      "upload_b",
      "upload_b_transcript_chunk_00000",
      ["Alice"]
    );
    const [voiceprintHints, recordingBMappings] = await Promise.all([
      repository.loadVoiceprintHints([recordingB]),
      repository.loadDirectMappings(recordingB.uploadId)
    ]);
    const resolved = await resolveSpeakerIdentities({
      uploadId: recordingB.uploadId,
      chunks: [recordingB],
      manualMappings: recordingBMappings,
      voiceprintHints
    });

    expect(provider.saveCalls).toHaveLength(1);
    expect(recordingBMappings).toEqual([]);
    expect(voiceprintHints).toEqual([{
      identityStatus: "verified",
      chunkId: recordingB.id,
      localSpeaker: "Alice",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      identityType: "known_contact",
      evidence: {
        type: "provider_label",
        provider: "company_voiceprint",
        providerLabel: "Alice"
      }
    }]);
    expect(resolved.chunks[0].segments[0]).toMatchObject({
      speaker: "Alice",
      identity: {
        globalSpeakerId: expect.stringMatching(/^unknown_/),
        identityType: "unknown_person",
        source: "provider_speaker_result",
        confidence: null,
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      }
    });
    await expect(repository.getManualMapping({
      uploadId: recordingB.uploadId,
      chunkId: recordingB.id,
      localSpeaker: "Alice"
    })).resolves.toBeNull();
  });

  it("fails closed when a provider label maps to multiple stored contacts", async () => {
    await repository.saveProfile({
      globalSpeakerId: "contact_a",
      displayName: "Contact A",
      identityType: "known_contact",
      voiceprintSpeakerId: "Shared"
    });
    await repository.saveProfile({
      globalSpeakerId: "contact_b",
      displayName: "Contact B",
      identityType: "known_contact",
      voiceprintSpeakerId: "Shared"
    });
    const recordingB = diarizedChunk(
      "upload_b",
      "upload_b_transcript_chunk_00000",
      ["Shared"]
    );

    const voiceprintHints = await repository.loadVoiceprintHints([recordingB]);
    const resolved = await resolveSpeakerIdentities({
      uploadId: recordingB.uploadId,
      chunks: [recordingB],
      voiceprintHints
    });

    expect(voiceprintHints).toEqual([{
      identityStatus: "conflict",
      chunkId: recordingB.id,
      localSpeaker: "Shared",
      conflictingGlobalSpeakerIds: ["contact_a", "contact_b"],
      evidence: {
        type: "provider_label",
        provider: "company_voiceprint",
        providerLabel: "Shared"
      }
    }]);
    expect(resolved.assignments).toHaveLength(1);
    expect(resolved.assignments[0]).toMatchObject({
      matched: false,
      reason: "ambiguous_match",
      identity: {
        identityType: "unknown_person",
        confidence: 0
      }
    });
    expect(resolved.chunks[0].segments[0].identity).toMatchObject({
      identityType: "unknown_person",
      confidence: 0
    });
  });
});
