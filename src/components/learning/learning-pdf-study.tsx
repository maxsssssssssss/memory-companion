"use client";

import { useEffect, useRef, useState } from "react";
import type { LearningMaterial, LearningPage } from "@/lib/domain/learning";
import type { ParsedDocument } from "@/lib/domain/learning-parsed-document";
import type { LearningPdfReadiness, ParsedTextBinding } from "@/lib/domain/learning-pdf-study";
import { learningApi, learningErrorMessage, LEARNING_INVALIDATION_CHANNEL } from "@/lib/client/learning-api";
import styles from "./learning.module.css";
import { useLearningUnsaved } from "./use-learning-unsaved";

export function LearningPdfStudy({ page, material, onUpdated, onSource, disabled = false }: {
  page: LearningPage; material: LearningMaterial; onUpdated: (page: LearningPage) => void;
  onSource: (id: string, page: number, parsed?: ParsedTextBinding) => void; disabled?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [doc, setDoc] = useState<ParsedDocument | null>(null);
  const [readiness, setReadiness] = useState<LearningPdfReadiness | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [versions, setVersions] = useState<Array<Omit<ParsedDocument, "pages">>>([]);
  const [version, setVersion] = useState<string | undefined>();
  const [pages, setPages] = useState<number[]>(material.pdfStudy?.physicalPages ?? []);
  const [excluded, setExcluded] = useState<string[]>(material.pdfStudy?.excludedBlockIds ?? []);
  const [ack, setAck] = useState(false), [warnings, setWarnings] = useState(false);
  const [progress, setProgress] = useState<Array<{ status: string }>>([]);
  const [start, setStart] = useState(1), [end, setEnd] = useState(1), [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false), [parsing, setParsing] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const submission = useRef<{ id: string; physicalPages: number[]; resumeFrom?: string } | null>(null);
  const writing = useRef(false), dirty = useRef(false), mounted = useRef(true);
  useLearningUnsaved(dirty.current);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (document.hidden) return;
    let alive = true;
    void learningApi.parsed(page.id, material.id, version, !advanced).then(result => {
      if (!alive) return;
      setStatusLoaded(true); setDoc(result.document); setVersions(result.documents); setProgress(result.progress);
      setReadiness(result.readiness ?? null); setError("");
      if (!dirty.current) {
        const selection = result.selection?.documentId === (version ?? result.selection?.documentId) ? result.selection : null;
        setPages(selection?.physicalPages ?? []);
        setExcluded(selection?.excludedBlockIds ?? result.readiness?.selection?.excludedBlockIds ?? []);
        setWarnings(selection?.acknowledgeWarnings ?? false);
      }
    }).catch(reason => { if (alive) { setStatusLoaded(true); setError(learningErrorMessage(reason)); } });
    return () => { alive = false; };
  }, [advanced, page.id, material.id, version, epoch, material.pdfStudy?.documentId]);
  useEffect(() => {
    const invalidate = () => setEpoch(value => value + 1);
    window.addEventListener("focus", invalidate); document.addEventListener("visibilitychange", invalidate);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(LEARNING_INVALIDATION_CHANNEL);
    if (channel) channel.onmessage = event => { if (event.data?.pageId === page.id) invalidate(); };
    return () => { window.removeEventListener("focus", invalidate); document.removeEventListener("visibilitychange", invalidate); channel?.close(); };
  }, [page.id]);
  const latestStatus = versions.at(-1)?.status;
  useEffect(() => {
    if (!(busy || latestStatus === "processing" || latestStatus === "pending")) return;
    const timer = setInterval(() => setEpoch(value => value + 1), 4000);
    return () => clearInterval(timer);
  }, [busy, latestStatus]);
  const parse = async (resume = false) => {
    if (writing.current || disabled) return;
    writing.current = true; setBusy(true); setParsing(true); setError(""); setNotice("");
    const physicalPages = (resume || doc?.status === "pending") && doc?.requestedPages ? doc.requestedPages : Array.from({ length: end - start + 1 }, (_, i) => start + i);
    if (!submission.current || JSON.stringify(submission.current.physicalPages) !== JSON.stringify(physicalPages) || resume) {
      submission.current = { id: doc?.status === "pending" ? doc.id : crypto.randomUUID(), physicalPages, ...resume && doc ? { resumeFrom: doc.id } : {} };
    }
    try {
      const result = await learningApi.parsePdf(page.id, material.id, submission.current);
      if (!mounted.current) return;
      dirty.current = false; setDoc(result.document); setVersion(result.document.id); setAck(false); setEpoch(value => value + 1);
      if (result.document.status !== "processing") submission.current = null;
    } catch (reason) { if (mounted.current) setError(learningErrorMessage(reason)); }
    finally { writing.current = false; if (mounted.current) { setBusy(false); setParsing(false); } }
  };
  const saveScope = async () => {
    if (!doc || writing.current || disabled) return;
    writing.current = true; setBusy(true); setError("");
    try {
      const result = await learningApi.pdfStudyScope(page.id, material.id, page.revision, {
        documentId: doc.id, physicalPages: pages,
        excludedBlockIds: excluded.filter(id => doc.pages?.some(item => pages.includes(item.physical_page) && item.blocks.some(block => block.id === id))),
        acknowledgeUnverified: true, acknowledgeWarnings: warnings
      });
      if (!mounted.current) return;
      dirty.current = false; onUpdated(result.page); setNotice("PDF 学习范围已保存，内容仍未核实。");
    } catch (reason) { if (mounted.current) setError(learningErrorMessage(reason)); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  };
  const total = material.pdf?.pageCount ?? 0;
  const status = !statusLoaded ? "正在读取状态…" : error && !versions.length ? "状态读取失败"
    : readiness?.unknownPages.length ? `处理结果待确认 · 已完成 ${readiness.completedPages.length}/${total} 页`
    : readiness?.processing === "budget_exhausted" ? `本轮解析额度已用完 · 已完成 ${readiness.completedPages.length}/${total} 页`
    : readiness?.processing === "session_expired" ? `本轮解析会话已结束 · 已完成 ${readiness.completedPages.length}/${total} 页`
    : readiness?.processing === "waiting_resource" ? `等待解析资源 · 已完成 ${readiness.completedPages.length}/${total} 页`
    : readiness?.processing === "resuming" ? `正在继续未完成页 · 已完成 ${readiness.completedPages.length}/${total} 页`
    : latestStatus === "processing" ? `处理中 · ${progress.filter(item => item.status === "completed").length}/${progress.length || total} 页`
    : readiness?.status === "ready" ? "全文已准备 · 内容未核实"
    : readiness?.status === "partial" ? `部分可用 · ${readiness.selection?.physicalPages.length ?? 0}/${total} 页`
    : readiness?.status === "blocked" ? "尚无可用学习范围"
    : latestStatus === "completed" ? "已有解析 · 待核对可用范围" : latestStatus === "failed" ? "处理未完成 · 原件保留" : "原件已保存 · 尚待处理";
  const usablePages = new Set(readiness?.selection?.physicalPages ?? []);
  return <details className={styles.pdfDetails}>
    <summary>{material.title} · {status}</summary>
    <div className={styles.row}><p className={styles.muted}>共 {total} 个物理页。处理完成与内容正确是两回事，请结合原页阅读。</p><button type="button" onClick={() => onSource(material.id, 1)}>查看原 PDF</button></div>
    {readiness ? <p className={styles.muted}>已处理 {readiness.completedPages.length}/{total} 页 · 可用于学习 {usablePages.size} 页 · 未完成 {readiness.pendingPages.length + readiness.failedPages.length + readiness.unknownPages.length} 页
      {readiness.excludedPages.length ? ` · 已排除 ${readiness.excludedPages.length} 页` : ""}{readiness.excludedBlockCount ? ` · 已排除 ${readiness.excludedBlockCount} 个区域` : ""}{readiness.warningCodes.length ? ` · ${readiness.warningCodes.length} 类风险提示` : ""}</p> : null}
    {readiness?.partial ? <p className={styles.muted}>当前只包含可用范围，不能代表完整 PDF；未通过检查的页面或区域不会用于生成。</p> : null}
    {readiness?.unknownPages.length ? <p className={styles.muted}>有页面的处理结果尚未确认，不会自动重新提交。请先核对原请求，已完成页和原件仍保留。</p>
      : readiness?.processing === "waiting_resource" ? <p className={styles.muted}>正在等待解析资源，已完成页已保存。稍后可继续处理未完成页。</p> : null}
    <details onToggle={event => { if (event.target === event.currentTarget) setAdvanced(event.currentTarget.open); }}>
      <summary>高级：手动解析与学习范围</summary>
      {advanced ? <>
        <p className={styles.muted}>需要更换解析版本或缩小范围时再调整。手动选择不代表已核实内容，页码均为原文件物理页。</p>
        <div className={styles.row}>
          <label>解析起始物理页<input type="number" min={1} max={total} value={start} onChange={event => setStart(Number(event.target.value))} /></label>
          <label>结束物理页<input type="number" min={start} max={total} value={end} onChange={event => setEnd(Number(event.target.value))} /></label>
          <button type="button" disabled={disabled || busy || latestStatus === "processing" || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total || end - start >= 30} onClick={() => void parse()}>{doc?.status === "pending" ? "继续已安排的解析" : "解析选定 PDF 页"}</button>
          {doc && (doc.status === "failed" || doc.coverage?.failed_pages.length) ? <button type="button" disabled={disabled || busy} onClick={() => void parse(true)}>处理未完成页</button> : null}
        </div>
        <p className={styles.muted}>每次最多 30 页。已完成页和旧成果保留；未知结果不会自动重提。</p>
        {versions.length ? <label>解析版本<select value={version ?? doc?.id ?? ""} disabled={busy} onChange={event => { setVersion(event.target.value); dirty.current = false; setPages([]); setExcluded([]); setAck(false); }}>{versions.map(item => <option key={item.id} value={item.id}>版本 {item.version} · {item.status === "completed" ? "处理完成" : item.status === "processing" ? "处理中" : item.status === "failed" ? "未完成" : "等待处理"}</option>)}</select></label> : <p className={styles.muted}>尚无解析版本。</p>}
        {doc?.pages?.map(item => <div key={item.physical_page} className={styles.pdfPageDetail}>
          <label className={styles.materialCheck}><input type="checkbox" disabled={disabled || busy || !usablePages.has(item.physical_page)} checked={pages.includes(item.physical_page)} onChange={event => { dirty.current = true; setPages(current => event.target.checked ? [...current, item.physical_page] : current.filter(number => number !== item.physical_page)); setAck(false); }} />第 {item.physical_page} 物理页 · {usablePages.has(item.physical_page) ? "可选 · 内容未核实" : "暂不可用于学习"}</label>
          <button type="button" onClick={() => onSource(material.id, item.physical_page)}>回看第 {item.physical_page} 原页</button>
          <details><summary>解析文字、风险与来源区域 · {item.blocks.length} 个区域</summary>
            {item.issues.map((issue, index) => <p key={index} className={styles.muted}>{issue.severity === "blocked" ? "不可用原因" : "风险提示"}：{issue.message}</p>)}
            {item.blocks.map(block => <div key={block.id}>
              <label className={styles.materialCheck}><input type="checkbox" disabled={disabled || busy || Boolean(readiness?.selection?.excludedBlockIds.includes(block.id))} aria-label={`排除区域 ${block.id}`} checked={excluded.includes(block.id)} onChange={event => { dirty.current = true; setExcluded(current => event.target.checked ? [...current, block.id] : current.filter(id => id !== block.id)); setAck(false); }} />排除此区域，不用于生成</label>
              <button type="button" onClick={() => onSource(material.id, item.physical_page, { documentId: doc.id, version: doc.version, blockId: block.id, physicalPage: item.physical_page, sourceHash: block.source_sha256 })}>回看此区域</button>
              <p className={styles.muted}>{block.quality.status === "blocked" ? "不可用于生成" : block.quality.status === "warning" ? "有风险提示" : block.quality.status === "verified" ? "已有核实记录，范围见详情" : "内容未核实"}</p>
              <pre className={styles.original}>{block.content.normalized ?? "缺少可用内容"}</pre>
              <details><summary>技术与定位详情</summary>
                {[...block.quality.automatic_signals, ...block.quality.text_layer_signals, ...block.quality.prior_findings ?? []].map((issue, index) => <p key={index} className={styles.muted}>{issue.message}</p>)}
                {block.source_regions.map((region, index) => <p key={index} className={styles.muted}>物理页 {region.physical_page} · {region.unit} · [{region.bbox.join(", ")}] · {item.render?.width_px}×{item.render?.height_px}</p>)}
              </details>
            </div>)}
          </details>
        </div>)}
        {doc?.status === "completed" ? <>
          <p className={styles.muted}>本次选 {pages.length}/{total} 页，排除 {excluded.length} 个区域。未选范围不会用于生成。</p>
          <label className={styles.materialCheck}><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />我已对照选定范围，允许用于学习；内容仍未核实</label>
          {readiness?.warningCodes.length ? <label className={styles.materialCheck}><input type="checkbox" checked={warnings} onChange={event => setWarnings(event.target.checked)} />允许使用有告警的范围，并保留告警</label> : null}
          <button type="button" disabled={disabled || busy || !ack || !pages.length || pages.some(number => !usablePages.has(number)) || Boolean(readiness?.warningCodes.length && !warnings)} onClick={() => void saveScope()}>保存 PDF 学习范围</button>
        </> : null}
      </> : null}
    </details>
    {busy ? <p role="status">{parsing ? `正在解析 ${progress.filter(item => item.status === "completed").length}/${progress.length || end - start + 1} 页…` : "正在保存学习范围…"}</p> : null}
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
  </details>;
}
