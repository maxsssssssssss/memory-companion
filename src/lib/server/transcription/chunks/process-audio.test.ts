import { describe, expect, it, vi } from "vitest";
import { buildAudioChunkId, type AudioChunk, type TranscriptChunk } from "@/lib/domain/chunks";
import { ChunkTranscriptionError, type ChunkTranscriptionAdapter } from "./adapter";
import type { ChunkCheckpointStore } from "./checkpoint-store";
import {
  IncompleteChunkTranscriptionError,
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

function successfulAdapter(): ChunkTranscriptionAdapter {
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
            speaker: "speaker_1",
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

describe("chunked audio transcription orchestration", () => {
  it("simulates a 30-minute upload as six chunks and returns the legacy TranscriptSegment shape", async () => {
    const planned = chunks(6);
    const planner = vi.fn(async () => planned);
    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store: {} as never
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
          store: {} as never
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

  it("does not discard a valid transcript when temporary chunk cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await transcribeSpeakerAsrAudioInChunks(
      {
        uploadId: "upload_30m",
        filePath: "C:/tmp/source.wav",
        mimeType: "audio/wav",
        userId: "user_1",
        store: {} as never
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
});
