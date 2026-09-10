"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useReflectionApp } from "./reflection-app-shell";
import { ReflectionRecordingRecovery } from "./reflection-recording-recovery";
import { reflectionSessionPath } from "./reflection-product";
import styles from "./daily-reflection.module.css";

const STATUS_LABELS: Record<string, string> = {
  created: "尚未确认保存", uploading: "上传尚未确认", transcribing: "正在转写", extracting: "正在整理",
  review_pending: "等待确认", failed: "整理失败", completed: "已完成", cancelled: "已取消",
  confirmation_ready: "正在保存确认", admitting: "正在保存确认", admission_failed: "确认保存失败"
};

export function ReflectionRecentSessions() {
  const { session } = useReflectionApp();
  const refresh = session.refreshHistory;
  useEffect(() => { void refresh(); }, [refresh]);
  return <main className={styles.productPage}>
    <div className={styles.recordingRecoveryActions}>
      <h1>最近复盘</h1>
      <button className={styles.secondaryButton} type="button" disabled={session.historyState === "loading"}
        onClick={() => void refresh()}>刷新记录</button>
    </div>
    <ReflectionRecordingRecovery session={session} compact />
    {session.historyState === "error" ? <p role="alert">暂时无法读取记录，请刷新重试。</p> : null}
    {session.historyState === "loading" ? <p role="status">正在读取最近复盘…</p> : null}
    {session.historyState === "ready" && !session.history.length ? <p>还没有已接收的复盘。未完成上传会显示在这里。</p> : null}
    <ul className={styles.recentSessionList}>
      {session.history.map((item) => <li key={item.id}>
        <Link href={reflectionSessionPath(item.id)}>
          <strong>{item.recordingDate ?? item.createdAt.slice(0, 10)} 的复盘</strong>
          <span>{STATUS_LABELS[item.status] ?? "正在处理"}</span>
        </Link>
      </li>)}
    </ul>
    {session.history.length === 24 ? <p>这里显示最近 24 条复盘。</p> : null}
  </main>;
}
