"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useContext, useEffect, useRef, useState } from "react";
import type { LearningPageSummary } from "@/lib/domain/learning";
import { learningApi, learningErrorMessage } from "@/lib/client/learning-api";
import { ProductDialog, ProductState } from "@/components/product-system/product-primitives";
import { useCallback } from "react";
import styles from "./learning.module.css";
import { useLearningUnsaved } from "./use-learning-unsaved";
import { clearLearningReadingState, LearningReadingAccount, learningReadingKey } from "./learning-reading-state";

export function LearningPages() {
  const router = useRouter();
  const accountId = useContext(LearningReadingAccount);
  const [pages, setPages] = useState<LearningPageSummary[] | null>(null);
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<LearningPageSummary | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useLearningUnsaved(Boolean(title.trim()));
  const submission = useRef<{ id: string; title: string } | null>(null);
  const inFlight = useRef(false);
  const closeDelete = useCallback(() => { if (!inFlight.current) setDeleting(null); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void learningApi.list(controller.signal).then((result) => { if (!controller.signal.aborted) setPages(result.pages); })
      .catch((reason) => { if (!controller.signal.aborted) setError(learningErrorMessage(reason)); });
    return () => controller.abort();
  }, [attempt]);
  return <>
    <header className={styles.pageHeader}>
      <div><h1>我的学习页</h1><p className={styles.muted}>整理课件、录音和笔记，理清知识关系，再用 Quiz 检查理解。</p></div>
      {pages?.length ? <button ref={newButton} className={styles.primary} aria-expanded={creating} onClick={() => { setCreating(true); requestAnimationFrame(() => nameInput.current?.focus()); }}>新建学习页</button> : null}
    </header>
    {(creating || pages?.length === 0) ? <form className={styles.create} noValidate onSubmit={async (event) => {
      event.preventDefault();
      if (inFlight.current) return;
      if (!title.trim()) { setTitleError(true); nameInput.current?.focus(); return; }
      setTitleError(false);
      inFlight.current = true; setBusy(true); setError("");
      try {
        if (!submission.current || submission.current.title !== title.trim()) submission.current = { id: crypto.randomUUID(), title: title.trim() };
        const result = await learningApi.create(submission.current.id, submission.current.title);
        setTitle("");
        router.push(`/learning/${result.page.id}`);
      } catch (reason) { setError(learningErrorMessage(reason)); }
      finally { inFlight.current = false; setBusy(false); }
    }}>
      <div className={styles.createField}>
        <label>学习页名称<input ref={nameInput} required maxLength={160} value={title}
          aria-invalid={titleError || undefined} aria-describedby={titleError ? "learning-page-name-error" : undefined}
          onChange={(event) => { setTitle(event.target.value); if (event.target.value.trim()) setTitleError(false); }}
          placeholder="例如：线性代数 · 第二周" disabled={busy} /></label>
        {titleError ? <p id="learning-page-name-error" role="alert" className={styles.error}>请先给学习页起个名字。</p> : null}
      </div>
      <button className={styles.primary} type="submit" disabled={busy}>{busy ? "正在创建…" : "创建学习页"}</button>
      {pages?.length ? <button type="button" disabled={busy} onClick={() => { setCreating(false); newButton.current?.focus(); }}>取消</button> : null}
    </form> : null}
    {error ? <ProductState tone="error" title={error} action={<button type="button" onClick={() => { setError(""); setAttempt((n) => n + 1); }}>重新载入</button>} /> : null}
    <section className={styles.section} aria-label="已保存的学习页">
      {pages === null ? <ProductState tone="loading" title="正在读取…" /> : pages.length === 0 ?
        <ProductState tone="empty" title="还没有学习页" description="创建后可以添加文本、TXT、PDF 和已有录音。" /> :
        <ul className={styles.pageList}>{pages.map((page) => <li key={page.id}>
          <Link href={`/learning/${page.id}`}><div><strong>{page.title}</strong><p className={styles.muted}>{page.materialCount} 份材料{Number.isFinite(Date.parse(page.updatedAt)) ? ` · 更新于 ${new Date(page.updatedAt).toLocaleDateString("zh-CN")}` : ""}</p></div><span>继续学习 →</span></Link>
          <button type="button" className={styles.listDelete} disabled={busy} aria-label={`删除学习页 ${page.title}`} onClick={() => { setDeleting(page); setError(""); }}>删除</button>
        </li>)}</ul>}
    </section>
    <ProductDialog open={Boolean(deleting)} title={`删除「${deleting?.title ?? ""}」？`} onClose={closeDelete}
      footer={<div className={styles.row}><button type="button" disabled={busy} onClick={closeDelete}>取消</button><button type="button" className={styles.danger} disabled={busy} onClick={async () => {
        if (!deleting || inFlight.current) return;
        inFlight.current = true; setBusy(true); setError("");
        try { await learningApi.deletePage(deleting.id); if (accountId) clearLearningReadingState(learningReadingKey(accountId, deleting.id)); setPages(old => old?.filter(p => p.id !== deleting.id) ?? null); setDeleting(null); newButton.current?.focus(); }
        catch (reason) { setError(learningErrorMessage(reason)); }
        finally { inFlight.current = false; setBusy(false); }
      }}>{busy ? "正在删除…" : "删除学习页"}</button></div>}>
      <p>将永久删除这个学习页的全部材料、框架、笔记、对话和练习记录，无法恢复。</p>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </ProductDialog>
  </>;
}
