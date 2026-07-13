import type { LocalDayPayload } from "./local-analysis";
import type { MemoryContextPayload, MemoryContextScope } from "./memory-context";
import { weekRangeForMemoryContext } from "./memory-context";

export type QaScopeMeta = {
  scope: "current" | "week" | "all";
  label: string;
  description: string;
  recordingCount?: number;
  dateRangeLabel?: string;
  evidenceCount?: number;
  caution?: string;
};

type BuildQaScopeMetaInput = {
  scope: "current" | "week" | "all";
  referenceDate: string;
  payload?: LocalDayPayload | null;
  memoryPayloads?: LocalDayPayload[];
  memoryContext?: MemoryContextPayload | null;
  recordingDates?: string[];
  hasServerScopeData?: boolean;
};

const scopeCopy: Record<QaScopeMeta["scope"], Pick<QaScopeMeta, "label" | "description" | "caution">> = {
  current: {
    label: "当前录音",
    description: "仅基于当前这段录音回答"
  },
  week: {
    label: "本周范围",
    description: "基于本周已处理录音回答"
  },
  all: {
    label: "全部记忆",
    description: "基于全部已处理记忆回答，长期结论需要足够证据支持",
    caution: "长期结论需要至少两个不同日期的证据支持"
  }
};

function isReadyPayload(payload: LocalDayPayload) {
  return (payload.job?.status ?? payload.upload.status) === "ready";
}

function evidenceCountForPayload(payload: LocalDayPayload) {
  return (
    (payload.segments?.length ?? 0) +
    (payload.audioInsights?.length ?? 0) +
    (payload.semanticSegments?.length ?? 0) +
    (payload.briefItems?.length ?? 0)
  );
}

function evidenceCountForContext(context?: MemoryContextPayload | null) {
  if (!context) {
    return undefined;
  }

  return context.segments.length + context.audioInsights.length + context.semanticSegments.length + context.briefItems.length;
}

function uniqueSortedDates(dates: string[]) {
  return [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
}

function dateRangeLabel(dates: string[]) {
  const sortedDates = uniqueSortedDates(dates);
  if (sortedDates.length === 0) {
    return undefined;
  }
  if (sortedDates.length === 1) {
    return sortedDates[0];
  }
  return `${sortedDates[0]} 至 ${sortedDates[sortedDates.length - 1]}`;
}

function datesForScope(scope: MemoryContextScope, referenceDate: string, dates: string[]) {
  const sortedDates = uniqueSortedDates(dates);
  if (scope === "all") {
    return sortedDates;
  }

  const range = weekRangeForMemoryContext(referenceDate);
  return sortedDates.filter((date) => date >= range.startKey && date <= range.endKey);
}

function payloadsForScope(scope: MemoryContextScope, referenceDate: string, payloads: LocalDayPayload[]) {
  const readyPayloads = payloads.filter(isReadyPayload);
  if (scope === "all") {
    return readyPayloads;
  }

  const range = weekRangeForMemoryContext(referenceDate);
  return readyPayloads.filter(
    (payload) => payload.upload.recordingDate >= range.startKey && payload.upload.recordingDate <= range.endKey
  );
}

export function buildQaScopeMeta(input: BuildQaScopeMetaInput): QaScopeMeta {
  const copy = scopeCopy[input.scope];

  if (input.scope === "current") {
    const payload = input.payload && isReadyPayload(input.payload) ? input.payload : null;
    return {
      scope: input.scope,
      ...copy,
      ...(payload
        ? {
            recordingCount: 1,
            dateRangeLabel: payload.upload.recordingDate,
            evidenceCount: evidenceCountForPayload(payload)
          }
        : {
            dateRangeLabel: input.referenceDate
          })
    };
  }

  const scopedPayloads = payloadsForScope(input.scope, input.referenceDate, input.memoryPayloads ?? []);
  const payloadDates = scopedPayloads.map((payload) => payload.upload.recordingDate);
  const serverDates = datesForScope(input.scope, input.referenceDate, input.recordingDates ?? []);
  const effectiveDates = payloadDates.length > 0 ? payloadDates : serverDates;
  const localEvidenceCount = scopedPayloads.length > 0 ? scopedPayloads.reduce((sum, payload) => sum + evidenceCountForPayload(payload), 0) : undefined;
  const evidenceCount = evidenceCountForContext(input.memoryContext) ?? localEvidenceCount;
  const recordingCount =
    scopedPayloads.length > 0
      ? scopedPayloads.length
      : input.hasServerScopeData && serverDates.length > 0
        ? serverDates.length
        : undefined;

  return {
    scope: input.scope,
    ...copy,
    ...(recordingCount !== undefined ? { recordingCount } : {}),
    ...(dateRangeLabel(effectiveDates) ? { dateRangeLabel: dateRangeLabel(effectiveDates) } : {}),
    ...(evidenceCount !== undefined ? { evidenceCount } : {})
  };
}
