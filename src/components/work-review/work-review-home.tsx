"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useContext, useEffect, useRef, useState } from "react";

import { ProductState } from "@/components/product-system/product-primitives";
import {
  WORK_REVIEW_AUDIO_ACCEPT,
  isDefinitiveWorkReviewApiError,
  WorkReviewApiError,
  type WorkMeetingListItem,
  type WorkReviewCapacityLimits,
  type WorkReviewApi
} from "@/lib/client/work-review-api";

import { WorkReviewContext, type WorkReviewFeatureFlags } from "./work-review-shell";
import { formatMeetingDuration, WorkMeetingStatus } from "./work-review-shared";
import styles from "./work-review.module.css";

function today() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatByteLimit(bytes: number) {
  const mebibytes = bytes / (1024 * 1024);
  if (Number.isInteger(mebibytes)) return `${mebibytes.toLocaleString("zh-CN")} MB`;
  return `${bytes.toLocaleString("zh-CN")} 字节`;
}

function formatDurationLimit(seconds: number) {
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

function operationKey() {
  return globalThis.crypto?.randomUUID?.() ?? `work-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const PENDING_UPLOAD_STORAGE_KEY = "daily-brief.work-review.pending-upload.v1";

function uploadFileIdentity(file: File) {
  return `${file.size}:${file.lastModified}:${file.type}`;
}

function pendingUploadOperationKey(file: File) {
  const identity = uploadFileIdentity(file);
  try {
    const current = globalThis.sessionStorage?.getItem(PENDING_UPLOAD_STORAGE_KEY);
    if (current) {
      const parsed = JSON.parse(current) as { identity?: unknown; idempotencyKey?: unknown };
      if (parsed.identity === identity && typeof parsed.idempotencyKey === "string" && parsed.idempotencyKey) {
        return parsed.idempotencyKey;
      }
    }
    const idempotencyKey = operationKey();
    globalThis.sessionStorage?.setItem(PENDING_UPLOAD_STORAGE_KEY, JSON.stringify({ identity, idempotencyKey }));
    return idempotencyKey;
  } catch {
    return operationKey();
  }
}

function clearPendingUploadOperation(idempotencyKey: string) {
  try {
    const current = globalThis.sessionStorage?.getItem(PENDING_UPLOAD_STORAGE_KEY);
    if (!current) return;
    const parsed = JSON.parse(current) as { idempotencyKey?: unknown };
    if (parsed.idempotencyKey === idempotencyKey) {
      globalThis.sessionStorage?.removeItem(PENDING_UPLOAD_STORAGE_KEY);
    }
  } catch {
    globalThis.sessionStorage?.removeItem(PENDING_UPLOAD_STORAGE_KEY);
  }
}

export function WorkReviewHome({
  api: apiOverride,
  featureFlags: flagsOverride
}: Readonly<{
  api?: WorkReviewApi;
  featureFlags?: WorkReviewFeatureFlags;
}> = {}) {
  const context = useContext(WorkReviewContext);
  const api = apiOverride ?? context?.api;
  const featureFlags = flagsOverride ?? context?.featureFlags;
  if (!api || !featureFlags) throw new Error("WorkReviewHome requires an API and feature flags");

  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const idempotencyKeyRef = useRef(operationKey());
  const [meetings, setMeetings] = useState<WorkMeetingListItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState(today);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [capacityLimits, setCapacityLimits] = useState<WorkReviewCapacityLimits | null>(null);
  const [capacityState, setCapacityState] = useState<"loading" | "ready" | "error">("loading");
  const [capacityAttempt, setCapacityAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    void api.listMeetings(controller.signal).then((records) => {
      if (!controller.signal.aborted) setMeetings(records);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(true);
    });
    return () => controller.abort();
  }, [api, loadAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setCapacityLimits(null);
    setCapacityState("loading");
    void api.getRuntimeConfig(controller.signal).then((limits) => {
      if (controller.signal.aborted) return;
      setCapacityLimits(limits);
      setCapacityState("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setCapacityState("error");
    });
    return () => controller.abort();
  }, [api, capacityAttempt]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !featureFlags.uploadEnabled || uploading) {
      if (!file) setUploadError("请选择一段已有的会议录音。");
      return;
    }
    if (capacityLimits && file.size > capacityLimits.maxUploadBytes) {
      setUploadError(`这段录音超过当前 ${formatByteLimit(capacityLimits.maxUploadBytes)} 的文件大小上限，请选择更小的文件。`);
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const receipt = await api.uploadMeeting({
        file,
        idempotencyKey: idempotencyKeyRef.current,
        meetingDate,
        title: title.trim() || undefined
      });
      clearPendingUploadOperation(idempotencyKeyRef.current);
      router.push(`/work-review/meetings/${encodeURIComponent(receipt.meetingId)}`);
    } catch (error) {
      if (isDefinitiveWorkReviewApiError(error)) {
        clearPendingUploadOperation(idempotencyKeyRef.current);
        idempotencyKeyRef.current = operationKey();
      }
      setUploadError(error instanceof WorkReviewApiError && error.code === "file_too_large" && capacityLimits
        ? `这段录音超过当前 ${formatByteLimit(capacityLimits.maxUploadBytes)} 的文件大小上限，请选择更小的文件。`
        : error instanceof WorkReviewApiError
          ? error.message
          : "暂时无法上传这段录音，请稍后重试。");
    } finally {
      setUploading(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.pageIntro}>
        <h1>工作复盘</h1>
        <p>上传工作会议录音，整理讨论、决定、行动事项和仍未解决的问题，并回到原文逐条核对。</p>
        <small>会议内容只对当前账号可见。</small>
      </header>

      <section aria-labelledby="work-review-upload-title" className={styles.primarySurface}>
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="work-review-upload-title">上传会议录音</h2>
            <p>只支持已经存在的录音文件；这里不会开启麦克风或实时录音。</p>
          </div>
        </div>
        <form aria-busy={uploading} className={styles.uploadForm} onSubmit={submit}>
          <label>
            <span>会议名称 <small>可选</small></span>
            <input
              autoComplete="off"
              disabled={uploading || !featureFlags.uploadEnabled}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：第一版发布范围确认"
              value={title}
            />
          </label>
          <label>
            <span>会议日期</span>
            <input
              disabled={uploading || !featureFlags.uploadEnabled}
              onChange={(event) => setMeetingDate(event.target.value)}
              required
              type="date"
              value={meetingDate}
            />
          </label>
          <label className={styles.fileField}>
            <span>会议录音</span>
            <input
              accept={WORK_REVIEW_AUDIO_ACCEPT}
              aria-label="会议录音"
              disabled={uploading || !featureFlags.uploadEnabled}
              onChange={(event) => {
                const selected = event.currentTarget.files?.[0] ?? null;
                setFile(selected);
                setUploadError(selected && capacityLimits && selected.size > capacityLimits.maxUploadBytes
                  ? `这段录音超过当前 ${formatByteLimit(capacityLimits.maxUploadBytes)} 的文件大小上限，请选择更小的文件。`
                  : null);
                idempotencyKeyRef.current = selected ? pendingUploadOperationKey(selected) : operationKey();
              }}
              ref={fileInputRef}
              required
              type="file"
            />
            <small>{file ? file.name : "AAC、FLAC、M4A、MP3、MP4、OGG、OPUS、PCM、WAV 或 WEBM"}</small>
          </label>
          {capacityState === "ready" && capacityLimits ? (
            <p className={styles.capacityNotice}>
              当前上限：文件不超过 <b>{formatByteLimit(capacityLimits.maxUploadBytes)}</b>，录音不超过 <b>{formatDurationLimit(capacityLimits.maxAudioDurationSeconds)}</b>。时长会在转写前核验，超限不会执行部分转写。
            </p>
          ) : capacityState === "error" ? (
            <div className={styles.capacityFailure} role="status">
              <p>暂时无法读取当前上传限制；服务端仍会在处理前严格校验。</p>
              <button className={styles.secondaryButton} onClick={() => setCapacityAttempt((value) => value + 1)} type="button">
                重新读取限制
              </button>
            </div>
          ) : (
            <p className={styles.capacityNotice} role="status">正在读取当前上传限制…</p>
          )}
          <p className={styles.permissionNotice}>
            请确保你有权上传和处理这段会议录音，并已取得必要的录音或处理许可。
          </p>
          {!featureFlags.uploadEnabled ? (
            <p className={styles.inlineNotice} role="status">工作复盘页面已开放，但会议录音上传暂不可用。</p>
          ) : null}
          {uploadError ? <p className={styles.formError} role="alert">{uploadError}</p> : null}
          <button className={styles.primaryButton} disabled={!featureFlags.uploadEnabled || uploading} type="submit">
            {uploading ? "正在上传会议录音…" : "上传并开始整理"}
          </button>
        </form>
      </section>

      <section aria-labelledby="work-review-recent-title" className={styles.recentSection}>
        <div className={styles.sectionHeading}>
          <div><h2 id="work-review-recent-title">最近会议</h2><p>打开一场会议，继续查看原文或核对会议结果。</p></div>
        </div>
        {loadError ? (
          <ProductState
            action={<button className={styles.secondaryButton} onClick={() => setLoadAttempt((value) => value + 1)} type="button">重新加载</button>}
            description="会议记录没有加载完成。"
            title="暂时无法读取最近会议"
            tone="error"
          />
        ) : meetings === null ? (
          <ProductState title="正在读取最近会议…" tone="loading" />
        ) : meetings.length === 0 ? (
          <ProductState
            action={featureFlags.uploadEnabled ? (
              <button className={styles.secondaryButton} onClick={() => fileInputRef.current?.focus()} type="button">选择会议录音</button>
            ) : undefined}
            description="上传一段已有的工作会议录音，从原文开始整理。"
            title="还没有会议记录"
            tone="empty"
          />
        ) : (
          <ul className={styles.meetingList}>
            {meetings.map((meeting) => {
              const duration = formatMeetingDuration(meeting.durationSeconds);
              return (
                <li key={meeting.id}>
                  <Link href={`/work-review/meetings/${encodeURIComponent(meeting.id)}`}>
                    <div>
                      <h3>{meeting.title}</h3>
                      <p><time dateTime={meeting.meetingDate}>{meeting.meetingDate}</time>{duration ? <span>{duration}</span> : null}</p>
                    </div>
                    <div className={styles.meetingListStatus}>
                      <WorkMeetingStatus meeting={meeting} />
                      {meeting.pendingCandidateCount ? <small>{meeting.pendingCandidateCount} 项待确认</small> : null}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
