import type { SemanticSegment, TranscriptSegment } from "@/lib/domain/types";

const LONG_FORM_DURATION_SECONDS = 20 * 60;
const LONG_FORM_SEGMENT_COUNT = 60;
const LONG_FORM_INPUT_CHARS = 12_000;
const MAX_CHUNK_SEGMENTS = 50;
const MAX_CHUNK_DURATION_SECONDS = 12 * 60;
const MAX_CHUNK_INPUT_CHARS = 8_000;

export type ExtractionChunk = {
  id: string;
  index: number;
  segments: TranscriptSegment[];
  startSeconds: number;
  endSeconds: number;
  inputChars: number;
  inputBytes: number;
  exceedsLimits: boolean;
};

export type ExtractionChunkPlan = {
  longForm: boolean;
  chunks: ExtractionChunk[];
  segmentCount: number;
  durationSeconds: number;
  inputChars: number;
  inputBytes: number;
  estimatedTokensMin: number;
  estimatedTokensMax: number;
  oversizedChunkCount: number;
};

export function formatExtractionSegments(segments: TranscriptSegment[]) {
  return segments
    .map(
      (segment) =>
        `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s ${segment.speaker ?? "speaker"}: ${segment.text}`
    )
    .join("\n");
}

function sortedSegments(segments: TranscriptSegment[]) {
  return [...segments].sort(
    (left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds || left.id.localeCompare(right.id)
  );
}

function timeRange(segments: TranscriptSegment[]) {
  if (segments.length === 0) {
    return { startSeconds: 0, endSeconds: 0, durationSeconds: 0 };
  }

  const startSeconds = Math.min(...segments.map((segment) => segment.startSeconds));
  const endSeconds = Math.max(...segments.map((segment) => segment.endSeconds));
  return {
    startSeconds,
    endSeconds,
    durationSeconds: Math.max(0, endSeconds - startSeconds)
  };
}

function inputMetrics(segments: TranscriptSegment[]) {
  const prompt = formatExtractionSegments(segments);
  return {
    inputChars: prompt.length,
    inputBytes: Buffer.byteLength(prompt, "utf8")
  };
}

function isLongForm(segments: TranscriptSegment[], durationSeconds: number, inputChars: number) {
  return (
    durationSeconds >= LONG_FORM_DURATION_SECONDS ||
    segments.length > LONG_FORM_SEGMENT_COUNT ||
    inputChars > LONG_FORM_INPUT_CHARS
  );
}

function distanceToGroup(segment: TranscriptSegment, group: TranscriptSegment[]) {
  const range = timeRange(group);
  const midpoint = (segment.startSeconds + segment.endSeconds) / 2;
  if (midpoint < range.startSeconds) {
    return range.startSeconds - midpoint;
  }
  if (midpoint > range.endSeconds) {
    return midpoint - range.endSeconds;
  }
  return 0;
}

function semanticGroups(segments: TranscriptSegment[], semanticSegments: SemanticSegment[]) {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const assignedIds = new Set<string>();
  const groups = [...semanticSegments]
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds)
    .map((semanticSegment) =>
      semanticSegment.sourceSegmentIds.flatMap((segmentId) => {
        const segment = segmentById.get(segmentId);
        if (!segment || assignedIds.has(segment.id)) {
          return [];
        }
        assignedIds.add(segment.id);
        return [segment];
      })
    )
    .filter((group) => group.length > 0)
    .map(sortedSegments);

  const unassigned = segments.filter((segment) => !assignedIds.has(segment.id));
  if (groups.length === 0) {
    return [segments];
  }

  for (const segment of unassigned) {
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    groups.forEach((group, index) => {
      const distance = distanceToGroup(segment, group);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    groups[nearestIndex].push(segment);
  }

  return groups.map(sortedSegments).sort((left, right) => left[0].startSeconds - right[0].startSeconds);
}

function exceedsChunkLimits(segments: TranscriptSegment[]) {
  if (segments.length > MAX_CHUNK_SEGMENTS) {
    return true;
  }
  if (timeRange(segments).durationSeconds > MAX_CHUNK_DURATION_SECONDS) {
    return true;
  }
  return inputMetrics(segments).inputChars > MAX_CHUNK_INPUT_CHARS;
}

function splitGroup(group: TranscriptSegment[]) {
  const chunks: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];

  for (const segment of sortedSegments(group)) {
    const candidate = [...current, segment];
    // Transcript segments are evidence atoms. If one segment alone exceeds a limit,
    // keep its real ID and surface the exception instead of inventing split evidence.
    if (current.length > 0 && exceedsChunkLimits(candidate)) {
      chunks.push(current);
      current = [segment];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function toChunk(segments: TranscriptSegment[], index: number): ExtractionChunk {
  const range = timeRange(segments);
  const metrics = inputMetrics(segments);
  return {
    id: `chunk_${index + 1}`,
    index,
    segments,
    startSeconds: range.startSeconds,
    endSeconds: range.endSeconds,
    exceedsLimits: exceedsChunkLimits(segments),
    ...metrics
  };
}

export function planExtractionChunks(input: {
  segments: TranscriptSegment[];
  semanticSegments?: SemanticSegment[];
}): ExtractionChunkPlan {
  const segments = sortedSegments(input.segments);
  const range = timeRange(segments);
  const metrics = inputMetrics(segments);
  const longForm = isLongForm(segments, range.durationSeconds, metrics.inputChars);

  const chunkSegments =
    segments.length === 0
      ? []
      : longForm
        ? semanticGroups(segments, input.semanticSegments ?? []).flatMap(splitGroup)
        : [segments];

  const chunks = chunkSegments.map(toChunk);
  return {
    longForm,
    chunks,
    segmentCount: segments.length,
    durationSeconds: range.durationSeconds,
    ...metrics,
    estimatedTokensMin: Math.ceil(metrics.inputChars / 4),
    estimatedTokensMax: Math.ceil(metrics.inputChars / 1.5),
    oversizedChunkCount: chunks.filter((chunk) => chunk.exceedsLimits).length
  };
}
