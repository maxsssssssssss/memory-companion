import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it, vi } from "vitest";
import { buildAudioChunkId } from "@/lib/domain/chunks";
import { getFfmpegExecutable } from "@/lib/server/ffmpeg";
import {
  FixedDurationAudioChunkStrategy,
  planAudioChunks,
  probeAudioDurationSeconds,
  splitAudioChunkForEmptyTranscriptRecovery,
  type AudioChunkRange
} from "./audio-planner";

const now = "2026-07-14T08:00:00.000Z";
const execFileAsync = promisify(execFile);

describe("audio chunk planner", () => {
  it("plans and materializes six five-minute chunks for a 30-minute upload", async () => {
    const splitAudio = vi.fn(async () =>
      Array.from({ length: 6 }, (_, index) => `C:/data/uploads/upload_1-chunks/chunk_${String(index).padStart(5, "0")}.mp3`)
    );

    const chunks = await planAudioChunks(
      {
        uploadId: "upload_1",
        filePath: "C:/data/uploads/upload_1.wav",
        mimeType: "audio/wav",
        chunkDurationSeconds: 300
      },
      {
        now: () => now,
        probeDurationSeconds: async () => 1_800,
        splitAudio
      }
    );

    expect(chunks).toHaveLength(6);
    expect(splitAudio).toHaveBeenCalledTimes(1);
    expect(chunks[0]).toMatchObject({
      id: buildAudioChunkId("upload_1", 0),
      index: 0,
      startSeconds: 0,
      endSeconds: 300,
      durationSeconds: 300,
      source: { type: "generated_chunk" },
      status: "created",
      retryCount: 0,
      metadata: {
        strategy: "fixed_duration",
        mimeType: "audio/mpeg",
        originalMimeType: "audio/wav"
      }
    });
    expect(chunks[5]).toMatchObject({ startSeconds: 1_500, endSeconds: 1_800 });
  });

  it("reuses the uploaded file for a short recording", async () => {
    const splitAudio = vi.fn();
    const chunks = await planAudioChunks(
      {
        uploadId: "upload_short",
        filePath: "C:/data/uploads/upload_short.mp3",
        mimeType: "audio/mpeg",
        chunkDurationSeconds: 300
      },
      {
        now: () => now,
        probeDurationSeconds: async () => 120,
        splitAudio
      }
    );

    expect(splitAudio).not.toHaveBeenCalled();
    expect(chunks).toEqual([
      expect.objectContaining({
        id: buildAudioChunkId("upload_short", 0),
        durationSeconds: 120,
        source: { type: "uploaded_audio", path: "C:/data/uploads/upload_short.mp3" }
      })
    ]);
  });

  it("keeps the planning strategy extensible and rejects invalid ranges", () => {
    const strategy = new FixedDurationAudioChunkStrategy(300);
    expect(strategy.plan(650)).toEqual([
      { index: 0, startSeconds: 0, endSeconds: 300 },
      { index: 1, startSeconds: 300, endSeconds: 600 },
      { index: 2, startSeconds: 600, endSeconds: 650 }
    ]);
    expect(() => strategy.plan(0)).toThrow(/duration/i);
  });

  it.each([
    { label: "44:59", durationSeconds: 2_699, expectedChunkCount: 9, expectedLastDurationSeconds: 299 },
    { label: "45:00", durationSeconds: 2_700, expectedChunkCount: 9, expectedLastDurationSeconds: 300 },
    { label: "45:01", durationSeconds: 2_701, expectedChunkCount: 10, expectedLastDurationSeconds: 1 },
    { label: "60:00", durationSeconds: 3_600, expectedChunkCount: 12, expectedLastDurationSeconds: 300 }
  ])(
    "keeps the $label boundary valid and returns chunks for downstream processing",
    async ({ durationSeconds, expectedChunkCount, expectedLastDurationSeconds }) => {
      const splitAudio = vi.fn(async ({ ranges }: { ranges: AudioChunkRange[] }) =>
        ranges.map(
          (_, index) =>
            `C:/data/uploads/upload_boundary-chunks/chunk_${String(index).padStart(5, "0")}.mp3`
        )
      );

      const chunks = await planAudioChunks(
        {
          uploadId: "upload_boundary",
          filePath: "C:/data/uploads/upload_boundary.wav",
          mimeType: "audio/wav",
          chunkDurationSeconds: 300
        },
        {
          now: () => now,
          probeDurationSeconds: async () => durationSeconds,
          splitAudio
        }
      );

      expect(chunks).toHaveLength(expectedChunkCount);
      expect(chunks.every((chunk) => chunk.durationSeconds > 0 && chunk.durationSeconds <= 300)).toBe(true);
      expect(chunks.at(-1)).toMatchObject({
        endSeconds: durationSeconds,
        durationSeconds: expectedLastDurationSeconds
      });
      expect(splitAudio).toHaveBeenCalledTimes(1);
    }
  );

  it("does not let ffmpeg create an endpoint tail chunk at an exact boundary", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "daily-brief-audio-boundary-"));
    const inputPath = join(temporaryDirectory, "exact-boundary.wav");

    try {
      await execFileAsync(getFfmpegExecutable(), [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono",
        "-t",
        "9",
        "-ac",
        "1",
        "-ar",
        "16000",
        inputPath
      ]);

      const chunks = await planAudioChunks(
        {
          uploadId: "upload_exact_boundary",
          filePath: inputPath,
          mimeType: "audio/wav",
          chunkDurationSeconds: 1
        },
        {
          now: () => now
        }
      );
      const physicalDurations = await Promise.all(
        chunks.map((chunk) => probeAudioDurationSeconds(chunk.source.path!))
      );

      expect(chunks).toHaveLength(9);
      expect(chunks.map((chunk) => chunk.durationSeconds)).toEqual(Array.from({ length: 9 }, () => 1));
      expect(physicalDurations.every((duration) => duration >= 0.9 && duration <= 1.1)).toBe(true);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("splits a failed 300-second parent into two globally aligned 150-second recovery chunks", async () => {
    const splitAudio = vi.fn(async () => [
      "C:/data/uploads/upload_1-chunks/recovery/chunk_00000.mp3",
      "C:/data/uploads/upload_1-chunks/recovery/chunk_00001.mp3"
    ]);
    const recoveryChunks = await splitAudioChunkForEmptyTranscriptRecovery(
      {
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
          message: "empty",
          retryable: true
        },
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: now,
        metadata: { mimeType: "audio/mpeg" }
      },
      {
        now: () => now,
        splitAudio
      }
    );

    expect(splitAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkDurationSeconds: 150,
        ranges: [
          { index: 0, startSeconds: 0, endSeconds: 150 },
          { index: 1, startSeconds: 150, endSeconds: 300 }
        ]
      })
    );
    expect(recoveryChunks).toHaveLength(2);
    expect(recoveryChunks.map((chunk) => ({
      id: chunk.id,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      durationSeconds: chunk.durationSeconds
    }))).toEqual([
      {
        id: "upload_1_audio_chunk_00002_recovery_00",
        startSeconds: 600,
        endSeconds: 750,
        durationSeconds: 150
      },
      {
        id: "upload_1_audio_chunk_00002_recovery_01",
        startSeconds: 750,
        endSeconds: 900,
        durationSeconds: 150
      }
    ]);
  });

  it("fails instead of silently dropping a chunk when ffmpeg output count differs", async () => {
    await expect(
      planAudioChunks(
        {
          uploadId: "upload_mismatch",
          filePath: "C:/data/uploads/upload_mismatch.wav",
          mimeType: "audio/wav",
          chunkDurationSeconds: 300
        },
        {
          now: () => now,
          probeDurationSeconds: async () => 900,
          splitAudio: async () => ["C:/data/uploads/upload_mismatch-chunks/chunk_00000.mp3"]
        }
      )
    ).rejects.toThrow(/expected 3 audio chunks/i);
  });
});
