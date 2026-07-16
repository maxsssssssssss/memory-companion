import { describe, expect, it, vi } from "vitest";
import { buildAudioChunkId } from "@/lib/domain/chunks";
import { FixedDurationAudioChunkStrategy, planAudioChunks } from "./audio-planner";

const now = "2026-07-14T08:00:00.000Z";

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
