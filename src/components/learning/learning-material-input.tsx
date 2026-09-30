"use client";

import { type ReactNode, useCallback, useRef, useState } from "react";
import { LEARNING_AUDIO_MAX_BYTES, LEARNING_AUDIO_BATCH_MAX_BYTES, LEARNING_BATCH_MAX_BYTES, LEARNING_BATCH_MAX_FILES, LEARNING_TEXT_MAX_BYTES, LEARNING_PDF_MAX_BYTES, LEARNING_PDF_BATCH_MAX_BYTES, LEARNING_PDF_BATCH_MAX_FILES, type LearningPage } from "@/lib/domain/learning";
import { LearningApiError, learningApi, learningErrorMessage } from "@/lib/client/learning-api";
import { ProductDialog } from "@/components/product-system/product-primitives";
import styles from "./learning.module.css";
import { useLearningUnsaved } from "./use-learning-unsaved";

type Draft = { id: string; title: string; kind: "text" | "txt" | "pdf" | "audio"; file: File };
function checkBatch(items: Array<Pick<Draft, "kind" | "file">>) {
  const pdfs = items.filter((item) => item.kind === "pdf");
  const texts = items.filter((item) => item.kind === "text" || item.kind === "txt");
  const audios = items.filter((item) => item.kind === "audio");
  if (audios.length > 2 || audios.reduce((sum, item) => sum + item.file.size, 0) > LEARNING_AUDIO_BATCH_MAX_BYTES) throw new Error("每批最多 2 份录音、共 128 MiB，可分批追加。");
  if (pdfs.length > LEARNING_PDF_BATCH_MAX_FILES) throw new Error("每批最多 5 份 PDF，可继续分批追加。");
  if (texts.length > LEARNING_BATCH_MAX_FILES) throw new Error("每批最多 16 份文本，可继续分批追加。");
  if (pdfs.reduce((sum, item) => sum + item.file.size, 0) > LEARNING_PDF_BATCH_MAX_BYTES) throw new Error("本批 PDF 超过 50 MiB，请分批保存。");
  if (texts.reduce((sum, item) => sum + item.file.size, 0) > LEARNING_BATCH_MAX_BYTES) throw new Error("本批文本超过 4 MiB，请分批保存。");
}
export function LearningMaterialInput({ pageId, disabled, onSaved, onBusy, onPreparation, hidden = false, dialogOpen, onDialogChange, progress, advanced }: {
  pageId: string; disabled: boolean; onSaved: (page: LearningPage) => void; onBusy: (busy: boolean) => void; onPreparation?: () => void;
  hidden?: boolean; dialogOpen?: boolean; onDialogChange?: (open: boolean) => void; progress?: ReactNode; advanced?: ReactNode;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [locked, setLocked] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [intent, setIntent] = useState<"organize" | "prepare" | "save">("organize");
  const [localOpen, setLocalOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const changeOpen = useCallback((open: boolean) => { setLocalOpen(open); onDialogChange?.(open); }, [onDialogChange]);
  const close = useCallback(() => changeOpen(false), [changeOpen]);
  const inFlight = useRef(false);
  useLearningUnsaved(Boolean(title.trim() || text.trim() || drafts.length));
  const blocked = disabled || locked || reading;
  const add = (items: Draft[]) => {
    checkBatch([...drafts, ...items]);
    setDrafts((current) => [...current, ...items]); setNotice(""); changeOpen(true);
  };
  return <>
    <section hidden={hidden} className={styles.materialWelcome} aria-labelledby="add-material-title">
    <div className={styles.materialWelcomeHeading}>
      <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M16 27V8m0 0C11 4 6 5 3 6v19c4-1 8-1 13 2 5-3 9-3 13-2V6c-3-1-8-2-13 2Z" /></svg>
      <div><h2 id="add-material-title">让材料，连成知识</h2><p>把课件、录音和笔记放在一起，整理成可以慢慢读的学习框架。</p></div>
    </div>
    <div className={styles.materialWelcomeActions}>
      <button type="button" className={styles.primary} disabled={blocked} onClick={() => fileInput.current?.click()}>选择文件</button>
      <span>PDF、TXT 和已有录音 · 可一次添加多份</span>
      <input ref={fileInput} className={styles.fileInput} aria-label="添加文件" tabIndex={-1} type="file" accept=".txt,.pdf,.mp3,.m4a,.mp4,.wav,.webm,.ogg,.opus,.flac,.aac,.mpga" multiple disabled={blocked} onChange={async event => {
        const files = Array.from(event.target.files ?? []); event.target.value = "";
        if (!files.length || inFlight.current) return;
        changeOpen(true);
        inFlight.current = true; setReading(true); onBusy(true); setError("");
        try {
          const imported: Draft[] = [];
          for (const file of files) {
            const kind = /\.pdf$/iu.test(file.name) ? "pdf" : /\.txt$/iu.test(file.name) ? "txt" : /\.(mp3|m4a|mp4|wav|webm|ogg|opus|flac|aac|mpga)$/iu.test(file.name) ? "audio" : null;
            if (!kind) throw new Error("请选择 PDF、UTF-8 TXT 或已有录音文件。");
            const limit = kind === "pdf" ? LEARNING_PDF_MAX_BYTES : kind === "audio" ? LEARNING_AUDIO_MAX_BYTES : LEARNING_TEXT_MAX_BYTES;
            if (file.size > limit) throw new Error(`${file.name} 超过单份文件大小限制，请拆分后添加。`);
            if (kind === "txt") {
              let content: string;
              try { content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
              catch { throw new Error("TXT 不是有效的 UTF-8 文本，请转换编码后添加。"); }
              if (!content.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content)) throw new Error("文本为空或包含非文本内容。");
            }
            imported.push({ id: crypto.randomUUID(), kind, file, title: file.name.replace(/\.(pdf|txt)$/iu, "").slice(0, 160) || "学习材料" });
          }
          add(imported);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "无法添加文件。"); changeOpen(true); }
        finally { inFlight.current = false; setReading(false); onBusy(false); }
      }} />
    </div>
    <details className={styles.inputText}><summary>粘贴文本或笔记</summary>
      <div className={styles.stack}>
        <label>文本标题<input maxLength={160} value={title} disabled={blocked} onChange={event => setTitle(event.target.value)} /></label>
        <label>粘贴文本<textarea rows={6} value={text} disabled={blocked} onChange={event => setText(event.target.value)} placeholder="课堂笔记、阅读摘录或学习材料…" /></label>
        <button type="button" disabled={blocked || !title.trim() || !text.trim()} onClick={() => {
          setError("");
          try {
            const file = new File([text], "pasted-text.txt", { type: "text/plain;charset=utf-8" });
            if (file.size > LEARNING_TEXT_MAX_BYTES) throw new Error("单份文本超过 1 MiB，请按自然章节拆分。");
            if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error("材料包含非文本内容，请检查后再添加。");
            add([{ id: crypto.randomUUID(), title: title.trim(), kind: "text", file }]); setTitle(""); setText("");
          } catch (reason) { setError(reason instanceof Error ? reason.message : "无法添加文本。"); changeOpen(true); }
        }}>加入本次材料</button>
      </div>
    </details>
    {drafts.length ? <button type="button" className={styles.draftReturn} onClick={() => changeOpen(true)}>待保存材料 · {drafts.length} 份，继续确认</button> : null}
    <details className={styles.fileLimits}><summary>支持的文件与大小</summary>
      <p className={styles.muted}>PDF 单份不超过 20 MiB、200 页，每批最多 5 份、50 MiB；暂不支持加密文件。文本/TXT 单份 1 MiB，每批最多 16 份、4 MiB。录音单份 64 MiB、最长 2 小时，每批最多 2 份、128 MiB。原音保留至主动删除，暂不支持回听。</p>
      <p className={styles.muted}>课件会按原文件页序分步读取并保存进度；遇到服务限制会明确提示，不会悄悄只读取开头。</p>
    </details>
    </section>
    <div className={styles.materialDialog}>
    <ProductDialog open={dialogOpen ?? localOpen} keepMounted onClose={close} title="材料与进度">
    <p className={styles.dialogHint}>关闭窗口不会取消已开始的处理。可随时从页顶「材料进度」重新打开。</p>
    {drafts.length ? <div className={styles.batch}>
      <h3>等待确认 · {drafts.length} 份材料</h3>
      <ul>{drafts.map((draft) => <li key={draft.id}><span><strong>{draft.title}</strong><small>{draft.kind === "pdf" ? "PDF 课件" : draft.kind === "audio" ? "录音" : "文本笔记"} · 尚未保存</small></span>
        <button disabled={blocked} type="button" aria-label={`移除待保存材料 ${draft.title}`} onClick={() => setDrafts((items) => items.filter((item) => item.id !== draft.id))}>移除</button>
      </li>)}</ul>
      <details><summary>其他整理方式</summary>
        <label>完成后<select aria-label="完成后" value={intent} disabled={blocked} onChange={event => setIntent(event.target.value as typeof intent)}>
          <option value="organize">自动整理知识框架</option>
          <option value="prepare">准备材料，稍后直接做 Quiz</option>
          <option value="save">只保存材料</option>
        </select></label>
      </details>
      <p className={styles.muted}>{intent === "organize" ? "自动读取这批材料并整理框架；识别内容可能有误。有明显缺失时，会先说明影响。" : intent === "prepare" ? "自动读取课件、转写录音，暂不生成框架或题目。" : "只保存原件，之后再开始整理。"}</p>
      <button type="button" className={styles.primary} disabled={disabled || reading} onClick={async () => {
        if (inFlight.current) return;
        inFlight.current = true; onBusy(true); setLocked(true); setError(""); setNotice(`正在保存：0/${drafts.length}`);
        const form = new FormData();
        form.set("intent", intent);
        form.set("materials", JSON.stringify(drafts.map(({ id, title, kind }) => ({ id, title, kind }))));
        for (const draft of drafts) form.append("files", draft.file);
        try {
          const result = await learningApi.save(pageId, form);
          const details = (result.preparation ?? []).map(item => {
            const name = drafts.find(d => d.id === item.materialId)?.title ?? "材料";
            return item.status === "needs_range" ? `${name}：已保存，请在处理详情中选择解析范围。`
              : item.status === "unavailable" ? `${name}：${learningErrorMessage(new LearningApiError(503, item.error ?? "request_failed"))}`
              : item.status === "already_started" ? `${name}：已有处理记录，可查看状态或手动恢复。`
              : `${name}：已开始或等待处理，可在此查看进度。`;
          });
          onSaved(result.page); onPreparation?.(); setNotice([`已保存：${drafts.length}/${drafts.length}`, ...details].join("\n")); setDrafts([]); setLocked(false);
        } catch (reason) {
          setError(learningErrorMessage(reason));
          if (reason instanceof LearningApiError && [400, 413, 422].includes(reason.status)) {
            setLocked(false); setNotice("保存失败，本批未保存。可移除不支持的文件后再次保存。");
          } else setNotice("本批保存尚未确认；重试会沿用本次提交，不会重复创建。");
        }
        finally { inFlight.current = false; onBusy(false); }
      }}>{disabled && !reading ? `正在保存 ${drafts.length} 份…` : locked ? "重试保存材料" : `${intent === "organize" ? "开始整理" : intent === "prepare" ? "准备材料" : "只保存"} · ${drafts.length} 份`}</button>
      <p className={styles.muted}>待保存内容仅在当前页面中，离开或刷新会清空。保存后可长期重新打开。</p>
    </div> : null}
    {reading ? <p role="status">正在准备文件…</p> : null}
    {notice ? <p role="status" style={{ whiteSpace: "pre-line" }}>{notice}</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {progress}
    {!drafts.length && !progress && !notice && !error ? <p className={styles.muted}>当前没有正在进行的整理。可添加新材料，或按需查看已保存材料的处理详情。</p> : null}
    {advanced ? <details className={styles.advancedMaterials}><summary>按材料查看处理详情</summary>{advanced}</details> : null}
    </ProductDialog>
    </div>
  </>;
}
