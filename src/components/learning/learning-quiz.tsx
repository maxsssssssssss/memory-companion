"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import type { LearningMaterial } from "@/lib/domain/learning";
import { QUIZ_MAX_QUESTIONS, type QuizConfig, type QuizAttemptView, type QuizRunSummary, type QuizActionInput } from "@/lib/domain/learning-quiz";
import { learningApi, learningErrorMessage, LearningApiError, LEARNING_INVALIDATION_CHANNEL } from "@/lib/client/learning-api";
import { ProductDialog } from "@/components/product-system/product-primitives";
import styles from "./learning.module.css";
import resultStyles from "./quiz-results.module.css";
import { useLearningUnsaved } from "./use-learning-unsaved";

export function LearningQuiz({ pageId, materials, selected, disabled, saveSelection, onSource }: {
  pageId: string; materials: LearningMaterial[]; selected: string[]; disabled: boolean;
  saveSelection: () => Promise<void>; onSource: (id: string, paragraph: number, parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding) => void;
}) {
  const open = true;
  const [stage, setStage] = useState<"prepare" | "history" | "ready" | "answer" | "results">("prepare");
  const [chosen, setChosen] = useState<QuizRunSummary | null>(null);
  const [pollStopped, setPollStopped] = useState(false);
  const restored = useRef(false);
  const [runs, setRuns] = useState<QuizRunSummary[]>([]), [chapters, setChapters] = useState<FrameworkChapter[]>([]);
  const [scope, setScope] = useState("materials"), [chapterIds, setChapterIds] = useState<string[]>([]), [nodeIds, setNodeIds] = useState<string[]>([]);
  const [count, setCount] = useState(5), [difficulty, setDifficulty] = useState<QuizConfig["difficulty"]>("standard"), [notes, setNotes] = useState(false), [supplements, setSupplements] = useState(false);
  const [mode, setMode] = useState<"practice" | "test">("practice"), [attempt, setAttempt] = useState<QuizAttemptView | null>(null), [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [sourceText, setSourceText] = useState("");
  const [deleting, setDeleting] = useState<QuizRunSummary | null>(null), [deleteError, setDeleteError] = useState("");
  const mounted = useRef(true), locked = useRef(false), seq = useRef(0), currentId = useRef<string | null>(null);
  const currentPage = useRef(pageId); currentPage.current = pageId;
  const pendingGeneration = useRef<{ id: string; settings: QuizConfig } | null>(null), pendingAction = useRef<QuizActionInput | null>(null);
  const pendingStart = useRef<{ id: string; quizId: string; mode: "practice" | "test" } | null>(null);
  const key = `learning-quiz-pending:${pageId}`;
  useLearningUnsaved(Boolean(pendingAction.current));
  const rememberPosition = (id: string, question: number) => { const url = new URL(window.location.href); url.searchParams.set("view", "quiz"); url.searchParams.set("attempt", id); url.searchParams.set("question", String(question)); window.history.replaceState(window.history.state, "", url); };
  const load = useCallback(async () => {
    const n = ++seq.current;
    const attemptId = currentId.current;
    try {
      const [r, f, a] = await Promise.all([learningApi.quizzes(pageId), learningApi.framework(pageId), attemptId ? learningApi.quizAttempt(pageId, attemptId).catch(e => {
        if (e instanceof LearningApiError && ((e.status === 404 && e.code === "quiz_not_found") || (e.status === 410 && e.code === "quiz_deleted"))) return { attempt: null };
        throw e;
      }) : null]);
      if (!mounted.current || n !== seq.current) return;
      setRuns(r.quizzes); setChapters(f.framework.chapters); if (a?.attempt) {
        setAttempt(a.attempt);
        if (!restored.current) {
          const position = Number(new URLSearchParams(window.location.search).get("question"));
          setIndex(Number.isInteger(position) && position >= 0 && position < a.attempt.questions.length ? position : 0);
          setStage(a.attempt.completed ? "results" : "answer"); restored.current = true;
        }
      } else if (attemptId) {
        currentId.current = null; restored.current = true; setAttempt(null); setSourceText(""); setStage("history");
        if (pendingAction.current?.attemptId === attemptId) { pendingAction.current = null; sessionStorage.removeItem(key + ":action"); }
        const url = new URL(window.location.href);
        if (url.searchParams.get("attempt") === attemptId) { url.searchParams.delete("attempt"); url.searchParams.delete("question"); window.history.replaceState(window.history.state, "", url); }
        setNotice("这份题组或作答记录已不可用，可以继续使用其他题组。");
      }
      const completed=pendingGeneration.current && r.quizzes.find(q=>q.id===pendingGeneration.current!.id&&q.status!=="generating");
      if(completed){if(completed.status==="completed"){setChosen(completed);setStage(s=>s==="prepare"?"ready":s);}pendingGeneration.current=null;sessionStorage.removeItem(key);}
    } catch (e) { if (mounted.current && n === seq.current) { setError(learningErrorMessage(e)); if (e instanceof LearningApiError && [401,404,410].includes(e.status)) { setRuns([]); setAttempt(null); setSourceText(""); } } }
  }, [pageId, key]);
  useEffect(() => {
    mounted.current = true;
    const query = new URLSearchParams(window.location.search); currentId.current = query.get("attempt");
    try { const saved = sessionStorage.getItem(key + ":action"); if (saved) pendingAction.current = JSON.parse(saved); } catch { /* Optional receipt only. */ }
    try { const saved = sessionStorage.getItem(key); if (saved) {
      const p = JSON.parse(saved) as { id: string; settings: QuizConfig }; pendingGeneration.current = p;
      setScope(p.settings.chapterIds.length ? "chapters" : p.settings.nodeIds.length ? "nodes" : "materials");
      setChapterIds(p.settings.chapterIds); setNodeIds(p.settings.nodeIds); setCount(p.settings.count); setDifficulty(p.settings.difficulty); setNotes(p.settings.includeNotes); setSupplements(p.settings.includeSupplements);
    } } catch { /* No original content in this optional recovery receipt. */ }
    return () => { mounted.current = false; seq.current++; };
  }, [key]);
  useEffect(() => {
    if (!open) return; void load();
    const focus = () => { if (!locked.current) void load(); };
    window.addEventListener("focus", focus);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(LEARNING_INVALIDATION_CHANNEL);
    if (channel) channel.onmessage = e => { if (e.data?.pageId === pageId) { setSourceText(""); focus(); } };
    return () => { window.removeEventListener("focus", focus); channel?.close(); };
  }, [open, load, pageId, materials]);
  const active = runs.some(r => r.status === "generating");
  useEffect(() => { if (!active) return; setPollStopped(false); const timer = setInterval(() => { if (!document.hidden && !locked.current) void load(); }, 1500); return () => clearInterval(timer); }, [active, load]);
  async function work(fn: () => Promise<void>) {
    if (locked.current) return; locked.current = true; seq.current++; setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { if (mounted.current) setError(learningErrorMessage(e)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  const generate = () => work(async () => {
    if (pendingAction.current || pendingStart.current) throw new LearningApiError(409, "submission_conflict");
    const pending = pendingGeneration.current ?? { id: crypto.randomUUID(), settings: { materialIds: scope === "materials" ? selected : [], chapterIds: scope === "chapters" ? chapterIds : [], nodeIds: scope === "nodes" ? nodeIds : [], includeNotes: notes, includeSupplements: supplements, count, difficulty } };
    if (!pendingGeneration.current && scope === "materials") await saveSelection();
    pendingGeneration.current = pending; sessionStorage.setItem(key, JSON.stringify(pending));
    try { const r = await learningApi.generateQuiz(pageId, pending.id, pending.settings); if (mounted.current) { setRuns(r.quizzes); const created = r.quizzes.find(q => q.id === pending.id && q.status === "completed"); if (created) { setChosen(created); setStage("ready"); } } if(!r.quizzes.some(q=>q.id===pending.id&&q.status==="generating")){pendingGeneration.current = null; sessionStorage.removeItem(key);} }
    catch (e) { if (e instanceof LearningApiError && (e.status < 500 || e.code === "learning_generation_not_configured")) { pendingGeneration.current = null; sessionStorage.removeItem(key); } throw e; }
  });
  const resumeGeneration=(run:QuizRunSummary)=>work(async()=>{
    pendingGeneration.current={id:run.id,settings:run.settings};sessionStorage.setItem(key,JSON.stringify(pendingGeneration.current));
    const result=await learningApi.generateQuiz(pageId,run.id,run.settings,true);
    if(mounted.current)setRuns(result.quizzes);
  });
  const start = (quiz: QuizRunSummary) => work(async () => {
    if (pendingAction.current) throw new LearningApiError(409, "submission_conflict");
    let a: QuizAttemptView;
    if (quiz.attemptId) a = (await learningApi.quizAttempt(pageId, quiz.attemptId)).attempt;
    else {
      const p = pendingStart.current ?? { id: crypto.randomUUID(), quizId: quiz.id, mode }; pendingStart.current = p;
      try { a = (await learningApi.startQuiz(pageId, p.id, p.quizId, p.mode)).attempt; pendingStart.current = null; }
      catch (e) { if (e instanceof LearningApiError && e.status < 500) pendingStart.current = null; throw e; }
    }
    if (!mounted.current) return;
    const next = Math.max(0, a.questions.findIndex(q => !q.progress.submitted && !q.progress.skipped && !q.progress.revealed && (a.mode === "practice" || !q.progress.optionId)));
    currentId.current = a.id; restored.current = true; setAttempt(a); setIndex(next); rememberPosition(a.id, next); setStage(a.completed ? "results" : "answer"); setSourceText(""); await load();
  });
  const act = (action: QuizActionInput["action"], optionId: string | null = null) => work(async () => {
    if (!attempt) return;
    const p = pendingAction.current ?? { id: crypto.randomUUID(), attemptId: attempt.id, revision: attempt.revision, action, question: index, optionId }; pendingAction.current = p; sessionStorage.setItem(key + ":action", JSON.stringify(p));
    try { const r = await learningApi.quizAction(pageId, p); pendingAction.current = null; sessionStorage.removeItem(key + ":action"); if (mounted.current) { setAttempt(r.attempt); setNotice("已保存"); setSourceText(""); if (r.attempt.completed && (r.attempt.mode === "test" || p.action === "finish")) setStage("results"); if (r.attempt.completed) await load(); } }
    catch (e) { if (e instanceof LearningApiError && e.status < 500) { pendingAction.current = null; sessionStorage.removeItem(key + ":action"); await load(); } throw e; }
  });
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
  const q = attempt?.questions[index], done = q && (q.progress.submitted || q.progress.skipped || q.progress.revealed);
  const navigateQuestion = (next: number) => {
    if (busy || pendingAction.current || !attempt) return;
    setIndex(next); setSourceText(""); rememberPosition(attempt.id, next);
  };
  const history = () => {
    if (busy || pendingAction.current) return;
    // Explicit navigation wins over an in-flight restoration of the old URL.
    // load() below fences the earlier read; saved attempts remain in history.
    currentId.current = null; restored.current = true;
    setStage("history"); setSourceText("");
    const url = new URL(window.location.href); url.searchParams.delete("attempt"); url.searchParams.delete("question"); window.history.replaceState(window.history.state, "", url);
    void load();
  };
  const closeDelete = useCallback(() => { if (!locked.current) { setDeleting(null); setDeleteError(""); } }, []);
  const deleteQuiz = () => work(async () => {
    if (!deleting) return;
    setDeleteError("");
    try {
      const result = await learningApi.deleteQuiz(pageId, deleting.id);
      if (!mounted.current || currentPage.current !== pageId) return;
      // Fence reads begun while deletion was in flight. An old list or attempt
      // must not put this group back after the server has removed it.
      seq.current++;
      if (pendingGeneration.current?.id === deleting.id) { pendingGeneration.current = null; sessionStorage.removeItem(key); }
      if (pendingStart.current?.quizId === deleting.id) pendingStart.current = null;
      const deletedAttempt = attempt?.quizId === deleting.id ? attempt.id : deleting.attemptId;
      if (deletedAttempt && pendingAction.current?.attemptId === deletedAttempt) { pendingAction.current = null; sessionStorage.removeItem(key + ":action"); }
      if (currentId.current === deletedAttempt) currentId.current = null;
      restored.current = true;
      const url = new URL(window.location.href);
      if (deletedAttempt && url.searchParams.get("attempt") === deletedAttempt) {
        url.searchParams.delete("attempt"); url.searchParams.delete("question"); window.history.replaceState(window.history.state, "", url);
      }
      setRuns(result.quizzes); setChosen(previous => previous?.id === deleting.id ? null : previous);
      setAttempt(previous => previous?.quizId === deleting.id ? null : previous);
      setSourceText(""); setStage("history"); setDeleting(null); setNotice("题组及其作答记录已删除。");
    } catch (e) { if (mounted.current && currentPage.current === pageId) setDeleteError(learningErrorMessage(e)); }
  });
  const finish = () => {
    if (!attempt) return;
    const unanswered = attempt.questions.filter(q => !q.progress.optionId && !q.progress.skipped && !q.progress.revealed).length;
    if (!unanswered || window.confirm("还有 " + unanswered + " 题未选择，交卷后记为跳过。确定交卷？")) void act("finish");
  };
  const questionCount = (r: QuizRunSummary) => r.count < r.settings.count ? r.count + "/" + r.settings.count + " 题" : "共 " + r.count + " 题";
  // Mirror the existing selection semantics for display only. Publication still
  // resolves the actual sources on the server; this never adds missing context.
  const scopedNodes = chapters.flatMap(c => c.nodes.filter(n => scope === "chapters" ? chapterIds.includes(c.id) : scope === "nodes" && nodeIds.includes(n.id)));
  const scopeSources = scopedNodes.flatMap(n => n.sources);
  const scopedMaterials = materials.filter(m => scope === "materials" ? selected.includes(m.id) : scopeSources.some(s => s.materialId === m.id));
  const extraNodes = chapters.flatMap(c => c.nodes).filter(n => scopedNodes.includes(n) || (scope === "materials" && n.sources.some(s => selected.includes(s.materialId))));
  const feedback = (question: NonNullable<typeof q>, questionIndex: number, review = false) => question.feedback && attempt ? <div className={review ? resultStyles.analysis : styles.feedback} data-correct={question.feedback.correct}>
    <h4>{review ? "解析" : <>{question.feedback.correct ? "答对了" : question.progress.skipped ? "已跳过" : question.progress.revealed ? "已看答案" : "本题未答对"} · 正确选项 {question.options.find(o => o.id === question.feedback!.correctOptionId)?.label ?? question.feedback.correctOptionId}</>}</h4>
    <p className={styles.original}>{question.feedback.explanation}</p>
    <details className={review ? resultStyles.supporting : undefined}><summary>各选项说明</summary>{question.feedback.reasons.map(r => {
      const option = question.options.find(o => o.id === r.id);
      return review ? <div key={r.id} className={resultStyles.optionReason}><strong>{option?.label ?? r.id}. {option?.text}</strong><p>{r.reason}</p></div> : <p key={r.id}>{option?.label ?? r.id}：{r.reason}</p>;
    })}</details>
    {question.feedback.sources.length > 0 ? <details className={review ? resultStyles.supporting : undefined} key={attempt.id + ":" + questionIndex} aria-label="解析引用"><summary>引用 · {question.feedback.sources.length}</summary><div className={styles.sources}>{question.feedback.sources.map((source, i) => <button key={i} disabled={busy || source.state !== "available"} onClick={() => void work(async () => {
      const result = await learningApi.quizSource(pageId, attempt.id, questionIndex, i); if (!mounted.current) return;
      if (result.source.kind === "material" && result.source.materialId && result.source.paragraph) onSource(result.source.materialId, result.source.paragraph.parsed?.physicalPage ?? result.source.paragraph.number, result.source.paragraph.parsed);
      else setSourceText(result.source.text ?? "");
    })}>{source.state === "material_deleted" ? "来源已删除" : source.state !== "available" ? "来源已变化" : source.kind === "material" ? source.parsed ? "PDF · 第 " + source.parsed.physicalPage + " 物理页 · 来源区域" : "原材料 · 第 " + source.paragraph + " 段" : source.kind === "note" ? "个人笔记依据" : "补充解释依据"}</button>)}</div></details> : null}
  </div> : null;
  return <section className={styles.section} aria-label="单选 Quiz">
    <div className={styles.sectionHeader}><h2>{stage === "results" ? "本次结果" : stage === "answer" ? attempt?.mode === "practice" ? "练习" : "测验" : stage === "history" ? "题组与历史" : "Quiz"}</h2>
      <div className={styles.row}>{stage !== "history" ? <button type="button" disabled={busy || Boolean(pendingAction.current)} onClick={history}>题组与历史</button> : <button type="button" onClick={() => setStage("prepare")}>生成另一组</button>}</div></div>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {stage !== "answer" && (busy || notice) ? <p role="status">{busy ? "正在保存或处理，请稍候…" : notice}</p> : null}
    {!busy && pendingAction.current ? <><p role="alert">这次作答的保存结果尚未确认，请重试后再切题或返回。</p><button onClick={() => void act(pendingAction.current!.action)}>核对并重试同一作答操作</button></> : null}
    {stage === "prepare" ? <>
      <p className={styles.muted}>根据所选材料检查理解，也可以独立出题，无需先生成框架。</p>
      <fieldset disabled={busy || disabled || active || Boolean(pendingGeneration.current)} className={styles.quizSettings}><legend>设置练习</legend>
        <label>出题范围<select value={scope} onChange={e => setScope(e.target.value)}><option value="materials">当前勾选材料（{selected.length} 份）</option><option value="chapters">选择章节</option><option value="nodes">选择知识点</option></select></label>
        {scope !== "materials" ? <div>{chapters.length ? chapters.map(c => <div key={c.id}>
          {scope === "chapters" ? <label className={styles.materialCheck}><input type="checkbox" checked={chapterIds.includes(c.id)} onChange={() => setChapterIds(toggle(chapterIds, c.id))} />{c.title}</label>
            : <><strong>{c.title}</strong>{c.nodes.map(n => <label className={styles.materialCheck} key={n.id}><input type="checkbox" checked={nodeIds.includes(n.id)} onChange={() => setNodeIds(toggle(nodeIds, n.id))} />{n.title}</label>)}</>}
        </div>) : <p>尚无章节，可选择已保存材料直接出题。</p>}</div> : null}
        <div className={styles.row}><label>题量<input type="number" min={1} max={QUIZ_MAX_QUESTIONS} value={count} onChange={e => setCount(Number(e.target.value))} /></label>
          <label>难度<select value={difficulty} onChange={e => setDifficulty(e.target.value as QuizConfig["difficulty"])}><option value="basic">基础</option><option value="standard">标准</option><option value="challenging">进阶</option></select></label></div>
        <p className={styles.muted}>每组 1–50 题。材料不足时会说明实际题量与原因。</p>
        <label className={styles.materialCheck}><input type="checkbox" checked={notes} onChange={e => setNotes(e.target.checked)} />纳入所选范围的个人笔记</label>
        <label className={styles.materialCheck}><input type="checkbox" checked={supplements} onChange={e => setSupplements(e.target.checked)} />纳入所选知识点已保存的补充解释</label>
        <p className={styles.muted}>编辑过的框架正文、总览与聊天记录不会自动作为依据。对话解释需先明确存为笔记，再勾选纳入个人笔记。</p>
        <details aria-label="本次范围预览"><summary>本次范围预览 · {scopedMaterials.length} 份材料</summary>
          <ul>{scopedMaterials.map(m => {
            const refs = scopeSources.filter(s => s.materialId === m.id);
            const pages = scope === "materials" ? m.pdfStudy?.physicalPages : [...new Set(refs.flatMap(s => s.parsed ? [s.parsed.physicalPage] : []))].sort((a,b) => a-b);
            return <li key={m.id}>{m.title}：{scope === "materials" ? m.kind === "pdf" ? "所选解析范围" : m.kind === "audio" ? "已保存转写全文" : "已保存正文全文" : `仅引用段落 ${[...new Set(refs.map(s => s.paragraph))].sort((a,b) => a-b).join("、")}`}
              {m.kind === "pdf" ? m.pdfStudy ? <>；物理页 {pages?.join("、")}。材料已排除 {m.pdfStudy.excludedBlockIds.length} 个区域，内容未核实；其他页和区域不自动补入。</> : "；尚未选择可用解析范围，不能出题。" : null}
              {m.kind === "audio" ? <>；ASR 可能有歧义。{m.audio?.transcription !== "completed" ? "转写尚未完成，不能出题。" : null}</> : null}
            </li>;
          })}</ul>
          <p>未包含材料：{materials.filter(m => !scopedMaterials.includes(m)).map(m => m.title).join("、") || "无"}。</p>
          {scope !== "materials" ? <p>只使用所选章节或知识点绑定的原文段落，不读取框架正文，也不会补入其余段落。请确认所需前提、例外和相关案例已包含。</p> : null}
          {scopeSources.some(s => !materials.some(m => m.id === s.materialId)) ? <p role="alert">部分来源材料已删除，不能基于该范围继续生成。</p> : null}
          <p>个人笔记：{notes ? `${extraNodes.filter(n => n.note).length} 条，明确纳入` : "未纳入"}；补充解释：{supplements ? `${extraNodes.filter(n => n.supplement).length} 条，明确纳入` : "未纳入"}。来源受限或发生变化时会提示，不会自动忽略。</p>
        </details>
        <button type="button" className={styles.primary} onClick={() => void generate()} disabled={!Number.isInteger(count) || count < 1 || count > 50 || (scope === "materials" ? !selected.length : scope === "chapters" ? !chapterIds.length : !nodeIds.length)}>生成 Quiz</button>
      </fieldset>

      {pendingGeneration.current ? <button disabled={busy || active} onClick={() => void generate()}>核对并继续本次生成</button> : null}
      {active ? <p role="status">正在阅读资料与准备题目，完成后统一展示。{runs.find(r=>r.status==="generating")?.progress ? `已完成 ${runs.find(r=>r.status==="generating")!.progress!.completed}/${runs.find(r=>r.status==="generating")!.progress!.total} 部分。` : ""}旧练习仍可查看。</p> : null}
      {pollStopped ? <p role="status">已暂停自动查询。<button onClick={() => void load()}>查看生成进度</button></p> : null}
      {runs.some(r => r.status === "completed") ? <button type="button" onClick={history}>使用已有题组</button> : null}
      {!active && runs.slice(0,1).filter(r => r.status === "failed" || r.status === "insufficient").map(r => <p role="alert" key={r.id}>{r.status === "failed" ? learningErrorMessage(new LearningApiError(422, r.failure ?? "quiz_invalid_result")) : r.reason ?? "材料不足，请调整范围再生成。"}</p>)}
      {!active && runs.slice(0,1).filter(r=>r.status==="failed"&&r.progress?.canResume).map(r=><button key={r.id} disabled={busy} onClick={()=>void resumeGeneration(r)}>继续未完成部分</button>)}
    </> : null}
    {stage === "history" ? <>
      {!runs.length ? <p>还没有题组，选择材料后可以开始生成。</p> : <ul className={styles.quizHistory}>{runs.map(r => <li key={r.id}>
        <div><h3>{r.title ?? "本次题组"}</h3><p className={styles.muted}>{r.createdAt.slice(0,16).replace("T", " ")} · {r.status === "generating" ? "生成中" : questionCount(r)}</p>
        {r.reason ? <p>{r.reason}</p> : null}{r.status === "failed" ? <p className={styles.error}>{learningErrorMessage(new LearningApiError(422, r.failure ?? "quiz_invalid_result"))}</p> : null}
        {r.status === "insufficient" ? <p>依据不足，未生成可作答题组。</p> : null}</div>
        <div className={styles.row}>{r.status === "completed" ? <button type="button" disabled={busy} onClick={() => { if (r.attemptId) void start(r); else { setChosen(r); setStage("ready"); } }}>{r.attemptId ? "续做 / 查看记录" : "使用这组题"}</button> : null}
        {r.status==="failed"&&r.progress?.canResume ? <button type="button" disabled={busy||active} onClick={()=>void resumeGeneration(r)}>继续未完成部分</button>:null}
        <button type="button" className={styles.danger} disabled={busy || disabled} aria-label={`删除题组 ${r.title ?? "本次题组"}`} onClick={() => { setDeleting(r); setDeleteError(""); }}>删除</button></div>
      </li>)}</ul>}
    </> : null}
    {stage === "ready" && chosen ? <div className={styles.quizReady}>
      <h3>{chosen.title}</h3><p>{questionCount(chosen)}</p>{chosen.reason ? <p>{chosen.reason}</p> : null}
      <fieldset disabled={busy || Boolean(pendingStart.current)}><legend>选择作答方式</legend>
        <label className={styles.quizOption}><input type="radio" name="quiz-mode" checked={mode === "practice"} onChange={() => setMode("practice")} /><span><strong>练习</strong><small>确认一题后查看反馈，再继续下一题。</small></span></label>
        <label className={styles.quizOption}><input type="radio" name="quiz-mode" checked={mode === "test"} onChange={() => setMode("test")} /><span><strong>测验</strong><small>先保存选择，交卷后查看全部答案与解析。</small></span></label>
      </fieldset>
      <p className={styles.muted}>作答会保存，可以退出后续做。开始后保持所选模式。</p>
      <button type="button" className={styles.primary} disabled={busy} onClick={() => void start(chosen)}>{pendingStart.current ? "核对并继续开始" : "开始作答"}</button>
    </div> : null}
    {stage === "answer" && attempt && q ? <article className={styles.quizAttempt} aria-label="当前作答">
      <h3>{attempt.title}</h3><p>第 {index + 1}/{attempt.questions.length} 题 · 已{attempt.mode === "practice" ? "确认" : "选择"} {attempt.questions.filter(q => q.progress.submitted || q.progress.skipped || q.progress.revealed || (attempt.mode === "test" && q.progress.optionId)).length} 题</p>
      <progress aria-label="作答进度" max={attempt.questions.length} value={attempt.questions.filter(q => q.progress.submitted || q.progress.skipped || q.progress.revealed || (attempt.mode === "test" && q.progress.optionId)).length} />
      <fieldset disabled={busy || disabled || Boolean(done) || Boolean(pendingAction.current)}><legend>{q.stem}</legend>{q.options.map(o => <label className={styles.quizOption} key={o.id}><input type="radio" name={"quiz-" + attempt.id + "-" + index} value={o.id} checked={q.progress.optionId === o.id} onChange={() => void act("choose", o.id)} />{o.label ?? o.id}. {o.text}</label>)}</fieldset>
      <p className={styles.muted} role="status">{busy ? "正在保存…" : pendingAction.current ? "保存尚未确认" : done ? q.progress.skipped ? "已跳过 · 记录已保存" : q.progress.revealed ? "已看答案 · 记录已保存" : "已确认 · 记录已保存" : q.progress.optionId ? "选择已保存" : "请选择一个选项"}</p>
      {q.progress.hinted ? <p className={styles.frameworkSupplement}>提示（本题已记录使用提示）：{q.hint ?? "本题没有额外提示。"}</p> : null}
      {feedback(q,index)}
      <div className={styles.quizActions}>
        {index > 0 ? <button disabled={busy || Boolean(pendingAction.current)} onClick={() => navigateQuestion(index - 1)}>上一题</button> : null}
        {attempt.mode === "practice" && !done ? <button className={styles.primary} disabled={busy || !q.progress.optionId || Boolean(pendingAction.current)} onClick={() => void act("submit")}>确认答案</button>
          : index < attempt.questions.length - 1 ? <button className={styles.primary} disabled={busy || Boolean(pendingAction.current) || (!done && !q.progress.optionId)} onClick={() => navigateQuestion(index + 1)}>下一题</button>
          : attempt.completed ? <button className={styles.primary} onClick={() => setStage("results")}>查看本次结果</button>
          : <button className={styles.primary} disabled={busy || Boolean(pendingAction.current)} onClick={finish}>交卷并查看结果</button>}
      </div>
      {!done && !attempt.completed ? <div className={styles.secondaryActions}>
        <button disabled={busy || q.progress.hinted || Boolean(pendingAction.current)} onClick={() => void act("hint")}>提示</button><button disabled={busy || Boolean(pendingAction.current)} onClick={() => void act("skip")}>跳过本题</button>
        {attempt.mode === "practice" ? <button disabled={busy || Boolean(pendingAction.current)} onClick={() => void act("reveal")}>看答案</button> : null}
      </div> : null}
    </article> : null}
    {stage === "results" && attempt ? <div className={`${styles.quizResults} ${resultStyles.results}`} aria-label="本次结果">
      <header className={resultStyles.header}><h3>{attempt.title}</h3>{attempt.score ? <><p className={`${styles.resultScore} ${resultStyles.score}`}>本次答对 {attempt.score.correct}/{attempt.score.total} 题</p><p className={resultStyles.stats}>无提示答对 {attempt.score.unassistedCorrect} 题 · 使用提示 {attempt.score.hinted} 题 · 看答案 {attempt.score.revealed} 题 · 跳过 {attempt.score.skipped} 题</p></> : null}</header>
      <p className={styles.muted}>成绩只表示这次练习的作答情况，不代表课程掌握率。AI 题目与解析可能有误，请结合来源判断。</p>
      <button type="button" onClick={() => { history(); setStage("prepare"); }}>生成另一组</button>
      <p className={resultStyles.reviewHint}>逐题回顾 · 展开查看答案、解析与来源</p>
      <div className={resultStyles.questions}>{attempt.questions.map((question,i) => {
        const own = question.options.find(o => o.id === question.progress.optionId);
        const correct = question.options.find(o => o.id === question.feedback?.correctOptionId);
        const result = question.progress.skipped ? "已跳过" : question.feedback?.correct ? "答对" : question.progress.revealed ? "已看答案" : "未答对";
        return <details className={resultStyles.question} key={attempt.id + ":" + question.index} aria-label={`第 ${i+1} 题回顾`}>
          <summary className={resultStyles.summary}>
            <span className={resultStyles.number}>第 {i+1} 题</span>
            <span className={resultStyles.summaryContent}><span className={resultStyles.statusLine}><span className={resultStyles.status} data-correct={Boolean(question.feedback?.correct)}>{result}</span>{question.progress.hinted ? <span className={resultStyles.hintLabel}>使用过提示</span> : null}</span><span className={resultStyles.preview}>{question.stem}</span></span>
            <svg className={resultStyles.chevron} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m8 5 7 7-7 7" /></svg>
          </summary>
          <div className={resultStyles.body}>
            <p className={resultStyles.fullStem}>{question.stem}</p>
            <dl className={resultStyles.answers}>
              <div><dt>你的选择</dt><dd>{own ? `${own.label ?? own.id}. ${own.text}` : "未选择"}</dd></div>
              {question.feedback ? <div data-correct="true"><dt>正确答案</dt><dd>{correct ? `${correct.label ?? correct.id}. ${correct.text}` : question.feedback.correctOptionId}</dd></div> : null}
            </dl>
            {question.progress.hinted ? <p className={resultStyles.usedHint}>使用过的提示：{question.hint ?? "本题没有额外提示。"}</p> : null}
            {feedback(question,i,true)}
          </div>
        </details>;
      })}</div>
    </div> : null}
    {sourceText ? <aside className={styles.frameworkNote}><strong>本题使用的笔记 / 补充</strong><p className={styles.original}>{sourceText}</p></aside> : null}
    <ProductDialog open={deleting !== null} title={`删除「${deleting?.title ?? "这组题"}」？`} onClose={closeDelete}
      footer={<div className={styles.row}><button type="button" disabled={busy} onClick={closeDelete}>取消</button>
        <button type="button" className={styles.danger} disabled={busy} onClick={() => void deleteQuiz()}>{busy ? "正在删除…" : "删除题组与记录"}</button></div>}>
      <p>将永久删除这组题及其全部作答记录，包括未完成的练习或测验，无法恢复。</p>
      {deleting?.status === "generating" ? <p>这组题正在生成。删除后，即使生成返回，也不会恢复题组。</p> : null}
      <p>材料、知识框架、个人笔记及其他题组会保留。</p>
      {deleteError ? <p role="alert" className={styles.error}>{deleteError}</p> : null}
    </ProductDialog>
  </section>;
}
