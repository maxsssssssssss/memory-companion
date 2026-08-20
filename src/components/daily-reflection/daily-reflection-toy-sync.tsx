"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_TOY_SYNC_DESTINATION,
  applyToySyncReceipt,
  findToySyncStateRecord,
  isToySyncReceiptDurablyAccepted,
  recoverInterruptedToySyncUploads,
  reconcileToySyncState,
  scanToySyncDirectory,
  transitionToySyncState,
  type ToySyncDestination,
  type ToySyncScanResult,
  type ToySyncScannedRecording,
  type ToySyncState
} from "@/lib/client/daily-reflection-toy-sync";
import {
  createBrowserToySyncRuntime,
  createToySyncOperationKey,
  createToySyncUploadIdempotencyKey,
  type ToySyncRuntime,
  type ToySyncPermissionDirectoryHandle
} from "@/lib/client/daily-reflection-toy-sync-storage";
import type { ToyIngestionReceipt } from "@/lib/domain/date-companion";

import styles from "./daily-reflection.module.css";

type ToySyncViewState =
  | "checking"
  | "unsupported"
  | "disconnected"
  | "permission_required"
  | "opening_picker"
  | "scanning"
  | "connected"
  | "error";

export type DailyReflectionToySyncProps = Readonly<{
  accountId: string;
  busy?: boolean;
  onUpload(
    file: File,
    recordingDate: string,
    idempotencyKey: string
  ): Promise<boolean>;
  runtime?: ToySyncRuntime;
}>;

export type ToySyncUploadAttempt = Readonly<{
  operation?: ToySyncUploadOperation;
  acceptReceipt(receipt: ToyIngestionReceipt): Promise<boolean>;
  finish(receiptReceived: boolean): Promise<void>;
}>;

export type ToySyncUploadOperation = Readonly<{
  operationKey: string;
  destination: "date_companion";
  relationshipId: string;
}>;

export type ToySyncSelection = Readonly<{
  file: File;
  filename: string;
  duplicateKey: string;
  recordingDate: string;
  recordingDateLocked: boolean;
  beginUpload(recordingDate: string): Promise<ToySyncUploadAttempt>;
}>;

export type ToyAudioSyncProps = Readonly<{
  accountId: string;
  busy?: boolean;
  className?: string;
  destination?: ToySyncDestination;
  mode?: "upload" | "select";
  relationshipId?: string;
  onSelect?: (selection: ToySyncSelection) => void;
  onResolveReceipt?: (
    operation: ToySyncUploadOperation
  ) => Promise<ToyIngestionReceipt | null>;
  onUpload?: (
    file: File,
    recordingDate: string,
    idempotencyKey: string
  ) => Promise<boolean>;
  runtime?: ToySyncRuntime;
  selectedDuplicateKey?: string | null;
}>;

function localDateValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function suggestedRecordingDate(timestampMs: number): string {
  const suggested = localDateValue(new Date(timestampMs));
  const today = localDateValue();
  return suggested > today ? today : suggested;
}

function formatSuggestedDateTime(timestampMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestampMs));
}

function friendlyConnectionError(error: unknown): string | null {
  if (error instanceof DOMException && error.name === "AbortError") return null;
  if (
    error instanceof DOMException
    && ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(error.name)
  ) {
    return "没有获得读取录音的权限。请确认后重新连接。";
  }
  return "暂时无法读取玩偶录音。你仍可使用下方的手动上传。";
}

function hasMismatchedPendingToyAnchor(
  state: ToySyncState,
  relationshipId: string
): boolean {
  return state.records.some((record) => (
    Boolean(record.operationKey)
    && Boolean(record.relationshipId)
    && record.relationshipId !== relationshipId
    && record.receiptStatus !== "completed"
  ));
}

const TOY_RELATIONSHIP_RECOVERY_MESSAGE =
  "这条未完成的录音属于另一段关系。请切回原来的关系后恢复，系统不会把它导入当前关系。";

export function ToyAudioSync({
  accountId,
  busy = false,
  className,
  destination = DEFAULT_TOY_SYNC_DESTINATION,
  mode = "upload",
  relationshipId,
  onSelect,
  onResolveReceipt,
  onUpload,
  runtime: providedRuntime,
  selectedDuplicateKey = null
}: ToyAudioSyncProps) {
  const [runtime, setRuntime] = useState<ToySyncRuntime | null>(
    providedRuntime ?? null
  );
  const [viewState, setViewState] = useState<ToySyncViewState>("checking");
  const [scanResult, setScanResult] = useState<ToySyncScanResult | null>(null);
  const [syncState, setSyncState] = useState<ToySyncState | null>(null);
  const [recordingDates, setRecordingDates] = useState<Record<string, string>>({});
  const [editingDateKey, setEditingDateKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const recordScope = useMemo(() => (
    destination === "date_companion" && relationshipId
      ? { relationshipId }
      : undefined
  ), [destination, relationshipId]);
  const directoryRef = useRef<ToySyncPermissionDirectoryHandle | null>(null);
  const syncStateRef = useRef<ToySyncState | null>(null);
  const activeRef = useRef(true);
  const persistenceScope = `${accountId}:${destination}:${relationshipId ?? ""}`;
  const accountRef = useRef(persistenceScope);
  const accountGenerationRef = useRef(0);
  const connectingRef = useRef<string | null>(null);
  const inFlightUploadsRef = useRef(new Set<string>());
  if (accountRef.current !== persistenceScope) {
    accountRef.current = persistenceScope;
    accountGenerationRef.current += 1;
  }
  const accountGeneration = accountGenerationRef.current;
  const scopeKey = `${accountGeneration}:${persistenceScope}`;
  const isCurrentScope = useCallback(() => activeRef.current
    && accountRef.current === persistenceScope
    && accountGenerationRef.current === accountGeneration, [accountGeneration, persistenceScope]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (providedRuntime || runtime || typeof window === "undefined") return;
    setRuntime(createBrowserToySyncRuntime());
  }, [providedRuntime, runtime]);

  useEffect(() => {
    directoryRef.current = null;
    syncStateRef.current = null;
    connectingRef.current = null;
    setViewState("checking");
    setScanResult(null);
    setSyncState(null);
    setRecordingDates({});
    setEditingDateKey(null);
    setMessage(null);
  }, [accountId, destination, relationshipId, runtime]);

  const saveState = useCallback(async (nextState: ToySyncState) => {
    if (!runtime || !isCurrentScope()) return;
    await runtime.persistence.saveState(accountId, nextState, destination);
    if (!isCurrentScope()) return;
    syncStateRef.current = nextState;
    setSyncState(nextState);
  }, [accountId, destination, isCurrentScope, runtime]);

  const recoverStoredReceipts = useCallback(async (
    persistedState: ToySyncState
  ): Promise<ToySyncState> => {
    if (!runtime) return persistedState;
    let nextState = recoverInterruptedToySyncUploads(persistedState);
    if (onResolveReceipt && recordScope) {
      if (
        isCurrentScope()
        && hasMismatchedPendingToyAnchor(nextState, recordScope.relationshipId)
      ) {
        setMessage(TOY_RELATIONSHIP_RECOVERY_MESSAGE);
      }
      const candidates = nextState.records.filter((record) => (
        record.relationshipId === recordScope.relationshipId
        && Boolean(record.operationKey)
        && record.status !== "ignored"
        && record.receiptStatus !== "completed"
        && findToySyncStateRecord(nextState, record.duplicateKey, recordScope) === record
      ));
      for (const record of candidates) {
        try {
          const receipt = await onResolveReceipt({
            operationKey: record.operationKey!,
            destination: "date_companion",
            relationshipId: recordScope.relationshipId
          });
          if (!isCurrentScope()) return persistedState;
          if (receipt) {
            nextState = applyToySyncReceipt(nextState, record.duplicateKey, receipt);
          }
        } catch (error) {
          // Preserve the operation anchor. A failed recovery must never fall
          // back to an implicit audio POST.
          if (
            error instanceof Error
            && error.message === "toy_ingestion_relationship_mismatch"
            && isCurrentScope()
          ) {
            setMessage(TOY_RELATIONSHIP_RECOVERY_MESSAGE);
          }
        }
      }
    }
    if (!isCurrentScope()) return persistedState;
    await runtime.persistence.saveState(accountId, nextState, destination);
    if (isCurrentScope()) {
      syncStateRef.current = nextState;
      setSyncState(nextState);
    }
    return nextState;
  }, [accountId, destination, isCurrentScope, onResolveReceipt, recordScope, runtime]);

  const scan = useCallback(async (
    handle: ToySyncPermissionDirectoryHandle,
    options: { persistDirectory?: boolean; persistedState?: ToySyncState } = {}
  ) => {
    if (!runtime || !isCurrentScope()) return;
    setViewState("scanning");
    setMessage(null);
    try {
      const [result, persistedState] = await Promise.all([
        scanToySyncDirectory(handle),
        options.persistedState
          ? Promise.resolve(options.persistedState)
          : runtime.persistence.loadState(accountId, destination)
      ]);
      const recoveredState = options.persistedState
        ? persistedState
        : await recoverStoredReceipts(persistedState);
      let nextState = reconcileToySyncState(
        recoveredState,
        result.recordings,
        new Date().toISOString(),
        destination === "date_companion" && relationshipId
          ? { relationshipId }
          : undefined
      );
      if (recordScope && hasMismatchedPendingToyAnchor(nextState, recordScope.relationshipId)) {
        setMessage(TOY_RELATIONSHIP_RECOVERY_MESSAGE);
      }
      await runtime.persistence.saveState(accountId, nextState, destination);
      if (options.persistDirectory) {
        await runtime.persistence.saveDirectory(accountId, handle);
      }
      if (!isCurrentScope()) return;
      directoryRef.current = handle;
      syncStateRef.current = nextState;
      setSyncState(nextState);
      setScanResult(result);
      setRecordingDates((current) => {
        const next = { ...current };
        for (const recording of result.recordings) {
          const persistedDate = findToySyncStateRecord(
            nextState,
            recording.duplicateKey,
            recordScope
          )?.recordingDate;
          next[recording.duplicateKey] = persistedDate
            ?? next[recording.duplicateKey]
            ?? suggestedRecordingDate(recording.suggestedTimestampMs);
        }
        return next;
      });
      setViewState("connected");
    } catch (error) {
      if (!isCurrentScope()) return;
      setViewState("error");
      setMessage(friendlyConnectionError(error));
    }
  }, [accountId, destination, isCurrentScope, recordScope, recoverStoredReceipts, relationshipId, runtime]);

  useEffect(() => {
    if (!runtime) return;
    let cancelled = false;
    const initialize = async () => {
      let recoveredState: ToySyncState;
      try {
        const persistedState = await runtime.persistence.loadState(accountId, destination);
        recoveredState = await recoverStoredReceipts(persistedState);
      } catch (error) {
        if (!cancelled && isCurrentScope()) {
          setViewState("error");
          setMessage(friendlyConnectionError(error));
        }
        return;
      }
      if (cancelled || !isCurrentScope()) return;
      if (!runtime.isSupported()) {
        if (!cancelled && isCurrentScope()) setViewState("unsupported");
        return;
      }
      try {
        const handle = await runtime.persistence.loadDirectory(accountId);
        if (cancelled || !isCurrentScope()) return;
        if (!handle) {
          setViewState("disconnected");
          return;
        }
        directoryRef.current = handle;
        const permission = await runtime.queryPermission(handle);
        if (cancelled || !isCurrentScope()) return;
        if (permission === "granted") await scan(handle, { persistedState: recoveredState });
        else setViewState("permission_required");
      } catch (error) {
        if (cancelled || !isCurrentScope()) return;
        setViewState("error");
        setMessage(friendlyConnectionError(error));
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [accountId, destination, isCurrentScope, recoverStoredReceipts, runtime, scan]);

  const connect = async () => {
    if (!runtime || busy || connectingRef.current === scopeKey) return;
    connectingRef.current = scopeKey;
    setMessage(null);
    const existing = directoryRef.current;
    const cancelledViewState: ToySyncViewState = existing
      ? "permission_required"
      : "disconnected";
    setViewState("opening_picker");
    try {
      if (existing) {
        const permission = await runtime.requestPermission(existing);
        if (!isCurrentScope()) return;
        if (permission === "granted") {
          await scan(existing);
          return;
        }
        await runtime.persistence.clearDirectory(accountId);
        if (!isCurrentScope()) return;
        directoryRef.current = null;
        setViewState("disconnected");
        setMessage("请再次点击连接，并重新选择玩偶录音文件夹。");
        return;
      }
      const handle = await runtime.pickDirectory();
      if (!isCurrentScope()) return;
      await scan(handle, { persistDirectory: true });
    } catch (error) {
      if (!isCurrentScope()) return;
      const nextMessage = friendlyConnectionError(error);
      if (!nextMessage) {
        setViewState(cancelledViewState);
        return;
      }
      setViewState("error");
      setMessage(nextMessage);
    } finally {
      if (connectingRef.current === scopeKey) connectingRef.current = null;
    }
  };

  const replaceDirectory = async () => {
    if (!runtime || busy || connectingRef.current === scopeKey) return;
    const existing = directoryRef.current;
    if (!existing) {
      await connect();
      return;
    }
    connectingRef.current = scopeKey;
    setMessage(null);
    setViewState("opening_picker");
    try {
      const handle = await runtime.pickDirectory();
      if (!isCurrentScope()) return;
      await scan(handle, { persistDirectory: true });
    } catch (error) {
      if (!isCurrentScope()) return;
      const nextMessage = friendlyConnectionError(error);
      if (!nextMessage) {
        setViewState("connected");
        return;
      }
      setViewState("error");
      setMessage(nextMessage);
    } finally {
      if (connectingRef.current === scopeKey) connectingRef.current = null;
    }
  };

  const updateRecord = async (
    recording: ToySyncScannedRecording,
    status: "ignored" | "uploading" | "uploaded" | "failed",
    options: { errorMessage?: string; recordingDate?: string; operationKey?: string } = {},
    baseState: ToySyncState | null = syncStateRef.current
  ) => {
    if (!baseState) return null;
    const next = transitionToySyncState(
      baseState,
      recording.duplicateKey,
      status,
      { ...options, ...(recordScope ?? {}) }
    );
    await saveState(next);
    return next;
  };

  const ignore = async (recording: ToySyncScannedRecording) => {
    if (busy) return;
    try {
      await updateRecord(recording, "ignored");
    } catch {
      if (isCurrentScope()) {
        setMessage("暂时无法保存忽略状态，请稍后重试。不同步操作没有发生。");
      }
    }
  };

  const beginUpload = async (
    recording: ToySyncScannedRecording,
    recordingDate: string
  ): Promise<ToySyncUploadAttempt> => {
    const uploadLatchKey = `${scopeKey}:${recording.duplicateKey}`;
    const currentRecord = syncStateRef.current
      ? findToySyncStateRecord(syncStateRef.current, recording.duplicateKey, recordScope)
      : undefined;
    if (
      !currentRecord
      || busy
      || !["new", "failed"].includes(currentRecord.status)
      || inFlightUploadsRef.current.size > 0
    ) throw new Error("toy_sync_upload_unavailable");
    let operation: ToySyncUploadOperation | undefined;
    if (destination === "date_companion") {
      const scopedRelationshipId = relationshipId?.normalize("NFKC").trim();
      if (!scopedRelationshipId || currentRecord.relationshipId !== scopedRelationshipId) {
        throw new Error("toy_sync_relationship_scope_required");
      }
      const operationKey = currentRecord.operationKey ?? await createToySyncOperationKey({
        accountId,
        destination,
        relationshipId: scopedRelationshipId,
        duplicateKey: recording.duplicateKey
      });
      operation = {
        operationKey,
        destination,
        relationshipId: scopedRelationshipId
      };
    }
    inFlightUploadsRef.current.add(uploadLatchKey);
    let workingState: ToySyncState;
    try {
      const nextState = await updateRecord(recording, "uploading", {
        recordingDate,
        ...(operation ? { operationKey: operation.operationKey } : {})
      });
      if (!nextState) throw new Error("toy_sync_state_unavailable");
      workingState = nextState;
    } catch (error) {
      inFlightUploadsRef.current.delete(uploadLatchKey);
      throw error;
    }
    let finished = false;
    let finishPromise: Promise<void> | null = null;
    return {
      ...(operation ? { operation } : {}),
      async acceptReceipt(receipt) {
        workingState = applyToySyncReceipt(
          workingState,
          recording.duplicateKey,
          receipt
        );
        await saveState(workingState);
        const durable = isToySyncReceiptDurablyAccepted(receipt);
        if (durable) {
          finished = true;
          inFlightUploadsRef.current.delete(uploadLatchKey);
        }
        return durable;
      },
      async finish(receiptReceived) {
        if (finished) return;
        if (finishPromise) return finishPromise;
        finishPromise = (async () => {
          const workingRecord = findToySyncStateRecord(
            workingState,
            recording.duplicateKey,
            recordScope
          );
          if (!receiptReceived && workingRecord?.status === "failed") {
            finished = true;
            return;
          }
          workingState = await updateRecord(
            recording,
            receiptReceived ? "uploaded" : "failed",
            receiptReceived ? {} : { errorMessage: "上传没有完成，请重试。" },
            workingState
          ) ?? workingState;
          finished = true;
        })();
        try {
          await finishPromise;
        } finally {
          if (finished) {
            inFlightUploadsRef.current.delete(uploadLatchKey);
          } else {
            finishPromise = null;
          }
        }
      }
    };
  };

  const selectRecording = (recording: ToySyncScannedRecording) => {
    const currentRecord = syncStateRef.current
      ? findToySyncStateRecord(syncStateRef.current, recording.duplicateKey, recordScope)
      : undefined;
    const recordingDate = currentRecord?.recordingDate
      ?? recordingDates[recording.duplicateKey];
    if (!currentRecord || !recordingDate || !onSelect) return;
    setMessage(null);
    onSelect({
      file: recording.file,
      filename: recording.filename,
      duplicateKey: recording.duplicateKey,
      recordingDate,
      recordingDateLocked: Boolean(currentRecord.recordingDate),
      beginUpload: (confirmedDate) => beginUpload(recording, confirmedDate)
    });
  };

  const upload = async (recording: ToySyncScannedRecording) => {
    const currentRecord = syncStateRef.current
      ? findToySyncStateRecord(syncStateRef.current, recording.duplicateKey, recordScope)
      : undefined;
    if (!currentRecord || !onUpload) return;
    const recordingDate = currentRecord.recordingDate
      ?? recordingDates[recording.duplicateKey];
    if (!recordingDate) {
      setEditingDateKey(recording.duplicateKey);
      setMessage("请先确认这条录音发生的日期。");
      return;
    }
    setMessage(null);
    let attempt: ToySyncUploadAttempt | null = null;
    try {
      attempt = await beginUpload(recording, recordingDate);
      const idempotencyKey = await createToySyncUploadIdempotencyKey(recording.duplicateKey);
      const receiptReceived = await onUpload(recording.file, recordingDate, idempotencyKey);
      await attempt.finish(receiptReceived);
    } catch {
      await attempt?.finish(false).catch(() => undefined);
      if (isCurrentScope()) {
        setMessage("上传没有完成。这条录音仍保留在玩偶中，可以重试。");
      }
    }
  };

  const rows = useMemo(() => {
    if (!scanResult || !syncState) return [];
    return scanResult.recordings.map((recording) => ({
      recording,
      state: findToySyncStateRecord(syncState, recording.duplicateKey, recordScope)
    })).filter((row) => Boolean(row.state));
  }, [recordScope, scanResult, syncState]);
  const newCount = rows.filter((row) => row.state?.status === "new").length;
  const latestKey = scanResult?.recordings[0]?.duplicateKey ?? null;
  const selectionMode = mode === "select";
  const titleId = `toy-audio-sync-title-${destination}`;
  const presentation = selectionMode
    ? {
        eyebrow: "玩偶录音",
        title: "从玩偶选择这次相处",
        scope: "这里只选择录音并带回当前上传表单，不会自动上传，也不会判断人物、自我、对方或说话人身份。"
      }
    : {
        eyebrow: "玩偶录音",
        title: "连接玩偶录音",
        scope: "此入口当前仅用于“我自己的复盘”。包含他人真实交流时，请使用下方手动上传并选择正确来源。"
      };

  return (
    <section
      className={`${styles.uploadCard} ${styles.toySyncCard}${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
    >
      <div className={styles.toySyncHeader}>
        <div>
          <p className={styles.eyebrow}>{presentation.eyebrow}</p>
          <h2 id={titleId}>{presentation.title}</h2>
        </div>
        {viewState === "connected" ? <span className={styles.toyConnectedBadge}>已连接玩偶</span> : null}
      </div>
      <p className={styles.cardLead}>
        第一次由你选择玩偶录音文件夹。以后打开本页时，只在已有授权仍有效时检查新录音；关闭页面后不会继续同步。
      </p>
      <p className={styles.toyScopeNote}>
        {presentation.scope}
      </p>

      {viewState === "checking" ? <p role="status">正在检查是否连接过玩偶…</p> : null}
      {viewState === "unsupported" ? (
        <div className={styles.toyCompatibility} role="status">
          <b>当前浏览器暂不支持连接玩偶。</b>
          <p>请使用最新版 Chrome 或 Edge，或继续使用下方“上传已有录音”。</p>
        </div>
      ) : null}
      {viewState === "opening_picker" ? (
        <div className={styles.toyCompatibility} role="status">
          <b>正在打开文件夹选择器…</b>
          <p>如果没有看到选择窗口，请确认正在使用最新版 Chrome 或 Edge。</p>
        </div>
      ) : null}
      {["disconnected", "permission_required", "error"].includes(viewState) ? (
        <button className={styles.primaryButton} disabled={busy} onClick={() => void connect()} type="button">
          {viewState === "permission_required" ? "重新连接玩偶" : "连接玩偶"}
        </button>
      ) : null}
      {viewState === "scanning" ? <p role="status">正在检查新的录音…</p> : null}
      {message ? <p className={styles.inlineError} role="alert">{message}</p> : null}

      {viewState === "connected" && scanResult ? (
        <div className={styles.toySyncResults}>
          <div className={styles.toySyncSummary} role="status">
            <b>发现 {scanResult.recordings.length} 条录音</b>
            <span>{newCount > 0 ? `发现新的录音 ${newCount} 条` : "暂时没有新的录音"}</span>
            <div className={styles.toySyncSummaryActions}>
              <button className={styles.quietButton} disabled={busy} onClick={() => {
                const handle = directoryRef.current;
                if (handle) void scan(handle);
              }} type="button">检查新录音</button>
              <button className={styles.quietButton} disabled={busy} onClick={() => void replaceDirectory()} type="button">
                重新选择文件夹
              </button>
            </div>
          </div>
          {scanResult.recordings.some((recording) => !recording.timestampReliable) ? (
            <p className={styles.toyTimestampWarning}>
              {selectionMode
                ? "录音日期会按文件信息自动填写；复制或移动录音可能改变这个日期。"
                : "建议时间来自文件信息，复制或移动录音可能改变它；上传前请确认日期。"}
            </p>
          ) : null}
          {scanResult.unreadableFileCount > 0 ? (
            <p className={styles.toyTimestampWarning}>
              有 {scanResult.unreadableFileCount} 个文件暂时无法读取，其他录音仍可继续处理。
            </p>
          ) : null}
          {rows.length === 0 ? <p>这个文件夹中还没有可用录音。</p> : (
            <ol className={styles.toyRecordingList}>
              {rows.map(({ recording, state }) => {
                if (!state) return null;
                const editingDate = editingDateKey === recording.duplicateKey;
                const lockedDate = state.recordingDate;
                const date = lockedDate ?? recordingDates[recording.duplicateKey] ?? "";
                const canUpload = state.status === "new" || state.status === "failed";
                const selected = selectedDuplicateKey === recording.duplicateKey;
                return (
                  <li className={styles.toyRecordingCard} key={recording.duplicateKey}>
                    <div className={styles.toyRecordingTop}>
                      <div>
                        <b>{recording.filename}</b>
                      </div>
                      {recording.duplicateKey === latestKey ? <span className={styles.toyLatestBadge}>最新录音</span> : null}
                    </div>
                    <p>建议时间：{formatSuggestedDateTime(recording.suggestedTimestampMs)}</p>
                    {!selectionMode && editingDate ? (
                      <label className={styles.dateField}>
                        <span>录音发生在</span>
                        <input
                          aria-label={`${recording.filename} 的录音日期`}
                          max={localDateValue()}
                          onChange={(event) => setRecordingDates((current) => ({
                            ...current,
                            [recording.duplicateKey]: event.target.value
                          }))}
                          required
                          type="date"
                          value={date}
                        />
                      </label>
                    ) : !selectionMode ? <p>录音日期：{date}</p> : null}
                    {lockedDate ? (
                      <p className={styles.toyLockedDate}>
                        {selectionMode
                          ? "重试会沿用第一次上传时记录的录音日期。"
                          : "重试会沿用第一次确认的日期。"}
                      </p>
                    ) : null}
                    {state.status === "failed" ? (
                      <p className={styles.inlineError}>{state.errorMessage ?? "上传没有完成，可以重试。"}</p>
                    ) : null}
                    <div className={styles.toyRecordingActions}>
                      {canUpload ? (
                        selectionMode ? (
                          <button
                            className={styles.primaryButton}
                            disabled={busy || !date || !onSelect}
                            onClick={() => selectRecording(recording)}
                            type="button"
                          >{selected ? "已选择这条录音" : "选择这条录音"}</button>
                        ) : (
                          <button
                            className={styles.primaryButton}
                            disabled={busy || !date || !onUpload}
                            onClick={() => void upload(recording)}
                            type="button"
                          >{state.status === "failed" ? "重试上传" : "作为我的复盘上传"}</button>
                        )
                      ) : null}
                      {state.status === "uploading" ? <span role="status">正在上传…</span> : null}
                      {state.status === "uploaded" ? (
                        <span className={styles.toyStateLabel}>
                          {state.receiptStatus === "completed"
                            ? "整理完成"
                            : state.receiptStatus === "failed"
                                ? "录音已收到，整理未完成"
                                : state.receiptId
                                  ? "录音已收到，正在整理"
                                  : "录音已收到"}
                        </span>
                      ) : null}
                      {state.status === "ignored" ? <span className={styles.toyStateLabel}>已忽略</span> : null}
                      {canUpload && !lockedDate && !selectionMode ? (
                        <button
                          className={styles.secondaryButton}
                          onClick={() => setEditingDateKey(editingDate ? null : recording.duplicateKey)}
                          type="button"
                        >{editingDate ? "确认日期" : "修改日期"}</button>
                      ) : null}
                      {canUpload && !selected ? (
                        <button className={styles.quietButton} disabled={busy} onClick={() => void ignore(recording)} type="button">忽略</button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function DailyReflectionToySync(props: DailyReflectionToySyncProps) {
  return (
    <ToyAudioSync
      {...props}
      destination="daily_reflection"
      mode="upload"
    />
  );
}
