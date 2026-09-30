"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LearningMaterial } from "@/lib/domain/learning";
import type { FrameworkChapter, FrameworkNode, FrameworkView } from "@/lib/domain/learning-framework";
import { LEARNING_INVALIDATION_CHANNEL, LearningApiError, learningApi, learningErrorMessage } from "@/lib/client/learning-api";
import styles from "./learning.module.css";
import { LearningRelations, LearningNodeConversation } from "./learning-study";
import { useLearningUnsaved } from "./use-learning-unsaved";
import { useLearningReadingKey } from "./learning-reading-state";
import { useLearningReadingPosition } from "./use-learning-reading-position";

type Editor = { chapter: FrameworkChapter; node?: FrameworkNode; title: string; explanation: string; note: string };
export function LearningFramework({ pageId, materials, selected, disabled, saveSelection, onSource, refreshKey = 0, preparationActive = false, onPrepare, readingActive = true }: {
  pageId: string; materials: LearningMaterial[]; selected: string[]; disabled: boolean;
  refreshKey?: number; preparationActive?: boolean; onPrepare?: () => Promise<void>; readingActive?: boolean;
  saveSelection: () => Promise<void>; onSource: (materialId: string, paragraph: number, parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding) => void;
}) {
  const [view, setView] = useState<FrameworkView | null>(null);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [openConversations, setOpenConversations] = useState<Set<string>>(() => new Set());
  const [conversation, setConversation] = useState<string | null>(null);
  const readingKey = useLearningReadingKey(pageId);
  const { reader, map, chapterId, chooseChapter, readInMap, mapOpen, toggleMap } = useLearningReadingPosition({
    readingKey, pageId, chapters: view?.chapters ?? [], ready: view !== null, active: readingActive,
  });
  const [directory, setDirectory] = useState("framework");
  const [managing, setManaging] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const closeConversation = useCallback(() => setConversation(null), []);
  const dirty = Boolean(editor && (editor.title !== (editor.node?.title ?? editor.chapter.title)
    || editor.explanation !== (editor.node?.explanation ?? editor.chapter.explanation) || editor.note !== (editor.node?.note ?? "")));
  useLearningUnsaved(dirty);
  const [uncertain, setUncertain] = useState<{ id: string; ids: string[] } | null>(null);
  const alive = useRef(true);
  const mutation = useRef(false);
  const generating = useRef(false);
  const reads = useRef(0);
  const editorTitle = useRef<HTMLInputElement>(null);
  const active = view?.runs.some((r) => r.status === "generating" || r.status === "validating") ?? false;
  const audioPending = materials.some((m) => selected.includes(m.id) && m.kind === "audio" && m.audio?.transcription !== "completed");
  const pdfSelected = materials.some((m) => selected.includes(m.id) && m.kind === "pdf" && !m.pdfStudy);
  const reload = useCallback(async () => {
    const sequence = ++reads.current;
    try {
      const result = await learningApi.framework(pageId);
      if (alive.current && sequence === reads.current) setView(result.framework);
    } catch (reason) {
      if (!alive.current || sequence !== reads.current) return;
      setError(learningErrorMessage(reason));
      if (reason instanceof LearningApiError && [401, 404, 410].includes(reason.status)) { setView(null); setEditor(null); }
    }
  }, [pageId]);
  useEffect(() => {
    alive.current = true;
    void reload();
    const refresh = () => { void reload(); };
    window.addEventListener("focus", refresh);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(LEARNING_INVALIDATION_CHANNEL);
    if (channel) channel.onmessage = (event) => { if (event.data?.pageId === pageId) refresh(); };
    return () => { alive.current = false; reads.current++; channel?.close(); window.removeEventListener("focus", refresh); };
  }, [pageId, reload]);
  useEffect(() => {
    if (!active && !starting && !uncertain) return;
    const timer = setInterval(() => { void reload(); }, 1500);
    return () => clearInterval(timer);
  }, [active, starting, uncertain, reload]);
  useEffect(() => { void reload(); }, [materials, reload]);
  useEffect(() => { if (refreshKey) void reload(); }, [refreshKey, reload]);
  useEffect(() => {
    if (uncertain && view?.runs.some((r) => r.id === uncertain.id)) setUncertain(null);
  }, [view, uncertain]);
  useEffect(() => { editorTitle.current?.focus(); }, [editor?.chapter.id, editor?.node?.id]);

  const organize = async () => {
    if (generating.current || active || starting) return;
    generating.current = true; setStarting(true); setError("");
    const submission = uncertain ?? { id: crypto.randomUUID(), ids: [...selected] };
    try {
      if (onPrepare) { await onPrepare(); await reload(); return; }
      if (!uncertain) await saveSelection();
      // Retain the same ID if the HTTP outcome is unknown; never silently replay with a new ID.
      setUncertain(submission);
      const generated = await learningApi.organize(pageId, submission.id, submission.ids);
      if (alive.current && generated?.overviewError) setError(`章节已保存；关系总览未更新。${learningErrorMessage(new LearningApiError(409, generated.overviewError))}`);
      if (alive.current) setUncertain(null);
      await reload();
    } catch (reason) {
      if (alive.current) {
        setError(learningErrorMessage(reason));
        if (reason instanceof LearningApiError && (reason.status < 500 || reason.code === "learning_generation_not_configured")) setUncertain(null);
      }
      await reload();
    } finally { generating.current = false; if (alive.current) setStarting(false); }
  };
  const saveEditor = async () => {
    if (!editor || mutation.current) return;
    mutation.current = true; setSaving(true); setError("");
    try {
      await learningApi.editFramework(pageId, editor.node
        ? { kind: "node", chapterId: editor.chapter.id, revision: editor.chapter.revision, nodeId: editor.node.id,
          title: editor.title, explanation: editor.explanation, note: editor.note }
        : { kind: "chapter", chapterId: editor.chapter.id, revision: editor.chapter.revision, title: editor.title, explanation: editor.explanation });
      if (alive.current) setEditor(null);
      await reload();
    } catch (reason) { if (alive.current) setError(learningErrorMessage(reason)); await reload(); }
    finally { mutation.current = false; if (alive.current) setSaving(false); }
  };
  const move = async (chapter: FrameworkChapter, node: FrameworkNode, target: FrameworkChapter, position: number) => {
    if (mutation.current) return;
    mutation.current = true; setSaving(true); setError("");
    try {
      await learningApi.editFramework(pageId, { kind: "move", chapterId: chapter.id, revision: chapter.revision, nodeId: node.id,
        targetChapterId: target.id, targetRevision: target.revision, position });
      await reload();
    } catch (reason) { if (alive.current) setError(learningErrorMessage(reason)); await reload(); }
    finally { mutation.current = false; if (alive.current) setSaving(false); }
  };
  const openSource = async (chapter: FrameworkChapter, node: FrameworkNode, index: number) => {
    setError("");
    try {
      const result = await learningApi.frameworkSource(pageId, chapter.id, node.id, index);
      if (alive.current) onSource(result.source.materialId, result.source.paragraph.parsed?.physicalPage ?? result.source.paragraph.number, result.source.paragraph.parsed);
    } catch (reason) { if (alive.current) setError(learningErrorMessage(reason)); }
  };
  const activeChapter = view?.chapters.find(c => c.id === chapterId)?.id ?? view?.chapters[0]?.id;
  const editForm = editor ? <form className={styles.frameworkEditor} aria-label="编辑框架" onSubmit={event => { event.preventDefault(); void saveEditor(); }}>
    <h3>{editor.node ? "编辑知识点与个人笔记" : "编辑章节"}</h3>
    <label>标题<input ref={editorTitle} required maxLength={160} value={editor.title} disabled={saving} onChange={e => setEditor({ ...editor, title: e.target.value })} /></label>
    <label>解释<textarea aria-label="解释" required rows={6} maxLength={20000} value={editor.explanation} disabled={saving} onChange={e => setEditor({ ...editor, explanation: e.target.value })} /></label>
    {editor.node ? <label>个人笔记<textarea aria-label="个人笔记" rows={4} maxLength={20000} value={editor.note} disabled={saving} onChange={e => setEditor({ ...editor, note: e.target.value })} /></label> : null}
    <p className={styles.muted}>修改只影响学习成果，原文和来源保留。保存失败时草稿仍在。</p>
    <div className={styles.row}><button type="submit" disabled={saving} className={styles.primary}>{saving ? "正在保存…" : "保存修改"}</button>
      <button type="button" disabled={saving} onClick={() => { if (!dirty || window.confirm("修改尚未保存，确定放弃这些修改？")) setEditor(null); }}>取消编辑</button></div>
  </form> : null;
  return <section ref={reader} className={`${styles.section} ${styles.readingSection}`} aria-label="知识框架">
    <div className={styles.sectionHeader}><h2>知识框架</h2><div className={styles.row}>
      {view?.chapters.length ? <><button type="button" aria-pressed={managing} onClick={() => setManaging(v => !v)}>编辑与管理</button><button type="button" aria-expanded={showGenerate} onClick={() => setShowGenerate(v => !v)}>整理新材料</button></> : null}
    </div></div>
    {!preparationActive && (showGenerate || !view?.chapters.length || active || starting || uncertain) ? <div className={styles.generation}>
      <p className={styles.muted}>{onPrepare ? "准备选定材料并整理为新章节。已有正文、修改和笔记会保留。" : "将选定材料整理为新章节。已有正文、修改和笔记会保留。"}</p>
      <div className={styles.row}><button type="button" className={styles.primary} disabled={disabled || active || starting || (!uncertain && (!selected.length || (!onPrepare && (pdfSelected || audioPending))))} onClick={() => void organize()}>
        {starting || active ? "正在整理…" : uncertain ? "核对并继续本次整理" : "整理所选材料"}</button><span className={styles.muted}>已选 {selected.length} 份材料</span></div>
      {pdfSelected && !onPrepare ? <p role="status">所选 PDF 尚未设置可用学习范围，请到材料区完成解析并选择页码。不会忽略这份材料。</p> : null}
      {audioPending && !onPrepare ? <p role="status">所选录音尚未完成转写，请先到材料区转写。</p> : null}
    </div> : null}
    {error ? <div role="alert" className={styles.error}><p>{error}</p><button type="button" onClick={() => void reload()}>核对已保存内容</button></div> : null}
    {uncertain ? <p role="status">正在核对这次整理结果，请保留当前页面。核对完成前不会开始另一份整理。</p> : null}
    {!preparationActive ? view?.runs.filter(r => r.status !== "completed").map(run => <p key={run.id} role="status" className={styles.muted}>
      {run.status === "failed" ? learningErrorMessage(new LearningApiError(409, run.failure ?? "framework_provider_failed")) : run.status === "validating" ? "正在检查来源并保存章节…" : "正在整理章节，旧成果仍可阅读…"}
    </p>) : null}
    {!view ? <p role="status">正在读取框架…</p> : !view.chapters.length ? <p className={styles.muted}>{preparationActive ? "材料正在整理，完成后会在这里显示知识框架。" : "添加材料后即可开始整理。也可以选用已准备好的材料，直接进入 Quiz。"}</p> : <div className={styles.readerLayout}>
      <aside className={styles.readerNav} aria-label="阅读目录">
        <div className={styles.directoryTabs}><button type="button" aria-pressed={directory === "framework"} onClick={() => setDirectory("framework")}>AI 框架</button><button type="button" aria-pressed={directory === "materials"} onClick={() => setDirectory("materials")}>原材料</button></div>
        <label className={styles.mobileDirectory}>{directory === "framework" ? "当前章节" : "查看原材料"}<select value={directory === "framework" ? activeChapter ?? "" : ""} onChange={event => { if (directory === "framework") chooseChapter(event.target.value); else if (event.target.value) onSource(event.target.value, 1); }}>
          {directory === "framework" ? view.chapters.map(c => <option key={c.id} value={c.id}>{c.title}</option>) : <><option value="">选择材料查看</option>{materials.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</>}
        </select></label>
        {directory === "framework" ? <nav aria-label="章节目录">{view.chapters.map((chapter, i) => <button type="button" key={chapter.id} aria-current={activeChapter === chapter.id ? "location" : undefined} onClick={() => chooseChapter(chapter.id)}><span>{i + 1}. {chapter.title}</span><small>{chapter.nodes.length} 个知识点</small></button>)}</nav>
          : <nav aria-label="原材料目录">{materials.map(m => <button type="button" key={m.id} onClick={() => onSource(m.id, 1)}>{m.title}<small>{m.kind === "pdf" ? "PDF 原页" : m.kind === "audio" ? "录音转写" : "文本原文"}</small></button>)}</nav>}
      </aside>
      <div className={styles.readerBody}>
        <details ref={map} className={styles.relations} open={mapOpen} onToggle={event => { if (event.target === event.currentTarget) toggleMap(event.currentTarget.open); }}><summary>思维导图 · {view.chapters.length} 章</summary>
          <LearningRelations pageId={pageId} readingKey={readingKey} materials={materials} onSource={onSource} chapters={view.chapters} onChapter={id => readInMap(id)} onNode={readInMap}
            refreshKey={String(starting) + view.chapters.map(c => c.id + ':' + c.revision).join(',') + materials.map(m => m.id).join(',')} />
          <details><summary>历次整理说明</summary>{view.runs.filter(r => r.overview).map((r, i) => <div key={r.id}><h3>第 {i + 1} 次整理</h3><p className={styles.original}>{r.overview}</p></div>)}</details>
        </details>
        <p className={styles.muted}>AI 整理可能有误，请结合来源阅读；框架不等同于原材料目录。</p>
        {view.chapters.map(chapter => <section hidden={activeChapter !== chapter.id} key={chapter.id} id={"chapter-" + chapter.id} tabIndex={-1} className={styles.frameworkChapter}>
          <h2>{chapter.title}</h2><p className={styles.original}>{chapter.explanation}</p>
          {managing ? <button type="button" disabled={saving || !!editor} onClick={() => setEditor({ chapter, title: chapter.title, explanation: chapter.explanation, note: "" })}>编辑章节</button> : null}
          {editor?.chapter.id === chapter.id && !editor.node ? editForm : null}
          {chapter.nodes.map((node, index) => <article key={node.id} id={"knowledge-" + node.id} tabIndex={-1} className={styles.frameworkNode} aria-label={node.title}>
            <h3>{node.title}</h3><p className={styles.eyebrow}>{node.edited ? "框架正文 · 已编辑" : "框架正文 · AI 整理"}</p><p className={styles.original}>{node.explanation}</p>
            <details className={styles.sourceDisclosure}><summary>引用 · {node.sources.length}</summary><div className={styles.sources} aria-label="知识点来源">{node.sources.map((ref, ri) => {
              const material = materials.find(m => m.id === ref.materialId);
              return <button type="button" key={ri} disabled={!material} onClick={() => void openSource(chapter, node, ri)}>{material ? material.title + ' · ' + (ref.parsed ? '第 ' + ref.parsed.physicalPage + ' 物理页 · 来源区域' : ref.startSeconds !== undefined ? ref.startSeconds.toFixed(1) + '–' + ref.endSeconds?.toFixed(1) + ' 秒' : '第 ' + ref.paragraph + ' 段') : "来源已删除"}</button>;
            })}</div></details>
            {node.supplement ? <aside className={styles.frameworkSupplement}><strong>补充解释 · 材料外</strong><p className={styles.original}>{node.supplement}</p></aside> : null}
            {node.note ? <aside className={styles.frameworkNote}><strong>个人笔记</strong><p className={styles.original}>{node.note}</p></aside> : null}
            <div className={styles.row}><button type="button" aria-expanded={conversation === node.id} onClick={() => { setOpenConversations(old => new Set([...old, node.id])); setConversation(node.id); }}>没看懂 / 继续追问</button>
              <details><summary>更多</summary><button type="button" disabled={saving || !!editor} onClick={() => setEditor({ chapter, node, title: node.title, explanation: node.explanation, note: node.note })}>编辑知识点 / 笔记</button></details></div>
            {managing ? <div className={styles.row}>
              <button type="button" disabled={saving || !!editor || index === 0} onClick={() => void move(chapter, node, chapter, index - 1)}>上移</button>
              <button type="button" disabled={saving || !!editor || index === chapter.nodes.length - 1} onClick={() => void move(chapter, node, chapter, index + 1)}>下移</button>
              <label>移动到章节<select aria-label="移动到章节" value="" disabled={saving || !!editor} onChange={event => { const target = view.chapters.find(c => c.id === event.target.value); if (target) void move(chapter, node, target, target.nodes.length); }}><option value="">选择目标章节</option>{view.chapters.filter(c => c.id !== chapter.id).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
            </div> : null}
            {editor?.node?.id === node.id ? editForm : null}
            {openConversations.has(node.id) ? <LearningNodeConversation pageId={pageId} materials={materials} onSource={onSource} chapter={chapter} node={node} onSaved={reload} open={conversation === node.id} onClose={closeConversation} noteLocked={Boolean(editor)} /> : null}
          </article>)}
        </section>)}
        {editor && editor.chapter.id !== activeChapter ? <p role="status">另一章有未关闭的编辑。<button onClick={() => chooseChapter(editor.chapter.id)}>回到编辑</button></p> : null}
      </div>
    </div>}
  </section>;
}
