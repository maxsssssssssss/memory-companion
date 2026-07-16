import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import {
  AnalysisChunkSchema,
  AudioChunkSchema,
  AudioChunkSetSchema,
  TranscriptChunkMergeInputSchema,
  TranscriptChunkMergeResultSchema,
  TranscriptChunkSchema,
  TranscriptChunkSetSchema,
  buildAudioChunkId,
  buildTranscriptChunkId
} from "./index";

const createdAt = "2026-07-14T08:00:00.000Z";

function transcriptSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "upload_1_seg_1",
    uploadId: "upload_1",
    startSeconds: 60,
    endSeconds: 75,
    speaker: "speaker_1",
    text: "我们周五之前再确认一次。",
    confidence: 0.91,
    sceneLabels: ["self_reflection"],
    valueLabels: ["commitment"],
    ...overrides
  };
}

function audioChunk(index = 0) {
  const startSeconds = index * 60;
  return {
    id: buildAudioChunkId("upload_1", index),
    uploadId: "upload_1",
    index,
    startSeconds,
    endSeconds: startSeconds + 60,
    durationSeconds: 60,
    source: {
      type: "generated_chunk" as const,
      path: `C:/tmp/chunk_${index}.mp3`
    },
    status: "created" as const,
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
    metadata: {}
  };
}

function transcriptChunk(index = 0) {
  const startSeconds = index * 60;
  const segment = transcriptSegment({
    id: `upload_1_seg_${index + 1}`,
    startSeconds: startSeconds + 1,
    endSeconds: startSeconds + 15
  });

  return {
    id: buildTranscriptChunkId("upload_1", index),
    uploadId: "upload_1",
    audioChunkId: buildAudioChunkId("upload_1", index),
    index,
    startSeconds,
    endSeconds: startSeconds + 60,
    timebase: "upload_global" as const,
    speakerIdScope: "upload" as const,
    speakerMap: {},
    segments: [segment],
    status: "completed" as const,
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    metadata: {}
  };
}

describe("unified chunk domain", () => {
  it("accepts a provider-neutral audio chunk with a stable id", () => {
    const parsed = AudioChunkSchema.parse({
      ...audioChunk(),
      metadata: { providerRequestId: "request_123" }
    });

    expect(parsed.id).toBe("upload_1_audio_chunk_00000");
    expect(parsed.durationSeconds).toBe(60);
    expect(parsed.metadata).toEqual({ providerRequestId: "request_123" });
  });

  it("rejects invalid audio time ranges and inconsistent durations", () => {
    expect(() => AudioChunkSchema.parse({ ...audioChunk(), endSeconds: 0 })).toThrow();
    expect(() => AudioChunkSchema.parse({ ...audioChunk(), durationSeconds: 30 })).toThrow();
  });

  it("rejects duplicate audio chunk indices", () => {
    expect(() =>
      AudioChunkSetSchema.parse({
        uploadId: "upload_1",
        chunks: [audioChunk(0), { ...audioChunk(1), index: 0 }]
      })
    ).toThrow(/index/i);
  });

  it("requires transcript timestamps to use the global upload timeline", () => {
    const parsed = TranscriptChunkSchema.parse(transcriptChunk(1));
    expect(parsed.segments[0].startSeconds).toBe(61);

    expect(() =>
      TranscriptChunkSchema.parse({
        ...transcriptChunk(1),
        segments: [transcriptSegment({ startSeconds: 1, endSeconds: 15 })]
      })
    ).toThrow(/global chunk range/i);
  });

  it("requires chunk-local speaker ids to have an upload-level mapping", () => {
    expect(() =>
      TranscriptChunkSchema.parse({
        ...transcriptChunk(),
        speakerIdScope: "chunk",
        speakerMap: {}
      })
    ).toThrow(/speakerMap/i);

    const parsed = TranscriptChunkSchema.parse({
      ...transcriptChunk(),
      speakerIdScope: "chunk",
      speakerMap: { speaker_1: "person_a" }
    });
    expect(parsed.speakerMap).toEqual({ speaker_1: "person_a" });
  });

  it("rejects duplicate transcript segment ids across chunks", () => {
    const second = transcriptChunk(1);
    second.segments[0].id = transcriptChunk(0).segments[0].id;

    expect(() =>
      TranscriptChunkSetSchema.parse({ uploadId: "upload_1", chunks: [transcriptChunk(0), second] })
    ).toThrow(/segment id/i);
  });

  it("validates transcript merge input and globally ordered output", () => {
    const chunks = [transcriptChunk(0), transcriptChunk(1)];
    const input = TranscriptChunkMergeInputSchema.parse({ uploadId: "upload_1", chunks });
    expect(input.chunks).toHaveLength(2);

    const result = TranscriptChunkMergeResultSchema.parse({
      uploadId: "upload_1",
      sourceChunkIds: chunks.map((chunk) => chunk.id),
      startSeconds: 0,
      endSeconds: 120,
      timebase: "upload_global",
      speakerIdScope: "upload",
      segments: chunks.flatMap((chunk) => chunk.segments)
    });
    expect(result.segments.map((segment) => segment.id)).toEqual(["upload_1_seg_1", "upload_1_seg_2"]);

    expect(() =>
      TranscriptChunkMergeResultSchema.parse({
        ...result,
        segments: [...result.segments].reverse()
      })
    ).toThrow(/chronological/i);
  });

  it("keeps provider-specific fields inside metadata", () => {
    expect(() => AudioChunkSchema.parse({ ...audioChunk(), speakerAsrReqId: "req_1" })).toThrow(/unrecognized/i);

    const analysis = AnalysisChunkSchema.parse({
      id: "upload_1_analysis_chunk_00000",
      uploadId: "upload_1",
      index: 0,
      kind: "relationship_signal",
      startSeconds: 0,
      endSeconds: 60,
      timebase: "upload_global",
      transcriptChunkIds: [buildTranscriptChunkId("upload_1", 0)],
      sourceSegmentIds: ["upload_1_seg_1"],
      outputIds: [],
      status: "created",
      retryCount: 0,
      createdAt,
      updatedAt: createdAt,
      metadata: { providerRequestId: "req_1" }
    });
    expect(analysis.metadata).toEqual({ providerRequestId: "req_1" });
  });
});
