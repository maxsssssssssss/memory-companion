"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { type LearningPage, type LearningSource } from "@/lib/domain/learning";
import type { LearningPreparationRun } from "@/lib/domain/learning-preparation";
import { LearningApiError, learningApi, learningErrorMessage } from "@/lib/client/learning-api";
import { ProductDialog, ProductEvidence, ProductState } from "@/components/product-system/product-primitives";
import { LearningMaterialInput } from "./learning-material-input";
import { LearningAudio } from "./learning-audio";
import { LearningFramework } from "./learning-framework";
import { LearningPdfStudy } from "./learning-pdf-study";
import { LearningQuiz } from "./learning-quiz";
import { LearningPreparation } from "./learning-preparation";
import styles from "./learning.module.css";
import { useLearningUnsaved } from "./use-learning-unsaved";
import { clearLearningReadingState, useLearningReadingKey } from "./learning-reading-state";

const LearningPdfViewer = dynamic(() => import("./learning-pdf-viewer"), { ssr: false, loading: () => <p role="status">正在打开 PDF 查看器…</p> });

export function LearningWorkspace({ pageId }: { pageId: string }) {
  return <LearningWorkspaceContent key={pageId} pageId={pageId} />;
}

function LearningWorkspaceContent({ pageId }: { pageId: string }) {
  const router = useRouter();
  const readingKey = useLearningReadingKey(pageId);
  const [page, setPage] = useState<LearningPage | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [source, setSource] = useState<LearningSource | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [paragraph, setParagraph] = useState(1);
  const [regions,setRegions]=useState<Array<{physicalPage:number;box:[number,number,number,number]}>>([]);
  const sourceEpoch=useRef(0);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [preparationEpoch, setPreparationEpoch] = useState(0);
  const [frameworkEpoch, setFrameworkEpoch] = useState(0);
  const [preparationActive, setPreparationActive] = useState(false);
  const [materialDialogOpen, setMaterialDialogOpen] = useState(false);
  const [preparationStatus, setPreparationStatus] = useState("查看材料");
  const [attempt, setAttempt] = useState(0);
  const [area, setArea] = useState("read");
  const [visitedQuiz, setVisitedQuiz] = useState(false);
  const [expandedSource, setExpandedSource] = useState(false);
  const initialized = useRef(false);
  const scrollPositions = useRef<Record<string, number>>({});
  const [confirmation, setConfirmation] = useState<{ kind: "page" } | { kind: "material"; id: string; title: string } | null>(null);
  const mutating = useRef(false);
  const pageRef = useRef<LearningPage | null>(null);
  const selectedRef = useRef<string[]>([]);
  const selectionDirty = useRef(false);
  const selectionVersion = useRef(0);
  const selectionWork = useRef<Promise<void> | null>(null);
  const preparationSubmission = useRef<{ id: string; materialIds: string[] } | null>(null);
  const alive = useRef(true);
  const removed = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const publish = useCallback((value: LearningPage) => {
    if (!alive.current || removed.current || (pageRef.current && value.revision < pageRef.current.revision)) return;
    const previousIds = new Set(pageRef.current?.materials.map(item => item.id));
    const next = selectionDirty.current
      ? [...selectedRef.current.filter(id => value.materials.some(item => item.id === id)),
        ...value.materials.filter(item => !previousIds.has(item.id) && item.selected).map(item => item.id)]
      : value.materials.filter(item => item.selected).map(item => item.id);
    pageRef.current = value; selectedRef.current = next;
    setPage(value); setSelected(next);
  }, []);
  const saveSelection = useCallback((): Promise<void> => {
    if (selectionWork.current) return selectionWork.current;
    if (!selectionDirty.current || !pageRef.current) return Promise.resolve();
    setSelectionSaving(true); setSelectionError("");
    const work = (async () => {
      while (selectionDirty.current && pageRef.current && alive.current && !removed.current) {
        const version = selectionVersion.current;
        const result = await learningApi.select(pageId, pageRef.current.revision, [...selectedRef.current]);
        if (!alive.current || removed.current) return;
        if (result.page.revision < pageRef.current.revision) throw new LearningApiError(409, "source_changed");
        if (version === selectionVersion.current) selectionDirty.current = false;
        publish(result.page);
      }
    })().catch(reason => {
      if (alive.current) setSelectionError(learningErrorMessage(reason));
      throw reason;
    }).finally(() => { selectionWork.current = null; if (alive.current) setSelectionSaving(false); });
    selectionWork.current = work;
    return work;
  }, [pageId, publish]);
  const preparationUpdated = useCallback(async (runs: LearningPreparationRun[]) => {
    try {
      const result = await learningApi.get(pageId);
      if (!alive.current || removed.current) return;
      publish(result.page);
      if (runs.some(run => run.id === preparationSubmission.current?.id)) preparationSubmission.current = null;
      setFrameworkEpoch(value => value + 1);
    } catch (reason) {
      if (alive.current && reason instanceof LearningApiError && [401, 404, 410].includes(reason.status)) { setPage(null); setActive(null); setSource(null); }
      throw reason;
    }
  }, [pageId, publish]);
  const prepareSelected = async () => {
    setMaterialDialogOpen(true);
    await saveSelection();
    const request = preparationSubmission.current ?? { id: crypto.randomUUID(), materialIds: [...selectedRef.current] };
    preparationSubmission.current = request;
    try {
      await learningApi.startPreparation(pageId, request.id, request.materialIds);
      preparationSubmission.current = null;
    } catch (reason) {
      if (reason instanceof LearningApiError && reason.status < 500) preparationSubmission.current = null;
      throw reason;
    } finally { if (alive.current) setPreparationEpoch(value => value + 1); }
  };
  const closeDialog = useCallback(() => { if (!mutating.current) setConfirmation(null); }, []);
  const closeSource = useCallback(() => {
    sourceEpoch.current++; setActive(null); setSource(null); setRegions([]); setExpandedSource(false);
    const url = new URL(window.location.href);
    for (const key of ["material", "paragraph", "pdfPage"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const changeArea = (next: string) => {
    scrollPositions.current[area] = window.scrollY;
    setArea(next); if (next === "quiz") setVisitedQuiz(true);
    const url = new URL(window.location.href); url.searchParams.set("view", next);
    window.history.replaceState(window.history.state, "", url);
    if (next !== "read") requestAnimationFrame(() => window.scrollTo(0, scrollPositions.current[next] ?? 0));
  };
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setActive(query.get("material"));
    setParagraph(Math.max(1, Number(query.get("pdfPage") ?? query.get("paragraph")) || 1));
    const controller = new AbortController();
    void learningApi.get(pageId, controller.signal).then(({ page: value }) => {
      if (!controller.signal.aborted) {
        publish(value); setError("");
        if (!initialized.current) {
          const next = query.get("view");
          const initialArea = next === "quiz" || next === "materials" ? next : value.materialCount ? "read" : "materials";
          setArea(initialArea);
          const url = new URL(window.location.href); url.searchParams.set("view", initialArea);
          window.history.replaceState(window.history.state, "", url);
          setVisitedQuiz(next === "quiz"); initialized.current = true;
        }
      }
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setError(learningErrorMessage(reason));
      if (reason instanceof LearningApiError && [401, 404, 410].includes(reason.status)) { setPage(null); setActive(null); setSource(null); }
    });
    return () => controller.abort();
  }, [pageId, attempt, publish]);
  const activeMaterial = page?.materials.find(item => item.id === active);
  useEffect(() => {
    setSource(null); setSourceError(""); setRaw(false);
    if (!active || !activeMaterial || activeMaterial.kind === "pdf") return;
    const controller = new AbortController();
    void learningApi.source(pageId, active, controller.signal).then(({ source: result }) => {
      if (!controller.signal.aborted) setSource(result);
    }).catch((reason) => { if (!controller.signal.aborted) setSourceError(learningErrorMessage(reason)); });
    return () => controller.abort();
  }, [active, pageId, activeMaterial?.id, activeMaterial?.kind, activeMaterial?.audio?.transcription]);
  useEffect(() => {
    // Real paragraph heights are required here: estimated content-visibility
    // heights shift a late paragraph away after the drawer has scrolled to it.
    if (!raw && source) document.getElementById(`learning-paragraph-${paragraph}`)?.scrollIntoView?.({ block: "start" });
  }, [paragraph, raw, source]);

  const viewSource = (id: string | null, sourceParagraph = 1, parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding) => {
    setMaterialDialogOpen(false);
    const token=++sourceEpoch.current;setRegions([]);
    if(id&&parsed)void learningApi.parsedSource(pageId,id,parsed.documentId,parsed.blockId).then(r=>{if(token===sourceEpoch.current&&r.state==="available")setRegions(r.source.source_regions.map(r=>({physicalPage:r.physical_page,box:r.normalized_bbox})));}).catch(e=>{if(token===sourceEpoch.current)setError(learningErrorMessage(e));});
    setActive(id); setParagraph(sourceParagraph); setRaw(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("pdfPage"); url.searchParams.delete("paragraph");
    if (id) { url.searchParams.set("material", id); url.searchParams.set(page?.materials.find((item) => item.id === id)?.kind === "pdf" ? "pdfPage" : "paragraph", String(sourceParagraph)); }
    else { url.searchParams.delete("material"); }
    window.history.replaceState(window.history.state, "", url);
  };
  const jump = (number: number) => {
    setParagraph(number);
    const url = new URL(window.location.href); url.searchParams.set("paragraph", String(number));
    window.history.replaceState(null, "", url);
    document.getElementById(`learning-paragraph-${number}`)?.focus();
  };
  const mutate = async (work: () => Promise<void>) => {
    if (mutating.current) return;
    mutating.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); }
    catch (reason) { setError(learningErrorMessage(reason)); }
    finally { mutating.current = false; setBusy(false); }
  };
  const selectionChanged = page && page.materials.some((item) => item.selected !== selected.includes(item.id));
  useLearningUnsaved(Boolean(selectionChanged));
  const activePdf = page?.materials.find((item) => item.id === active && item.kind === "pdf" && item.pdf);
  return <>
    {error ? <ProductState tone="error" title={error} action={<div className={styles.row}>
      <button type="button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>重新载入</button>
      <Link href="/date-companion">返回登录</Link>
    </div>} /> : null}
    {!page ? (!error ? <ProductState tone="loading" title="正在读取学习页…" /> : null) : <>
      <header className={styles.pageHeader}>
        <div><h1>{page.title}</h1><p className={styles.muted}>{page.materialCount} 份材料 · 选定 {selected.length} 份用于学习
          {page.materials.some(item => item.kind === "audio") ? ` · 录音转写 ${page.materials.filter(item => item.audio?.transcription === "completed").length}/${page.materials.filter(item => item.kind === "audio").length} 份完成${page.materials.some(item => item.audio?.transcription === "processing") ? "，处理中" : ""}` : ""}</p></div>
        <div className={styles.pageActions}>
          <button className={styles.materialProgressEntry} type="button" aria-haspopup="dialog" aria-expanded={materialDialogOpen} onClick={() => setMaterialDialogOpen(true)}>材料进度<span aria-live="polite">{preparationStatus}</span></button>
          <details className={styles.pageMore}><summary>学习页管理</summary><button className={styles.danger} disabled={busy} onClick={() => setConfirmation({ kind: "page" })} type="button">删除学习页</button></details>
        </div>
      </header>
      <nav className={styles.taskNav} aria-label="学习任务">
        {[['read', '阅读框架'], ['quiz', 'Quiz 练习']].map(([id, label]) => <button key={id} type="button" aria-pressed={area === id} onClick={() => changeArea(id)}>{label}</button>)}
        <button className={styles.materialsEntry} type="button" aria-pressed={area === "materials"} onClick={() => changeArea("materials")}>材料</button>
      </nav>
      <LearningPreparation pageId={pageId} refreshKey={preparationEpoch} onUpdated={preparationUpdated} onActive={setPreparationActive} onStatus={setPreparationStatus}
        onMaterials={() => { setMaterialDialogOpen(false); changeArea("materials"); }} onRead={() => { setMaterialDialogOpen(false); changeArea("read"); }} onQuiz={() => { setMaterialDialogOpen(false); changeArea("quiz"); }}
        saveSelection={saveSelection} disabled={busy} onBusy={value => { mutating.current = value; setBusy(value); }}
        renderContent={progress => <LearningMaterialInput pageId={pageId} disabled={busy} onSaved={publish} hidden={area !== "materials"}
          dialogOpen={materialDialogOpen} onDialogChange={setMaterialDialogOpen} progress={progress}
          onPreparation={() => setPreparationEpoch(value => value + 1)} onBusy={value => { mutating.current = value; setBusy(value); }}
          advanced={page.materials.length ? <>
            <LearningAudio page={page} selected={selected} disabled={busy || preparationActive} onUpdated={publish} saveSelection={saveSelection} />
            {page.materials.filter(m => m.kind === "pdf").map(material => <LearningPdfStudy key={material.id} page={page} material={material} disabled={busy || preparationActive} onUpdated={publish} onSource={viewSource} />)}
          </> : null} />} />
      <div hidden={area !== "read"}>
      <LearningFramework pageId={pageId} materials={page.materials} selected={selected} disabled={busy || preparationActive} onSource={viewSource}
        readingActive={area === "read"} refreshKey={frameworkEpoch} preparationActive={preparationActive} onPrepare={prepareSelected} saveSelection={saveSelection} />
      </div>
      <div hidden={area !== "quiz"}>
      {visitedQuiz ? <LearningQuiz pageId={pageId} materials={page.materials} selected={selected} disabled={busy} onSource={viewSource}
        saveSelection={saveSelection} /> : null}
      </div>
      <div hidden={area !== "materials"}>
      <section className={styles.section} aria-labelledby="saved-materials-title">
        <div className={styles.sectionHeader}><h2 id="saved-materials-title">已保存材料</h2><span>本次范围：{selected.length} 份</span></div>
        <p className={styles.muted}>按需调整学习范围，选择会自动保存。已有框架和练习保留。</p>
        {page.materials.length ? <>
          <ul className={styles.materialList}>{page.materials.map((item) => <li key={item.id}>
            <label className={styles.materialCheck}><input type="checkbox" checked={selected.includes(item.id)} disabled={busy} onChange={(event) => {
              const next = event.target.checked ? [...selectedRef.current, item.id] : selectedRef.current.filter(id => id !== item.id);
              selectedRef.current = next; selectionDirty.current = true; selectionVersion.current++;
              setSelected(next); setNotice(""); void saveSelection().catch(() => {});
            }} /><span><strong>{item.title}</strong><small>{item.kind === "pdf" ? `PDF · ${item.pdf?.pageCount} 页 · ${item.pdfStudy ? `可用范围 ${item.pdfStudy.physicalPages.length}/${item.pdf?.pageCount} 页 · 内容未核实` : "原件已保存 · 尚无可用学习范围"}` : item.kind === "audio" ? `录音 · ${Math.round(item.audio?.durationSeconds ?? 0)} 秒 · ${item.audio?.transcription === "completed" ? "转写完成" : item.audio?.transcription === "processing" ? "正在转写" : item.audio?.transcription === "failed" ? "转写未完成，原音保留" : "原音已保存，尚未转写"}` : item.kind === "txt" ? "TXT" : "粘贴文本"}</small>
              {item.kind === "pdf" ? <small>文件名：{item.filename}
                {item.pdf?.compatibilityWarnings?.some((warning) => warning.code === "long_name_preserved") ? " · 兼容提示：较长 PDF 名称已完整保留" : ""}
                {item.pdf?.compatibilityWarnings?.some((warning) => warning.code === "font_hinting_removed") ? " · 兼容提示：部分字体已停用无效微调指令，请核对原页显示" : ""}
              </small> : null}</span></label>
            <div className={styles.row}>
              <button type="button" onClick={() => viewSource(item.id)} aria-label={`${item.kind === "pdf" ? "查看原页" : "查看原文"} ${item.title}`}>{item.kind === "pdf" ? "查看原页" : "查看原文"}</button>
              <button type="button" className={styles.danger} disabled={busy} aria-label={`删除材料 ${item.title}`} onClick={() => setConfirmation({ kind: "material", id: item.id, title: item.title })}>删除</button>
            </div>
          </li>)}</ul>
          <p className={styles.muted} role="status">{selectionSaving ? "正在保存选择…" : selectionChanged ? "选择尚未保存，本地选择已保留" : "选择已自动保存"}</p>
          {selectionError ? <div className={styles.error} role="alert"><p>{selectionError}</p><button type="button" disabled={selectionSaving} onClick={() => { void learningApi.get(pageId).then(result => { publish(result.page); return saveSelection(); }).catch(reason => setSelectionError(learningErrorMessage(reason))); }}>重试保存选择</button></div> : null}
        </> : <ProductState tone="empty" title="还没有已保存材料" description="添加课件、录音或笔记，准备好后一起整理。" />}
      </section>
      {notice ? <p role="status">{notice}</p> : null}
      </div>
      <div className={styles.sourceDrawer} data-expanded={expandedSource}>
      <ProductDialog open={Boolean(active)} title="材料原文" onClose={closeSource}>
      {active ? <section aria-label="材料原文">
        <div className={styles.sectionHeader}><button type="button" onClick={() => setExpandedSource(value => !value)}>{expandedSource ? "恢复侧栏宽度" : "展开阅读"}</button><button type="button" onClick={closeSource}>关闭原文</button></div>
        {activePdf ? <LearningPdfViewer key={`${activePdf.id}-${paragraph}`} pageId={pageId} material={activePdf} initialPage={paragraph} regions={regions} /> : sourceError ? <ProductState tone="error" title={sourceError} /> : !source ? <ProductState tone="loading" title="正在读取原文…" /> : <>
          <h3>{source.material.title}</h3>
          <p className={styles.muted}>{source.material.kind === "audio" ? "以下为 ASR 转写，可能包含错词；时间位置来自 ASR，不代表内容正确。原音保留，但本版不回听。" : "以下是材料原文，未经 AI 改写。段落按空行划分；段内换行保留。"}</p>
          <div className={styles.row}>
            <button type="button" aria-pressed={raw} onClick={() => setRaw((value) => !value)}>{raw ? "按段落查看" : "查看连续原文"}</button>
            {!raw ? <form className={styles.row} onSubmit={(event) => {
              event.preventDefault(); const value = new FormData(event.currentTarget).get("paragraph"); jump(Number(value));
            }}><label className={styles.jumpLabel}>定位段落<input name="paragraph" type="number" min={1} max={source.paragraphs.length} defaultValue={Math.min(paragraph, source.paragraphs.length)} key={`${source.material.id}-${paragraph}`} required /></label>
              <span>共 {source.paragraphs.length} 段</span><button type="submit">定位</button></form> : null}
          </div>
          {paragraph > source.paragraphs.length ? <p role="alert">该段落不存在，请选择有效段落。</p> : null}
          {raw ? <pre className={styles.original}>{source.text}</pre> : <div className={styles.paragraphs}>
            {source.paragraphs.map((item) => <div id={`learning-paragraph-${item.number}`} key={item.number} tabIndex={-1} data-current={item.number === paragraph}>
              <ProductEvidence label={`第 ${item.number} 段${item.startSeconds === undefined ? "" : ` · ${item.startSeconds.toFixed(1)}–${item.endSeconds?.toFixed(1)} 秒`}`} meta={<button type="button" onClick={() => jump(item.number)} aria-label={`定位第 ${item.number} 段`}>定位此段</button>}>
                <span className={styles.original}>{item.text}</span>
              </ProductEvidence>
            </div>)}
          </div>}
        </>}
      </section> : null}</ProductDialog></div>
      <ProductDialog open={confirmation !== null} title={confirmation?.kind === "page" ? `删除「${page.title}」？` : `删除「${confirmation?.title ?? "这份材料"}」？`} onClose={closeDialog}
        footer={<div className={styles.row}>
          <button type="button" disabled={busy} onClick={closeDialog}>取消</button>
          <button type="button" className={styles.danger} disabled={busy} onClick={() => void mutate(async () => {
            if (!confirmation) return;
            if (confirmation.kind === "page") {
              setActive(null); setSource(null); await learningApi.deletePage(pageId); removed.current = true; clearLearningReadingState(readingKey); setPage(null); router.replace("/learning");
            } else {
              if (active === confirmation.id) viewSource(null);
              const result = await learningApi.deleteMaterial(pageId, confirmation.id); publish(result.page); setNotice("材料原文已删除，已从本次范围移除。");
            }
            setConfirmation(null);
          })}>{busy ? "正在删除…" : confirmation?.kind === "page" ? "删除学习页" : "删除这份材料"}</button>
        </div>}>
        {confirmation?.kind === "page" ? <p>将永久删除这个学习页的全部材料、框架、笔记、对话和练习记录，无法恢复。</p> : <p>将删除这份材料及其解析内容，但保留已有学习成果和作答记录。相关原文将无法回看，已有成果中可能仍包含材料摘录。</p>}
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      </ProductDialog>
    </>}
  </>;
}
