import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import { JsonSpeakerIdentityRepository } from "./repository";
import { resolveSpeakerIdentities } from "./resolver";
import {
  HttpVoiceprintProvider,
  InMemoryVoiceprintProvider,
  VoiceprintCapabilityUnsupportedError,
  VoiceprintProviderError,
  type VoiceprintProvider
} from "./voiceprint-client";
import { JsonVoiceprintOperationRepository } from "./voiceprint-operation-repository";
import { VoiceprintService } from "./voiceprint-service";

const timestamp = "2026-07-24T00:00:00.000Z";

function transcriptChunk(localSpeakers: string[]): TranscriptChunk {
  const segments: TranscriptSegment[] = localSpeakers.map((speaker, index) => ({
    id: `segment_${index}`,
    uploadId: "upload_1",
    startSeconds: index,
    endSeconds: index + 0.5,
    speaker,
    text: `utterance ${index}`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  }));
  return {
    id: "chunk_1",
    uploadId: "upload_1",
    audioChunkId: "audio_chunk_1",
    index: 0,
    startSeconds: 0,
    endSeconds: 300,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries(localSpeakers.map((speaker) => [speaker, speaker])),
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

function failingProvider(error: Error): VoiceprintProvider {
  return {
    train: vi.fn(async () => { throw error; }),
    save: vi.fn(async () => { throw error; }),
    identify: vi.fn(async () => { throw new VoiceprintCapabilityUnsupportedError(); })
  };
}

describe("VoiceprintService", () => {
  let rootDir: string;
  let store: JsonStore;
  let profiles: JsonSpeakerIdentityRepository;
  let operations: JsonVoiceprintOperationRepository;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "voiceprint-service-"));
    store = new JsonStore(rootDir);
    profiles = new JsonSpeakerIdentityRepository(store, () => timestamp);
    operations = new JsonVoiceprintOperationRepository(store, () => timestamp);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("records user training but keeps the Provider self label pending for Memory review", async () => {
    const provider = new InMemoryVoiceprintProvider();
    const service = new VoiceprintService(provider, profiles, operations);

    const result = await service.trainUser({
      userId: "user_1",
      requestId: "train_1",
      displayName: "Current user",
      audio: [
        { url: "https://audio.example.test/current.opus", rule: [[0, 8_000]] },
        { url: "https://audio.example.test/history.opus", rule: [[0, 7_000]] }
      ]
    });

    expect(result.profile).toMatchObject({
      globalSpeakerId: "user_user_1",
      userId: "user_1",
      identityType: "known_user",
      status: "active",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: "我",
        lastRequestId: "train_1",
        operationType: "train"
      }
    });
    expect(result.operation).toMatchObject({
      status: "succeeded",
      resultMetadata: {
        audioCount: 2,
        incremental: true,
        providerAttemptCount: 1,
        providerSucceeded: true
      }
    });

    const chunks = [transcriptChunk(["我", "speaker_0"])];
    const voiceprintHints = await profiles.loadVoiceprintHints(chunks);
    const resolved = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks,
      voiceprintHints
    });
    expect(resolved.assignments.find((assignment) => assignment.localSpeaker === "我"))
      .toMatchObject({
        localSpeaker: "我",
        matched: false,
        reason: "provider_label_review_required",
        identity: {
          globalSpeakerId: expect.stringMatching(/^unknown_/),
          identityType: "unknown_person",
          confidence: null,
          source: "provider_speaker_result",
          evidence: {
            type: "provider_label",
            provider: "company_voiceprint",
            providerLabel: "我"
          }
        }
      });
    expect(resolved.assignments.find((assignment) => assignment.localSpeaker === "speaker_0"))
      .toMatchObject({
        localSpeaker: "speaker_0",
        matched: false,
        identity: { identityType: "unknown_person", confidence: 0 }
      });
  });

  it("records train failure without creating a known-user profile", async () => {
    const service = new VoiceprintService(
      failingProvider(new VoiceprintProviderError("timeout", "timed out")),
      profiles,
      operations
    );

    await expect(service.trainUser({
      userId: "user_1",
      requestId: "train_failed",
      audio: [{ url: "https://audio.example.test/current.opus", rule: [[0, 8_000]] }]
    })).rejects.toMatchObject({ reason: "timeout" });

    await expect(profiles.getProfile("user_user_1")).resolves.toBeNull();
    await expect(operations.get("train_failed")).resolves.toMatchObject({
      status: "failed",
      resultMetadata: {
        providerSucceeded: false,
        failureReason: "timeout",
        retryable: true
      }
    });
  });

  it("persists a user-confirmed contact only after provider save succeeds", async () => {
    const provider = new InMemoryVoiceprintProvider();
    const service = new VoiceprintService(provider, profiles, operations);

    const result = await service.saveContact({
      userId: "user_1",
      requestId: "save_1",
      recordId: "chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    });

    expect(provider.saveCalls).toEqual([{
      userId: "user_1",
      requestId: "save_1",
      recordId: "chunk_1",
      speakerId: "speaker_1",
      speakerName: "Alice"
    }]);
    expect(result.profile).toMatchObject({
      globalSpeakerId: "contact_alice",
      userId: "user_1",
      contactName: "Alice",
      identityType: "known_contact",
      status: "active",
      providerReference: {
        provider: "company_voiceprint",
        speakerLabel: "Alice",
        lastRequestId: "save_1",
        operationType: "save"
      }
    });
    expect(result.mapping).toMatchObject({
      localSpeaker: "speaker_1",
      source: "manual_mapping",
      confidence: 1
    });
    await expect(service.saveContact({
      userId: "user_1",
      requestId: "save_1",
      recordId: "chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    })).resolves.toMatchObject({ reused: true });
    expect(provider.saveCalls).toHaveLength(1);

    const resolved = await resolveSpeakerIdentities({
      uploadId: "upload_1",
      chunks: [transcriptChunk(["speaker_0", "speaker_1"])],
      manualMappings: await profiles.loadDirectMappings("upload_1")
    });
    expect(resolved.chunks[0].segments[0].identity).toMatchObject({
      identityType: "unknown_person"
    });
    expect(resolved.chunks[0].segments[1]).toMatchObject({
      speaker: "speaker_1",
      identity: {
        globalSpeakerId: "contact_alice",
        identityType: "known_contact",
        source: "manual_mapping",
        confidence: 1
      }
    });
  });

  it("does not persist a contact or mapping when provider save fails", async () => {
    const service = new VoiceprintService(
      failingProvider(new VoiceprintProviderError("provider_rejected", "rejected", 200, 4)),
      profiles,
      operations
    );

    await expect(service.saveContact({
      userId: "user_1",
      requestId: "save_failed",
      recordId: "chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    })).rejects.toMatchObject({ reason: "provider_rejected" });

    await expect(profiles.getProfile("contact_alice")).resolves.toBeNull();
    await expect(profiles.getManualMapping({
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1"
    })).resolves.toBeNull();
    await expect(operations.get("save_failed")).resolves.toMatchObject({
      status: "failed",
      resultMetadata: { providerCode: 4 }
    });
  });

  it("rejects a chunk-local label as a contact identity without calling provider", async () => {
    const provider = new InMemoryVoiceprintProvider();
    const service = new VoiceprintService(provider, profiles, operations);

    await expect(service.saveContact({
      userId: "user_1",
      requestId: "save_boundary",
      recordId: "chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_1",
      displayName: "speaker_1",
      providerSpeakerId: "speaker_1"
    })).rejects.toMatchObject({ reason: "invalid_contact_name" });
    expect(provider.saveCalls).toHaveLength(0);
  });

  it("serializes concurrent retries for the same request id", async () => {
    const provider = new InMemoryVoiceprintProvider();
    const service = new VoiceprintService(provider, profiles, operations);
    const input = {
      userId: "user_1",
      requestId: "save_concurrent",
      recordId: "audio_chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    };

    const results = await Promise.all([
      service.saveContact(input),
      service.saveContact(input)
    ]);

    expect(provider.saveCalls).toHaveLength(1);
    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
  });

  it("records a bounded provider retry under the same idempotent request", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ code: 5, message: "temporary" }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ code: 0, message: "success" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ));
    const provider = new HttpVoiceprintProvider({
      baseUrl: "https://voiceprint.example.test",
      fetcher: fetcher as typeof fetch,
      retryDelayMs: 0,
      sleeper: async () => undefined
    });
    const service = new VoiceprintService(provider, profiles, operations);

    const result = await service.saveContact({
      userId: "user_1",
      requestId: "save_retry_once",
      recordId: "audio_chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const providerRequestIds = fetcher.mock.calls.map(([, init]) =>
      (JSON.parse(String(init?.body)) as { req_id: string }).req_id
    );
    expect(providerRequestIds).toEqual(["save_retry_once", "save_retry_once"]);
    expect(result.operation).toMatchObject({
      status: "succeeded",
      providerRequestId: "save_retry_once",
      resultMetadata: {
        providerAttemptCount: 2,
        providerSucceeded: true
      }
    });
  });

  it("rejects reusing a request id with different binding input", async () => {
    const provider = new InMemoryVoiceprintProvider();
    const service = new VoiceprintService(provider, profiles, operations);
    const input = {
      userId: "user_1",
      requestId: "save_conflict",
      recordId: "audio_chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    };

    await service.saveContact(input);
    await expect(service.saveContact({
      ...input,
      displayName: "Bob",
      providerSpeakerId: "Bob"
    })).rejects.toMatchObject({ reason: "request_id_conflict" });
    expect(provider.saveCalls).toHaveLength(1);
  });

  it("resumes local persistence without repeating a successful provider save", async () => {
    const provider = new InMemoryVoiceprintProvider();
    let rejectFirstProfileSave = true;
    const flakyProfiles = {
      saveProfile: vi.fn(async (input: Parameters<typeof profiles.saveProfile>[0]) => {
        if (rejectFirstProfileSave) {
          rejectFirstProfileSave = false;
          throw new Error("temporary profile write failure");
        }
        return await profiles.saveProfile(input);
      }),
      getProfile: profiles.getProfile.bind(profiles),
      listProfiles: profiles.listProfiles.bind(profiles),
      saveManualMapping: profiles.saveManualMapping.bind(profiles),
      getManualMapping: profiles.getManualMapping.bind(profiles)
    };
    const service = new VoiceprintService(provider, flakyProfiles, operations);
    const input = {
      userId: "user_1",
      requestId: "save_resume",
      recordId: "audio_chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    };

    await expect(service.saveContact(input)).rejects.toMatchObject({
      reason: "persistence_error"
    });
    await expect(operations.get("save_resume")).resolves.toMatchObject({
      status: "provider_succeeded",
      resultMetadata: {
        providerSucceeded: true,
        failurePhase: "persistence"
      }
    });

    await expect(service.saveContact(input)).resolves.toMatchObject({
      reused: false,
      operation: { status: "succeeded" }
    });
    expect(provider.saveCalls).toHaveLength(1);
  });

  it("continues training when the intermediate provider-succeeded checkpoint write is transient", async () => {
    const provider = new InMemoryVoiceprintProvider();
    let failCheckpointOnce = true;
    const flakyOperations = {
      get: operations.get.bind(operations),
      list: operations.list.bind(operations),
      save: vi.fn(async (
        input: Parameters<typeof operations.save>[0]
      ) => {
        if (input.status === "provider_succeeded" && failCheckpointOnce) {
          failCheckpointOnce = false;
          throw new Error("temporary operation checkpoint failure");
        }
        return await operations.save(input);
      })
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new VoiceprintService(provider, profiles, flakyOperations);

    const result = await service.trainUser({
      userId: "user_1",
      requestId: "train_checkpoint_recovery",
      audio: [{
        url: "https://audio.example.test/current.opus",
        rule: [[0, 8_000]]
      }]
    });

    expect(result.operation.status).toBe("succeeded");
    expect(provider.trainCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      "provider_succeeded_checkpoint_failed operation=train"
    ));
    warn.mockRestore();
  });

  it("recovers a pending save from its durable profile and mapping receipt", async () => {
    const provider = new InMemoryVoiceprintProvider();
    const unavailableOperations = {
      get: operations.get.bind(operations),
      list: operations.list.bind(operations),
      save: vi.fn(async (
        input: Parameters<typeof operations.save>[0]
      ) => {
        if (input.status !== "pending") {
          throw new Error("operation repository unavailable");
        }
        return await operations.save(input);
      })
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      userId: "user_1",
      requestId: "save_pending_receipt",
      recordId: "audio_chunk_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_alice",
      displayName: "Alice",
      providerSpeakerId: "Alice"
    };

    await expect(
      new VoiceprintService(provider, profiles, unavailableOperations)
        .saveContact(input)
    ).rejects.toMatchObject({ reason: "persistence_error" });
    await expect(operations.get(input.requestId)).resolves.toMatchObject({
      status: "pending"
    });
    expect(provider.saveCalls).toHaveLength(1);

    const recovered = await new VoiceprintService(provider, profiles, operations)
      .saveContact(input);
    expect(recovered).toMatchObject({
      reused: true,
      operation: { status: "succeeded" },
      profile: { identityType: "known_contact" },
      mapping: { globalSpeakerId: "contact_alice" }
    });
    expect(provider.saveCalls).toHaveLength(1);
    warn.mockRestore();
  });

  it("recovers a pending train from its durable user-profile receipt", async () => {
    const provider = new InMemoryVoiceprintProvider();
    const unavailableOperations = {
      get: operations.get.bind(operations),
      list: operations.list.bind(operations),
      save: vi.fn(async (
        input: Parameters<typeof operations.save>[0]
      ) => {
        if (input.status !== "pending") {
          throw new Error("operation repository unavailable");
        }
        return await operations.save(input);
      })
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      userId: "user_1",
      requestId: "train_pending_receipt",
      audio: [{
        url: "https://audio.example.test/current.opus",
        rule: [[0, 8_000]] as Array<[number, number]>
      }]
    };

    await expect(
      new VoiceprintService(provider, profiles, unavailableOperations)
        .trainUser(input)
    ).rejects.toMatchObject({ reason: "persistence_error" });
    await expect(operations.get(input.requestId)).resolves.toMatchObject({
      status: "pending"
    });
    expect(provider.trainCalls).toHaveLength(1);

    const recovered = await new VoiceprintService(provider, profiles, operations)
      .trainUser(input);
    expect(recovered).toMatchObject({
      reused: true,
      operation: { status: "succeeded" },
      profile: {
        identityType: "known_user",
        providerReference: { speakerLabel: "我" }
      }
    });
    expect(provider.trainCalls).toHaveLength(1);
    warn.mockRestore();
  });
});
