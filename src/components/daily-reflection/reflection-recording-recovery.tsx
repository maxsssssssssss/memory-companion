"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ProductDialog } from "@/components/product-system/product-primitives";
import type { DailyReflectionSessionValue } from "@/lib/client/daily-reflection-session";
import { reflectionUploadFailureMessage } from "@/lib/client/daily-reflection-api";
import { activeUploadFailure, reflectionUploadLabel } from "./reflection-upload-status";
import styles from "./daily-reflection.module.css";
import { reflectionSessionPath, REFLECTION_ROUTES } from "./reflection-product";

export function ReflectionRecordingRecovery({ session, compact = false }: {
  session: DailyReflectionSessionValue;
  compact?: boolean;
}) {
  const recovery = session.recordingRecovery;
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const closeDiscard = useCallback(() => setConfirmDiscard(false), []);
  const file = recovery?.file;
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setDownloadUrl(url);
    return () => { URL.revokeObjectURL(url); setDownloadUrl(null); };
  }, [file]);
  if (!recovery) return null;
  const saved = recovery.phase === "saved";
  const uploading = recovery.phase === "uploading";
  const failure = activeUploadFailure(recovery.uploadState, recovery.uploadFailure);
  const failedRecord = session.detail?.reflection.id === recovery.reflectionId && session.detail.reflection.status === "failed"
    || failure?.retryable === false;
  const href = recovery.reflectionId ? reflectionSessionPath(recovery.reflectionId) : `${REFLECTION_ROUTES.capture}?resume=1`;
  return <aside className={styles.recordingRecovery} aria-label="这次录音的保存状态">
    <div aria-live="polite">
      <strong>{uploading ? "正在上传 · 尚未确认保存" : saved ? "录音已接收" : recovery.phase === "checking" ? "正在核对保存状态"
        : reflectionUploadLabel(recovery.uploadState, failure) ?? (recovery.phase === "persisting" ? "服务器正在保存录音"
          : recovery.phase === "draft" ? "原音频尚未上传" : "录音保存尚未确认")}</strong>
      <p>{saved ? "可以关闭页面，稍后回来查看整理结果。内容仍由你确认。"
        : !file ? "此浏览器没有可用的本地副本。请重新选择原文件；不要选择不同内容替代。"
        : recovery.localCopy === "saved" ? "原录音已暂存在本机。站内浏览不影响上传；刷新或关页会中断传输，回来后可恢复。"
        : recovery.localCopy === "saving" ? "正在保存本机副本，请先保持页面打开。"
        : "本机暂存不可用。原音频仍在当前页面，请先下载备份；关页后需重新选择原文件。"}</p>
      {!saved && recovery.phase !== "persisting" && (failure || recovery.uploadErrorMessage) ? <p role="alert">
        {failure ? reflectionUploadFailureMessage(failure) : recovery.uploadErrorMessage}
        {failure ? <span> 排查代码：{failure.code}</span> : null}
      </p> : null}
      {failure && recovery.reflectionId ? <small>记录编号：{recovery.reflectionId}</small> : null}
      {recovery.errorMessage ? <p role={recovery.phase === "persisting" ? "status" : "alert"}>{recovery.errorMessage}</p> : null}
    </div>
    {!compact && recovery.phase === "draft" ? <label>
      这段录音来自
      <select className={styles.secondaryButton} value={recovery.sourceOrigin ?? ""}
        onChange={(event) => {
          if (event.target.value === "user_reflection" || event.target.value === "direct_conversation") {
            void session.setRecordingRecoverySource(event.target.value);
          }
        }}>
        <option value="" disabled>请确认来源</option>
        <option value="user_reflection">我自己的复盘</option>
        <option value="direct_conversation">一段真实交流</option>
      </select>
    </label> : null}
    <div className={styles.recordingRecoveryActions}>
      {compact ? <Link href={href} onClick={() => void session.resumeRecording()}>继续这次复盘</Link> : null}
      {!compact && !saved && !uploading && failure?.retryable !== false ? <button className={styles.secondaryButton} type="button" disabled={!recovery.sourceOrigin || recovery.phase === "checking"}
        onClick={() => void session.retryRecordingUpload()}>{!file ? "核对保存状态" : recovery.uploadState === "reupload_allowed" ? "重试上传" : "核对进度并继续上传"}</button> : null}
      {!compact && !saved && !file && failure?.retryable !== false ? <label>重新选择原文件
        <input type="file" accept="audio/*,.webm,.m4a,.mp3,.wav,.ogg" disabled={recovery.phase === "checking" || uploading}
          onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void session.setRecordingRecoveryFile(selected); event.target.value = ""; }} />
      </label> : null}
      {!compact && file && downloadUrl ? <a href={downloadUrl} download={file.name}>下载原录音</a> : null}
      {!compact && recovery.phase === "draft" ? <button className={styles.dangerButton} type="button"
        onClick={() => setConfirmDiscard(true)}>删除这段录音</button> : null}
      {!compact && !saved && recovery.reflectionId ? <button className={styles.dangerButton} type="button"
        disabled={session.operation === "cancelling" || session.operation === "deleting"}
        onClick={() => setConfirmDiscard(true)}>{failedRecord ? "删除失败记录" : "取消这次上传"}</button> : null}
    </div>
    <ProductDialog open={confirmDiscard} onClose={closeDiscard} title={recovery.phase === "draft" ? "删除尚未上传的录音？" : failedRecord ? "删除失败记录？" : "取消这次上传？"}>
      <p>确认后将停止这次恢复并移除本机副本。你也可以先下载原音频；之后重新录制或选择文件会开始新的上传。</p>
      <div className={styles.recordingRecoveryActions}>
        <button className={styles.secondaryButton} type="button" onClick={closeDiscard}>保留录音</button>
        <button className={styles.dangerButton} type="button" onClick={() => {
          closeDiscard(); void (recovery.phase === "draft" ? session.discardRecordingDraft() : session.cancelRecordingUpload());
        }}>{recovery.phase === "draft" ? "确认删除录音" : failedRecord ? "确认删除失败记录" : "确认取消上传"}</button>
      </div>
    </ProductDialog>
  </aside>;
}
