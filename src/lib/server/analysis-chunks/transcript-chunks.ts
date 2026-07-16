import {
  TranscriptChunkSetSchema,
  TranscriptChunkSchema,
  buildAudioChunkId,
  buildTranscriptChunkId,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";

const DEFAULT_MAX_DURATION_SECONDS = 5 * 60;
const DEFAULT_MAX_SEGMENTS = 50;

function sortedSegments(segments: TranscriptSegment[]) {
  return [...segments].sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.endSeconds - right.endSeconds ||
      left.id.localeCompare(right.id)
  );
}

function projectCheckpointChunks(input: {
  uploadId: string;
  segments: TranscriptSegment[];
  checkpointChunks: TranscriptChunk[];
}) {
  const finalById = new Map(input.segments.map((segment) => [segment.id, segment]));
  return [...input.checkpointChunks]
    .sort((left, right) => left.index - right.index)
    .flatMap((chunk): TranscriptChunk[] => {
      if (chunk.uploadId !== input.uploadId || chunk.status !== "completed") {
        return [];
      }
      const segments = chunk.segments.flatMap((segment) => {
        const finalSegment = finalById.get(segment.id);
        return finalSegment ? [finalSegment] : [];
      });
      if (segments.length === 0) {
        return [];
      }
      return [
        TranscriptChunkSchema.parse({
          ...chunk,
          segments,
          metadata: { ...chunk.metadata, analysisSource: "asr_checkpoint" }
        })
      ];
    });
}

function partitionSegments(input: {
  segments: TranscriptSegment[];
  maxDurationSeconds: number;
  maxSegments: number;
}) {
  const groups: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];

  for (const segment of sortedSegments(input.segments)) {
    const candidate = [...current, segment];
    const duration = candidate.at(-1)!.endSeconds - candidate[0].startSeconds;
    if (
      current.length > 0 &&
      (candidate.length > input.maxSegments || duration > input.maxDurationSeconds)
    ) {
      groups.push(current);
      current = [segment];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function derivedChunks(input: {
  uploadId: string;
  segments: TranscriptSegment[];
  maxDurationSeconds: number;
  maxSegments: number;
  now: () => string;
}) {
  const createdAt = input.now();
  return partitionSegments(input).map((segments, index) =>
    TranscriptChunkSchema.parse({
      id: buildTranscriptChunkId(input.uploadId, index),
      uploadId: input.uploadId,
      audioChunkId: buildAudioChunkId(input.uploadId, index),
      index,
      startSeconds: segments[0].startSeconds,
      endSeconds: segments.at(-1)!.endSeconds,
      timebase: "upload_global",
      speakerIdScope: "upload",
      speakerMap: {},
      segments,
      status: "completed",
      retryCount: 0,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
      metadata: { analysisSource: "merged_transcript" }
    })
  );
}

export function resolveAnalysisTranscriptChunks(input: {
  uploadId: string;
  segments: TranscriptSegment[];
  checkpointChunks?: TranscriptChunk[];
  maxDurationSeconds?: number;
  maxSegments?: number;
  now?: () => string;
}): TranscriptChunk[] {
  const segments = sortedSegments(input.segments).filter((segment) => segment.uploadId === input.uploadId);
  if (segments.length === 0) {
    return [];
  }

  const projected = projectCheckpointChunks({
    uploadId: input.uploadId,
    segments,
    checkpointChunks: input.checkpointChunks ?? []
  });
  const projectedIds = new Set(projected.flatMap((chunk) => chunk.segments.map((segment) => segment.id)));
  const projectedSet = TranscriptChunkSetSchema.safeParse({ uploadId: input.uploadId, chunks: projected });
  if (projected.length > 0 && projectedIds.size === segments.length && projectedSet.success) {
    return projected;
  }

  return derivedChunks({
    uploadId: input.uploadId,
    segments,
    maxDurationSeconds: input.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS,
    maxSegments: input.maxSegments ?? DEFAULT_MAX_SEGMENTS,
    now: input.now ?? (() => new Date().toISOString())
  });
}
