import { describe, expect, it, vi } from "vitest";
import {
  buildAudioChunkId,
  buildTranscriptChunkId,
  type AudioChunk,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import { ChunkTranscriptionError, type ChunkTranscriptionAdapter } from "./adapter";
import type { ChunkCheckpointStore } from "./checkpoint-store";
import { processAudioChunks } from "./scheduler";

const timestamp = "2026-07-14T08:00:00.000Z";

function audioChunk(index: number): AudioChunk {
  return {
    id: buildAudioChunkId("upload_1", index),
    uploadId: "upload_1",
    index,
    startSeconds: index * 300,
    endSeconds: (index + 1) * 300,
    durationSeconds: 300,
    source: { type: "generated_chunk", path: `C:/tmp/chunk_${index}.mp3` },
    status: "created",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {}
  };
}

function transcriptChunk(chunk: AudioChunk): TranscriptChunk {
  return {
    id: buildTranscriptChunkId(chunk.uploadId, chunk.index),
    uploadId: chunk.uploadId,
    audioChunkId: chunk.id,
    index: chunk.index,
    startSeconds: chunk.startSeconds,
    endSeconds: chunk.endSeconds,
    timebase: "upload_global",
    speakerIdScope: "upload",
    speakerMap: {},
    segments: [
      {
        id: `${chunk.uploadId}_chunk_${chunk.index}_seg_1`,
        uploadId: chunk.uploadId,
        startSeconds: chunk.startSeconds + 1,
        endSeconds: chunk.startSeconds + 2,
        speaker: "speaker_1",
        text: `chunk ${chunk.index}`,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }
    ],
    status: "completed",
    retryCount: chunk.retryCount,
    createdAt: chunk.createdAt,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: {}
  };
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
    async saveAudioChunk(value) {
      audio.set(value.id, structuredClone(value));
    },
    async saveTranscriptChunk(value) {
      transcripts.set(value.id, structuredClone(value));
    },
    async listAudioChunks(uploadId) {
      return [...audio.values()].filter((item) => item.uploadId === uploadId);
    },
    async listTranscriptChunks(uploadId) {
      return [...transcripts.values()].filter((item) => item.uploadId === uploadId);
    },
    async deleteUpload(uploadId) {
      for (const [id, value] of audio) if (value.uploadId === uploadId) audio.delete(id);
      for (const [id, value] of transcripts) if (value.uploadId === uploadId) transcripts.delete(id);
    }
  };
}

describe("chunk scheduler", () => {
  it("enforces bounded concurrency instead of starting every chunk", async () => {
    let active = 0;
    let maxActive = 0;
    const adapter: ChunkTranscriptionAdapter = {
      name: "fake",
      async transcribeChunk({ chunk }) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return transcriptChunk(chunk);
      }
    };

    const result = await processAudioChunks({
      chunks: Array.from({ length: 6 }, (_, index) => audioChunk(index)),
      adapter,
      checkpoints: recordingCheckpoints(),
      options: { concurrency: 2, maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(maxActive).toBe(2);
    expect(result.completed).toHaveLength(6);
    expect(result.failed).toEqual([]);
  });

  it.each(["submit_failed", "query_failed"])(
    "retries a retryable %s chunk failure and records retryCount",
    async (failureCode) => {
    const attempts = new Map<number, number>();
    const checkpoints = recordingCheckpoints();
    const adapter: ChunkTranscriptionAdapter = {
      name: "fake",
      async transcribeChunk({ chunk }) {
        const attempt = (attempts.get(chunk.index) ?? 0) + 1;
        attempts.set(chunk.index, attempt);
        if (attempt === 1) {
          throw new ChunkTranscriptionError(failureCode, "temporary provider failure", true);
        }
        return transcriptChunk(chunk);
      }
    };

    const result = await processAudioChunks({
      chunks: [audioChunk(0)],
      adapter,
      checkpoints,
      options: {
        concurrency: 1,
        maxRetries: 1,
        retryDelayMs: 0,
        attemptTimeoutMs: 1_000,
        now: () => timestamp
      }
    });

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].retryCount).toBe(1);
    expect(checkpoints.audio.get(buildAudioChunkId("upload_1", 0))).toMatchObject({
      status: "completed",
      retryCount: 1
    });
    }
  );

  it("isolates a final failure and redacts tokens while other chunks complete", async () => {
    const checkpoints = recordingCheckpoints();
    const adapter: ChunkTranscriptionAdapter = {
      name: "fake",
      async transcribeChunk({ chunk }) {
        if (chunk.index === 1) {
          throw new ChunkTranscriptionError(
            "query_failed",
            "download failed: https://example.test/audio?token=secret-value",
            false
          );
        }
        return transcriptChunk(chunk);
      }
    };

    const result = await processAudioChunks({
      chunks: [audioChunk(0), audioChunk(1), audioChunk(2)],
      adapter,
      checkpoints,
      options: { concurrency: 2, maxRetries: 1, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(result.completed.map((chunk) => chunk.index)).toEqual([0, 2]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ status: "failed", error: { code: "query_failed" } });
    expect(result.failed[0].error?.message).toContain("token=****");
    expect(result.failed[0].error?.message).not.toContain("secret-value");
  });

  it("retries an attempt timeout and completes on the next attempt", async () => {
    const checkpoints = recordingCheckpoints();
    let attempts = 0;
    const adapter: ChunkTranscriptionAdapter = {
      name: "fake",
      async transcribeChunk({ chunk, signal }) {
        attempts += 1;
        if (attempts > 1) {
          return transcriptChunk(chunk);
        }
        return await new Promise<TranscriptChunk>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };

    const result = await processAudioChunks({
      chunks: [audioChunk(0)],
      adapter,
      checkpoints,
      options: {
        concurrency: 1,
        maxRetries: 1,
        retryDelayMs: 0,
        attemptTimeoutMs: 20,
        now: () => timestamp
      }
    });

    expect(result.failed).toEqual([]);
    expect(result.completed[0]).toMatchObject({ retryCount: 1 });
  });
});
