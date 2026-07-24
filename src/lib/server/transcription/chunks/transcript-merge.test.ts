import { describe, expect, it, vi } from "vitest";
import { buildAudioChunkId, type AudioChunk, type TranscriptChunk } from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";
import { createTranscriptChunkFromLocalSegments, mergeTranscriptChunks } from "./transcript-merge";

const timestamp = "2026-07-14T08:00:00.000Z";

function audioChunk(index: number, range?: { startSeconds: number; endSeconds: number }): AudioChunk {
  const startSeconds = range?.startSeconds ?? index * 300;
  const endSeconds = range?.endSeconds ?? (index + 1) * 300;
  return {
    id: buildAudioChunkId("upload_1", index),
    uploadId: "upload_1",
    index,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    source: { type: "generated_chunk", path: `C:/tmp/chunk_${index}.mp3` },
    status: "processing",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    metadata: {}
  };
}

function localSegment(
  index: number,
  startSeconds: number,
  endSeconds: number,
  overrides: Partial<TranscriptSegment> = {}
): TranscriptSegment {
  return {
    id: `provider_local_${index}`,
    uploadId: "upload_1",
    startSeconds,
    endSeconds,
    speaker: `speaker_${index}`,
    text: `local segment ${index}`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: [],
    ...overrides
  };
}

describe("transcript chunk merge", () => {
  it("converts chunk-local timestamps to the upload-global timeline", () => {
    const chunk = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(1),
      localSegments: [localSegment(1, 0, 30), localSegment(2, 45, 60)],
      providerMetadata: { provider: "speaker-asr", requestId: "req_1" },
      now: () => timestamp
    });

    expect(chunk.segments.map((segment) => [segment.startSeconds, segment.endSeconds])).toEqual([
      [300, 330],
      [345, 360]
    ]);
    expect(chunk.segments.map((segment) => segment.id)).toEqual([
      "upload_1_chunk_00001_seg_00001",
      "upload_1_chunk_00001_seg_00002"
    ]);
    expect(chunk.speakerMap).toEqual({ speaker_1: "speaker_1", speaker_2: "speaker_2" });
    expect(chunk.metadata).toEqual({
      provider: "speaker-asr",
      requestId: "req_1",
      segmentSources: {
        upload_1_chunk_00001_seg_00001: { originalSegmentId: "provider_local_1" },
        upload_1_chunk_00001_seg_00002: { originalSegmentId: "provider_local_2" }
      }
    });
  });

  it("merges chunks chronologically with unique ids and preserves speakers", () => {
    const first = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(0),
      localSegments: [localSegment(1, 20, 40)],
      now: () => timestamp
    });
    const second = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(1),
      localSegments: [localSegment(1, 2, 10)],
      now: () => timestamp
    });

    const merged = mergeTranscriptChunks([second, first]);

    expect(merged.segments.map((segment) => segment.startSeconds)).toEqual([20, 302]);
    expect(new Set(merged.segments.map((segment) => segment.id)).size).toBe(2);
    expect(merged.segments.map((segment) => segment.speaker)).toEqual(["speaker_1", "speaker_1"]);
    expect(merged.stats).toEqual({
      chunkCount: 2,
      inputSegmentCount: 2,
      segmentCount: 2,
      duplicateRemoved: 0
    });
    expect(merged.segmentSources["upload_1_chunk_00000_seg_00001"]).toEqual({
      chunkId: "upload_1_transcript_chunk_00000",
      chunkIndex: 0,
      originalSegmentId: "provider_local_1",
      speakerIdScope: "chunk"
    });
  });

  it("rebuilds provider-local duplicate ids into stable upload-global ids", () => {
    const first = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(0),
      localSegments: [localSegment(1, 20, 40)],
      now: () => timestamp
    });
    const second = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(1),
      localSegments: [localSegment(1, 2, 10)],
      now: () => timestamp
    });
    const providerChunks: TranscriptChunk[] = [first, second].map((chunk) => ({
      ...chunk,
      metadata: {},
      segments: chunk.segments.map((segment) => ({ ...segment, id: "seg_1" }))
    }));

    const merged = mergeTranscriptChunks(providerChunks);

    expect(merged.segments.map((segment) => segment.id)).toEqual([
      "upload_1_chunk_00000_seg_00001",
      "upload_1_chunk_00001_seg_00001"
    ]);
    expect(Object.values(merged.segmentSources).map((source) => source.originalSegmentId)).toEqual([
      "seg_1",
      "seg_1"
    ]);
  });

  it("exposes a speaker reconciliation hook without changing the default", () => {
    const chunk = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(0),
      localSegments: [localSegment(1, 1, 5)],
      now: () => timestamp
    });
    const reconcileSpeakers = vi.fn((chunks: TranscriptChunk[]) =>
      chunks.map((item) => ({
        ...item,
        speakerIdScope: "upload" as const,
        speakerMap: {},
        segments: item.segments.map((segment) => ({ ...segment, speaker: "person_a" }))
      }))
    );

    expect(mergeTranscriptChunks([chunk], { reconcileSpeakers }).segments[0].speaker).toBe("person_a");
    expect(reconcileSpeakers).toHaveBeenCalledTimes(1);
  });

  it("preserves global identity metadata without replacing the chunk-local speaker", () => {
    const chunk = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(0),
      localSegments: [localSegment(1, 1, 5)],
      now: () => timestamp
    });
    const identified = {
      ...chunk,
      speakerMap: { speaker_1: "person_a" },
      segments: chunk.segments.map((segment) => ({
        ...segment,
        identity: {
          globalSpeakerId: "person_a",
          identityType: "unknown_person" as const,
          confidence: 0.91,
          source: "cross_chunk_matching" as const
        }
      }))
    };

    const segment = mergeTranscriptChunks([identified]).segments[0];

    expect(segment.speaker).toBe("speaker_1");
    expect(segment.identity?.globalSpeakerId).toBe("person_a");
  });

  it("removes a highly similar same-speaker duplicate at an overlapping chunk boundary", () => {
    const first = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(0),
      localSegments: [
        localSegment(1, 296, 300, { speaker: "speaker_1", text: "我们周末去公园看看展览" })
      ],
      now: () => timestamp
    });
    const second = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(1, { startSeconds: 295, endSeconds: 595 }),
      localSegments: [
        localSegment(1, 1, 6, { speaker: "speaker_1", text: "周末去公园看看展览" })
      ],
      now: () => timestamp
    });

    const merged = mergeTranscriptChunks([first, second]);

    expect(merged.segments).toHaveLength(1);
    expect(merged.segments[0].text).toBe("我们周末去公园看看展览");
    expect(merged.stats.duplicateRemoved).toBe(1);
    expect(merged.warnings).toContain("removed 1 overlapping boundary duplicate(s)");
  });

  it("does not deduplicate similar overlapping text from different speakers", () => {
    const first = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(0),
      localSegments: [localSegment(1, 296, 300, { speaker: "speaker_1", text: "周末去公园看看展览" })],
      now: () => timestamp
    });
    const second = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(1, { startSeconds: 295, endSeconds: 595 }),
      localSegments: [localSegment(1, 1, 6, { speaker: "speaker_2", text: "周末去公园看看展览" })],
      now: () => timestamp
    });

    const merged = mergeTranscriptChunks([first, second]);

    expect(merged.segments).toHaveLength(2);
    expect(merged.stats.duplicateRemoved).toBe(0);
  });

  it("rejects transcript segments outside their chunk range", () => {
    const chunk = createTranscriptChunkFromLocalSegments({
      chunk: audioChunk(0),
      localSegments: [localSegment(1, 1, 5)],
      now: () => timestamp
    });
    const invalid = {
      ...chunk,
      segments: [{ ...chunk.segments[0], endSeconds: 301 }]
    };

    expect(() => mergeTranscriptChunks([invalid])).toThrow(/global chunk range/);
  });
});
