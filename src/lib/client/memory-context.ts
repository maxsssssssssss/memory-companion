import type { AudioInsight, BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { LocalDayPayload } from "./local-analysis";

export type MemoryContextScope = "week" | "all";

export type MemoryContextPayload = {
  uploadId: string;
  scope: MemoryContextScope;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipSignals: RelationshipSignalCard[];
};

const MAX_MEMORY_CONTEXT_SEGMENTS = 48;
const MAX_MEMORY_CONTEXT_AUDIO_INSIGHTS = 32;
const MAX_MEMORY_CONTEXT_SEMANTIC_SEGMENTS = 40;
const MAX_MEMORY_CONTEXT_BRIEF_ITEMS = 40;
const MAX_MEMORY_CONTEXT_RELATIONSHIP_SIGNALS = 12;
const MAX_MEMORY_CONTEXT_TEXT_LENGTH = 700;

function compactText(text: string, maxLength = MAX_MEMORY_CONTEXT_TEXT_LENGTH) {
  const compacted = text.replace(/\s+/g, " ").trim();
  return compacted.length <= maxLength ? compacted : `${compacted.slice(0, maxLength - 1)}…`;
}

function dateFromKey(dateValue: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return null;
  }

  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return date;
}

function formatDateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addDays(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate;
}

export function weekRangeForMemoryContext(referenceDate: string) {
  const date = dateFromKey(referenceDate) ?? new Date();
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const start = addDays(date, -daysSinceMonday);
  const end = addDays(start, 6);

  return {
    startKey: formatDateKey(start),
    endKey: formatDateKey(end)
  };
}

function isQuestionReadyPayload(payload: LocalDayPayload) {
  const status = payload.job?.status ?? payload.upload.status;
  return (
    status === "ready" &&
    (payload.segments.length > 0 ||
      payload.audioInsights.length > 0 ||
      payload.semanticSegments.length > 0 ||
      payload.briefItems.length > 0)
  );
}

function sortPayloads(payloads: LocalDayPayload[]) {
  return [...payloads].sort(
    (left, right) =>
      left.upload.recordingDate.localeCompare(right.upload.recordingDate) ||
      (left.upload.createdAt ?? "").localeCompare(right.upload.createdAt ?? "") ||
      left.upload.id.localeCompare(right.upload.id)
  );
}

function datePrefix(payload: LocalDayPayload) {
  return `[${payload.upload.recordingDate}]`;
}

function decorateSegment(payload: LocalDayPayload, segment: TranscriptSegment): TranscriptSegment {
  return {
    ...segment,
    text: compactText(`${datePrefix(payload)} ${segment.text}`)
  };
}

function decorateAudioInsight(payload: LocalDayPayload, insight: AudioInsight): AudioInsight {
  return {
    ...insight,
    summary: compactText(`${datePrefix(payload)} ${insight.summary}`),
    evidence: compactText(`${datePrefix(payload)} ${insight.evidence}`)
  };
}

function decorateSemanticSegment(payload: LocalDayPayload, segment: SemanticSegment): SemanticSegment {
  return {
    ...segment,
    title: `${payload.upload.recordingDate} · ${segment.title}`,
    summary: compactText(`${datePrefix(payload)} ${segment.summary}`),
    transcriptExcerpt: compactText(`${datePrefix(payload)} ${segment.transcriptExcerpt}`)
  };
}

function decorateBriefItem(payload: LocalDayPayload, item: BriefItem): BriefItem {
  return {
    ...item,
    title: `${payload.upload.recordingDate} · ${item.title}`,
    body: compactText(`${datePrefix(payload)} ${item.body}`),
    transcriptExcerpt: compactText(`${datePrefix(payload)} ${item.transcriptExcerpt}`)
  };
}

function payloadsForScope(input: { scope: MemoryContextScope; referenceDate: string; payloads: LocalDayPayload[] }) {
  const readyPayloads = input.payloads.filter(isQuestionReadyPayload);

  if (input.scope === "all") {
    return readyPayloads;
  }

  const range = weekRangeForMemoryContext(input.referenceDate);
  return readyPayloads.filter((payload) => payload.upload.recordingDate >= range.startKey && payload.upload.recordingDate <= range.endKey);
}

export function memoryContextIdForScope(scope: MemoryContextScope, referenceDate: string) {
  if (scope === "all") {
    return "all_memory";
  }

  const range = weekRangeForMemoryContext(referenceDate);
  return `week_${range.startKey}_${range.endKey}`;
}

export function buildMemoryContextPayload(input: {
  scope: MemoryContextScope;
  referenceDate: string;
  payloads: LocalDayPayload[];
}): MemoryContextPayload | null {
  const selectedPayloads = sortPayloads(payloadsForScope(input));

  if (selectedPayloads.length === 0) {
    return null;
  }

  const segments = selectedPayloads
    .flatMap((payload) => payload.segments.map((segment) => decorateSegment(payload, segment)))
    .slice(-MAX_MEMORY_CONTEXT_SEGMENTS);
  const retainedSegmentIds = new Set(segments.map((segment) => segment.id));
  const relationshipSignals = selectedPayloads
    .flatMap((payload) =>
      (payload.relationshipSignals ?? []).map((card) => ({
        ...card,
        date: payload.upload.recordingDate
      }))
    )
    .filter((card) => card.evidenceSegments.every((evidence) => retainedSegmentIds.has(evidence.segmentId)))
    .slice(-MAX_MEMORY_CONTEXT_RELATIONSHIP_SIGNALS);

  return {
    uploadId: memoryContextIdForScope(input.scope, input.referenceDate),
    scope: input.scope,
    segments,
    audioInsights: selectedPayloads.flatMap((payload) =>
      payload.audioInsights.map((insight) => decorateAudioInsight(payload, insight))
    ).slice(-MAX_MEMORY_CONTEXT_AUDIO_INSIGHTS),
    semanticSegments: selectedPayloads.flatMap((payload) =>
      payload.semanticSegments.map((segment) => decorateSemanticSegment(payload, segment))
    ).slice(-MAX_MEMORY_CONTEXT_SEMANTIC_SEGMENTS),
    briefItems: selectedPayloads
      .flatMap((payload) => payload.briefItems.map((item) => decorateBriefItem(payload, item)))
      .slice(-MAX_MEMORY_CONTEXT_BRIEF_ITEMS),
    relationshipSignals
  };
}
