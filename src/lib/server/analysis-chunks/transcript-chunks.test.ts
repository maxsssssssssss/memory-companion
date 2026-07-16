import { describe, expect, it } from "vitest";
import { buildAudioChunkId, buildTranscriptChunkId, type TranscriptChunk } from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";
import { resolveAnalysisTranscriptChunks } from "./transcript-chunks";

const timestamp = "2026-07-15T08:00:00.000Z";

function segment(index: number, startSeconds: number): TranscriptSegment {
  return {
    id: `upload_1_chunk_${String(index).padStart(5, "0")}_seg_00001`,
    uploadId: "upload_1",
    startSeconds,
    endSeconds: startSeconds + 20,
    speaker: `speaker_${index + 1}`,
    text: `segment ${index}`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function checkpointChunk(index: number, segments: TranscriptSegment[]): TranscriptChunk {
  return {
    id: buildTranscriptChunkId("upload_1", index),
    uploadId: "upload_1",
    audioChunkId: buildAudioChunkId("upload_1", index),
    index,
    startSeconds: index * 300,
    endSeconds: (index + 1) * 300,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries(segments.flatMap((item) => item.speaker ? [[item.speaker, item.speaker]] : [])),
    segments,
    status: "completed",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: { provider: "fixture" }
  };
}

describe("analysis transcript chunk resolver", () => {
  it("projects ASR checkpoint chunks onto the final merged transcript", () => {
    const kept = segment(0, 10);
    const removedBoundaryDuplicate = { ...segment(1, 290), id: "removed_duplicate" };
    const second = segment(1, 310);

    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments: [kept, second],
      checkpointChunks: [
        checkpointChunk(0, [kept, removedBoundaryDuplicate]),
        checkpointChunk(1, [second])
      ],
      now: () => timestamp
    });

    expect(chunks).toHaveLength(2);
    expect(chunks.flatMap((chunk) => chunk.segments.map((item) => item.id))).toEqual([kept.id, second.id]);
    expect(chunks[0].metadata).toMatchObject({ provider: "fixture", analysisSource: "asr_checkpoint" });
  });

  it("deterministically partitions merged transcripts when checkpoints are unavailable", () => {
    const segments = [segment(0, 0), segment(1, 310), segment(2, 620)];
    const first = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      checkpointChunks: [],
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const second = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      checkpointChunks: [],
      maxDurationSeconds: 300,
      now: () => timestamp
    });

    expect(first).toHaveLength(3);
    expect(first).toEqual(second);
    expect(first.every((chunk) => chunk.timebase === "upload_global")).toBe(true);
  });

  it("falls back to merged transcript chunks when checkpoints do not cover every final segment", () => {
    const first = segment(0, 0);
    const missingFromCheckpoint = segment(1, 310);

    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments: [first, missingFromCheckpoint],
      checkpointChunks: [checkpointChunk(0, [first])],
      maxDurationSeconds: 300,
      now: () => timestamp
    });

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.metadata?.analysisSource === "merged_transcript")).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.segments.map((item) => item.id))).toEqual([
      first.id,
      missingFromCheckpoint.id
    ]);
  });
});
