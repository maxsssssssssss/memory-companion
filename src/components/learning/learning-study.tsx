"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FrameworkChapter, FrameworkNode } from "@/lib/domain/learning-framework";
import type { LearningMaterial } from "@/lib/domain/learning";
import type { NodeConversation, OverviewView } from "@/lib/domain/learning-study";
import { learningApi, LearningApiError, learningErrorMessage } from "@/lib/client/learning-api";
import styles from "./learning.module.css";
import { ProductDialog } from "@/components/product-system/product-primitives";
import { useLearningUnsaved } from "./use-learning-unsaved";
import { LearningMindMap } from "./learning-mind-map";
type SourceProps = { pageId: string; materials: LearningMaterial[]; onSource: (material: string, paragraph: number, parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding) => void };
const kindLabels = { prerequisite: "前置知识", distinction: "概念区别", complement: "互补内容", connection: "相关联系", conflict: "材料冲突" };
const rejectionLabels: Record<string, string> = { invalid_structure: "关系结构不完整", unknown_chapter: "章节引用不在本次范围", duplicate_chapter: "重复引用同一章节", same_batch: "仅涉及同一批次", source_outside_scope: "来源不在本次材料范围", chapter_evidence_missing: "缺少所关联章节的段落依据" };

export function LearningRelations({ pageId, materials, onSource, refreshKey, chapters, onChapter, onNode, readingKey }: SourceProps & { refreshKey: string; chapters: FrameworkChapter[]; onChapter?: (id: string) => void; onNode?: (chapterId: string, nodeId: string) => void; readingKey?: string }) {
  const [view, setView] = useState<OverviewView | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<string | null>(null);
  const sequence = useRef(0), mounted = useRef(true), writing = useRef(false);
  const reload = useCallback(async () => {
    const seq = ++sequence.current;
    try { const next = await learningApi.overview(pageId); if (mounted.current && seq === sequence.current) setView(next.overview); }
    catch (e) { if (mounted.current && seq === sequence.current) { setError(learningErrorMessage(e)); if (e instanceof LearningApiError && [401,404,410].includes(e.status)) setView(null); } }
  }, [pageId]);
  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; sequence.current++; }; }, [reload, refreshKey]);
  const active = view?.latest?.status === "generating";
  useEffect(() => { if (!active && !busy && !pending) return; let polling = false; const timer = setInterval(() => { if (polling) return; polling = true; void reload().finally(() => { polling = false; }); }, 1500); return () => clearInterval(timer); }, [active, busy, pending, reload]);
  useEffect(() => { if (pending && view?.latest?.id === pending) setPending(null); }, [pending, view]);
  const update = async () => {
    if (writing.current) return; writing.current = true; setBusy(true); setError(""); const id = pending ?? crypto.randomUUID(); setPending(id);
    try { await learningApi.updateOverview(pageId, id); if (mounted.current) setPending(null); await reload(); }
    catch (e) { if (mounted.current) { setError(learningErrorMessage(e)); if (e instanceof LearningApiError && e.status < 500) setPending(null); } }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  };
  const source = async (item: number, index: number) => {
    if (!view?.published) return;
    try { const r = await learningApi.studySource(pageId, "overview", view.published.id, item, index); if (mounted.current) onSource(r.source.materialId, r.source.paragraph.parsed?.physicalPage ?? r.source.paragraph.number, r.source.paragraph.parsed); }
    catch (e) { if (mounted.current) setError(learningErrorMessage(e)); }
  };
  return <section aria-label="章节关系" className={styles.section}>
    {error ? <p role="alert">{error}</p> : null}
    {active || busy ? <p role="status">正在整理关系，旧总览仍可阅读。</p> : null}
    {view?.latest?.status === "failed" ? <p role="status">关系更新未完成，旧版保留。{learningErrorMessage(new LearningApiError(409, view.latest.failure ?? "framework_provider_failed"))}</p> : null}
    {view?.latest?.validation?.rejected.length ? <details aria-label="未发布关系说明">
      <summary>本次 {view.latest.validation.accepted}/{view.latest.validation.submitted} 条关系通过检查，范围不完整</summary>
      <ul>{view.latest.validation.rejected.map(r => <li key={r.index}>第 {r.index + 1} 条：{rejectionLabels[r.reason] ?? "未通过检查"}</li>)}</ul>
      <p className={styles.muted}>仅校验引用与批次结构，不代表内容已经核实。</p>
    </details> : null}
    {view?.published ? <>
      {view.published.stale ? <p role="status">这份关系基于旧章节或来源，尚未反映当前变化。{view.published.sourceState === "material_deleted" ? "相关来源已删除。" : ""}</p> : null}
      <details className={styles.sourceDisclosure}><summary>总览说明</summary><p className={styles.original}>{view.published.result.summary}</p></details>
      {!view.published.result.items.length ? <p>本次未形成有充分依据的章节联系。</p> : null}
    </> : null}
    <LearningMindMap readingKey={readingKey} chapters={chapters} relations={view?.published?.result.items ?? []} onChapter={onChapter} onNode={onNode} renderRelation={(i, actions) => {
      const item = view?.published?.result.items[i];
      return item ? <article className={styles.frameworkNode}>
        <h4>{kindLabels[item.kind]} · {item.title}</h4><p className={styles.original}>{item.explanation}</p>
        <div className={styles.row}>{item.chapterIds.map(id => <a key={id} href={`#chapter-${id}`} onClick={event => { event.preventDefault(); if (actions) actions.navigateChapter(id); else onChapter?.(id); }}>{chapters.find(c => c.id === id)?.title ?? "原章节"}</a>)}</div>
        <details className={styles.sourceDisclosure}><summary>引用 · {item.sources.length}</summary>
          <div className={styles.row}>{item.sources.map((ref,j) => { const m = materials.find(m => m.id === ref.materialId); return <button key={j} type="button" disabled={!m} onClick={() => actions ? actions.beforeSource(() => void source(i,j)) : void source(i,j)}>{m ? `${m.title} · ${ref.parsed ? `第 ${ref.parsed.physicalPage} 物理页 · 来源区域` : `第 ${ref.paragraph} 段`}` : "来源已删除"}</button>; })}</div>
        </details>
      </article> : null;
    }} />
    <button type="button" disabled={busy || active || new Set(chapters.map(c => c.runId)).size < 2} onClick={() => void update()}>{pending ? "核对本次关系更新" : "更新关系总览"}</button>
  </section>;
}

export function LearningNodeConversation({ pageId, materials, onSource, chapter, node, onSaved, open, onClose, noteLocked = false }: SourceProps & { chapter: FrameworkChapter; node: FrameworkNode; onSaved: () => Promise<void>; open?: boolean; onClose?: () => void; noteLocked?: boolean }) {
  const [conversations, setConversations] = useState<NodeConversation[]>([]), [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [newId, setNewId] = useState<string | null>(null);
  const [pending, setPending] = useState<Parameters<typeof learningApi.askNode>[1] | null>(null);
  useLearningUnsaved(Boolean(draft.trim() || pending));
  const mounted = useRef(true), sequence = useRef(0), writing = useRef(false);
  const reload = useCallback(async () => {
    const seq = ++sequence.current;
    try { const v = await learningApi.conversations(pageId, chapter.id, node.id); if (mounted.current && seq === sequence.current) { setConversations(v.conversations); setLoaded(true); } }
    catch (e) { if (mounted.current && seq === sequence.current) { setError(learningErrorMessage(e)); if (e instanceof LearningApiError && [401,404,410].includes(e.status)) { setConversations([]); setLoaded(false); } } }
  }, [pageId, chapter.id, node.id]);
  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; sequence.current++; }; }, [reload, chapter.revision, materials]);
  const current = conversations.filter(c => c.state === "current").at(-1);
  const active = conversations.some(c => c.turns.some(t => t.status === "generating"));
  useEffect(() => { if (!active && !pending && !busy) return; let polling = false; const timer = setInterval(() => { if (polling) return; polling = true; void reload().finally(() => { polling = false; }); }, 1500); return () => clearInterval(timer); }, [active, pending, busy, reload]);
  useEffect(() => { if (pending && conversations.some(c => c.turns.some(t => t.id === pending.id))) setPending(null); }, [conversations, pending]);
  const canSend = loaded && !busy && !active && (!!newId || !!current || !conversations.length);
  const send = async (action: "ask" | "rephrase" | "example") => {
    if (writing.current || (!canSend && !pending)) return; writing.current = true; setBusy(true); setError("");
    const value = pending ?? { id: crypto.randomUUID(), conversationId: newId ?? current?.id ?? crypto.randomUUID(), chapterId: chapter.id, nodeId: node.id,
      action, question: action === "ask" ? draft.trim() : action === "rephrase" ? "请换个说法解释这个知识点，保留条件和反例。" : "请给这个知识点举一个帮助理解的例子，说明假设和适用范围。" };
    setPending(value);
    try { await learningApi.askNode(pageId, value); if (mounted.current) { setPending(null); setNewId(null); setDraft(""); } await reload(); }
    catch (e) { if (mounted.current) { setError(learningErrorMessage(e)); if (e instanceof LearningApiError && e.status < 500) setPending(null); } }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  };
  const save = async (turnId: string, section: number) => {
    if (writing.current || noteLocked) return; writing.current = true; setBusy(true); setError("");
    try { await learningApi.saveAnswerNote(pageId, { turnId, section, chapterId: chapter.id, nodeId: node.id, revision: chapter.revision }); await onSaved(); await reload(); }
    catch (e) { if (mounted.current) setError(learningErrorMessage(e)); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  };
  const source = async (id: string, index: number) => {
    try { const r = await learningApi.studySource(pageId, "answer", id, 0, index); if (mounted.current) { onClose?.(); onSource(r.source.materialId, r.source.paragraph.parsed?.physicalPage ?? r.source.paragraph.number, r.source.paragraph.parsed); } }
    catch (e) { if (mounted.current) setError(learningErrorMessage(e)); }
  };
  const content = <section aria-label="知识点对话" className={styles.conversation}>
    <h4>围绕「{node.title}」追问</h4><p className={styles.muted}>对话独立保存，不改框架；只有手动存为笔记才写入个人笔记。历史回答不是新的材料依据。</p>
    {error ? <p role="alert">{error}</p> : null}
    {!loaded ? <p>正在读取对话…</p> : null}
    {conversations.map((c,i) => <div key={c.id}><h5>对话 {i+1} · {c.title}</h5>
      {c.state !== "current" ? <p role="status">这段对话绑定的知识点或来源已变化，历史保留，不能直接续聊。{c.state === "material_deleted" ? "来源已删除。" : ""}</p> : null}
      {c.turns.map(t => <article key={t.id} className={styles.frameworkNode}>
        <strong>你</strong><p className={styles.original}>{t.question}</p>
        {t.status === "generating" ? <p role="status">正在回答，问题已保存。</p> : t.status === "failed" ? <p>{learningErrorMessage(new LearningApiError(409,t.failure ?? "framework_provider_failed"))}</p> : null}
        {t.answer?.materialAnswer ? <><strong>材料内容 · AI 解释</strong><p className={styles.original}>{t.answer.materialAnswer}</p>
          <button type="button" disabled={busy || noteLocked || t.savedSections.includes(-1)} onClick={() => void save(t.id,-1)}>{t.savedSections.includes(-1) ? "已存为笔记" : "将材料解释存为笔记"}</button></> : null}
        {t.answer?.supplements.map((s,j) => <aside key={j} className={styles.frameworkSupplement}><strong>{s.kind === "example" ? "教学例子" : "补充解释"} · 材料外</strong><p className={styles.original}>{s.text}</p>
          <button type="button" disabled={busy || noteLocked || t.savedSections.includes(j)} onClick={() => void save(t.id,j)}>{t.savedSections.includes(j) ? "已存为笔记" : "将这条补充存为笔记"}</button></aside>)}
        {t.answer?.items.length ? <details className={styles.sourceDisclosure}><summary>引用 · {t.answer.items.length}</summary>
          <div className={styles.row}>{t.answer.items.map((r,j) => { const m=materials.find(m=>m.id===r.materialId);return <button key={j} type="button" disabled={!m} onClick={() => void source(t.id,j)}>{m ? `${m.title} · ${r.parsed ? `第 ${r.parsed.physicalPage} 物理页 · 来源区域` : `第 ${r.paragraph} 段`}` : "来源已删除"}</button>; })}</div>
        </details> : null}
        {t.omittedTurns > 0 ? <p className={styles.muted}>这次回答未参考更早的 {t.omittedTurns} 轮对话；完整历史仍保留。</p> : null}
        <details><summary>回答详情</summary><p className={styles.muted}>本次参考最近 {t.contextTurnIds.length} 轮。来源可达不代表内容已核实。</p></details>
      </article>)}
    </div>)}
    {loaded && conversations.length > 0 ? <button type="button" disabled={busy || active || !!pending} onClick={() => { setNewId(crypto.randomUUID()); setError(""); }}>基于当前知识点开始新对话</button> : null}
    {newId ? <p role="status">下一条问题将开始新对话，旧对话保留。</p> : null}
    {noteLocked ? <p role="status">请先保存或取消当前编辑，再将解释存为笔记，避免覆盖未保存内容。</p> : null}
    <div className={styles.row}><button type="button" disabled={!canSend || !!pending} onClick={() => void send("rephrase")}>换个说法</button><button type="button" disabled={!canSend || !!pending} onClick={() => void send("example")}>举例</button></div>
    <form onSubmit={e => { e.preventDefault(); void send("ask"); }}><label>继续追问<textarea aria-label="继续追问" value={draft} disabled={busy || Boolean(pending)} maxLength={4000} rows={3} onChange={e=>setDraft(e.target.value)} /></label>
      <button type="submit" className={styles.primary} disabled={busy || active || (!pending && (!canSend || !draft.trim()))}>{pending ? "核对并继续本次提问" : "发送问题"}</button></form>
  </section>;
  return onClose ? <div className={styles.sourceDrawer}><ProductDialog open={Boolean(open)} title="没看懂 / 继续追问" onClose={onClose}>{content}</ProductDialog></div> : content;
}
