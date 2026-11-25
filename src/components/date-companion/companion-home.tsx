"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  ToyAudioSync,
  type ToySyncSelection,
  type ToySyncUploadAttempt
} from "@/components/daily-reflection/daily-reflection-toy-sync";
import type { ToySyncRuntime } from "@/lib/client/daily-reflection-toy-sync-storage";
import type { DateCompanionUploadOptions } from "@/lib/client/date-companion-session";
import type { DateCompanionHomeContentState } from "@/lib/client/date-companion-proactive-value";
import type {
  InteractionVM,
  SourceRefVM,
  ToyIngestionReceipt
} from "@/lib/domain/date-companion";
import type { DateCompanionToyUploadRequest } from "@/lib/client/date-companion-api";

import { BookHome, type BookHomeContext } from "./book-home";
import { bookHomeForm } from "./book-home-reading-state";

export type CompanionUploadPresentation = {
  status: "idle" | "uploading" | "processing" | "ready" | "failed";
  jobStatus?: string;
  progress?: number;
  errorMessage?: string;
  cacheErrorMessage?: string;
  cleanupWarningMessage?: string;
  failureStage?: "upload" | "read" | "processing" | "cache" | "relationship_import";
  hasReceipt?: boolean;
  uploadId?: string;
  fileName?: string;
  recordingDate?: string;
};

export type CompanionHomeProps = {
  book: BookHomeContext;
  currentInteraction: InteractionVM | null;
  homeContent?: DateCompanionHomeContentState;
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
  relationshipName?: string;
  relationshipId?: string;
  participantNotice?: string | null;
  participantReviewHref?: string;
  accountId?: string;
  toySyncEnabled?: boolean;
  toySyncRuntime?: ToySyncRuntime;
  uploadState: CompanionUploadPresentation;
  onRetryRead: () => Promise<void> | void;
  onResolveToyReceipt?: (
    request: DateCompanionToyUploadRequest
  ) => Promise<ToyIngestionReceipt | null>;
  onUpload: (
    file: File,
    recordingDate: string,
    options?: DateCompanionUploadOptions
  ) => Promise<boolean>;
};

const MAX_CLIENT_FILE_BYTES = 300 * 1024 * 1024;

function localDateValue(date = new Date()) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 10);
}

function clientFileSelectionError(file: File): string | null {
  return file.size > MAX_CLIENT_FILE_BYTES
    ? "文件超过 300MB，请选择较小的录音。服务端仍会执行最终校验。"
    : null;
}

function statusCopy(state: CompanionUploadPresentation) {
  if (state.status === "uploading") return "正在把这次相处交进来";
  if (state.status === "ready") return "这次相处已经整理好";
  if (state.status === "failed") return "这次整理没有完成";
  if (state.status !== "processing") return "";
  const labels: Record<string, string> = {
    uploaded: "录音已收到",
    waiting: "正在等待整理",
    processing: "正在整理录音",
    transcribing: "正在转成文字",
    extracting: "正在提取值得回看的片段"
  };
  return labels[state.jobStatus ?? ""] ?? "正在整理这次相处";
}

export function CompanionHome({
  book,
  currentInteraction,
  homeContent = { status: "empty" },
  onOpenSource,
  relationshipName,
  relationshipId,
  participantNotice,
  participantReviewHref,
  accountId,
  toySyncEnabled = false,
  toySyncRuntime,
  uploadState,
  onRetryRead,
  onResolveToyReceipt,
  onUpload
}: CompanionHomeProps) {
  const submitLatchRef = useRef(false);
  const previousUploadStatusRef = useRef(uploadState.status);
  const savedForm = bookHomeForm(book.scopeKey);
  const sourceReturnForm = savedForm?.uploadStateKey === JSON.stringify([uploadState.status,uploadState.uploadId]) ? savedForm : null;
  const [file, setFile] = useState<File | null>(() => sourceReturnForm?.file ?? null);
  const [recordingDate, setRecordingDate] = useState(() => sourceReturnForm?.recordingDate ?? localDateValue());
  const [fileError, setFileError] = useState<string | null>(() => sourceReturnForm?.fileError ?? null);
  const [toySelection, setToySelection] = useState<ToySyncSelection | null>(() => sourceReturnForm?.toySelection ?? null);
  const [bookFormOpen, setBookFormOpen] = useState(() => sourceReturnForm?.open ?? false);
  const displayName = relationshipName?.trim() || "Ta";
  const busy = uploadState.status === "uploading" || uploadState.status === "processing";
  const activeToySelection = toySelection?.file === file ? toySelection : null;
  const effectiveRecordingDate = activeToySelection?.recordingDate ?? recordingDate;

  useEffect(() => {
    const previousStatus = previousUploadStatusRef.current;
    previousUploadStatusRef.current = uploadState.status;
    if (uploadState.status === "ready" && previousStatus !== "ready") {
      setBookFormOpen(false);
      setFile(null);
      setToySelection(null);
      setFileError(null);
    }
  }, [uploadState.status]);

  const selectFile = (nextFile: File | null) => {
    setToySelection(null);
    if (!nextFile) {
      setFile(null);
      setFileError(null);
      return;
    }
    const validationError = clientFileSelectionError(nextFile);
    if (validationError) {
      setFile(null);
      setFileError(validationError);
      return;
    }
    setFile(nextFile);
    setFileError(null);
  };

  const selectToyRecording = (selection: ToySyncSelection) => {
    setBookFormOpen(true);
    const validationError = clientFileSelectionError(selection.file);
    if (validationError) {
      setFile(null);
      setToySelection(null);
      setFileError(validationError);
      return;
    }
    setToySelection(selection);
    setFile(selection.file);
    setFileError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !effectiveRecordingDate || busy || submitLatchRef.current) return;
    submitLatchRef.current = true;
    let toyAttempt: ToySyncUploadAttempt | null = null;
    let toyReceiptRecorded = false;
    try {
      if (activeToySelection) {
        toyAttempt = await activeToySelection.beginUpload(effectiveRecordingDate);
      }
      const receiptReceived = await onUpload(
        file,
        effectiveRecordingDate,
        toyAttempt
          ? {
              ...(toyAttempt.operation ? { toyOperation: toyAttempt.operation } : {}),
              onServerAccepted: async (receipt) => {
                if (receipt.ingestionReceipt) {
                  toyReceiptRecorded = await toyAttempt?.acceptReceipt(
                    receipt.ingestionReceipt
                  ) ?? false;
                } else {
                  await toyAttempt?.finish(true);
                  toyReceiptRecorded = true;
                }
              },
              onIngestionReceipt: async (receipt) => {
                toyReceiptRecorded = await toyAttempt?.acceptReceipt(receipt) ?? false;
              }
            }
          : undefined
      );
      if (!toyReceiptRecorded) await toyAttempt?.finish(receiptReceived);
      if (activeToySelection && receiptReceived) {
        setFile(current => current === file ? null : current);
        setToySelection(current => current?.file === file ? null : current);
      } else if (activeToySelection) {
        setToySelection((current) => current?.duplicateKey === activeToySelection.duplicateKey
          ? { ...current, recordingDateLocked: true }
          : current);
      }
    } catch {
      await toyAttempt?.finish(false).catch(() => undefined);
      if (activeToySelection && toyAttempt) {
        setToySelection((current) => current?.duplicateKey === activeToySelection.duplicateKey
          ? { ...current, recordingDateLocked: true }
          : current);
      }
      setFileError(activeToySelection ? "暂时无法提交这条玩偶录音，请保留文件并稍后重试。" : "上传没有完成，文件和日期已保留，请重试。");
    } finally {
      submitLatchRef.current = false;
    }
  };

  return <BookHome book={book} currentInteraction={currentInteraction} uploadState={uploadState}
    file={file} fileError={fileError} recordingDate={effectiveRecordingDate} dateMax={localDateValue()}
    toySelection={activeToySelection} open={bookFormOpen} onOpenChange={setBookFormOpen}
    onSelectFile={selectFile} onDate={setRecordingDate} onSubmit={submit}
    statusLabel={statusCopy(uploadState)} onRetryRead={onRetryRead}
    homeContent={homeContent} participantNotice={participantNotice} participantReviewHref={participantReviewHref} relationshipName={displayName}
    onOpenSource={onOpenSource}
    renderToy={toySyncEnabled && accountId && relationshipId ? (close) => <ToyAudioSync
      key={`${accountId}:date_companion:${relationshipId}`} accountId={accountId} relationshipId={relationshipId}
      busy={busy} destination="date_companion" mode="select"
      paperLoading
      onSelect={selection => { selectToyRecording(selection); close(); }}
      onResolveReceipt={onResolveToyReceipt} runtime={toySyncRuntime} selectedDuplicateKey={toySelection?.duplicateKey}
    /> : undefined} />;
}
