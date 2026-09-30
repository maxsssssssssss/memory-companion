"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type { LearningMaterial } from "@/lib/domain/learning";
import { LearningApiError, learningErrorMessage, learningPdfResponse, LEARNING_INVALIDATION_CHANNEL } from "@/lib/client/learning-api";
import styles from "./learning.module.css";

const EMPTY_REGIONS:Array<{physicalPage:number;box:[number,number,number,number]}>=[];
export default function LearningPdfViewer({ pageId, material, initialPage, regions=EMPTY_REGIONS }: { pageId: string; material: LearningMaterial; initialPage?:number; regions?:Array<{physicalPage:number;box:[number,number,number,number]}> }) {
  const metadata = material.pdf!;
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [physicalPage, setPhysicalPage] = useState(() => {
    const value = initialPage ?? (Number(new URLSearchParams(window.location.search).get("pdfPage")) || 1);
    return Number.isInteger(value) && value >= 1 && value <= metadata.pageCount ? value : 1;
  });
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(800);
  const [epoch, setEpoch] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const measuredWidth = useRef(800);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(200, entry.contentRect.width - 24);
      if (next !== measuredWidth.current) { measuredWidth.current = next; setReady(false); setWidth(next); }
    });
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const visibility = () => { setHidden(window.document.hidden); if (!window.document.hidden) setEpoch((value) => value + 1); };
    const hide = () => setHidden(true);
    const show = () => { setHidden(false); setEpoch((value) => value + 1); };
    window.document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(LEARNING_INVALIDATION_CHANNEL) : null;
    if (channel) channel.onmessage = (event) => { if (event.data?.pageId === pageId) setEpoch((value) => value + 1); };
    return () => { channel?.close(); window.document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); };
  }, [pageId]);
  useEffect(() => {
    const controller = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    setDocument(null); setReady(false); setError("");
    if (hidden) return;
    void (async () => {
      // Original bytes are fetched afresh on every open/resume; never stored in a
      // Blob URL, CacheStorage, localStorage or IndexedDB.
      const [pdfjs, response] = await Promise.all([import("pdfjs-dist"), learningPdfResponse(pageId, material.id, controller.signal)]);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (controller.signal.aborted) return;
      if (response.headers.get("x-content-sha256") !== metadata.sha256) throw new Error("changed_original");
      pdfjs.GlobalWorkerOptions.workerSrc = "/api/learning/pdf-assets/worker.mjs?v=6.3.289";
      task = pdfjs.getDocument({ data: bytes, verbosity: 0, stopAtErrors: true, enableXfa: false, maxImageSize: 16_000_000,
        cMapUrl: "/api/learning/pdf-assets/cmaps/", cMapPacked: true,
        standardFontDataUrl: "/api/learning/pdf-assets/standard_fonts/", wasmUrl: "/api/learning/pdf-assets/wasm/", iccUrl: "/api/learning/pdf-assets/iccs/" });
      const loaded = await task.promise;
      if (!controller.signal.aborted) setDocument(loaded);
    })().catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof LearningApiError ? learningErrorMessage(reason) : "原件仍已保存，但此 PDF 暂无法显示。可以重新打开尝试；未生成解析内容。");
    });
    return () => { controller.abort(); void task?.destroy(); };
  }, [pageId, material.id, metadata.sha256, hidden, epoch]);
  useEffect(() => {
    setReady(false);
    if (!document || hidden) return;
    const controller = new AbortController();
    let cancel: (() => void) | undefined;
    void (async () => {
      // Recheck access before another page or zoom can render cached document data.
      await learningPdfResponse(pageId, material.id, controller.signal, true);
      const page = await document.getPage(physicalPage);
      if (controller.signal.aborted || !canvas.current) return;
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(width / natural.width, 1.6) * zoom;
      const view = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (view.width * view.height)));
      const target = canvas.current;
      target.width = Math.max(1, Math.floor(view.width * ratio)); target.height = Math.max(1, Math.floor(view.height * ratio));
      target.style.width = `${view.width}px`; target.style.height = `${view.height}px`;
      // Preserve static annotation appearances on the original page. No annotation
      // interaction layer or scripting manager is created.
      const rendering = page.render({ canvas: target, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: 1 });
      cancel = () => rendering.cancel();
      await rendering.promise;
      const ctx=target.getContext("2d");
      if(ctx){ctx.strokeStyle="#c45316";ctx.fillStyle="rgba(255,160,30,0.16)";ctx.lineWidth=2*ratio;
        for(const region of regions.filter(r=>r.physicalPage===physicalPage)){const [x0,y0,x1,y1]=region.box;ctx.fillRect(x0*target.width,y0*target.height,(x1-x0)*target.width,(y1-y0)*target.height);ctx.strokeRect(x0*target.width,y0*target.height,(x1-x0)*target.width,(y1-y0)*target.height);}}

      if (!controller.signal.aborted) { setReady(true); setError(""); }
    })().catch((reason) => {
      if (!controller.signal.aborted) {
        setReady(false);
        if (reason instanceof LearningApiError && [401, 404, 410].includes(reason.status)) { void document.loadingTask.destroy(); setDocument(null); }
        setError(reason instanceof LearningApiError ? learningErrorMessage(reason) : "这一页暂时无法显示。原件仍已保存，可换页或重新打开；没有补猜页面内容。");
      }
    });
    const target = canvas.current;
    return () => { controller.abort(); cancel?.(); if (target) { target.width = 0; target.height = 0; } };
  }, [document, physicalPage, zoom, width, pageId, material.id, hidden, regions]);
  const jump = (number: number) => {
    if (!Number.isInteger(number) || number < 1 || number > metadata.pageCount) return;
    if (number !== physicalPage) { setReady(false); setPhysicalPage(number); }
    const url = new URL(window.location.href); url.searchParams.set("material", material.id);
    url.searchParams.set("pdfPage", String(number)); url.searchParams.delete("paragraph");
    window.history.replaceState(window.history.state, "", url);
  };
  return <div>
    <h3>{material.filename}</h3>
    <p className={styles.muted}>原件已保存 · {metadata.pageCount} 个物理页。可按原文件页序查看。</p>
    <div className={styles.pdfToolbar}>
      <button type="button" disabled={physicalPage === 1} onClick={() => jump(physicalPage - 1)}>上一页</button>
      <form className={styles.row} onSubmit={(event) => { event.preventDefault(); jump(Number(new FormData(event.currentTarget).get("pdfPage"))); }}>
        <label className={styles.jumpLabel}>物理页<input name="pdfPage" type="number" min={1} max={metadata.pageCount} step={1} required defaultValue={physicalPage} key={physicalPage} /></label>
        <span>/ {metadata.pageCount}</span><button type="submit">跳转原页</button>
      </form>
      <button type="button" disabled={physicalPage === metadata.pageCount} onClick={() => jump(physicalPage + 1)}>下一页</button>
      <label>缩放<select aria-label="缩放" value={zoom} onChange={(event) => { setReady(false); setZoom(Number(event.target.value)); }}>
        <option value={0.5}>50%</option><option value={1}>适合宽度</option><option value={1.5}>150%</option><option value={2}>200%</option>
      </select></label>
      <a href={`?material=${encodeURIComponent(material.id)}&pdfPage=${physicalPage}`}>第 {physicalPage} 页定位链接</a>
    </div>
    <p className={styles.muted}>物理页从 PDF 第一页开始计数，与纸面印刷页码可能不同。橙色框标记解析来源区域，不表示内容已核实。</p>
    {error ? <p role="alert" className={styles.error}>{error} <button type="button" onClick={() => setEpoch((value) => value + 1)}>重新读取原件</button></p>
      : <p role="status">{ready ? `原页可查看 · 第 ${physicalPage} / ${metadata.pageCount} 个物理页` : hidden ? "返回页面时会重新检查原件访问权限。" : "正在读取原页…"}</p>}
    <div ref={viewport} className={styles.pdfViewport}>
      <canvas ref={canvas} role="img" aria-label={`PDF 原页：${material.filename}，物理页 ${physicalPage}`} data-physical-page={physicalPage} data-ready={ready} style={{ visibility: ready && !hidden && !error ? "visible" : "hidden" }} />
    </div>
  </div>;
}
