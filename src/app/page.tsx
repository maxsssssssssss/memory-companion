"use client";

import { Fragment, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DailyBrief } from "@/components/daily-brief";
import { QaPanel } from "@/components/qa-panel";
import { QaVoiceWorkspace } from "@/components/qa-voice-workspace";
import { Timeline } from "@/components/timeline";
import { formatLocalDateInputValue, UploadPanel } from "@/components/upload-panel";
import { combineDayPayloads, type DayRecording } from "@/lib/client/day-aggregation";
import { buildMemoryContextPayload, type MemoryContextPayload } from "@/lib/client/memory-context";
import { buildProactiveQaPresentation } from "@/lib/client/proactive-qa-presentation";
import { buildProactiveQaSuggestions } from "@/lib/client/proactive-qa-suggestions";
import { buildQaScopeMeta } from "@/lib/client/qa-scope-metadata";
import {
  applyAudioInsightCorrections,
  correctionsFromAudioInsights,
  sanitizeAudioInsightCorrection,
  type StoredAudioInsightCorrection
} from "@/lib/domain/audio-insight-corrections";
import {
  analyzeAudioLocally,
  appendLocalQaHistory,
  answerQuestionLocally,
  clearLocalQaHistory,
  deleteLocalDayPayload,
  listLocalDayIndex,
  readLocalDayPayload,
  readLocalQaHistory,
  saveLocalDayPayload,
  type LocalDayPayload
} from "@/lib/client/local-analysis";
import { applySpeakerAliasesToPayload, collectSpeakerAliasTargets, sanitizeSpeakerAliases, sanitizeSpeakerAliasesByUploadId } from "@/lib/domain/speaker-aliases";
import type { ProactiveInsight } from "@/lib/domain/proactive-insights";
import type { AudioInsight, AudioUpload, BriefItem, ProcessingJob, QuestionAnswer, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { VoiceQaContext } from "@/lib/domain/voice-qa-context";

type DayPayload = {
  upload: AudioUpload;
  job?: ProcessingJob;
  segments: TranscriptSegment[];
  audioInsights?: AudioInsight[];
  semanticSegments?: SemanticSegment[];
  semanticSegmentsAvailable?: boolean;
  briefItems: BriefItem[];
  relationshipSignals?: RelationshipSignalCard[];
  relationshipSignalsAvailable?: boolean;
  proactiveInsights?: ProactiveInsight[];
  proactiveInsightsAvailable?: boolean;
  speakerAliases?: Record<string, string>;
  speakerAliasesByUploadId?: Record<string, Record<string, string>>;
  recordings?: DayRecording[];
  isDayAggregate?: boolean;
};

type ApiKeyMode = "default" | "custom";

type ProviderSettingsPayload = {
  apiKeyMode: ApiKeyMode;
  hasCustomApiKey: boolean;
  defaultApiKeyAvailable: boolean;
  activeApiKeySource: "custom" | "default" | "missing";
  providerDisplayName: string;
  storageMode: "local" | "server";
  canOpenDataFolder: boolean;
  dataDirectory: string;
  uploadsDirectory: string;
  apiKeyStoragePath: string;
};

function voiceQaContext(input: {
  contextId: string;
  segments: TranscriptSegment[];
  audioInsights?: AudioInsight[];
  semanticSegments?: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipSignals?: RelationshipSignalCard[];
}): VoiceQaContext {
  return {
    contextId: input.contextId,
    segments: input.segments,
    audioInsights: input.audioInsights ?? [],
    semanticSegments: input.semanticSegments ?? [],
    briefItems: input.briefItems,
    relationshipSignals: input.relationshipSignals ?? []
  };
}

type DayRequestResult =
  | {
      kind: "success";
      payload: DayPayload;
      status: ProcessingJob["status"];
      progress: number;
      source: "browser" | "server";
      serverPayloads?: LocalDayPayload[];
      serverUploadIds?: string[];
    }
  | {
      kind: "error";
      errorMessage: string;
    }
  | {
      kind: "empty";
      recordingDate: string;
    }
  | {
      kind: "aborted";
    };

type WorkspaceView = "brief" | "timeline" | "qa";
type MemoryScope = "current" | "week" | "all";
type QaQuestionInput = {
  question: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  promptPresetId: string;
  customPrompt: string;
};
type QaStreamQuestionInput = QaQuestionInput & {
  signal: AbortSignal;
};
type QaAnswerPayload = {
  answer: string;
  citedSegmentIds: string[];
  citations?: Array<{
    id: string;
    title: string;
    startSeconds: number;
    endSeconds: number;
    excerpt: string;
    sourceSegmentIds: string[];
  }>;
  id?: string;
  uploadId?: string;
  question?: string;
  createdAt?: string;
  error?: string;
};
type QaHistoryTurn = {
  id: string;
  question: string;
  answer: string;
  citedSegmentIds: string[];
  citations?: QuestionAnswer["citations"];
  createdAt?: string;
};

type AuthUser = {
  id: string;
  email: string;
  name?: string;
};

const views: Array<{ id: WorkspaceView; label: string; badge?: string }> = [
  { id: "brief", label: "每日复盘" },
  { id: "timeline", label: "时间轴" },
  { id: "qa", label: "问答", badge: "AI" }
];

const memoryScopes: Array<{ id: MemoryScope; label: string; date: string; detail: string; available: boolean; status: string }> = [
  { id: "current", label: "当前录音", date: "今天", detail: "可分析", available: true, status: "当前录音" },
  { id: "week", label: "本周范围", date: "已接入", detail: "可问答", available: true, status: "本周记忆已接入" },
  { id: "all", label: "全部记忆", date: "已接入", detail: "可问答", available: true, status: "全部记忆已接入" }
];

const ACTIVE_USER_STORAGE_KEY = "daily-brief:active-user-id";
const LAST_UPLOAD_ID_STORAGE_KEY = "last-upload-id";
const SELECTED_RECORDING_DATE_STORAGE_KEY = "selected-recording-date";
const LOCAL_OPENROUTER_API_KEY_STORAGE_KEY = "openrouter-api-key";

function setActiveBrowserUserId(userId: string | null) {
  try {
    if (userId) {
      window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, userId);
    } else {
      window.localStorage.removeItem(ACTIVE_USER_STORAGE_KEY);
    }
  } catch {
    // Local storage can be disabled; server-side session remains authoritative.
  }
}

function scopedBrowserStorageKey(key: string) {
  try {
    const userId = window.localStorage.getItem(ACTIVE_USER_STORAGE_KEY)?.trim();
    return userId ? `daily-brief:${userId}:${key}` : `daily-brief:anonymous:${key}`;
  } catch {
    return `daily-brief:anonymous:${key}`;
  }
}

function isValidDateKey(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function readStoredUploadId() {
  try {
    return window.localStorage.getItem(scopedBrowserStorageKey(LAST_UPLOAD_ID_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredUploadId(uploadId: string) {
  try {
    window.localStorage.setItem(scopedBrowserStorageKey(LAST_UPLOAD_ID_STORAGE_KEY), uploadId);
  } catch {
    // Storage can be unavailable in private browsing or tests; server restore remains the fallback.
  }
}

function clearStoredUploadId() {
  try {
    window.localStorage.removeItem(scopedBrowserStorageKey(LAST_UPLOAD_ID_STORAGE_KEY));
  } catch {
    // Ignore storage failures; deletion has already happened on the server.
  }
}

function readStoredSelectedRecordingDate() {
  try {
    const storedDate = window.localStorage.getItem(scopedBrowserStorageKey(SELECTED_RECORDING_DATE_STORAGE_KEY));
    return isValidDateKey(storedDate) ? storedDate : null;
  } catch {
    return null;
  }
}

function writeStoredSelectedRecordingDate(recordingDate: string) {
  if (!isValidDateKey(recordingDate)) {
    return;
  }

  try {
    window.localStorage.setItem(scopedBrowserStorageKey(SELECTED_RECORDING_DATE_STORAGE_KEY), recordingDate);
  } catch {
    // Storage can be unavailable in private browsing or tests; the in-memory date still drives this session.
  }
}

function readStoredOpenRouterApiKey() {
  try {
    return window.localStorage.getItem(scopedBrowserStorageKey(LOCAL_OPENROUTER_API_KEY_STORAGE_KEY))?.trim() || null;
  } catch {
    return null;
  }
}

function writeStoredOpenRouterApiKey(apiKey: string) {
  try {
    window.localStorage.setItem(scopedBrowserStorageKey(LOCAL_OPENROUTER_API_KEY_STORAGE_KEY), apiKey);
  } catch {
    // Browser storage can be unavailable; the UI will report save failure from the caller.
  }
}

function clearStoredOpenRouterApiKey() {
  try {
    window.localStorage.removeItem(scopedBrowserStorageKey(LOCAL_OPENROUTER_API_KEY_STORAGE_KEY));
  } catch {
    // Ignore storage failures; this only affects the local BYOK preference.
  }
}

function isLocalUploadId(uploadId: string) {
  return uploadId.startsWith("local_");
}

function isDayUploadId(uploadId: string) {
  return /^day_\d{4}-\d{2}-\d{2}$/.test(uploadId);
}

function dayUploadIdForDate(recordingDate: string) {
  return `day_${recordingDate}`;
}

function dateFromDayUploadId(uploadId: string) {
  return isDayUploadId(uploadId) ? uploadId.slice(4) : null;
}

function mergeDateLists(...dateLists: string[][]) {
  return [...new Set(dateLists.flat())].sort();
}

function uniquePayloadsByUploadId(payloads: LocalDayPayload[]) {
  const payloadById = new Map<string, LocalDayPayload>();

  payloads.forEach((payload) => {
    payloadById.set(payload.upload.id, payload);
  });

  return [...payloadById.values()];
}

function readLocalDayPayloadsForDate(recordingDate: string) {
  return uniquePayloadsByUploadId(
    listLocalDayIndex()
      .filter((item) => item.recordingDate === recordingDate)
      .map((item) => readLocalDayPayload(item.uploadId))
      .filter((payload): payload is LocalDayPayload => Boolean(payload))
      .map((payload) => toLocalDayPayload(payload))
  );
}

function dayPayloadFromRecordings(payloads: LocalDayPayload[]): DayPayload {
  if (payloads.length === 1) {
    return payloads[0];
  }

  return combineDayPayloads(payloads);
}

function toLocalDayPayload(payload: DayPayload): LocalDayPayload {
  const audioInsights = payload.audioInsights ?? [];
  const semanticSegments = payload.semanticSegments ?? [];

  return {
    upload: payload.upload,
    job: payload.job,
    segments: payload.segments,
    audioInsights,
    semanticSegments,
    semanticSegmentsAvailable: payload.semanticSegmentsAvailable ?? semanticSegments.length > 0,
    briefItems: payload.briefItems,
    relationshipSignals: payload.relationshipSignals ?? [],
    relationshipSignalsAvailable: payload.relationshipSignalsAvailable ?? (payload.relationshipSignals?.length ?? 0) > 0,
    proactiveInsights: payload.proactiveInsights ?? [],
    proactiveInsightsAvailable: payload.proactiveInsightsAvailable ?? (payload.proactiveInsights?.length ?? 0) > 0,
    speakerAliases: payload.speakerAliases ?? {},
    speakerAliasesByUploadId: payload.speakerAliasesByUploadId ?? {}
  };
}

function speakerAliasLookupForPayload(payload: Pick<DayPayload, "upload" | "speakerAliases" | "speakerAliasesByUploadId">) {
  const aliasesByUploadId = sanitizeSpeakerAliasesByUploadId(payload.speakerAliasesByUploadId ?? {});

  if (Object.keys(aliasesByUploadId).length > 0) {
    return aliasesByUploadId;
  }

  const aliases = sanitizeSpeakerAliases(payload.speakerAliases ?? {});

  return Object.keys(aliases).length > 0 ? { [payload.upload.id]: aliases } : {};
}

function applyPayloadSpeakerAliases<T extends DayPayload | LocalDayPayload>(payload: T): T {
  return applySpeakerAliasesToPayload(payload, speakerAliasLookupForPayload(payload));
}

function speakerAliasesByUploadIdWith(
  currentAliasesByUploadId: Record<string, Record<string, string>> | undefined,
  uploadId: string,
  aliases: Record<string, string>
) {
  const nextAliasesByUploadId = { ...sanitizeSpeakerAliasesByUploadId(currentAliasesByUploadId ?? {}) };

  if (Object.keys(aliases).length > 0) {
    nextAliasesByUploadId[uploadId] = aliases;
  } else {
    delete nextAliasesByUploadId[uploadId];
  }

  return nextAliasesByUploadId;
}

function saveSpeakerAliasesToLocalCache(uploadId: string, aliases: Record<string, string>) {
  const cachedPayload = readLocalDayPayload(uploadId);

  if (!cachedPayload) {
    return false;
  }

  saveLocalDayPayload({
    ...cachedPayload,
    speakerAliases: aliases,
    speakerAliasesByUploadId: speakerAliasesByUploadIdWith(cachedPayload.speakerAliasesByUploadId, uploadId, aliases)
  });

  return true;
}

function withAudioInsightCorrection(
  payload: DayPayload,
  uploadId: string,
  insightId: string,
  correction: StoredAudioInsightCorrection
): DayPayload {
  return {
    ...payload,
    audioInsights: (payload.audioInsights ?? []).map((insight) => {
      if (insight.uploadId !== uploadId || insight.id !== insightId) {
        return insight;
      }

      return applyAudioInsightCorrections([insight], { [insightId]: correction })[0];
    })
  };
}

function saveAudioInsightCorrectionsToLocalCache(uploadId: string, corrections: Record<string, StoredAudioInsightCorrection>) {
  const cachedPayload = readLocalDayPayload(uploadId);

  if (!cachedPayload) {
    return false;
  }

  saveLocalDayPayload({
    ...cachedPayload,
    audioInsights: applyAudioInsightCorrections(cachedPayload.audioInsights ?? [], corrections)
  });

  return true;
}

async function cleanupServerUploadAfterLocalCache(uploadId: string) {
  try {
    await fetch(`/api/uploads/${uploadId}`, {
      method: "DELETE",
      headers: {
        "x-daily-brief-cleanup-mode": "browser-cache"
      }
    });
  } catch {
    // Cleanup is best-effort; if it fails, the user can still delete the record manually.
  }
}

function NavIcon({ view }: { view: WorkspaceView }) {
  if (view === "timeline") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <circle cx="6" cy="6" r="2" />
        <circle cx="6" cy="18" r="2" />
        <path d="M6 8v8M11 6h7M11 12h7M11 18h7" />
      </svg>
    );
  }

  if (view === "qa") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.36L4 21l1.14-4.18A8.38 8.38 0 1 1 21 11.5Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4-4" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3Z" />
      <path d="m8.8 12 2.2 2.2 4.4-4.7" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function formatRecordingDate(dateValue?: string) {
  if (!dateValue) {
    return "未选择日期";
  }

  const [year, month, day] = dateValue.split("-");

  if (!year || !month || !day) {
    return dateValue;
  }

  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

function formatCompactDate(dateValue: string) {
  const [year, month, day] = dateValue.split("-");

  if (!year || !month || !day) {
    return dateValue;
  }

  return `${month}/${day}/${year}`;
}

function formatScopeDate(dateValue: string, todayValue: string) {
  if (dateValue === todayValue) {
    return "今天";
  }

  const [, month, day] = dateValue.split("-");
  const monthNumber = Number(month);
  const dayNumber = Number(day);

  if (!monthNumber || !dayNumber) {
    return "当前日期";
  }

  return `${monthNumber}/${dayNumber}`;
}

function dateFromKey(dateValue: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);

  if (!match) {
    return null;
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function weekRangeForDate(dateValue: string) {
  const referenceDate = dateFromKey(dateValue) ?? new Date();
  const localDate = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const daysSinceMonday = (localDate.getDay() + 6) % 7;
  const start = addDays(localDate, -daysSinceMonday);
  const end = addDays(start, 6);

  return {
    startKey: formatDateKey(start),
    endKey: formatDateKey(end)
  };
}

function isDateInRange(dateValue: string, startKey: string, endKey: string) {
  return dateValue >= startKey && dateValue <= endKey;
}

function dateToMonthValue(dateValue: string) {
  const [year, month] = dateValue.split("-");
  return year && month ? `${year}-${month}` : formatLocalDateInputValue().slice(0, 7);
}

function shiftMonthValue(monthValue: string, offset: number) {
  const [year, month] = monthValue.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(year, month - 1 + offset, 1));

  return `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatCalendarMonth(monthValue: string) {
  const [year, month] = monthValue.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

function buildCalendarDays(monthValue: string) {
  const [year, month] = monthValue.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = firstDay.getUTCDay();
  const gridStart = new Date(Date.UTC(year, month - 1, 1 - firstWeekday));

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);

    const dateValue = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

    return {
      dateValue,
      day: date.getUTCDate(),
      isCurrentMonth: date.getUTCMonth() === month - 1
    };
  });
}

function formatDuration(seconds?: number) {
  if (!seconds) {
    return "待识别";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (hours <= 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}

function formatRecordingCreatedTime(createdAt?: string) {
  if (!createdAt) {
    return "时间未知";
  }

  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return "时间未知";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function inferDurationSeconds(payload: DayPayload | null) {
  if (!payload) {
    return undefined;
  }

  const candidates = [
    payload.upload.durationSeconds,
    ...payload.segments.map((segment) => segment.endSeconds),
    ...(payload.audioInsights ?? []).map((insight) => insight.sourceTimeRange.endSeconds),
    ...(payload.semanticSegments ?? []).map((segment) => segment.sourceTimeRange.endSeconds),
    ...payload.briefItems.map((item) => item.sourceTimeRange.endSeconds)
  ].filter((seconds): seconds is number => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0);

  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

function hasQuestionEvidence(payload: Pick<DayPayload, "segments" | "audioInsights" | "semanticSegments" | "briefItems">) {
  return payload.segments.length > 0 || (payload.audioInsights?.length ?? 0) > 0 || (payload.semanticSegments?.length ?? 0) > 0 || payload.briefItems.length > 0;
}

function isQuestionReadyPayload(payload: Pick<DayPayload, "upload" | "job" | "segments" | "audioInsights" | "semanticSegments" | "briefItems">) {
  return (payload.job?.status ?? payload.upload.status) === "ready" && hasQuestionEvidence(payload);
}

function listLocalQuestionReadyDates() {
  return listLocalDayIndex()
    .map((item) => readLocalDayPayload(item.uploadId))
    .filter((payload): payload is LocalDayPayload => Boolean(payload))
    .filter(isQuestionReadyPayload)
    .map((payload) => payload.upload.recordingDate);
}

function listLocalQuestionReadyPayloads() {
  return listLocalDayIndex()
    .map((item) => readLocalDayPayload(item.uploadId))
    .filter((payload): payload is LocalDayPayload => Boolean(payload))
    .map((payload) => toLocalDayPayload(payload))
    .filter(isQuestionReadyPayload);
}

function memoryContextToLocalPayload(context: MemoryContextPayload, referenceDate: string): LocalDayPayload {
  return {
    upload: {
      id: context.uploadId,
      originalName: context.scope === "week" ? "本周记忆" : "全部记忆",
      mimeType: "application/vnd.daily-brief.memory",
      sizeBytes: 0,
      recordingDate: referenceDate,
      status: "ready"
    },
    job: {
      id: `job_${context.uploadId}`,
      uploadId: context.uploadId,
      status: "ready",
      progress: 100
    },
    segments: context.segments,
    audioInsights: context.audioInsights,
    semanticSegments: context.semanticSegments,
    semanticSegmentsAvailable: context.semanticSegments.length > 0,
    briefItems: context.briefItems,
    relationshipSignals: context.relationshipSignals,
    relationshipSignalsAvailable: true,
    proactiveInsights: [],
    proactiveInsightsAvailable: false
  };
}

function shortRecordId(uploadId?: string | null) {
  if (!uploadId) {
    return "未建立";
  }

  if (uploadId.length <= 13) {
    return uploadId;
  }

  return `${uploadId.slice(0, 8)}…${uploadId.slice(-4)}`;
}

function getFriendlyStatus(input: {
  status: string;
  progress: number;
  hasUpload: boolean;
  hasPayload: boolean;
  isResolvingUpload: boolean;
  statusMessage: string;
}) {
  if (input.isResolvingUpload) {
    return {
      label: "查找中",
      title: input.statusMessage || "正在查找这一天的录音",
      detail: "正在读取已保存的录音索引",
      tone: "processing"
    };
  }

  if (input.status === "ready" && input.hasPayload) {
    return {
      label: "已完成",
      title: "录音复盘已完成",
      detail: "每日复盘、时间轴和问答已可用",
      tone: "ready"
    };
  }

  if (input.status === "failed") {
    return {
      label: "处理失败",
      title: "这次录音没有生成结果",
      detail: "可以删除后重新上传，或检查转写与提取配置",
      tone: "failed"
    };
  }

  if (input.hasUpload) {
    return {
      label: "处理中",
      title: `正在整理录音 · ${input.progress}%`,
      detail: "完成后会自动显示每日复盘、时间轴和问答",
      tone: "processing"
    };
  }

  return {
    label: "等待上传",
    title: "还没有选择录音",
    detail: "上传录音后会在这里显示处理进度和结果状态",
    tone: "idle"
  };
}

function normalizeSearchValue(value: string) {
  return value.trim().toLowerCase();
}

function briefItemMatchesSearch(item: BriefItem, query: string) {
  const searchable = [item.title, item.body, item.transcriptExcerpt, item.category, item.priority, ...item.people, ...item.topics]
    .join(" ")
    .toLowerCase();

  return searchable.includes(query);
}

function segmentMatchesSearch(segment: TranscriptSegment, query: string) {
  const searchable = [segment.text, segment.speaker, ...segment.sceneLabels, ...segment.valueLabels]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return searchable.includes(query);
}

function semanticSegmentMatchesSearch(segment: SemanticSegment, query: string, sourceSegmentById: Map<string, TranscriptSegment>) {
  const searchable = [
    segment.title,
    segment.summary,
    segment.transcriptExcerpt,
    ...segment.tags,
    ...segment.sceneLabels,
    ...segment.valueLabels,
    ...segment.sourceSegmentIds
  ]
    .join(" ")
    .toLowerCase();

  if (searchable.includes(query)) {
    return true;
  }

  return segment.sourceSegmentIds.some((sourceSegmentId) => {
    const sourceSegment = sourceSegmentById.get(sourceSegmentId);
    return sourceSegment ? segmentMatchesSearch(sourceSegment, query) : false;
  });
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          password,
          ...(mode === "register" && name.trim() ? { name: name.trim() } : {}),
          ...(mode === "register" ? { inviteCode: inviteCode.trim() } : {})
        })
      });
      const payload = (await response.json()) as { user?: AuthUser; error?: string };

      if (!response.ok || !payload.user) {
        const messageByError: Record<string, string> = {
          invalid_credentials: "邮箱或密码不正确。",
          invalid_invite_code: "邀请码不正确。",
          invite_not_configured: "邀请码暂未配置，请联系管理员。",
          user_exists: "这个邮箱已经注册过。"
        };
        setErrorMessage(messageByError[payload.error ?? ""] ?? (mode === "register" ? "注册失败，请检查信息后重试。" : "邮箱或密码不正确。"));
        return;
      }

      setActiveBrowserUserId(payload.user.id);
      onAuthenticated(payload.user);
    } catch {
      setErrorMessage("暂时无法连接认证服务。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="mark auth-mark">
          <span>昼</span>
        </div>
        <p className="kicker-line">PRIVATE MEMORY</p>
        <h1 id="auth-title">{mode === "login" ? "登录昼记" : "创建昼记账号"}</h1>
        <p>每个账号拥有独立的录音、摘要、问答历史和模型配置。</p>

        <form className="auth-form" onSubmit={submitAuth}>
          {mode === "register" ? (
            <label>
              <span>昵称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="可选" autoComplete="name" />
            </label>
          ) : null}
          <label>
            <span>邮箱</span>
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required autoComplete="email" />
          </label>
          <label>
            <span>密码</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              minLength={8}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {mode === "register" ? (
            <label>
              <span>邀请码</span>
              <input
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                required
                autoComplete="off"
                placeholder="请输入内部邀请码"
              />
            </label>
          ) : null}
          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
          <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "处理中..." : mode === "login" ? "登录" : "注册并进入"}
          </button>
        </form>

        <button
          className="ghost-link"
          type="button"
          onClick={() => {
            setErrorMessage("");
            setMode(mode === "login" ? "register" : "login");
          }}
        >
          {mode === "login" ? "还没有账号？注册" : "已有账号？登录"}
        </button>
      </section>
    </main>
  );
}

export default function HomePage() {
  const [authState, setAuthState] = useState<
    { status: "checking" } | { status: "anonymous" } | { status: "authenticated"; user: AuthUser }
  >({ status: "checking" });

  useEffect(() => {
    let isCancelled = false;

    const loadCurrentUser = async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const payload = (await response.json()) as { user?: AuthUser };

        if (isCancelled) {
          return;
        }

        if (response.ok && payload.user) {
          setActiveBrowserUserId(payload.user.id);
          setAuthState({ status: "authenticated", user: payload.user });
          return;
        }
      } catch {
        // Fall through to anonymous state.
      }

      if (!isCancelled) {
        setActiveBrowserUserId(null);
        setAuthState({ status: "anonymous" });
      }
    };

    void loadCurrentUser();

    return () => {
      isCancelled = true;
    };
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setActiveBrowserUserId(null);
    setAuthState({ status: "anonymous" });
  }

  if (authState.status === "checking") {
    return (
      <main className="auth-shell">
        <section className="auth-panel compact-auth" aria-live="polite">
          <div className="mark auth-mark">
            <span>昼</span>
          </div>
          <h1>正在确认账号</h1>
          <p>读取你的个人记忆空间。</p>
        </section>
      </main>
    );
  }

  if (authState.status === "anonymous") {
    return <AuthScreen onAuthenticated={(user) => setAuthState({ status: "authenticated", user })} />;
  }

  return <DailyBriefApp user={authState.user} onLogout={handleLogout} />;
}

function DailyBriefApp({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [payload, setPayload] = useState<DayPayload | null>(null);
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsPayload | null>(null);
  const [apiKeyMode, setApiKeyMode] = useState<ApiKeyMode>("default");
  const [customApiKey, setCustomApiKey] = useState("");
  const [hasBrowserCustomApiKey, setHasBrowserCustomApiKey] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isOpeningDataFolder, setIsOpeningDataFolder] = useState(false);
  const [isTrustPanelOpen, setIsTrustPanelOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("等待上传");
  const [errorMessage, setErrorMessage] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [isResolvingUpload, setIsResolvingUpload] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [activeView, setActiveView] = useState<WorkspaceView>("brief");
  const [memoryScope, setMemoryScope] = useState<MemoryScope>("current");
  const [searchText, setSearchText] = useState("");
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const defaultRecordingDate = useMemo(() => formatLocalDateInputValue(), []);
  const [selectedDate, setSelectedDate] = useState(defaultRecordingDate);
  const [selectedDateHasNoUpload, setSelectedDateHasNoUpload] = useState(false);
  const [isDateCalendarOpen, setIsDateCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => dateToMonthValue(defaultRecordingDate));
  const [recordingDates, setRecordingDates] = useState<string[]>([]);
  const [deletingRecordingId, setDeletingRecordingId] = useState<string | null>(null);
  const uploadIdRef = useRef<string | null>(null);
  const storedRestoreUploadIdRef = useRef<string | null>(null);
  const requestTokenRef = useRef(0);
  const pollTimeoutRef = useRef<number | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);
  const uploadDialogRef = useRef<HTMLDivElement | null>(null);
  const uploadCloseButtonRef = useRef<HTMLButtonElement | null>(null);

  const clearScheduledPoll = useCallback(() => {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  const invalidateActiveRequests = useCallback(() => {
    requestTokenRef.current += 1;
    clearScheduledPoll();
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    setIsFetching(false);
  }, [clearScheduledPoll]);

  const restoreLatestUpload = useCallback(
    async (input: { signal: AbortSignal; requestToken: number; excludedUploadId?: string }) => {
      setIsResolvingUpload(true);
      setStatusMessage("正在恢复最近的录音");

      try {
        const response = await fetch("/api/uploads/latest", {
          cache: "no-store",
          signal: input.signal
        });
        const latest = (await response.json()) as { uploadId?: string | null };

        if (input.signal.aborted || input.requestToken !== requestTokenRef.current) {
          return false;
        }

        if (!response.ok || !latest.uploadId || latest.uploadId === input.excludedUploadId) {
          setIsResolvingUpload(false);
          setStatusMessage("等待上传");
          return false;
        }

        writeStoredUploadId(latest.uploadId);
        storedRestoreUploadIdRef.current = null;
        setUploadId(latest.uploadId);
        uploadIdRef.current = latest.uploadId;
        setIsResolvingUpload(false);
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return false;
        }

        if (input.requestToken === requestTokenRef.current) {
          setIsResolvingUpload(false);
          setStatusMessage("等待上传");
        }

        return false;
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();

    const fetchProviderSettings = async () => {
      try {
        const response = await fetch("/api/settings", {
          cache: "no-store",
          signal: controller.signal
        });
        const settings = (await response.json()) as ProviderSettingsPayload;

        if (!response.ok || controller.signal.aborted) {
          return;
        }

        const storedOpenRouterApiKey = readStoredOpenRouterApiKey();
        setProviderSettings(settings);
        setHasBrowserCustomApiKey(Boolean(storedOpenRouterApiKey));
        setApiKeyMode(storedOpenRouterApiKey ? "custom" : "default");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        setSettingsMessage("读取配置失败。");
      }
    };

    void fetchProviderSettings();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const storedUploadId = readStoredUploadId();

    if (storedUploadId) {
      storedRestoreUploadIdRef.current = storedUploadId;
      setUploadId(storedUploadId);
      uploadIdRef.current = storedUploadId;
      return;
    }

    const storedSelectedDate = readStoredSelectedRecordingDate();

    if (storedSelectedDate) {
      void handleDateChange(storedSelectedDate);
      return;
    }

    const controller = new AbortController();
    const requestToken = requestTokenRef.current;

    void restoreLatestUpload({ signal: controller.signal, requestToken });

    return () => {
      controller.abort();
    };
  }, [restoreLatestUpload]);

  const fetchSingleDayPayload = useCallback(async (targetUploadId: string, signal: AbortSignal): Promise<DayRequestResult> => {
    try {
      const cachedPayload = readLocalDayPayload(targetUploadId);
      if (cachedPayload) {
        const normalizedCachedPayload = toLocalDayPayload(cachedPayload);

        return {
          kind: "success",
          payload: normalizedCachedPayload,
          status: normalizedCachedPayload.job?.status ?? normalizedCachedPayload.upload.status,
          progress: normalizedCachedPayload.job?.progress ?? 100,
          source: "browser"
        };
      }

      if (isLocalUploadId(targetUploadId)) {
        if (signal.aborted) {
          return { kind: "aborted" };
        }

        return {
          kind: "error",
          errorMessage: "当前浏览器没有找到这条本地录音。"
        };
      }

      const response = await fetch(`/api/days/${targetUploadId}`, {
        cache: "no-store",
        signal
      });
      const nextPayload = (await response.json()) as DayPayload & { error?: string };

      if (!response.ok) {
        return {
          kind: "error",
          errorMessage: nextPayload.error ?? "读取分析结果失败。"
        };
      }

      return {
        kind: "success",
        payload: nextPayload,
        status: nextPayload.job?.status ?? nextPayload.upload.status,
        progress: nextPayload.job?.progress ?? 0,
        source: "server",
        serverPayloads: [toLocalDayPayload(nextPayload)],
        serverUploadIds: [targetUploadId]
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { kind: "aborted" };
      }

      return {
        kind: "error",
        errorMessage: "读取分析结果失败。"
      };
    }
  }, []);

  const fetchDayPayloadsForDate = useCallback(
    async (recordingDate: string, signal: AbortSignal, seedServerPayloads: LocalDayPayload[] = []): Promise<DayRequestResult> => {
      const localPayloads = readLocalDayPayloadsForDate(recordingDate);
      const localUploadIds = new Set(localPayloads.map((item) => item.upload.id));
      const seedUploadIds = new Set(seedServerPayloads.map((item) => item.upload.id));
      let uploadIds: string[] = [];

      try {
        const response = await fetch(`/api/uploads/by-date?date=${encodeURIComponent(recordingDate)}`, {
          cache: "no-store",
          signal
        });
        const result = (await response.json()) as { uploadId?: string | null; uploadIds?: string[]; recordingDate?: string; error?: string };

        if (signal.aborted) {
          return { kind: "aborted" };
        }

        if (!response.ok) {
          if (localPayloads.length === 0 && seedServerPayloads.length === 0) {
            return {
              kind: "error",
              errorMessage: result.error ?? "按日期读取录音失败。"
            };
          }
        } else {
          uploadIds = result.uploadIds ?? (result.uploadId ? [result.uploadId] : []);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return { kind: "aborted" };
        }

        if (localPayloads.length === 0 && seedServerPayloads.length === 0) {
          return {
            kind: "error",
            errorMessage: "按日期读取录音失败。"
          };
        }
      }

      const remoteUploadIds = uploadIds.filter((id) => !localUploadIds.has(id) && !seedUploadIds.has(id));
      const remoteResults = await Promise.all(remoteUploadIds.map((id) => fetchSingleDayPayload(id, signal)));

      if (signal.aborted || remoteResults.some((result) => result.kind === "aborted")) {
        return { kind: "aborted" };
      }

      const successfulRemoteResults = remoteResults.filter(
        (result): result is Extract<DayRequestResult, { kind: "success" }> => result.kind === "success"
      );
      const remotePayloads = successfulRemoteResults.map((result) => toLocalDayPayload(result.payload));
      const discoveredPayloads = uniquePayloadsByUploadId([...localPayloads, ...seedServerPayloads, ...remotePayloads]);
      const payloadById = new Map(discoveredPayloads.map((payload) => [payload.upload.id, payload]));
      const listedUploadIds = new Set(uploadIds);
      const orderedPayloads = uploadIds.flatMap((id) => {
        const matchedPayload = payloadById.get(id);
        return matchedPayload ? [matchedPayload] : [];
      });
      const payloads =
        orderedPayloads.length > 0
          ? [...orderedPayloads, ...discoveredPayloads.filter((payload) => !listedUploadIds.has(payload.upload.id))]
          : discoveredPayloads;

      if (payloads.length === 0) {
        return {
          kind: "empty",
          recordingDate
        };
      }

      const dayPayload = dayPayloadFromRecordings(payloads);
      const serverPayloads = uniquePayloadsByUploadId([
        ...seedServerPayloads,
        ...successfulRemoteResults.flatMap((result) => result.serverPayloads ?? [])
      ]);
      const serverUploadIds = [...new Set([...seedServerPayloads.map((payload) => payload.upload.id), ...successfulRemoteResults.flatMap((result) => result.serverUploadIds ?? [])])];

      return {
        kind: "success",
        payload: dayPayload,
        status: dayPayload.job?.status ?? dayPayload.upload.status,
        progress: dayPayload.job?.progress ?? 100,
        source: serverPayloads.length > 0 ? "server" : "browser",
        serverPayloads,
        serverUploadIds
      };
    },
    [fetchSingleDayPayload]
  );

  const fetchDayPayload = useCallback(
    async (targetUploadId: string, signal: AbortSignal): Promise<DayRequestResult> => {
      const recordingDate = dateFromDayUploadId(targetUploadId);

      if (recordingDate) {
        return fetchDayPayloadsForDate(recordingDate, signal);
      }

      const singleResult = await fetchSingleDayPayload(targetUploadId, signal);
      if (singleResult.kind !== "success" || singleResult.source !== "server") {
        return singleResult;
      }

      return fetchDayPayloadsForDate(singleResult.payload.upload.recordingDate, signal, singleResult.serverPayloads ?? [toLocalDayPayload(singleResult.payload)]);
    },
    [fetchDayPayloadsForDate, fetchSingleDayPayload]
  );

  useEffect(() => {
    uploadIdRef.current = uploadId;

    if (!uploadId) {
      clearScheduledPoll();
      return;
    }

    const requestToken = requestTokenRef.current;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setIsFetching(true);

    const run = async () => {
      const result = await fetchDayPayload(uploadId, controller.signal);

      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }

      if (requestToken !== requestTokenRef.current || uploadIdRef.current !== uploadId) {
        return;
      }

      setIsFetching(false);

      if (result.kind === "aborted") {
        return;
      }

      if (result.kind === "empty") {
        clearStoredUploadId();
        setUploadId(null);
        uploadIdRef.current = null;
        setPayload(null);
        setSelectedDate(result.recordingDate);
        setCalendarMonth(dateToMonthValue(result.recordingDate));
        writeStoredSelectedRecordingDate(result.recordingDate);
        setSelectedDateHasNoUpload(true);
        setIsResolvingUpload(false);
        setErrorMessage("");
        setStatusMessage("这一天没有录音");
        return;
      }

      if (result.kind === "error") {
        if (storedRestoreUploadIdRef.current === uploadId) {
          storedRestoreUploadIdRef.current = null;
          clearStoredUploadId();
          setUploadId(null);
          uploadIdRef.current = null;
          setPayload(null);
          setErrorMessage("");

          const restoredLatest = await restoreLatestUpload({
            signal: controller.signal,
            requestToken,
            excludedUploadId: uploadId
          });

          if (restoredLatest || requestToken !== requestTokenRef.current || uploadIdRef.current !== uploadId) {
            return;
          }
        }

        setErrorMessage(result.errorMessage);
        return;
      }

      if (storedRestoreUploadIdRef.current === uploadId) {
        storedRestoreUploadIdRef.current = null;
      }

      setPayload(result.payload);
      setSelectedDate(result.payload.upload.recordingDate);
      setCalendarMonth(dateToMonthValue(result.payload.upload.recordingDate));
      writeStoredSelectedRecordingDate(result.payload.upload.recordingDate);
      if (isQuestionReadyPayload(result.payload)) {
        setRecordingDates((current) =>
          current.includes(result.payload.upload.recordingDate) ? current : [...current, result.payload.upload.recordingDate].sort()
        );
      }
      setSelectedDateHasNoUpload(false);
      setErrorMessage("");
      setStatusMessage(`${result.status} · ${result.progress}%`);
      if (uploadId !== result.payload.upload.id && (isDayUploadId(uploadId) || result.payload.isDayAggregate)) {
        writeStoredUploadId(result.payload.upload.id);
        setUploadId(result.payload.upload.id);
        uploadIdRef.current = result.payload.upload.id;
      }

      if (result.status === "ready" && result.source === "server" && result.serverPayloads?.length) {
        try {
          result.serverPayloads.forEach((serverPayload) => saveLocalDayPayload(serverPayload));
          result.serverUploadIds?.forEach((serverUploadId) => {
            if (!isLocalUploadId(serverUploadId)) {
              void cleanupServerUploadAfterLocalCache(serverUploadId);
            }
          });

          const sameDayPayloads = uniquePayloadsByUploadId([
            ...readLocalDayPayloadsForDate(result.payload.upload.recordingDate),
            ...result.serverPayloads
          ]);

          if (sameDayPayloads.length > 1) {
            const combinedPayload = combineDayPayloads(sameDayPayloads);
            writeStoredUploadId(combinedPayload.upload.id);
            setUploadId(combinedPayload.upload.id);
            uploadIdRef.current = combinedPayload.upload.id;
            setPayload(combinedPayload);
          }
        } catch {
          setErrorMessage("浏览器本地存储空间不足，暂时无法把这次结果保存到本机。服务端结果会先保留，避免数据丢失。");
        }
      }

      if (result.status !== "ready" && result.status !== "failed") {
        clearScheduledPoll();
        pollTimeoutRef.current = window.setTimeout(() => {
          if (requestToken === requestTokenRef.current && uploadIdRef.current === uploadId) {
            setPollVersion((current) => current + 1);
          }
        }, 1200);
      }
    };

    void run();

    return () => {
      controller.abort();
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    };
  }, [clearScheduledPoll, fetchDayPayload, pollVersion, restoreLatestUpload, uploadId]);

  useEffect(() => {
    if (!isUploadOpen) {
      return;
    }

    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    uploadCloseButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsUploadOpen(false);
        return;
      }

      if (event.key !== "Tab" || !uploadDialogRef.current) {
        return;
      }

      const focusableElements = Array.from(
        uploadDialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )
      );

      if (focusableElements.length === 0) {
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [isUploadOpen]);

  async function handleSaveProviderSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSettingsMessage("");

    const openRouterApiKey = customApiKey.trim();
    if (apiKeyMode === "custom" && !openRouterApiKey && !hasBrowserCustomApiKey) {
      setSettingsMessage("请输入 OpenRouter API Key。");
      return;
    }

    setIsSavingSettings(true);

    if (apiKeyMode === "custom") {
      if (openRouterApiKey) {
        writeStoredOpenRouterApiKey(openRouterApiKey);
        setHasBrowserCustomApiKey(true);
      }

      setCustomApiKey("");
      setSettingsMessage("正在使用你的 OpenRouter Key，本地优先模式");
      setIsSavingSettings(false);
      return;
    }

    clearStoredOpenRouterApiKey();
    setHasBrowserCustomApiKey(false);

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          apiKeyMode
        })
      });
      const settings = (await response.json()) as ProviderSettingsPayload & { error?: string };

      if (!response.ok) {
        setSettingsMessage(settings.error ?? "保存配置失败。");
        return;
      }

      setProviderSettings(settings);
      setApiKeyMode(settings.apiKeyMode);
      setCustomApiKey("");
      setSettingsMessage("已切回默认服务 Key");
    } catch {
      setSettingsMessage("保存配置失败。");
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleOpenDataFolder() {
    if (!canOpenDataFolder) {
      setSettingsMessage(openFolderErrorMessage);
      return;
    }

    setSettingsMessage("");
    setIsOpeningDataFolder(true);

    try {
      const response = await fetch("/api/settings/open-data-folder", {
        method: "POST"
      });

      if (!response.ok) {
        setSettingsMessage(openFolderErrorMessage);
        return;
      }

      setSettingsMessage("已打开本地数据文件夹。");
    } catch {
      setSettingsMessage(openFolderErrorMessage);
    } finally {
      setIsOpeningDataFolder(false);
    }
  }

  async function deleteUploadRecord(targetUploadId: string) {
    const cachedPayload = readLocalDayPayload(targetUploadId);

    if (cachedPayload && !isLocalUploadId(targetUploadId)) {
      const response = await fetch(`/api/uploads/${targetUploadId}`, {
        method: "DELETE"
      });
      if (!response.ok && response.status !== 404) {
        const errorPayload = (await response.json()) as { error?: string };
        return { ok: false, errorMessage: errorPayload.error ?? "删除失败。" };
      }
      deleteLocalDayPayload(targetUploadId);
      return { ok: true };
    }

    if (cachedPayload || isLocalUploadId(targetUploadId)) {
      deleteLocalDayPayload(targetUploadId);
      return { ok: true };
    }

    const response = await fetch(`/api/uploads/${targetUploadId}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      const errorPayload = (await response.json()) as { error?: string };
      return { ok: false, errorMessage: errorPayload.error ?? "删除失败。" };
    }

    return { ok: true };
  }

  function showEmptyDateAfterDelete(recordingDate: string) {
    setUploadId(null);
    uploadIdRef.current = null;
    storedRestoreUploadIdRef.current = null;
    clearStoredUploadId();
    setPayload(null);
    setSelectedDate(recordingDate);
    setCalendarMonth(dateToMonthValue(recordingDate));
    writeStoredSelectedRecordingDate(recordingDate);
    setStatusMessage("这一天没有录音");
    setErrorMessage("");
    setIsResolvingUpload(false);
    setSelectedDateHasNoUpload(true);
    setActiveView("brief");
  }

  async function showDateAfterDelete(recordingDate: string, requestToken: number) {
    const controller = new AbortController();
    const result = await fetchDayPayloadsForDate(recordingDate, controller.signal);

    if (requestToken !== requestTokenRef.current) {
      return;
    }

    if (result.kind === "success") {
      const nextUploadId = result.payload.upload.id;
      writeStoredUploadId(nextUploadId);
      setUploadId(nextUploadId);
      uploadIdRef.current = nextUploadId;
      setPayload(result.payload);
      setSelectedDate(recordingDate);
      setCalendarMonth(dateToMonthValue(recordingDate));
      writeStoredSelectedRecordingDate(recordingDate);
      setStatusMessage(`${result.status} · ${result.progress}%`);
      setSelectedDateHasNoUpload(false);
      setErrorMessage("");
      setIsResolvingUpload(false);
      setActiveView("brief");
      return;
    }

    if (result.kind === "empty") {
      showEmptyDateAfterDelete(recordingDate);
      return;
    }

    if (result.kind === "error") {
      setErrorMessage(result.errorMessage);
      setIsResolvingUpload(false);
    }
  }

  async function handleDeleteRecording(recordingUploadId: string) {
    if (!payload) {
      return;
    }

    const recordingDate = payload.upload.recordingDate;
    invalidateActiveRequests();
    const requestToken = requestTokenRef.current;
    storedRestoreUploadIdRef.current = null;
    setDeletingRecordingId(recordingUploadId);
    setErrorMessage("");

    try {
      const result = await deleteUploadRecord(recordingUploadId);

      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? "删除失败。");
        return;
      }

      clearLocalQaHistory(dayUploadIdForDate(recordingDate));
      clearLocalQaHistory(recordingUploadId);
      await showDateAfterDelete(recordingDate, requestToken);
      await refreshRecordingDates();
    } catch {
      setErrorMessage("删除失败。");
    } finally {
      if (requestToken === requestTokenRef.current) {
        setDeletingRecordingId(null);
      }
    }
  }

  async function handleDelete() {
    if (!uploadId) {
      return;
    }

    const targetUploadId = uploadId;
    const targetRecordingIds = payload?.recordings?.length ? payload.recordings.map((recording) => recording.upload.id) : [payload?.upload.id ?? targetUploadId];
    const targetRecordingDate = payload?.upload.recordingDate ?? selectedDate;
    invalidateActiveRequests();
    const requestToken = requestTokenRef.current;
    storedRestoreUploadIdRef.current = null;

    const resumePollingAfterDeleteFailure = () => {
      if (uploadIdRef.current !== targetUploadId) {
        return;
      }

      clearScheduledPoll();
      pollTimeoutRef.current = window.setTimeout(() => {
        if (uploadIdRef.current === targetUploadId) {
          setPollVersion((current) => current + 1);
        }
      }, 1200);
    };

    try {
      for (const recordingUploadId of targetRecordingIds) {
        const result = await deleteUploadRecord(recordingUploadId);

        if (!result.ok) {
          setErrorMessage(result.errorMessage ?? "删除失败。");
          resumePollingAfterDeleteFailure();
          return;
        }
      }

      clearLocalQaHistory(dayUploadIdForDate(targetRecordingDate));
      targetRecordingIds.forEach((recordingUploadId) => clearLocalQaHistory(recordingUploadId));

      if (targetRecordingIds.length > 1) {
        await showDateAfterDelete(targetRecordingDate, requestToken);
        await refreshRecordingDates();
        return;
      }

      setUploadId(null);
      uploadIdRef.current = null;
      storedRestoreUploadIdRef.current = null;
      clearStoredUploadId();
      setPayload(null);
      setStatusMessage("等待上传");
      setErrorMessage("");
      setIsResolvingUpload(false);
      setSelectedDateHasNoUpload(false);
      setActiveView("brief");
      await refreshRecordingDates();
    } catch {
      setErrorMessage("删除失败。");
      resumePollingAfterDeleteFailure();
    }
  }

  const refreshRecordingDates = useCallback(async () => {
    const localDates = listLocalQuestionReadyDates();

    try {
      const response = await fetch("/api/uploads/dates", {
        cache: "no-store"
      });
      const result = (await response.json()) as { dates?: string[] };

      if (!response.ok) {
        setRecordingDates(mergeDateLists(localDates));
        return;
      }

      setRecordingDates(mergeDateLists(result.dates ?? [], localDates));
    } catch {
      setRecordingDates(mergeDateLists(localDates));
    }
  }, []);

  useEffect(() => {
    void refreshRecordingDates();
  }, [refreshRecordingDates]);

  function handleDateCalendarToggle() {
    setIsDateCalendarOpen((current) => {
      const next = !current;

      if (next) {
        setCalendarMonth(dateToMonthValue(selectedDate));
        void refreshRecordingDates();
      }

      return next;
    });
  }

  function handleCalendarDateSelect(nextDate: string) {
    setIsDateCalendarOpen(false);
    void handleDateChange(nextDate);
  }

  async function handleDateChange(nextDate: string) {
    if (!nextDate) {
      return;
    }

    invalidateActiveRequests();
    const requestToken = requestTokenRef.current;
    setSelectedDate(nextDate);
    setCalendarMonth(dateToMonthValue(nextDate));
    writeStoredSelectedRecordingDate(nextDate);
    setSelectedDateHasNoUpload(false);
    setUploadId(null);
    uploadIdRef.current = null;
    storedRestoreUploadIdRef.current = null;
    clearStoredUploadId();
    setPayload(null);
    setSearchText("");
    setMemoryScope("current");
    setIsResolvingUpload(true);
    setStatusMessage("正在查找这一天的录音");
    setErrorMessage("");

    const localUploadIds = readLocalDayPayloadsForDate(nextDate).map((item) => item.upload.id);
    let serverUploadIds: string[] = [];

    try {
      const response = await fetch(`/api/uploads/by-date?date=${encodeURIComponent(nextDate)}`, {
        cache: "no-store"
      });
      const result = (await response.json()) as { uploadId?: string | null; uploadIds?: string[]; recordingDate?: string; error?: string };

      if (requestToken !== requestTokenRef.current) {
        return;
      }

      if (!response.ok) {
        if (localUploadIds.length === 0) {
          setErrorMessage(result.error ?? "按日期读取录音失败。");
          setIsResolvingUpload(false);
          setStatusMessage("读取失败");
          return;
        }
      } else {
        serverUploadIds = result.uploadIds ?? (result.uploadId ? [result.uploadId] : []);
      }

      const candidateUploadIds = [...new Set([...localUploadIds, ...serverUploadIds])];

      if (candidateUploadIds.length === 0) {
        setSelectedDateHasNoUpload(true);
        setIsResolvingUpload(false);
        setStatusMessage("这一天没有录音");
        return;
      }

      const nextUploadId = candidateUploadIds.length > 1 ? dayUploadIdForDate(nextDate) : candidateUploadIds[0];
      writeStoredUploadId(nextUploadId);
      setUploadId(nextUploadId);
      uploadIdRef.current = nextUploadId;
      setIsResolvingUpload(false);
      setStatusMessage("切换日期中");
      setPollVersion((current) => current + 1);
    } catch {
      if (requestToken !== requestTokenRef.current) {
        return;
      }

      if (localUploadIds.length > 0) {
        const nextUploadId = localUploadIds.length > 1 ? dayUploadIdForDate(nextDate) : localUploadIds[0];
        writeStoredUploadId(nextUploadId);
        setUploadId(nextUploadId);
        uploadIdRef.current = nextUploadId;
        setIsResolvingUpload(false);
        setStatusMessage("切换本地录音中");
        setPollVersion((current) => current + 1);
        return;
      }

      setErrorMessage("按日期读取录音失败。");
      setIsResolvingUpload(false);
      setStatusMessage("读取失败");
    }
  }

  const statusLabel = payload?.job?.status ?? payload?.upload.status ?? (uploadId ? "uploaded" : "idle");
  const progressValue = payload?.job?.progress ?? 0;
  const isReady = statusLabel === "ready" && payload !== null;
  const isFailed = statusLabel === "failed";
  const isProcessing = Boolean(uploadId) && !isReady && !isFailed;
  const recordingDateLabel = formatRecordingDate(payload?.upload.recordingDate ?? selectedDate);
  const durationLabel = formatDuration(inferDurationSeconds(payload));
  const dayRecordings = payload?.recordings ?? [];
  const hasMultipleRecordings = dayRecordings.length > 1;
  const recordIdLabel = hasMultipleRecordings ? payload?.upload.originalName ?? shortRecordId(uploadId) : shortRecordId(uploadId);
  const friendlyStatus = getFriendlyStatus({
    status: statusLabel,
    progress: progressValue,
    hasUpload: Boolean(uploadId),
    hasPayload: Boolean(payload),
    isResolvingUpload,
    statusMessage
  });
  const speakerAliasesByUploadId = useMemo(() => {
    if (!payload) {
      return {};
    }

    return speakerAliasLookupForPayload(payload);
  }, [payload]);
  const displayPayload = useMemo(() => (payload ? applySpeakerAliasesToPayload(payload, speakerAliasesByUploadId) : null), [payload, speakerAliasesByUploadId]);
  const speakerAliasTargets = useMemo(() => (payload ? collectSpeakerAliasTargets(payload) : []), [payload]);
  const normalizedSearchText = normalizeSearchValue(searchText);
  const trimmedSearchText = searchText.trim();
  const visibleBriefItems =
    displayPayload && normalizedSearchText ? displayPayload.briefItems.filter((item) => briefItemMatchesSearch(item, normalizedSearchText)) : displayPayload?.briefItems ?? [];
  const visibleRelationshipSignals = displayPayload?.relationshipSignals ?? [];
  const semanticSegments = displayPayload?.semanticSegments ?? [];
  const hasSemanticSegments = payload?.semanticSegmentsAvailable ?? semanticSegments.length > 0;
  const sourceSegmentById = useMemo(() => new Map((displayPayload?.segments ?? []).map((segment) => [segment.id, segment])), [displayPayload?.segments]);
  const visibleSegments =
    displayPayload && normalizedSearchText && !hasSemanticSegments
      ? displayPayload.segments.filter((segment) => segmentMatchesSearch(segment, normalizedSearchText))
      : displayPayload?.segments ?? [];
  const visibleSemanticSegments =
    displayPayload && normalizedSearchText ? semanticSegments.filter((segment) => semanticSegmentMatchesSearch(segment, normalizedSearchText, sourceSegmentById)) : semanticSegments;
  const visibleTimelineResultCount = hasSemanticSegments ? visibleSemanticSegments.length : visibleSegments.length;
  const totalSearchResultCount = visibleBriefItems.length + visibleTimelineResultCount;
  const localDataDirectory = providerSettings?.dataDirectory ?? ".data";
  const uploadsDirectory = providerSettings?.uploadsDirectory ?? ".data/uploads";
  const apiKeyStoragePath = providerSettings?.apiKeyStoragePath ?? ".data/settings/provider-config.json";
  const storageMode = providerSettings?.storageMode ?? "local";
  const isServerStorage = storageMode === "server";
  const isLocalFirstMode = apiKeyMode === "custom" && hasBrowserCustomApiKey;
  const canOpenDataFolder = providerSettings?.canOpenDataFolder ?? true;
  const shouldShowStoragePaths = !isServerStorage;
  const canShowOpenDataFolder = canOpenDataFolder && !isLocalFirstMode && !isServerStorage;
  const storagePanelLabel = isLocalFirstMode ? "本地优先 / API Key" : isServerStorage ? "在线服务 / API Key" : "本地数据 / API Key";
  const storageTitle = isLocalFirstMode
    ? "本地优先 BYOK：数据保存在当前浏览器"
    : isServerStorage
      ? "在线服务模式：服务器只临时处理"
      : "数据只保存在本机";
  const storageKicker = isLocalFirstMode ? "LOCAL FIRST BYOK" : isServerStorage ? "INTERNAL SERVICE" : "LOCAL FIRST";
  const storagePathLabel = isLocalFirstMode ? "浏览器数据位置" : "本地数据目录";
  const uploadPathLabel = isLocalFirstMode ? "录音文件处理方式" : "录音文件目录";
  const storageCopy = isLocalFirstMode
    ? "使用你的 OpenRouter Key 时，录音文件、转写请求和问答请求都由当前浏览器直连 API 提供商；录音和结果不写入验证服务器。"
    : isServerStorage
      ? "使用默认服务 Key 时，录音会临时上传到当前内部验证服务器处理；处理完成后原始录音会删除，结果会缓存到当前浏览器，并清理服务器记录。"
      : "录音文件、转写片段、摘要和问答记录都写入下面的本地目录。";
  const displayDataDirectory = isLocalFirstMode ? "当前浏览器 localStorage" : localDataDirectory;
  const displayUploadsDirectory = isLocalFirstMode ? "音频文件只在当前浏览器读取，不上传到服务器" : uploadsDirectory;
  const analysisLocationLabel = isLocalFirstMode ? "本地优先 BYOK" : isServerStorage ? "在线服务" : "本地分析";
  const userDisplayName = user.name?.trim() || user.email;
  const userInitial = userDisplayName.trim().at(0)?.toUpperCase() || "我";
  const openFolderErrorMessage = isLocalFirstMode
    ? "浏览器本地优先模式没有可直接打开的系统文件夹。"
    : "打开本地数据文件夹失败。";
  const effectiveActiveApiKeySource =
    apiKeyMode === "custom" && hasBrowserCustomApiKey ? "custom" : providerSettings?.activeApiKeySource ?? "missing";
  const activeApiKeyLabel =
    effectiveActiveApiKeySource === "custom"
      ? "正在使用你的 OpenRouter Key"
      : effectiveActiveApiKeySource === "default"
        ? "正在使用默认服务 Key"
        : "API Key 未配置";
  const renderedMemoryScopes = useMemo(
    () =>
      memoryScopes.map((scope) =>
        scope.id === "current" ? { ...scope, date: formatScopeDate(payload?.upload.recordingDate ?? selectedDate, defaultRecordingDate) } : scope
      ),
    [defaultRecordingDate, payload?.upload.recordingDate, selectedDate]
  );
  const activeMemoryScope = renderedMemoryScopes.find((scope) => scope.id === memoryScope) ?? renderedMemoryScopes[0];
  const recordingDateSet = useMemo(() => new Set(recordingDates), [recordingDates]);
  const selectedWeekRange = useMemo(() => weekRangeForDate(selectedDate), [selectedDate]);
  const localMemoryPayloads = useMemo(() => {
    const currentPayload = displayPayload && isQuestionReadyPayload(displayPayload) ? [toLocalDayPayload(displayPayload)] : [];
    const aliasedStoredPayloads = listLocalQuestionReadyPayloads().map((localPayload) => applyPayloadSpeakerAliases(localPayload));
    return uniquePayloadsByUploadId([...aliasedStoredPayloads, ...currentPayload]);
  }, [displayPayload, recordingDates]);
  const weekMemoryContext = useMemo(
    () =>
      buildMemoryContextPayload({
        scope: "week",
        referenceDate: selectedDate,
        payloads: localMemoryPayloads
      }),
    [localMemoryPayloads, selectedDate]
  );
  const allMemoryContext = useMemo(
    () =>
      buildMemoryContextPayload({
        scope: "all",
        referenceDate: selectedDate,
        payloads: localMemoryPayloads
      }),
    [localMemoryPayloads, selectedDate]
  );
  const activeLocalMemoryContext = memoryScope === "week" ? weekMemoryContext : memoryScope === "all" ? allMemoryContext : null;
  const hasCurrentScopeData = isReady && Boolean(payload) && isQuestionReadyPayload(payload);
  const hasWeekScopeData =
    Boolean(weekMemoryContext) ||
    (!isLocalFirstMode && recordingDates.some((recordingDate) => isDateInRange(recordingDate, selectedWeekRange.startKey, selectedWeekRange.endKey)));
  const hasAllScopeData = Boolean(allMemoryContext) || (!isLocalFirstMode && recordingDates.length > 0);
  const activeScopeHasData =
    memoryScope === "current" ? hasCurrentScopeData : memoryScope === "week" ? hasWeekScopeData : hasAllScopeData;
  const voiceQaModeUnavailableReason = isLocalFirstMode
    ? "语音问答暂不支持浏览器本地优先数据。切回服务端保存的记忆后即可使用。"
    : undefined;
  const voiceQaUnavailableReason = ({
    hasData,
    isDayAggregate = false
  }: {
    hasData: boolean;
    isDayAggregate?: boolean;
  }) =>
    voiceQaModeUnavailableReason ??
    (!hasData
      ? "当前范围还没有可用于语音问答的记忆。"
      : isDayAggregate
        ? "当前日期包含多条录音，暂不支持按聚合结果进行语音问答。请切换到本周或全部记忆。"
        : undefined);
  const activeQaEmptyState = !activeScopeHasData
    ? {
        current: {
          title: "这一天还没有可用于问答的录音",
          detail: `${formatRecordingDate(selectedDate)} 暂无处理完成的录音，上传这一天的录音后就可以提问。`,
          placeholder: "这一天还没有录音，上传后再问",
          actions: [
            {
              label: "上传录音",
              onClick: () => setIsUploadOpen(true)
            },
            ...(hasAllScopeData
              ? [
                  {
                    label: "切到全部记忆",
                    onClick: () => {
                      setMemoryScope("all");
                      setActiveView("qa");
                    }
                  }
                ]
              : [])
          ]
        },
        week: {
          title: "这一周还没有可用于问答的录音",
          detail: `${formatRecordingDate(selectedWeekRange.startKey)} 至 ${formatRecordingDate(selectedWeekRange.endKey)} 暂无处理完成的录音，上传本周录音后就可以提问。`,
          placeholder: "本周还没有录音，上传后再问",
          actions: [
            {
              label: "上传录音",
              onClick: () => setIsUploadOpen(true)
            },
            ...(hasAllScopeData
              ? [
                  {
                    label: "切到全部记忆",
                    onClick: () => {
                      setMemoryScope("all");
                      setActiveView("qa");
                    }
                  }
                ]
              : [])
          ]
        },
        all: {
          title: "还没有可用于问答的录音",
          detail: "当前账号暂无处理完成的录音，上传录音后就可以跨日期提问。",
          placeholder: "还没有录音，上传后再问",
          actions: [
            {
              label: "上传录音",
              onClick: () => setIsUploadOpen(true)
            }
          ]
        }
      }[memoryScope]
    : undefined;
  const currentProactiveQaPresentation = useMemo(
    () => {
      const ruleSuggestions = buildProactiveQaSuggestions({
        scope: "current",
        referenceDate: selectedDate,
        payload: displayPayload && isQuestionReadyPayload(displayPayload) ? toLocalDayPayload(displayPayload) : null
      });

      return buildProactiveQaPresentation({
        agentInsights: displayPayload?.proactiveInsights ?? [],
        ruleSuggestions
      });
    },
    [displayPayload, selectedDate]
  );
  const currentQaScopeMeta = useMemo(
    () =>
      buildQaScopeMeta({
        scope: "current",
        referenceDate: selectedDate,
        payload: displayPayload && isQuestionReadyPayload(displayPayload) ? toLocalDayPayload(displayPayload) : null
      }),
    [displayPayload, selectedDate]
  );
  const memoryProactiveQaPresentation = useMemo(
    () => {
      const ruleSuggestions = buildProactiveQaSuggestions({
        scope: memoryScope === "all" ? "all" : "week",
        referenceDate: selectedDate,
        memoryPayloads: localMemoryPayloads,
        memoryContext: activeLocalMemoryContext,
        hasServerScopeData: memoryScope === "all" ? hasAllScopeData : hasWeekScopeData
      });

      return buildProactiveQaPresentation({
        agentInsights: [],
        ruleSuggestions
      });
    },
    [activeLocalMemoryContext, hasAllScopeData, hasWeekScopeData, localMemoryPayloads, memoryScope, selectedDate]
  );
  const memoryQaScopeMeta = useMemo(
    () =>
      buildQaScopeMeta({
        scope: memoryScope === "all" ? "all" : "week",
        referenceDate: selectedDate,
        memoryPayloads: localMemoryPayloads,
        memoryContext: activeLocalMemoryContext,
        recordingDates,
        hasServerScopeData: memoryScope === "all" ? hasAllScopeData : hasWeekScopeData
      }),
    [activeLocalMemoryContext, hasAllScopeData, hasWeekScopeData, localMemoryPayloads, memoryScope, recordingDates, selectedDate]
  );
  const calendarDays = useMemo(() => buildCalendarDays(calendarMonth), [calendarMonth]);

  async function handleLocalAnalyze(input: { file: File; recordingDate: string }) {
    const apiKey = readStoredOpenRouterApiKey();

    if (!apiKey) {
      const message = "请先保存你的 OpenRouter Key，再使用本地优先模式。";
      setErrorMessage(message);
      setSettingsMessage(message);
      throw new Error(message);
    }

    invalidateActiveRequests();
    const requestToken = requestTokenRef.current;
    setSelectedDate(input.recordingDate);
    setCalendarMonth(dateToMonthValue(input.recordingDate));
    writeStoredSelectedRecordingDate(input.recordingDate);
    setSelectedDateHasNoUpload(false);
    setUploadId(null);
    uploadIdRef.current = null;
    storedRestoreUploadIdRef.current = null;
    clearStoredUploadId();
    setPayload(null);
    setIsResolvingUpload(false);
    setStatusMessage("本地转写中 · 25%");
    setErrorMessage("");

    try {
      const nextPayload = await analyzeAudioLocally({
        file: input.file,
        recordingDate: input.recordingDate,
        apiKey
      });

      if (requestToken !== requestTokenRef.current) {
        return;
      }

      saveLocalDayPayload(nextPayload);
      const sameDayPayloads = uniquePayloadsByUploadId([
        ...readLocalDayPayloadsForDate(nextPayload.upload.recordingDate),
        nextPayload
      ]);
      const nextDisplayPayload = dayPayloadFromRecordings(sameDayPayloads);
      writeStoredUploadId(nextDisplayPayload.upload.id);
      setUploadId(nextDisplayPayload.upload.id);
      uploadIdRef.current = nextDisplayPayload.upload.id;
      setPayload(nextDisplayPayload);
      if (isQuestionReadyPayload(nextPayload)) {
        setRecordingDates((current) => mergeDateLists(current, [nextPayload.upload.recordingDate]));
      }
      setStatusMessage("ready · 100%");
      setActiveView("brief");
      setMemoryScope("current");
      setIsUploadOpen(false);
    } catch (error) {
      if (requestToken === requestTokenRef.current) {
        setStatusMessage("本地分析失败");
        setErrorMessage(error instanceof Error ? error.message : "本地分析失败。");
      }

      throw error;
    }
  }

  const handleLocalQuestion = useCallback(async (input: QaQuestionInput) => {
    const apiKey = readStoredOpenRouterApiKey();

    if (!apiKey || !displayPayload) {
      throw new Error("当前浏览器没有可用于本地问答的录音或 OpenRouter Key。");
    }

    return answerQuestionLocally({
      payload: toLocalDayPayload(displayPayload),
      apiKey,
      question: input.question,
      conversation: input.conversation,
      model: input.model,
      promptPresetId: input.promptPresetId,
      customPrompt: input.customPrompt
    });
  }, [displayPayload]);

  const handleServerContextQuestion = useCallback(async (input: QaQuestionInput) => {
    if (!displayPayload) {
      throw new Error("当前没有可用于问答的录音。");
    }

    const response = await fetch("/api/days/context/qa", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        uploadId: displayPayload.upload.id,
        question: input.question,
        ...(input.conversation.length > 0 ? { conversation: input.conversation } : {}),
        promptPresetId: input.promptPresetId,
        customPrompt: input.customPrompt,
        segments: displayPayload.segments,
        audioInsights: displayPayload.audioInsights ?? [],
        semanticSegments: displayPayload.semanticSegments ?? [],
        briefItems: displayPayload.briefItems,
        relationshipSignals: displayPayload.relationshipSignals ?? []
      })
    });
    const answer = (await response.json()) as QaAnswerPayload;

    if (!response.ok) {
      throw new Error(answer.error ?? "当天问答失败。");
    }

    return answer;
  }, [displayPayload]);

  const handleServerContextQuestionStream = useCallback(async (input: QaStreamQuestionInput) => {
    if (!displayPayload) {
      throw new Error("当前没有可用于问答的录音。");
    }

    return fetch("/api/days/context/qa", {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        uploadId: displayPayload.upload.id,
        question: input.question,
        ...(input.conversation.length > 0 ? { conversation: input.conversation } : {}),
        promptPresetId: input.promptPresetId,
        customPrompt: input.customPrompt,
        segments: displayPayload.segments,
        audioInsights: displayPayload.audioInsights ?? [],
        semanticSegments: displayPayload.semanticSegments ?? [],
        briefItems: displayPayload.briefItems,
        relationshipSignals: displayPayload.relationshipSignals ?? []
      }),
      signal: input.signal
    });
  }, [displayPayload]);

  const handleMemoryContextQuestion = useCallback(
    async (input: QaQuestionInput) => {
      if (!activeLocalMemoryContext) {
        throw new Error("当前范围没有可用于问答的本地记忆。");
      }

      if (isLocalFirstMode) {
        const apiKey = readStoredOpenRouterApiKey();

        if (!apiKey) {
          throw new Error("请先保存你的 OpenRouter Key，再使用本地优先模式。");
        }

        return answerQuestionLocally({
          payload: memoryContextToLocalPayload(activeLocalMemoryContext, selectedDate),
          apiKey,
          question: input.question,
          conversation: input.conversation,
          scope: activeLocalMemoryContext.scope,
          model: input.model,
          promptPresetId: input.promptPresetId,
          customPrompt: input.customPrompt
        });
      }

      const response = await fetch("/api/days/context/qa", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          uploadId: activeLocalMemoryContext.uploadId,
          scope: activeLocalMemoryContext.scope,
          question: input.question,
          ...(input.conversation.length > 0 ? { conversation: input.conversation } : {}),
          promptPresetId: input.promptPresetId,
          customPrompt: input.customPrompt,
          segments: activeLocalMemoryContext.segments,
          audioInsights: activeLocalMemoryContext.audioInsights,
          semanticSegments: activeLocalMemoryContext.semanticSegments,
          briefItems: activeLocalMemoryContext.briefItems,
          relationshipSignals: activeLocalMemoryContext.relationshipSignals
        })
      });
      const answer = (await response.json()) as QaAnswerPayload;

      if (!response.ok) {
        throw new Error(answer.error ?? "记忆范围问答失败。");
      }

      return answer;
    },
    [activeLocalMemoryContext, isLocalFirstMode, selectedDate]
  );

  const handleMemoryContextQuestionStream = useCallback(
    async (input: QaStreamQuestionInput) => {
      if (!activeLocalMemoryContext || isLocalFirstMode) {
        throw new Error("当前范围没有可用于服务端流式问答的记忆。");
      }

      return fetch("/api/days/context/qa", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          uploadId: activeLocalMemoryContext.uploadId,
          scope: activeLocalMemoryContext.scope,
          question: input.question,
          ...(input.conversation.length > 0 ? { conversation: input.conversation } : {}),
          promptPresetId: input.promptPresetId,
          customPrompt: input.customPrompt,
          segments: activeLocalMemoryContext.segments,
          audioInsights: activeLocalMemoryContext.audioInsights,
          semanticSegments: activeLocalMemoryContext.semanticSegments,
          briefItems: activeLocalMemoryContext.briefItems,
          relationshipSignals: activeLocalMemoryContext.relationshipSignals
        }),
        signal: input.signal
      });
    },
    [activeLocalMemoryContext, isLocalFirstMode]
  );

  const loadCurrentQuestionHistory = useCallback(() => {
    return payload ? readLocalQaHistory(payload.upload.id) : [];
  }, [payload]);

  const saveCurrentQuestionHistory = useCallback(
    (turn: QaHistoryTurn) => {
      if (!payload) {
        return;
      }

      appendLocalQaHistory(payload.upload.id, {
        id: turn.id,
        uploadId: payload.upload.id,
        question: turn.question,
        answer: turn.answer,
        citedSegmentIds: turn.citedSegmentIds,
        citations: turn.citations,
        createdAt: turn.createdAt ?? new Date().toISOString()
      });
    },
    [payload]
  );

  const loadMemoryQuestionHistory = useCallback(() => {
    return activeLocalMemoryContext ? readLocalQaHistory(activeLocalMemoryContext.uploadId) : [];
  }, [activeLocalMemoryContext]);

  const saveMemoryQuestionHistory = useCallback(
    (turn: QaHistoryTurn) => {
      if (!activeLocalMemoryContext) {
        return;
      }

      appendLocalQaHistory(activeLocalMemoryContext.uploadId, {
        id: turn.id,
        uploadId: activeLocalMemoryContext.uploadId,
        question: turn.question,
        answer: turn.answer,
        citedSegmentIds: turn.citedSegmentIds,
        citations: turn.citations,
        createdAt: turn.createdAt ?? new Date().toISOString()
      });
    },
    [activeLocalMemoryContext]
  );

  const handleSaveSpeakerAliases = useCallback(
    async (nextAliasesByUploadId: Record<string, Record<string, string>>) => {
      if (!payload) {
        throw new Error("当前没有可保存的录音。");
      }

      const aliasesByUploadId = sanitizeSpeakerAliasesByUploadId(nextAliasesByUploadId);
      const targetUploadIds = Object.keys(nextAliasesByUploadId).filter((targetUploadId) => /^[A-Za-z0-9_-]+$/.test(targetUploadId));
      const nextPayload = {
        ...payload,
        speakerAliases: payload.isDayAggregate ? {} : (aliasesByUploadId[payload.upload.id] ?? {}),
        speakerAliasesByUploadId: aliasesByUploadId
      };

      for (const targetUploadId of targetUploadIds) {
        const aliases = sanitizeSpeakerAliases(nextAliasesByUploadId[targetUploadId] ?? {});
        let savedToLocalCache = false;
        let localSaveError: unknown = null;

        try {
          savedToLocalCache = saveSpeakerAliasesToLocalCache(targetUploadId, aliases);
        } catch (error) {
          localSaveError = error;
        }

        if (!isLocalUploadId(targetUploadId) && !isDayUploadId(targetUploadId)) {
          const response = await fetch(`/api/days/${targetUploadId}/speaker-aliases`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ aliases })
          });
          const result = (await response.json()) as { aliases?: Record<string, string>; error?: string };

          if (!response.ok) {
            if (response.status === 404 && result.error === "upload_not_found" && savedToLocalCache) {
              continue;
            }

            if (response.status === 404 && result.error === "upload_not_found" && localSaveError) {
              throw new Error("服务端临时记录已清理，且浏览器本地保存失败。");
            }

            throw new Error(result.error ?? "保存说话人名称失败。");
          }

          const savedAliases = sanitizeSpeakerAliases(result.aliases ?? aliases);
          if (Object.keys(savedAliases).length > 0) {
            aliasesByUploadId[targetUploadId] = savedAliases;
          } else {
            delete aliasesByUploadId[targetUploadId];
          }

          try {
            saveSpeakerAliasesToLocalCache(targetUploadId, savedAliases);
          } catch {
            // Best effort; the remote save above remains authoritative for server-backed recordings.
          }
        } else if (localSaveError) {
          throw new Error("保存到浏览器本地失败。");
        }
      }

      nextPayload.speakerAliases = payload.isDayAggregate ? {} : (aliasesByUploadId[payload.upload.id] ?? {});
      nextPayload.speakerAliasesByUploadId = aliasesByUploadId;

      setPayload(nextPayload);

      if (!isDayUploadId(nextPayload.upload.id)) {
        try {
          saveLocalDayPayload(toLocalDayPayload(nextPayload));
        } catch {
          // Server save already succeeded or this is a transient local storage issue.
        }
      }
    },
    [payload]
  );

  const handleSaveAudioInsightCorrection = useCallback(
    async (input: {
      uploadId: string;
      insightId: string;
      correction: {
        labelCorrections: Array<{ from: string; to: string }>;
        note?: string;
      };
    }) => {
      if (!payload) {
        throw new Error("当前没有可保存的录音。");
      }

      const correction = sanitizeAudioInsightCorrection(input.correction);
      if (!correction) {
        throw new Error("纠正内容为空。");
      }

      const targetUploadId = input.uploadId;
      const currentInsightsForUpload = (payload.audioInsights ?? []).filter((insight) => insight.uploadId === targetUploadId);
      const currentCorrections = correctionsFromAudioInsights(currentInsightsForUpload);
      const nextCorrections = {
        ...currentCorrections,
        [input.insightId]: correction
      };
      const nextPayload = withAudioInsightCorrection(payload, targetUploadId, input.insightId, correction);
      let savedToLocalCache = false;
      let localSaveError: unknown = null;

      try {
        savedToLocalCache = saveAudioInsightCorrectionsToLocalCache(targetUploadId, nextCorrections);
      } catch (error) {
        localSaveError = error;
      }

      if (!isLocalUploadId(targetUploadId) && !isDayUploadId(targetUploadId)) {
        const response = await fetch(`/api/days/${targetUploadId}/audio-insight-corrections`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ corrections: nextCorrections })
        });
        const result = (await response.json()) as { corrections?: Record<string, StoredAudioInsightCorrection>; error?: string };

        if (!response.ok) {
          if (response.status === 404 && result.error === "upload_not_found" && savedToLocalCache) {
            setPayload(nextPayload);
            return;
          }

          if (response.status === 404 && result.error === "upload_not_found" && localSaveError) {
            throw new Error("服务端临时记录已清理，且浏览器本地保存失败。");
          }

          throw new Error(result.error ?? "保存语气纠正失败。");
        }

        try {
          saveAudioInsightCorrectionsToLocalCache(targetUploadId, result.corrections ?? nextCorrections);
        } catch {
          // The server save remains authoritative for server-backed recordings.
        }
      } else if (localSaveError) {
        throw new Error("保存到浏览器本地失败。");
      }

      setPayload(nextPayload);

      if (!isDayUploadId(nextPayload.upload.id)) {
        try {
          saveLocalDayPayload(toLocalDayPayload(nextPayload));
        } catch {
          // Best effort for browser cache; remote save above remains authoritative when available.
        }
      }
    },
    [payload]
  );

  const handleUploaded = (nextUploadId: string) => {
    invalidateActiveRequests();
    writeStoredUploadId(nextUploadId);
    setUploadId(nextUploadId);
    uploadIdRef.current = nextUploadId;
    storedRestoreUploadIdRef.current = null;
    setPayload(null);
    setIsResolvingUpload(false);
    setSelectedDateHasNoUpload(false);
    setStatusMessage("uploaded · 0%");
    setErrorMessage("");
    setPollVersion((current) => current + 1);
    setActiveView("brief");
    setMemoryScope("current");
    setIsUploadOpen(false);
  };

  const renderWorkspaceState = () => {
    if (activeView === "qa" && memoryScope !== "current") {
      return (
        <section className="workspace-view workspace-view-active qa-workspace-view">
          <QaVoiceWorkspace
            active
            scope={memoryScope}
            referenceDate={memoryScope === "week" ? selectedDate : undefined}
            context={activeLocalMemoryContext ? voiceQaContext({
              contextId: activeLocalMemoryContext.uploadId,
              segments: activeLocalMemoryContext.segments,
              audioInsights: activeLocalMemoryContext.audioInsights,
              semanticSegments: activeLocalMemoryContext.semanticSegments,
              briefItems: activeLocalMemoryContext.briefItems,
              relationshipSignals: activeLocalMemoryContext.relationshipSignals
            }) : undefined}
            unavailableReason={voiceQaUnavailableReason({ hasData: activeScopeHasData })}
          >
            <QaPanel
              uploadId={activeLocalMemoryContext?.uploadId}
              scope={memoryScope}
              referenceDate={selectedDate}
              isActive
              emptyState={activeQaEmptyState}
              proactiveObservations={memoryProactiveQaPresentation.observations}
              suggestedQuestions={memoryProactiveQaPresentation.suggestedQuestions}
              scopeMeta={memoryQaScopeMeta}
              onLocalQuestion={activeLocalMemoryContext ? handleMemoryContextQuestion : undefined}
              onStreamQuestion={
                activeLocalMemoryContext && !isLocalFirstMode
                  ? handleMemoryContextQuestionStream
                  : undefined
              }
              loadQuestionHistory={activeLocalMemoryContext ? loadMemoryQuestionHistory : undefined}
              saveQuestionHistory={activeLocalMemoryContext ? saveMemoryQuestionHistory : undefined}
              includeLoadedHistoryInConversation={Boolean(activeLocalMemoryContext)}
            />
          </QaVoiceWorkspace>
        </section>
      );
    }

    if (isReady && payload) {
      return (
        <>
          <section className={`workspace-view ${activeView === "brief" ? "workspace-view-active" : ""}`} aria-hidden={activeView !== "brief"}>
            <DailyBrief
              items={visibleBriefItems}
              audioInsights={displayPayload?.audioInsights ?? []}
              relationshipSignals={visibleRelationshipSignals}
              transcriptSegmentCount={visibleSegments.length}
              speakerAliasTargets={speakerAliasTargets}
              speakerAliasesByUploadId={speakerAliasesByUploadId}
              onSaveSpeakerAliases={handleSaveSpeakerAliases}
            />
          </section>
          <section
            className={`workspace-view ${activeView === "timeline" ? "workspace-view-active" : ""}`}
            aria-hidden={activeView !== "timeline"}
          >
            <Timeline
              segments={visibleSegments}
              audioInsights={displayPayload?.audioInsights ?? []}
              semanticSegments={visibleSemanticSegments}
              preferSemanticSegments={hasSemanticSegments}
              speakerAliasesByUploadId={speakerAliasesByUploadId}
              onSaveAudioInsightCorrection={handleSaveAudioInsightCorrection}
            />
          </section>
          <section
            className={`workspace-view qa-workspace-view ${activeView === "qa" ? "workspace-view-active" : ""}`}
            aria-hidden={activeView !== "qa"}
          >
            <QaVoiceWorkspace
              active={activeView === "qa"}
              scope="current"
              uploadId={payload.isDayAggregate ? undefined : payload.upload.id}
              context={!payload.isDayAggregate && displayPayload ? voiceQaContext({
                contextId: displayPayload.upload.id,
                segments: displayPayload.segments,
                audioInsights: displayPayload.audioInsights,
                semanticSegments: displayPayload.semanticSegments,
                briefItems: displayPayload.briefItems,
                relationshipSignals: displayPayload.relationshipSignals
              }) : undefined}
              unavailableReason={voiceQaUnavailableReason({
                hasData: hasCurrentScopeData,
                isDayAggregate: Boolean(payload.isDayAggregate)
              })}
            >
              <QaPanel
                uploadId={payload.upload.id}
                scope="current"
                isActive={activeView === "qa"}
                emptyState={activeQaEmptyState}
                proactiveObservations={currentProactiveQaPresentation.observations}
                suggestedQuestions={currentProactiveQaPresentation.suggestedQuestions}
                scopeMeta={currentQaScopeMeta}
                onLocalQuestion={isLocalFirstMode ? handleLocalQuestion : handleServerContextQuestion}
                onStreamQuestion={!isLocalFirstMode ? handleServerContextQuestionStream : undefined}
                loadQuestionHistory={loadCurrentQuestionHistory}
                saveQuestionHistory={saveCurrentQuestionHistory}
                includeLoadedHistoryInConversation={isLocalFirstMode}
              />
            </QaVoiceWorkspace>
          </section>
        </>
      );
    }

    if (isResolvingUpload) {
      return (
        <section className="empty-workspace" aria-labelledby="resolving-title">
          <div className="empty-mark">昼</div>
          <p className="kicker-line">日期切换 · DATE</p>
          <h1 id="resolving-title">正在查找这一天的录音</h1>
          <p>正在读取已保存的录音索引，找到后会自动切换到对应复盘。</p>
        </section>
      );
    }

    if (isFailed) {
      return (
        <section className="empty-workspace" aria-labelledby="failed-title">
          <div className="empty-mark">!</div>
          <p className="kicker-line">处理失败 · FAILED</p>
          <h1 id="failed-title">这次录音没有生成结果</h1>
          <p>{payload?.job?.errorMessage ?? errorMessage ?? "录音处理失败，请删除后重新上传。"}</p>
        </section>
      );
    }

    if (isProcessing) {
      return (
        <section className="empty-workspace" aria-labelledby="processing-title">
          <div className="empty-mark">昼</div>
          <p className="kicker-line">处理中 · PROCESSING</p>
          <h1 id="processing-title">录音处理中，正式结果将在提取完成后展示。</h1>
          <p>当前任务：{statusMessage}</p>
        </section>
      );
    }

    if (activeView === "qa" && memoryScope === "current" && activeQaEmptyState) {
      return (
        <section className="workspace-view workspace-view-active qa-workspace-view">
          <QaVoiceWorkspace
            active
            scope="current"
            unavailableReason={voiceQaUnavailableReason({ hasData: false })}
          >
            <QaPanel scope="current" referenceDate={selectedDate} isActive emptyState={activeQaEmptyState} scopeMeta={currentQaScopeMeta} />
          </QaVoiceWorkspace>
        </section>
      );
    }

    if (selectedDateHasNoUpload) {
      return (
        <section className="empty-workspace" aria-labelledby="no-recording-title">
          <div className="empty-mark">昼</div>
          <p className="kicker-line">日期切换 · DATE</p>
          <h1 id="no-recording-title">这一天没有可查看的录音</h1>
          <p>{formatRecordingDate(selectedDate)} 暂无处理完成或正在处理的录音。你可以切换到其他日期，或上传这一天的录音。</p>
          <button className="btn-up empty-action" type="button" onClick={() => setIsUploadOpen(true)}>
            <UploadIcon />
            上传录音
          </button>
        </section>
      );
    }

    return (
      <section className="empty-workspace" aria-labelledby="idle-title">
        <div className="empty-mark">昼</div>
        <p className="kicker-line">每日简报 · DAILY BRIEF</p>
        <h1 id="idle-title">上传录音后，这里会成为你的工作台。</h1>
        <p>结果区会显示高优先级提要、证据时间线和当日问答，不会在处理完成前挂载真实结果组件。</p>
        <button className="btn-up empty-action" type="button" onClick={() => setIsUploadOpen(true)}>
          <UploadIcon />
          上传录音
        </button>
      </section>
    );
  };

  return (
    <div className="app">
      <aside className="rail" aria-label="昼记导航">
        <div className="brand">
          <div className="mark">
            <span>昼</span>
          </div>
          <div>
            <b>昼记</b>
            <small>Daily Voice Brief</small>
          </div>
        </div>

        <div className="nav-label">工作台</div>
        {views.map((view) => (
          <Fragment key={view.id}>
            <button
              className={`nav-btn ${activeView === view.id ? "on" : ""}`}
              type="button"
              onClick={() => {
                setActiveView(view.id);
                if (view.id !== "qa") {
                  setMemoryScope("current");
                }
              }}
            >
              <NavIcon view={view.id} />
              {view.label}
              {view.badge ? <span className="badge">{view.badge}</span> : null}
            </button>
            {view.id === "qa" ? (
              <div className="qa-scope-nav" role="group" aria-label="问答范围">
                {renderedMemoryScopes.map((scope) => (
                  <button
                    key={scope.id}
                    className={`mem-day ${activeView === "qa" && memoryScope === scope.id ? "on" : ""} ${scope.available ? "" : "locked"}`}
                    type="button"
                    disabled={!scope.available}
                    aria-disabled={!scope.available}
                    onClick={() => {
                      if (!scope.available) {
                        return;
                      }

                      setMemoryScope(scope.id);
                      setActiveView("qa");
                    }}
                  >
                    <span className="dot" />
                    <span className="mem-copy">
                      <b>{scope.label}</b>
                      <span>{scope.detail}</span>
                    </span>
                    <span className="when">{scope.date}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </Fragment>
        ))}

        <div className="rail-foot">
          <div className="me">
            <div className="av">{userInitial}</div>
            <div className="me-copy">
              <b>{userDisplayName}</b>
              <span>{user.email}</span>
              <small>真实录音 · {analysisLocationLabel}</small>
            </div>
          </div>
          <button className="logout-button" type="button" onClick={() => void onLogout()}>
            退出登录
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="scope scope-readonly" aria-label="当前数据范围">
            <span>{activeMemoryScope.label}</span>
            <small>{activeMemoryScope.status}</small>
          </div>
          <div className="date-picker">
            <span>查看日期</span>
            <button
              className="date-picker-button"
              type="button"
              aria-label="查看日期"
              aria-expanded={isDateCalendarOpen}
              aria-controls="recording-date-calendar"
              onClick={handleDateCalendarToggle}
            >
              <span>{formatCompactDate(selectedDate)}</span>
              <span className="date-picker-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {isDateCalendarOpen ? (
              <div id="recording-date-calendar" className="date-calendar" role="dialog" aria-label="选择查看日期">
                <div className="date-calendar-head">
                  <button type="button" aria-label="上个月" onClick={() => setCalendarMonth((current) => shiftMonthValue(current, -1))}>
                    ‹
                  </button>
                  <strong>{formatCalendarMonth(calendarMonth)}</strong>
                  <button type="button" aria-label="下个月" onClick={() => setCalendarMonth((current) => shiftMonthValue(current, 1))}>
                    ›
                  </button>
                </div>
                <div className="date-calendar-week" aria-hidden="true">
                  {["日", "一", "二", "三", "四", "五", "六"].map((dayName) => (
                    <span key={dayName}>{dayName}</span>
                  ))}
                </div>
                <div className="date-calendar-grid" role="grid" aria-label={formatCalendarMonth(calendarMonth)}>
                  {calendarDays.map((day) => {
                    const hasDiary = recordingDateSet.has(day.dateValue);
                    const isSelected = day.dateValue === selectedDate;

                    return (
                      <button
                        key={day.dateValue}
                        className={`date-calendar-day ${day.isCurrentMonth ? "" : "muted"} ${hasDiary ? "has-diary" : ""} ${isSelected ? "selected" : ""}`}
                        type="button"
                        aria-label={`${day.dateValue} ${hasDiary ? "有日记" : "无日记"}`}
                        aria-pressed={isSelected}
                        onClick={() => handleCalendarDateSelect(day.dateValue)}
                      >
                        <span>{day.day}</span>
                        {hasDiary ? <i title="这一天有日记" aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <div className="mobile-view-switch" role="group" aria-label="移动端视图切换">
            {views.map((view) => (
              <button
                key={view.id}
                className={activeView === view.id ? "on" : ""}
                type="button"
                aria-label={`切换到${view.label}`}
                onClick={() => setActiveView(view.id)}
              >
                {view.label}
              </button>
            ))}
          </div>
          <div className="grow" />
          <label className="search">
            <SearchIcon />
            <input
              aria-label="搜索当前录音"
              placeholder="搜索当前录音的内容、人名、承诺..."
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </label>
          <button
            className={`topbar-utility ${isTrustPanelOpen ? "on" : ""}`}
            type="button"
            aria-expanded={isTrustPanelOpen}
            aria-controls="local-settings-panel"
            onClick={() => setIsTrustPanelOpen((current) => !current)}
          >
            <ShieldIcon />
            {storagePanelLabel}
          </button>
          <button className="btn-up" type="button" onClick={() => setIsUploadOpen(true)}>
            <UploadIcon />
            上传录音
          </button>
        </div>

        {isTrustPanelOpen ? (
          <section id="local-settings-panel" className="trust-panel" aria-label="数据与 API Key 设置">
            <div className="trust-main">
              <div className="trust-title">
                <span className="trust-icon">
                  <ShieldIcon />
                </span>
                <div>
                  <p className="kicker-line">{storageKicker}</p>
                  <h2>{storageTitle}</h2>
                </div>
              </div>
              <p className="trust-copy">
                {storageCopy}
                <span className="cloud-note">不会上传到我们的云</span>
                。只有当你使用转写、提取或问答模型时，请求才会发往当前选择的 API 提供商，你也可以完全自定义 API 提供商。
              </p>
              {shouldShowStoragePaths ? (
                <div className="path-list">
                  <div>
                    <span>{storagePathLabel}</span>
                    <code>{displayDataDirectory}</code>
                  </div>
                  <div>
                    <span>{uploadPathLabel}</span>
                    <code>{displayUploadsDirectory}</code>
                  </div>
                </div>
              ) : null}
              {canShowOpenDataFolder ? (
                <button className="secondary-button folder-button" type="button" onClick={() => void handleOpenDataFolder()} disabled={isOpeningDataFolder}>
                  <FolderIcon />
                  {isOpeningDataFolder ? "打开中..." : "打开本地数据文件夹"}
                </button>
              ) : isLocalFirstMode ? (
                <p className="server-storage-note">
                  当前浏览器会保存结果，但网页不能直接打开系统文件夹。
                </p>
              ) : null}
            </div>

            <form className="api-key-box" onSubmit={(event) => void handleSaveProviderSettings(event)}>
              <div className="api-key-head">
                <div>
                  <p className="kicker-line">API KEY</p>
                  <h3>{activeApiKeyLabel}</h3>
                </div>
                <span className={`source-pill source-${effectiveActiveApiKeySource}`}>
                  {effectiveActiveApiKeySource === "custom" ? "自定义" : effectiveActiveApiKeySource === "default" ? "默认" : "未配置"}
                </span>
              </div>
              <div className="mode-switch" role="group" aria-label="API Key 来源">
                <button className={apiKeyMode === "default" ? "on" : ""} type="button" onClick={() => setApiKeyMode("default")}>
                  使用默认服务 Key
                </button>
                <button className={apiKeyMode === "custom" ? "on" : ""} type="button" onClick={() => setApiKeyMode("custom")}>
                  使用我的 OpenRouter Key
                </button>
              </div>
              <label className="api-key-field">
                <span>OpenRouter API Key</span>
                <input
                  aria-label="OpenRouter API Key"
                  type="password"
                  value={customApiKey}
                  placeholder={hasBrowserCustomApiKey ? "已保存在当前浏览器，输入新 Key 可覆盖" : "sk-or-v1-..."}
                  disabled={apiKeyMode !== "custom"}
                  onChange={(event) => setCustomApiKey(event.target.value)}
                />
              </label>
              {apiKeyMode === "custom" ? (
                <p className="key-note">
                  你的 Key 只保存在当前浏览器：<code>浏览器 localStorage</code>
                </p>
              ) : null}
              <button
                className="primary-button"
                type="submit"
                disabled={isSavingSettings || (apiKeyMode === "custom" && !customApiKey.trim() && !hasBrowserCustomApiKey)}
              >
                {isSavingSettings ? "保存中..." : "保存配置"}
              </button>
              {settingsMessage ? <p className="settings-message">{settingsMessage}</p> : null}
            </form>
          </section>
        ) : null}

        {normalizedSearchText ? (
          <section className={`search-feedback ${totalSearchResultCount === 0 ? "search-feedback-empty" : ""}`} aria-label="搜索结果">
            <div className="search-feedback-main">
              <span>搜索 “{trimmedSearchText}”</span>
              <strong>{totalSearchResultCount > 0 ? "已筛选当前录音" : "没有找到匹配内容"}</strong>
            </div>
            <div className="search-feedback-counts">
              <span>简报 {visibleBriefItems.length} 条</span>
              <span>时间轴 {visibleTimelineResultCount} 段</span>
            </div>
            <button className="ghost-button" type="button" onClick={() => setSearchText("")}>
              清除搜索
            </button>
          </section>
        ) : null}

        <section className={`status-strip status-strip-${friendlyStatus.tone}`} aria-label="处理状态">
          <div className="status-summary">
            <span className="status-dot" aria-hidden="true" />
            <div>
              <span>录音状态</span>
              <strong>{friendlyStatus.title}</strong>
              <p>{friendlyStatus.detail}</p>
            </div>
            <strong className={`status-badge status-${friendlyStatus.tone}`}>{friendlyStatus.label}</strong>
          </div>
          <div className="status-meta">
            <div>
              <span>录音日期</span>
              <strong>{recordingDateLabel}</strong>
            </div>
            <div>
              <span>音频时长</span>
              <strong>{durationLabel}</strong>
            </div>
            <div>
              <span>{hasMultipleRecordings ? "当天录音" : "记录编号"}</span>
              <strong>{recordIdLabel}</strong>
            </div>
          </div>
          <div className="strip-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                if (!uploadId || isFetching) {
                  return;
                }

                clearScheduledPoll();
                setPollVersion((current) => current + 1);
              }}
              disabled={!uploadId || isFetching}
            >
              {isFetching ? "刷新中..." : "刷新"}
            </button>
            <button className="ghost-button" type="button" onClick={() => void handleDelete()} disabled={!uploadId}>
              {hasMultipleRecordings ? "删除当天录音" : "删除本次上传"}
            </button>
          </div>
          <div className="progress-track" aria-hidden="true">
            <div className="progress-bar" style={{ width: `${progressValue}%` }} />
          </div>
          {payload?.job?.errorMessage ? <p className="form-error">{payload.job.errorMessage}</p> : null}
          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
        </section>

        {hasMultipleRecordings ? (
          <section className="recording-sessions" aria-label="当天录音列表">
            <div className="recording-sessions-head">
              <div>
                <span>当天录音</span>
                <strong>{dayRecordings.length} 段录音合并查看</strong>
              </div>
              <p>每日复盘、时间轴和问答默认使用这一天的全部录音。</p>
            </div>
            <div className="recording-session-list">
              {dayRecordings.map((recording, index) => {
                const recordingStatus = recording.job?.status ?? recording.upload.status;
                const isDeleting = deletingRecordingId === recording.upload.id;

                return (
                  <article className="recording-session-item" key={recording.upload.id}>
                    <div className="recording-session-index">{index + 1}</div>
                    <div className="recording-session-copy">
                      <strong>{recording.upload.originalName}</strong>
                      <span>
                        {formatRecordingCreatedTime(recording.upload.createdAt)} · {formatDuration(recording.upload.durationSeconds)}
                      </span>
                    </div>
                    <span className={`status-badge status-${recordingStatus}`}>{recordingStatus === "ready" ? "已完成" : recordingStatus}</span>
                    <button
                      className="ghost-button recording-delete-button"
                      type="button"
                      disabled={Boolean(deletingRecordingId)}
                      onClick={() => void handleDeleteRecording(recording.upload.id)}
                    >
                      {isDeleting ? "删除中..." : "删除"}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {renderWorkspaceState()}
      </main>

      {isUploadOpen ? (
        <div className="modal-bg show" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setIsUploadOpen(false)}>
          <div ref={uploadDialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-panel-title">
            <div className="mclose">
              <button ref={uploadCloseButtonRef} type="button" onClick={() => setIsUploadOpen(false)} aria-label="关闭上传窗口">
                <CloseIcon />
              </button>
            </div>
            <UploadPanel
              defaultRecordingDate={defaultRecordingDate}
              onUploaded={handleUploaded}
              processingMode={isLocalFirstMode ? "local" : "online"}
              onLocalAnalyze={handleLocalAnalyze}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
