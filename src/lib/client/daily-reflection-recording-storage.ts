"use client";

import type { DailyReflectionUploadSource } from "./daily-reflection-session";

/** A transport backup only. Server receipts remain the workflow authority. */
export type ReflectionRecordingBackup = Readonly<{
  accountId: string;
  operationKey: string;
  file: File;
  sourceOrigin: DailyReflectionUploadSource | null;
  recordingDate: string;
  clientReportedDurationMs?: number;
  submitted?: boolean;
  inputAdapter?: "browser_recorder" | "file_picker";
}>;

export interface ReflectionRecordingStorage {
  load(accountId: string): Promise<ReflectionRecordingBackup | null>;
  save(backup: ReflectionRecordingBackup): Promise<void>;
  remove(accountId: string, operationKey: string): Promise<void>;
}

export function createReflectionRecordingStorage(): ReflectionRecordingStorage {
  async function transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore, result: (value: T) => void) => void
  ): Promise<T> {
    if (typeof indexedDB === "undefined") throw new Error("recording_storage_unavailable");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("daily-reflection-recording-recovery", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("recordings", { keyPath: "accountId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("recording_storage_unavailable"));
      request.onblocked = () => reject(new Error("recording_storage_blocked"));
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = database.transaction("recordings", mode);
        let value: T;
        tx.oncomplete = () => resolve(value);
        tx.onerror = tx.onabort = () => reject(new Error("recording_storage_failed"));
        action(tx.objectStore("recordings"), (result) => { value = result; });
      });
    } finally {
      database.close();
    }
  }
  return {
    load: (accountId) => transaction("readonly", (store, result) => {
      const request = store.get(accountId);
      request.onsuccess = () => {
        const row = request.result as ReflectionRecordingBackup | undefined;
        result(row?.accountId === accountId && row.file instanceof Blob && row.file.size > 0
          && typeof row.operationKey === "string" && row.operationKey.length > 0
          && (row.inputAdapter === undefined || row.inputAdapter === "browser_recorder" || row.inputAdapter === "file_picker")
          && /^\d{4}-\d{2}-\d{2}$/u.test(row.recordingDate)
          && (row.sourceOrigin === null || row.sourceOrigin === "user_reflection" || row.sourceOrigin === "direct_conversation")
          ? row : null);
      };
    }),
    save: (backup) => transaction("readwrite", (store) => {
      const request = store.get(backup.accountId);
      request.onsuccess = () => {
        // Another tab's unfinished recording must never be overwritten.
        if (request.result && request.result.operationKey !== backup.operationKey) store.transaction.abort();
        else store.put(backup);
      };
    }),
    remove: (accountId, operationKey) => transaction("readwrite", (store) => {
      const request = store.get(accountId);
      request.onsuccess = () => {
        if (request.result?.operationKey === operationKey) store.delete(accountId);
      };
    })
  };
}
