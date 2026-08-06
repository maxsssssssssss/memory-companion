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
  type AuthState,
  type DateCompanionMutationState,
  type DateCompanionParticipantRole,
  type DateCompanionRelationshipState,
  type DateCompanionSearchState,
  type DateCompanionVoiceEnrollmentIntent,
  type DateCompanionViewModel,
  type FailedUploadReceipt,
  type QaState,
  type RecapItemVM,
  type UploadReceipt,
  type UploadState
} from "@/lib/domain/date-companion";
import type { DcRelationshipView } from "@/lib/domain/date-companion-stage2";
import type { QuestionAnswer } from "@/lib/domain/types";

import {
  applyDateCompanionRelationshipView,
  buildDateCompanionSearchResults,
  buildDateCompanionViewModel
} from "./date-companion-adapter";
import {
  DateCompanionApiError,
  FailedUploadResponseSchema,
  UploadReceiptSchema,
  createDateCompanionApi,
  isRealDateCompanionUploadId,
  type DateCompanionApi,
  type LoginInput
} from "./date-companion-api";

const ACTIVE_USER_STORAGE_KEY = "daily-brief:active-user-id";
const PERSISTED_SESSION_VERSION = 1;

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
  qaState: QaState;
  qaHistory: QuestionAnswer[];
  relationshipState: DateCompanionRelationshipState;
  mutationState: DateCompanionMutationState;
  searchState: DateCompanionSearchState;
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
};

export type DateCompanionSessionValue = DateCompanionSessionSnapshot & {
  login(input: LoginInput): Promise<void>;
  logout(): Promise<void>;
  upload(file: File, recordingDate: string): Promise<void>;
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
    voiceEnrollmentIntents?: DateCompanionVoiceEnrollmentIntent[]
  ): Promise<void>;
  updatePromise(promiseId: string, version: number, status: "open" | "done"): Promise<void>;
  searchRelationship(query: string): Promise<void>;
  deleteInteraction(interactionId: string): Promise<void>;
  selectCachedInteraction(uploadId: string): boolean;
  selectRelationshipInteraction(interactionId: string | null): boolean;
  ask(question: string): Promise<QuestionAnswer | null>;
  cancelQa(): void;
};

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

function failedUploadReceipt(error: unknown): FailedUploadReceipt | undefined {
  if (!(error instanceof DateCompanionApiError)) return undefined;
  const parsed = FailedUploadResponseSchema.safeParse(error.details);
  return parsed.success
    ? {
        uploadId: parsed.data.uploadId,
        jobId: parsed.data.jobId,
        status: "failed",
        error: parsed.data.error
      }
    : undefined;
}

function processingStatus(payload: DayPayload): Exclude<UploadState, { status: "idle" | "uploading" | "ready" | "failed" }>[
  "jobStatus"
] | null {
  const status = payload.job?.status ?? payload.upload.status;
  return status === "ready" || status === "failed" ? null : status;
}

function qaCitationSourcesResolve(answer: QuestionAnswer, payload: DayPayload): boolean {
  const knownSegmentIds = new Set(payload.segments.map((segment) => segment.id));
  return (answer.citations ?? []).every((citation) =>
    citation.sourceSegmentIds.every((segmentId) => knownSegmentIds.has(segmentId))
  );
}

export class DateCompanionSessionController {
  private readonly api: DateCompanionApi;
  private readonly cache: DateCompanionCache;
  private readonly storage: Storage;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<() => void>();
  private snapshot: DateCompanionSessionSnapshot = {
    auth: { status: "checking" },
    viewModel: emptyDateCompanionViewModel(),
    uploadState: { status: "idle" },
    qaState: { status: "idle" },
    qaHistory: [],
    relationshipState: { status: "idle" },
    mutationState: { status: "idle" },
    searchState: { status: "idle" }
  };
  private authController: AbortController | null = null;
  private uploadController: AbortController | null = null;
  private pollController: AbortController | null = null;
  private qaController: AbortController | null = null;
  private relationshipController: AbortController | null = null;
  private mutationController: AbortController | null = null;
  private searchController: AbortController | null = null;
  private activeUploadId: string | null = null;
  private currentPayload: DayPayload | null = null;
  private relationshipView: DcRelationshipView | null = null;
  private selectedRelationshipInteractionId: string | null = null;
  private uploadRequestVersion = 0;
  private qaRequestVersion = 0;
  private relationshipRequestVersion = 0;
  private mutationRequestVersion = 0;
  private searchRequestVersion = 0;
  private initialized = false;
  private disposed = false;

  constructor(options: DateCompanionSessionOptions = {}) {
    this.api = options.api ?? createDateCompanionApi();
    this.cache = options.cache ?? defaultCache;
    this.storage = currentStorage(options.storage);
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 1_200);
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
    this.relationshipRequestVersion += 1;
    this.mutationRequestVersion += 1;
    this.searchRequestVersion += 1;
  }

  private refreshViewModel() {
    const current = this.currentPayload
      ? buildDateCompanionViewModel(this.currentPayload)
      : emptyDateCompanionViewModel();
    const viewModel = this.relationshipView
      ? applyDateCompanionRelationshipView(current, this.relationshipView, {
          hasLocalDay: (uploadId) => this.localPayload(uploadId) !== null,
          getLocalDay: (uploadId) => this.localPayload(uploadId),
          selectedInteractionId: this.selectedRelationshipInteractionId
        })
      : current;
    this.update({ viewModel });
  }

  private applyRelationshipView(view: DcRelationshipView) {
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
      qaState: { status: "idle" },
      qaHistory: [],
      relationshipState: { status: "idle" },
      mutationState: { status: "idle" },
      searchState: { status: "idle" }
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

  private authenticatedUserId(): string | null {
    return this.snapshot.auth.status === "authenticated" ? this.snapshot.auth.user.id : null;
  }

  private cancelUploadWork() {
    this.uploadController?.abort();
    this.uploadController = null;
    this.pollController?.abort();
    this.pollController = null;
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
    this.update({ qaHistory: this.cache.readQaHistory(payload.upload.id) });
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
    version: number
  ): Promise<void> {
    const uploadId = payload.upload.id;
    if (!this.isCurrentUpload(version, uploadId)) return;
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

    await this.finishCachedPayload(payload, receipt, failedReceipt, version, this.pollController?.signal);
  }

  private async finishCachedPayload(
    payload: DayPayload,
    receipt: UploadReceipt | undefined,
    failedReceipt: FailedUploadReceipt | undefined,
    version: number,
    signal?: AbortSignal,
    forceCleanup = false
  ): Promise<void> {
    const uploadId = payload.upload.id;
    if (!this.isCurrentUpload(version, uploadId)) return;
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
        if (!this.isCurrentUpload(version, uploadId)) return;
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
        if (!this.isCurrentUpload(version, uploadId) || isAbortError(error)) return;
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
          this.update({ uploadState: { status: "idle" }, qaState: { status: "idle" }, qaHistory: [] });
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
      if (!this.isCurrentUpload(version, uploadId)) return;
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
      if (!this.isCurrentUpload(version, uploadId)) return;
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
    forceCleanup = true
  ): Promise<boolean> {
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
        forceCleanup
      );
    } finally {
      if (this.pollController === controller) this.pollController = null;
    }
    return true;
  }

  private async pollUpload(
    receipt: UploadReceipt | undefined,
    uploadId: string,
    version: number,
    failedReceipt?: FailedUploadReceipt
  ): Promise<void> {
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
          this.update({ uploadState: { status: "idle" }, qaState: { status: "idle" }, qaHistory: [] });
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
      const persisted = this.readPersistedSession(user.id);
      if (persisted && isRealDateCompanionUploadId(persisted.currentUploadId)) {
        this.activeUploadId = persisted.currentUploadId;
        const version = this.nextUploadVersion();
        if (
          await this.resumeCachedPayload(
            persisted.currentUploadId,
            persisted.receipt,
            persisted.failedReceipt,
            version,
            persisted.cleanupConfirmed !== true
          )
        ) return;
        await this.pollUpload(persisted.receipt, persisted.currentUploadId, version, persisted.failedReceipt);
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
      this.update({ auth: { status: "error", message: errorMessage(error, "无法确认登录状态") } });
    } finally {
      if (this.authController === controller) this.authController = null;
    }
  }

  readonly login = async (input: LoginInput): Promise<void> => {
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
    this.authController = new AbortController();
    this.update({
      auth: { status: "checking" },
      viewModel: emptyDateCompanionViewModel(),
      uploadState: { status: "idle" },
      qaState: { status: "idle" },
      qaHistory: [],
      relationshipState: { status: "idle" },
      mutationState: { status: "idle" },
      searchState: { status: "idle" }
    });
    try {
      const user = await this.api.login(input, this.authController.signal);
      this.setActiveUser(user.id);
      this.update({ auth: { status: "authenticated", user } });
      await this.loadRelationship();
      if (this.snapshot.auth.status !== "authenticated") return;
      const persisted = this.readPersistedSession(user.id);
      if (persisted && isRealDateCompanionUploadId(persisted.currentUploadId)) {
        this.activeUploadId = persisted.currentUploadId;
        const version = this.nextUploadVersion();
        if (
          await this.resumeCachedPayload(
            persisted.currentUploadId,
            persisted.receipt,
            persisted.failedReceipt,
            version,
            persisted.cleanupConfirmed !== true
          )
        ) return;
        await this.pollUpload(persisted.receipt, persisted.currentUploadId, version, persisted.failedReceipt);
      } else if (
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
      if (error instanceof DateCompanionApiError && error.status === 401) this.setActiveUser(null);
      this.update({ auth: { status: "error", message: errorMessage(error, "登录失败") } });
    } finally {
      this.authController = null;
    }
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
        qaState: { status: "idle" },
        qaHistory: [],
        relationshipState: { status: "idle" },
        mutationState: { status: "idle" },
        searchState: { status: "idle" }
      });
    } catch (error) {
      this.setActiveUser(null);
      this.update({
        auth: { status: "error", message: errorMessage(error, "退出登录失败") },
        viewModel: emptyDateCompanionViewModel(),
        uploadState: { status: "idle" },
        qaState: { status: "idle" },
        qaHistory: [],
        relationshipState: { status: "idle" },
        mutationState: { status: "idle" },
        searchState: { status: "idle" }
      });
    }
  };

  readonly upload = async (file: File, recordingDate: string): Promise<void> => {
    const userId = this.authenticatedUserId();
    if (!userId) {
      this.update({
        uploadState: { status: "failed", message: "请先登录", failureStage: "upload" }
      });
      return;
    }
    if (this.snapshot.relationshipState.status !== "ready" || !this.relationshipView) {
      this.update({
        uploadState: {
          status: "failed",
          message: "请先由你明确建立这段关系，再上传相处录音。",
          failureStage: "upload"
        }
      });
      return;
    }

    const version = this.nextUploadVersion();
    this.uploadController = new AbortController();
    const controller = this.uploadController;
    this.currentPayload = null;
    this.activeUploadId = null;
    this.refreshViewModel();
    this.update({
      uploadState: { status: "uploading", fileName: file.name, recordingDate },
      qaState: { status: "idle" },
      qaHistory: []
    });

    try {
      const receipt = await this.api.upload(file, recordingDate, controller.signal);
      if (version !== this.uploadRequestVersion || this.disposed) return;
      this.activeUploadId = receipt.uploadId;
      this.persistSession(userId, {
        currentUploadId: receipt.uploadId,
        receipt
      });
      await this.pollUpload(receipt, receipt.uploadId, version);
    } catch (error) {
      if (isAbortError(error) || version !== this.uploadRequestVersion) return;
      if (error instanceof DateCompanionApiError && error.status === 401) {
        this.expireAuthentication();
        return;
      }
      const failedReceipt = failedUploadReceipt(error);
      if (failedReceipt) {
        this.activeUploadId = failedReceipt.uploadId;
        this.persistSession(userId, {
          currentUploadId: failedReceipt.uploadId,
          failedReceipt
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
  };

  readonly retryRead = async (): Promise<void> => {
    const uploadId = this.activeUploadId;
    if (!uploadId || !isRealDateCompanionUploadId(uploadId)) return;
    const receipt =
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
    const version = this.nextUploadVersion();
    if (await this.resumeCachedPayload(uploadId, receipt, failedReceipt, version, forceCleanup)) return;
    await this.pollUpload(receipt, uploadId, version, failedReceipt);
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
    voiceEnrollmentIntents: DateCompanionVoiceEnrollmentIntent[] = []
  ): Promise<void> => {
    await this.runRelationshipMutation("finalize", (signal) =>
      this.api.updateRecap(interactionId, {
        version,
        assignments,
        items,
        ...(voiceEnrollmentIntents.length > 0 ? { voiceEnrollmentIntents } : {}),
        finalize: true
      }, signal)
    );
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
            { hasLocalDay: (uploadId) => this.currentPayload?.upload.id === uploadId || this.cachedPayload(uploadId) !== null }
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
        this.update({ uploadState: { status: "idle" }, qaState: { status: "idle" }, qaHistory: [] });
        const userId = this.authenticatedUserId();
        if (userId) this.clearPersistedUpload(userId, interaction.sourceUploadId);
      }
      return this.api.getRelationshipView(relationshipId, signal);
    });
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

  readonly ask = async (question: string): Promise<QuestionAnswer | null> => {
    const normalizedQuestion = question.trim();
    const payload = this.currentPayload;
    const uploadId = this.activeUploadId;
    if (!normalizedQuestion || !payload || !uploadId || !isRealDateCompanionUploadId(uploadId)) return null;
    if ((payload.job?.status ?? payload.upload.status) !== "ready") return null;

    this.cancelQa();
    this.qaRequestVersion += 1;
    const version = this.qaRequestVersion;
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
        if (version !== this.qaRequestVersion || this.activeUploadId !== uploadId) return null;
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
          if (event.answer.uploadId !== uploadId) {
            throw new Error("QA final answer belongs to another upload");
          }
          if (!qaCitationSourcesResolve(event.answer, payload)) {
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
      if (version !== this.qaRequestVersion || this.activeUploadId !== uploadId) return null;
      this.cache.appendQaHistory(uploadId, finalAnswer);
      const qaHistory = this.cache.readQaHistory(uploadId);
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
      this.update({
        qaState: {
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

  readonly cancelQa = () => {
    this.qaController?.abort();
    this.qaController = null;
    this.qaRequestVersion += 1;
    if (this.snapshot.qaState.status === "streaming") {
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
    logout: controller.logout,
    upload: controller.upload,
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
    ask: controller.ask,
    cancelQa: controller.cancelQa
  };
}
