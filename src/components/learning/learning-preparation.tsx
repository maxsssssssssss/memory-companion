"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { LearningPreparationRun } from "@/lib/domain/learning-preparation";
import { LearningApiError, learningApi, learningErrorMessage } from "@/lib/client/learning-api";
import styles from "./learning.module.css";

export function LearningPreparation({ pageId, refreshKey, onUpdated, onActive, onMaterials, onRead, onQuiz, saveSelection, onBusy, disabled = false, renderContent, onStatus }: {
  pageId: string; refreshKey: number; onUpdated: (runs: LearningPreparationRun[]) => void | Promise<void>; onActive: (active: boolean) => void; onMaterials: () => void; onRead: () => void; onQuiz: () => void;
  saveSelection: () => Promise<void>; onBusy?: (busy: boolean) => void; disabled?: boolean;
  renderContent?: (content: ReactNode) => ReactNode; onStatus?: (status: string) => void;
}) {
  const [runs, setRuns] = useState<LearningPreparationRun[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), reading = useRef(false), writing = useRef(false), sequence = useRef(0);
  const callbacks = useRef({ onUpdated, onActive }); callbacks.current = { onUpdated, onActive };
  const fingerprint = useRef<string | null>(null);
  const refreshPending = useRef(false);
  const accept = useCallback(async (next: LearningPreparationRun[]) => {
    if (!alive.current) return;
    const request = sequence.current;
    const identity = next.map(run => `${run.id}:${run.updatedAt}:${run.status}:${run.completed}`).join("|");
    if (fingerprint.current !== identity && (fingerprint.current !== null || next.length > 0)) await callbacks.current.onUpdated(next);
    if (!alive.current || request !== sequence.current) return;
    setRuns(next);
    fingerprint.current = identity;
    callbacks.current.onActive(next.some(run => run.status === "preparing" || run.status === "generating"));
  }, []);
  const read = useCallback(async function refresh(signal?: AbortSignal): Promise<void> {
    if (reading.current) { refreshPending.current = true; return; }
    reading.current = true;
    const request = ++sequence.current;
    try {
      const result = await learningApi.preparation(pageId, signal);
      if (alive.current && !signal?.aborted && request === sequence.current) { await accept(result.runs); if (alive.current && request === sequence.current) setError(""); }
    } catch (reason) {
      if (alive.current && !signal?.aborted && request === sequence.current) {
        setError(learningErrorMessage(reason));
        if (reason instanceof LearningApiError && [401, 404, 410].includes(reason.status)) { setRuns([]); fingerprint.current = null; callbacks.current.onActive(false); }
      }
    } finally {
      reading.current = false;
      if (refreshPending.current && alive.current) { refreshPending.current = false; void refresh(); }
    }
  }, [pageId, accept]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; };
  }, []);
  useEffect(() => { const controller = new AbortController(); void read(controller.signal); return () => controller.abort(); }, [read, refreshKey]);
  const active = runs.some(run => run.status === "preparing" || run.status === "generating");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setInterval(() => { if (!document.hidden) void read(controller.signal); }, 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, read]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void read(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [read]);
  const run = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const resume = async (continueWithAvailable = false) => {
    if (!run || writing.current || disabled) return;
    writing.current = true; setBusy(true); setError(""); sequence.current++;
    if (continueWithAvailable) onBusy?.(true);
    let submitted = false;
    let responseReceived = false;
    try {
      if (continueWithAvailable) await saveSelection();
      if (!alive.current) return;
      submitted = true;
      const result = await learningApi.resumePreparation(pageId, run.id, continueWithAvailable ? { continueWithAvailable: true } : {});
      responseReceived = true;
      if (alive.current) { sequence.current++; await accept(runs.map(item => item.id === result.run.id ? result.run : item)); }
    } catch (reason) {
      if (alive.current) setError(learningErrorMessage(reason));
      // A failed response is reconciled with a read; it never creates another run.
      // A failed selection save has not submitted anything and must retain its error.
      if (submitted && !responseReceived) await read();
    } finally {
      writing.current = false;
      if (alive.current) { setBusy(false); if (continueWithAvailable) onBusy?.(false); }
    }
  };
  const partial = run?.materials.some(material => material.status === "partial" || material.status === "blocked");
  const pauseReason = run && ["preparing", "needs_attention", "interrupted"].includes(run.status)
    ? run.materials.find(material => material.processing === "budget_exhausted" || material.processing === "session_expired")?.processing : undefined;
  const pauseTitle = pauseReason === "budget_exhausted" ? "本轮解析额度已用完" : pauseReason === "session_expired" ? "本轮解析会话已结束" : undefined;
  const waitingForResource = run && ["preparing", "needs_attention", "interrupted"].includes(run.status) && run.materials.some(material => material.processing === "waiting_resource");
  const resumingPages = run?.status === "preparing" && run.materials.some(material => material.processing === "resuming");
  const status = error ? "进度读取失败" : !run ? "查看材料" : pauseTitle ?? (waitingForResource ? "等待解析资源" : active ? "处理中" : run.status === "completed" ? partial ? "部分完成" : "已完成" : "需要处理");
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);
  const title = !run ? "暂时无法读取整理进度" : pauseTitle ? pauseTitle : waitingForResource ? "等待解析资源" : resumingPages ? "正在继续未完成页" : run.status === "preparing" ? "正在准备学习材料"
    : run.status === "generating" ? run.frameworkPublished ? "正在连接不同资料中的知识" : "正在阅读资料与整理章节"
    : run.status === "completed" ? run.intent === "prepare" ? "材料已准备，可以开始练习" : partial ? "已按可用范围整理" : "本次整理已完成"
    : run.status === "needs_attention" ? "部分材料需要处理"
    : run.status === "interrupted" ? "整理已暂停" : run.frameworkPublished ? "章节已保存，总览未更新" : "本次整理未完成";
  const content = !run && !error ? null : <section className={styles.preparation} aria-label="整理进度">
    <div className={styles.preparationSummary}>
      <p role="status"><strong>{title}</strong>{run?.generation && run.status==="generating" ? <span> 已完成 {run.generation.completed}/{run.generation.total} 部分</span> : run && run.total > 0 ? <span> {run.completed}/{run.total} 份</span> : null}</p>
      <div className={styles.preparationActions}>
        {run?.status === "needs_attention" && run.canContinue ? <button className={styles.primary} type="button" disabled={busy || disabled} onClick={() => void resume(true)}>先整理可用部分</button> : null}
        {run?.canResume ? <button className={run.status === "needs_attention" && run.canContinue ? undefined : styles.primary} type="button" disabled={busy || disabled} onClick={() => void resume()}>{busy ? "正在核对…" : "继续处理"}</button> : null}
        {run?.status === "completed" || run?.frameworkPublished ? <button className={styles.primary} type="button" onClick={run.intent === "prepare" ? onQuiz : onRead}>{run.intent === "prepare" ? "开始练习" : "阅读框架"}</button> : null}
        <button type="button" onClick={onMaterials}>查看材料</button>
      </div>
    </div>
    {pauseReason ? <p className={styles.muted}>已完成页和原件仍保留，未完成页不会自动重试。可以继续阅读已保存的内容。</p> : waitingForResource ? <p className={styles.muted}>已完成页已保存，可以继续阅读已有内容。未完成页不会当作已解析内容使用。</p> : run?.status === "generating" || run?.status === "preparing" ? <p className={styles.muted}>可以继续阅读已有内容，完成后新章节会加入框架。</p> : null}
    {run?.status === "needs_attention" ? <p className={styles.muted}>{waitingForResource ? "稍后可继续处理未完成页；若先整理可用部分，会保留未覆盖范围与风险说明。" : "部分页面或材料暂不能用于学习。继续使用可用部分时，会保留缺失范围和风险说明。"}</p> : null}
    {run?.error ? <p className={styles.muted}>{learningErrorMessage(new LearningApiError(409, run.error))}</p> : null}
    {run ? <div><h3>本次材料 · {run.materials.length} 份</h3><ul className={styles.preparationMaterials}>
      {run.materials.map(material => <li key={material.materialId}><div><strong>{material.title}</strong><span>{material.processing === "budget_exhausted" ? "本轮解析额度已用完" : material.processing === "session_expired" ? "本轮解析会话已结束" : material.processing === "waiting_resource" ? "等待解析资源" : material.processing === "resuming" ? "正在继续未完成页" : material.status === "ready" ? material.kind === "audio" ? "转写完成" : "可用于学习" : material.status === "partial" ? "部分可用" : material.status === "blocked" ? "暂不可用" : "准备中"}{material.total > 0 ? ` · ${material.processing ? "已完成 " : ""}${material.completed}/${material.total}${material.kind === "pdf" ? " 页" : material.kind === "audio" ? " 段" : ""}` : ""}</span></div>
        {[...new Set(material.issues.map(issue => /[\u3400-\u9fff]/u.test(issue) ? issue : learningErrorMessage(new LearningApiError(409, issue))))].map((issue, index) => <p key={index} className={styles.muted}>{issue}</p>)}
      </li>)}
    </ul></div> : null}
    {error ? <div role="alert" className={styles.error}><p>{error}</p><button type="button" onClick={() => void read()}>重新读取进度</button></div> : null}
  </section>;
  // The controller remains mounted while its dialog is closed, so polling and
  // completed-page publication do not depend on whether the user is watching.
  return renderContent ? renderContent(content) : content;
}
