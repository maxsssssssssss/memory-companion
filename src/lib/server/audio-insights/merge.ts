import { AudioInsightSchema, type AudioInsight, type TranscriptSegment } from "@/lib/domain/types";
import type { TranscriptChunk } from "@/lib/domain/chunks";

export type AudioInsightChunkOutput = {
  transcriptChunk: TranscriptChunk;
  insights: AudioInsight[];
};

export type AudioInsightMergeResult = {
  insights: AudioInsight[];
  sourceChunkIdsByInsightId: Record<string, string[]>;
  inputCount: number;
  rejectedCount: number;
  duplicateRemoved: number;
};

function normalizedSummary(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function candidateKey(insight: AudioInsight) {
  return [
    [...insight.sourceSegmentIds].sort().join(","),
    insight.speaker.id,
    [...insight.toneLabels].sort().join(","),
    [...insight.emotionLabels].sort().join(","),
    [...insight.interactionLabels].sort().join(","),
    normalizedSummary(insight.summary)
  ].join("|");
}

export function mergeAudioInsightChunks(input: {
  uploadId: string;
  segments: TranscriptSegment[];
  chunks: AudioInsightChunkOutput[];
}): AudioInsightMergeResult {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const accepted: Array<{ insight: AudioInsight; chunkId: string; chunkIndex: number }> = [];
  let inputCount = 0;
  let rejectedCount = 0;

  for (const output of input.chunks) {
    const chunkSegmentIds = new Set(output.transcriptChunk.segments.map((segment) => segment.id));
    for (const insight of output.insights) {
      inputCount += 1;
      const sourceIds = unique(insight.sourceSegmentIds);
      if (
        insight.uploadId !== input.uploadId ||
        sourceIds.length === 0 ||
        sourceIds.some((sourceId) => !chunkSegmentIds.has(sourceId) || !segmentById.has(sourceId))
      ) {
        rejectedCount += 1;
        continue;
      }
      const sourceSegments = sourceIds.map((sourceId) => segmentById.get(sourceId)!);
      const parsed = AudioInsightSchema.safeParse({
        ...insight,
        sourceSegmentIds: sourceIds,
        sourceTimeRange: {
          startSeconds: Math.min(...sourceSegments.map((segment) => segment.startSeconds)),
          endSeconds: Math.max(...sourceSegments.map((segment) => segment.endSeconds))
        },
        emotionEvidence: insight.emotionEvidence?.filter((evidence) =>
          evidence.sourceSegmentIds.every((sourceId) => sourceIds.includes(sourceId))
        )
      });
      if (!parsed.success) {
        rejectedCount += 1;
        continue;
      }
      accepted.push({ insight: parsed.data, chunkId: output.transcriptChunk.id, chunkIndex: output.transcriptChunk.index });
    }
  }

  accepted.sort(
    (left, right) =>
      left.insight.sourceTimeRange.startSeconds - right.insight.sourceTimeRange.startSeconds ||
      left.insight.sourceTimeRange.endSeconds - right.insight.sourceTimeRange.endSeconds ||
      left.chunkIndex - right.chunkIndex ||
      left.insight.id.localeCompare(right.insight.id)
  );
  const deduplicated = new Map<string, { insight: AudioInsight; chunkIds: string[]; order: number }>();
  accepted.forEach((candidate, order) => {
    const key = candidateKey(candidate.insight);
    const existing = deduplicated.get(key);
    if (!existing) {
      deduplicated.set(key, { insight: candidate.insight, chunkIds: [candidate.chunkId], order });
      return;
    }
    existing.chunkIds = unique([...existing.chunkIds, candidate.chunkId]);
    if (candidate.insight.confidence > existing.insight.confidence) {
      existing.insight = candidate.insight;
    }
  });

  const merged = [...deduplicated.values()].sort((left, right) => left.order - right.order);
  const sourceChunkIdsByInsightId: Record<string, string[]> = {};
  const insights = merged.map((entry, index) => {
    const id = `insight_${input.uploadId}_ai_${index + 1}`;
    sourceChunkIdsByInsightId[id] = entry.chunkIds;
    return AudioInsightSchema.parse({ ...entry.insight, id, uploadId: input.uploadId });
  });

  return {
    insights,
    sourceChunkIdsByInsightId,
    inputCount,
    rejectedCount,
    duplicateRemoved: accepted.length - merged.length
  };
}
