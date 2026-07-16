import {
  TranscriptChunkMergeInputSchema,
  TranscriptChunkMergeResultSchema,
  TranscriptChunkSchema,
  buildTranscriptChunkId,
  type AudioChunk,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";

export type SpeakerReconciler = (chunks: TranscriptChunk[]) => TranscriptChunk[];

export type TranscriptSegmentSource = {
  chunkId: string;
  chunkIndex: number;
  originalSegmentId: string;
  speakerIdScope: TranscriptChunk["speakerIdScope"];
};

export type TranscriptMergeStats = {
  chunkCount: number;
  inputSegmentCount: number;
  segmentCount: number;
  duplicateRemoved: number;
};

export type TranscriptMergeResult = {
  uploadId: string | null;
  segments: TranscriptSegment[];
  segmentSources: Record<string, TranscriptSegmentSource>;
  stats: TranscriptMergeStats;
  warnings: string[];
};

type SegmentCandidate = {
  segment: TranscriptSegment;
  source: TranscriptSegmentSource;
};

const SOURCE_METADATA_KEY = "segmentSources";
const MIN_DUPLICATE_TEXT_LENGTH = 4;
const MIN_TIME_OVERLAP_RATIO = 0.6;
const MIN_TEXT_SIMILARITY = 0.78;

function buildChunkSegmentId(uploadId: string, chunkIndex: number, segmentIndex: number) {
  return `${uploadId}_chunk_${String(chunkIndex).padStart(5, "0")}_seg_${String(segmentIndex + 1).padStart(5, "0")}`;
}

export function createTranscriptChunkFromLocalSegments(input: {
  chunk: AudioChunk;
  localSegments: TranscriptSegment[];
  providerMetadata?: Record<string, unknown>;
  now?: () => string;
}): TranscriptChunk {
  const now = input.now ?? (() => new Date().toISOString());
  const finishedAt = now();
  const speakers = new Set<string>();
  const segmentSources: Record<string, { originalSegmentId: string }> = {};
  const segments = input.localSegments.flatMap((segment, segmentIndex): TranscriptSegment[] => {
    const localStart = Math.max(0, segment.startSeconds);
    if (localStart >= input.chunk.durationSeconds) {
      return [];
    }
    const localEnd = Math.min(
      input.chunk.durationSeconds,
      Math.max(localStart + 0.1, segment.endSeconds)
    );
    if (localEnd <= localStart) {
      return [];
    }
    if (segment.speaker) {
      speakers.add(segment.speaker);
    }
    const id = buildChunkSegmentId(input.chunk.uploadId, input.chunk.index, segmentIndex);
    segmentSources[id] = { originalSegmentId: segment.id };
    return [
      {
        ...segment,
        id,
        uploadId: input.chunk.uploadId,
        startSeconds: Number((input.chunk.startSeconds + localStart).toFixed(3)),
        endSeconds: Number((input.chunk.startSeconds + localEnd).toFixed(3))
      }
    ];
  });

  return TranscriptChunkSchema.parse({
    id: buildTranscriptChunkId(input.chunk.uploadId, input.chunk.index),
    uploadId: input.chunk.uploadId,
    audioChunkId: input.chunk.id,
    index: input.chunk.index,
    startSeconds: input.chunk.startSeconds,
    endSeconds: input.chunk.endSeconds,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries([...speakers].map((speaker) => [speaker, speaker])),
    segments,
    status: "completed",
    retryCount: input.chunk.retryCount,
    createdAt: input.chunk.createdAt,
    updatedAt: finishedAt,
    startedAt: input.chunk.startedAt ?? input.chunk.createdAt,
    finishedAt,
    metadata: {
      ...(input.providerMetadata ?? {}),
      [SOURCE_METADATA_KEY]: segmentSources
    }
  });
}

function normalizeComparableText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function characterBigrams(value: string) {
  if (value.length < 2) {
    return new Set(value ? [value] : []);
  }
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
}

function textSimilarity(leftText: string, rightText: string) {
  const left = normalizeComparableText(leftText);
  const right = normalizeComparableText(rightText);
  if (Math.min(left.length, right.length) < MIN_DUPLICATE_TEXT_LENGTH) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }

  const leftBigrams = characterBigrams(left);
  const rightBigrams = characterBigrams(right);
  const intersection = [...leftBigrams].filter((bigram) => rightBigrams.has(bigram)).length;
  return (2 * intersection) / Math.max(1, leftBigrams.size + rightBigrams.size);
}

function timeOverlapRatio(left: TranscriptSegment, right: TranscriptSegment) {
  const overlap = Math.max(
    0,
    Math.min(left.endSeconds, right.endSeconds) - Math.max(left.startSeconds, right.startSeconds)
  );
  const shorterDuration = Math.min(
    left.endSeconds - left.startSeconds,
    right.endSeconds - right.startSeconds
  );
  return shorterDuration > 0 ? overlap / shorterDuration : 0;
}

function isBoundaryDuplicate(left: SegmentCandidate, right: SegmentCandidate) {
  return (
    Math.abs(left.source.chunkIndex - right.source.chunkIndex) === 1 &&
    Boolean(left.segment.speaker) &&
    left.segment.speaker === right.segment.speaker &&
    timeOverlapRatio(left.segment, right.segment) >= MIN_TIME_OVERLAP_RATIO &&
    textSimilarity(left.segment.text, right.segment.text) >= MIN_TEXT_SIMILARITY
  );
}

function preferredDuplicate(left: SegmentCandidate, right: SegmentCandidate) {
  const leftLength = normalizeComparableText(left.segment.text).length;
  const rightLength = normalizeComparableText(right.segment.text).length;
  if (leftLength !== rightLength) {
    return rightLength > leftLength ? right : left;
  }
  if (left.segment.confidence !== right.segment.confidence) {
    return right.segment.confidence > left.segment.confidence ? right : left;
  }
  return left.source.chunkIndex <= right.source.chunkIndex ? left : right;
}

function originalSegmentId(chunk: TranscriptChunk, segmentId: string) {
  const rawSources = chunk.metadata[SOURCE_METADATA_KEY];
  if (!rawSources || typeof rawSources !== "object" || Array.isArray(rawSources)) {
    return segmentId;
  }
  const rawSource = (rawSources as Record<string, unknown>)[segmentId];
  if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) {
    return segmentId;
  }
  const value = (rawSource as Record<string, unknown>).originalSegmentId;
  return typeof value === "string" && value.trim() ? value : segmentId;
}

function normalizeChunkSegmentIds(inputChunks: TranscriptChunk[]) {
  return inputChunks.map((rawChunk) => {
    const chunk = TranscriptChunkSchema.parse(rawChunk);
    const sources: Record<string, { originalSegmentId: string }> = {};
    const segments = chunk.segments.map((segment, segmentIndex) => {
      const id = buildChunkSegmentId(chunk.uploadId, chunk.index, segmentIndex);
      sources[id] = { originalSegmentId: originalSegmentId(chunk, segment.id) };
      return { ...segment, id };
    });

    return TranscriptChunkSchema.parse({
      ...chunk,
      segments,
      metadata: {
        ...chunk.metadata,
        [SOURCE_METADATA_KEY]: sources
      }
    });
  });
}

function segmentCandidates(chunks: TranscriptChunk[]) {
  return chunks
    .flatMap((chunk) =>
      chunk.segments.map((segment): SegmentCandidate => ({
        segment,
        source: {
          chunkId: chunk.id,
          chunkIndex: chunk.index,
          originalSegmentId: originalSegmentId(chunk, segment.id),
          speakerIdScope: chunk.speakerIdScope
        }
      }))
    )
    .sort(
      (left, right) =>
        left.segment.startSeconds - right.segment.startSeconds ||
        left.segment.endSeconds - right.segment.endSeconds ||
        left.source.chunkIndex - right.source.chunkIndex ||
        left.segment.id.localeCompare(right.segment.id)
    );
}

function removeBoundaryDuplicates(candidates: SegmentCandidate[]) {
  const kept: SegmentCandidate[] = [];
  let duplicateRemoved = 0;

  for (const candidate of candidates) {
    const duplicateIndex = kept.findIndex((existing) => isBoundaryDuplicate(existing, candidate));
    if (duplicateIndex < 0) {
      kept.push(candidate);
      continue;
    }
    kept[duplicateIndex] = preferredDuplicate(kept[duplicateIndex], candidate);
    duplicateRemoved += 1;
  }

  return { kept, duplicateRemoved };
}

export function mergeTranscriptChunks(
  inputChunks: TranscriptChunk[],
  options: { reconcileSpeakers?: SpeakerReconciler } = {}
): TranscriptMergeResult {
  if (inputChunks.length === 0) {
    return {
      uploadId: null,
      segments: [],
      segmentSources: {},
      stats: { chunkCount: 0, inputSegmentCount: 0, segmentCount: 0, duplicateRemoved: 0 },
      warnings: []
    };
  }

  const uploadId = inputChunks[0].uploadId;
  const normalizedChunks = normalizeChunkSegmentIds(inputChunks);
  const parsedChunks = TranscriptChunkMergeInputSchema.parse({ uploadId, chunks: normalizedChunks }).chunks;
  const reconciledChunks = options.reconcileSpeakers
    ? TranscriptChunkMergeInputSchema.parse({
        uploadId,
        chunks: options.reconcileSpeakers(parsedChunks)
      }).chunks
    : parsedChunks;
  const candidates = segmentCandidates(reconciledChunks);
  const { kept, duplicateRemoved } = removeBoundaryDuplicates(candidates);
  const segments = kept.map((candidate) => candidate.segment);

  const validated = TranscriptChunkMergeResultSchema.parse({
    uploadId,
    sourceChunkIds: reconciledChunks.map((chunk) => chunk.id),
    startSeconds: Math.min(...reconciledChunks.map((chunk) => chunk.startSeconds)),
    endSeconds: Math.max(...reconciledChunks.map((chunk) => chunk.endSeconds)),
    timebase: "upload_global",
    speakerIdScope: "upload",
    segments
  });
  const warnings: string[] = [];
  if (reconciledChunks.some((chunk) => chunk.speakerIdScope === "chunk")) {
    warnings.push("speaker ids remain chunk-local and have not been reconciled across chunks");
  }
  if (duplicateRemoved > 0) {
    warnings.push(`removed ${duplicateRemoved} overlapping boundary duplicate(s)`);
  }

  return {
    uploadId: validated.uploadId,
    segments: validated.segments,
    segmentSources: Object.fromEntries(kept.map((candidate) => [candidate.segment.id, candidate.source])),
    stats: {
      chunkCount: reconciledChunks.length,
      inputSegmentCount: candidates.length,
      segmentCount: validated.segments.length,
      duplicateRemoved
    },
    warnings
  };
}
