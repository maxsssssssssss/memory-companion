import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import { JsonStore } from "@/lib/server/storage/json-store";
import { JsonSpeakerIdentityRepository } from "./repository";

const timestamp = "2026-07-24T00:00:00.000Z";

function transcriptChunk(id: string, localSpeakers: string[]): TranscriptChunk {
  return {
    id,
    uploadId: "upload_1",
    audioChunkId: `audio_${id}`,
    index: 0,
    startSeconds: 0,
    endSeconds: 300,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries(localSpeakers.map((speaker) => [speaker, speaker])),
    segments: localSpeakers.map((speaker, index) => ({
      id: `${id}_segment_${index}`,
      uploadId: "upload_1",
      startSeconds: index,
      endSeconds: index + 0.5,
      speaker,
      text: `text ${index}`,
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
    metadata: { provider: "test" }
  };
}

describe("JsonSpeakerIdentityRepository", () => {
  let rootDir: string;
  let store: JsonStore;
  let clock: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "speaker-identity-repository-"));
    store = new JsonStore(rootDir);
    clock = "2026-07-17T00:00:00.000Z";
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("persists profiles and reloads chunk-scoped manual mappings", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    await repository.saveProfile({
      globalSpeakerId: "person_partner",
      displayName: "Partner",
      identityType: "known_contact",
      voiceprintSpeakerId: "partner"
    });
    await repository.saveManualMapping({
      uploadId: "upload_1",
      chunkId: "upload_1_transcript_chunk_00001",
      localSpeaker: "speaker_0",
      globalSpeakerId: "person_partner"
    });

    const reloaded = new JsonSpeakerIdentityRepository(new JsonStore(rootDir));
    await expect(reloaded.getManualMapping({
      uploadId: "upload_1",
      chunkId: "upload_1_transcript_chunk_00001",
      localSpeaker: "speaker_0"
    })).resolves.toMatchObject({
      globalSpeakerId: "person_partner",
      source: "manual_mapping",
      confidence: 1
    });
    await expect(reloaded.loadDirectMappings("upload_1")).resolves.toEqual([{
      chunkId: "upload_1_transcript_chunk_00001",
      localSpeaker: "speaker_0",
      globalSpeakerId: "person_partner",
      displayName: "Partner",
      identityType: "known_contact",
      confidence: 1
    }]);
  });

  it("keeps the same local label in different chunks as separate mappings", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    for (const [globalSpeakerId, displayName] of [["person_a", "A"], ["person_b", "B"]] as const) {
      await repository.saveProfile({ globalSpeakerId, displayName, identityType: "known_contact" });
    }
    await repository.saveManualMapping({
      uploadId: "upload_1",
      chunkId: "chunk_0",
      localSpeaker: "speaker_0",
      globalSpeakerId: "person_a"
    });
    await repository.saveManualMapping({
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_0",
      globalSpeakerId: "person_b"
    });

    await expect(repository.listManualMappings("upload_1")).resolves.toEqual([
      expect.objectContaining({ chunkId: "chunk_0", globalSpeakerId: "person_a" }),
      expect.objectContaining({ chunkId: "chunk_1", globalSpeakerId: "person_b" })
    ]);
  });

  it("creates voiceprint hints only for an exact unambiguous provider identity", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    await repository.saveProfile({
      globalSpeakerId: "user_user_1",
      identityType: "known_user",
      voiceprintSpeakerId: "user_1"
    });
    await repository.saveProfile({
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      identityType: "known_contact",
      voiceprintSpeakerId: "Alice"
    });

    await expect(repository.loadVoiceprintHints([
      transcriptChunk("chunk_0", ["user_1", "speaker_1"]),
      transcriptChunk("chunk_1", ["Alice"])
    ])).resolves.toEqual([
      {
        chunkId: "chunk_0",
        localSpeaker: "user_1",
        globalSpeakerId: "user_user_1",
        identityType: "known_user",
        confidence: 0.9
      },
      {
        chunkId: "chunk_1",
        localSpeaker: "Alice",
        globalSpeakerId: "contact_alice",
        displayName: "Alice",
        identityType: "known_contact",
        confidence: 0.9
      }
    ]);
  });

  it("fails closed when legacy profiles share the same provider identity", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    await repository.saveProfile({
      globalSpeakerId: "contact_a",
      identityType: "known_contact",
      voiceprintSpeakerId: "Shared"
    });
    await repository.saveProfile({
      globalSpeakerId: "contact_b",
      identityType: "known_contact",
      voiceprintSpeakerId: "Shared"
    });

    await expect(repository.loadVoiceprintHints([
      transcriptChunk("chunk_0", ["Shared"])
    ])).resolves.toEqual([]);
  });

  it("preserves profile and mapping creation timestamps on update", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    const firstProfile = await repository.saveProfile({
      globalSpeakerId: "person_partner",
      displayName: "First",
      identityType: "known_contact"
    });
    const firstMapping = await repository.saveManualMapping({
      uploadId: "upload_1",
      chunkId: "chunk_0",
      localSpeaker: "speaker_1",
      globalSpeakerId: "person_partner"
    });

    clock = "2026-07-17T01:00:00.000Z";
    const updatedProfile = await repository.saveProfile({
      globalSpeakerId: "person_partner",
      displayName: "Updated",
      identityType: "known_contact"
    });
    const updatedMapping = await repository.saveManualMapping({
      uploadId: "upload_1",
      chunkId: "chunk_0",
      localSpeaker: "speaker_1",
      globalSpeakerId: "person_partner"
    });

    expect(updatedProfile.createdAt).toBe(firstProfile.createdAt);
    expect(updatedProfile.updatedAt).toBe(clock);
    expect(updatedMapping.createdAt).toBe(firstMapping.createdAt);
    expect(updatedMapping.updatedAt).toBe(clock);
  });

  it("rejects mappings for missing profiles and refuses raw voice material fields", async () => {
    const repository = new JsonSpeakerIdentityRepository(store);
    await expect(repository.saveManualMapping({
      uploadId: "upload_1",
      chunkId: "chunk_0",
      localSpeaker: "speaker_0",
      globalSpeakerId: "missing_person"
    })).rejects.toThrow("does not exist");

    await expect(repository.saveProfile({
      globalSpeakerId: "person_partner",
      identityType: "known_contact",
      embedding: [0.1, 0.2]
    } as never)).rejects.toThrow();
    await expect(repository.saveProfile({
      globalSpeakerId: "person_partner",
      identityType: "known_contact",
      audio: "raw-bytes"
    } as never)).rejects.toThrow();
  });

  it("stores only structural profile and mapping documents", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    await repository.saveProfile({
      globalSpeakerId: "person_partner",
      displayName: "Partner",
      identityType: "known_contact"
    });
    await repository.saveManualMapping({
      uploadId: "upload_1",
      chunkId: "chunk_0",
      localSpeaker: "speaker_0",
      globalSpeakerId: "person_partner"
    });

    const documents = await Promise.all(
      (await readdir(rootDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8"))
    );
    const stored = documents.join("\n");
    expect(stored).not.toContain("embedding");
    expect(stored).not.toContain("audioBytes");
    expect(stored).toContain("manual_mapping");
  });

  it("stores bounded provider reference metadata and ignores disabled profiles for hints", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    const profile = await repository.saveProfile({
      globalSpeakerId: "contact_alice",
      userId: "user_1",
      contactName: "Alice",
      displayName: "Alice",
      identityType: "known_contact",
      status: "disabled",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: "Alice",
        lastRequestId: "save_alice_1",
        operationType: "save"
      }
    });

    expect(profile).toMatchObject({
      userId: "user_1",
      contactName: "Alice",
      status: "disabled"
    });
    await expect(repository.loadVoiceprintHints([
      transcriptChunk("chunk_0", ["Alice"])
    ])).resolves.toEqual([]);
  });

  it("deletes mappings for one upload while retaining profiles and other uploads", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    await repository.saveProfile({
      globalSpeakerId: "person_partner",
      displayName: "Partner",
      identityType: "known_contact"
    });
    for (const uploadId of ["upload_1", "upload_2"]) {
      await repository.saveManualMapping({
        uploadId,
        chunkId: `${uploadId}_chunk_0`,
        localSpeaker: "speaker_0",
        globalSpeakerId: "person_partner"
      });
    }

    await expect(repository.deleteUploadMappings("upload_1")).resolves.toBe(1);
    await expect(repository.listManualMappings("upload_1")).resolves.toEqual([]);
    await expect(repository.listManualMappings("upload_2")).resolves.toHaveLength(1);
    await expect(repository.getProfile("person_partner")).resolves.toMatchObject({
      globalSpeakerId: "person_partner",
      displayName: "Partner"
    });
  });

  it("isolates a corrupt row that safely identifies a different upload", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    await repository.saveProfile({
      globalSpeakerId: "person_partner",
      identityType: "known_contact"
    });
    await repository.saveManualMapping({
      uploadId: "upload_target",
      chunkId: "chunk_0",
      localSpeaker: "speaker_0",
      globalSpeakerId: "person_partner"
    });
    await store.write("speaker-identity-manual-mappings", "corrupt_other_upload", {
      uploadId: "upload_other",
      unexpectedPrivateValue: "must-not-be-read-as-a-mapping"
    });

    await expect(repository.listManualMappings("upload_target")).resolves.toEqual([
      expect.objectContaining({ uploadId: "upload_target", chunkId: "chunk_0" })
    ]);
  });

  it("fails explicitly when a corrupt row claims the requested upload", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    await store.write("speaker-identity-manual-mappings", "corrupt_target_upload", {
      uploadId: "upload_target",
      localSpeaker: "speaker_0"
    });

    await expect(repository.listManualMappings("upload_target")).rejects.toThrow();
  });

  it("deletes target-scoped corrupt rows without touching corrupt or unscoped rows elsewhere", async () => {
    const repository = new JsonSpeakerIdentityRepository(store, () => clock);
    await repository.saveProfile({
      globalSpeakerId: "person_partner",
      identityType: "known_contact"
    });
    await repository.saveManualMapping({
      uploadId: "upload_target",
      chunkId: "chunk_0",
      localSpeaker: "speaker_0",
      globalSpeakerId: "person_partner"
    });
    await store.write("speaker-identity-manual-mappings", "corrupt_target_upload", {
      uploadId: "upload_target",
      invalid: true
    });
    await store.write("speaker-identity-manual-mappings", "corrupt_other_upload", {
      uploadId: "upload_other",
      invalid: true
    });
    await store.write("speaker-identity-manual-mappings", "corrupt_unknown_scope", {
      invalid: true
    });

    await expect(repository.deleteUploadMappings("upload_target")).resolves.toBe(2);
    const remainingIds = (await store.list<unknown>("speaker-identity-manual-mappings"))
      .map(({ id }) => id)
      .sort();
    expect(remainingIds).toEqual(["corrupt_other_upload", "corrupt_unknown_scope"]);
    await expect(repository.getProfile("person_partner")).resolves.not.toBeNull();
  });
});
