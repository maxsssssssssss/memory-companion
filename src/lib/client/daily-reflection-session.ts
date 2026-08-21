"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { AuthState } from "@/lib/domain/date-companion";
import type {
  DailyReflectionCardDecision,
  DailyReflectionCandidateDecision,
  DailyReflectionDetailResponse,
  DailyReflectionHistoryItem
} from "@/lib/domain/daily-reflection-api";
import type {
  DailyReflectionStatus,
  DailyReflectionV2Input
} from "@/lib/domain/daily-reflection";

import {
  DailyReflectionApiError,
  DailyReflectionOperationReceiptSchema,
  createDailyReflectionApi,
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
  | "creating_candidate"
  | "excluding_candidate"
  | "finalizing"
  | "revoking_candidate";

export type DailyReflectionUploadOptions = Readonly<{
  operationKey?: string;
  inputAdapter?: DailyReflectionV2Input["inputAdapter"];
}>;

export type DailyReflectionHistoryState = "idle" | "loading" | "ready" | "error";

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
  errorMessage: string | null;
};

export type DailyReflectionSessionOptions = {
  api?: DailyReflectionApi;
  pollIntervalMs?: number;
  createIdempotencyKey?: () => string;
  createRevocationIdempotencyKey?: () => string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  onReflectionIdChange?: (reflectionId: string | null) => void;
};

export type UseDailyReflectionSessionOptions = DailyReflectionSessionOptions & {
  initialReflectionId?: string | null;
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
  updateCandidate(decision: DailyReflectionCandidateDecision): Promise<void>;
  updateCandidates(decisions: readonly DailyReflectionCandidateDecision[]): Promise<void>;
  updateCard(decision: DailyReflectionCardDecision): Promise<void>;
  updateCards(decisions: readonly DailyReflectionCardDecision[]): Promise<void>;
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
  errorMessage: null
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

  constructor(options: DailyReflectionSessionOptions = {}) {
    this.api = options.api ?? createDailyReflectionApi();
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 1_200);
    this.createIdempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
    this.createRevocationIdempotencyKey = options.createRevocationIdempotencyKey
      ?? defaultRevocationIdempotencyKey;
    this.storage = options.storage === undefined
      ? (typeof window === "undefined" ? null : window.localStorage)
      : options.storage;
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
      errorMessage: null,
      ...(resetForm
        ? { selectedFile: null, sourceOrigin: null, recordingDate: "" }
        : {})
    };
    for (const listener of this.listeners) listener();
    if (changed) this.onReflectionIdChange?.(null);
  }

  private abortAuthentication() {
    this.authController?.abort();
    this.authController = null;
    this.authGeneration += 1;
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
    this.abortAuthentication();
    this.abortWork();
    this.abortHistory();
    this.resetWorkflow(true);
    this.update({ auth: { status: "anonymous" } });
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
    if (!result.found) {
      this.clearPendingInputOperation();
      return null;
    }
    if (result.status === "deleted" || result.status === "cancelled") {
      this.clearPendingInputOperation();
      this.update({
        state: result.status,
        operation: "idle",
        errorMessage: result.status === "deleted"
          ? "这次上传对应的复盘已删除，不会重新创建。"
          : "这次上传对应的复盘已取消，不会重新创建。"
      });
      return null;
    }
    this.writePendingInputOperation({ ...pending, reflectionId: result.reflectionId });
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
    const { controller, generation } = this.beginAuthentication();
    this.update({ auth: { status: "checking" }, errorMessage: null });
    try {
      const user = await this.api.getCurrentUser(controller.signal);
      if (!this.isCurrentAuth(controller, generation)) return;
      if (!user) {
        this.resetWorkflow(true);
        this.update({ auth: { status: "anonymous" } });
        return;
      }
      this.update({ auth: { status: "authenticated", user } });
      const requestedReflectionId = normalizeReflectionId(initialReflectionId);
      const reflectionId = requestedReflectionId
        ?? await this.lookupPendingInputOperation(controller.signal);
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
    if (this.snapshot.auth.status !== "authenticated") return;
    const { controller, generation } = this.beginWork();
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
        inputAdapter: "browser_recorder",
        sourceOrigin,
        recordingDate
      });
      const receipt = await this.api.uploadBrowserRecording({
        file,
        operationKey,
        recordingDate,
        inputAdapter: "browser_recorder",
        sourceOrigin,
        capturePurpose: "inspiration_capture",
        ...(clientReportedDurationMs === undefined || clientReportedDurationMs === 0
          ? {}
          : { clientReportedDurationMs })
      }, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
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
            this.updateReflectionId(recoveredId);
            this.update({ state: "loading", operation: "loading", errorMessage: null });
            await this.pollReflection(recoveredId, controller, generation);
            await this.refreshHistory();
            return;
          }
        } catch (recoveryError) {
          if (isUnauthorized(recoveryError)) this.expireAuthentication();
        }
      }
      if (error instanceof DailyReflectionApiError && error.status >= 400 && error.status < 500) {
        this.clearPendingInputOperation();
      }
      this.handleWorkError(
        error,
        controller,
        generation,
        "录音没有提交成功，请稍后重试。"
      );
    } finally {
      if (this.workController === controller) this.workController = null;
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
    this.abortWork();
    this.resetWorkflow(true, false);
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
    const { controller, generation } = this.beginWork();
    this.update({ operation: "cancelling", errorMessage: null });
    try {
      const receipt = await this.api.cancel(reflectionId, controller.signal);
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
    const { controller, generation } = this.beginWork();
    this.update({ operation: "deleting", errorMessage: null });
    try {
      await this.api.delete(reflectionId, controller.signal);
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
    this.disposed = true;
    this.abortAuthentication();
    this.abortWork();
    this.abortHistory();
    this.listeners.clear();
  }
}

export function useDailyReflectionSession(
  options: UseDailyReflectionSessionOptions = {}
): DailyReflectionSessionValue {
  const [controller] = useState(() => new DailyReflectionSessionController(options));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const initialReflectionId = options.initialReflectionId;

  useEffect(() => {
    void controller.initialize(initialReflectionId);
  }, [controller, initialReflectionId]);

  useEffect(() => () => controller.dispose(), [controller]);

  return {
    ...snapshot,
    initialize: controller.initialize.bind(controller),
    setSelectedFile: controller.setSelectedFile,
    setSourceOrigin: controller.setSourceOrigin,
    setRecordingDate: controller.setRecordingDate,
    upload: controller.upload,
    uploadBrowserRecording: controller.uploadBrowserRecording,
    reload: controller.reload,
    refreshHistory: controller.refreshHistory,
    startNew: controller.startNew,
    updateCandidate: controller.updateCandidate,
    updateCandidates: controller.updateCandidates,
    updateCard: controller.updateCard,
    updateCards: controller.updateCards,
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
