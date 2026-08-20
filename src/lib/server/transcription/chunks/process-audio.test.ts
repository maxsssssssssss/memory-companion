import { describe, expect, it, vi } from "vitest";
import { buildAudioChunkId, type AudioChunk, type TranscriptChunk } from "@/lib/domain/chunks";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  CompositeIdentityResolver,
  ManualMappingResolver,
  VoiceprintResolver,
  type IdentityResolver
} from "@/lib/server/speaker-identity/identity-resolver";
import type {
  SpeakerIdentityDirectMapping,
  VoiceprintIdentityHint
} from "@/lib/server/speaker-identity/types";
import { ChunkTranscriptionError, type ChunkTranscriptionAdapter } from "./adapter";
import type { ChunkCheckpointStore } from "./checkpoint-store";
import { fixtureTranscriptionProvider } from "../fixture-provider";
import {
  IncompleteChunkTranscriptionError,
  transcribeConfiguredAudio,
  transcribeDailyReflectionAudio,
  transcribeSpeakerAsrAudioInChunks
} from "./process-audio";
import { createTranscriptChunkFromLocalSegments } from "./transcript-merge";

const timestamp = "2026-07-14T08:00:00.000Z";

function chunks(count: number): AudioChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    id: buildAudioChunkId("upload_30m", index),
    uploadId: "upload_30m",
    index,
    startSeconds: index * 300,
    endSeconds: (index + 1) * 300,
    durationSeconds: 300,
    source: { type: "uploaded_audio" as const, path: "C:/tmp/source.wav" },
    status: "created" as const,
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: { strategy: "fixed_duration" }
  }));
}

function checkpoints(): ChunkCheckpointStore {
  const audio = new Map<string, AudioChunk>();
  const transcript = new Map<string, TranscriptChunk>();
  return {
    async saveAudioChunk(value) {
      audio.set(value.id, value);
    },
    async saveTranscriptChunk(value) {
      transcript.set(value.id, value);
    },
    async listAudioChunks(uploadId) {
      return [...audio.values()].filter((value) => value.uploadId === uploadId);
    },
    async listTranscriptChunks(uploadId) {
      return [...transcript.values()].filter((value) => value.uploadId === uploadId);
    },
    async deleteUpload(uploadId) {
      for (const [id, value] of audio) if (value.uploadId === uploadId) audio.delete(id);
      for (const [id, value] of transcript) if (value.uploadId === uploadId) transcript.delete(id);
    }
  };
}

function testStore() {
  const values = new Map<string, unknown>();
  const key = (collection: string, id: string) => `${collection}:${id}`;
  return {
    async write<T>(collection: string, id: string, value: T) {
      values.set(key(collection, id), structuredClone(value));
    },
    async read<T>(collection: string, id: string) {
      return (values.get(key(collection, id)) as T | undefined) ?? null;
    },
    async list<T>(collection: string) {
      const prefix = `${collection}:`;
      return [...values.entries()]
        .filter(([entryKey]) => entryKey.startsWith(prefix))
        .map(([entryKey, value]) => ({ id: entryKey.slice(prefix.length), value: value as T }));
    },
    async delete(collection: string, id: string) {
      values.delete(key(collection, id));
    }
  } as unknown as JsonStore;
}

function successfulAdapter(speaker = "speaker_1"): ChunkTranscriptionAdapter {
  return {
    name: "fake-speaker-asr",
    async transcribeChunk({ chunk }) {
      return createTranscriptChunkFromLocalSegments({
        chunk,
        localSegments: [
          {
            id: "provider-local-id",
            uploadId: chunk.uploadId,
            startSeconds: 1,
            endSeconds: 3,
            speaker,
            text: `chunk ${chunk.index}`,
            confidence: 0.9,
            sceneLabels: [],
            valueLabels: []
          }
        ],
        now: () => timestamp
      });
    }
  };
}

function testIdentityResolver(input: {
  loadDirectMappings?: (uploadId: string) => Promise<SpeakerIdentityDirectMapping[]>;
  loadVoiceprintHints?: (chunks: TranscriptChunk[]) => Promise<VoiceprintIdentityHint[]>;
} = {}): IdentityResolver {
  return new CompositeIdentityResolver({
    manualMappingResolver: new ManualMappingResolver({
      loadDirectMappings: input.loadDirectMappings ?? (async () => [])
    }),
    voiceprintResolver: new VoiceprintResolver({
      loadVoiceprintHints: input.loadVoiceprintHints ?? (async () => [])
    })
  });
}

describe("chunked audio transcription orchestration", () => {
  it("simulates a 30-minute upload as six chunks and returns the legacy TranscriptSegment shape", async () => {
    const planned = chunks(6);
    const planner = vi.fn(async () => planned);
    const store = testStore();
    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store
      },
      {
        planner,
        adapter: successfulAdapter(),
        checkpoints: checkpoints(),
        cleanupChunks: async () => undefined,
        schedulerOptions: {
          concurrency: 3,
          maxRetries: 0,
          attemptTimeoutMs: 1_000,
          now: () => timestamp
        }
      }
    );

    expect(planner).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({
      id: "upload_30m_chunk_00000_seg_00001",
      uploadId: "upload_30m",
      startSeconds: 1,
      endSeconds: 3,
      speaker: "speaker_1"
    });
    expect(result[5]).toMatchObject({ startSeconds: 1_501, endSeconds: 1_503 });
    expect(result[0].identity).toMatchObject({
      identityType: "unknown_person",
      confidence: 0,
      source: "cross_chunk_matching"
    });
    await expect(store.read("speaker-identities", "upload_30m")).resolves.toMatchObject({
      chunksProcessed: 6,
      localSpeakerGroups: 6,
      matched: 0,
      resolutionStates: expect.arrayContaining([
        expect.objectContaining({
          localSpeaker: "speaker_1",
          ownerIdentityId: null,
          status: "unknown"
        })
      ])
    });
  });

  it("skips identity and voiceprint resolution for transcript-only staging", async () => {
    const store = testStore();
    const resolve = vi.fn(async () => {
      throw new Error("identity resolver must not run");
    });
    const adapter = successfulAdapter();
    const transcribeChunk = vi.fn(adapter.transcribeChunk);

    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store,
        identityPolicy: "skip",
        audioAccessPolicy: "daily_reflection_capability"
      },
      {
        planner: async () => chunks(1),
        adapter: { ...adapter, transcribeChunk },
        checkpoints: checkpoints(),
        cleanupChunks: async () => undefined,
        identityResolver: { resolve },
        schedulerOptions: {
          concurrency: 1,
          maxRetries: 0,
          attemptTimeoutMs: 1_000,
          now: () => timestamp
        }
      }
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(transcribeChunk).toHaveBeenCalledWith(expect.objectContaining({
      audioAccessPolicy: "daily_reflection_capability"
    }));
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("identity");
    await expect(store.read("speaker-identities", "upload_30m")).resolves.toBeNull();
  });

  it("defaults configured uploads to legacy access and forces the Daily Reflection policy", async () => {
    const originalProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalFallback = process.env.TRANSCRIPTION_FALLBACK_PROVIDER;
    process.env.TRANSCRIPTION_PROVIDER = "fixture";
    process.env.TRANSCRIPTION_FALLBACK_PROVIDER = "none";
    const transcribe = vi.spyOn(fixtureTranscriptionProvider, "transcribe")
      .mockResolvedValue([]);
    const baseInput = {
      uploadId: "upload_policy",
      filePath: "C:/tmp/source.wav",
      mimeType: "audio/wav",
      userId: "user_1",
      store: testStore()
    };

    try {
      await transcribeConfiguredAudio(baseInput);
      expect(transcribe).toHaveBeenLastCalledWith(expect.objectContaining({
        audioAccessPolicy: "legacy_bearer"
      }));

      await transcribeDailyReflectionAudio({
        ...baseInput,
        audioAccessPolicy: "legacy_bearer",
        identityPolicy: "resolve_and_persist"
      });
      expect(transcribe).toHaveBeenLastCalledWith(expect.objectContaining({
        audioAccessPolicy: "daily_reflection_capability",
        identityPolicy: "skip"
      }));
    } finally {
      transcribe.mockRestore();
      if (originalProvider === undefined) delete process.env.TRANSCRIPTION_PROVIDER;
      else process.env.TRANSCRIPTION_PROVIDER = originalProvider;
      if (originalFallback === undefined) delete process.env.TRANSCRIPTION_FALLBACK_PROVIDER;
      else process.env.TRANSCRIPTION_FALLBACK_PROVIDER = originalFallback;
    }
  });

  it("resumes only exact non-empty completed checkpoints and is idempotent", async () => {
    const planned = chunks(2);
    const checkpointStore = checkpoints();
    const completedAudioChunk: AudioChunk = {
      ...planned[0],
      status: "completed",
      startedAt: timestamp,
      finishedAt: timestamp
    };
    const completedTranscript = await successfulAdapter().transcribeChunk({
      chunk: completedAudioChunk,
      signal: new AbortController().signal
    });
    await checkpointStore.saveAudioChunk(completedAudioChunk);
    await checkpointStore.saveTranscriptChunk(completedTranscript);
    const transcribeChunk = vi.fn(successfulAdapter().transcribeChunk);
    const progress = vi.fn();
    const dependencies = {
      planner: async () => planned,
      adapter: {
        name: "fake-speaker-asr",
        transcribeChunk
      },
      checkpoints: checkpointStore,
      cleanupChunks: async () => undefined,
      identityResolver: testIdentityResolver(),
      schedulerOptions: {
        concurrency: 1,
        maxRetries: 0,
        attemptTimeoutMs: 1_000,
        now: () => timestamp
      }
    };
    const input = {
      uploadId: "upload_30m",
      filePath: "C:/tmp/source.wav",
      mimeType: "audio/wav",
      userId: "user_1",
      store: testStore(),
      onChunkProgress: progress
    };

    const first = await transcribeSpeakerAsrAudioInChunks(input, dependencies);
    const second = await transcribeSpeakerAsrAudioInChunks(input, dependencies);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(transcribeChunk).toHaveBeenCalledTimes(1);
    expect(transcribeChunk).toHaveBeenCalledWith(
      expect.objectContaining({ chunk: expect.objectContaining({ id: planned[1].id }) })
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ completed: 2, failed: 0, total: 2 })
    );
  });

  it("reprocesses a completed checkpoint whose transcript is empty", async () => {
    const planned = chunks(1);
    const checkpointStore = checkpoints();
    const completedAudioChunk: AudioChunk = {
      ...planned[0],
      status: "completed",
      startedAt: timestamp,
      finishedAt: timestamp
    };
    await checkpointStore.saveAudioChunk(completedAudioChunk);
    await checkpointStore.saveTranscriptChunk(
      createTranscriptChunkFromLocalSegments({
        chunk: completedAudioChunk,
        localSegments: [],
        now: () => timestamp
      })
    );
    const transcribeChunk = vi.fn(successfulAdapter().transcribeChunk);

    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store: testStore()
      },
      {
        planner: async () => planned,
        adapter: { name: "fake-speaker-asr", transcribeChunk },
        checkpoints: checkpointStore,
        cleanupChunks: async () => undefined,
        identityResolver: testIdentityResolver(),
        schedulerOptions: {
          concurrency: 1,
          maxRetries: 0,
          attemptTimeoutMs: 1_000,
          now: () => timestamp
        }
      }
    );

    expect(result).toHaveLength(1);
    expect(transcribeChunk).toHaveBeenCalledTimes(1);
  });

  it("waits for independent chunks but rejects a partial transcript", async () => {
    const called: number[] = [];
    const adapter: ChunkTranscriptionAdapter = {
      name: "partially-failing",
      async transcribeChunk(input) {
        called.push(input.chunk.index);
        if (input.chunk.index === 1) {
          throw new ChunkTranscriptionError("query_failed", "chunk failed", false);
        }
        return successfulAdapter().transcribeChunk(input);
      }
    };

    await expect(
      transcribeSpeakerAsrAudioInChunks(
        {
          uploadId: "upload_30m",
          filePath: "C:/tmp/source.wav",
          mimeType: "audio/wav",
          userId: "user_1",
          store: testStore()
        },
        {
          planner: async () => chunks(3),
          adapter,
          checkpoints: checkpoints(),
          cleanupChunks: async () => undefined,
          schedulerOptions: {
            concurrency: 2,
            maxRetries: 0,
            attemptTimeoutMs: 1_000,
            now: () => timestamp
          }
        }
      )
    ).rejects.toBeInstanceOf(IncompleteChunkTranscriptionError);

    expect(called.sort()).toEqual([0, 1, 2]);
  });

  it("replaces an exhausted empty-transcript parent with its recovered transcript", async () => {
    const adapter: ChunkTranscriptionAdapter = {
      name: "speaker-asr",
      async transcribeChunk() {
        throw new ChunkTranscriptionError(
          "speaker_asr_empty_transcript",
          "empty transcript",
          true
        );
      }
    };
    const recoverEmptyTranscript = vi.fn(async ({ chunk }: { chunk: AudioChunk }) =>
      successfulAdapter().transcribeChunk({
        chunk,
        signal: new AbortController().signal
      })
    );

    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store: testStore()
      },
      {
        planner: async () => chunks(1),
        adapter,
        checkpoints: checkpoints(),
        cleanupChunks: async () => undefined,
        emptyTranscriptRecovery: recoverEmptyTranscript,
        emptyTranscriptRecoveryEnabled: true,
        schedulerOptions: {
          concurrency: 1,
          maxRetries: 1,
          retryDelayMs: 0,
          attemptTimeoutMs: 1_000,
          now: () => timestamp
        }
      }
    );

    expect(recoverEmptyTranscript).toHaveBeenCalledTimes(1);
    expect(recoverEmptyTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        chunk: expect.objectContaining({
          status: "failed",
          retryCount: 1,
          error: expect.objectContaining({ code: "speaker_asr_empty_transcript" })
        })
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      startSeconds: 1,
      endSeconds: 3,
      text: "chunk 0"
    });
  });

  it("keeps strict failure behavior when empty-transcript split recovery is disabled", async () => {
    const recoverEmptyTranscript = vi.fn();
    const adapter: ChunkTranscriptionAdapter = {
      name: "speaker-asr",
      async transcribeChunk() {
        throw new ChunkTranscriptionError(
          "speaker_asr_empty_transcript",
          "empty transcript",
          true
        );
      }
    };

    await expect(
      transcribeSpeakerAsrAudioInChunks(
        {
          uploadId: "upload_30m",
          filePath: "C:/tmp/source.wav",
          mimeType: "audio/wav",
          userId: "user_1",
          store: testStore()
        },
        {
          planner: async () => chunks(1),
          adapter,
          checkpoints: checkpoints(),
          cleanupChunks: async () => undefined,
          emptyTranscriptRecovery: recoverEmptyTranscript,
          emptyTranscriptRecoveryEnabled: false,
          schedulerOptions: {
            concurrency: 1,
            maxRetries: 0,
            attemptTimeoutMs: 1_000,
            now: () => timestamp
          }
        }
      )
    ).rejects.toBeInstanceOf(IncompleteChunkTranscriptionError);

    expect(recoverEmptyTranscript).not.toHaveBeenCalled();
  });

  it("does not discard a valid transcript when temporary chunk cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store: testStore()
      },
      {
        planner: async () => chunks(1),
        adapter: successfulAdapter(),
        checkpoints: checkpoints(),
        cleanupChunks: async () => {
          throw new Error("cleanup unavailable");
        },
        schedulerOptions: {
          concurrency: 1,
          maxRetries: 0,
          attemptTimeoutMs: 1_000,
          now: () => timestamp
        }
      }
    );

    expect(result).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("temporary file cleanup failed"));
    warn.mockRestore();
  });

  it("fails open to completed transcript chunks when an injected identity resolver fails unexpectedly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const identityResolver: IdentityResolver = {
      async resolve() {
        throw new Error("SENSITIVE_RESOLVER_FAILURE");
      }
    };

    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store: testStore()
      },
      {
        planner: async () => chunks(1),
        adapter: successfulAdapter(),
        checkpoints: checkpoints(),
        cleanupChunks: async () => undefined,
        identityResolver,
        schedulerOptions: {
          concurrency: 1,
          maxRetries: 0,
          attemptTimeoutMs: 1_000,
          now: () => timestamp
        }
      }
    );

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("identity");
    expect(warn).toHaveBeenCalledWith(
      "[speaker-identity] resolution_failed upload_id=upload_30m error_name=Error"
    );
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SENSITIVE_RESOLVER_FAILURE");
    warn.mockRestore();
  });

  it("keeps resolved identities when audit persistence fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = testStore();
    vi.spyOn(store, "write").mockRejectedValueOnce(new Error("SENSITIVE_AUDIT_FAILURE"));

    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store
      },
      {
        planner: async () => chunks(1),
        adapter: successfulAdapter(),
        checkpoints: checkpoints(),
        cleanupChunks: async () => undefined,
        identityResolver: testIdentityResolver({
          loadDirectMappings: async () => [{
            chunkId: "upload_30m_transcript_chunk_00000",
            localSpeaker: "speaker_1",
            globalSpeakerId: "contact_partner",
            displayName: "Partner"
          }]
        }),
        schedulerOptions: {
          concurrency: 1,
          maxRetries: 0,
          attemptTimeoutMs: 1_000,
          now: () => timestamp
        }
      }
    );

    expect(result[0].identity).toMatchObject({
      globalSpeakerId: "contact_partner",
      displayName: "Partner",
      confidence: 1
    });
    expect(warn).toHaveBeenCalledWith(
      "[speaker-identity] audit_write_failed upload_id=upload_30m error_name=Error"
    );
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SENSITIVE_AUDIT_FAILURE");
    warn.mockRestore();
  });

  it("preserves exact Provider labels as pending evidence before transcript merge", async () => {
    const store = testStore();
    const loadVoiceprintHints = vi.fn(async () => [{
      identityStatus: "verified" as const,
      chunkId: "upload_30m_transcript_chunk_00000",
      localSpeaker: "我",
      globalSpeakerId: "user_user_1",
      identityType: "known_user" as const,
      evidence: {
        type: "provider_label" as const,
        provider: "company_voiceprint" as const,
        providerLabel: "我"
      }
    }]);

    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store
      },
      {
        planner: async () => chunks(1),
        adapter: successfulAdapter("我"),
        checkpoints: checkpoints(),
        cleanupChunks: async () => undefined,
        identityResolver: testIdentityResolver({ loadVoiceprintHints }),
        schedulerOptions: {
          concurrency: 1,
          maxRetries: 0,
          attemptTimeoutMs: 1_000,
          now: () => timestamp
        }
      }
    );

    expect(loadVoiceprintHints).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({
      speaker: "我",
      identity: {
        globalSpeakerId: expect.stringMatching(/^unknown_/),
        identityType: "unknown_person",
        source: "provider_speaker_result",
        confidence: null,
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "我"
        }
      }
    });
  });
});
