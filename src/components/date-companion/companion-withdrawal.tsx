"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ProductDialog } from "@/components/product-system/product-primitives";
import { changedWithdrawalPreview, type WithdrawalImpact, type WithdrawalReceipt } from "@/lib/client/date-companion-api";
import styles from "./date-companion.module.css";

type WithdrawalProps = {
  busy: boolean;
  read(signal: AbortSignal): Promise<WithdrawalImpact>;
  submit(version: string): Promise<WithdrawalReceipt>;
};

export function CompanionWithdrawal({ busy, read, submit }: WithdrawalProps) {
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<WithdrawalImpact | null>(null);
  const [receipt, setReceipt] = useState<WithdrawalReceipt | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const request = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const closeControl = useRef<HTMLButtonElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  useLayoutEffect(() => {
    if (open && (receipt || message) && document.activeElement === document.body) closeControl.current?.focus({preventScroll:true});
  }, [open, receipt, message, saving]);

  async function preview() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setOpen(true);
    setImpact(null);
    setReceipt(null);
    setMessage("");
    try {
      const result = await read(controller.signal);
      if (!controller.signal.aborted) setImpact(result);
    } catch {
      if (!controller.signal.aborted) setMessage("暂时无法读取撤回范围。");
    }
  }
  const close = useCallback(() => {
    if (submitting.current) return;
    request.current?.abort();
    setOpen(false);
  }, []);
  async function confirm(version: string, retry: boolean) {
    if (!impact || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setMessage("");
    try {
      const result = await submit(version);
      if (request.current?.signal.aborted) return;
      setReceipt(result);
      setImpact({
        preview: retry ? impact.preview : { ...impact.preview, totalCount: 0, retainedCount: 0, processingCount: 0 },
        ...(result.retryable ? { pendingCleanup: { ...result, previewVersion: version } } : {})
      });
    } catch (error) {
      if (request.current?.signal.aborted) return;
      const updated = changedWithdrawalPreview(error);
      if (updated) {
        setReceipt(null);
        setImpact({ ...impact, preview: updated });
        setMessage("长期资料范围已变化，请核对下方的新场次后再确认。");
      } else setMessage("尚未取得本次操作的回执，可按原范围重试。");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  return <>
    <section aria-labelledby="purge-title" className={`${styles.peopleTrustSection} ${styles.peopleDangerZone}`}>
      <p className={styles.eyebrow}>长期资料</p>
      <h2 id="purge-title">撤回这段关系的长期资料</h2>
      <p>本场复盘和录音保留。永久删除录音请使用录音的删除入口。</p>
      <button className={styles.dangerButton} disabled={busy} onClick={() => void preview()} type="button">查看撤回影响</button>
    </section>
    <ProductDialog open={open} onClose={close} title="撤回这段关系的长期资料？" footer={<>
      <button ref={closeControl} aria-disabled={saving} onClick={close} type="button">{receipt ? "关闭" : "取消"}</button>
      {impact?.pendingCleanup && <button aria-disabled={saving} type="button" onClick={() => void confirm(impact.pendingCleanup!.previewVersion, true)}>重试上次清理</button>}
      {impact && impact.preview.totalCount > 0 && <button className={styles.dangerButton} aria-disabled={saving}
        onClick={() => void confirm(impact.preview.version, false)} type="button">{saving ? "正在处理…" : "确认撤回长期资料"}</button>}
    </>}>
      {message && <p role="alert">{message}</p>}
      {!impact ? message ? <button type="button" onClick={() => void preview()}>重新读取范围</button> : <p role="status">正在核对已授权的相处场次…</p> : <>
        {receipt && <p role="status">{receipt.totalCount} 场资料已停止长期使用。已清理 {receipt.completedCount} 场。{receipt.retryable ? "其余场次可重试清理。" : ""}</p>}
        {!receipt && impact.pendingCleanup && <p role="status">上次撤回已停止使用，还有资料等待清理。</p>}
        {impact.preview.totalCount > 0 ? <>
          <p>共 {impact.preview.totalCount} 场 · 已纳入 {impact.preview.retainedCount} 场 · 仅在处理 {impact.preview.processingCount} 场</p>
          <p>确认后立即停止使用这些场次的旧长期授权。以后可在单场复盘中重新选择并授权。</p>
        </> : !receipt && <p>这段关系目前没有可撤回的长期授权。</p>}
      </>}
    </ProductDialog>
  </>;
}
