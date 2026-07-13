import type { AudioInsight, AudioUpload, BriefItem, ProcessingJob, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { ProactiveInsight } from "@/lib/domain/proactive-insights";
import type { LocalDayPayload } from "./local-analysis";

export type DayRecording = {
  upload: AudioUpload;
  job?: ProcessingJob;
};

export type AggregatedDayPayload = LocalDayPayload & {
  recordings: DayRecording[];
  isDayAggregate: boolean;
};

const RECORDING_GAP_SECONDS = 1;

function uploadCreatedAt(payload: LocalDayPayload) {
  const createdAt = payload.upload.createdAt ? Date.parse(payload.upload.createdAt) : Number.NaN;
  return Number.isNaN(createdAt) ? null : createdAt;
}

function sortDayPayloads(payloads: LocalDayPayload[]) {
  return payloads
    .map((payload, index) => ({ payload, index }))
    .sort((left, right) => {
      const leftCreatedAt = uploadCreatedAt(left.payload);
      const rightCreatedAt = uploadCreatedAt(right.payload);

      if (leftCreatedAt !== null && rightCreatedAt !== null) {
        return leftCreatedAt - rightCreatedAt || left.payload.upload.id.localeCompare(right.payload.upload.id);
      }

      return left.index - right.index;
    })
    .map(({ payload }) => payload);
}

function shiftSegment(segment: TranscriptSegment, offsetSeconds: number): TranscriptSegment {
  return {
    ...segment,
    startSeconds: segment.startSeconds + offsetSeconds,
    endSeconds: segment.endSeconds + offsetSeconds
  };
}

function shiftSemanticSegment(segment: SemanticSegment, offsetSeconds: number): SemanticSegment {
  return {
    ...segment,
    startSeconds: segment.startSeconds + offsetSeconds,
    endSeconds: segment.endSeconds + offsetSeconds,
    sourceTimeRange: {
      startSeconds: segment.sourceTimeRange.startSeconds + offsetSeconds,
      endSeconds: segment.sourceTimeRange.endSeconds + offsetSeconds
    }
  };
}

function shiftAudioInsight(insight: AudioInsight, offsetSeconds: number): AudioInsight {
  return {
    ...insight,
    sourceTimeRange: {
      startSeconds: insight.sourceTimeRange.startSeconds + offsetSeconds,
      endSeconds: insight.sourceTimeRange.endSeconds + offsetSeconds
    }
  };
}

function shiftBriefItem(item: BriefItem, offsetSeconds: number): BriefItem {
  return {
    ...item,
    sourceTimeRange: {
      startSeconds: item.sourceTimeRange.startSeconds + offsetSeconds,
      endSeconds: item.sourceTimeRange.endSeconds + offsetSeconds
    }
  };
}

function shiftRelationshipSignal(card: RelationshipSignalCard, offsetSeconds: number): RelationshipSignalCard {
  return {
    ...card,
    timeRange: {
      startSeconds: card.timeRange.startSeconds + offsetSeconds,
      endSeconds: card.timeRange.endSeconds + offsetSeconds
    },
    evidenceSegments: card.evidenceSegments.map((segment) => ({
      ...segment,
      startSeconds: segment.startSeconds + offsetSeconds,
      endSeconds: segment.endSeconds + offsetSeconds
    }))
  };
}

function inferDurationSeconds(payload: LocalDayPayload) {
  if (typeof payload.upload.durationSeconds === "number" && Number.isFinite(payload.upload.durationSeconds)) {
    return payload.upload.durationSeconds;
  }

  const maxSegmentEnd = Math.max(0, ...payload.segments.map((segment) => segment.endSeconds));
  const maxSemanticEnd = Math.max(0, ...payload.semanticSegments.map((segment) => segment.endSeconds));
  const maxBriefEnd = Math.max(0, ...payload.briefItems.map((item) => item.sourceTimeRange.endSeconds));

  return Math.max(maxSegmentEnd, maxSemanticEnd, maxBriefEnd);
}

function combinedStatus(payloads: LocalDayPayload[]): AudioUpload["status"] {
  if (payloads.some((payload) => payload.upload.status === "failed" || payload.job?.status === "failed")) {
    return "failed";
  }

  if (payloads.every((payload) => payload.upload.status === "ready" && (payload.job?.status ?? "ready") === "ready")) {
    return "ready";
  }

  return payloads.find((payload) => payload.job?.status && payload.job.status !== "ready")?.job?.status ?? "uploaded";
}

function combinedProgress(payloads: LocalDayPayload[]) {
  if (payloads.length === 0) {
    return 0;
  }

  const total = payloads.reduce((sum, payload) => sum + (payload.job?.progress ?? (payload.upload.status === "ready" ? 100 : 0)), 0);
  return Math.round(total / payloads.length);
}

export function combineDayPayloads(payloads: LocalDayPayload[]): AggregatedDayPayload {
  if (payloads.length === 0) {
    throw new Error("Cannot combine an empty day payload list");
  }

  const sortedPayloads = sortDayPayloads(payloads);
  const recordingDate = sortedPayloads[0].upload.recordingDate;
  let offsetSeconds = 0;
  const segments: TranscriptSegment[] = [];
  const audioInsights: AudioInsight[] = [];
  const semanticSegments: SemanticSegment[] = [];
  const briefItems: BriefItem[] = [];
  const relationshipSignals: RelationshipSignalCard[] = [];
  const proactiveInsights: ProactiveInsight[] = [];

  sortedPayloads.forEach((payload, index) => {
    segments.push(...payload.segments.map((segment) => shiftSegment(segment, offsetSeconds)));
    audioInsights.push(...(payload.audioInsights ?? []).map((insight) => shiftAudioInsight(insight, offsetSeconds)));
    semanticSegments.push(...payload.semanticSegments.map((segment) => shiftSemanticSegment(segment, offsetSeconds)));
    briefItems.push(...payload.briefItems.map((item) => shiftBriefItem(item, offsetSeconds)));
    relationshipSignals.push(...(payload.relationshipSignals ?? []).map((card) => shiftRelationshipSignal(card, offsetSeconds)));
    proactiveInsights.push(...(payload.proactiveInsights ?? []));

    offsetSeconds += inferDurationSeconds(payload);
    if (index < sortedPayloads.length - 1) {
      offsetSeconds += RECORDING_GAP_SECONDS;
    }
  });

  const status = combinedStatus(sortedPayloads);
  const createdAt = sortedPayloads[0].upload.createdAt;

  return {
    upload: {
      id: `day_${recordingDate}`,
      originalName: sortedPayloads.length === 1 ? sortedPayloads[0].upload.originalName : `${sortedPayloads.length} 段录音`,
      mimeType: "application/vnd.daily-brief.day",
      sizeBytes: sortedPayloads.reduce((sum, payload) => sum + payload.upload.sizeBytes, 0),
      recordingDate,
      createdAt,
      durationSeconds: offsetSeconds,
      status
    },
    job: {
      id: `job_day_${recordingDate}`,
      uploadId: `day_${recordingDate}`,
      status,
      progress: combinedProgress(sortedPayloads),
      startedAt: createdAt,
      finishedAt: sortedPayloads.at(-1)?.job?.finishedAt
    },
    segments,
    audioInsights,
    semanticSegments,
    semanticSegmentsAvailable: sortedPayloads.some((payload) => payload.semanticSegmentsAvailable),
    briefItems,
    relationshipSignals,
    relationshipSignalsAvailable: sortedPayloads.some((payload) => payload.relationshipSignalsAvailable),
    proactiveInsights,
    proactiveInsightsAvailable: sortedPayloads.some((payload) => payload.proactiveInsightsAvailable),
    speakerAliases: {},
    speakerAliasesByUploadId: Object.assign(
      {},
      ...sortedPayloads.map((payload) => ({
        [payload.upload.id]: payload.speakerAliases ?? {},
        ...(payload.speakerAliasesByUploadId ?? {})
      }))
    ),
    recordings: sortedPayloads.map((payload) => ({
      upload: payload.upload,
      job: payload.job
    })),
    isDayAggregate: true
  };
}
