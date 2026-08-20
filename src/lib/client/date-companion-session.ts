"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";

import {
  appendLocalQaHistory,
  clearLocalQaHistory,
  deleteLocalDayPayload,
  listLocalDayIndex,
  readLocalDayPayload,
  readLocalQaHistory,
  saveLocalDayPayload
} from "@/lib/client/local-analysis";
import { DayPayloadSchema, type DayPayload } from "@/lib/domain/day-payload";
import {
  emptyDateCompanionViewModel,
  type AuthUser,
  type AuthState,
  type DateCompanionMemoryBridgeStatus,
  type DateCompanionMemoryBridgeState,
  type DateCompanionMemoryReview,
  type DateCompanionMemoryReviewInteraction,
  type DateCompanionMemoryMutationState,
  type DateCompanionMemorySubject,
  type DateCompanionMutationState,
  type DateCompanionParticipantRole,
  type DateCompanionRelationshipState,
  type DateCompanionRelationshipReconfirmationRequest,
  type DateCompanionRelationshipType,
  type DateCompanionSearchState,
  type DateCompanionVoiceEnrollmentIntent,
  type DateCompanionViewModel,
  type FailedUploadReceipt,
  type ToyIngestionReceipt,
  type QaState,
  type RecapItemVM,
  type SourceRefVM,
  type UploadReceipt,
  type UploadState
} from "@/lib/domain/date-companion";
import type {
  DcRelationshipView,
  DcSubjectSuggestionConfirmation
} from "@/lib/domain/date-companion-stage2";
import type { DateCompanionRelationshipPersonSource } from "@/lib/domain/date-companion-person-source";
import { QuestionAnswerSchema, type QuestionAnswer } from "@/lib/domain/types";

import {
  applyDateCompanionRelationshipView,
  buildDateCompanionSearchResults,
  buildDateCompanionViewModel,
  dateCompanionRetainedSourceKey
} from "./date-companion-adapter";
import {
  DateCompanionApiError,
  FailedUploadResponseSchema,
  UploadReceiptSchema,
  createDateCompanionApi,
  isRealDateCompanionUploadId,
  type DateCompanionApi,
  type DateCompanionToyUploadRequest,
  type DateCompanionRetainedSource,
  type LoginInput,
  type RegisterInput
} from "./date-companion-api";
import { isToySyncReceiptDurablyAccepted } from "./daily-reflection-toy-sync";

const ACTIVE_USER_STORAGE_KEY = "daily-brief:active-user-id";
const PERSISTED_SESSION_VERSION = 1;
const PERSON_QA_HISTORY_VERSION = 1;
const MAX_PERSON_QA_HISTORY_ITEMS = 40;
const DEFAULT_MEMORY_BRIDGE_POLL_TIMEOUT_MS = 120_000;
const TOY_RECEIPT_RECOVERY_LOOKUP_ATTEMPTS = 3;
const DEFAULT_TOY_RECOVERY_POLL_TIMEOUT_MS = 120_000;
const DEFAULT_TOY_RECOVERY_POLL_MAX_ATTEMPTS = 100;

type ToyRecoveryRelationshipScope = {
  userId: string;
  relationshipId: string;
  relationshipRequestVersion: number;
};

function shouldPollMemoryBridge(status: DateCompanionMemoryBridgeStatus | "not_queued" | undefined): boolean {
  return status === "waiting_for_cleanup" || status === "pending" || status === "processing";
}

function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const PersistedSessionSchema = z
  .object({
    version: z.literal(PERSISTED_SESSION_VERSION),
    currentUploadId: z.string().min(1),
    receipt: UploadReceiptSchema.optional(),
    failedReceipt: FailedUploadResponseSchema.optional(),
    cleanupConfirmed: z.boolean().optional()
  })
  .strict()
  .refine((session) => session.receipt || session.failedReceipt, {
    message: "A persisted upload response is required"
  });

type PersistedSession = z.infer<typeof PersistedSessionSchema>;

export type DateCompanionSessionSnapshot = {
  auth: AuthState;
  viewModel: DateCompanionViewModel;
  uploadState: UploadState;
  activeQaMode: DateCompanionQaMode;
  currentQaState: QaState;
  currentQaHistory: QuestionAnswer[];
  qaState: QaState;
  qaHistory: QuestionAnswer[];
  relationshipState: DateCompanionRelationshipState;
  mutationState: DateCompanionMutationState;
  searchState: DateCompanionSearchState;
  memoryBridgeState: DateCompanionMemoryBridgeState;
  memoryMutationState: DateCompanionMemoryMutationState;
};

export type DateCompanionCache = {
  saveDay(payload: DayPayload): void;
  readDay(uploadId: string): unknown | null;
  listDays(): Array<{ uploadId: string; recordingDate: string; originalName: string; createdAt: string }>;
  deleteDay(uploadId: string): void;
  readQaHistory(uploadId: string): QuestionAnswer[];
  appendQaHistory(uploadId: string, answer: QuestionAnswer): void;
  clearQaHistory(uploadId: string): void;
};

export type DateCompanionSessionOptions = {
  api?: DateCompanionApi;
  cache?: DateCompanionCache;
  storage?: Storage;
  pollIntervalMs?: number;
  memoryBridgePollTimeoutMs?: number;
  toyRecoveryPollTimeoutMs?: number;
  toyRecoveryPollMaxAttempts?: number;
};

export type DateCompanionPersonQaAvailability =
  | { enabled: true; personId: string; mappingVersion: number }
  | { enabled: false; message: string };

export type DateCompanionQaMode = "current-interaction" | "person";

export type DateCompanionCurrentQaAvailability =
  | { enabled: true; uploadId: string }
  | { enabled: false; message: string };

export type DateCompanionSessionValue = DateCompanionSessionSnapshot & {
  login(input: LoginInput): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  clearAuthError(): void;
  logout(): Promise<void>;
  upload(
    file: File,
    recordingDate: string,
    options?: DateCompanionUploadOptions
  ): Promise<boolean>;
  adoptToyIngestionReceipt(
    request: DateCompanionToyUploadRequest
  ): Promise<ToyIngestionReceipt | null>;
  retryRead(): Promise<void>;
  createRelationship(displayName?: string): Promise<void>;
  updateParticipants(
    interactionId: string,
    version: number,
    assignments: Array<{ speakerId: string; role: DateCompanionParticipantRole }>
  ): Promise<void>;
  updateRecap(
    interactionId: string,
    version: number,
    items: Array<{ id: string; version: number; userText?: string | null; disposition: RecapItemVM["disposition"] }>
  ): Promise<void>;
  finalizeRecap(
    interactionId: string,
    version: number,
    assignments: Array<{ speakerId: string; role: DateCompanionParticipantRole }>,
    items: Array<{ id: string; version: number; userText?: string | null; disposition: RecapItemVM["disposition"] }>,
    voiceEnrollmentIntents?: DateCompanionVoiceEnrollmentIntent[],
    memoryAdmission?: {
      mappingVersion: number;
      subjectSuggestionConfirmation: DcSubjectSuggestionConfirmation;
      selections: Array<{ evidenceSnapshotId: string; subject: DateCompanionMemorySubject }>;
    }
  ): Promise<void>;
  updatePromise(promiseId: string, version: number, status: "open" | "done"): Promise<void>;
  searchRelationship(query: string): Promise<void>;
  deleteInteraction(interactionId: string): Promise<void>;
  selectCachedInteraction(uploadId: string): boolean;
  selectRelationshipInteraction(interactionId: string | null): boolean;
  relationshipQaSources(): SourceRefVM[];
  personQaSources(): SourceRefVM[];
  personQaAvailability(): DateCompanionPersonQaAvailability;
  currentInteractionQaAvailability(): DateCompanionCurrentQaAvailability;
  activateQaMode(mode: DateCompanionQaMode): void;
  ensureMemoryBridgeLoaded(force?: boolean): Promise<void>;
  createConfirmedPerson(displayName: string): Promise<void>;
  savePersonMapping(input: {
    selfPersonId: string;
    companionPersonId: string;
    relationshipType: DateCompanionRelationshipType;
  }): Promise<void>;
  setLongTermRetention(enabled: boolean): Promise<void>;
  syncInteractionMemory(
    interactionId: string,
    selections?: Array<{ evidenceSnapshotId: string; subject: DateCompanionMemorySubject }>,
    subjectSuggestionConfirmation?: DcSubjectSuggestionConfirmation,
    relationshipReconfirmation?: DateCompanionRelationshipReconfirmationRequest
  ): Promise<void>;
  purgeRetainedMemory(): Promise<void>;
  ask(question: string): Promise<QuestionAnswer | null>;
  askCurrentInteraction(question: string): Promise<QuestionAnswer | null>;
  cancelQa(): void;
};

export type DateCompanionUploadOptions = Readonly<{
  /** Present only for a Toy-selected Date Companion recording. */
  toyOperation?: DateCompanionToyUploadRequest;
  /**
   * Runs once as soon as the server has durably identified the Upload/Job,
   * before the longer poll/import path continues. Local input adapters use it
   * to avoid treating an accepted upload as retryable after a page close. If
   * the first attempt rejects, the session retries it once immediately, so the
   * callback must be idempotent.
   */
  onServerAccepted?(receipt: UploadReceipt): Promise<void> | void;
  /** Later receipt refreshes never upload the audio again. */
  onIngestionReceipt?(receipt: ToyIngestionReceipt): Promise<void> | void;
}>;

const defaultCache: DateCompanionCache = {
  saveDay: saveLocalDayPayload,
  readDay: readLocalDayPayload,
  listDays: listLocalDayIndex,
  deleteDay: deleteLocalDayPayload,
  readQaHistory: readLocalQaHistory,
  appendQaHistory: appendLocalQaHistory,
  clearQaHistory: clearLocalQaHistory
};

const memoryStorage = new Map<string, string>();

function fallbackStorage(): Storage {
  return {
    get length() {
      return memoryStorage.size;
    },
    clear() {
      memoryStorage.clear();
    },
    getItem(key) {
      return memoryStorage.get(key) ?? null;
    },
    key(index) {
      return [...memoryStorage.keys()][index] ?? null;
    },
    removeItem(key) {
      memoryStorage.delete(key);
    },
    setItem(key, value) {
      memoryStorage.set(key, value);
    }
  };
}

function currentStorage(explicitStorage?: Storage): Storage {
  if (explicitStorage) return explicitStorage;
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // Fall through to the in-memory implementation when storage access is blocked.
  }
  return fallbackStorage();
}

function persistedSessionKey(userId: string): string {
  return `daily-brief:${userId}:date-companion:session`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof DateCompanionApiError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function relationshipActionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof DateCompanionApiError)) return errorMessage(error, fallback);
  if (error.status === 409) return "内容已经在别处更新，请重新读取后再试。";
  if (error.status === 404) return "这段记录不存在，或已经无法访问。";
  if (error.status === 400 || error.status === 422) return "这项内容还不符合保存条件，请核对人物和原话来源。";
  return fallback;
}

function personQaHistoryStorageKey(input: {
  accountId: string;
  relationshipId: string;
  personId: string;
  mappingVersion: number;
}) {
  return [
    "daily-brief",
    encodeURIComponent(input.accountId),
    "date-companion",
    "person-qa",
    encodeURIComponent(input.relationshipId),
    encodeURIComponent(input.personId),
    `mapping-${input.mappingVersion}`,
    `v${PERSON_QA_HISTORY_VERSION}`
  ].join(":");
}

function normalizedSourceText(value: string) {
  return value.normalize("NFKC").trim();
}

type UnifiedPersonSourceCatalog = {
  retainedSubjects: Record<string, DateCompanionMemorySubject>;
  memoryRetainedSourceKeys: string[];
  relationshipPersonSources: DateCompanionRelationshipPersonSource[];
  sources: SourceRefVM[];
};

export function buildUnifiedPersonSourceCatalog(input: {
  selfPersonId: string;
  companionPersonId: string;
  memorySources: DateCompanionRetainedSource[];
  relationshipPersonSources: DateCompanionRelationshipPersonSource[];
  relationshipSources: SourceRefVM[];
  getLocalDay: (uploadId: string) => DayPayload | null;
}): UnifiedPersonSourceCatalog {
  type MemoryCandidate = {
    source: DateCompanionRetainedSource;
    subjectPersonIds: Set<string>;
    conflict: boolean;
  };
  const memoryByKey = new Map<string, MemoryCandidate>();
  for (const source of input.memorySources) {
    if (!source.uploadId.trim() || !source.sourceSegmentId.trim() || !source.quote.trim()) continue;
    const key = dateCompanionRetainedSourceKey(source.uploadId, source.sourceSegmentId);
    const existing = memoryByKey.get(key);
    if (!existing) {
      memoryByKey.set(key, {
        source,
        subjectPersonIds: new Set(source.subjectPersonIds),
        conflict: false
      });
      continue;
    }
    source.subjectPersonIds.forEach((personId) => existing.subjectPersonIds.add(personId));
    if (normalizedSourceText(existing.source.quote) !== normalizedSourceText(source.quote)) {
      existing.conflict = true;
    }
  }

  const relationshipByKey = new Map<string, {
    source: DateCompanionRelationshipPersonSource;
    signature: string;
    conflict: boolean;
  }>();
  for (const source of input.relationshipPersonSources) {
    const key = dateCompanionRetainedSourceKey(source.uploadId, source.sourceSegmentId);
    const signature = JSON.stringify([
      source.evidenceSnapshotId,
      source.interactionId,
      source.recordingDate,
      source.startSeconds,
      source.endSeconds,
      source.speakerId ?? null,
      normalizedSourceText(source.quote),
      source.subject
    ]);
    const existing = relationshipByKey.get(key);
    if (!existing) {
      relationshipByKey.set(key, { source, signature, conflict: false });
    } else if (existing.signature !== signature) {
      existing.conflict = true;
    }
  }

  const validRelationshipSources = [...relationshipByKey.values()]
    .filter((candidate) => !candidate.conflict)
    .map((candidate) => candidate.source)
    .sort((left, right) =>
      left.recordingDate.localeCompare(right.recordingDate)
      || left.startSeconds - right.startSeconds
      || left.uploadId.localeCompare(right.uploadId)
      || left.sourceSegmentId.localeCompare(right.sourceSegmentId)
      || left.evidenceSnapshotId.localeCompare(right.evidenceSnapshotId)
    );
  const validRelationshipKeys = new Set(validRelationshipSources.map((source) =>
    dateCompanionRetainedSourceKey(source.uploadId, source.sourceSegmentId)
  ));
  const retainedSubjects: Record<string, DateCompanionMemorySubject> = {};
  const memoryRetainedSourceKeys: string[] = [];
  const memoryQaSources = new Map<string, DateCompanionRetainedSource>();

  for (const [key, candidate] of memoryByKey) {
    if (candidate.conflict) continue;
    const self = candidate.subjectPersonIds.has(input.selfPersonId);
    const companion = candidate.subjectPersonIds.has(input.companionPersonId);
    const subject = self && companion ? "both" : self ? "self" : companion ? "companion" : "unknown";
    if (subject === "unknown") continue;
    retainedSubjects[key] = subject;
    if (!validRelationshipKeys.has(key)) memoryRetainedSourceKeys.push(key);
    if (companion) memoryQaSources.set(key, candidate.source);
  }
  for (const source of validRelationshipSources) {
    retainedSubjects[dateCompanionRetainedSourceKey(source.uploadId, source.sourceSegmentId)] = source.subject;
  }

  const unifiedByKey = new Map<string, SourceRefVM>();
  for (const [key, source] of memoryQaSources) {
    if (validRelationshipKeys.has(key)) continue;
    const localDay = input.getLocalDay(source.uploadId);
    const localSegment = localDay?.segments.find((segment) =>
      segment.id === source.sourceSegmentId
      && normalizedSourceText(segment.text) === normalizedSourceText(source.quote)
    );
    const relationshipSource = input.relationshipSources.find((candidate) =>
      candidate.uploadId === source.uploadId
      && candidate.segmentIds.includes(source.sourceSegmentId)
      && normalizedSourceText(candidate.quote) === normalizedSourceText(source.quote)
    );
    unifiedByKey.set(key, {
      id: relationshipSource?.id ?? `person-qa:${source.uploadId}:${source.sourceSegmentId}`,
      uploadId: source.uploadId,
      segmentIds: [source.sourceSegmentId],
      recordingDate: relationshipSource?.recordingDate ?? localDay?.upload.recordingDate ?? "",
      startSeconds: localSegment?.startSeconds ?? relationshipSource?.startSeconds ?? 0,
      endSeconds: localSegment?.endSeconds ?? relationshipSource?.endSeconds ?? 0,
      speakerId: localSegment?.speaker ?? relationshipSource?.speakerId,
      quote: source.quote,
      contentDigest: source.contentDigest,
      kind: "transcript",
      presentation: "direct_quote",
      canOpenTranscript: Boolean(localSegment),
      memorySubject: retainedSubjects[key]
    });
  }
  for (const source of validRelationshipSources) {
    const key = dateCompanionRetainedSourceKey(source.uploadId, source.sourceSegmentId);
    const localSegment = input.getLocalDay(source.uploadId)?.segments.find((segment) =>
      segment.id === source.sourceSegmentId
      && normalizedSourceText(segment.text) === normalizedSourceText(source.quote)
    );
    unifiedByKey.set(key, {
      id: source.evidenceSnapshotId,
      uploadId: source.uploadId,
      segmentIds: [source.sourceSegmentId],
      recordingDate: source.recordingDate,
      startSeconds: source.startSeconds,
      endSeconds: source.endSeconds,
      speakerId: source.speakerId,
      quote: source.quote,
      contentDigest: source.contentDigest,
      kind: "transcript",
      presentation: "direct_quote",
      canOpenTranscript: Boolean(localSegment),
      memorySubject: source.subject
    });
  }

  const bySegmentId = new Map<string, SourceRefVM[]>();
  for (const source of unifiedByKey.values()) {
    const segmentId = source.segmentIds[0];
    const current = bySegmentId.get(segmentId) ?? [];
    current.push(source);
    bySegmentId.set(segmentId, current);
  }
  const sources = [...bySegmentId.values()].flatMap((candidates) => {
    const signatures = new Set(candidates.map((source) => JSON.stringify([
      source.uploadId,
      normalizedSourceText(source.quote)
    ])));
    return signatures.size === 1 ? [candidates[0]] : [];
  }).sort((left, right) =>
    left.recordingDate.localeCompare(right.recordingDate) ||
    left.startSeconds - right.startSeconds ||
    left.uploadId.localeCompare(right.uploadId) ||
    left.segmentIds[0].localeCompare(right.segmentIds[0])
  );

  return {
    retainedSubjects,
    memoryRetainedSourceKeys: memoryRetainedSourceKeys.sort(),
    relationshipPersonSources: validRelationshipSources,
    sources
  };
}

function failedUploadReceipt(error: unknown): FailedUploadReceipt | undefined {
  if (!(error instanceof DateCompanionApiError)) return undefined;
  const parsed = FailedUploadResponseSchema.safeParse(error.details);
  if (
    parsed.success
    && parsed.data.ingestionReceipt
    && !isToySyncReceiptDurablyAccepted(parsed.data.ingestionReceipt)
  ) return undefined;
  return parsed.success
    ? {
        uploadId: parsed.data.uploadId,
        jobId: parsed.data.jobId,
        status: "failed",
        error: parsed.data.error
      }
    : undefined;
}

function failedToyIngestionReceipt(
  error: unknown,
  request: DateCompanionToyUploadRequest
): ToyIngestionReceipt | null {
  if (!(error instanceof DateCompanionApiError)) return null;
  const parsed = FailedUploadResponseSchema.safeParse(error.details);
  if (!parsed.success || !parsed.data.ingestionReceipt) return null;
  const receipt = parsed.data.ingestionReceipt;
  return receipt.operationKey === request.operationKey.trim()
    && receipt.destination === request.destination
    && receipt.relationshipId === request.relationshipId
    ? receipt
    : null;
}

function toyReceiptMatchesRequest(
  receipt: ToyIngestionReceipt,
  request: DateCompanionToyUploadRequest
): boolean {
  return receipt.operationKey === request.operationKey.trim()
    && receipt.destination === request.destination
    && receipt.relationshipId === request.relationshipId;
}

function isToyRelationshipMismatch(error: unknown): boolean {
  return error instanceof DateCompanionApiError
    && error.code === "toy_ingestion_relationship_mismatch";
}

function uploadReceiptFromIngestion(receipt: ToyIngestionReceipt): UploadReceipt {
  return {
    uploadId: receipt.uploadId,
    jobId: receipt.jobId,
    status: "uploaded",
    ingestionReceipt: receipt
  };
}

function processingStatus(payload: DayPayload): Exclude<UploadState, { status: "idle" | "uploading" | "ready" | "failed" }>[
  "jobStatus"
] | null {
  const status = payload.job?.status ?? payload.upload.status;
  return status === "ready" || status === "failed" ? null : status;
}

function relationshipQaSourceSignature(source: SourceRefVM) {
  return JSON.stringify([
    source.uploadId,
    source.startSeconds,
    source.endSeconds,
    source.speakerId ?? null,
    source.quote,
    source.contentDigest ?? null
  ]);
}

export function buildDateCompanionRelationshipQaSources(
  view: DcRelationshipView,
  getLocalDay: (uploadId: string) => DayPayload | null
): SourceRefVM[] {
  const candidates: SourceRefVM[] = [];
  for (const interaction of view.interactions) {
    if (
      interaction.relationshipId !== view.relationship.id ||
      interaction.status !== "confirmed" ||
      !interaction.confirmedAt ||
      interaction.sourceState === "explicitly_deleted"
    ) continue;
    const roleBySpeaker = new Map(
      interaction.participants.flatMap((participant) =>
        participant.confirmedAt && participant.role !== "unresolved"
          ? [[participant.speakerId, participant.role] as const]
          : []
      )
    );
    const localSegments = new Set(
      getLocalDay(interaction.sourceUploadId)?.segments.map((segment) => segment.id) ?? []
    );
    for (const recap of interaction.recapItems) {
      if (recap.disposition !== "kept") continue;
      for (const evidence of recap.evidence) {
        const role = evidence.speakerId ? roleBySpeaker.get(evidence.speakerId) : undefined;
        if (
          !role ||
          evidence.uploadId !== interaction.sourceUploadId ||
          (recap.kind === "mentioned" && role !== "companion") ||
          (recap.kind === "promise" && role !== "self")
        ) continue;
        candidates.push({
          id: evidence.id,
          uploadId: evidence.uploadId,
          segmentIds: [evidence.sourceSegmentId],
          recordingDate: interaction.recordingDate,
          startSeconds: evidence.startSeconds,
          endSeconds: evidence.endSeconds,
          speakerId: evidence.speakerId,
          quote: evidence.quote,
          contentDigest: evidence.contentDigest,
          kind: "transcript",
          presentation: "direct_quote",
          canOpenTranscript: localSegments.has(evidence.sourceSegmentId)
        });
      }
    }
  }

  const bySegmentId = new Map<string, SourceRefVM[]>();
  for (const source of candidates) {
    const segmentId = source.segmentIds[0];
    if (!segmentId?.trim() || !source.quote.trim()) continue;
    const matches = bySegmentId.get(segmentId) ?? [];
    matches.push(source);
    bySegmentId.set(segmentId, matches);
  }
  return [...bySegmentId.entries()]
    .flatMap(([, sources]) =>
      new Set(sources.map(relationshipQaSourceSignature)).size === 1 ? [sources[0]] : []
    )
    .sort((left, right) =>
      left.recordingDate.localeCompare(right.recordingDate) ||
      left.startSeconds - right.startSeconds ||
      left.segmentIds[0].localeCompare(right.segmentIds[0])
    );
}

function currentQaCitationSourcesResolve(answer: QuestionAnswer, payload: DayPayload): boolean {
  if (answer.uploadId !== payload.upload.id) return false;
  const knownSegmentIds = new Set(payload.segments.map((segment) => segment.id));
  return answer.citedSegmentIds.every((segmentId) => knownSegmentIds.has(segmentId)) &&
    (answer.citations ?? []).every((citation) =>
      citation.sourceSegmentIds.every((segmentId) => knownSegmentIds.has(segmentId))
    );
}

function personQaCitationSourcesResolve(
  answer: QuestionAnswer,
  personId: string,
  sources: SourceRefVM[]
): boolean {
  if (answer.uploadId !== personId) return false;
  const knownSegmentIds = new Set(sources.flatMap((source) => source.segmentIds));
  return answer.citedSegmentIds.every((segmentId) => knownSegmentIds.has(segmentId)) &&
    (answer.citations ?? []).every((citation) =>
      citation.sourceSegmentIds.every((segmentId) => knownSegmentIds.has(segmentId))
    );
}

function personQaSourceSignature(sources: SourceRefVM[]) {
  return JSON.stringify(sources.map((source) => [
    source.id,
    source.uploadId,
    source.segmentIds,
    source.startSeconds,
    source.endSeconds,
    source.speakerId ?? null,
    normalizedSourceText(source.quote),
    source.contentDigest ?? null
  ]));
}

type PersonQaTarget = {
  accountId: string;
  relationshipId: string;
  personId: string;
  mappingVersion: number;
  historyKey: string;
};

export class DateCompanionSessionController {
  private readonly api: DateCompanionApi;
  private readonly cache: DateCompanionCache;
  private readonly storage: Storage;
  private readonly pollIntervalMs: number;
  private readonly memoryBridgePollTimeoutMs: number;
  private readonly toyRecoveryPollTimeoutMs: number;
  private readonly toyRecoveryPollMaxAttempts: number;
  private readonly listeners = new Set<() => void>();
  private snapshot: DateCompanionSessionSnapshot = {
    auth: { status: "checking" },
    viewModel: emptyDateCompanionViewModel(),
    uploadState: { status: "idle" },
    activeQaMode: "person",
    currentQaState: { status: "idle" },
    currentQaHistory: [],
    qaState: { status: "idle" },
    qaHistory: [],
    relationshipState: { status: "idle" },
    mutationState: { status: "idle" },
    searchState: { status: "idle" },
    memoryBridgeState: { status: "idle" },
    memoryMutationState: { status: "idle" }
  };
  private authController: AbortController | null = null;
  private uploadController: AbortController | null = null;
  private pollController: AbortController | null = null;
  private toyReceiptRecoveryController: AbortController | null = null;
  private qaController: AbortController | null = null;
  private relationshipController: AbortController | null = null;
  private mutationController: AbortController | null = null;
  private searchController: AbortController | null = null;
  private memoryController: AbortController | null = null;
  private memoryMutationController: AbortController | null = null;
  private activeUploadId: string | null = null;
  private currentPayload: DayPayload | null = null;
  private relationshipView: DcRelationshipView | null = null;
  private selectedRelationshipInteractionId: string | null = null;
  private activeToyRecoveryScope: ToyRecoveryRelationshipScope | null = null;
  private uploadRequestVersion = 0;
  private toyReceiptRecoveryRequestVersion = 0;
  private qaRequestVersion = 0;
  private relationshipRequestVersion = 0;
  private mutationRequestVersion = 0;
  private searchRequestVersion = 0;
  private memoryRequestVersion = 0;
  private memoryMutationRequestVersion = 0;
  private activePersonQaHistoryKey: string | null = null;
  private activePersonQaSourceSignature: string | null = null;
  private initialized = false;
  private disposed = false;

  constructor(options: DateCompanionSessionOptions = {}) {
    this.api = options.api ?? createDateCompanionApi();
    this.cache = options.cache ?? defaultCache;
    this.storage = currentStorage(options.storage);
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 1_200);
    this.memoryBridgePollTimeoutMs = Math.max(
      0,
      options.memoryBridgePollTimeoutMs ?? DEFAULT_MEMORY_BRIDGE_POLL_TIMEOUT_MS
    );
    const requestedToyRecoveryTimeout = options.toyRecoveryPollTimeoutMs
      ?? DEFAULT_TOY_RECOVERY_POLL_TIMEOUT_MS;
    this.toyRecoveryPollTimeoutMs = Number.isFinite(requestedToyRecoveryTimeout)
      ? Math.max(1, Math.min(DEFAULT_TOY_RECOVERY_POLL_TIMEOUT_MS, requestedToyRecoveryTimeout))
      : DEFAULT_TOY_RECOVERY_POLL_TIMEOUT_MS;
    const requestedToyRecoveryAttempts = options.toyRecoveryPollMaxAttempts
      ?? DEFAULT_TOY_RECOVERY_POLL_MAX_ATTEMPTS;
    this.toyRecoveryPollMaxAttempts = Number.isFinite(requestedToyRecoveryAttempts)
      ? Math.max(
          1,
          Math.min(DEFAULT_TOY_RECOVERY_POLL_MAX_ATTEMPTS, Math.floor(requestedToyRecoveryAttempts))
        )
      : DEFAULT_TOY_RECOVERY_POLL_MAX_ATTEMPTS;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): DateCompanionSessionSnapshot => this.snapshot;

  private update(next: Partial<DateCompanionSessionSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private setActiveUser(userId: string | null) {
    try {
      if (userId) this.storage.setItem(ACTIVE_USER_STORAGE_KEY, userId);
      else this.storage.removeItem(ACTIVE_USER_STORAGE_KEY);
    } catch {
      // A blocked localStorage must not turn a valid server session into an auth failure.
    }
  }

  private cancelRelationshipWork() {
    this.relationshipController?.abort();
    this.relationshipController = null;
    this.mutationController?.abort();
    this.mutationController = null;
    this.searchController?.abort();
    this.searchController = null;
    this.memoryController?.abort();
    this.memoryController = null;
    this.memoryMutationController?.abort();
    this.memoryMutationController = null;
    this.relationshipRequestVersion += 1;
    this.mutationRequestVersion += 1;
    this.searchRequestVersion += 1;
    this.memoryRequestVersion += 1;
    this.memoryMutationRequestVersion += 1;
    this.activePersonQaHistoryKey = null;
    this.activePersonQaSourceSignature = null;
  }

  private refreshViewModel() {
    const current = this.currentPayload
      ? buildDateCompanionViewModel(this.currentPayload)
      : emptyDateCompanionViewModel();
    const readyBridge = this.snapshot.memoryBridgeState.status === "ready"
      && this.relationshipView?.relationship.status === "active"
      ? this.snapshot.memoryBridgeState
      : null;
    const viewModel = this.relationshipView
      ? applyDateCompanionRelationshipView(current, this.relationshipView, {
          hasLocalDay: (uploadId) => this.localPayload(uploadId) !== null,
          getLocalDay: (uploadId) => this.localPayload(uploadId),
          selectedInteractionId: this.selectedRelationshipInteractionId,
          retainedSubjects: readyBridge?.retainedSubjects ?? {},
          memoryRetainedSourceKeys: readyBridge?.memoryRetainedSourceKeys ?? [],
          relationshipPersonSources: readyBridge?.relationshipPersonSources ?? []
        })
      : current;
    this.update({ viewModel });
  }

  private applyRelationshipView(view: DcRelationshipView) {
    if (
      this.activeToyRecoveryScope
      && this.activeToyRecoveryScope.relationshipId !== view.relationship.id
    ) {
      this.fenceActiveToyRecoveryForRelationshipChange();
    }
    this.relationshipView = view;
    if (
      this.selectedRelationshipInteractionId
      && !view.interactions.some((interaction) => interaction.id === this.selectedRelationshipInteractionId)
    ) {
      this.selectedRelationshipInteractionId = null;
    }
    this.update({
      relationshipState: {
        status: "ready",
        relationship: {
          id: view.relationship.id,
          displayName: view.relationship.displayName,
          participantState: "confirmed",
          status: view.relationship.status,
          version: view.relationship.version
        }
      }
    });
    this.refreshViewModel();
    this.syncPersonQaHistory(true);
  }

  private invalidatePersonSourceCatalog() {
    if (this.snapshot.memoryBridgeState.status !== "ready") return;
    this.update({
      memoryBridgeState: {
        ...this.snapshot.memoryBridgeState,
        retainedSubjects: {},
        memoryRetainedSourceKeys: [],
        relationshipPersonSources: [],
        personQaSources: []
      }
    });
    this.refreshViewModel();
    this.syncPersonQaHistory(true);
  }

  private expireAuthentication() {
    this.cancelUploadWork();
    this.cancelRelationshipWork();
    this.cancelQa();
    this.uploadRequestVersion += 1;
    this.currentPayload = null;
    this.relationshipView = null;
    this.selectedRelationshipInteractionId = null;
    this.activeUploadId = null;
    this.setActiveUser(null);
    this.update({
      auth: { status: "anonymous" },
      viewModel: emptyDateCompanionViewModel(),
      uploadState: { status: "idle" },
      activeQaMode: "person",
      currentQaState: { status: "idle" },
      currentQaHistory: [],
      qaState: { status: "idle" },
      qaHistory: [],
      relationshipState: { status: "idle" },
      mutationState: { status: "idle" },
      searchState: { status: "idle" },
      memoryBridgeState: { status: "idle" },
      memoryMutationState: { status: "idle" }
    });
  }

  private readPersistedSession(userId: string): PersistedSession | null {
    try {
      const raw = this.storage.getItem(persistedSessionKey(userId));
      if (!raw) return null;
      const parsed = PersistedSessionSchema.safeParse(JSON.parse(raw) as unknown);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private persistSession(userId: string, session: Omit<PersistedSession, "version">) {
    try {
      this.storage.setItem(
        persistedSessionKey(userId),
        JSON.stringify({ version: PERSISTED_SESSION_VERSION, ...session })
      );
    } catch {
      // Day caching is handled separately and is the required durability boundary.
    }
  }

  private toyReceiptBelongsToCurrentRelationship(receipt: ToyIngestionReceipt): boolean {
    return this.snapshot.relationshipState.status === "ready"
      && this.relationshipView?.relationship.id === receipt.relationshipId;
  }

  private pauseMismatchedToyRecovery(receipt?: UploadReceipt) {
    this.cancelUploadWork();
    this.cancelQa();
    // Abort is only a bandwidth optimization: Providers may ignore it. Fence
    // every late poll/import continuation with a new upload version while
    // preserving the canonical anchor for recovery under the original scope.
    this.uploadRequestVersion += 1;
    this.update({
      uploadState: {
        status: "failed",
        ...(receipt ? { uploadId: receipt.uploadId, receipt } : {}),
        message: "这条未完成的玩偶录音属于另一段关系。请切回原来的关系后恢复，系统不会把它导入当前关系。",
        failureStage: "relationship_import",
        serverDataRetained: true
      }
    });
  }

  private requireToyReceiptForCurrentRelationship(
    receipt: ToyIngestionReceipt,
    request?: DateCompanionToyUploadRequest
  ) {
    if (
      !this.toyReceiptBelongsToCurrentRelationship(receipt)
      || (request && !toyReceiptMatchesRequest(receipt, request))
    ) {
      this.pauseMismatchedToyRecovery(uploadReceiptFromIngestion(receipt));
      throw new DateCompanionApiError({
        status: 409,
        code: "toy_ingestion_relationship_mismatch"
      });
    }
  }

  private async refreshPersistedToyReceipt(
    userId: string,
    persisted: PersistedSession,
    signal?: AbortSignal
  ): Promise<PersistedSession> {
    const ingestion = persisted.receipt?.ingestionReceipt;
    if (!ingestion) return persisted;
    this.requireToyReceiptForCurrentRelationship(ingestion);
    const refreshed = await this.api.getToyIngestionReceipt({
      operationKey: ingestion.operationKey,
      destination: "date_companion",
      relationshipId: ingestion.relationshipId
    }, signal);
    if (!refreshed) return persisted;
    this.requireToyReceiptForCurrentRelationship(refreshed, {
      operationKey: ingestion.operationKey,
      destination: "date_companion",
      relationshipId: ingestion.relationshipId
    });
    const next: PersistedSession = {
      ...persisted,
      receipt: { ...persisted.receipt!, ingestionReceipt: refreshed }
    };
    this.persistSession(userId, {
      currentUploadId: next.currentUploadId,
      receipt: next.receipt,
      ...(next.cleanupConfirmed !== undefined
        ? { cleanupConfirmed: next.cleanupConfirmed }
        : {})
    });
    return next;
  }

  private authenticatedUserId(): string | null {
    return this.snapshot.auth.status === "authenticated" ? this.snapshot.auth.user.id : null;
  }

  private currentPersonQaTarget(): PersonQaTarget | null {
    const accountId = this.authenticatedUserId();
    const relationshipId = this.relationshipView?.relationship.id;
    const bridge = this.snapshot.memoryBridgeState;
    if (
      !accountId
      || !relationshipId
      || this.relationshipView?.relationship.status !== "active"
      || bridge.status !== "ready"
    ) return null;
    const mapping = bridge.mapping;
    if (
      !mapping ||
      mapping.status !== "confirmed" ||
      mapping.selfPersonId === mapping.companionPersonId ||
      bridge.selfBinding?.status !== "active" ||
      bridge.selfBinding.personId !== mapping.selfPersonId
    ) return null;
    const confirmedIds = new Set(bridge.people.map((person) => person.id));
    if (!confirmedIds.has(mapping.selfPersonId) || !confirmedIds.has(mapping.companionPersonId)) return null;
    const target = {
      accountId,
      relationshipId,
      personId: mapping.companionPersonId,
      mappingVersion: mapping.version
    };
    return {
      ...target,
      historyKey: personQaHistoryStorageKey(target)
    };
  }

  readonly personQaAvailability = (): DateCompanionPersonQaAvailability => {
    const target = this.currentPersonQaTarget();
    if (target) {
      return { enabled: true, personId: target.personId, mappingVersion: target.mappingVersion };
    }
    const bridge = this.snapshot.memoryBridgeState;
    if (bridge.status === "idle" || bridge.status === "loading") {
      return { enabled: false, message: "正在确认人物设置，请稍候。" };
    }
    if (bridge.status === "error") {
      return { enabled: false, message: "人物设置暂时没有读取成功，请刷新后再试。" };
    }
    if (bridge.status !== "ready") {
      return { enabled: false, message: "正在确认人物设置，请稍候。" };
    }
    if (!bridge.mapping) {
      return { enabled: false, message: "先在“人物与长期保留”中确认“我”和“Ta”，再来提问。" };
    }
    return { enabled: false, message: "人物设置已经变化，请先重新确认“我”和“Ta”。" };
  };

  readonly currentInteractionQaAvailability = (): DateCompanionCurrentQaAvailability => {
    const payload = this.currentPayload;
    const activeUploadId = this.activeUploadId;
    const recapInteraction = this.snapshot.viewModel.recap.interaction;
    if (
      payload
      && activeUploadId
      && payload.upload.id === activeUploadId
      && isRealDateCompanionUploadId(activeUploadId)
      && (payload.job?.status ?? payload.upload.status) === "ready"
      && recapInteraction?.status === "ready"
      && (recapInteraction.sourceUploadId ?? recapInteraction.id) === activeUploadId
    ) {
      return { enabled: true, uploadId: activeUploadId };
    }
    if (recapInteraction?.status === "processing") {
      return { enabled: false, message: "这次录音还在整理，完成后就可以针对这次相处提问。" };
    }
    if (recapInteraction?.status === "failed") {
      return { enabled: false, message: "这次录音尚未整理成功，暂时不能针对这次相处提问。" };
    }
    return {
      enabled: false,
      message: recapInteraction
        ? "这台设备没有保存这次相处的完整文字稿，仍可以使用“问问 Ta”回看已确认内容。"
        : "先完成并打开一次相处记录，再针对这次相处提问。"
    };
  };

  readonly activateQaMode = (mode: DateCompanionQaMode): void => {
    if (this.snapshot.activeQaMode === mode) return;
    this.cancelQa();
    this.update({ activeQaMode: mode });
  };

  private readPersonQaHistory(target: PersonQaTarget): QuestionAnswer[] {
    try {
      const raw = this.storage.getItem(target.historyKey);
      const values = raw ? JSON.parse(raw) as unknown : [];
      if (!Array.isArray(values)) return [];
      return values.flatMap((value) => {
        const parsed = QuestionAnswerSchema.safeParse(value);
        return parsed.success && personQaCitationSourcesResolve(
          parsed.data,
          target.personId,
          this.personQaSources()
        ) ? [parsed.data] : [];
      }).slice(-MAX_PERSON_QA_HISTORY_ITEMS);
    } catch {
      return [];
    }
  }

  private appendPersonQaHistory(target: PersonQaTarget, answer: QuestionAnswer): QuestionAnswer[] {
    if (!personQaCitationSourcesResolve(answer, target.personId, this.personQaSources())) return this.snapshot.qaHistory;
    const next = [
      ...this.snapshot.qaHistory.filter((item) => item.id !== answer.id),
      answer
    ].slice(-MAX_PERSON_QA_HISTORY_ITEMS);
    try {
      this.storage.setItem(target.historyKey, JSON.stringify(next));
    } catch {
      // The current answer remains visible even when local history storage is blocked.
    }
    return next;
  }

  private syncPersonQaHistory(force = false) {
    const target = this.currentPersonQaTarget();
    const nextKey = target?.historyKey ?? null;
    const nextSourceSignature = target ? personQaSourceSignature(this.personQaSources()) : null;
    if (
      !force
      && this.activePersonQaHistoryKey === nextKey
      && this.activePersonQaSourceSignature === nextSourceSignature
    ) return;
    if (
      this.snapshot.activeQaMode === "person"
      && this.activePersonQaHistoryKey !== null
      && (
        this.activePersonQaHistoryKey !== nextKey
        || this.activePersonQaSourceSignature !== nextSourceSignature
      )
    ) this.cancelQa();
    this.activePersonQaHistoryKey = nextKey;
    this.activePersonQaSourceSignature = nextSourceSignature;
    this.update({
      qaState: { status: "idle" },
      qaHistory: target ? this.readPersonQaHistory(target) : []
    });
  }

  private cancelUploadWork() {
    this.uploadController?.abort();
    this.uploadController = null;
    this.pollController?.abort();
    this.pollController = null;
    this.cancelToyReceiptRecovery();
    this.activeToyRecoveryScope = null;
  }

  private cancelToyReceiptRecovery() {
    this.toyReceiptRecoveryController?.abort();
    this.toyReceiptRecoveryController = null;
    this.toyReceiptRecoveryRequestVersion += 1;
  }

  private isCurrentToyReceiptRecovery(input: {
    userId: string;
    relationshipId: string;
    relationshipVersion: number;
    uploadVersion: number;
    recoveryVersion: number;
  }): boolean {
    return this.isCurrentToyRecoveryRelationshipScope({
      userId: input.userId,
      relationshipId: input.relationshipId,
      relationshipRequestVersion: input.relationshipVersion
    })
      && this.uploadRequestVersion === input.uploadVersion
      && this.toyReceiptRecoveryRequestVersion === input.recoveryVersion;
  }

  private isCurrentToyRecoveryRelationshipScope(
    scope: ToyRecoveryRelationshipScope
  ): boolean {
    return !this.disposed
      && this.authenticatedUserId() === scope.userId
      && this.snapshot.relationshipState.status === "ready"
      && this.relationshipView?.relationship.id === scope.relationshipId
      && this.relationshipRequestVersion === scope.relationshipRequestVersion;
  }

  private isCurrentScopedUpload(
    version: number,
    uploadId: string,
    toyRecoveryScope?: ToyRecoveryRelationshipScope
  ): boolean {
    return this.isCurrentUpload(version, uploadId)
      && (!toyRecoveryScope
        || this.isCurrentToyRecoveryRelationshipScope(toyRecoveryScope));
  }

  private fenceActiveToyRecoveryForRelationshipChange() {
    if (!this.activeToyRecoveryScope) return;
    this.cancelUploadWork();
    this.uploadRequestVersion += 1;
    this.activeUploadId = null;
    this.currentPayload = null;
    this.update({ uploadState: { status: "idle" } });
    this.refreshViewModel();
  }

  private nextUploadVersion(): number {
    this.cancelUploadWork();
    this.cancelQa();
    this.uploadRequestVersion += 1;
    return this.uploadRequestVersion;
  }

  private isCurrentUpload(version: number, uploadId: string): boolean {
    return !this.disposed && version === this.uploadRequestVersion && this.activeUploadId === uploadId;
  }

  private cachedPayload(uploadId: string): DayPayload | null {
    let cached: unknown;
    try {
      cached = this.cache.readDay(uploadId);
    } catch {
      return null;
    }
    const parsed = DayPayloadSchema.safeParse(cached);
    if (
      !parsed.success ||
      parsed.data.upload.id !== uploadId ||
      !isRealDateCompanionUploadId(parsed.data.upload.id)
    ) return null;
    return parsed.data;
  }

  private localPayload(uploadId: string): DayPayload | null {
    return this.currentPayload?.upload.id === uploadId
      ? this.currentPayload
      : this.cachedPayload(uploadId);
  }

  private showPayload(payload: DayPayload) {
    this.selectedRelationshipInteractionId = null;
    this.currentPayload = payload;
    this.activeUploadId = payload.upload.id;
    this.refreshViewModel();
    this.update({
      currentQaState: { status: "idle" },
      currentQaHistory: this.cache.readQaHistory(payload.upload.id)
    });
  }

  private relationshipContainsUpload(uploadId: string): boolean {
    return this.relationshipView?.interactions.some(
      (interaction) => interaction.sourceUploadId === uploadId
    ) === true;
  }

  private relationshipInteractionForUpload(uploadId: string) {
    return this.relationshipView?.interactions.find(
      (interaction) => interaction.sourceUploadId === uploadId
    ) ?? null;
  }

  private clearPersistedUpload(userId: string, uploadId: string) {
    const persisted = this.readPersistedSession(userId);
    if (persisted?.currentUploadId !== uploadId) return;
    try {
      this.storage.removeItem(persistedSessionKey(userId));
    } catch {
      // Server relationship membership remains authoritative even if storage is blocked.
    }
  }

  private markPersistedCleanupConfirmed(uploadId: string) {
    const userId = this.authenticatedUserId();
    if (!userId) return;
    const persisted = this.readPersistedSession(userId);
    if (!persisted || persisted.currentUploadId !== uploadId) return;
    this.persistSession(userId, {
      currentUploadId: persisted.currentUploadId,
      ...(persisted.receipt ? { receipt: persisted.receipt } : {}),
      ...(persisted.failedReceipt ? { failedReceipt: persisted.failedReceipt } : {}),
      cleanupConfirmed: true
    });
  }

  private clearStaleLocalUpload(uploadId: string) {
    try {
      this.cache.deleteDay(uploadId);
      this.cache.clearQaHistory(uploadId);
    } catch {
      // A stale browser cache must never override the server relationship view.
    }
  }

  private restoreLatestCached(): boolean {
    const interactionByUploadId = new Map(
      this.relationshipView?.interactions.map((interaction) => [interaction.sourceUploadId, interaction] as const) ?? []
    );
    const candidates = [...this.cache.listDays()].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.uploadId.localeCompare(left.uploadId)
    );
    for (const candidate of candidates) {
      const importedInteraction = interactionByUploadId.get(candidate.uploadId);
      if (!isRealDateCompanionUploadId(candidate.uploadId) || !importedInteraction) continue;
      const payload = this.cachedPayload(candidate.uploadId);
      if (!payload || (payload.job?.status ?? payload.upload.status) !== "ready") continue;
      this.showPayload(payload);
      this.update({
        uploadState: {
          status: "ready",
          uploadId: payload.upload.id,
          cacheStatus: "saved",
          serverCleanupStatus: importedInteraction.sourceState === "server_cleaned" ? "completed" : "not_completed",
          ...(importedInteraction.sourceState === "server_cleaned"
            ? {}
            : { cleanupMessage: "服务器原结果尚未清理" })
        }
      });
      return true;
    }
    return false;
  }

  private async loadRelationship(): Promise<void> {
    this.fenceActiveToyRecoveryForRelationshipChange();
    this.relationshipController?.abort();
    this.relationshipRequestVersion += 1;
    const version = this.relationshipRequestVersion;
    this.relationshipController = new AbortController();
    const controller = this.relationshipController;
    this.update({ relationshipState: { status: "loading" } });

    try {
      const relationships = await this.api.listRelationships(controller.signal);
      if (this.disposed || version !== this.relationshipRequestVersion) return;
      const relationship = relationships.find((candidate) => candidate.status === "active");
      if (!relationship) {
        this.relationshipView = null;
        this.update({ relationshipState: { status: "absent" } });
        this.refreshViewModel();
        return;
      }
      const view = await this.api.getRelationshipView(relationship.id, controller.signal);
      if (this.disposed || version !== this.relationshipRequestVersion) return;
      if (view.relationship.id !== relationship.id) {
        throw new Error("Relationship view belongs to another relationship");
      }
      this.applyRelationshipView(view);
    } catch (error) {
      if (isAbortError(error) || version !== this.relationshipRequestVersion) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      this.relationshipView = null;
      this.update({ relationshipState: { status: "error", message: relationshipActionErrorMessage(error, "暂时无法读取这段关系") } });
      this.refreshViewModel();
    } finally {
      if (this.relationshipController === controller) this.relationshipController = null;
    }
  }

  private async finishPayload(
    payload: DayPayload,
    receipt: UploadReceipt | undefined,
    failedReceipt: FailedUploadReceipt | undefined,
    version: number,
    toyRecoveryScope?: ToyRecoveryRelationshipScope
  ): Promise<void> {
    const uploadId = payload.upload.id;
    if (!this.isCurrentScopedUpload(version, uploadId, toyRecoveryScope)) return;
    if (
      receipt?.ingestionReceipt
      && !this.toyReceiptBelongsToCurrentRelationship(receipt.ingestionReceipt)
    ) {
      this.pauseMismatchedToyRecovery(receipt);
      return;
    }
    this.showPayload(payload);
    const status = payload.job?.status ?? payload.upload.status;

    if (status === "failed") {
      this.update({
        uploadState: {
          status: "failed",
          uploadId,
          receipt,
          failedReceipt,
          message: payload.job?.errorMessage ?? "这次处理没有完成，可以重新读取状态",
          failureStage: "processing"
        }
      });
      return;
    }

    if (status !== "ready") return;

    try {
      this.cache.saveDay(payload);
    } catch (error) {
      this.update({
        uploadState: {
          status: "failed",
          uploadId,
          receipt,
          message: `本机保存失败，服务端结果仍保留，尚未清理：${errorMessage(error, "无法写入本机缓存")}`,
          failureStage: "cache",
          serverDataRetained: true
        }
      });
      return;
    }

    await this.finishCachedPayload(
      payload,
      receipt,
      failedReceipt,
      version,
      this.pollController?.signal,
      false,
      toyRecoveryScope
    );
  }

  private async finishCachedPayload(
    payload: DayPayload,
    receipt: UploadReceipt | undefined,
    failedReceipt: FailedUploadReceipt | undefined,
    version: number,
    signal?: AbortSignal,
    forceCleanup = false,
    toyRecoveryScope?: ToyRecoveryRelationshipScope
  ): Promise<void> {
    const uploadId = payload.upload.id;
    if (!this.isCurrentScopedUpload(version, uploadId, toyRecoveryScope)) return;
    this.showPayload(payload);

    const relationshipId = this.relationshipView?.relationship.id;
    if (!relationshipId || this.snapshot.relationshipState.status !== "ready") {
      this.update({
        uploadState: {
          status: "failed",
          uploadId,
          receipt,
          message: "这次相处已保存在本机，但还没有明确建立一段关系；服务端结果仍保留，尚未清理。",
          failureStage: "relationship_import",
          serverDataRetained: true
        }
      });
      return;
    }

    let importedInteraction = this.relationshipInteractionForUpload(uploadId);
    // sourceState=available can also mean a previous import persisted the text
    // snapshot but returned a retryable participant-audio error. Re-run the
    // idempotent import before cleanup so a reload cannot delete the only source
    // audio before speaker previews are durable (or declared not applicable).
    if (!importedInteraction || importedInteraction.sourceState === "available") {
      try {
        const imported = await this.api.importInteraction(
          relationshipId,
          { uploadId },
          signal
        );
        if (!this.isCurrentScopedUpload(version, uploadId, toyRecoveryScope)) return;
        if (
          imported.view.relationship.id !== relationshipId ||
          !imported.view.interactions.some(
            (interaction) => interaction.id === imported.interactionId && interaction.sourceUploadId === uploadId
          )
        ) {
          throw new Error("Imported interaction does not match the current recording");
        }
        this.applyRelationshipView(imported.view);
        importedInteraction = this.relationshipInteractionForUpload(uploadId);
      } catch (error) {
        if (
          !this.isCurrentScopedUpload(version, uploadId, toyRecoveryScope)
          || isAbortError(error)
        ) return;
        if (error instanceof DateCompanionApiError && error.status === 401) {
          this.expireAuthentication();
          return;
        }
        if (error instanceof DateCompanionApiError && error.status === 404) {
          const userId = this.authenticatedUserId();
          if (userId) this.clearPersistedUpload(userId, uploadId);
          this.clearStaleLocalUpload(uploadId);
          this.currentPayload = null;
          this.activeUploadId = null;
          this.update({
            uploadState: { status: "idle" },
            currentQaState: { status: "idle" },
            currentQaHistory: []
          });
          this.refreshViewModel();
          return;
        }
        this.update({
          uploadState: {
            status: "failed",
            uploadId,
            receipt,
            failedReceipt,
            message: `长期保存没有完成，服务端结果仍保留，尚未清理：${relationshipActionErrorMessage(error, "无法关联这次相处")}`,
            failureStage: "relationship_import",
            serverDataRetained: true
          }
        });
        return;
      }
    }

    if (!this.isCurrentScopedUpload(version, uploadId, toyRecoveryScope)) return;
    if (importedInteraction?.sourceState === "server_cleaned" && !forceCleanup) {
      this.update({
        uploadState: {
          status: "ready",
          uploadId,
          receipt,
          cacheStatus: "saved",
          serverCleanupStatus: "completed"
        }
      });
      void this.ensureMemoryBridgeLoaded(true);
      return;
    }

    this.update({
      uploadState: {
        status: "ready",
        uploadId,
        receipt,
        cacheStatus: "saved",
        serverCleanupStatus: "pending"
      }
    });

    try {
      await this.api.cleanupUpload(uploadId, signal);
      if (!this.isCurrentScopedUpload(version, uploadId, toyRecoveryScope)) return;
      this.markPersistedCleanupConfirmed(uploadId);
      this.update({
        uploadState: {
          status: "ready",
          uploadId,
          receipt,
          cacheStatus: "saved",
          serverCleanupStatus: "completed"
        }
      });
    } catch (error) {
      if (!this.isCurrentScopedUpload(version, uploadId, toyRecoveryScope)) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      this.update({
        uploadState: {
          status: "ready",
          uploadId,
          receipt,
          cacheStatus: "saved",
          serverCleanupStatus: "not_completed",
          cleanupMessage: errorMessage(error, "服务器数据尚未清理")
        }
      });
    }
  }

  private async resumeCachedPayload(
    uploadId: string,
    receipt: UploadReceipt | undefined,
    failedReceipt: FailedUploadReceipt | undefined,
    version: number,
    forceCleanup = true,
    toyRecoveryScope?: ToyRecoveryRelationshipScope
  ): Promise<boolean> {
    if (!this.isCurrentScopedUpload(version, uploadId, toyRecoveryScope)) return false;
    const payload = this.cachedPayload(uploadId);
    if (
      !payload ||
      (payload.job?.status ?? payload.upload.status) !== "ready"
    ) {
      return false;
    }

    const controller = new AbortController();
    this.pollController = controller;
    try {
      await this.finishCachedPayload(
        payload,
        receipt,
        failedReceipt,
        version,
        controller.signal,
        forceCleanup,
        toyRecoveryScope
      );
    } finally {
      if (this.pollController === controller) this.pollController = null;
    }
    return true;
  }

  private async pollToyRecoveryUpload(
    receipt: UploadReceipt,
    uploadId: string,
    version: number,
    scope: ToyRecoveryRelationshipScope,
    failedReceipt?: FailedUploadReceipt
  ): Promise<void> {
    if (!this.isCurrentScopedUpload(version, uploadId, scope)) return;
    const controller = new AbortController();
    this.pollController = controller;
    const deadline = Date.now() + this.toyRecoveryPollTimeoutMs;
    let deadlineReached = false;
    const timeout = setTimeout(() => {
      deadlineReached = true;
      controller.abort();
    }, this.toyRecoveryPollTimeoutMs);
    this.update({
      uploadState: {
        status: "processing",
        receipt,
        failedReceipt,
        jobStatus: receipt.status,
        progress: undefined
      }
    });

    const deferRecovery = (message: string) => {
      if (!this.isCurrentScopedUpload(version, uploadId, scope)) return;
      this.update({
        uploadState: {
          status: "failed",
          uploadId,
          receipt,
          failedReceipt,
          message,
          failureStage: "read",
          serverDataRetained: true
        }
      });
    };

    try {
      for (let attempt = 0; attempt < this.toyRecoveryPollMaxAttempts; attempt += 1) {
        const payload = await this.api.getDay(uploadId, controller.signal);
        if (!this.isCurrentScopedUpload(version, uploadId, scope)) return;
        this.showPayload(payload);
        const status = payload.job?.status ?? payload.upload.status;
        if (status === "ready" || status === "failed") {
          clearTimeout(timeout);
          await this.finishPayload(payload, receipt, failedReceipt, version, scope);
          return;
        }
        const jobStatus = processingStatus(payload);
        if (jobStatus) {
          this.update({
            uploadState: {
              status: "processing",
              receipt,
              failedReceipt,
              jobStatus,
              progress: payload.job?.progress
            }
          });
        }
        if (attempt + 1 >= this.toyRecoveryPollMaxAttempts) break;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          deadlineReached = true;
          break;
        }
        await waitForAbortableDelay(
          Math.min(this.pollIntervalMs, remainingMs),
          controller.signal
        );
      }
      deferRecovery("这次玩偶录音仍在服务器整理，可稍后重新读取，不需要再次上传音频。");
    } catch (error) {
      if (!this.isCurrentScopedUpload(version, uploadId, scope)) return;
      if (isAbortError(error)) {
        if (deadlineReached) {
          deferRecovery("读取整理结果已暂停，可稍后重新读取，不需要再次上传音频。");
        }
        return;
      }
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      deferRecovery(errorMessage(error, "暂时无法读取整理结果，可稍后重试。"));
    } finally {
      clearTimeout(timeout);
      if (this.pollController === controller) this.pollController = null;
    }
  }

  private async pollUpload(
    receipt: UploadReceipt | undefined,
    uploadId: string,
    version: number,
    failedReceipt?: FailedUploadReceipt
  ): Promise<void> {
    if (
      receipt?.ingestionReceipt
      && !this.toyReceiptBelongsToCurrentRelationship(receipt.ingestionReceipt)
    ) {
      this.pauseMismatchedToyRecovery(receipt);
      return;
    }
    this.pollController = new AbortController();
    const controller = this.pollController;
    this.update({
      uploadState: {
        status: "processing",
        receipt,
        failedReceipt,
        ...(receipt || failedReceipt ? { jobStatus: receipt?.status ?? failedReceipt?.status } : {}),
        progress: undefined,
        ...(!receipt ? { statusMessage: "正在重新读取这次相处的处理结果" } : {})
      }
    });

    try {
      const payload = await this.api.pollDay(uploadId, {
        signal: controller.signal,
        intervalMs: this.pollIntervalMs,
        onPayload: (partialPayload) => {
          if (!this.isCurrentUpload(version, uploadId)) return;
          this.showPayload(partialPayload);
          const jobStatus = processingStatus(partialPayload);
          if (jobStatus) {
            this.update({
              uploadState: {
                status: "processing",
                receipt,
                failedReceipt,
                jobStatus,
                progress: partialPayload.job?.progress
              }
            });
          }
        }
      });
      await this.finishPayload(payload, receipt, failedReceipt, version);
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentUpload(version, uploadId)) return;

      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }

      if (error instanceof DateCompanionApiError && error.status === 404) {
        const relationshipMembershipKnown =
          this.snapshot.relationshipState.status === "ready" ||
          this.snapshot.relationshipState.status === "absent";
        const belongsToCurrentRelationship = this.relationshipContainsUpload(uploadId);
        const cached = belongsToCurrentRelationship ? this.cachedPayload(uploadId) : null;
        if (cached) {
          this.showPayload(cached);
          this.update({
            uploadState: {
              status: "ready",
              uploadId,
              receipt,
              cacheStatus: "saved",
              serverCleanupStatus: "completed"
            }
          });
          return;
        }
        if (relationshipMembershipKnown && !belongsToCurrentRelationship) {
          const userId = this.authenticatedUserId();
          if (userId) this.clearPersistedUpload(userId, uploadId);
          this.clearStaleLocalUpload(uploadId);
          this.currentPayload = null;
          this.activeUploadId = null;
          this.update({
            uploadState: { status: "idle" },
            currentQaState: { status: "idle" },
            currentQaHistory: []
          });
          this.refreshViewModel();
          if (this.restoreLatestCached()) return;
          return;
        }
        if (this.restoreLatestCached()) return;
      }

      this.update({
        uploadState: {
          status: "failed",
          uploadId,
          receipt,
          failedReceipt,
          message: errorMessage(error, "暂时无法读取这次相处的处理状态"),
          failureStage: "read"
        }
      });
    } finally {
      if (this.pollController === controller) this.pollController = null;
    }
  }

  private async runRelationshipMutation(
    operation: "participants" | "recap" | "finalize" | "promise" | "delete",
    mutate: (signal: AbortSignal) => Promise<DcRelationshipView>
  ): Promise<void> {
    if (this.snapshot.relationshipState.status !== "ready" || !this.relationshipView) return;
    this.mutationController?.abort();
    this.mutationRequestVersion += 1;
    const version = this.mutationRequestVersion;
    this.mutationController = new AbortController();
    const controller = this.mutationController;
    this.update({ mutationState: { status: "saving", operation } });

    try {
      const view = await mutate(controller.signal);
      if (this.disposed || version !== this.mutationRequestVersion) return;
      if (view.relationship.id !== this.relationshipView.relationship.id) {
        throw new Error("Mutation returned another relationship");
      }
      this.applyRelationshipView(view);
      this.update({ mutationState: { status: "idle" } });
    } catch (error) {
      if (isAbortError(error) || version !== this.mutationRequestVersion) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      const message = relationshipActionErrorMessage(error, "这次修改没有保存");
      this.update({
        mutationState: {
          status: "error",
          operation,
          message
        }
      });
      throw new Error(message);
    } finally {
      if (this.mutationController === controller) this.mutationController = null;
    }
  }

  readonly ensureMemoryBridgeLoaded = async (force = false): Promise<void> => {
    const relationshipId = this.relationshipView?.relationship.id;
    if (!relationshipId || this.snapshot.auth.status !== "authenticated") return;
    if (!force && (this.snapshot.memoryBridgeState.status === "ready" || this.snapshot.memoryBridgeState.status === "loading")) {
      return;
    }
    this.memoryController?.abort();
    this.memoryRequestVersion += 1;
    const version = this.memoryRequestVersion;
    const controller = new AbortController();
    this.memoryController = controller;
    if (this.snapshot.memoryBridgeState.status !== "ready") {
      this.update({ memoryBridgeState: { status: "loading" } });
    }

    try {
      const [people, selfBinding, review, sourceCatalog] = await Promise.all([
        this.api.listConfirmedPeople(controller.signal),
        this.api.getSelfBinding(controller.signal),
        this.api.getMemoryReview(relationshipId, controller.signal),
        this.api.getPersonSourceCatalog(relationshipId, controller.signal)
      ]);
      if (
        this.disposed ||
        version !== this.memoryRequestVersion ||
        this.relationshipView?.relationship.id !== relationshipId
      ) return;
      const mapping = review.mapping;
      let retainedSubjects: Record<string, DateCompanionMemorySubject> = {};
      let memoryRetainedSourceKeys: string[] = [];
      let relationshipPersonSources: DateCompanionRelationshipPersonSource[] = [];
      let personQaSources: SourceRefVM[] = [];
      const confirmedIds = new Set(people.map((person) => person.id));
      if (
        this.relationshipView.relationship.status === "active" &&
        mapping?.status === "confirmed" &&
        mapping.selfPersonId !== mapping.companionPersonId &&
        confirmedIds.has(mapping.selfPersonId) &&
        confirmedIds.has(mapping.companionPersonId) &&
        selfBinding?.status === "active" &&
        selfBinding.personId === mapping.selfPersonId
      ) {
        const [selfSources, companionSources] = await Promise.all([
          this.api.getPersonRetainedSources(mapping.selfPersonId, controller.signal),
          this.api.getPersonRetainedSources(mapping.companionPersonId, controller.signal)
        ]);
        if (
          this.disposed ||
          version !== this.memoryRequestVersion ||
          this.relationshipView?.relationship.id !== relationshipId
        ) return;
        const trustedRelationshipSources = sourceCatalog.status === "ready"
          && sourceCatalog.relationshipId === relationshipId
          && sourceCatalog.companionPersonId === mapping.companionPersonId
          && sourceCatalog.mappingVersion === mapping.version
          ? sourceCatalog.sources
          : [];
        const unifiedCatalog = buildUnifiedPersonSourceCatalog({
          selfPersonId: mapping.selfPersonId,
          companionPersonId: mapping.companionPersonId,
          memorySources: [...selfSources, ...companionSources],
          relationshipPersonSources: trustedRelationshipSources,
          relationshipSources: this.relationshipQaSources(),
          getLocalDay: (uploadId) => this.localPayload(uploadId)
        });
        retainedSubjects = unifiedCatalog.retainedSubjects;
        memoryRetainedSourceKeys = unifiedCatalog.memoryRetainedSourceKeys;
        relationshipPersonSources = unifiedCatalog.relationshipPersonSources;
        personQaSources = unifiedCatalog.sources;
      }
      this.update({
        memoryBridgeState: {
          status: "ready",
          people,
          selfBinding,
          setting: review.retention,
          mapping,
          review,
          retainedSubjects,
          memoryRetainedSourceKeys,
          relationshipPersonSources,
          personQaSources
        }
      });
      this.refreshViewModel();
      this.syncPersonQaHistory(true);
    } catch (error) {
      if (isAbortError(error) || version !== this.memoryRequestVersion) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      this.update({
        memoryBridgeState: {
          status: "error",
          message: relationshipActionErrorMessage(error, "人物与长期保留设置暂时没有读取成功。")
        }
      });
      this.refreshViewModel();
      this.syncPersonQaHistory(true);
    } finally {
      if (this.memoryController === controller) this.memoryController = null;
    }
  };

  private applyMemoryReview(review: DateCompanionMemoryReview) {
    const current = this.snapshot.memoryBridgeState;
    if (current.status !== "ready") return;
    this.update({
      memoryBridgeState: {
        ...current,
        setting: review.retention,
        mapping: review.mapping,
        review
      }
    });
  }

  private applyMemorySyncStatus(
    interactionId: string,
    result: {
      status: DateCompanionMemoryBridgeStatus;
      attemptCount: number;
      updatedAt: string;
      review?: DateCompanionMemoryReviewInteraction["review"];
    }
  ) {
    const current = this.snapshot.memoryBridgeState;
    if (current.status !== "ready") return;
    const interaction = current.review.interactions.find((candidate) => candidate.interactionId === interactionId);
    if (!interaction) return;
    this.applyMemoryReview({
      ...current.review,
      interactions: current.review.interactions.map((candidate) => candidate.interactionId === interactionId
        ? {
            ...candidate,
            status: result.status,
            attemptCount: result.attemptCount,
            updatedAt: result.updatedAt,
            ...(result.review ? { review: result.review } : {})
          }
        : candidate)
    });
  }

  private async pollMemoryBridgeUntilSettled(input: {
    interactionId: string;
    relationshipId: string;
    initialStatus: DateCompanionMemoryBridgeStatus;
    signal: AbortSignal;
    mutationVersion: number;
  }): Promise<boolean> {
    if (!shouldPollMemoryBridge(input.initialStatus)) return true;
    if (this.memoryBridgePollTimeoutMs <= 0) return false;
    const deadline = Date.now() + this.memoryBridgePollTimeoutMs;
    let status: DateCompanionMemoryBridgeStatus | "not_queued" | undefined = input.initialStatus;

    while (shouldPollMemoryBridge(status)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await waitForAbortableDelay(Math.min(this.pollIntervalMs, remainingMs), input.signal);
      if (
        this.disposed
        || input.mutationVersion !== this.memoryMutationRequestVersion
        || this.relationshipView?.relationship.id !== input.relationshipId
      ) return false;

      const readController = new AbortController();
      const abortRead = () => readController.abort();
      input.signal.addEventListener("abort", abortRead, { once: true });
      const readTimeout = setTimeout(abortRead, Math.max(0, deadline - Date.now()));
      let review: DateCompanionMemoryReview;
      try {
        review = await this.api.getMemoryReview(input.relationshipId, readController.signal);
      } catch (error) {
        if (input.signal.aborted) throw error;
        if (readController.signal.aborted) return false;
        // The sync POST has already been accepted. A read failure must not turn it
        // into a second mutation or claim that the save failed.
        return false;
      } finally {
        clearTimeout(readTimeout);
        input.signal.removeEventListener("abort", abortRead);
      }
      if (
        this.disposed
        || input.mutationVersion !== this.memoryMutationRequestVersion
        || this.relationshipView?.relationship.id !== input.relationshipId
      ) return false;
      this.applyMemoryReview(review);
      status = review.interactions.find((candidate) => candidate.interactionId === input.interactionId)?.status ?? status;
    }
    return true;
  }

  private async runMemoryMutation(
    operation: "create_person" | "mapping" | "retention" | "sync" | "purge",
    mutate: (signal: AbortSignal) => Promise<void | { skipRefresh: true }>,
    targetId?: string
  ) {
    if (this.snapshot.memoryMutationState.status === "saving") return;
    this.memoryMutationController?.abort();
    this.memoryMutationRequestVersion += 1;
    const version = this.memoryMutationRequestVersion;
    const controller = new AbortController();
    this.memoryMutationController = controller;
    if (operation === "mapping" || operation === "purge") this.invalidatePersonSourceCatalog();
    this.update({ memoryMutationState: { status: "saving", operation, ...(targetId ? { targetId } : {}) } });
    try {
      const result = await mutate(controller.signal);
      if (this.disposed || version !== this.memoryMutationRequestVersion) return;
      if (!result?.skipRefresh) await this.ensureMemoryBridgeLoaded(true);
      if (this.disposed || version !== this.memoryMutationRequestVersion) return;
      this.update({ memoryMutationState: { status: "idle" } });
    } catch (error) {
      if (isAbortError(error) || version !== this.memoryMutationRequestVersion) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      if (
        operation === "mapping"
        || operation === "purge"
        || error instanceof DateCompanionApiError && error.status === 409
      ) {
        await this.ensureMemoryBridgeLoaded(true);
      }
      const message = relationshipActionErrorMessage(error, "这项设置暂时没有保存成功，请稍后再试。");
      this.update({
        memoryMutationState: {
          status: "error",
          operation,
          message,
          ...(targetId ? { targetId } : {})
        }
      });
      throw new Error(message);
    } finally {
      if (this.memoryMutationController === controller) this.memoryMutationController = null;
    }
  }

  readonly createConfirmedPerson = async (displayName: string): Promise<void> => {
    const normalizedName = displayName.normalize("NFKC").trim();
    if (!normalizedName) return;
    await this.runMemoryMutation("create_person", async (signal) => {
      const idempotencyKey = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `date-companion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const candidate = await this.api.createPersonCandidate({ idempotencyKey, displayName: normalizedName }, signal);
      if (candidate.status === "confirmed" && candidate.explicitlyConfirmed && candidate.confirmedAt) return;
      await this.api.confirmPerson(candidate.id, candidate.version, signal);
    });
  };

  readonly savePersonMapping = async (input: {
    selfPersonId: string;
    companionPersonId: string;
    relationshipType: DateCompanionRelationshipType;
  }): Promise<void> => {
    const relationshipId = this.relationshipView?.relationship.id;
    const bridge = this.snapshot.memoryBridgeState;
    if (!relationshipId || bridge.status !== "ready") return;
    if (input.selfPersonId === input.companionPersonId) {
      const message = "“我”和“Ta”必须选择为两个不同的人。";
      this.update({ memoryMutationState: { status: "error", operation: "mapping", message } });
      throw new Error(message);
    }
    const confirmedIds = new Set(bridge.people.map((person) => person.id));
    if (!confirmedIds.has(input.selfPersonId) || !confirmedIds.has(input.companionPersonId)) {
      const message = "请先选择两个已经确认的人物。";
      this.update({ memoryMutationState: { status: "error", operation: "mapping", message } });
      throw new Error(message);
    }
    await this.runMemoryMutation("mapping", async (signal) => {
      if (bridge.selfBinding?.personId !== input.selfPersonId || bridge.selfBinding.status !== "active") {
        await this.api.setSelfBinding(input.selfPersonId, bridge.selfBinding?.version ?? 0, signal);
      }
      await this.api.updatePersonMapping(relationshipId, {
        ...input,
        expectedVersion: bridge.mapping?.version ?? 0
      }, signal);
    });
  };

  readonly setLongTermRetention = async (enabled: boolean): Promise<void> => {
    const bridge = this.snapshot.memoryBridgeState;
    if (bridge.status !== "ready" || bridge.setting.enabled === enabled) return;
    await this.runMemoryMutation("retention", async (signal) => {
      await this.api.updateMemorySetting(enabled, bridge.setting.version, signal);
    });
  };

  readonly syncInteractionMemory = async (
    interactionId: string,
    selections?: Array<{ evidenceSnapshotId: string; subject: DateCompanionMemorySubject }>,
    subjectSuggestionConfirmation?: DcSubjectSuggestionConfirmation,
    relationshipReconfirmation?: DateCompanionRelationshipReconfirmationRequest
  ): Promise<void> => {
    const bridge = this.snapshot.memoryBridgeState;
    if (bridge.status !== "ready") {
      const message = "人物与长期保留设置还没有读取完成，请稍后再试。";
      this.update({ memoryMutationState: { status: "error", operation: "sync", message, targetId: interactionId } });
      throw new Error(message);
    }
    if (bridge.mapping?.status !== "confirmed") {
      const message = "需要先重新确认人物设置，才能继续整理长期记录。";
      this.update({ memoryMutationState: { status: "error", operation: "sync", message, targetId: interactionId } });
      throw new Error(message);
    }
    await this.runMemoryMutation("sync", async (signal) => {
      const result = await this.api.syncInteractionMemory(interactionId, {
        mappingVersion: bridge.mapping!.version,
        ...(selections ? { selections } : {}),
        ...(subjectSuggestionConfirmation ? { subjectSuggestionConfirmation } : {}),
        ...(relationshipReconfirmation ? { relationshipReconfirmation } : {})
      }, signal);
      if (!result) return;
      this.applyMemorySyncStatus(interactionId, result);
      const relationshipId = this.relationshipView?.relationship.id;
      if (!relationshipId) return;
      const settled = await this.pollMemoryBridgeUntilSettled({
        interactionId,
        relationshipId,
        initialStatus: result.status,
        signal,
        mutationVersion: this.memoryMutationRequestVersion
      });
      if (!settled) return { skipRefresh: true };
    }, interactionId);
  };

  readonly purgeRetainedMemory = async (): Promise<void> => {
    const relationshipId = this.relationshipView?.relationship.id;
    if (!relationshipId) return;
    await this.runMemoryMutation("purge", async (signal) => {
      await this.api.purgeRetainedMemory(relationshipId, signal);
    });
  };

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.disposed = false;
    this.initialized = true;
    const controller = new AbortController();
    this.authController = controller;

    try {
      const user = await this.api.getCurrentUser(controller.signal);
      if (!user) {
        this.setActiveUser(null);
        this.update({ auth: { status: "anonymous" } });
        return;
      }

      this.setActiveUser(user.id);
      this.update({ auth: { status: "authenticated", user } });
      await this.loadRelationship();
      if (this.snapshot.auth.status !== "authenticated") return;
      let persisted = this.readPersistedSession(user.id);
      if (
        persisted?.receipt?.ingestionReceipt
        && !this.toyReceiptBelongsToCurrentRelationship(persisted.receipt.ingestionReceipt)
      ) {
        // Keep another relationship's durable anchor for a future switch back,
        // but never let it mutate or block the relationship being initialized.
        persisted = null;
      }
      if (persisted?.receipt?.ingestionReceipt) {
        try {
          persisted = await this.refreshPersistedToyReceipt(user.id, persisted, controller.signal);
        } catch (error) {
          if (isToyRelationshipMismatch(error)) return;
          throw error;
        }
      }
      if (persisted && isRealDateCompanionUploadId(persisted.currentUploadId)) {
        this.activeUploadId = persisted.currentUploadId;
        const version = this.nextUploadVersion();
        const toyScope = persisted.receipt?.ingestionReceipt
          ? {
              userId: user.id,
              relationshipId: persisted.receipt.ingestionReceipt.relationshipId,
              relationshipRequestVersion: this.relationshipRequestVersion
            }
          : null;
        if (toyScope) this.activeToyRecoveryScope = toyScope;
        try {
          if (
            await this.resumeCachedPayload(
              persisted.currentUploadId,
              persisted.receipt,
              persisted.failedReceipt,
              version,
              persisted.cleanupConfirmed !== true,
              toyScope ?? undefined
            )
          ) return;
          if (toyScope && persisted.receipt) {
            await this.pollToyRecoveryUpload(
              persisted.receipt,
              persisted.currentUploadId,
              version,
              toyScope,
              persisted.failedReceipt
            );
          } else {
            await this.pollUpload(
              persisted.receipt,
              persisted.currentUploadId,
              version,
              persisted.failedReceipt
            );
          }
        } finally {
          if (toyScope && this.activeToyRecoveryScope === toyScope) {
            this.activeToyRecoveryScope = null;
          }
        }
        return;
      }
      if (
        this.restoreLatestCached() &&
        this.activeUploadId &&
        this.relationshipInteractionForUpload(this.activeUploadId)?.sourceState !== "server_cleaned"
      ) {
        const uploadId = this.activeUploadId;
        const version = this.nextUploadVersion();
        await this.resumeCachedPayload(uploadId, undefined, undefined, version);
      }
    } catch (error) {
      if (isAbortError(error)) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.setActiveUser(null);
        this.update({ auth: { status: "anonymous" } });
        return;
      }
      this.update({
        auth: {
          status: "error",
          message: error instanceof DateCompanionApiError
            ? error.message
            : "暂时无法确认登录状态，请稍后刷新重试。"
        }
      });
    } finally {
      if (this.authController === controller) this.authController = null;
    }
  }

  private beginAuthentication(): AbortController {
    this.authController?.abort();
    this.cancelUploadWork();
    this.cancelRelationshipWork();
    this.cancelQa();
    this.uploadRequestVersion += 1;
    this.currentPayload = null;
    this.relationshipView = null;
    this.selectedRelationshipInteractionId = null;
    this.activeUploadId = null;
    this.setActiveUser(null);
    const controller = new AbortController();
    this.authController = controller;
    this.update({
      auth: { status: "checking" },
      viewModel: emptyDateCompanionViewModel(),
      uploadState: { status: "idle" },
      activeQaMode: "person",
      currentQaState: { status: "idle" },
      currentQaHistory: [],
      qaState: { status: "idle" },
      qaHistory: [],
      relationshipState: { status: "idle" },
      mutationState: { status: "idle" },
      searchState: { status: "idle" },
      memoryBridgeState: { status: "idle" },
      memoryMutationState: { status: "idle" }
    });
    return controller;
  }

  private async restoreAuthenticatedUser(user: AuthUser): Promise<void> {
    this.setActiveUser(user.id);
    this.update({ auth: { status: "authenticated", user } });
    await this.loadRelationship();
    if (this.snapshot.auth.status !== "authenticated") return;
    let persisted = this.readPersistedSession(user.id);
    if (
      persisted?.receipt?.ingestionReceipt
      && !this.toyReceiptBelongsToCurrentRelationship(persisted.receipt.ingestionReceipt)
    ) {
      persisted = null;
    }
    if (persisted?.receipt?.ingestionReceipt) {
      try {
        persisted = await this.refreshPersistedToyReceipt(user.id, persisted);
      } catch (error) {
        if (isToyRelationshipMismatch(error)) return;
        throw error;
      }
    }
    if (persisted && isRealDateCompanionUploadId(persisted.currentUploadId)) {
      this.activeUploadId = persisted.currentUploadId;
      const version = this.nextUploadVersion();
      const toyScope = persisted.receipt?.ingestionReceipt
        ? {
            userId: user.id,
            relationshipId: persisted.receipt.ingestionReceipt.relationshipId,
            relationshipRequestVersion: this.relationshipRequestVersion
          }
        : null;
      if (toyScope) this.activeToyRecoveryScope = toyScope;
      try {
        if (
          await this.resumeCachedPayload(
            persisted.currentUploadId,
            persisted.receipt,
            persisted.failedReceipt,
            version,
            persisted.cleanupConfirmed !== true,
            toyScope ?? undefined
          )
        ) return;
        if (toyScope && persisted.receipt) {
          await this.pollToyRecoveryUpload(
            persisted.receipt,
            persisted.currentUploadId,
            version,
            toyScope,
            persisted.failedReceipt
          );
        } else {
          await this.pollUpload(
            persisted.receipt,
            persisted.currentUploadId,
            version,
            persisted.failedReceipt
          );
        }
      } finally {
        if (toyScope && this.activeToyRecoveryScope === toyScope) {
          this.activeToyRecoveryScope = null;
        }
      }
    } else if (
      this.restoreLatestCached() &&
      this.activeUploadId &&
      this.relationshipInteractionForUpload(this.activeUploadId)?.sourceState !== "server_cleaned"
    ) {
      const uploadId = this.activeUploadId;
      const version = this.nextUploadVersion();
      await this.resumeCachedPayload(uploadId, undefined, undefined, version);
    }
  }

  private async authenticate(
    request: (signal: AbortSignal) => Promise<AuthUser>,
    fallbackMessage: string
  ): Promise<void> {
    const controller = this.beginAuthentication();
    try {
      const user = await request(controller.signal);
      if (this.authController !== controller) return;
      await this.restoreAuthenticatedUser(user);
    } catch (error) {
      if (isAbortError(error)) return;
      if (error instanceof DateCompanionApiError && error.status === 401) this.setActiveUser(null);
      const message = error instanceof DateCompanionApiError ? error.message : fallbackMessage;
      this.update({ auth: { status: "error", message } });
    } finally {
      if (this.authController === controller) this.authController = null;
    }
  }

  readonly login = async (input: LoginInput): Promise<void> => {
    await this.authenticate((signal) => this.api.login(input, signal), "暂时无法连接登录服务，请稍后再试。");
  };

  readonly register = async (input: RegisterInput): Promise<void> => {
    await this.authenticate((signal) => this.api.register(input, signal), "暂时无法连接注册服务，请稍后再试。");
  };

  readonly clearAuthError = (): void => {
    if (this.snapshot.auth.status === "error") this.update({ auth: { status: "anonymous" } });
  };

  readonly logout = async (): Promise<void> => {
    this.authController?.abort();
    this.cancelUploadWork();
    this.cancelRelationshipWork();
    this.cancelQa();
    this.uploadRequestVersion += 1;
    this.currentPayload = null;
    this.relationshipView = null;
    this.selectedRelationshipInteractionId = null;
    this.activeUploadId = null;
    try {
      await this.api.logout();
      this.setActiveUser(null);
      this.update({
        auth: { status: "anonymous" },
        viewModel: emptyDateCompanionViewModel(),
        uploadState: { status: "idle" },
        activeQaMode: "person",
        currentQaState: { status: "idle" },
        currentQaHistory: [],
        qaState: { status: "idle" },
        qaHistory: [],
        relationshipState: { status: "idle" },
        mutationState: { status: "idle" },
        searchState: { status: "idle" },
        memoryBridgeState: { status: "idle" },
        memoryMutationState: { status: "idle" }
      });
    } catch (error) {
      this.setActiveUser(null);
      this.update({
        auth: {
          status: "error",
          message: error instanceof DateCompanionApiError
            ? error.message
            : "暂时无法完成退出，请刷新后重试。"
        },
        viewModel: emptyDateCompanionViewModel(),
        uploadState: { status: "idle" },
        activeQaMode: "person",
        currentQaState: { status: "idle" },
        currentQaHistory: [],
        qaState: { status: "idle" },
        qaHistory: [],
        relationshipState: { status: "idle" },
        mutationState: { status: "idle" },
        searchState: { status: "idle" },
        memoryBridgeState: { status: "idle" },
        memoryMutationState: { status: "idle" }
      });
    }
  };

  readonly adoptToyIngestionReceipt = async (
    request: DateCompanionToyUploadRequest
  ): Promise<ToyIngestionReceipt | null> => {
    const userId = this.authenticatedUserId();
    if (!userId) return null;
    if (
      this.snapshot.relationshipState.status !== "ready"
      || !this.relationshipView
      || request.destination !== "date_companion"
      || request.relationshipId !== this.relationshipView.relationship.id
    ) {
      this.pauseMismatchedToyRecovery();
      throw new DateCompanionApiError({
        status: 409,
        code: "toy_ingestion_relationship_mismatch"
      });
    }

    this.cancelToyReceiptRecovery();
    const recoveryController = new AbortController();
    this.toyReceiptRecoveryController = recoveryController;
    const relationshipScope: ToyRecoveryRelationshipScope = {
      userId,
      relationshipId: request.relationshipId,
      relationshipRequestVersion: this.relationshipRequestVersion
    };
    const recoveryScope = {
      userId,
      relationshipId: request.relationshipId,
      relationshipVersion: relationshipScope.relationshipRequestVersion,
      uploadVersion: this.uploadRequestVersion,
      recoveryVersion: this.toyReceiptRecoveryRequestVersion
    };
    let ingestion: ToyIngestionReceipt | null = null;
    try {
      for (let attempt = 0; attempt < TOY_RECEIPT_RECOVERY_LOOKUP_ATTEMPTS; attempt += 1) {
        ingestion = await this.api.getToyIngestionReceipt(request, recoveryController.signal);
        if (!this.isCurrentToyReceiptRecovery(recoveryScope)) return null;
        if (ingestion) {
          this.requireToyReceiptForCurrentRelationship(ingestion, request);
          if (isToySyncReceiptDurablyAccepted(ingestion)) break;
        }
        if (attempt + 1 < TOY_RECEIPT_RECOVERY_LOOKUP_ATTEMPTS) {
          await waitForAbortableDelay(this.pollIntervalMs, recoveryController.signal);
          if (!this.isCurrentToyReceiptRecovery(recoveryScope)) return null;
        }
      }
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    } finally {
      if (this.toyReceiptRecoveryController === recoveryController) {
        this.toyReceiptRecoveryController = null;
      }
    }
    if (!this.isCurrentToyReceiptRecovery(recoveryScope)) return null;
    if (!ingestion) return null;
    if (!isToySyncReceiptDurablyAccepted(ingestion)) return ingestion;

    const receipt = uploadReceiptFromIngestion(ingestion);
    if (
      this.activeUploadId === receipt.uploadId
      && (this.snapshot.uploadState.status === "processing"
        || this.snapshot.uploadState.status === "ready")
    ) return ingestion;

    const version = this.nextUploadVersion();
    this.activeToyRecoveryScope = relationshipScope;
    this.currentPayload = null;
    this.activeUploadId = receipt.uploadId;
    this.persistSession(userId, { currentUploadId: receipt.uploadId, receipt });
    this.refreshViewModel();

    try {
      if (await this.resumeCachedPayload(
        receipt.uploadId,
        receipt,
        undefined,
        version,
        true,
        relationshipScope
      )) {
        return ingestion;
      }
      await this.pollToyRecoveryUpload(
        receipt,
        receipt.uploadId,
        version,
        relationshipScope
      );
      return ingestion;
    } finally {
      if (this.activeToyRecoveryScope === relationshipScope) {
        this.activeToyRecoveryScope = null;
      }
    }
  };

  readonly upload = async (
    file: File,
    recordingDate: string,
    options: DateCompanionUploadOptions = {}
  ): Promise<boolean> => {
    const userId = this.authenticatedUserId();
    if (!userId) {
      this.update({
        uploadState: { status: "failed", message: "请先登录", failureStage: "upload" }
      });
      return false;
    }
    if (this.snapshot.relationshipState.status !== "ready" || !this.relationshipView) {
      this.update({
        uploadState: {
          status: "failed",
          message: "请先由你明确建立这段关系，再上传相处录音。",
          failureStage: "upload"
        }
      });
      return false;
    }
    if (
      options.toyOperation
      && (options.toyOperation.destination !== "date_companion"
        || options.toyOperation.relationshipId !== this.relationshipView.relationship.id)
    ) {
      this.update({
        uploadState: {
          status: "failed",
          message: "玩偶录音不属于当前关系，请重新选择录音。",
          failureStage: "upload"
        }
      });
      return false;
    }

    const version = this.nextUploadVersion();
    this.uploadController = new AbortController();
    const controller = this.uploadController;
    this.currentPayload = null;
    this.activeUploadId = null;
    this.refreshViewModel();
    this.update({
      uploadState: { status: "uploading", fileName: file.name, recordingDate },
      currentQaState: { status: "idle" },
      currentQaHistory: []
    });

    let receiptReceived = false;
    let uploadAttempted = false;
    let serverAcceptedNotified = false;
    const notifyServerAccepted = async (receipt: UploadReceipt): Promise<boolean> => {
      if (serverAcceptedNotified) return true;
      try {
        await options.onServerAccepted?.(receipt);
        serverAcceptedNotified = true;
        return true;
      } catch {
        return false;
      }
    };
    const notifyServerAcceptedWithImmediateRetry = async (receipt: UploadReceipt) => {
      if (await notifyServerAccepted(receipt)) return;
      // A transient local persistence failure must not leave the adapter in an
      // uploading state for the entire poll/import lifecycle. One immediate
      // retry is safe because the callback contract is explicitly idempotent.
      await notifyServerAccepted(receipt);
    };
    const notifyIngestionReceipt = async (receipt: ToyIngestionReceipt) => {
      try {
        await options.onIngestionReceipt?.(receipt);
      } catch {
        await options.onIngestionReceipt?.(receipt);
      }
    };
    const continueAcceptedReceipt = async (receipt: UploadReceipt) => {
      if (receipt.ingestionReceipt && options.toyOperation) {
        this.requireToyReceiptForCurrentRelationship(
          receipt.ingestionReceipt,
          options.toyOperation
        );
      }
      if (
        receipt.ingestionReceipt
        && !isToySyncReceiptDurablyAccepted(receipt.ingestionReceipt)
      ) {
        await notifyIngestionReceipt(receipt.ingestionReceipt);
        this.update({
          uploadState: {
            status: "failed",
            message: "服务器正在确认这条录音，请保留文件并稍后用同一次操作重试。",
            failureStage: "upload"
          }
        });
        return;
      }
      receiptReceived = true;
      if (receipt.ingestionReceipt) await notifyIngestionReceipt(receipt.ingestionReceipt);
      if (version !== this.uploadRequestVersion || this.disposed) {
        await notifyServerAcceptedWithImmediateRetry(receipt);
        return;
      }
      this.activeUploadId = receipt.uploadId;
      this.persistSession(userId, {
        currentUploadId: receipt.uploadId,
        receipt
      });
      await notifyServerAcceptedWithImmediateRetry(receipt);
      await this.pollUpload(receipt, receipt.uploadId, version);
      if (options.toyOperation && receipt.ingestionReceipt) {
        try {
          const refreshed = await this.api.getToyIngestionReceipt(
            options.toyOperation,
            controller.signal
          );
          if (refreshed) {
            this.requireToyReceiptForCurrentRelationship(refreshed, options.toyOperation);
            await notifyIngestionReceipt(refreshed);
          }
        } catch {
          // The canonical receipt is already local. A refresh failure must not
          // cause another audio POST or invalidate the accepted upload.
        }
      }
    };
    try {
      let receipt: UploadReceipt;
      if (options.toyOperation) {
        const existing = await this.api.getToyIngestionReceipt(
          options.toyOperation,
          controller.signal
        );
        if (existing) {
          this.requireToyReceiptForCurrentRelationship(existing, options.toyOperation);
        }
        if (existing && isToySyncReceiptDurablyAccepted(existing)) {
          receipt = uploadReceiptFromIngestion(existing);
        } else {
          if (existing) await notifyIngestionReceipt(existing);
          uploadAttempted = true;
          receipt = await this.api.upload(
            file,
            recordingDate,
            controller.signal,
            options.toyOperation
          );
        }
      } else {
        uploadAttempted = true;
        receipt = await this.api.upload(file, recordingDate, controller.signal);
      }
      await continueAcceptedReceipt(receipt);
    } catch (error) {
      const erroredToyReceipt = options.toyOperation
        ? failedToyIngestionReceipt(error, options.toyOperation)
        : null;
      if (
        options.toyOperation
        && uploadAttempted
        && !receiptReceived
        && !erroredToyReceipt
        && !isAbortError(error)
        && (!(error instanceof DateCompanionApiError) || error.status >= 500)
      ) {
        try {
          const recovered = await this.api.getToyIngestionReceipt(
            options.toyOperation,
            controller.signal
          );
          if (recovered) {
            this.requireToyReceiptForCurrentRelationship(recovered, options.toyOperation);
            if (isToySyncReceiptDurablyAccepted(recovered)) {
              await continueAcceptedReceipt(uploadReceiptFromIngestion(recovered));
              return true;
            }
            await notifyIngestionReceipt(recovered);
          }
        } catch (recoveryError) {
          if (recoveryError instanceof DateCompanionApiError && recoveryError.status === 401) {
            this.expireAuthentication();
            return false;
          }
        }
      }
      if (erroredToyReceipt) {
        this.requireToyReceiptForCurrentRelationship(erroredToyReceipt, options.toyOperation);
        await notifyIngestionReceipt(erroredToyReceipt);
        if (isToySyncReceiptDurablyAccepted(erroredToyReceipt)) {
          await continueAcceptedReceipt(uploadReceiptFromIngestion(erroredToyReceipt));
          return true;
        }
      }
      const failedReceipt = failedUploadReceipt(error);
      if (failedReceipt) {
        receiptReceived = true;
      }
      if (isAbortError(error) || version !== this.uploadRequestVersion) {
        if (failedReceipt) {
          await notifyServerAcceptedWithImmediateRetry({
            uploadId: failedReceipt.uploadId,
            jobId: failedReceipt.jobId,
            status: "uploaded"
          });
        }
        return receiptReceived;
      }
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return receiptReceived;
      }
      if (failedReceipt) {
        this.activeUploadId = failedReceipt.uploadId;
        this.persistSession(userId, {
          currentUploadId: failedReceipt.uploadId,
          failedReceipt
        });
        await notifyServerAcceptedWithImmediateRetry({
          uploadId: failedReceipt.uploadId,
          jobId: failedReceipt.jobId,
          status: "uploaded"
        });
      }
      this.update({
        uploadState: {
          status: "failed",
          uploadId: failedReceipt?.uploadId,
          failedReceipt,
          message: errorMessage(error, "上传失败"),
          failureStage: "upload",
          ...(failedReceipt ? { serverDataRetained: true } : {})
        }
      });
    } finally {
      if (this.uploadController === controller) this.uploadController = null;
    }
    return receiptReceived;
  };

  readonly retryRead = async (): Promise<void> => {
    const uploadId = this.activeUploadId;
    if (!uploadId || !isRealDateCompanionUploadId(uploadId)) return;
    let receipt =
      this.snapshot.uploadState.status === "failed" || this.snapshot.uploadState.status === "ready"
        ? this.snapshot.uploadState.receipt
        : this.snapshot.uploadState.status === "processing"
          ? this.snapshot.uploadState.receipt
          : undefined;
    const failedReceipt =
      this.snapshot.uploadState.status === "failed" || this.snapshot.uploadState.status === "processing"
        ? this.snapshot.uploadState.failedReceipt
        : undefined;
    const forceCleanup = !(
      this.snapshot.uploadState.status === "ready" &&
      this.snapshot.uploadState.serverCleanupStatus === "completed"
    );
    if (
      receipt?.ingestionReceipt
      && !this.toyReceiptBelongsToCurrentRelationship(receipt.ingestionReceipt)
    ) {
      this.activeUploadId = null;
      this.update({ uploadState: { status: "idle" } });
      return;
    }
    const userId = this.authenticatedUserId();
    const toyScope = receipt?.ingestionReceipt && userId
      ? {
          userId,
          relationshipId: receipt.ingestionReceipt.relationshipId,
          relationshipRequestVersion: this.relationshipRequestVersion
        }
      : null;
    const version = this.nextUploadVersion();
    if (toyScope) this.activeToyRecoveryScope = toyScope;
    try {
      if (receipt?.ingestionReceipt) {
        try {
          const request = {
            operationKey: receipt.ingestionReceipt.operationKey,
            destination: "date_companion" as const,
            relationshipId: receipt.ingestionReceipt.relationshipId
          };
          const refreshed = await this.api.getToyIngestionReceipt(request);
          if (
            toyScope
            && !this.isCurrentScopedUpload(version, uploadId, toyScope)
          ) return;
          if (refreshed) {
            this.requireToyReceiptForCurrentRelationship(refreshed, request);
            receipt = { ...receipt, ingestionReceipt: refreshed };
            if (userId) this.persistSession(userId, { currentUploadId: uploadId, receipt });
          }
        } catch (error) {
          if (
            toyScope
            && !this.isCurrentScopedUpload(version, uploadId, toyScope)
          ) return;
          if (isToyRelationshipMismatch(error)) return;
          if (error instanceof DateCompanionApiError && error.status === 401) {
            this.expireAuthentication();
            return;
          }
          this.update({
            uploadState: {
              status: "failed",
              uploadId,
              receipt,
              message: "暂时无法读取录音回执，请稍后重试。",
              failureStage: "read",
              serverDataRetained: true
            }
          });
          return;
        }
      }
      if (await this.resumeCachedPayload(
        uploadId,
        receipt,
        failedReceipt,
        version,
        forceCleanup,
        toyScope ?? undefined
      )) return;
      if (toyScope && receipt) {
        await this.pollToyRecoveryUpload(receipt, uploadId, version, toyScope, failedReceipt);
      } else {
        await this.pollUpload(receipt, uploadId, version, failedReceipt);
      }
    } finally {
      if (toyScope && this.activeToyRecoveryScope === toyScope) {
        this.activeToyRecoveryScope = null;
      }
    }
  };

  readonly createRelationship = async (displayName?: string): Promise<void> => {
    if (!this.authenticatedUserId()) return;
    if (this.snapshot.relationshipState.status === "ready") return;
    this.relationshipController?.abort();
    this.relationshipRequestVersion += 1;
    const version = this.relationshipRequestVersion;
    this.relationshipController = new AbortController();
    const controller = this.relationshipController;
    this.update({ relationshipState: { status: "creating" } });

    try {
      const normalizedName = displayName?.trim();
      const created = await this.api.createRelationship(
        normalizedName ? { displayName: normalizedName } : {},
        controller.signal
      );
      const view = await this.api.getRelationshipView(created.relationship.id, controller.signal);
      if (this.disposed || version !== this.relationshipRequestVersion) return;
      if (view.relationship.id !== created.relationship.id) {
        throw new Error("Created relationship view does not match the relationship");
      }
      this.applyRelationshipView(view);
    } catch (error) {
      if (isAbortError(error) || version !== this.relationshipRequestVersion) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      this.update({
        relationshipState: { status: "error", message: relationshipActionErrorMessage(error, "暂时无法建立这段关系") }
      });
    } finally {
      if (this.relationshipController === controller) this.relationshipController = null;
    }
  };

  readonly updateParticipants = async (
    interactionId: string,
    version: number,
    assignments: Array<{ speakerId: string; role: DateCompanionParticipantRole }>
  ): Promise<void> => {
    await this.runRelationshipMutation("participants", (signal) =>
      this.api.updateParticipants(interactionId, { version, assignments }, signal)
    );
  };

  readonly updateRecap = async (
    interactionId: string,
    version: number,
    items: Array<{ id: string; version: number; userText?: string | null; disposition: RecapItemVM["disposition"] }>
  ): Promise<void> => {
    if (items.length === 0) return;
    await this.runRelationshipMutation("recap", (signal) =>
      this.api.updateRecap(interactionId, { version, items, finalize: false }, signal)
    );
  };

  readonly finalizeRecap = async (
    interactionId: string,
    version: number,
    assignments: Array<{ speakerId: string; role: DateCompanionParticipantRole }>,
    items: Array<{ id: string; version: number; userText?: string | null; disposition: RecapItemVM["disposition"] }>,
    voiceEnrollmentIntents: DateCompanionVoiceEnrollmentIntent[] = [],
    memoryAdmission?: {
      mappingVersion: number;
      subjectSuggestionConfirmation: DcSubjectSuggestionConfirmation;
      selections: Array<{ evidenceSnapshotId: string; subject: DateCompanionMemorySubject }>;
    }
  ): Promise<void> => {
    try {
      await this.runRelationshipMutation("finalize", (signal) =>
        this.api.updateRecap(interactionId, {
          version,
          assignments,
          items,
          ...(voiceEnrollmentIntents.length > 0 ? { voiceEnrollmentIntents } : {}),
          ...(memoryAdmission ? { memoryAdmission } : {}),
          finalize: true
        }, signal)
      );
    } catch (error) {
      if (memoryAdmission) await this.ensureMemoryBridgeLoaded(true);
      throw error;
    }
    await this.ensureMemoryBridgeLoaded(true);
  };

  readonly updatePromise = async (
    promiseId: string,
    version: number,
    status: "open" | "done"
  ): Promise<void> => {
    await this.runRelationshipMutation("promise", (signal) =>
      this.api.patchPromise(promiseId, { version, status }, signal)
    );
  };

  readonly searchRelationship = async (query: string): Promise<void> => {
    const normalizedQuery = query.trim();
    this.searchController?.abort();
    this.searchRequestVersion += 1;
    const version = this.searchRequestVersion;
    if (!normalizedQuery) {
      this.searchController = null;
      this.update({ searchState: { status: "idle" } });
      return;
    }
    if (this.snapshot.relationshipState.status !== "ready" || !this.relationshipView) return;

    const relationshipId = this.relationshipView.relationship.id;
    this.searchController = new AbortController();
    const controller = this.searchController;
    this.update({ searchState: { status: "loading", query: normalizedQuery } });
    try {
      const results = await this.api.searchRelationship(relationshipId, normalizedQuery, controller.signal);
      if (this.disposed || version !== this.searchRequestVersion) return;
      const interactionIds = new Set(this.relationshipView.interactions.map((interaction) => interaction.id));
      this.update({
        searchState: {
          status: "ready",
          query: normalizedQuery,
          results: buildDateCompanionSearchResults(
            results.filter((result) => interactionIds.has(result.interactionId)),
            {
              hasLocalDay: (uploadId) => this.currentPayload?.upload.id === uploadId || this.cachedPayload(uploadId) !== null,
              retainedSubjects: this.snapshot.memoryBridgeState.status === "ready"
                ? this.snapshot.memoryBridgeState.retainedSubjects
                : {},
              memoryRetainedSourceKeys: this.snapshot.memoryBridgeState.status === "ready"
                ? this.snapshot.memoryBridgeState.memoryRetainedSourceKeys
                : [],
              relationshipPersonSources: this.snapshot.memoryBridgeState.status === "ready"
                ? this.snapshot.memoryBridgeState.relationshipPersonSources
                : [],
              relationshipView: this.relationshipView
            }
          )
        }
      });
    } catch (error) {
      if (isAbortError(error) || version !== this.searchRequestVersion) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      this.update({
        searchState: { status: "error", query: normalizedQuery, message: relationshipActionErrorMessage(error, "搜索没有完成") }
      });
    } finally {
      if (this.searchController === controller) this.searchController = null;
    }
  };

  readonly deleteInteraction = async (interactionId: string): Promise<void> => {
    const relationshipId = this.relationshipView?.relationship.id;
    const interaction = this.relationshipView?.interactions.find((candidate) => candidate.id === interactionId);
    if (!relationshipId || !interaction) return;
    this.invalidatePersonSourceCatalog();
    try {
      await this.runRelationshipMutation("delete", async (signal) => {
        if (interaction.sourceState === "available") {
          await this.api.deleteSourceUpload(
            interaction.sourceUploadId,
            { interactionId: interaction.id, expectedVersion: interaction.version },
            signal
          );
        } else {
          await this.api.deleteInteraction(interactionId, interaction.version, signal);
        }
        this.clearStaleLocalUpload(interaction.sourceUploadId);
        if (this.currentPayload?.upload.id === interaction.sourceUploadId) {
          this.currentPayload = null;
          this.activeUploadId = null;
          this.update({
            uploadState: { status: "idle" },
            currentQaState: { status: "idle" },
            currentQaHistory: []
          });
          const userId = this.authenticatedUserId();
          if (userId) this.clearPersistedUpload(userId, interaction.sourceUploadId);
        }
        return this.api.getRelationshipView(relationshipId, signal);
      });
    } finally {
      if (this.snapshot.auth.status === "authenticated") await this.ensureMemoryBridgeLoaded(true);
    }
  };

  readonly selectCachedInteraction = (uploadId: string): boolean => {
    if (!this.relationshipView?.interactions.some((interaction) => interaction.sourceUploadId === uploadId)) return false;
    const payload = this.cachedPayload(uploadId);
    if (!payload || (payload.job?.status ?? payload.upload.status) !== "ready") return false;
    this.nextUploadVersion();
    this.showPayload(payload);
    this.update({
      uploadState: {
        status: "ready",
        uploadId,
        cacheStatus: "saved",
        serverCleanupStatus: "completed"
      }
    });
    return true;
  };

  readonly selectRelationshipInteraction = (interactionId: string | null): boolean => {
    const normalized = interactionId?.trim() || null;
    if (
      normalized
      && !this.relationshipView?.interactions.some((interaction) =>
        interaction.id === normalized && interaction.status === "confirmed"
      )
    ) {
      if (this.selectedRelationshipInteractionId !== null) {
        this.selectedRelationshipInteractionId = null;
        this.refreshViewModel();
      }
      return false;
    }
    if (this.selectedRelationshipInteractionId === normalized) return true;
    this.selectedRelationshipInteractionId = normalized;
    this.refreshViewModel();
    return true;
  };

  readonly relationshipQaSources = (): SourceRefVM[] =>
    this.relationshipView
      ? buildDateCompanionRelationshipQaSources(
          this.relationshipView,
          (uploadId) => this.localPayload(uploadId)
        )
      : [];

  readonly personQaSources = (): SourceRefVM[] =>
    this.snapshot.memoryBridgeState.status === "ready"
      ? this.snapshot.memoryBridgeState.personQaSources
      : [];

  readonly askCurrentInteraction = async (question: string): Promise<QuestionAnswer | null> => {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return null;
    this.activateQaMode("current-interaction");
    const availability = this.currentInteractionQaAvailability();
    const payload = this.currentPayload;
    const uploadId = this.activeUploadId;
    if (!availability.enabled || !payload || !uploadId) {
      this.update({
        currentQaState: {
          status: "failed",
          question: normalizedQuestion,
          message: availability.enabled
            ? "这次相处的完整记录已经变化，请重新打开后再试。"
            : availability.message
        }
      });
      return null;
    }

    this.cancelQa();
    const version = this.qaRequestVersion;
    this.qaController = new AbortController();
    const controller = this.qaController;
    this.update({
      currentQaState: { status: "streaming", question: normalizedQuestion, committedText: "" }
    });
    const conversation = this.snapshot.currentQaHistory.slice(-4).flatMap((answer) => [
      { role: "user" as const, content: answer.question },
      { role: "assistant" as const, content: answer.answer }
    ]);
    let finalAnswer: QuestionAnswer | null = null;
    let streamErrorCode: string | null = null;
    let streamCompleted = false;

    try {
      for await (const event of this.api.streamCurrentInteractionQa({
        uploadId,
        question: normalizedQuestion,
        conversation,
        segments: payload.segments,
        audioInsights: payload.audioInsights,
        semanticSegments: payload.semanticSegments,
        briefItems: payload.briefItems,
        relationshipSignals: payload.relationshipSignals,
        signal: controller.signal
      })) {
        if (
          version !== this.qaRequestVersion
          || this.snapshot.activeQaMode !== "current-interaction"
          || this.activeUploadId !== uploadId
          || this.currentPayload !== payload
        ) return null;
        if (event.type === "sentence") {
          const currentText = this.snapshot.currentQaState.status === "streaming"
            ? this.snapshot.currentQaState.committedText
            : "";
          this.update({
            currentQaState: {
              status: "streaming",
              question: normalizedQuestion,
              committedText: [currentText, event.text].filter(Boolean).join(" ")
            }
          });
        } else if (event.type === "final") {
          if (event.answer.uploadId !== uploadId) {
            throw new Error("QA final answer belongs to another upload");
          }
          if (!currentQaCitationSourcesResolve(event.answer, payload)) {
            throw new Error("QA final answer contains an unresolved source");
          }
          finalAnswer = event.answer;
        } else if (event.type === "error") {
          streamErrorCode = event.code;
        } else if (event.type === "complete") {
          streamCompleted = event.status !== "failed";
        }
      }

      if (!finalAnswer || !streamCompleted) throw new Error(streamErrorCode ?? "问答没有返回完整答案");
      if (
        version !== this.qaRequestVersion
        || this.snapshot.activeQaMode !== "current-interaction"
        || this.activeUploadId !== uploadId
        || this.currentPayload !== payload
      ) return null;
      this.cache.appendQaHistory(uploadId, finalAnswer);
      const currentQaHistory = this.cache.readQaHistory(uploadId);
      this.update({
        currentQaState: { status: "complete", answer: finalAnswer },
        currentQaHistory
      });
      return finalAnswer;
    } catch (error) {
      if (isAbortError(error) || version !== this.qaRequestVersion) return null;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return null;
      }
      this.update({
        currentQaState: {
          status: "failed",
          question: normalizedQuestion,
          message: errorMessage(error, "这次提问没有完成")
        }
      });
      return null;
    } finally {
      if (this.qaController === controller) this.qaController = null;
    }
  };

  readonly ask = async (question: string): Promise<QuestionAnswer | null> => {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion || this.snapshot.relationshipState.status !== "ready") return null;
    this.activateQaMode("person");
    this.cancelQa();
    const version = this.qaRequestVersion;
    await this.ensureMemoryBridgeLoaded(true);
    if (version !== this.qaRequestVersion) return null;
    const target = this.currentPersonQaTarget();
    if (!target) {
      const availability = this.personQaAvailability();
      this.update({
        qaState: {
          status: "failed",
          question: normalizedQuestion,
          message: availability.enabled
            ? "人物设置已经变化，请重新确认后再试。"
            : availability.message
        }
      });
      return null;
    }
    const allowedSources = this.personQaSources();

    this.qaController = new AbortController();
    const controller = this.qaController;
    this.update({ qaState: { status: "streaming", question: normalizedQuestion, committedText: "" } });
    const conversation = this.snapshot.qaHistory.slice(-4).flatMap((answer) => [
      { role: "user" as const, content: answer.question },
      { role: "assistant" as const, content: answer.answer }
    ]);
    let finalAnswer: QuestionAnswer | null = null;
    let streamErrorCode: string | null = null;
    let streamCompleted = false;

    try {
      for await (const event of this.api.streamPersonQa({
        personId: target.personId,
        question: normalizedQuestion,
        conversation,
        signal: controller.signal
      })) {
        if (
          version !== this.qaRequestVersion ||
          this.snapshot.activeQaMode !== "person" ||
          this.currentPersonQaTarget()?.historyKey !== target.historyKey
        ) return null;
        if (event.type === "sentence") {
          const currentText = this.snapshot.qaState.status === "streaming" ? this.snapshot.qaState.committedText : "";
          this.update({
            qaState: {
              status: "streaming",
              question: normalizedQuestion,
              committedText: [currentText, event.text].filter(Boolean).join(" ")
            }
          });
        } else if (event.type === "final") {
          if (!personQaCitationSourcesResolve(event.answer, target.personId, allowedSources)) {
            throw new Error("QA final answer contains an unresolved source");
          }
          finalAnswer = event.answer;
        } else if (event.type === "error") {
          streamErrorCode = event.code;
        } else if (event.type === "complete") {
          streamCompleted = event.status !== "failed";
        }
      }

      if (!finalAnswer || !streamCompleted) throw new Error(streamErrorCode ?? "问答没有返回完整答案");
      if (
        version !== this.qaRequestVersion ||
        this.snapshot.activeQaMode !== "person" ||
        this.currentPersonQaTarget()?.historyKey !== target.historyKey
      ) return null;
      const qaHistory = this.appendPersonQaHistory(target, finalAnswer);
      this.update({
        qaState: { status: "complete", answer: finalAnswer },
        qaHistory
      });
      return finalAnswer;
    } catch (error) {
      if (isAbortError(error) || version !== this.qaRequestVersion) return null;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return null;
      }
      if (error instanceof DateCompanionApiError && (error.status === 404 || error.status === 409)) {
        await this.ensureMemoryBridgeLoaded(true);
      }
      this.update({
        qaState: {
          status: "failed",
          question: normalizedQuestion,
          message: error instanceof DateCompanionApiError && (error.status === 404 || error.status === 409)
            ? "人物设置已经变化，请重新确认后再试。"
            : errorMessage(error, "这次提问没有完成")
        }
      });
      return null;
    } finally {
      if (this.qaController === controller) this.qaController = null;
    }
  };

  readonly cancelQa = () => {
    this.qaController?.abort();
    this.qaController = null;
    this.qaRequestVersion += 1;
    if (
      this.snapshot.activeQaMode === "current-interaction"
      && this.snapshot.currentQaState.status === "streaming"
    ) {
      this.update({ currentQaState: { status: "idle" } });
    } else if (this.snapshot.activeQaMode === "person" && this.snapshot.qaState.status === "streaming") {
      this.update({ qaState: { status: "idle" } });
    }
  };

  dispose() {
    this.disposed = true;
    this.initialized = false;
    this.authController?.abort();
    this.cancelUploadWork();
    this.cancelRelationshipWork();
    this.qaController?.abort();
    this.listeners.clear();
  }
}

export function useDateCompanionSession(options: DateCompanionSessionOptions = {}): DateCompanionSessionValue {
  const [controller] = useState(() => new DateCompanionSessionController(options));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    void controller.initialize();
    return () => controller.dispose();
  }, [controller]);

  return {
    ...snapshot,
    login: controller.login,
    register: controller.register,
    clearAuthError: controller.clearAuthError,
    logout: controller.logout,
    upload: controller.upload,
    adoptToyIngestionReceipt: controller.adoptToyIngestionReceipt,
    retryRead: controller.retryRead,
    createRelationship: controller.createRelationship,
    updateParticipants: controller.updateParticipants,
    updateRecap: controller.updateRecap,
    finalizeRecap: controller.finalizeRecap,
    updatePromise: controller.updatePromise,
    searchRelationship: controller.searchRelationship,
    deleteInteraction: controller.deleteInteraction,
    selectCachedInteraction: controller.selectCachedInteraction,
    selectRelationshipInteraction: controller.selectRelationshipInteraction,
    relationshipQaSources: controller.relationshipQaSources,
    personQaSources: controller.personQaSources,
    personQaAvailability: controller.personQaAvailability,
    currentInteractionQaAvailability: controller.currentInteractionQaAvailability,
    activateQaMode: controller.activateQaMode,
    ensureMemoryBridgeLoaded: controller.ensureMemoryBridgeLoaded,
    createConfirmedPerson: controller.createConfirmedPerson,
    savePersonMapping: controller.savePersonMapping,
    setLongTermRetention: controller.setLongTermRetention,
    syncInteractionMemory: controller.syncInteractionMemory,
    purgeRetainedMemory: controller.purgeRetainedMemory,
    ask: controller.ask,
    askCurrentInteraction: controller.askCurrentInteraction,
    cancelQa: controller.cancelQa
  };
}
