"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createReflectionRecordingStorage,
  type ReflectionRecordingBackup,
  type ReflectionRecordingStorage
} from "./daily-reflection-recording-storage";

import type { AuthState } from "@/lib/domain/date-companion";
import type {
  DailyReflectionCardDecision,
  DailyReflectionCandidateDecision,
  DailyReflectionDetailResponse,
  DailyReflectionHistoryItem,
  DailyReflectionOperationUploadState,
  DailyReflectionUploadFailure
} from "@/lib/domain/daily-reflection-api";
import type {
  DailyReflectionStatus,
  DailyReflectionV2Input
} from "@/lib/domain/daily-reflection";
import type {
  DailyReflectionWorkingCardMemoryLifecycleStatus,
  DailyReflectionWorkingCardStatus
} from "@/lib/domain/daily-reflection-working-card";

import {
  DailyReflectionApiError,
  DailyReflectionOperationReceiptSchema,
  createDailyReflectionApi,
  reflectionUploadFailureMessage,
  type DailyReflectionApi,
  type DailyReflectionManualCandidateInput,
  type DailyReflectionUploadReceipt
} from "./daily-reflection-api";

export type DailyReflectionUploadSource = DailyReflectionV2Input["sourceOrigin"];
export type DailyReflectionSaveIntent = "recap_only" | "retain_selected";
export type DailyReflectionManualCandidateDraft = Omit<
  DailyReflectionManualCandidateInput,
  "expectedVersion"
>;

export type DailyReflectionSessionState =
  | "idle"
  | "loading"
  | "error"
  | DailyReflectionStatus;

export type DailyReflectionSessionOperation =
  | "idle"
  | "uploading"
  | "loading"
  | "retrying"
  | "cancelling"
  | "deleting"
  | "saving_candidate"
  | "saving_working_card"
  | "creating_candidate"
  | "excluding_candidate"
  | "finalizing"
  | "revoking_candidate";

export type DailyReflectionUploadOptions = Readonly<{
  operationKey?: string;
  inputAdapter?: DailyReflectionV2Input["inputAdapter"];
}>;

export type DailyReflectionHistoryState = "idle" | "loading" | "ready" | "error";

export type ReflectionRecordingRecovery = Omit<ReflectionRecordingBackup, "file"> & {
  file: File | null;
  reflectionId: string | null;
  phase: "draft" | "uploading" | "interrupted" | "checking" | "persisting" | "saved";
  localCopy: "saving" | "saved" | "unavailable";
  errorMessage: string | null;
  uploadState?: DailyReflectionOperationUploadState;
  uploadFailure?: DailyReflectionUploadFailure | null;
  uploadErrorMessage?: string | null;
  contentHash?: string;
};

export type DailyReflectionSessionSnapshot = {
  auth: AuthState;
  state: DailyReflectionSessionState;
  operation: DailyReflectionSessionOperation;
  reflectionId: string | null;
  detail: DailyReflectionDetailResponse | null;
  selectedFile: File | null;
  sourceOrigin: DailyReflectionUploadSource | null;
  recordingDate: string;
  operationReceipt: DailyReflectionUploadReceipt | null;
  history: DailyReflectionHistoryItem[];
  historyState: DailyReflectionHistoryState;
  historyErrorMessage: string | null;
  activeCandidateId: string | null;
  workingCardStates: Readonly<Record<string, Readonly<{
    status: DailyReflectionWorkingCardStatus;
    memoryLifecycleStatus?: DailyReflectionWorkingCardMemoryLifecycleStatus;
    version: number;
  }>>>;
  errorMessage: string | null;
  recordingRecovery: ReflectionRecordingRecovery | null;
};

export type DailyReflectionSessionOptions = {
  api?: DailyReflectionApi;
  pollIntervalMs?: number;
  createIdempotencyKey?: () => string;
  createRevocationIdempotencyKey?: () => string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  onReflectionIdChange?: (reflectionId: string | null) => void;
  recordingStorage?: ReflectionRecordingStorage;
};

export type UseDailyReflectionSessionOptions = DailyReflectionSessionOptions & {
  initialReflectionId?: string | null;
  retainAcrossNavigation?: boolean;
};

export type DailyReflectionSessionValue = DailyReflectionSessionSnapshot & {
  initialize(initialReflectionId?: string | null): Promise<void>;
  setSelectedFile(file: File | null): void;
  setSourceOrigin(sourceOrigin: DailyReflectionUploadSource | null): void;
  setRecordingDate(recordingDate: string): void;
  upload(
    file: File,
    sourceOrigin: DailyReflectionUploadSource,
    recordingDate: string,
    options?: DailyReflectionUploadOptions
  ): Promise<boolean>;
  uploadBrowserRecording(
    file: File,
    clientReportedDurationMs: number | undefined,
    recordingDate: string,
    operationKey: string,
    sourceOrigin?: DailyReflectionUploadSource
  ): Promise<void>;
  reload(reflectionId?: string | null): Promise<void>;
  refreshHistory(): Promise<void>;
  startNew(): void;
  resumeRecording(): Promise<void>;
  retryRecordingUpload(): Promise<void>;
  preserveRecording(backup: Omit<ReflectionRecordingBackup, "accountId">): Promise<void>;
  setRecordingRecoverySource(source: DailyReflectionUploadSource): Promise<void>;
  setRecordingRecoveryFile(file: File): Promise<void>;
  cancelRecordingUpload(): Promise<void>;
  discardRecordingDraft(): Promise<void>;
  updateCandidate(decision: DailyReflectionCandidateDecision): Promise<void>;
  updateCandidates(decisions: readonly DailyReflectionCandidateDecision[]): Promise<void>;
  updateCard(decision: DailyReflectionCardDecision): Promise<void>;
  updateCards(decisions: readonly DailyReflectionCardDecision[]): Promise<void>;
  saveWorkingCard(
    cardId: string,
    draft?: Pick<DailyReflectionCardDecision, "userTitle" | "userText">
  ): Promise<boolean>;
  archiveWorkingCard(cardId: string): Promise<void>;
  restoreWorkingCard(cardId: string): Promise<void>;
  removeWorkingCard(cardId: string): Promise<void>;
  acceptAllCandidates(): Promise<void>;
  createManualCandidate(candidate: DailyReflectionManualCandidateDraft): Promise<void>;
  excludeCandidate(candidateId: string): Promise<void>;
  finalize(saveIntent: DailyReflectionSaveIntent): Promise<void>;
  revokeCandidate(candidateId: string): Promise<void>;
  retry(): Promise<void>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
  logout(): Promise<void>;
  dispose(): void;
};

const INITIAL_SNAPSHOT: DailyReflectionSessionSnapshot = {
  auth: { status: "checking" },
  state: "idle",
  operation: "idle",
  reflectionId: null,
  detail: null,
  selectedFile: null,
  sourceOrigin: null,
  recordingDate: "",
  operationReceipt: null,
  history: [],
  historyState: "idle",
  historyErrorMessage: null,
  activeCandidateId: null,
  workingCardStates: {},
  errorMessage: null,
  recordingRecovery: null
};

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError")
  );
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof DailyReflectionApiError && error.status === 401;
}

function friendlyError(error: unknown, fallback: string): string {
  return error instanceof DailyReflectionApiError ? error.message : fallback;
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldKeepPolling(status: DailyReflectionStatus): boolean {
  return status === "created"
    || status === "uploading"
    || status === "transcribing"
    || status === "extracting"
    || status === "confirmation_ready"
    || status === "admitting";
}

function normalizeReflectionId(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim() ?? "";
  return normalized || null;
}

function defaultIdempotencyKey(): string {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `daily-reflection-${id}`;
}

function defaultRevocationIdempotencyKey(): string {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `daily-reflection-revoke-${id}`;
}

type FinalizeAttempt = Readonly<{
  reflectionId: string;
  accountId: string;
  expectedVersion: number;
  operationKey: string;
  saveIntent: DailyReflectionSaveIntent;
}>;

type RevocationAttempt = Readonly<{
  reflectionId: string;
  candidateId: string;
  accountId: string;
  expectedVersion: number;
  idempotencyKey: string;
}>;

type PendingInputOperation = Readonly<{
  accountId: string;
  operationKey: string;
  inputAdapter: DailyReflectionV2Input["inputAdapter"];
  sourceOrigin: DailyReflectionV2Input["sourceOrigin"];
  recordingDate: string;
  reflectionId?: string;
}>;

const FINALIZE_ATTEMPT_STORAGE_PREFIX = "daily-reflection:finalize:v2";
const OPERATION_RECEIPT_STORAGE_PREFIX = "daily-reflection:operation-receipt:v2";
const PENDING_INPUT_OPERATION_STORAGE_PREFIX = "daily-reflection:pending-input:v2";
const REVOCATION_ATTEMPT_STORAGE_PREFIX = "daily-reflection:revoke:v1";
const STALE_MESSAGE = "这份复盘已经在其他页面更新，请重新加载最新内容。";

function finalizeAttemptStorageKey(accountId: string, reflectionId: string): string {
  return `${FINALIZE_ATTEMPT_STORAGE_PREFIX}:${encodeURIComponent(accountId)}:${encodeURIComponent(reflectionId)}`;
}

function operationReceiptStorageKey(accountId: string, reflectionId: string): string {
  return `${OPERATION_RECEIPT_STORAGE_PREFIX}:${encodeURIComponent(accountId)}:${encodeURIComponent(reflectionId)}`;
}

function pendingInputOperationStorageKey(accountId: string): string {
  return `${PENDING_INPUT_OPERATION_STORAGE_PREFIX}:${encodeURIComponent(accountId)}`;
}

function parsePendingInputOperation(value: string | null): PendingInputOperation | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PendingInputOperation>;
    if (
      typeof parsed.accountId !== "string"
      || typeof parsed.operationKey !== "string"
      || !parsed.operationKey.trim()
      || !["file_picker", "browser_recorder", "toy_sync"].includes(parsed.inputAdapter ?? "")
      || !["user_reflection", "direct_conversation"].includes(parsed.sourceOrigin ?? "")
      || typeof parsed.recordingDate !== "string"
    ) return null;
    return parsed as PendingInputOperation;
  } catch {
    return null;
  }
}

function parseFinalizeAttempt(value: string | null): FinalizeAttempt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<FinalizeAttempt>;
    if (
      typeof parsed.reflectionId !== "string"
      || typeof parsed.accountId !== "string"
      || !Number.isInteger(parsed.expectedVersion)
      || (parsed.expectedVersion ?? -1) < 0
      || typeof parsed.operationKey !== "string"
      || !parsed.operationKey.trim()
      || (parsed.saveIntent !== "recap_only" && parsed.saveIntent !== "retain_selected")
    ) return null;
    return parsed as FinalizeAttempt;
  } catch {
    return null;
  }
}

function revocationAttemptStorageKey(
  accountId: string,
  reflectionId: string,
  candidateId: string
): string {
  return `${REVOCATION_ATTEMPT_STORAGE_PREFIX}:${encodeURIComponent(accountId)}:${encodeURIComponent(reflectionId)}:${encodeURIComponent(candidateId)}`;
}

function parseRevocationAttempt(value: string | null): RevocationAttempt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RevocationAttempt>;
    if (
      typeof parsed.reflectionId !== "string"
      || typeof parsed.candidateId !== "string"
      || typeof parsed.accountId !== "string"
      || !Number.isInteger(parsed.expectedVersion)
      || (parsed.expectedVersion ?? -1) < 0
      || typeof parsed.idempotencyKey !== "string"
      || !parsed.idempotencyKey.trim()
    ) return null;
    return parsed as RevocationAttempt;
  } catch {
    return null;
  }
}

export class DailyReflectionSessionController {
  private readonly releasedRecordingOperations = new Set<string>();
  private readonly api: DailyReflectionApi;
  private readonly pollIntervalMs: number;
  private readonly createIdempotencyKey: () => string;
  private readonly createRevocationIdempotencyKey: () => string;
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  private pendingInputOperation: PendingInputOperation | null = null;
  private readonly onReflectionIdChange?: (reflectionId: string | null) => void;
  private readonly listeners = new Set<() => void>();
  private snapshot: DailyReflectionSessionSnapshot = { ...INITIAL_SNAPSHOT };
  private authController: AbortController | null = null;
  private workController: AbortController | null = null;
  private historyController: AbortController | null = null;
  private authGeneration = 0;
  private workGeneration = 0;
  private historyGeneration = 0;
  private finalizeAttempt: FinalizeAttempt | null = null;
  private revocationAttempt: RevocationAttempt | null = null;
  private disposed = false;
  private uploadController: AbortController | null = null;
  private recordingCheckController: AbortController | null = null;
  private readonly recordingStorage: ReflectionRecordingStorage;

  constructor(options: DailyReflectionSessionOptions = {}) {
    this.api = options.api ?? createDailyReflectionApi();
    this.recordingStorage = options.recordingStorage ?? createReflectionRecordingStorage();
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 1_200);
    this.createIdempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
    this.createRevocationIdempotencyKey = options.createRevocationIdempotencyKey
      ?? defaultRevocationIdempotencyKey;
    let browserStorage: Storage | null = null;
    try { browserStorage = typeof window === "undefined" ? null : window.localStorage; } catch { /* Restricted browser storage. */ }
    this.storage = options.storage === undefined ? browserStorage : options.storage;
    this.onReflectionIdChange = options.onReflectionIdChange;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): DailyReflectionSessionSnapshot => this.snapshot;

  private update(next: Partial<DailyReflectionSessionSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private updateReflectionId(reflectionId: string | null) {
    if (this.disposed || reflectionId === this.snapshot.reflectionId) return;
    this.snapshot = { ...this.snapshot, reflectionId };
    for (const listener of this.listeners) listener();
    this.onReflectionIdChange?.(reflectionId);
  }

  private resetWorkflow(resetForm: boolean, clearAccountData = true) {
    if (this.disposed) return;
    const changed = this.snapshot.reflectionId !== null;
    this.snapshot = {
      ...this.snapshot,
      state: "idle",
      operation: "idle",
      reflectionId: null,
      detail: null,
      operationReceipt: null,
      ...(clearAccountData
        ? {
            history: [],
            historyState: "idle" as const,
            historyErrorMessage: null
          }
        : {}),
      activeCandidateId: null,
      workingCardStates: {},
      errorMessage: null,
      ...(resetForm
        ? { selectedFile: null, sourceOrigin: null, recordingDate: "" }
        : {})
    };
    for (const listener of this.listeners) listener();
    if (changed) this.onReflectionIdChange?.(null);
  }

  private abortAuthentication() {
    this.abortRecordingCheck();
    this.authController?.abort();
    this.authController = null;
    this.authGeneration += 1;
  }

  private abortRecordingCheck() {
    this.recordingCheckController?.abort();
    this.recordingCheckController = null;
  }

  private abortWork() {
    this.workController?.abort();
    this.workController = null;
    this.workGeneration += 1;
  }

  private abortHistory() {
    this.historyController?.abort();
    this.historyController = null;
    this.historyGeneration += 1;
  }

  private beginAuthentication(): {
    controller: AbortController;
    generation: number;
  } {
    this.abortAuthentication();
    this.abortWork();
    this.abortHistory();
    const controller = new AbortController();
    const generation = this.authGeneration;
    this.authController = controller;
    return { controller, generation };
  }

  private beginWork(): { controller: AbortController; generation: number } {
    this.abortWork();
    const controller = new AbortController();
    const generation = this.workGeneration;
    this.workController = controller;
    return { controller, generation };
  }

  private beginHistory(): { controller: AbortController; generation: number } {
    this.abortHistory();
    const controller = new AbortController();
    const generation = this.historyGeneration;
    this.historyController = controller;
    return { controller, generation };
  }

  private isCurrentAuth(controller: AbortController, generation: number): boolean {
    return !this.disposed
      && this.authController === controller
      && this.authGeneration === generation
      && !controller.signal.aborted;
  }

  private isCurrentWork(controller: AbortController, generation: number): boolean {
    return !this.disposed
      && this.workController === controller
      && this.workGeneration === generation
      && !controller.signal.aborted;
  }

  private isCurrentHistory(controller: AbortController, generation: number): boolean {
    return !this.disposed
      && this.historyController === controller
      && this.historyGeneration === generation
      && !controller.signal.aborted;
  }

  private expireAuthentication() {
    this.uploadController?.abort();
    this.uploadController = null;
    this.abortAuthentication();
    this.abortWork();
    this.abortHistory();
    this.resetWorkflow(true);
    this.update({ auth: { status: "anonymous" }, recordingRecovery: null });
  }

  private authenticatedAccountId(): string | null {
    return this.snapshot.auth.status === "authenticated"
      ? this.snapshot.auth.user.id
      : null;
  }

  private readOperationReceipt(reflectionId: string): DailyReflectionUploadReceipt | null {
    const accountId = this.authenticatedAccountId();
    if (this.snapshot.operationReceipt?.reflectionId === reflectionId) {
      return this.snapshot.operationReceipt;
    }
    if (!accountId || !this.storage) return null;
    const key = operationReceiptStorageKey(accountId, reflectionId);
    try {
      const parsed = DailyReflectionOperationReceiptSchema.safeParse(
        JSON.parse(this.storage.getItem(key) ?? "null")
      );
      if (!parsed.success || parsed.data.reflectionId !== reflectionId) {
        this.storage.removeItem(key);
        return null;
      }
      return parsed.data;
    } catch {
      try {
        this.storage.removeItem(key);
      } catch {
        // Storage availability must not alter server truth.
      }
      return null;
    }
  }

  private writeOperationReceipt(receipt: DailyReflectionUploadReceipt) {
    const accountId = this.authenticatedAccountId();
    if (!accountId) return;
    this.update({ operationReceipt: receipt });
    if (!this.storage) return;
    try {
      this.storage.setItem(
        operationReceiptStorageKey(accountId, receipt.reflectionId),
        JSON.stringify(receipt)
      );
    } catch {
      // The in-memory receipt still keeps this tab recoverable.
    }
  }

  private clearOperationReceipt(reflectionId: string) {
    const accountId = this.authenticatedAccountId();
    if (this.snapshot.operationReceipt?.reflectionId === reflectionId) {
      this.update({ operationReceipt: null });
    }
    if (!accountId || !this.storage) return;
    try {
      this.storage.removeItem(operationReceiptStorageKey(accountId, reflectionId));
    } catch {
      // Storage availability must not alter server truth.
    }
  }

  private readPendingInputOperation(): PendingInputOperation | null {
    const accountId = this.authenticatedAccountId();
    if (!accountId) return null;
    if (this.pendingInputOperation?.accountId === accountId) {
      return this.pendingInputOperation;
    }
    if (!this.storage) return null;
    const key = pendingInputOperationStorageKey(accountId);
    try {
      const pending = parsePendingInputOperation(this.storage.getItem(key));
      if (!pending || pending.accountId !== accountId) {
        this.storage.removeItem(key);
        return null;
      }
      this.pendingInputOperation = pending;
      return pending;
    } catch {
      return null;
    }
  }

  private writePendingInputOperation(operation: PendingInputOperation) {
    this.pendingInputOperation = operation;
    if (!this.storage) return;
    try {
      this.storage.setItem(
        pendingInputOperationStorageKey(operation.accountId),
        JSON.stringify(operation)
      );
    } catch {
      // Server receipt lookup still protects this live tab.
    }
  }

  private clearPendingInputOperation() {
    const accountId = this.authenticatedAccountId();
    this.pendingInputOperation = null;
    if (!accountId || !this.storage) return;
    try {
      this.storage.removeItem(pendingInputOperationStorageKey(accountId));
    } catch {
      // Storage availability must not alter server truth.
    }
  }

  private async lookupPendingInputOperation(signal?: AbortSignal): Promise<string | null> {
    const pending = this.readPendingInputOperation();
    if (!pending) return null;
    const result = await this.api.getOperation(pending.operationKey, signal);
    if (signal?.aborted || this.authenticatedAccountId() !== pending.accountId) return null;
    if (!result.found) {
      this.clearPendingInputOperation();
      return null;
    }
    if (pending.reflectionId && pending.reflectionId !== result.reflectionId) return null;
    if (result.uploadState === "terminated" || result.status === "deleted" || result.status === "cancelled") {
      this.clearPendingInputOperation();
      this.update({
        state: result.status === "deleted" ? "deleted" : "cancelled",
        operation: "idle",
        errorMessage: result.status === "deleted"
          ? "这次上传对应的复盘已删除，不会重新创建。"
          : "这次上传对应的复盘已取消，不会重新创建。"
      });
      return null;
    }
    this.writePendingInputOperation({ ...pending, reflectionId: result.reflectionId });
    if (pending.inputAdapter !== "toy_sync" && !this.snapshot.recordingRecovery && result.uploadState !== "accepted") {
      this.update({ recordingRecovery: { accountId: pending.accountId, operationKey: pending.operationKey,
        inputAdapter: pending.inputAdapter, sourceOrigin: pending.sourceOrigin, recordingDate: pending.recordingDate,
        file: null, submitted: true, localCopy: "unavailable", reflectionId: result.reflectionId, contentHash: result.contentHash,
        phase: result.uploadState === "still_persisting" ? "persisting" : "interrupted", uploadState: result.uploadState,
        uploadFailure: result.uploadFailure ?? null, uploadErrorMessage: result.uploadFailure ? reflectionUploadFailureMessage(result.uploadFailure) : null,
        errorMessage: null } });
    }
    return result.reflectionId;
  }

  private readFinalizeAttempt(reflectionId: string): FinalizeAttempt | null {
    const accountId = this.authenticatedAccountId();
    if (!accountId) return null;
    if (
      this.finalizeAttempt?.accountId === accountId
      && this.finalizeAttempt.reflectionId === reflectionId
    ) return this.finalizeAttempt;
    if (!this.storage) return null;
    const key = finalizeAttemptStorageKey(accountId, reflectionId);
    try {
      const attempt = parseFinalizeAttempt(this.storage.getItem(key));
      if (!attempt || attempt.accountId !== accountId || attempt.reflectionId !== reflectionId) {
        this.storage.removeItem(key);
        return null;
      }
      this.finalizeAttempt = attempt;
      return attempt;
    } catch {
      return null;
    }
  }

  private writeFinalizeAttempt(attempt: FinalizeAttempt) {
    this.finalizeAttempt = attempt;
    if (!this.storage) return;
    try {
      this.storage.setItem(
        finalizeAttemptStorageKey(attempt.accountId, attempt.reflectionId),
        JSON.stringify(attempt)
      );
    } catch {
      // Session-local retry still uses the same request while the controller lives.
    }
  }

  private clearFinalizeAttempt(reflectionId: string) {
    const accountId = this.authenticatedAccountId();
    if (!accountId) return;
    if (this.finalizeAttempt?.reflectionId === reflectionId) this.finalizeAttempt = null;
    if (!this.storage) return;
    try {
      this.storage.removeItem(finalizeAttemptStorageKey(accountId, reflectionId));
    } catch {
      // Storage availability must not alter server truth.
    }
  }

  private readRevocationAttempt(
    reflectionId: string,
    candidateId: string
  ): RevocationAttempt | null {
    const accountId = this.authenticatedAccountId();
    if (!accountId) return null;
    if (
      this.revocationAttempt?.accountId === accountId
      && this.revocationAttempt.reflectionId === reflectionId
      && this.revocationAttempt.candidateId === candidateId
    ) return this.revocationAttempt;
    if (!this.storage) return null;
    const key = revocationAttemptStorageKey(accountId, reflectionId, candidateId);
    try {
      const attempt = parseRevocationAttempt(this.storage.getItem(key));
      if (
        !attempt
        || attempt.accountId !== accountId
        || attempt.reflectionId !== reflectionId
        || attempt.candidateId !== candidateId
      ) {
        this.storage.removeItem(key);
        return null;
      }
      this.revocationAttempt = attempt;
      return attempt;
    } catch {
      return null;
    }
  }

  private writeRevocationAttempt(attempt: RevocationAttempt) {
    this.revocationAttempt = attempt;
    if (!this.storage) return;
    try {
      this.storage.setItem(
        revocationAttemptStorageKey(
          attempt.accountId,
          attempt.reflectionId,
          attempt.candidateId
        ),
        JSON.stringify(attempt)
      );
    } catch {
      // Session-local retry still uses the same request while the controller lives.
    }
  }

  private clearRevocationAttempt(reflectionId: string, candidateId: string) {
    const accountId = this.authenticatedAccountId();
    if (!accountId) return;
    if (
      this.revocationAttempt?.reflectionId === reflectionId
      && this.revocationAttempt.candidateId === candidateId
    ) this.revocationAttempt = null;
    if (!this.storage) return;
    try {
      this.storage.removeItem(revocationAttemptStorageKey(accountId, reflectionId, candidateId));
    } catch {
      // Storage availability must not alter server truth.
    }
  }

  private reconcileFinalizeAttempt(detail: DailyReflectionDetailResponse) {
    const attempt = this.readFinalizeAttempt(detail.reflection.id);
    if (!attempt) return;
    if (
      detail.confirmation
      && "contractVersion" in detail.confirmation
      && detail.confirmation.operationKey === attempt.operationKey
      && detail.confirmation.saveIntent === attempt.saveIntent
    ) {
      if (detail.reflection.status === "completed") {
        this.clearFinalizeAttempt(detail.reflection.id);
      }
      return;
    }
    if (
      detail.reflection.status !== "review_pending"
      || detail.reflection.version !== attempt.expectedVersion
    ) {
      this.clearFinalizeAttempt(detail.reflection.id);
    }
  }

  readonly refreshHistory = async (): Promise<void> => {
    if (this.snapshot.auth.status !== "authenticated") return;
    const { controller, generation } = this.beginHistory();
    this.update({ historyState: "loading", historyErrorMessage: null });
    try {
      const history = await this.api.list(controller.signal);
      if (!this.isCurrentHistory(controller, generation)) return;
      this.update({ history, historyState: "ready", historyErrorMessage: null });
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentHistory(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      this.update({
        historyState: "error",
        historyErrorMessage: friendlyError(error, "最近复盘暂时没有读取成功，请稍后重试。")
      });
    } finally {
      if (this.historyController === controller) this.historyController = null;
    }
  };

  private applyDetail(detail: DailyReflectionDetailResponse) {
    if ((detail.reflection.status === "deleted" || detail.reflection.status === "cancelled")
      && this.snapshot.recordingRecovery?.reflectionId === detail.reflection.id) {
      void this.stopRecordingRecovery(detail.reflection.id);
    }
    const recovery = this.snapshot.recordingRecovery;
    if (recovery?.reflectionId === detail.reflection.id && detail.uploadState) {
      if (detail.uploadState === "accepted") void this.markRecordingSaved(recovery, detail.reflection.id);
      else if (detail.uploadState !== "terminated") {
        this.update({ recordingRecovery: { ...recovery, uploadState: detail.uploadState,
          uploadFailure: detail.uploadFailure ?? null,
          phase: detail.uploadState === "still_persisting" ? "persisting" : "interrupted",
          errorMessage: detail.uploadState === "still_persisting" ? "服务器正在保存录音。已保留原音频，请稍后核对。"
            : detail.uploadState === "reupload_allowed" ? "服务器允许重新上传。可以使用原录音继续这次复盘。"
              : "尚未确认录音保存状态。请保留原音频并稍后核对。",
          uploadErrorMessage: detail.uploadState === "still_persisting" ? null : detail.uploadFailure
            ? reflectionUploadFailureMessage(detail.uploadFailure) : recovery.uploadErrorMessage } });
      }
    }
    this.reconcileFinalizeAttempt(detail);
    for (const candidateId of detail.revokedCandidateIds ?? []) {
      this.clearRevocationAttempt(detail.reflection.id, candidateId);
    }
    const revoked = new Set(detail.revokedCandidateIds ?? []);
    const activeCandidateId = detail.rememberedCount === undefined
      || detail.revokedCandidateIds === undefined
      ? null
      : detail.admissionResults.find((result) => (
          (result.status === "admitted" || result.status === "already_admitted")
          && !revoked.has(result.candidateId)
          && this.readRevocationAttempt(detail.reflection.id, result.candidateId) !== null
        ))?.candidateId ?? null;
    this.update({
      state: detail.reflection.status,
      operation: "idle",
      activeCandidateId,
      detail,
      workingCardStates: Object.fromEntries(
        (detail.workingCards ?? []).map((card) => [card.id, {
          status: card.status,
          memoryLifecycleStatus: card.memoryLifecycleStatus,
          version: card.version
        }])
      ),
      operationReceipt: this.readOperationReceipt(detail.reflection.id),
      errorMessage: null
    });
  }

  private async readServerTruth(
    reflectionId: string,
    controller: AbortController,
    generation: number
  ): Promise<DailyReflectionDetailResponse | null> {
    const detail = await this.api.get(reflectionId, controller.signal);
    if (!this.isCurrentWork(controller, generation)) return null;
    if (detail.reflection.id !== reflectionId) {
      throw new Error("Daily Reflection response ID mismatch");
    }
    this.applyDetail(detail);
    return detail;
  }

  private async pollReflection(
    reflectionId: string,
    controller: AbortController,
    generation: number
  ): Promise<void> {
    let firstRequest = true;
    while (this.isCurrentWork(controller, generation)) {
      if (!firstRequest) await waitForPoll(this.pollIntervalMs, controller.signal);
      firstRequest = false;
      const detail = await this.readServerTruth(reflectionId, controller, generation);
      if (!detail) return;
      if (detail.uploadState === "reupload_allowed" || detail.uploadState === "unresolved") return;
      if (!shouldKeepPolling(detail.reflection.status)) return;
    }
  }

  private handleWorkError(
    error: unknown,
    controller: AbortController,
    generation: number,
    fallback: string
  ) {
    if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return;
    if (isUnauthorized(error)) {
      this.expireAuthentication();
      return;
    }
    this.update({
      state: "error",
      operation: "idle",
      errorMessage: friendlyError(error, fallback)
    });
  }

  async initialize(initialReflectionId?: string | null): Promise<void> {
    this.disposed = false;
    const previousAccountId = this.authenticatedAccountId();
    const { controller, generation } = this.beginAuthentication();
    this.update({ auth: { status: "checking" }, errorMessage: null });
    try {
      const user = await this.api.getCurrentUser(controller.signal);
      if (!this.isCurrentAuth(controller, generation)) return;
      if (!user) {
        this.uploadController?.abort();
        this.uploadController = null;
        this.resetWorkflow(true);
        this.update({ auth: { status: "anonymous" }, recordingRecovery: null });
        return;
      }
      if ((previousAccountId && previousAccountId !== user.id)
        || (this.snapshot.recordingRecovery && this.snapshot.recordingRecovery.accountId !== user.id)) {
        this.uploadController?.abort();
        this.uploadController = null;
        this.resetWorkflow(true);
        this.update({ recordingRecovery: null });
      }
      this.update({ auth: { status: "authenticated", user } });
      if (!this.snapshot.recordingRecovery) {
        try {
          const backup = await this.recordingStorage.load(user.id);
          if (!this.isCurrentAuth(controller, generation)) return;
          const pending = this.readPendingInputOperation();
          const submitted = backup?.submitted || (backup && pending?.operationKey === backup.operationKey);
          if (backup) this.update({ recordingRecovery: {
            ...backup,
            ...(pending?.operationKey === backup.operationKey ? { sourceOrigin: pending.sourceOrigin, recordingDate: pending.recordingDate } : {}),
            reflectionId: pending?.operationKey === backup.operationKey ? pending.reflectionId ?? null : null,
            phase: submitted ? "interrupted" : "draft", localCopy: "saved", errorMessage: null
          } });
        } catch { /* No claim of a local copy when storage cannot be read. */ }
      }
      if (this.snapshot.recordingRecovery && this.snapshot.recordingRecovery.phase !== "draft" && !this.uploadController) {
        await this.checkRecordingOperation(controller.signal);
        if (!this.isCurrentAuth(controller, generation)) return;
      }
      const requestedReflectionId = normalizeReflectionId(initialReflectionId);
      const pendingReflectionId = !this.snapshot.recordingRecovery ? await this.lookupPendingInputOperation(controller.signal) : null;
      if (!this.isCurrentAuth(controller, generation)) return;
      const reflectionId = requestedReflectionId
        ?? this.snapshot.recordingRecovery?.reflectionId
        ?? (this.snapshot.recordingRecovery ? null : pendingReflectionId);
      if (!this.isCurrentAuth(controller, generation)) return;
      await Promise.all([
        this.refreshHistory(),
        reflectionId ? this.reload(reflectionId) : Promise.resolve()
      ]);
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentAuth(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.resetWorkflow(true);
        this.update({ auth: { status: "anonymous" } });
        return;
      }
      this.update({
        auth: {
          status: "error",
          message: friendlyError(error, "暂时无法确认登录状态，请稍后重试。")
        }
      });
    } finally {
      if (this.authController === controller) this.authController = null;
    }
  }

  readonly setSelectedFile = (file: File | null) => {
    this.update({ selectedFile: file, errorMessage: null });
  };

  readonly setSourceOrigin = (sourceOrigin: DailyReflectionUploadSource | null) => {
    this.update({ sourceOrigin, errorMessage: null });
  };

  readonly setRecordingDate = (recordingDate: string) => {
    this.update({ recordingDate, errorMessage: null });
  };

  readonly upload = async (
    file: File,
    sourceOrigin: DailyReflectionUploadSource,
    recordingDate: string,
    options: DailyReflectionUploadOptions = {}
  ): Promise<boolean> => {
    if (this.snapshot.auth.status !== "authenticated") return false;
    if (this.snapshot.recordingRecovery && this.snapshot.recordingRecovery.phase !== "saved") return false;
    if (options.inputAdapter !== "toy_sync") {
      const operationKey = options.operationKey ?? this.createIdempotencyKey();
      await this.uploadOriginal(file, undefined, recordingDate, operationKey, sourceOrigin, options.inputAdapter ?? "file_picker");
      return this.snapshot.recordingRecovery?.operationKey === operationKey && this.snapshot.recordingRecovery.phase === "saved";
    }
    const { controller, generation } = this.beginWork();
    let receiptReceived = false;
    const operationKey = options.operationKey ?? this.createIdempotencyKey();
    this.updateReflectionId(null);
    this.update({
      state: "uploading",
      operation: "uploading",
      detail: null,
      selectedFile: file,
      sourceOrigin,
      recordingDate,
      operationReceipt: null,
      errorMessage: null
    });
    try {
      this.writePendingInputOperation({
        accountId: this.snapshot.auth.user.id,
        operationKey,
        inputAdapter: options.inputAdapter ?? "file_picker",
        sourceOrigin,
        recordingDate
      });
      const receipt = await this.api.upload({
        file,
        sourceOrigin,
        recordingDate,
        operationKey,
        inputAdapter: options.inputAdapter ?? "file_picker",
        capturePurpose: "inspiration_capture"
      }, controller.signal);
      receiptReceived = true;
      if (!this.isCurrentWork(controller, generation)) return receiptReceived;
      this.writeOperationReceipt(receipt);
      this.clearPendingInputOperation();
      this.updateReflectionId(receipt.reflectionId);
      this.update({
        state: receipt.status,
        operation: "loading",
        detail: null,
        errorMessage: null
      });
      await this.pollReflection(receipt.reflectionId, controller, generation);
      await this.refreshHistory();
    } catch (error) {
      const recoverableTransportFailure = !(error instanceof DailyReflectionApiError)
        || error.status === 0
        || error.status >= 500;
      if (!isAbortError(error) && recoverableTransportFailure && this.isCurrentWork(controller, generation)) {
        try {
          const recoveredId = await this.lookupPendingInputOperation(controller.signal);
          if (recoveredId && this.isCurrentWork(controller, generation)) {
            receiptReceived = true;
            this.updateReflectionId(recoveredId);
            this.update({ state: "loading", operation: "loading", errorMessage: null });
            await this.pollReflection(recoveredId, controller, generation);
            await this.refreshHistory();
            return receiptReceived;
          }
        } catch (recoveryError) {
          if (isUnauthorized(recoveryError)) this.expireAuthentication();
        }
      }
      if (error instanceof DailyReflectionApiError && error.status >= 400 && error.status < 500) {
        this.clearPendingInputOperation();
      }
      this.handleWorkError(error, controller, generation, "上传没有完成，请稍后重试。");
    } finally {
      if (this.workController === controller) this.workController = null;
    }
    return receiptReceived;
  };

  readonly uploadBrowserRecording = async (
    file: File,
    clientReportedDurationMs: number | undefined,
    recordingDate: string,
    operationKey: string,
    sourceOrigin: DailyReflectionUploadSource = "user_reflection"
  ): Promise<void> => {
    await this.uploadOriginal(file, clientReportedDurationMs, recordingDate, operationKey, sourceOrigin, "browser_recorder");
  };

  private readonly uploadOriginal = async (file: File, clientReportedDurationMs: number | undefined, recordingDate: string,
    operationKey: string, sourceOrigin: DailyReflectionUploadSource, inputAdapter: "browser_recorder" | "file_picker") => {
    const accountId = this.authenticatedAccountId();
    if (!accountId || this.uploadController) return;
    const previous = this.snapshot.recordingRecovery;
    if (previous && previous.phase !== "saved" && previous.operationKey !== operationKey) return;
    this.update({ state: "uploading", operation: "uploading", selectedFile: file, sourceOrigin, recordingDate });
    if (!previous || previous.phase === "draft" || previous.phase === "saved") {
      await this.preserveRecording({ file, clientReportedDurationMs, recordingDate, operationKey, sourceOrigin, inputAdapter });
    }
    if (this.authenticatedAccountId() !== accountId || this.uploadController) return;
    const recovery = this.snapshot.recordingRecovery;
    if (!recovery || recovery.operationKey !== operationKey) return;
    const controller = new AbortController();
    this.uploadController = controller;
    const current = () => !this.disposed && this.uploadController === controller
      && !controller.signal.aborted && this.authenticatedAccountId() === accountId;
    this.abortWork();
    this.updateReflectionId(null);
    this.update({ state: "uploading", operation: "uploading", detail: null,
      selectedFile: file, sourceOrigin, recordingDate, operationReceipt: null, errorMessage: null,
      recordingRecovery: { ...recovery, inputAdapter, phase: "uploading", errorMessage: null, uploadErrorMessage: null, uploadFailure: null, uploadState: undefined } });
    this.writePendingInputOperation({ accountId, operationKey, inputAdapter, sourceOrigin, recordingDate });
    try {
      try {
        await this.recordingStorage.save({ accountId, operationKey, file, sourceOrigin, recordingDate,
          clientReportedDurationMs, inputAdapter, submitted: true });
        if (this.releasedRecordingOperations.has(JSON.stringify([accountId, operationKey]))) {
          await this.recordingStorage.remove(accountId, operationKey).catch(() => undefined);
        }
      } catch {
        if (current()) this.update({ recordingRecovery: {
          ...recovery, inputAdapter, phase: "uploading", localCopy: "unavailable", uploadErrorMessage: null, uploadFailure: null
        } });
      }
      if (!current()) return;
      const receipt = inputAdapter === "browser_recorder"
        ? await this.api.uploadBrowserRecording({ file, operationKey, recordingDate, inputAdapter, sourceOrigin,
          capturePurpose: "inspiration_capture", ...(clientReportedDurationMs ? { clientReportedDurationMs } : {}) }, controller.signal)
        : await this.api.upload({ file, operationKey, recordingDate, inputAdapter, sourceOrigin, capturePurpose: "inspiration_capture" }, controller.signal);
      if (!current()) return;
      const latestRecovery = this.snapshot.recordingRecovery ?? recovery;
      // Upload completion must not replace another reflection the user is reading.
      const followGeneration = this.workGeneration;
      const follow = () => this.workGeneration === followGeneration && this.snapshot.reflectionId === null
        && this.authenticatedAccountId() === accountId;
      this.writeOperationReceipt(receipt);
      this.writePendingInputOperation({ accountId, operationKey, inputAdapter, sourceOrigin, recordingDate, reflectionId: receipt.reflectionId });
      if (receipt.status === "deleted" || receipt.status === "cancelled") {
        this.update({ recordingRecovery: { ...latestRecovery, reflectionId: receipt.reflectionId } });
        await this.stopRecordingRecovery(receipt.reflectionId);
        if (follow()) this.update({ state: receipt.status, operation: "idle", errorMessage: "这次复盘已结束，不会重新上传。" });
        return;
      }
      {
        this.update({ recordingRecovery: { ...latestRecovery, reflectionId: receipt.reflectionId,
          phase: "persisting", errorMessage: "服务器仍在保存录音，请稍后核对进度。" } });
        const outcome = await this.checkRecordingOperation(controller.signal);
        if (outcome === "terminated") {
          if (follow()) this.update({ state: "cancelled", operation: "idle", errorMessage: "这次复盘已结束，不会重新上传。" });
          return;
        }
      }
      if (!current()) return;
      this.uploadController = null;
      if (follow()) await this.reload(receipt.reflectionId);
      await this.refreshHistory();
    } catch (error) {
      if (!current() || isAbortError(error)) return;
      this.uploadController = null;
      if (isUnauthorized(error)) { this.expireAuthentication(); return; }
      const message = friendlyError(error, "上传中断，请核对进度后使用原录音重试。");
      const recoveryViewGeneration = this.workGeneration;
      if (error instanceof DailyReflectionApiError && error.status === 409) {
        // A conflicting key may belong to different bytes. Never adopt its lookup result.
        this.clearPendingInputOperation();
        this.update({ state: "error", operation: "idle", errorMessage: message,
          recordingRecovery: { ...recovery, inputAdapter, phase: "draft", submitted: false, reflectionId: null,
            uploadErrorMessage: message, errorMessage: "请先下载原音频；删除这份本机草稿后重新选择文件。" } });
        await this.recordingStorage.save({ accountId, operationKey, file, sourceOrigin, recordingDate,
          clientReportedDurationMs, inputAdapter, submitted: false }).catch(() => undefined);
        if (this.releasedRecordingOperations.has(JSON.stringify([accountId, operationKey]))) {
          await this.recordingStorage.remove(accountId, operationKey).catch(() => undefined);
        }
        return;
      }
      this.update({ recordingRecovery: { ...(this.snapshot.recordingRecovery ?? recovery), phase: "interrupted",
        uploadErrorMessage: message,
        ...(error instanceof DailyReflectionApiError ? { uploadState: error.uploadState, uploadFailure: error.uploadFailure,
          reflectionId: error.reflectionId ?? recovery.reflectionId } : {}),
        errorMessage: message } });
      const operationFound = await this.checkRecordingOperation(controller.signal);
      if (this.disposed || this.authenticatedAccountId() !== accountId
        || this.snapshot.recordingRecovery?.operationKey !== operationKey) return;
      if (operationFound === "not_found" && error instanceof DailyReflectionApiError && error.status >= 400 && error.status < 500) {
        this.clearPendingInputOperation();
        const rejected = this.snapshot.recordingRecovery;
        this.update({ recordingRecovery: { ...rejected, phase: "draft", submitted: false } });
        await this.recordingStorage.save({ accountId, operationKey, file, sourceOrigin, recordingDate,
          clientReportedDurationMs, inputAdapter, submitted: false }).catch(() => undefined);
        if (this.releasedRecordingOperations.has(JSON.stringify([accountId, operationKey]))) {
          await this.recordingStorage.remove(accountId, operationKey).catch(() => undefined);
        }
        if (this.authenticatedAccountId() !== accountId || this.snapshot.recordingRecovery?.operationKey !== operationKey) return;
      }
      if (this.snapshot.recordingRecovery && this.snapshot.recordingRecovery.phase !== "saved"
        && operationFound === "not_found") {
        this.update({ recordingRecovery: { ...this.snapshot.recordingRecovery, errorMessage: message } });
      }
      if (this.workGeneration === recoveryViewGeneration && this.snapshot.reflectionId === null) await this.resumeRecording();
      await this.refreshHistory();
    } finally {
      if (this.uploadController === controller) this.uploadController = null;
    }
  };

  readonly reload = async (reflectionId?: string | null): Promise<void> => {
    if (this.snapshot.auth.status !== "authenticated") return;
    const targetId = normalizeReflectionId(reflectionId) ?? this.snapshot.reflectionId;
    if (!targetId) return;
    const { controller, generation } = this.beginWork();
    const changed = targetId !== this.snapshot.reflectionId;
    this.updateReflectionId(targetId);
    this.update({
      state: "loading",
      operation: "loading",
      ...(changed ? { detail: null } : {}),
      ...(changed ? { workingCardStates: {} } : {}),
      errorMessage: null
    });
    try {
      await this.pollReflection(targetId, controller, generation);
    } catch (error) {
      this.handleWorkError(error, controller, generation, "暂时无法读取这条复盘，请稍后重试。");
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly startNew = () => {
    if (this.snapshot.auth.status !== "authenticated") return;
    if (this.snapshot.recordingRecovery && this.snapshot.recordingRecovery.phase !== "saved") {
      void this.resumeRecording();
      return;
    }
    this.abortWork();
    this.resetWorkflow(true, false);
  };

  readonly preserveRecording = async (input: Omit<ReflectionRecordingBackup, "accountId">) => {
    const accountId = this.authenticatedAccountId();
    if (!accountId || this.uploadController) return;
    const previous = this.snapshot.recordingRecovery;
    if (previous && previous.phase !== "draft" && previous.phase !== "saved") return;
    const recovery: ReflectionRecordingRecovery = {
      ...input, accountId, reflectionId: null, phase: "draft", localCopy: "saving", errorMessage: null
    };
    this.update({ recordingRecovery: recovery });
    try {
      await this.recordingStorage.save({ ...input, accountId });
      if (this.releasedRecordingOperations.has(JSON.stringify([accountId, input.operationKey]))) {
        await this.recordingStorage.remove(accountId, input.operationKey).catch(() => undefined);
        return;
      }
      if (this.snapshot.recordingRecovery === recovery) {
        this.update({ recordingRecovery: { ...recovery, localCopy: "saved" } });
      }
    } catch {
      if (this.snapshot.recordingRecovery === recovery) {
        this.update({ recordingRecovery: { ...recovery, localCopy: "unavailable" } });
      }
    }
  };

  private async markRecordingSaved(recovery: ReflectionRecordingRecovery, reflectionId: string) {
    if (this.snapshot.recordingRecovery?.operationKey !== recovery.operationKey
      || this.authenticatedAccountId() !== recovery.accountId) return;
    this.update({ recordingRecovery: { ...recovery, reflectionId, file: null, phase: "saved", errorMessage: null,
      uploadState: "accepted", uploadFailure: null, uploadErrorMessage: null } });
    this.releasedRecordingOperations.add(JSON.stringify([recovery.accountId, recovery.operationKey]));
    await this.recordingStorage.remove(recovery.accountId, recovery.operationKey).catch(() => undefined);
    if (this.authenticatedAccountId() === recovery.accountId
      && this.snapshot.recordingRecovery?.operationKey === recovery.operationKey
      && this.snapshot.recordingRecovery.phase === "saved") this.update({ selectedFile: null });
  }

  private async checkRecordingOperation(
    signal?: AbortSignal
  ): Promise<DailyReflectionOperationUploadState | "not_found"> {
    const recovery = this.snapshot.recordingRecovery;
    if (!recovery) return "terminated";
    if (recovery.phase === "saved") return "accepted";
    if (this.recordingCheckController) return "unresolved";
    const controller = new AbortController();
    this.recordingCheckController = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const current = () => !this.disposed && !controller.signal.aborted
      && this.recordingCheckController === controller
      && this.snapshot.recordingRecovery?.operationKey === recovery.operationKey
      && !this.releasedRecordingOperations.has(JSON.stringify([recovery.accountId, recovery.operationKey]))
      && this.authenticatedAccountId() === recovery.accountId;
    this.update({ recordingRecovery: { ...recovery, phase: "checking" } });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!current()) return "unresolved";
        const result = await this.api.getOperation(recovery.operationKey, controller.signal);
        if (!current()) return "unresolved";
        if (!result.found) {
          this.update({ recordingRecovery: { ...recovery, phase: "interrupted", uploadState: undefined,
            errorMessage: "尚未查到保存记录。请保留原音频，确认后再上传。" } });
          return "not_found";
        }
        if (recovery.reflectionId && recovery.reflectionId !== result.reflectionId) {
          this.update({ recordingRecovery: { ...recovery, phase: "interrupted", uploadState: "unresolved",
            errorMessage: "返回的记录与这次上传不一致，尚未确认保存。请保留原音频并稍后核对。" } });
          return "unresolved";
        }
        if (result.uploadState === "terminated" || result.status === "cancelled" || result.status === "deleted") {
          this.releasedRecordingOperations.add(JSON.stringify([recovery.accountId, recovery.operationKey]));
          this.update({ recordingRecovery: null, selectedFile: null });
          this.clearPendingInputOperation();
          if (this.snapshot.reflectionId === result.reflectionId) {
            this.abortWork();
            this.updateReflectionId(null);
            this.update({ detail: null, operation: "idle", state: result.status === "deleted" ? "deleted" : "cancelled" });
          }
          await this.recordingStorage.remove(recovery.accountId, recovery.operationKey).catch(() => undefined);
          return "terminated";
        }
        if (recovery.sourceOrigin) this.writePendingInputOperation({
          accountId: recovery.accountId, operationKey: recovery.operationKey, inputAdapter: recovery.inputAdapter ?? "browser_recorder",
          sourceOrigin: recovery.sourceOrigin, recordingDate: recovery.recordingDate, reflectionId: result.reflectionId
        });
        if (result.uploadState === "accepted") {
          await this.markRecordingSaved(recovery, result.reflectionId);
          return "accepted";
        }
        const currentRecovery: ReflectionRecordingRecovery = { ...recovery, reflectionId: result.reflectionId,
          contentHash: result.contentHash,
          uploadState: result.uploadState, uploadFailure: result.uploadFailure ?? null,
          uploadErrorMessage: result.uploadState === "still_persisting" ? null : result.uploadFailure
            ? reflectionUploadFailureMessage(result.uploadFailure) : recovery.uploadErrorMessage };
        if (result.uploadState === "reupload_allowed") {
          this.update({ recordingRecovery: { ...currentRecovery, phase: "interrupted",
            errorMessage: "服务器允许重新上传。可以使用原录音继续这次复盘。" } });
          return "reupload_allowed";
        }
        if (result.uploadState !== "still_persisting") {
          this.update({ recordingRecovery: { ...currentRecovery, phase: "interrupted",
            errorMessage: "尚未确认录音保存状态。已保留现有录音，请稍后重新核对。" } });
          return "unresolved";
        }
        this.update({ recordingRecovery: { ...currentRecovery, phase: "persisting",
          errorMessage: attempt === 4 ? "服务器仍在保存录音。已保留现有录音，可稍后重新核对。"
            : `服务器正在保存录音，核对进度 ${attempt + 1}/5。` } });
        if (attempt < 4) await waitForPoll(this.pollIntervalMs, controller.signal);
      }
      return "still_persisting";
    } catch (error) {
      if (current()) {
        if (isUnauthorized(error)) this.expireAuthentication();
        else this.update({ recordingRecovery: { ...recovery, phase: "interrupted",
          errorMessage: friendlyError(error, "暂时无法核对保存状态。请保留原音频，稍后重新核对。") } });
      }
      return "unresolved";
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.recordingCheckController === controller) this.recordingCheckController = null;
    }
  }

  readonly resumeRecording = async () => {
    const recovery = this.snapshot.recordingRecovery;
    if (!recovery) return;
    if (recovery.reflectionId) { await this.reload(recovery.reflectionId); return; }
    this.abortWork();
    this.updateReflectionId(null);
    this.update({ detail: null, selectedFile: recovery.file, sourceOrigin: recovery.sourceOrigin,
      recordingDate: recovery.recordingDate, state: recovery.phase === "uploading" ? "uploading" : "error",
      operation: recovery.phase === "uploading" ? "uploading" : "idle", errorMessage: recovery.errorMessage });
  };

  readonly retryRecordingUpload = async () => {
    if (this.uploadController || this.recordingCheckController || !this.snapshot.recordingRecovery) return;
    const result = this.snapshot.recordingRecovery.phase === "draft" ? "not_found" : await this.checkRecordingOperation();
    const recovery = this.snapshot.recordingRecovery;
    if ((result !== "not_found" && result !== "reupload_allowed") || !recovery?.file || !recovery.sourceOrigin) {
      await this.resumeRecording(); return;
    }
    if (recovery.uploadFailure?.retryable === false) return;
    await this.uploadOriginal(recovery.file, recovery.clientReportedDurationMs,
      recovery.recordingDate, recovery.operationKey, recovery.sourceOrigin, recovery.inputAdapter ?? "browser_recorder");
  };

  readonly setRecordingRecoveryFile = async (file: File) => {
    const recovery = this.snapshot.recordingRecovery;
    if (!recovery || recovery.file || this.uploadController || this.recordingCheckController
      || recovery.phase === "saved" || recovery.uploadFailure?.retryable === false || file.size === 0) return;
    try {
      if (!recovery.contentHash || !globalThis.crypto?.subtle) throw new Error("original_file_not_verifiable");
      const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      if (this.authenticatedAccountId() !== recovery.accountId || this.snapshot.recordingRecovery !== recovery) return;
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== recovery.contentHash) {
        this.update({ recordingRecovery: { ...recovery, errorMessage: "所选文件与这次上传的原音频不一致，请重新选择原文件。" } });
        return;
      }
    } catch {
      if (this.authenticatedAccountId() === recovery.accountId && this.snapshot.recordingRecovery === recovery) {
        this.update({ recordingRecovery: { ...recovery, errorMessage: "暂时无法核验原文件，请先核对保存状态；也可以删除失败记录后重新选择。" } });
      }
      return;
    }
    this.update({ recordingRecovery: { ...recovery, file, localCopy: "saving", errorMessage: "原文件已核对，可以继续核对保存状态并重试上传。" } });
    try {
      await this.recordingStorage.save({ ...recovery, file, submitted: true });
      if (this.releasedRecordingOperations.has(JSON.stringify([recovery.accountId, recovery.operationKey]))) {
        await this.recordingStorage.remove(recovery.accountId, recovery.operationKey).catch(() => undefined);
        return;
      }
      if (this.authenticatedAccountId() === recovery.accountId && this.snapshot.recordingRecovery?.operationKey === recovery.operationKey) {
        this.update({ recordingRecovery: { ...this.snapshot.recordingRecovery, localCopy: "saved" } });
      }
    } catch {
      if (this.authenticatedAccountId() === recovery.accountId && this.snapshot.recordingRecovery?.operationKey === recovery.operationKey) {
        this.update({ recordingRecovery: { ...this.snapshot.recordingRecovery, localCopy: "unavailable" } });
      }
    }
  };

  readonly cancelRecordingUpload = async () => {
    const recovery = this.snapshot.recordingRecovery;
    if (!recovery?.reflectionId) return;
    this.fenceRecordingUpload(recovery.reflectionId);
    const { controller, generation } = this.beginWork();
    this.updateReflectionId(recovery.reflectionId);
    try {
      const detail = await this.readServerTruth(recovery.reflectionId, controller, generation);
      if (!detail || this.authenticatedAccountId() !== recovery.accountId
        || this.snapshot.recordingRecovery?.operationKey !== recovery.operationKey) return;
      if (detail.reflection.status === "failed") await this.delete();
      else await this.cancel();
    } catch (error) {
      this.handleWorkError(error, controller, generation, "未能取消这次上传，原音频仍被保留，请重试。");
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly setRecordingRecoverySource = async (sourceOrigin: DailyReflectionUploadSource) => {
    const recovery = this.snapshot.recordingRecovery;
    if (!recovery?.file || recovery.phase !== "draft") return;
    await this.preserveRecording({ ...recovery, file: recovery.file, sourceOrigin });
  };

  readonly discardRecordingDraft = async () => {
    const recovery = this.snapshot.recordingRecovery;
    if (!recovery || recovery.phase !== "draft") return;
    try {
      await this.recordingStorage.remove(recovery.accountId, recovery.operationKey);
    } catch {
      this.update({ recordingRecovery: { ...recovery, errorMessage: "本机暂存暂时无法删除，请重试。" } });
      return;
    }
    if (this.snapshot.recordingRecovery?.operationKey !== recovery.operationKey
      || this.authenticatedAccountId() !== recovery.accountId) return;
    this.releasedRecordingOperations.add(JSON.stringify([recovery.accountId, recovery.operationKey]));
    this.update({ recordingRecovery: null });
    this.startNew();
  };

  readonly updateCandidates = async (
    decisions: readonly DailyReflectionCandidateDecision[]
  ): Promise<void> => {
    const detail = this.snapshot.detail;
    if (
      this.snapshot.auth.status !== "authenticated"
      || !this.snapshot.reflectionId
      || !detail
      || detail.reflection.status !== "review_pending"
      || this.snapshot.operation !== "idle"
      || decisions.length === 0
    ) return;
    if (decisions.some((decision) => decision.subjectPersonId !== null)) {
      this.update({ errorMessage: "日常复盘不会在这里关联人物。" });
      return;
    }
    const reflectionId = this.snapshot.reflectionId;
    const { controller, generation } = this.beginWork();
    this.update({
      operation: "saving_candidate",
      activeCandidateId: decisions.length === 1 ? decisions[0]?.candidateId ?? null : null,
      errorMessage: null
    });
    try {
      await this.api.updateCandidates(reflectionId, {
        expectedVersion: detail.reflection.version,
        candidates: [...decisions]
      }, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      await this.readServerTruth(reflectionId, controller, generation);
      await this.refreshHistory();
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      if (error instanceof DailyReflectionApiError && error.status === 409) {
        try {
          await this.readServerTruth(reflectionId, controller, generation);
          if (this.isCurrentWork(controller, generation)) {
            this.update({ operation: "idle", activeCandidateId: null, errorMessage: STALE_MESSAGE });
          }
        } catch (refreshError) {
          if (isUnauthorized(refreshError)) this.expireAuthentication();
          else if (!isAbortError(refreshError) && this.isCurrentWork(controller, generation)) {
            this.update({
              operation: "idle",
              activeCandidateId: null,
              errorMessage: friendlyError(refreshError, "暂时无法读取最新内容，请稍后重试。")
            });
          }
        }
        return;
      }
      try {
        const current = await this.readServerTruth(reflectionId, controller, generation);
        if (!current || !this.isCurrentWork(controller, generation)) return;
        const allSaved = decisions.every((decision) => {
          const saved = current.candidates.find((candidate) => candidate.id === decision.candidateId);
          return saved?.status === decision.status
            && (saved.userText ?? null) === decision.userText
            && saved.subjectPersonId === null
            && (
              decision.actionClaimed === undefined
              || ("contractVersion" in saved && saved.actionClaimed === decision.actionClaimed)
            );
        });
        if (allSaved) return;
        this.update({
          operation: "idle",
          activeCandidateId: null,
          errorMessage: friendlyError(error, "这些选择没有保存成功，请稍后再试。")
        });
      } catch (refreshError) {
        if (isUnauthorized(refreshError)) this.expireAuthentication();
        else if (!isAbortError(refreshError) && this.isCurrentWork(controller, generation)) {
          this.update({
            operation: "idle",
            activeCandidateId: null,
            errorMessage: friendlyError(error, "这些选择没有保存成功，请稍后再试。")
          });
        }
      }
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly updateCandidate = async (
    decision: DailyReflectionCandidateDecision
  ): Promise<void> => this.updateCandidates([decision]);

  readonly updateCards = async (
    decisions: readonly DailyReflectionCardDecision[]
  ): Promise<void> => {
    const detail = this.snapshot.detail;
    if (
      this.snapshot.auth.status !== "authenticated"
      || !this.snapshot.reflectionId
      || !detail
      || detail.reflection.status !== "review_pending"
      || this.snapshot.operation !== "idle"
      || decisions.length === 0
    ) return;
    const reflectionId = this.snapshot.reflectionId;
    const { controller, generation } = this.beginWork();
    this.update({
      operation: "saving_candidate",
      activeCandidateId: decisions.length === 1 ? decisions[0]?.cardId ?? null : null,
      errorMessage: null
    });
    try {
      await this.api.updateCards(reflectionId, {
        expectedVersion: detail.reflection.version,
        cards: [...decisions]
      }, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      await this.readServerTruth(reflectionId, controller, generation);
      await this.refreshHistory();
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      if (error instanceof DailyReflectionApiError && error.status === 409) {
        try {
          await this.readServerTruth(reflectionId, controller, generation);
          if (this.isCurrentWork(controller, generation)) {
            this.update({ operation: "idle", activeCandidateId: null, errorMessage: STALE_MESSAGE });
          }
        } catch (refreshError) {
          if (isUnauthorized(refreshError)) this.expireAuthentication();
        }
        return;
      }
      this.update({
        operation: "idle",
        activeCandidateId: null,
        errorMessage: friendlyError(error, "这张复盘卡没有保存成功，请稍后重试。")
      });
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly updateCard = async (
    decision: DailyReflectionCardDecision
  ): Promise<void> => this.updateCards([decision]);

  readonly saveWorkingCard = async (
    cardId: string,
    draft?: Pick<DailyReflectionCardDecision, "userTitle" | "userText">
  ): Promise<boolean> => {
    const detail = this.snapshot.detail;
    const reflectionId = this.snapshot.reflectionId;
    const card = detail?.cards.find((item) => item.id === cardId);
    if (
      this.snapshot.auth.status !== "authenticated"
      || !reflectionId
      || !detail
      || !card
      || this.snapshot.operation !== "idle"
    ) return false;
    const { controller, generation } = this.beginWork();
    this.update({
      operation: "saving_working_card",
      activeCandidateId: cardId,
      errorMessage: null
    });
    try {
      let cardVersion = card.version;
      let latestDetail = detail;
      if (
        draft
        && (draft.userTitle !== card.userTitle || draft.userText !== card.userText)
      ) {
        const updated = await this.api.updateCards(reflectionId, {
          expectedVersion: detail.reflection.version,
          cards: [{
            cardId,
            reviewStatus: card.reviewStatus,
            userTitle: draft.userTitle,
            userText: draft.userText
          }]
        }, controller.signal);
        if (!this.isCurrentWork(controller, generation)) return false;
        const updatedCard = updated.cards.find((item) => item.id === cardId);
        if (!updatedCard) throw new Error("Daily Reflection Card update response mismatch");
        cardVersion = updatedCard.version;
        const previousById = new Map(detail.cards.map((item) => [item.id, item]));
        latestDetail = {
          ...detail,
          reflection: updated.reflection,
          cards: updated.cards.map((item) => ({
            ...item,
            evidence: previousById.get(item.id)?.evidence ?? []
          }))
        };
        this.update({ detail: latestDetail, state: updated.reflection.status });
      }
      const result = await this.api.saveWorkingCard(
        reflectionId,
        cardId,
        { expectedVersion: cardVersion },
        controller.signal
      );
      if (!this.isCurrentWork(controller, generation)) return false;
      const nextWorkingCards = [
        ...(latestDetail.workingCards ?? []).filter((item) => item.id !== cardId),
        { id: cardId, status: result.card.status, version: result.card.version }
      ].sort((left, right) => left.id.localeCompare(right.id));
      this.update({
        operation: "idle",
        activeCandidateId: null,
        detail: { ...latestDetail, workingCards: nextWorkingCards },
        workingCardStates: {
          ...this.snapshot.workingCardStates,
          [cardId]: {
            status: result.card.status,
            version: result.card.version
          }
        },
        errorMessage: null
      });
      return true;
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return false;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return false;
      }
      if (error instanceof DailyReflectionApiError && error.status === 409) {
        try {
          await this.readServerTruth(reflectionId, controller, generation);
          if (this.isCurrentWork(controller, generation)) {
            this.update({
              operation: "idle",
              activeCandidateId: null,
              errorMessage: STALE_MESSAGE
            });
          }
        } catch (refreshError) {
          if (isUnauthorized(refreshError)) this.expireAuthentication();
        }
        return false;
      }
      this.update({
        operation: "idle",
        activeCandidateId: null,
        errorMessage: friendlyError(error, "这张卡片没有保存到 My Cards，请稍后重试。")
      });
      return false;
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  private updateWorkingCardLifecycle = async (
    cardId: string,
    operation: "archive" | "restore" | "remove"
  ): Promise<void> => {
    const state = this.snapshot.workingCardStates[cardId];
    if (
      this.snapshot.auth.status !== "authenticated"
      || !state
      || this.snapshot.operation !== "idle"
    ) return;
    const { controller, generation } = this.beginWork();
    this.update({
      operation: "saving_working_card",
      activeCandidateId: cardId,
      errorMessage: null
    });
    try {
      const input = { expectedVersion: state.version };
      const result = operation === "archive"
        ? await this.api.archiveWorkingCard(cardId, input, controller.signal)
        : operation === "restore"
          ? await this.api.restoreWorkingCard(cardId, input, controller.signal)
          : await this.api.removeWorkingCard(cardId, input, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      const detail = this.snapshot.detail;
      const nextWorkingCards = detail ? [
        ...(detail.workingCards ?? []).filter((item) => item.id !== cardId),
        { id: cardId, status: result.card.status, version: result.card.version }
      ].sort((left, right) => left.id.localeCompare(right.id)) : undefined;
      this.update({
        operation: "idle",
        activeCandidateId: null,
        ...(detail && nextWorkingCards
          ? { detail: { ...detail, workingCards: nextWorkingCards } }
          : {}),
        workingCardStates: {
          ...this.snapshot.workingCardStates,
          [cardId]: {
            status: result.card.status,
            version: result.card.version
          }
        },
        errorMessage: null
      });
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      this.update({
        operation: "idle",
        activeCandidateId: null,
        errorMessage: friendlyError(error, "这张 Card 的状态没有更新成功，请稍后重试。")
      });
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly archiveWorkingCard = async (cardId: string) =>
    this.updateWorkingCardLifecycle(cardId, "archive");

  readonly restoreWorkingCard = async (cardId: string) =>
    this.updateWorkingCardLifecycle(cardId, "restore");

  readonly removeWorkingCard = async (cardId: string) =>
    this.updateWorkingCardLifecycle(cardId, "remove");

  readonly acceptAllCandidates = async (): Promise<void> => {
    const cards = this.snapshot.detail?.cards ?? [];
    if (cards.length > 0) {
      await this.updateCards(cards
        .filter((card) => card.displayTier === "primary")
        .map((card) => ({
          cardId: card.id,
          reviewStatus: "kept" as const,
          userTitle: card.userTitle,
          userText: card.userText
          // Bulk review deliberately omits actionClaimed. Only the per-card
          // explicit claim control may change that field.
        })));
      return;
    }
    const candidates = this.snapshot.detail?.candidates ?? [];
    await this.updateCandidates(candidates.map((candidate) => ({
      candidateId: candidate.id,
      status: "kept" as const,
      userText: candidate.userText,
      subjectPersonId: null,
      ...("contractVersion" in candidate ? { actionClaimed: false } : {})
    })));
  };

  readonly createManualCandidate = async (
    candidate: DailyReflectionManualCandidateDraft
  ): Promise<void> => {
    const detail = this.snapshot.detail;
    if (
      this.snapshot.auth.status !== "authenticated"
      || !this.snapshot.reflectionId
      || !detail
      || (detail.reflection.status !== "review_pending" && detail.reflection.status !== "failed")
      || this.snapshot.operation !== "idle"
    ) return;
    const reflectionId = this.snapshot.reflectionId;
    const { controller, generation } = this.beginWork();
    this.update({ operation: "creating_candidate", activeCandidateId: null, errorMessage: null });
    try {
      await this.api.createManualCandidate(reflectionId, {
        expectedVersion: detail.reflection.version,
        ...candidate
      }, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      await this.readServerTruth(reflectionId, controller, generation);
      await this.refreshHistory();
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      if (error instanceof DailyReflectionApiError && error.status === 409) {
        try {
          await this.readServerTruth(reflectionId, controller, generation);
          if (this.isCurrentWork(controller, generation)) {
            this.update({ operation: "idle", errorMessage: STALE_MESSAGE });
          }
        } catch (refreshError) {
          if (isUnauthorized(refreshError)) this.expireAuthentication();
          else if (!isAbortError(refreshError) && this.isCurrentWork(controller, generation)) {
            this.update({
              operation: "idle",
              errorMessage: friendlyError(refreshError, "暂时无法读取最新内容，请稍后重试。")
            });
          }
        }
        return;
      }
      this.update({
        operation: "idle",
        errorMessage: friendlyError(error, "手写内容没有保存成功，请稍后重试。")
      });
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly excludeCandidate = async (candidateId: string): Promise<void> => {
    const detail = this.snapshot.detail;
    if (
      this.snapshot.auth.status !== "authenticated"
      || !this.snapshot.reflectionId
      || !detail
      || detail.reflection.status !== "review_pending"
      || this.snapshot.operation !== "idle"
    ) return;
    const reflectionId = this.snapshot.reflectionId;
    const { controller, generation } = this.beginWork();
    this.update({
      operation: "excluding_candidate",
      activeCandidateId: candidateId,
      errorMessage: null
    });
    try {
      await this.api.excludeCandidate(reflectionId, candidateId, {
        expectedVersion: detail.reflection.version
      }, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      await this.readServerTruth(reflectionId, controller, generation);
      await this.refreshHistory();
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      if (error instanceof DailyReflectionApiError && error.status === 409) {
        try {
          await this.readServerTruth(reflectionId, controller, generation);
          if (this.isCurrentWork(controller, generation)) {
            this.update({ operation: "idle", activeCandidateId: null, errorMessage: STALE_MESSAGE });
          }
        } catch (refreshError) {
          if (isUnauthorized(refreshError)) this.expireAuthentication();
          else if (!isAbortError(refreshError) && this.isCurrentWork(controller, generation)) {
            this.update({
              operation: "idle",
              activeCandidateId: null,
              errorMessage: friendlyError(refreshError, "暂时无法读取最新内容，请稍后重试。")
            });
          }
        }
        return;
      }
      this.update({
        operation: "idle",
        activeCandidateId: null,
        errorMessage: friendlyError(error, "这张卡片没有删除成功，请稍后重试。")
      });
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly finalize = async (saveIntent: DailyReflectionSaveIntent): Promise<void> => {
    let detail = this.snapshot.detail;
    const accountId = this.authenticatedAccountId();
    if (
      !accountId
      || !this.snapshot.reflectionId
      || !detail
      || (
        detail.reflection.status !== "review_pending"
        && detail.reflection.status !== "admission_failed"
      )
      || this.snapshot.operation !== "idle"
    ) return;
    if (detail.reflection.status === "review_pending") {
      const pending = detail.candidates.filter((candidate) => candidate.status === "pending");
      if (pending.length > 0) {
        await this.updateCandidates(pending.map((candidate) => ({
          candidateId: candidate.id,
          status: saveIntent === "recap_only" ? "kept" as const : "excluded" as const,
          userText: candidate.userText,
          subjectPersonId: null,
          ...("contractVersion" in candidate ? { actionClaimed: false } : {})
        })));
        detail = this.snapshot.detail;
        if (
          !detail
          || detail.reflection.status !== "review_pending"
          || detail.candidates.some((candidate) => candidate.status === "pending")
          || this.snapshot.errorMessage
        ) return;
      }
    }
    const reflectionId = this.snapshot.reflectionId;
    const existingAttempt = this.readFinalizeAttempt(reflectionId);
    if (existingAttempt && existingAttempt.saveIntent !== saveIntent) {
      this.update({
        errorMessage: existingAttempt.saveIntent === "recap_only"
          ? "上一次“只保存这次复盘”的请求仍待确认，请继续使用原来的保存方式。"
          : "上一次“保存并长期保留”的请求仍待确认，请继续使用原来的保存方式。"
      });
      return;
    }
    if (detail.reflection.status === "admission_failed" && !existingAttempt) {
      this.update({
        errorMessage: "这次确认的安全重试信息已失效，请保留这条复盘并稍后再试。"
      });
      return;
    }
    const confirmedOperationKey = detail.confirmation
      && "contractVersion" in detail.confirmation
      ? detail.confirmation.operationKey
      : null;
    const operationKey = existingAttempt?.operationKey
      ?? this.readOperationReceipt(reflectionId)?.operationKey
      ?? (this.readPendingInputOperation()?.reflectionId === reflectionId
        ? this.readPendingInputOperation()?.operationKey
        : null)
      ?? confirmedOperationKey;
    if (!operationKey) {
      this.update({
        errorMessage: "这次提交凭据还没有恢复，请重新打开这条复盘后再试。"
      });
      return;
    }
    const attempt = existingAttempt ?? {
      reflectionId,
      accountId,
      expectedVersion: detail.reflection.version,
      operationKey,
      saveIntent
    };
    this.writeFinalizeAttempt(attempt);
    const { controller, generation } = this.beginWork();
    this.update({ operation: "finalizing", activeCandidateId: null, errorMessage: null });
    try {
      await this.api.finalize(reflectionId, {
        expectedVersion: attempt.expectedVersion,
        operationKey: attempt.operationKey,
        saveIntent: attempt.saveIntent
      }, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      await this.pollReflection(reflectionId, controller, generation);
      await this.refreshHistory();
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      if (error instanceof DailyReflectionApiError && error.status === 409) {
        try {
          const current = await this.readServerTruth(reflectionId, controller, generation);
          if (!current || !this.isCurrentWork(controller, generation)) return;
          if (
            current.confirmation
            && "contractVersion" in current.confirmation
            && current.confirmation.operationKey === attempt.operationKey
            && current.confirmation.saveIntent === attempt.saveIntent
          ) {
            if (shouldKeepPolling(current.reflection.status)) {
              await this.pollReflection(reflectionId, controller, generation);
            }
          } else {
            this.update({ operation: "idle", errorMessage: STALE_MESSAGE });
          }
        } catch (refreshError) {
          if (isUnauthorized(refreshError)) this.expireAuthentication();
          else if (!isAbortError(refreshError) && this.isCurrentWork(controller, generation)) {
            this.update({
              operation: "idle",
              errorMessage: friendlyError(refreshError, "暂时无法读取最新内容，请稍后重试。")
            });
          }
        }
        return;
      }
      try {
        const current = await this.readServerTruth(reflectionId, controller, generation);
        if (!current || !this.isCurrentWork(controller, generation)) return;
        if (
          current.confirmation
          && "contractVersion" in current.confirmation
          && current.confirmation.operationKey === attempt.operationKey
          && current.confirmation.saveIntent === attempt.saveIntent
        ) {
          if (shouldKeepPolling(current.reflection.status)) {
            await this.pollReflection(reflectionId, controller, generation);
          }
          return;
        }
        this.update({
          operation: "idle",
          errorMessage: friendlyError(error, "这次确认没有完成，请稍后重试。")
        });
      } catch (refreshError) {
        if (isUnauthorized(refreshError)) this.expireAuthentication();
        else if (!isAbortError(refreshError) && this.isCurrentWork(controller, generation)) {
          this.update({
            operation: "idle",
            errorMessage: friendlyError(error, "这次确认没有完成，请稍后重试。")
          });
        }
      }
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly revokeCandidate = async (candidateId: string): Promise<void> => {
    const detail = this.snapshot.detail;
    const accountId = this.authenticatedAccountId();
    const reflectionId = this.snapshot.reflectionId;
    const result = detail?.admissionResults.find((item) => item.candidateId === candidateId);
    if (
      !accountId
      || !reflectionId
      || !detail
      || detail.reflection.status !== "completed"
      || detail.rememberedCount === undefined
      || detail.revokedCandidateIds === undefined
      || detail.revokedCandidateIds.includes(candidateId)
      || (result?.status !== "admitted" && result?.status !== "already_admitted")
      || this.snapshot.operation !== "idle"
    ) return;
    const existingAttempt = this.readRevocationAttempt(reflectionId, candidateId);
    const attempt = existingAttempt ?? {
      reflectionId,
      candidateId,
      accountId,
      expectedVersion: detail.reflection.version,
      idempotencyKey: this.createRevocationIdempotencyKey()
    };
    this.writeRevocationAttempt(attempt);
    const { controller, generation } = this.beginWork();
    this.update({
      operation: "revoking_candidate",
      activeCandidateId: candidateId,
      errorMessage: null
    });
    try {
      await this.api.revokeCandidate(reflectionId, candidateId, {
        expectedVersion: attempt.expectedVersion,
        idempotencyKey: attempt.idempotencyKey
      }, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      const current = await this.readServerTruth(reflectionId, controller, generation);
      if (!current || !this.isCurrentWork(controller, generation)) return;
      if (!current.revokedCandidateIds?.includes(candidateId)) {
        this.update({
          operation: "idle",
          activeCandidateId: candidateId,
          errorMessage: "撤销结果暂时没有确认，请稍后重试撤销。"
        });
        return;
      }
      this.clearRevocationAttempt(reflectionId, candidateId);
      this.update({ activeCandidateId: null, errorMessage: null });
      await this.refreshHistory();
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentWork(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      if (error instanceof DailyReflectionApiError && error.status === 404) {
        this.clearRevocationAttempt(reflectionId, candidateId);
        this.update({ history: this.snapshot.history.filter((item) => item.id !== reflectionId) });
        this.resetWorkflow(true, false);
        await this.refreshHistory();
        this.update({ historyErrorMessage: "这条复盘不存在或已被删除。" });
        return;
      }
      try {
        const current = await this.readServerTruth(reflectionId, controller, generation);
        if (!current || !this.isCurrentWork(controller, generation)) return;
        if (current.revokedCandidateIds?.includes(candidateId)) {
          this.clearRevocationAttempt(reflectionId, candidateId);
          this.update({ activeCandidateId: null, errorMessage: null });
          await this.refreshHistory();
          return;
        }
      } catch (refreshError) {
        if (isUnauthorized(refreshError)) {
          this.expireAuthentication();
          return;
        }
        if (isAbortError(refreshError) || !this.isCurrentWork(controller, generation)) return;
      }
      if (
        error instanceof DailyReflectionApiError
        && error.status === 409
        && error.code === "version_conflict"
      ) {
        this.clearRevocationAttempt(reflectionId, candidateId);
        this.update({ operation: "idle", activeCandidateId: null, errorMessage: STALE_MESSAGE });
        return;
      }
      this.update({
        operation: "idle",
        activeCandidateId: candidateId,
        errorMessage: friendlyError(error, "这条内容暂时没有撤销成功，请稍后重试撤销。")
      });
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly retry = async (): Promise<void> => {
    if (this.snapshot.auth.status !== "authenticated" || !this.snapshot.reflectionId) return;
    const reflectionId = this.snapshot.reflectionId;
    const { controller, generation } = this.beginWork();
    this.update({ operation: "retrying", errorMessage: null });
    try {
      const receipt = await this.api.retry(reflectionId, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      this.update({
        state: receipt.status,
        operation: "loading",
        detail: null,
        errorMessage: null
      });
      await this.pollReflection(reflectionId, controller, generation);
      await this.refreshHistory();
    } catch (error) {
      this.handleWorkError(error, controller, generation, "重试没有开始，请稍后再试。");
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly cancel = async (): Promise<void> => {
    if (this.snapshot.auth.status !== "authenticated" || !this.snapshot.reflectionId) return;
    const reflectionId = this.snapshot.reflectionId;
    this.fenceRecordingUpload(reflectionId);
    const { controller, generation } = this.beginWork();
    this.update({ operation: "cancelling", errorMessage: null });
    try {
      const receipt = await this.api.cancel(reflectionId, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      await this.stopRecordingRecovery(reflectionId);
      if (!this.isCurrentWork(controller, generation)) return;
      this.update({
        state: receipt.status,
        operation: "loading",
        detail: null,
        errorMessage: null
      });
      await this.pollReflection(reflectionId, controller, generation);
      await this.refreshHistory();
    } catch (error) {
      this.handleWorkError(error, controller, generation, "取消没有完成，请稍后再试。");
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly delete = async (): Promise<void> => {
    if (this.snapshot.auth.status !== "authenticated" || !this.snapshot.reflectionId) return;
    const reflectionId = this.snapshot.reflectionId;
    this.fenceRecordingUpload(reflectionId);
    const { controller, generation } = this.beginWork();
    this.update({ operation: "deleting", errorMessage: null });
    try {
      await this.api.delete(reflectionId, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
      await this.stopRecordingRecovery(reflectionId);
      if (!this.isCurrentWork(controller, generation)) return;
      this.clearFinalizeAttempt(reflectionId);
      this.clearOperationReceipt(reflectionId);
      for (const candidate of this.snapshot.detail?.candidates ?? []) {
        this.clearRevocationAttempt(reflectionId, candidate.id);
      }
      this.update({ history: this.snapshot.history.filter((item) => item.id !== reflectionId) });
      this.resetWorkflow(true, false);
      await this.refreshHistory();
    } catch (error) {
      this.handleWorkError(error, controller, generation, "删除没有完成，请稍后再试。");
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly logout = async (): Promise<void> => {
    this.uploadController?.abort();
    this.uploadController = null;
    this.update({ recordingRecovery: null });
    const { controller, generation } = this.beginAuthentication();
    try {
      await this.api.logout(controller.signal);
      if (!this.isCurrentAuth(controller, generation)) return;
      this.resetWorkflow(true);
      this.update({ auth: { status: "anonymous" } });
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentAuth(controller, generation)) return;
      this.resetWorkflow(true);
      this.update({
        auth: isUnauthorized(error)
          ? { status: "anonymous" }
          : {
              status: "error",
              message: friendlyError(error, "暂时无法退出，请刷新后重试。")
            }
      });
    } finally {
      if (this.authController === controller) this.authController = null;
    }
  };

  dispose() {
    this.uploadController?.abort();
    this.uploadController = null;
    this.disposed = true;
    this.abortAuthentication();
    this.abortWork();
    this.abortHistory();
    this.listeners.clear();
  }

  private async stopRecordingRecovery(reflectionId: string) {
    const recovery = this.snapshot.recordingRecovery;
    if (!recovery || recovery.reflectionId !== reflectionId) return;
    this.releasedRecordingOperations.add(JSON.stringify([recovery.accountId, recovery.operationKey]));
    this.abortRecordingCheck();
    this.uploadController?.abort();
    this.uploadController = null;
    this.update({ recordingRecovery: null, selectedFile: null });
    this.clearPendingInputOperation();
    await this.recordingStorage.remove(recovery.accountId, recovery.operationKey).catch(() => undefined);
  }

  private fenceRecordingUpload(reflectionId: string) {
    if (this.snapshot.recordingRecovery?.reflectionId !== reflectionId) return;
    this.abortRecordingCheck();
    this.uploadController?.abort();
    this.uploadController = null;
  }

  detachView() {
    this.abortWork();
    this.abortHistory();
  }
}

// Client-only session continuity across product navigation. Authentication is
// revalidated on every mount; this instance is never shared by server requests.
let navigationSession: DailyReflectionSessionController | null = null;

export function useDailyReflectionSession(
  options: UseDailyReflectionSessionOptions = {}
): DailyReflectionSessionValue {
  const [controller] = useState(() => {
    if (!options.retainAcrossNavigation || typeof window === "undefined") {
      return new DailyReflectionSessionController(options);
    }
    navigationSession ??= new DailyReflectionSessionController(options);
    return navigationSession;
  });
  const [authenticationStarted, setAuthenticationStarted] = useState(false);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const initialReflectionId = options.initialReflectionId;

  useEffect(() => {
    void controller.initialize(initialReflectionId);
    // initialize synchronously enters checking before awaiting the current user.
    setAuthenticationStarted(true);
  }, [controller, initialReflectionId]);

  const retainAcrossNavigation = options.retainAcrossNavigation;
  useEffect(() => () => {
    if (retainAcrossNavigation) controller.detachView();
    else controller.dispose();
  }, [controller, retainAcrossNavigation]);

  return {
    ...snapshot,
    // A retained snapshot belongs to the previous mount. Do not expose its
    // account or anonymous redirect until this mount has begun revalidation.
    auth: authenticationStarted ? snapshot.auth : { status: "checking" },
    initialize: controller.initialize.bind(controller),
    setSelectedFile: controller.setSelectedFile,
    setSourceOrigin: controller.setSourceOrigin,
    setRecordingDate: controller.setRecordingDate,
    upload: controller.upload,
    uploadBrowserRecording: controller.uploadBrowserRecording,
    reload: controller.reload,
    refreshHistory: controller.refreshHistory,
    startNew: controller.startNew,
    preserveRecording: controller.preserveRecording,
    setRecordingRecoverySource: controller.setRecordingRecoverySource,
    setRecordingRecoveryFile: controller.setRecordingRecoveryFile,
    cancelRecordingUpload: controller.cancelRecordingUpload,
    discardRecordingDraft: controller.discardRecordingDraft,
    resumeRecording: controller.resumeRecording,
    retryRecordingUpload: controller.retryRecordingUpload,
    updateCandidate: controller.updateCandidate,
    updateCandidates: controller.updateCandidates,
    updateCard: controller.updateCard,
    updateCards: controller.updateCards,
    saveWorkingCard: controller.saveWorkingCard,
    archiveWorkingCard: controller.archiveWorkingCard,
    restoreWorkingCard: controller.restoreWorkingCard,
    removeWorkingCard: controller.removeWorkingCard,
    acceptAllCandidates: controller.acceptAllCandidates,
    createManualCandidate: controller.createManualCandidate,
    excludeCandidate: controller.excludeCandidate,
    finalize: controller.finalize,
    revokeCandidate: controller.revokeCandidate,
    retry: controller.retry,
    cancel: controller.cancel,
    delete: controller.delete,
    logout: controller.logout,
    dispose: controller.dispose.bind(controller)
  };
}
