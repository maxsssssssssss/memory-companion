import { describe, expect, it, vi } from "vitest";
import {
  buildAudioChunkId,
  type AudioChunk,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import { ChunkTranscriptionError, type ChunkTranscriptionAdapter } from "./adapter";
import type { ChunkCheckpointStore } from "./checkpoint-store";
import {
  isEmptyTranscriptRecoveryCandidate,
  recoverEmptyTranscriptChunk
} from "./empty-transcript-recovery";
import { createTranscriptChunkFromLocalSegments } from "./transcript-merge";

const timestamp = "2026-07-30T02:00:00.000Z";

function failedParent(): AudioChunk {
  return {
    id: buildAudioChunkId("upload_1", 2),
    uploadId: "upload_1",
    index: 2,
    startSeconds: 600,
    endSeconds: 900,
    durationSeconds: 300,
    source: {
      type: "generated_chunk",
      path: "C:/data/uploads/upload_1-chunks/chunk_00002.mp3"
    },
    status: "failed",
    retryCount: 1,
    error: {
      code: "speaker_asr_empty_transcript",
      message: "empty transcript",
      retryable: true
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: { mimeType: "audio/mpeg" }
  };
}

function recoveryChunks(parent: AudioChunk): AudioChunk[] {
  return [
    {
      ...parent,
      id: `${parent.id}_recovery_00`,
      index: 1_000_004,
      startSeconds: 600,
      endSeconds: 750,
      durationSeconds: 150,
      source: { type: "generated_chunk", path: "C:/tmp/recovery_00.mp3" },
      status: "created",
      retryCount: 0,
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined
    },
    {
      ...parent,
      id: `${parent.id}_recovery_01`,
      index: 1_000_005,
      startSeconds: 750,
      endSeconds: 900,
      durationSeconds: 150,
      source: { type: "generated_chunk", path: "C:/tmp/recovery_01.mp3" },
      status: "created",
      retryCount: 0,
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined
    }
  ];
}

function splitRecoveryChunk(parent: AudioChunk): AudioChunk[] {
  const splitAt = Number(
    (parent.startSeconds + parent.durationSeconds / 2).toFixed(3)
  );
  return [
    {
      ...parent,
      id: `${parent.id}_recovery_00`,
      index: parent.index * 2 + 1,
      startSeconds: parent.startSeconds,
      endSeconds: splitAt,
      durationSeconds: Number((splitAt - parent.startSeconds).toFixed(3)),
      source: {
        type: "generated_chunk",
        path: `C:/tmp/${parent.id}_recovery_00.mp3`
      },
      status: "created",
      retryCount: 0,
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined
    },
    {
      ...parent,
      id: `${parent.id}_recovery_01`,
      index: parent.index * 2 + 2,
      startSeconds: splitAt,
      endSeconds: parent.endSeconds,
      durationSeconds: Number((parent.endSeconds - splitAt).toFixed(3)),
      source: {
        type: "generated_chunk",
        path: `C:/tmp/${parent.id}_recovery_01.mp3`
      },
      status: "created",
      retryCount: 0,
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined
    }
  ];
}

function recordingCheckpoints(): ChunkCheckpointStore & {
  audio: Map<string, AudioChunk>;
  transcripts: Map<string, TranscriptChunk>;
} {
  const audio = new Map<string, AudioChunk>();
  const transcripts = new Map<string, TranscriptChunk>();
  return {
    audio,
    transcripts,
    async saveAudioChunk(chunk) {
      audio.set(chunk.id, structuredClone(chunk));
    },
    async saveTranscriptChunk(chunk) {
      transcripts.set(chunk.id, structuredClone(chunk));
    },
    async deleteAudioChunk(chunkId) {
      audio.delete(chunkId);
    },
    async deleteTranscriptChunk(chunkId) {
      transcripts.delete(chunkId);
    },
    async listAudioChunks(uploadId) {
      return [...audio.values()].filter((chunk) => chunk.uploadId === uploadId);
    },
    async listTranscriptChunks(uploadId) {
      return [...transcripts.values()].filter((chunk) => chunk.uploadId === uploadId);
    },
    async deleteUpload(uploadId) {
      for (const [id, chunk] of audio) if (chunk.uploadId === uploadId) audio.delete(id);
      for (const [id, chunk] of transcripts) {
        if (chunk.uploadId === uploadId) transcripts.delete(id);
      }
    }
  };
}

function successfulAdapter(): ChunkTranscriptionAdapter {
  return {
    name: "speaker-asr",
    async transcribeChunk({ chunk }) {
      return createTranscriptChunkFromLocalSegments({
        chunk,
        localSegments: [{
          id: `${chunk.id}_provider_segment`,
          uploadId: chunk.uploadId,
          startSeconds: 1,
          endSeconds: 2,
          speaker: "speaker_1",
          text: `recovered ${chunk.index}`,
          confidence: 0.9,
          sceneLabels: [],
          valueLabels: []
        }],
        now: () => timestamp
      });
    }
  };
}

describe("empty transcript chunk recovery", () => {
  it("only accepts exhausted speaker-asr empty-transcript failures", () => {
    const parent = failedParent();

    expect(isEmptyTranscriptRecoveryCandidate(parent)).toBe(true);
    expect(isEmptyTranscriptRecoveryCandidate({
      ...parent,
      error: { code: "speaker_asr_query_http", message: "http", retryable: true }
    })).toBe(false);
    expect(isEmptyTranscriptRecoveryCandidate({
      ...parent,
      status: "processing",
      error: undefined,
      finishedAt: undefined
    })).toBe(false);
  });

  it("recovers a failed 300-second parent from two successful 150-second subchunks", async () => {
    const parent = failedParent();
    const children = recoveryChunks(parent);
    const checkpoints = recordingCheckpoints();
    await checkpoints.saveAudioChunk(parent);
    const cleanupChunks = vi.fn(async () => undefined);
    const adapter = successfulAdapter();
    const transcribeChunk = vi.fn(adapter.transcribeChunk);

    const recovered = await recoverEmptyTranscriptChunk({
      chunk: parent,
      adapter: { ...adapter, transcribeChunk },
      checkpoints,
      userId: "user_1",
      audioAccessPolicy: "daily_reflection_capability",
      schedulerOptions: {
        concurrency: 2,
        attemptTimeoutMs: 1_000,
        now: () => timestamp
      },
      dependencies: {
        splitChunk: async () => children,
        cleanupChunks,
        now: () => timestamp
      }
    });

    expect(recovered).toMatchObject({
      audioChunkId: parent.id,
      index: parent.index,
      startSeconds: 600,
      endSeconds: 900,
      status: "completed",
      retryCount: 1,
      metadata: {
        recovery: "empty_transcript_split",
        recoverySubchunkCount: 2
      }
    });
    expect(recovered?.segments.map((segment) => ({
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds
    }))).toEqual([
      { startSeconds: 601, endSeconds: 602 },
      { startSeconds: 751, endSeconds: 752 }
    ]);
    expect(checkpoints.audio.get(parent.id)).toMatchObject({
      status: "completed",
      error: undefined
    });
    expect([...checkpoints.audio.keys()]).toEqual([parent.id]);
    expect([...checkpoints.transcripts.keys()]).toEqual([recovered?.id]);
    expect(cleanupChunks).toHaveBeenCalledWith(children);
    expect(transcribeChunk).toHaveBeenCalledTimes(2);
    expect(transcribeChunk).toHaveBeenCalledWith(expect.objectContaining({
      audioAccessPolicy: "daily_reflection_capability"
    }));
  });

  it("keeps the parent failed when either recovery subchunk fails", async () => {
    const parent = failedParent();
    const children = recoveryChunks(parent);
    const checkpoints = recordingCheckpoints();
    await checkpoints.saveAudioChunk(parent);
    const adapter: ChunkTranscriptionAdapter = {
      name: "speaker-asr",
      async transcribeChunk({ chunk }) {
        if (chunk.id.endsWith("_recovery_01")) {
          throw new ChunkTranscriptionError(
            "speaker_asr_empty_transcript",
            "still empty",
            true
          );
        }
        return successfulAdapter().transcribeChunk({
          chunk,
          signal: new AbortController().signal
        });
      }
    };

    const recovered = await recoverEmptyTranscriptChunk({
      chunk: parent,
      adapter,
      checkpoints,
      schedulerOptions: {
        concurrency: 2,
        attemptTimeoutMs: 1_000,
        now: () => timestamp
      },
      dependencies: {
        splitChunk: async () => children,
        cleanupChunks: async () => undefined,
        now: () => timestamp,
        maxDepth: 1
      }
    });

    expect(recovered).toBeNull();
    expect(checkpoints.audio.get(parent.id)).toMatchObject({
      status: "failed",
      error: { code: "speaker_asr_empty_transcript" }
    });
    expect([...checkpoints.audio.keys()]).toEqual([parent.id]);
    expect([...checkpoints.transcripts.keys()]).toEqual([]);
  });

  it("rejects recovery subchunks that claim completion with no transcript", async () => {
    const parent = failedParent();
    const children = recoveryChunks(parent);
    const checkpoints = recordingCheckpoints();
    await checkpoints.saveAudioChunk(parent);
    const emptyAdapter: ChunkTranscriptionAdapter = {
      name: "speaker-asr",
      async transcribeChunk({ chunk }) {
        return createTranscriptChunkFromLocalSegments({
          chunk,
          localSegments: [],
          now: () => timestamp
        });
      }
    };

    const recovered = await recoverEmptyTranscriptChunk({
      chunk: parent,
      adapter: emptyAdapter,
      checkpoints,
      dependencies: {
        splitChunk: async () => children,
        cleanupChunks: async () => undefined,
        now: () => timestamp
      }
    });

    expect(recovered).toBeNull();
    expect(checkpoints.audio.get(parent.id)).toMatchObject({
      status: "failed",
      error: { code: "speaker_asr_empty_transcript" }
    });
    expect([...checkpoints.audio.keys()]).toEqual([parent.id]);
    expect([...checkpoints.transcripts.keys()]).toEqual([]);
  });

  it("recursively narrows a deterministic empty interval down to successful 37.5-second leaves", async () => {
    const parent = failedParent();
    const checkpoints = recordingCheckpoints();
    await checkpoints.saveAudioChunk(parent);
    const splitChunk = vi.fn(async (chunk: AudioChunk) =>
      splitRecoveryChunk(chunk)
    );
    const adapter: ChunkTranscriptionAdapter = {
      name: "speaker-asr",
      async transcribeChunk({ chunk }) {
        if (chunk.startSeconds === 600 && chunk.durationSeconds > 37.5) {
          throw new ChunkTranscriptionError(
            "speaker_asr_empty_transcript",
            "still empty",
            true
          );
        }
        return successfulAdapter().transcribeChunk({
          chunk,
          signal: new AbortController().signal
        });
      }
    };

    const recovered = await recoverEmptyTranscriptChunk({
      chunk: parent,
      adapter,
      checkpoints,
      schedulerOptions: {
        concurrency: 2,
        attemptTimeoutMs: 1_000,
        now: () => timestamp
      },
      dependencies: {
        splitChunk,
        cleanupChunks: async () => undefined,
        now: () => timestamp,
        maxDepth: 3,
        minimumChildDurationSeconds: 30
      }
    });

    expect(splitChunk).toHaveBeenCalledTimes(3);
    expect(recovered).toMatchObject({
      audioChunkId: parent.id,
      status: "completed",
      metadata: {
        recovery: "empty_transcript_split",
        recoveryDepth: 3,
        recoveryLeafCount: 4,
        recoveryMaxDepth: 3,
        recoveryMinimumChildDurationSeconds: 30
      }
    });
    expect(recovered?.segments.map((segment) => segment.startSeconds)).toEqual([
      601,
      638.5,
      676,
      751
    ]);
    expect(checkpoints.audio.get(parent.id)).toMatchObject({
      status: "completed",
      error: undefined
    });
    expect([...checkpoints.audio.keys()]).toEqual([parent.id]);
    expect([...checkpoints.transcripts.keys()]).toEqual([recovered?.id]);
  });

  it("stops at the configured maximum depth and preserves strict failure", async () => {
    const parent = failedParent();
    const checkpoints = recordingCheckpoints();
    await checkpoints.saveAudioChunk(parent);
    const splitChunk = vi.fn(async (chunk: AudioChunk) =>
      splitRecoveryChunk(chunk)
    );
    const adapter: ChunkTranscriptionAdapter = {
      name: "speaker-asr",
      async transcribeChunk() {
        throw new ChunkTranscriptionError(
          "speaker_asr_empty_transcript",
          "still empty",
          true
        );
      }
    };

    const recovered = await recoverEmptyTranscriptChunk({
      chunk: parent,
      adapter,
      checkpoints,
      dependencies: {
        splitChunk,
        cleanupChunks: async () => undefined,
        now: () => timestamp,
        maxDepth: 1,
        minimumChildDurationSeconds: 30
      }
    });

    expect(recovered).toBeNull();
    expect(splitChunk).toHaveBeenCalledTimes(1);
    expect(checkpoints.audio.get(parent.id)).toMatchObject({
      status: "failed",
      error: { code: "speaker_asr_empty_transcript" }
    });
    expect([...checkpoints.transcripts.keys()]).toEqual([]);
  });

  it("does not split below the configured minimum child duration", async () => {
    const parent = {
      ...failedParent(),
      endSeconds: 650,
      durationSeconds: 50
    };
    const checkpoints = recordingCheckpoints();
    await checkpoints.saveAudioChunk(parent);
    const splitChunk = vi.fn(async (chunk: AudioChunk) =>
      splitRecoveryChunk(chunk)
    );

    const recovered = await recoverEmptyTranscriptChunk({
      chunk: parent,
      adapter: successfulAdapter(),
      checkpoints,
      dependencies: {
        splitChunk,
        cleanupChunks: async () => undefined,
        now: () => timestamp,
        maxDepth: 3,
        minimumChildDurationSeconds: 30
      }
    });

    expect(recovered).toBeNull();
    expect(splitChunk).not.toHaveBeenCalled();
    expect(checkpoints.audio.get(parent.id)).toMatchObject({
      status: "failed"
    });
  });

  it("propagates a deepest-leaf failure instead of accepting a partial transcript", async () => {
    const parent = failedParent();
    const checkpoints = recordingCheckpoints();
    await checkpoints.saveAudioChunk(parent);
    const splitChunk = vi.fn(async (chunk: AudioChunk) =>
      splitRecoveryChunk(chunk)
    );
    const adapter: ChunkTranscriptionAdapter = {
      name: "speaker-asr",
      async transcribeChunk({ chunk }) {
        if (chunk.startSeconds === 600) {
          throw new ChunkTranscriptionError(
            "speaker_asr_empty_transcript",
            "still empty",
            true
          );
        }
        return successfulAdapter().transcribeChunk({
          chunk,
          signal: new AbortController().signal
        });
      }
    };

    const recovered = await recoverEmptyTranscriptChunk({
      chunk: parent,
      adapter,
      checkpoints,
      dependencies: {
        splitChunk,
        cleanupChunks: async () => undefined,
        now: () => timestamp,
        maxDepth: 3,
        minimumChildDurationSeconds: 30
      }
    });

    expect(recovered).toBeNull();
    expect(splitChunk).toHaveBeenCalledTimes(3);
    expect(checkpoints.audio.get(parent.id)).toMatchObject({
      status: "failed",
      error: { code: "speaker_asr_empty_transcript" }
    });
    expect([...checkpoints.audio.keys()]).toEqual([parent.id]);
    expect([...checkpoints.transcripts.keys()]).toEqual([]);
  });
});
