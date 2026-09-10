"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ProductDialog } from "@/components/product-system/product-primitives";
import type { DailyReflectionSessionValue } from "@/lib/client/daily-reflection-session";
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
  const href = recovery.reflectionId ? reflectionSessionPath(recovery.reflectionId) : `${REFLECTION_ROUTES.capture}?resume=1`;
  return <aside className={styles.recordingRecovery} aria-label="这次录音的保存状态">
    <div aria-live="polite">
      <strong>{uploading ? "正在上传 · 尚未确认保存" : saved ? "录音已接收" : recovery.phase === "persisting" ? "服务器正在保存录音" : recovery.phase === "checking" ? "正在核对保存状态" : recovery.phase === "draft" ? "录音已结束 · 尚未上传" : "上传中断 · 需要核对进度"}</strong>
      <p>{saved ? "可以关闭页面，稍后回来查看整理结果。内容仍由你确认。"
        : recovery.localCopy === "saved" ? "原录音已暂存在本机。站内浏览不影响上传；刷新或关页会中断传输，回来后可恢复。"
        : recovery.localCopy === "saving" ? "正在保存本机副本，请先保持页面打开。"
        : "本机暂存不可用。请保持页面打开，并下载原录音作为备份。"}</p>
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
      {!compact && !saved && !uploading ? <button className={styles.secondaryButton} type="button" disabled={!recovery.sourceOrigin || recovery.phase === "checking"}
        onClick={() => void session.retryRecordingUpload()}>核对进度并继续上传</button> : null}
      {!compact && file && downloadUrl ? <a href={downloadUrl} download={file.name}>下载原录音</a> : null}
      {!compact && recovery.phase === "draft" ? <button className={styles.dangerButton} type="button"
        onClick={() => setConfirmDiscard(true)}>删除这段录音</button> : null}
    </div>
    <ProductDialog open={confirmDiscard} onClose={closeDiscard} title="删除尚未上传的录音？">
      <p>这会移除本机副本，删除后无法恢复。你也可以先下载原录音。</p>
      <div className={styles.recordingRecoveryActions}>
        <button className={styles.secondaryButton} type="button" onClick={closeDiscard}>保留录音</button>
        <button className={styles.dangerButton} type="button" onClick={() => {
          closeDiscard(); void session.discardRecordingDraft();
        }}>确认删除录音</button>
      </div>
    </ProductDialog>
  </aside>;
}
