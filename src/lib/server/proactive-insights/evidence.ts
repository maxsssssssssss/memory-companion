import { createHash } from "node:crypto";

import type { ProactiveEvidence, ProactiveInsightContext, ProactiveInsightScope } from "@/lib/domain/proactive-insights";
import { ProactiveInsightContextSchema } from "@/lib/domain/proactive-insights";
import type { AudioInsight, BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";

const MAX_TOTAL_EVIDENCE = 24;
const MAX_SEGMENTS_PER_EXCERPT = 4;
const MAX_SEGMENT_TEXT_LENGTH = 160;

const kindCaps = {
  relationship_signal: 6,
  brief: 8,
  semantic_segment: 6,
  audio_insight: 8
} as const;

function compactText(text: string, maxLength = MAX_SEGMENT_TEXT_LENGTH) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function excerptFromSegments(segments: TranscriptSegment[]) {
  return segments
    .slice(0, MAX_SEGMENTS_PER_EXCERPT)
    .map((segment) => compactText(segment.text))
    .join(" ");
}

function sortRelationshipSignals(left: RelationshipSignalCard, right: RelationshipSignalCard) {
  const severityRank = { high: 3, medium: 2, low: 1 };
  return (
    right.confidence - left.confidence ||
    severityRank[right.severity] - severityRank[left.severity] ||
    left.timeRange.startSeconds - right.timeRange.startSeconds ||
    left.id.localeCompare(right.id)
  );
}

function sortBriefItems(left: BriefItem, right: BriefItem) {
  const priorityRank = { high: 3, medium: 2, low: 1 };
  return (
    priorityRank[right.priority] - priorityRank[left.priority] ||
    right.confidence - left.confidence ||
    left.sourceTimeRange.startSeconds - right.sourceTimeRange.startSeconds ||
    left.id.localeCompare(right.id)
  );
}

function sortSemanticSegments(left: SemanticSegment, right: SemanticSegment) {
  return right.confidence - left.confidence || left.startSeconds - right.startSeconds || left.id.localeCompare(right.id);
}

function sortAudioInsights(left: AudioInsight, right: AudioInsight) {
  return (
    right.confidence - left.confidence ||
    left.sourceTimeRange.startSeconds - right.sourceTimeRange.startSeconds ||
    left.id.localeCompare(right.id)
  );
}

function pickSourceSegments(sourceSegmentIds: string[], segmentById: Map<string, TranscriptSegment>, uploadId: string) {
  const sourceSegments = sourceSegmentIds
    .slice(0, MAX_SEGMENTS_PER_EXCERPT)
    .map((segmentId) => segmentById.get(segmentId))
    .filter((segment): segment is TranscriptSegment => Boolean(segment && segment.uploadId === uploadId));

  return sourceSegments.length === Math.min(sourceSegmentIds.length, MAX_SEGMENTS_PER_EXCERPT) ? sourceSegments : [];
}

function pickAllSourceSegments(sourceSegmentIds: string[], segmentById: Map<string, TranscriptSegment>, uploadId: string) {
  const sourceSegments = sourceSegmentIds
    .map((segmentId) => segmentById.get(segmentId))
    .filter((segment): segment is TranscriptSegment => Boolean(segment && segment.uploadId === uploadId));

  return sourceSegments.length === sourceSegmentIds.length ? sourceSegments : [];
}

function timeRangeFromSegments(segments: TranscriptSegment[]) {
  return {
    startSeconds: Math.min(...segments.map((segment) => segment.startSeconds)),
    endSeconds: Math.max(...segments.map((segment) => segment.endSeconds))
  };
}

function fingerprintForEvidence(scope: ProactiveInsightScope, uploadId: string, recordingDate: string, evidence: ProactiveEvidence[]) {
  const payload = {
    scope,
    uploadId,
    recordingDate,
    evidence: evidence.map((item) => ({
      evidenceId: item.evidenceId,
      sourceId: item.sourceId,
      sourceType: item.sourceType,
      uploadId: item.uploadId,
      recordingDate: item.recordingDate,
      sourceSegmentIds: item.sourceSegmentIds,
      timeRange: item.timeRange,
      title: item.title,
      summary: item.summary,
      excerpt: item.excerpt,
      confidence: item.confidence,
      caution: item.caution,
      signalCategory: item.signalCategory
    }))
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function relationshipEvidence(
  scope: ProactiveInsightScope,
  uploadId: string,
  recordingDate: string,
  segmentById: Map<string, TranscriptSegment>,
  relationshipSignals: RelationshipSignalCard[]
) {
  return relationshipSignals
    .slice()
    .sort(sortRelationshipSignals)
    .flatMap((card): ProactiveEvidence[] => {
      if (card.uploadId !== uploadId || card.date !== recordingDate) {
        return [];
      }

      const sourceSegmentIds = card.evidenceSegments.map((segment) => segment.segmentId);
      const sourceSegments = pickAllSourceSegments(sourceSegmentIds, segmentById, uploadId);
      if (sourceSegments.length !== sourceSegmentIds.length) {
        return [];
      }

      return [
        {
          evidenceId: `relationship_signal:${card.id}`,
          kind: "relationship_signal",
          sourceType: "relationship_signal",
          sourceId: card.id,
          uploadId,
          recordingDate,
          sourceSegmentIds: sourceSegments.slice(0, MAX_SEGMENTS_PER_EXCERPT).map((segment) => segment.id),
          timeRange: timeRangeFromSegments(sourceSegments),
          title: card.summary,
          summary: card.explanation,
          excerpt: excerptFromSegments(sourceSegments),
          confidence: card.confidence,
          caution: card.caution?.trim() || undefined,
          signalCategory: card.signalCategory
        }
      ];
    })
    .slice(0, kindCaps.relationship_signal);
}

function briefEvidence(
  uploadId: string,
  recordingDate: string,
  segmentById: Map<string, TranscriptSegment>,
  briefItems: BriefItem[]
) {
  return briefItems
    .slice()
    .sort(sortBriefItems)
    .flatMap((item): ProactiveEvidence[] => {
      if (item.uploadId !== uploadId) {
        return [];
      }

      const sourceSegments = pickAllSourceSegments(item.sourceSegmentIds, segmentById, uploadId);
      if (sourceSegments.length !== item.sourceSegmentIds.length) {
        return [];
      }

      return [
        {
          evidenceId: `brief:${item.id}`,
          kind: "brief",
          sourceType: "brief",
          sourceId: item.id,
          uploadId,
          recordingDate,
          sourceSegmentIds: sourceSegments.slice(0, MAX_SEGMENTS_PER_EXCERPT).map((segment) => segment.id),
          timeRange: timeRangeFromSegments(sourceSegments),
          title: item.title,
          summary: item.body,
          excerpt: excerptFromSegments(sourceSegments),
          confidence: item.confidence
        }
      ];
    })
    .slice(0, kindCaps.brief);
}

function semanticEvidence(
  uploadId: string,
  recordingDate: string,
  segmentById: Map<string, TranscriptSegment>,
  semanticSegments: SemanticSegment[]
) {
  return semanticSegments
    .slice()
    .sort(sortSemanticSegments)
    .flatMap((item): ProactiveEvidence[] => {
      if (item.uploadId !== uploadId) {
        return [];
      }

      const sourceSegments = pickAllSourceSegments(item.sourceSegmentIds, segmentById, uploadId);
      if (sourceSegments.length !== item.sourceSegmentIds.length) {
        return [];
      }

      return [
        {
          evidenceId: `semantic_segment:${item.id}`,
          kind: "semantic_segment",
          sourceType: "semantic_segment",
          sourceId: item.id,
          uploadId,
          recordingDate,
          sourceSegmentIds: sourceSegments.slice(0, MAX_SEGMENTS_PER_EXCERPT).map((segment) => segment.id),
          timeRange: timeRangeFromSegments(sourceSegments),
          title: item.title,
          summary: item.summary,
          excerpt: excerptFromSegments(sourceSegments),
          confidence: item.confidence
        }
      ];
    })
    .slice(0, kindCaps.semantic_segment);
}

function audioEvidence(
  uploadId: string,
  recordingDate: string,
  segmentById: Map<string, TranscriptSegment>,
  audioInsights: AudioInsight[]
) {
  return audioInsights
    .slice()
    .sort(sortAudioInsights)
    .flatMap((item): ProactiveEvidence[] => {
      if (item.uploadId !== uploadId) {
        return [];
      }

      const sourceSegments = pickAllSourceSegments(item.sourceSegmentIds, segmentById, uploadId);
      if (sourceSegments.length !== item.sourceSegmentIds.length) {
        return [];
      }

      return [
        {
          evidenceId: `audio_insight:${item.id}`,
          kind: "audio_insight",
          sourceType: "audio_insight",
          sourceId: item.id,
          uploadId,
          recordingDate,
          sourceSegmentIds: sourceSegments.slice(0, MAX_SEGMENTS_PER_EXCERPT).map((segment) => segment.id),
          timeRange: timeRangeFromSegments(sourceSegments),
          title: compactText(item.summary, 160),
          summary: compactText(item.evidence, 400),
          excerpt: excerptFromSegments(sourceSegments),
          confidence: item.confidence
        }
      ];
    })
    .slice(0, kindCaps.audio_insight);
}

export function buildProactiveInsightContext(input: {
  scope: ProactiveInsightScope;
  uploadId: string;
  recordingDate: string;
  segments: TranscriptSegment[];
  relationshipSignals: RelationshipSignalCard[];
  briefItems: BriefItem[];
  semanticSegments: SemanticSegment[];
  audioInsights: AudioInsight[];
}): { context: ProactiveInsightContext; sourceFingerprint: string } {
  const segmentById = new Map(
    input.segments
      .filter((segment) => segment.uploadId === input.uploadId)
      .map((segment) => [segment.id, segment] as const)
  );
  const eligibleRelationshipSignals = input.relationshipSignals.filter(
    (item) => item.uploadId === input.uploadId && item.date === input.recordingDate
  );
  const eligibleBriefItems = input.briefItems.filter((item) => item.uploadId === input.uploadId);
  const eligibleSemanticSegments = input.semanticSegments.filter((item) => item.uploadId === input.uploadId);
  const eligibleAudioInsights = input.audioInsights.filter((item) => item.uploadId === input.uploadId);
  const relationshipItems = relationshipEvidence(
    input.scope,
    input.uploadId,
    input.recordingDate,
    segmentById,
    input.relationshipSignals
  );
  const briefItems = briefEvidence(input.uploadId, input.recordingDate, segmentById, input.briefItems);
  const semanticItems = semanticEvidence(input.uploadId, input.recordingDate, segmentById, input.semanticSegments);
  const audioItems = audioEvidence(input.uploadId, input.recordingDate, segmentById, input.audioInsights);
  const groupedEvidence = [...relationshipItems, ...briefItems, ...semanticItems, ...audioItems];
  const evidence = groupedEvidence.slice(0, MAX_TOTAL_EVIDENCE);
  const perKindTruncated =
    relationshipItems.length < Math.min(eligibleRelationshipSignals.length, kindCaps.relationship_signal) ||
    briefItems.length < Math.min(eligibleBriefItems.length, kindCaps.brief) ||
    semanticItems.length < Math.min(eligibleSemanticSegments.length, kindCaps.semantic_segment) ||
    audioItems.length < Math.min(eligibleAudioInsights.length, kindCaps.audio_insight) ||
    eligibleRelationshipSignals.length > kindCaps.relationship_signal ||
    eligibleBriefItems.length > kindCaps.brief ||
    eligibleSemanticSegments.length > kindCaps.semantic_segment ||
    eligibleAudioInsights.length > kindCaps.audio_insight;
  const context = ProactiveInsightContextSchema.parse({
    schemaVersion: 1,
    scope: input.scope,
    referenceDate: input.recordingDate,
    dateRange: {
      startDate: input.recordingDate,
      endDate: input.recordingDate
    },
    sourceUploadIds: [input.uploadId],
    distinctDates: [input.recordingDate],
    evidence,
    truncated: perKindTruncated || groupedEvidence.length > MAX_TOTAL_EVIDENCE
  });

  return {
    context,
    sourceFingerprint: fingerprintForEvidence(input.scope, input.uploadId, input.recordingDate, evidence)
  };
}
