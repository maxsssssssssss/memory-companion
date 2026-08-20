"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type {
  AuthState,
  DateCompanionConfirmedPerson
} from "@/lib/domain/date-companion";
import type {
  DailyReflectionCandidateDecision,
  DailyReflectionDetailResponse,
  DailyReflectionHistoryItem
} from "@/lib/domain/daily-reflection-api";
import type { DailyReflectionStatus, SourceOrigin } from "@/lib/domain/daily-reflection";

import {
  DailyReflectionApiError,
  createDailyReflectionApi,
  type DailyReflectionApi
} from "./daily-reflection-api";

export type DailyReflectionUploadSource = Extract<
  SourceOrigin,
  "user_reflection" | "direct_conversation" | "unknown"
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
  | "finalizing"
  | "revoking_candidate";

export type DailyReflectionUploadOptions = Readonly<{
  idempotencyKey?: string;
  inputAdapter?: "toy_sync";
}>;

export type DailyReflectionPeopleState = "idle" | "loading" | "ready" | "error";
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
  confirmedPeople: DateCompanionConfirmedPerson[];
  peopleState: DailyReflectionPeopleState;
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
  createFinalizeIdempotencyKey?: () => string;
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
    idempotencyKey: string
  ): Promise<void>;
  reload(reflectionId?: string | null): Promise<void>;
  refreshHistory(): Promise<void>;
  startNew(): void;
  updateCandidate(decision: DailyReflectionCandidateDecision): Promise<void>;
  finalize(): Promise<void>;
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
  confirmedPeople: [],
  peopleState: "idle",
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

function defaultFinalizeIdempotencyKey(): string {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `daily-reflection-finalize-${id}`;
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
  idempotencyKey: string;
}>;

type RevocationAttempt = Readonly<{
  reflectionId: string;
  candidateId: string;
  accountId: string;
  expectedVersion: number;
  idempotencyKey: string;
}>;

const FINALIZE_ATTEMPT_STORAGE_PREFIX = "daily-reflection:finalize:v1";
const REVOCATION_ATTEMPT_STORAGE_PREFIX = "daily-reflection:revoke:v1";
const STALE_MESSAGE = "这份复盘已经在其他页面更新，请重新加载最新内容。";

function finalizeAttemptStorageKey(accountId: string, reflectionId: string): string {
  return `${FINALIZE_ATTEMPT_STORAGE_PREFIX}:${encodeURIComponent(accountId)}:${encodeURIComponent(reflectionId)}`;
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
      || typeof parsed.idempotencyKey !== "string"
      || !parsed.idempotencyKey.trim()
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
  private readonly createFinalizeIdempotencyKey: () => string;
  private readonly createRevocationIdempotencyKey: () => string;
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  private readonly onReflectionIdChange?: (reflectionId: string | null) => void;
  private readonly listeners = new Set<() => void>();
  private snapshot: DailyReflectionSessionSnapshot = { ...INITIAL_SNAPSHOT };
  private authController: AbortController | null = null;
  private workController: AbortController | null = null;
  private peopleController: AbortController | null = null;
  private historyController: AbortController | null = null;
  private authGeneration = 0;
  private workGeneration = 0;
  private peopleGeneration = 0;
  private historyGeneration = 0;
  private finalizeAttempt: FinalizeAttempt | null = null;
  private revocationAttempt: RevocationAttempt | null = null;
  private disposed = false;

  constructor(options: DailyReflectionSessionOptions = {}) {
    this.api = options.api ?? createDailyReflectionApi();
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 1_200);
    this.createIdempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
    this.createFinalizeIdempotencyKey = options.createFinalizeIdempotencyKey
      ?? defaultFinalizeIdempotencyKey;
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
      ...(clearAccountData
        ? {
            confirmedPeople: [],
            peopleState: "idle" as const,
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

  private abortPeople() {
    this.peopleController?.abort();
    this.peopleController = null;
    this.peopleGeneration += 1;
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
    this.abortPeople();
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

  private beginPeople(): { controller: AbortController; generation: number } {
    this.abortPeople();
    const controller = new AbortController();
    const generation = this.peopleGeneration;
    this.peopleController = controller;
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

  private isCurrentPeople(controller: AbortController, generation: number): boolean {
    return !this.disposed
      && this.peopleController === controller
      && this.peopleGeneration === generation
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
    this.abortPeople();
    this.abortHistory();
    this.resetWorkflow(true);
    this.update({ auth: { status: "anonymous" } });
  }

  private authenticatedAccountId(): string | null {
    return this.snapshot.auth.status === "authenticated"
      ? this.snapshot.auth.user.id
      : null;
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
    if (detail.confirmation?.idempotencyKey === attempt.idempotencyKey) {
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

  private async loadConfirmedPeople(): Promise<void> {
    if (this.snapshot.auth.status !== "authenticated") return;
    const { controller, generation } = this.beginPeople();
    this.update({ peopleState: "loading" });
    try {
      const people = await this.api.listConfirmedPeople(controller.signal);
      if (!this.isCurrentPeople(controller, generation)) return;
      this.update({ confirmedPeople: people, peopleState: "ready" });
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentPeople(controller, generation)) return;
      if (isUnauthorized(error)) {
        this.expireAuthentication();
        return;
      }
      this.update({ confirmedPeople: [], peopleState: "error" });
    } finally {
      if (this.peopleController === controller) this.peopleController = null;
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
    if (detail.reflection.status === "review_pending") {
      await this.loadConfirmedPeople();
    }
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
      const reflectionId = normalizeReflectionId(initialReflectionId);
      await Promise.all([
        this.refreshHistory(),
        this.loadConfirmedPeople(),
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
    this.updateReflectionId(null);
    this.update({
      state: "uploading",
      operation: "uploading",
      detail: null,
      selectedFile: file,
      sourceOrigin,
      recordingDate,
      errorMessage: null
    });
    try {
      const receipt = await this.api.upload({
        file,
        sourceOrigin,
        recordingDate,
        idempotencyKey: options.idempotencyKey ?? this.createIdempotencyKey(),
        ...(options.inputAdapter ? { inputAdapter: options.inputAdapter } : {})
      }, controller.signal);
      receiptReceived = true;
      if (!this.isCurrentWork(controller, generation)) return receiptReceived;
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
    idempotencyKey: string
  ): Promise<void> => {
    if (this.snapshot.auth.status !== "authenticated") return;
    const { controller, generation } = this.beginWork();
    this.updateReflectionId(null);
    this.update({
      state: "uploading",
      operation: "uploading",
      detail: null,
      selectedFile: file,
      sourceOrigin: "user_reflection",
      recordingDate,
      errorMessage: null
    });
    try {
      const receipt = await this.api.uploadBrowserRecording({
        file,
        idempotencyKey,
        recordingDate,
        ...(clientReportedDurationMs === undefined || clientReportedDurationMs === 0
          ? {}
          : { clientReportedDurationMs })
      }, controller.signal);
      if (!this.isCurrentWork(controller, generation)) return;
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

  readonly updateCandidate = async (
    decision: DailyReflectionCandidateDecision
  ): Promise<void> => {
    const detail = this.snapshot.detail;
    if (
      this.snapshot.auth.status !== "authenticated"
      || !this.snapshot.reflectionId
      || !detail
      || detail.reflection.status !== "review_pending"
      || this.snapshot.operation !== "idle"
    ) return;
    if (decision.status !== "kept" && decision.subjectPersonId !== null) {
      this.update({ errorMessage: "只有选择记住的内容才能关联人物。" });
      return;
    }
    const reflectionId = this.snapshot.reflectionId;
    const { controller, generation } = this.beginWork();
    this.update({
      operation: "saving_candidate",
      activeCandidateId: decision.candidateId,
      errorMessage: null
    });
    try {
      await this.api.updateCandidates(reflectionId, {
        expectedVersion: detail.reflection.version,
        candidates: [decision]
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
        const saved = current.candidates.find((candidate) => candidate.id === decision.candidateId);
        const savedText = saved?.userText ?? null;
        if (
          saved?.status === decision.status
          && savedText === decision.userText
          && saved.subjectPersonId === decision.subjectPersonId
        ) return;
        this.update({
          operation: "idle",
          activeCandidateId: null,
          errorMessage: friendlyError(error, "这条内容没有保存成功，请稍后再试。")
        });
      } catch (refreshError) {
        if (isUnauthorized(refreshError)) this.expireAuthentication();
        else if (!isAbortError(refreshError) && this.isCurrentWork(controller, generation)) {
          this.update({
            operation: "idle",
            activeCandidateId: null,
            errorMessage: friendlyError(error, "这条内容没有保存成功，请稍后再试。")
          });
        }
      }
    } finally {
      if (this.workController === controller) this.workController = null;
    }
  };

  readonly finalize = async (): Promise<void> => {
    const detail = this.snapshot.detail;
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
    if (
      detail.reflection.status === "review_pending"
      && detail.candidates.some((candidate) => candidate.status === "pending")
    ) {
      this.update({ errorMessage: "还有内容没有选择是否记住，请先完成确认。" });
      return;
    }
    const reflectionId = this.snapshot.reflectionId;
    const existingAttempt = this.readFinalizeAttempt(reflectionId);
    if (detail.reflection.status === "admission_failed" && !existingAttempt) {
      this.update({
        errorMessage: "这次确认的安全重试信息已失效，请保留这条复盘并稍后再试。"
      });
      return;
    }
    const attempt = existingAttempt ?? {
      reflectionId,
      accountId,
      expectedVersion: detail.reflection.version,
      idempotencyKey: this.createFinalizeIdempotencyKey()
    };
    this.writeFinalizeAttempt(attempt);
    const { controller, generation } = this.beginWork();
    this.update({ operation: "finalizing", activeCandidateId: null, errorMessage: null });
    try {
      await this.api.finalize(reflectionId, {
        expectedVersion: attempt.expectedVersion,
        idempotencyKey: attempt.idempotencyKey
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
          if (current.confirmation?.idempotencyKey === attempt.idempotencyKey) {
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
        if (current.confirmation?.idempotencyKey === attempt.idempotencyKey) {
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
    this.abortPeople();
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
    finalize: controller.finalize,
    revokeCandidate: controller.revokeCandidate,
    retry: controller.retry,
    cancel: controller.cancel,
    delete: controller.delete,
    logout: controller.logout,
    dispose: controller.dispose.bind(controller)
  };
}
