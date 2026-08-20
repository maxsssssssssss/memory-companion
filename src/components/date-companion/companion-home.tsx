"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  ToyAudioSync,
  type ToySyncSelection,
  type ToySyncUploadAttempt
} from "@/components/daily-reflection/daily-reflection-toy-sync";
import type { ToySyncRuntime } from "@/lib/client/daily-reflection-toy-sync-storage";
import type { DateCompanionUploadOptions } from "@/lib/client/date-companion-session";
import type {
  InteractionVM,
  RecapItemVM,
  ToyIngestionReceipt
} from "@/lib/domain/date-companion";
import type { DateCompanionToyUploadRequest } from "@/lib/client/date-companion-api";

import styles from "./date-companion.module.css";
import { LocalTimeGreeting } from "./local-time-greeting";

export type CompanionUploadPresentation = {
  status: "idle" | "uploading" | "processing" | "ready" | "failed";
  jobStatus?: string;
  progress?: number;
  errorMessage?: string;
  cacheErrorMessage?: string;
  cleanupWarningMessage?: string;
};

type CompanionHomeProps = {
  currentInteraction: InteractionVM | null;
  rememberedItem?: RecapItemVM | null;
  prepareItem?: RecapItemVM | null;
  recentItem?: RecapItemVM | null;
  relationshipName?: string;
  relationshipId?: string;
  participantNotice?: string | null;
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

function formatFileSize(bytes: number) {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
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

function rememberedText(item: RecapItemVM | null | undefined) {
  if (!item || item.disposition !== "kept" || item.sources.length === 0) return null;
  return item.displayedText.trim() || item.proposedText.trim() || null;
}

export function CompanionHome({
  currentInteraction,
  rememberedItem,
  prepareItem,
  recentItem,
  relationshipName,
  relationshipId,
  participantNotice,
  accountId,
  toySyncEnabled = false,
  toySyncRuntime,
  uploadState,
  onRetryRead,
  onResolveToyReceipt,
  onUpload
}: CompanionHomeProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const submitLatchRef = useRef(false);
  const previousUploadStatusRef = useRef(uploadState.status);
  const [file, setFile] = useState<File | null>(null);
  const [recordingDate, setRecordingDate] = useState(() => localDateValue());
  const [fileError, setFileError] = useState<string | null>(null);
  const [toySelection, setToySelection] = useState<ToySyncSelection | null>(null);
  const remembered = rememberedText(rememberedItem);
  const rememberedIsDirectQuote = Boolean(rememberedItem?.sources.length) && rememberedItem!.sources.every((source) => source.presentation === "direct_quote");
  const preparation = rememberedText(prepareItem);
  const recent = rememberedText(recentItem);
  const displayName = relationshipName?.trim() || "Ta";
  const busy = uploadState.status === "uploading" || uploadState.status === "processing";
  const hasUploadState = uploadState.status !== "idle";
  const activeToySelection = toySelection?.file === file ? toySelection : null;
  const effectiveRecordingDate = activeToySelection?.recordingDate ?? recordingDate;

  useEffect(() => {
    const previousStatus = previousUploadStatusRef.current;
    previousUploadStatusRef.current = uploadState.status;
    if (uploadState.status === "ready" && previousStatus !== "ready") {
      detailsRef.current?.removeAttribute("open");
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
    detailsRef.current?.setAttribute("open", "");
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
        setFile(null);
        setToySelection(null);
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
      setFileError("暂时无法提交这条玩偶录音，请保留文件并稍后重试。");
    } finally {
      submitLatchRef.current = false;
    }
  };

  return (
    <div className={styles.home}>
      <section className={styles.homeHero}>
        <LocalTimeGreeting className={styles.homeDate} />
        <h1>今天，有什么值得留在心里？</h1>
        <p>上传这次相处的完整录音。整理完成后，你可以查看复盘、完整文字稿和每条内容的来源。</p>

        <details className={styles.uploadDetails} ref={detailsRef}>
          <summary>
            <span className={styles.uploadMark} aria-hidden="true">↑</span>
            <span className={styles.uploadCopy}>
              <b>{hasUploadState ? statusCopy(uploadState) : "上传这次相处的录音"}</b>
              <small>{busy
                ? "可以离开抽屉，整理会继续"
                : uploadState.status === "ready"
                  ? "打开复盘查看完整文字稿和来源"
                  : uploadState.status === "failed"
                    ? uploadState.errorMessage || "打开查看失败详情"
                    : "从电脑选择完整录音，不会伪造上传百分比"}</small>
            </span>
            <span className={styles.uploadChevron} aria-hidden="true">⌄</span>
          </summary>

          <form className={styles.uploadPanel} onSubmit={submit} aria-label="上传相处录音">
            {toySyncEnabled && accountId && relationshipId ? (
              <ToyAudioSync
                accountId={accountId}
                busy={busy}
                className={styles.companionToySync}
                destination="date_companion"
                key={`${accountId}:date_companion`}
                mode="select"
                onSelect={selectToyRecording}
                onResolveReceipt={onResolveToyReceipt}
                relationshipId={relationshipId}
                runtime={toySyncRuntime}
                selectedDuplicateKey={toySelection?.duplicateKey}
              />
            ) : null}
            <label className={styles.filePicker}>
              <input
                accept="audio/*,.m4a,.mp3,.wav,.aac,.flac,.ogg,.opus,.mp4,.mov,.webm"
                disabled={busy}
                onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
                type="file"
              />
              <strong>{file ? "重新选择录音" : "选择一段完整录音"}</strong>
              <small>单个文件不超过 300MB</small>
            </label>

            {file ? (
              <div className={styles.selectedFile}>
                <b>{file.name}</b>
                <span>{activeToySelection ? "已从玩偶带入 · 录音日期已自动填写" : formatFileSize(file.size)}</span>
              </div>
            ) : null}
            {fileError ? <p className={styles.inlineError} role="alert">{fileError}</p> : null}

            {activeToySelection ? (
              <div className={styles.dateField}>
                <span>这次相处发生在</span>
                <time dateTime={activeToySelection.recordingDate}>{activeToySelection.recordingDate}</time>
              </div>
            ) : (
              <label className={styles.dateField}>
                <span>这次相处发生在</span>
                <input
                  disabled={busy}
                  max={localDateValue()}
                  onChange={(event) => setRecordingDate(event.target.value)}
                  required
                  type="date"
                  value={recordingDate}
                />
              </label>
            )}
            {activeToySelection && !activeToySelection.recordingDateLocked ? (
              <p className={styles.toyDateNote}>根据玩偶录音时间自动填写；手动上传文件时仍可自行选择日期。</p>
            ) : null}
            {activeToySelection?.recordingDateLocked ? (
              <p className={styles.toyDateNote}>这条录音正在重试，将沿用第一次上传时记录的录音日期。</p>
            ) : null}

            {uploadState.status !== "idle" ? (
              <div className={styles.uploadStatus} role="status" aria-live="polite">
                <div className={styles.uploadStatusTop}>
                  <b>{statusCopy(uploadState)}</b>
                  {uploadState.status === "processing" && typeof uploadState.progress === "number"
                    ? <span>{Math.round(uploadState.progress)}%</span>
                    : null}
                </div>
                {uploadState.status === "uploading" ? (
                  <div className={`${styles.statusTrack} ${styles.indeterminateTrack}`} aria-label="正在上传，暂无百分比"><span /></div>
                ) : null}
                {uploadState.status === "processing" && typeof uploadState.progress === "number" ? (
                  <div className={styles.statusTrack} aria-label={`处理进度 ${Math.round(uploadState.progress)}%`}><span style={{ width: `${Math.max(0, Math.min(100, uploadState.progress))}%` }} /></div>
                ) : null}
                {uploadState.status === "failed" ? (
                  <p className={styles.inlineError} role="alert">{uploadState.errorMessage || "服务没有返回具体原因，请稍后重新读取。"}</p>
                ) : null}
                {uploadState.cacheErrorMessage ? (
                  <p className={styles.inlineError} role="alert">{uploadState.cacheErrorMessage}</p>
                ) : null}
                {uploadState.cleanupWarningMessage ? (
                  <p className={styles.inlineError} role="alert">{uploadState.cleanupWarningMessage}</p>
                ) : null}
                {uploadState.status === "ready" ? <p className={styles.statusDetail}>结果只属于当前账号；由你确认留下的内容会进入这段关系的长期记录。</p> : null}
              </div>
            ) : null}

            <div className={styles.uploadPanelActions}>
              {uploadState.status === "failed" || uploadState.cacheErrorMessage ? (
                <button className={styles.secondaryButton} onClick={() => void onRetryRead()} type="button">重新读取结果</button>
              ) : null}
              {uploadState.status === "ready" && !file ? (
                <Link className={styles.primaryButton} href="/date-companion/a/recap"><span>查看这次复盘</span><span aria-hidden="true">→</span></Link>
              ) : (
                <button className={styles.primaryButton} disabled={!file || !effectiveRecordingDate || busy} type="submit">
                  <span>{uploadState.status === "uploading" ? "正在上传…" : busy ? "正在整理…" : "开始上传"}</span>
                  <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          </form>
        </details>

        {uploadState.status === "ready" ? (
          <Link className={styles.homeStatusAction} href="/date-companion/a/recap">查看这次复盘 <span aria-hidden="true">→</span></Link>
        ) : null}
        {uploadState.cacheErrorMessage || uploadState.cleanupWarningMessage ? (
          <div className={styles.homeCacheWarning} role="alert">
            <span>{uploadState.cacheErrorMessage || uploadState.cleanupWarningMessage}</span>
            <button onClick={() => void onRetryRead()} type="button">重新读取</button>
          </div>
        ) : null}
        {uploadState.status === "failed" ? (
          <button className={styles.homeFailureAction} onClick={() => detailsRef.current?.setAttribute("open", "")} type="button">
            <span>{uploadState.errorMessage || "这次整理没有完成"}</span>
            <b>查看详情</b>
          </button>
        ) : null}
      </section>

      <section className={styles.homeSideCard}>
        <div className={styles.sectionHeading}>
          <h2>{displayName === "Ta" ? "关于 Ta" : `你和 ${displayName}`}</h2>
          <span>只显示你确认留下的内容</span>
        </div>
        <Link
          aria-label={`打开关于 ${displayName}`}
          className={styles.personEmpty}
          href="/date-companion/a/person"
        >
          <span className={styles.personEmptyMark} aria-hidden="true">Ta</span>
          <b>{recent ?? participantNotice ?? `还没有留下关于 ${displayName} 的近况`}</b>
          <span>{recent
            ? "Ta 最近 · 来自你确认留下的相处记录"
            : participantNotice
              ? "人物尚未核对的内容不会进入长期记录"
              : "整理并确认一段相处后，值得记住的近况会出现在这里"}</span>
        </Link>
        {currentInteraction ? (
          <div className={styles.relationshipMeta}>
            <span>最近一次相处</span>
            <b>{currentInteraction.recordingDate}</b>
          </div>
        ) : null}
      </section>

      <Link className={styles.preparePreview} href="/date-companion/a/prepare">
        <small>下次见面前</small>
        <b>{preparation ?? "还没有需要特别记住的事"}</b>
        <p>{preparation ? "来自你确认留下的相处记录，不包含虚构的见面时间和地点。" : "不会猜测下次见面的日期、地点，也不会创建提醒。"}</p>
        <span className={styles.sideLink}>打开准备卡 <span aria-hidden="true">→</span></span>
      </Link>

      {remembered ? (
        <section className={styles.remembered}>
          <p>最近一次相处，记住了什么</p>
          {rememberedIsDirectQuote ? (
            <blockquote>“{remembered}”</blockquote>
          ) : (
            <div className={styles.rememberedSummary}>
              <p>{remembered}</p>
              <span>根据原话整理 · 可在复盘查看来源</span>
            </div>
          )}
          <small>{currentInteraction?.recordingDate ?? "来自这次相处"}</small>
        </section>
      ) : (
        <div className={styles.homeEmptyBottom}>
          {currentInteraction?.status === "processing" ? "这次相处仍在整理，内容会在完成后出现。" : "整理完成并找到真实来源后，这里才会出现值得回看的片段。"}
        </div>
      )}
    </div>
  );
}
