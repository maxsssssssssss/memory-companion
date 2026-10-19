"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LearningAgentReviewSummary } from "@/lib/domain/learning-agent";
import type { LearningMaterial } from "@/lib/domain/learning";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import { LearningApiError, learningApi, LEARNING_INVALIDATION_CHANNEL } from "@/lib/client/learning-api";
import { learningAgentApi, learningAgentErrorMessage, type LearningAgentTaskView, type LearningAgentControl, type LearningAgentMutation, type LearningAgentAdjustment, type StartLearningAgent } from "@/lib/client/learning-agent-api";
import type { QuizAttemptView } from "@/lib/domain/learning-quiz";
import { LearningQuiz } from "./learning-quiz";
import { LearningAgentAdjustmentForm } from "./learning-agent-adjustment";
import { LearningAgentCompletion } from "./learning-agent-completion";
import styles from "./learning.module.css";

const statusLabels: Record<LearningAgentTaskView["status"], string> = {
  ready: "准备执行", running: "正在复习", waiting: "等待你的反馈", paused: "已暂停", cancelled: "用户已取消",
  ended: "本次任务已结束", budget_exhausted: "本轮复习已结束", needs_attention: "结果需要核对",
};
const actionLabels: Record<string, string> = {
  "learning.read_scope": "查看授权范围", "learning.read_navigation": "查看框架与历史", "learning.read_source": "回到材料原文",
  "learning.create_quiz": "准备复习题组", "learning.read_answers": "读取已保存作答", "learning.explain": "生成本轮讲解",
  "learning.request_feedback": "等待用户反馈", "learning.finish": "结束本次任务",
  "learning.append_note": "追加个人笔记（需确认）",
  "learning.establish_review_plan": "整理本轮目标", "learning.associate_evidence": "核对本轮表现",
};
const terminal = new Set(["cancelled", "ended", "budget_exhausted"]);
const progressSignature = (task: LearningAgentTaskView) => JSON.stringify([task.version ?? 1, task.status, task.wait, task.approval?.status, task.actions.map(action => [action.id, action.status]), task.usage?.calls]);
const knownRequestFailure = (reason: unknown) => reason instanceof LearningApiError && (reason.status < 500 || ["agent_not_configured", "agent_decision_not_configured", "learning_generation_not_configured"].includes(reason.code));

function ReviewSummary({ summary, quizLinks, disabled, onReview, onSource }: {
  summary: LearningAgentReviewSummary; quizLinks: NonNullable<LearningAgentTaskView["quizLinks"]>; disabled: boolean;
  onReview: (ref: LearningAgentReviewSummary["topics"][number]["questionRefs"][number]) => void;
  onSource: (id: string, paragraph: number, parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding) => void;
}) {
  const showStats = summary.kind === "partial" || summary.stats.wrong > 0 || summary.stats.hinted > 0 || summary.stats.revealed > 0 || summary.stats.skipped > 0;
  return <section className={styles.agentReviewSummary} aria-label={summary.kind === "completed" ? "本轮复习总结" : "本轮进度回顾"}>
    <h4>{summary.kind === "completed" ? "本轮复习总结" : "本轮进度回顾"}</h4>
    <p className={styles.agentSummaryHeadline}>{summary.headline}</p>
    {showStats && summary.stats.total > 0 ? <div className={styles.agentSummaryMeta}>
      <p>已记录 {summary.stats.groups} 组练习 · 已作答 {summary.stats.answered}/{summary.stats.total} 题</p>
      <p>答对 {summary.stats.correct} 题（其中 {summary.stats.unassistedCorrect} 题未使用提示或提前看答案） · 答错 {summary.stats.wrong} 题</p>
      {summary.stats.hinted || summary.stats.revealed || summary.stats.skipped || summary.stats.unanswered ? <p>使用提示 {summary.stats.hinted} 题 · 看答案 {summary.stats.revealed} 题 · 跳过 {summary.stats.skipped} 题 · 未完成 {summary.stats.unanswered} 题</p> : null}
    </div> : null}
    {summary.topics.length ? <section className={styles.agentSummaryTopics} aria-label="专项讲解">
      {summary.topics.map(topic => <section key={topic.id} className={styles.agentSummaryTopic} aria-label={topic.title}>
        <h5>{topic.title}</h5><p className={styles.original}>{topic.explanation}</p>
        <div className={styles.sources}>{topic.questionRefs.map(ref => {
          const group = quizLinks.findIndex(link => link.quizId === ref.quizId && link.attemptId === ref.attemptId);
          return <button type="button" key={ref.attemptId + ":" + ref.index} disabled={disabled || group < 0} onClick={() => onReview(ref)}>{group < 0 ? "原题组不可用" : "查看错题 · 题组 " + (group + 1) + " 第 " + (ref.index + 1) + " 题"}</button>;
        })}{topic.sources.map((source, index) => <button type="button" key={source.materialId + ":" + source.paragraph + ":" + index} onClick={() => onSource(source.materialId, source.parsed?.physicalPage ?? source.paragraph, source.parsed)}>查看原文 · {topic.title}{topic.sources.length > 1 ? " " + (index + 1) : ""}</button>)}</div>
      </section>)}
    </section> : null}
    {summary.reminders.length ? <div className={styles.agentSummaryReminders}><h5>记住这几点</h5><ul>{summary.reminders.slice(0, 3).map((reminder, index) => <li key={index}>{reminder}</li>)}</ul></div> : null}
    {summary.notices.length ? <div className={styles.agentSummaryNotices}>{summary.notices.map((notice, index) => <p key={index}>{notice}</p>)}</div> : null}
  </section>;
}

export function LearningAgentPanel({ pageId, materials, selected, disabled, active = true, saveSelection, onSource }: {
  pageId: string; materials: LearningMaterial[]; selected: string[]; disabled: boolean; active?: boolean;
  saveSelection: () => Promise<void>; onSource: (id: string, paragraph: number, parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding) => void;
}) {
  const [tasks, setTasks] = useState<LearningAgentTaskView[]>([]), [chosenId, setChosenId] = useState<string | null>(null);
  const [chapters, setChapters] = useState<FrameworkChapter[]>([]);
  const [loaded, setLoaded] = useState(false), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [goal, setGoal] = useState(""), [scopeMode, setScopeMode] = useState("materials");
  const [chapterIds, setChapterIds] = useState<string[]>([]), [nodeIds, setNodeIds] = useState<string[]>([]);
  const [includeHistory, setHistory] = useState(false), [includeNotes, setNotes] = useState(false), [includeSupplements, setSupplements] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [quizFeedback, setQuizFeedback] = useState("");
  const [quizSyncError, setQuizSyncError] = useState("");
  const [inlineQuiz, setInlineQuiz] = useState<{ taskId: string; version: number; quizId: string; review?: { index: number; requestId: string } } | null>(null);
  const quizSection = useRef<HTMLElement | null>(null);
  const syncReceipts = useRef(new Map<string, string>());
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingAdvance, setPendingAdvance] = useState<{ id: string; signature: string } | null>(null);
  const alive = useRef(true), locked = useRef(false), sequence = useRef(0), initialized = useRef(false);
  const pendingStart = useRef<StartLearningAgent | null>(null), pendingControl = useRef<LearningAgentMutation | null>(null);
  const task = tasks.find(item => item.id === chosenId) ?? tasks[0] ?? null;
  const currentTask = useRef(task); currentTask.current = task;
  const endReason = task?.endReason?.trim();
  const selectTask = (id: string) => {
    setChosenId(id); setCreating(false); setFeedback("");
    if (id !== task?.id) { setQuizFeedback(""); setQuizSyncError(""); }
    const url = new URL(window.location.href); url.searchParams.set("agent", id); window.history.replaceState(window.history.state, "", url);
  };
  const load = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const [result, framework] = await Promise.all([learningAgentApi.list(pageId), learningApi.framework(pageId)]);
      if (!alive.current || sequence.current !== version) return;
      setTasks(result.tasks); setChapters(framework.framework.chapters); setLoaded(true); setError("");
      setPendingAdvance(previous => {
        if (!previous) return null;
        const updated = result.tasks.find(item => item.id === previous.id);
        return !updated || progressSignature(updated) !== previous.signature ? null : previous;
      });
      if (!initialized.current) {
        const requested = new URLSearchParams(window.location.search).get("agent");
        setChosenId(result.tasks.some(item => item.id === requested) ? requested : result.tasks[0]?.id ?? null);
        setCreating(!result.tasks.length); initialized.current = true;
      }
    } catch (reason) {
      if (!alive.current || sequence.current !== version) return;
      setError(learningAgentErrorMessage(reason)); setLoaded(true);
      if (reason instanceof LearningApiError && [401, 404, 410].includes(reason.status)) {
        setTasks([]); setChapters([]); setGoal(""); setFeedback(""); setChapterIds([]); setNodeIds([]);
        setHistory(false); setNotes(false); setSupplements(false); pendingStart.current = null; pendingControl.current = null;
        setPendingAdvance(null); setEditing(null);
      }
    }
  }, [pageId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const refresh = () => { if (!locked.current) void load(); };
    window.addEventListener("focus", refresh);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(LEARNING_INVALIDATION_CHANNEL);
    if (channel) channel.onmessage = event => { if (event.data?.pageId === pageId) refresh(); };
    return () => { window.removeEventListener("focus", refresh); channel?.close(); };
  }, [active, load, pageId, materials]);
  const computing = Boolean(pendingAdvance) || tasks.some(item => item.status === "ready" || item.status === "running");
  useEffect(() => {
    if (!active || !computing) return;
    const timer = setInterval(() => { if (!document.hidden && !locked.current) void load(); }, 1500);
    return () => clearInterval(timer);
  }, [active, computing, load]);
  const publish = (value: LearningAgentTaskView) => {
    sequence.current++;
    setTasks(previous => [value, ...previous.filter(item => item.id !== value.id)]); selectTask(value.id);
  };
  async function work(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; sequence.current++; setBusy(true); setError("");
    try { await fn(); } catch (reason) { if (alive.current) setError(learningAgentErrorMessage(reason)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const start = () => work(async () => {
    const input = pendingStart.current ?? { id: crypto.randomUUID(), goal: goal.trim(), scope: {
      materialIds: scopeMode === "materials" ? [...selected] : [], chapterIds: scopeMode === "chapters" ? [...chapterIds] : [], nodeIds: scopeMode === "nodes" ? [...nodeIds] : [],
      includeHistory, includeNotes, includeSupplements,
    } };
    if (!pendingStart.current && scopeMode === "materials") await saveSelection();
    pendingStart.current = input;
    try { const result = await learningAgentApi.start(pageId, input); pendingStart.current = null; if (alive.current) publish(result.task); }
    catch (reason) { if (knownRequestFailure(reason)) pendingStart.current = null; throw reason; }
  });
  async function submitControl(value: LearningAgentMutation) {
    const input = pendingControl.current ?? value;
    pendingControl.current = input;
    try {
      const result = await learningAgentApi.control(pageId, input); pendingControl.current = null;
      if (alive.current) {
        publish(result.task); setFeedback("");
        if (input.action === "dispute_quiz") setQuizFeedback("");
        if (input.action === "sync_quiz") setQuizSyncError("");
        if (input.action === "adjust") setEditing(null);
        setPendingAdvance(result.scheduled ? { id: result.task.id, signature: progressSignature(result.task) } : null);
      }
    }
    catch (reason) { if (input.action === "sync_quiz") setQuizSyncError("作答已保存，自动衔接尚未确认。可以核对衔接状态，无需重新作答。"); if (knownRequestFailure(reason)) pendingControl.current = null; throw reason; }
  }
  const mutateTask = (value: LearningAgentMutation) => work(() => submitControl(value));
  const control = (action: LearningAgentControl["action"], attemptId?: string, dispute = false) => {
    if (!task) return Promise.resolve();
    return mutateTask({ id: task.id, action, expectedVersion: task.version ?? 1, eventId: crypto.randomUUID(), ...(attemptId ? { attemptId } : {}), ...(action === "feedback" && (!attemptId || dispute) ? { feedback: feedback.trim() } : {}) });
  };
  const adjust = (value: LearningAgentAdjustment) => { if (task) void mutateTask({ id: task.id, action: "adjust", eventId: crypto.randomUUID(), ...value }); };
  const approvalDecision = (decision: "approve" | "reject") => {
    if (task?.approval) void mutateTask({ id: task.id, action: "approval", eventId: crypto.randomUUID(), expectedVersion: task.version ?? 1, approvalId: task.approval.id, fingerprint: task.approval.fingerprint, decision });
  };
  const recover = (mode: "inspect" | "retry") => { if (task) void mutateTask({ id: task.id, action: "recover", eventId: crypto.randomUUID(), expectedVersion: task.version ?? 1, mode }); };
  const end = () => { if (task) void mutateTask({ id: task.id, action: "end", eventId: crypto.randomUUID(), expectedVersion: task.version ?? 1 }); };
  const explanationFeedback = (explanationId: string, outcome: "resolved" | "needs_clarification") => {
    if (task) void mutateTask({ id: task.id, action: "explanation_feedback", expectedVersion: task.version ?? 1,
      eventId: crypto.randomUUID(), explanationId, outcome, ...(feedback.trim() ? { message: feedback.trim() } : {}) });
  };
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id];
  const scopedNodes = chapters.flatMap(chapter => chapter.nodes.filter(node => scopeMode === "chapters" ? chapterIds.includes(chapter.id) : nodeIds.includes(node.id)));
  const scopeMaterials = materials.filter(material => scopeMode === "materials" ? selected.includes(material.id) : scopedNodes.some(node => node.sources.some(source => source.materialId === material.id)));
  const hasScope = scopeMode === "materials" ? selected.length > 0 : scopeMode === "chapters" ? chapterIds.length > 0 : nodeIds.length > 0;
  const quizLinks = task?.quizLinks ?? [];
  const waitingQuiz = task?.wait?.kind === "quiz_submission";
  const attemptId = waitingQuiz ? task.wait?.refId : undefined;
  const approvalWaiting = task?.approval?.status === "pending" && task.approval.taskVersion === (task.version ?? 1);
  const sourceAssociationBlocked = Boolean(task?.completion?.technicalBlocker
    && task.completion.taskVersion === (task.version ?? 1) && task.completion.outcome !== "stale");
  const explanationToConfirm = task?.completion?.plan?.kind === "explanation"
    && task.completion.taskVersion === (task.version ?? 1) && task.completion.outcome !== "stale"
    && task.status === "waiting" && task.wait?.kind === "feedback"
    ? task.explanations?.[task.explanations.length - 1] : undefined;
  const explanationHasKnownIssue = explanationToConfirm?.contentIssue?.status === "known_issue"
    || Boolean(explanationToConfirm && task?.completion?.contentIssues?.some(issue => issue.explanationId === explanationToConfirm.id));
  const explanationMissing = task?.completion?.plan?.kind === "explanation"
    && task.completion.taskVersion === (task.version ?? 1) && task.completion.outcome !== "stale"
    && !task.explanations?.length && task.completion.objectives.some(objective => objective.explanationState === "missing");
  const interactionLocked = busy || Boolean(pendingControl.current) || Boolean(task && pendingAdvance?.id === task.id);
  const scopeDescription = (value: LearningAgentTaskView["scope"]) => [
    ...value.materialIds.map(id => materials.find(item => item.id === id)?.title ?? "已不可用的材料"),
    ...value.chapterIds.map(id => chapters.find(item => item.id === id)?.title ?? "已不可用的章节"),
    ...value.nodeIds.map(id => chapters.flatMap(item => item.nodes).find(item => item.id === id)?.title ?? "已不可用的知识点"),
  ].join("、");
  const showNextStep = Boolean(task?.wait && !terminal.has(task.status) && !editing && !task.recovery && !approvalWaiting);
  const shownQuiz = task && inlineQuiz?.taskId === task.id && inlineQuiz.version === (task.version ?? 1)
    ? quizLinks.find(link => link.quizId === inlineQuiz.quizId) : undefined;
  useEffect(() => {
    if (!task || shownQuiz || !quizLinks.length) return;
    const preferred = quizLinks.find(link => link.attemptId === task.wait?.refId)
      ?? [...quizLinks].reverse().find(link => !link.historical) ?? quizLinks[quizLinks.length - 1];
    setInlineQuiz({ taskId: task.id, version: task.version ?? 1, quizId: preferred.quizId });
  }, [task, shownQuiz, quizLinks]);
  const savedAttempt = useCallback((attempt: QuizAttemptView) => {
    const latest = currentTask.current;
    if (!task || !latest || latest.id !== task.id || (latest.version ?? 1) !== (task.version ?? 1)
      || !latest.quizLinks?.some(link => link.quizId === attempt.quizId && link.attemptId === attempt.id)) return;
    // A saved attempt is newer than any list already in flight.
    sequence.current++;
    setTasks(previous => previous.map(value => value.id === latest.id && (value.version ?? 1) === (latest.version ?? 1)
      ? { ...value, quizLinks: value.quizLinks?.map(link => link.quizId === attempt.quizId ? { ...link, completed: attempt.completed } : link) } : value));
  }, [task?.id, task?.version]);
  const completedWait = quizLinks.find(link => link.attemptId === attemptId && link.completed && !link.disputed);
  useEffect(() => {
    if (!active || creating || editing || !task || task.status !== "waiting" || !completedWait?.attemptId
      || !waitingQuiz || busy || locked.current || pendingControl.current || pendingAdvance?.id === task.id) return;
    const key = JSON.stringify([task.id, task.version ?? 1, completedWait.attemptId]);
    if (syncReceipts.current.has(key)) return;
    const eventId = crypto.randomUUID(); syncReceipts.current.set(key, eventId);
    void work(() => submitControl({ id: task.id, action: "sync_quiz", expectedVersion: task.version ?? 1,
      eventId, attemptId: completedWait.attemptId! }));
  }, [active, creating, editing, task, completedWait, waitingQuiz, busy, pendingAdvance]);
  const retryQuizSync = () => {
    if (!task || !completedWait?.attemptId) return;
    const key = JSON.stringify([task.id, task.version ?? 1, completedWait.attemptId]);
    const eventId = syncReceipts.current.get(key) ?? crypto.randomUUID(); syncReceipts.current.set(key, eventId);
    void mutateTask({ id: task.id, action: "sync_quiz", expectedVersion: task.version ?? 1, eventId, attemptId: completedWait.attemptId });
  };
  const disputeQuiz = () => {
    if (!task || !shownQuiz?.attemptId || !quizFeedback.trim()) return;
    void mutateTask({ id: task.id, action: "dispute_quiz", expectedVersion: task.version ?? 1,
      eventId: crypto.randomUUID(), attemptId: shownQuiz.attemptId, feedback: quizFeedback.trim() });
  };
  const reviewQuestion = (ref: LearningAgentReviewSummary["topics"][number]["questionRefs"][number]) => {
    if (!task || !quizLinks.some(link => link.quizId === ref.quizId && link.attemptId === ref.attemptId)) return;
    setInlineQuiz({ taskId: task.id, version: task.version ?? 1, quizId: ref.quizId, review: { index: ref.index, requestId: crypto.randomUUID() } });
    setQuizFeedback(""); quizSection.current?.focus({ preventScroll: true }); quizSection.current?.scrollIntoView?.({ block: "start" });
  };
  const quizControls = task && quizLinks.length > 1 ? <div className={styles.row}>{quizLinks.map((link, index) => <button
    type="button" key={link.quizId} disabled={Boolean(editing)} aria-pressed={shownQuiz?.quizId === link.quizId}
    className={waitingQuiz && link.attemptId === attemptId && shownQuiz?.quizId !== link.quizId ? styles.primary : undefined}
    onClick={() => { setInlineQuiz({ taskId: task.id, version: task.version ?? 1, quizId: link.quizId }); setQuizFeedback(""); }}>{link.historical ? "查看历史作答" : "查看题组"} {index + 1}</button>)}</div> : null;
  return <section className={`${styles.section} ${styles.agentSection}`} aria-label="复习向导">
    <header className={`${styles.sectionHeader} ${styles.agentHeader}`}>
      <div><h2>复习向导</h2><p className={styles.muted}>围绕你的目标，结合练习与反馈，一起理清知识。</p></div>
      <div className={styles.row}>
        <button type="button" className={styles.agentQuietButton} disabled={busy} onClick={() => void load()}>刷新任务</button>
        {task && !creating ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => { setCreating(true); setError(""); }}>开始另一项复习</button> : null}
      </div>
    </header>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {!loaded ? <p role="status">正在读取复习任务…</p> : null}
    {loaded && (creating || !task) ? <div className={styles.agentPanel}>
      <fieldset className={`${styles.quizSettings} ${styles.agentStart}`} disabled={disabled || busy || Boolean(pendingStart.current)}><legend>确认本次复习</legend>
        <label>复习目标<textarea maxLength={1000} rows={3} value={goal} placeholder="例如：我不理解条件概率，先帮我理清它的含义。" onChange={event => setGoal(event.target.value)} /></label>
        <label>复习范围<select value={scopeMode} onChange={event => setScopeMode(event.target.value)}><option value="materials">当前勾选材料（{selected.length} 份）</option><option value="chapters">明确选择章节</option><option value="nodes">明确选择知识点</option></select></label>
        {scopeMode !== "materials" ? <div>{chapters.length ? chapters.map(chapter => <div key={chapter.id}>
          {scopeMode === "chapters" ? <label className={styles.materialCheck}><input type="checkbox" checked={chapterIds.includes(chapter.id)} onChange={() => setChapterIds(toggle(chapterIds, chapter.id))} />{chapter.title}</label>
            : <><strong>{chapter.title}</strong>{chapter.nodes.map(node => <label key={node.id} className={styles.materialCheck}><input type="checkbox" checked={nodeIds.includes(node.id)} onChange={() => setNodeIds(toggle(nodeIds, node.id))} />{node.title}</label>)}</>}
        </div>) : <p>尚无章节或知识点，请先选择已保存材料。</p>}</div> : null}
        <p>本次材料：{scopeMaterials.map(item => item.title).join("、") || "尚未选择，请先在材料页勾选或选择上方章节 / 知识点。"}</p>
        <p className={styles.muted}>{scopeMode === "materials" ? "仅读取所选材料的可用正文；PDF 沿用已明确保存的解析页与区域。" : "只读取所选章节或知识点绑定的原文段落。"} 调整本轮目标或授权需再次明确确认，不扩展到其他学习页或产品。</p>
        <div className={styles.agentPermissionsForm}>
        <label className={styles.materialCheck}><input type="checkbox" checked={includeHistory} onChange={event => setHistory(event.target.checked)} />允许读取本范围的相关作答历史</label>
        <label className={styles.materialCheck}><input type="checkbox" checked={includeNotes} onChange={event => setNotes(event.target.checked)} />纳入本范围的个人笔记</label>
        <label className={styles.materialCheck}><input type="checkbox" checked={includeSupplements} onChange={event => setSupplements(event.target.checked)} />允许本范围的材料外补充解释</label>
        </div>
        <p className={styles.muted}>勾选补充后，可读取本范围已保存的补充，并在本轮讲解中提供明确标注的材料外补充。讲解随本轮保存，不自动写入个人笔记。不联网寻找新材料。</p>
        <button type="button" className={styles.primary} disabled={!goal.trim() || !hasScope} onClick={() => void start()}>明确开始复习</button>
      </fieldset>
      {pendingStart.current ? <button type="button" disabled={busy} onClick={() => void start()}>核对本次任务是否已开始</button> : null}
      {task ? <button type="button" disabled={busy || Boolean(pendingStart.current)} onClick={() => setCreating(false)}>返回当前任务</button> : null}

    </div> : task ? <div className={styles.agentPanel}>
      {tasks.length > 1 ? <label className={styles.agentTaskPicker}>已保存任务<select value={task.id} disabled={interactionLocked || Boolean(editing)} onChange={event => selectTask(event.target.value)}>{tasks.map(item => <option key={item.id} value={item.id}>{item.goal} · {statusLabels[item.status]}</option>)}</select></label> : null}
      <div className={styles.agentOverview}>
        <p role="status" className={styles.agentStatus}><span className={styles.badge}>{statusLabels[task.status]}</span>{task.currentAction ? <span>{actionLabels[task.currentAction] ?? "正在准备下一步"}</span> : null}</p>
        <h3 className={styles.agentGoal}>{task.goal}</h3>
        <p className={styles.agentScope}>复习范围：{scopeDescription(task.scope)}</p>
        <div className={styles.agentPermissions} aria-label="本轮使用的内容">
          <span>相关历史：{task.scope.includeHistory ? "允许" : "不读取"}</span>
          <span>个人笔记：{task.scope.includeNotes ? "已纳入" : "未纳入"}</span>
          <span>材料外补充：{task.scope.includeSupplements ? "已纳入" : "未纳入"}</span>
        </div>
      </div>
      {task.completion ? <LearningAgentCompletion completion={task.completion} taskVersion={task.version ?? 1} ended={terminal.has(task.status)}
        quizLinks={quizLinks} materials={materials} disabled={Boolean(editing)} onReview={ref => reviewQuestion({ quizId: ref.quizId, attemptId: ref.attemptId, index: ref.questionIndex })} onSource={onSource} /> : null}
      {task.reviewSummary ? <ReviewSummary summary={task.reviewSummary} quizLinks={quizLinks} disabled={Boolean(editing)} onReview={reviewQuestion} onSource={onSource} /> : null}
      {pendingAdvance?.id === task.id ? <p role="status" className={styles.agentNotice}>反馈已受理，正在读取任务进度…</p> : null}
      {task.status === "budget_exhausted" ? <p className={styles.agentNotice}>{endReason && endReason !== "本任务预算耗尽，已停止；等待用户的时间不计入计算预算。"
        ? endReason : "本轮复习因执行限制停止，旧记录未保存具体原因。已有内容已保留，你可以开始新的复习。"}</p>
        : task.status === "paused" && task.endReason === "用户已拒绝这项提案；原行动不会作为生成失败重试。" ? <p className={styles.agentNotice}>你已拒绝这项笔记建议，可以调整复习或结束本轮。</p>
        : task.endReason && !(task.status === "needs_attention" && task.recovery) ? <p className={styles.agentNotice}>{task.endReason}</p> : null}
      {editing === task.id ? <LearningAgentAdjustmentForm key={task.id} task={task} materials={materials} chapters={chapters} disabled={interactionLocked}
        onSubmit={adjust} onRefresh={() => void load()} onClose={() => setEditing(null)} /> : null}
      {task.recovery && !terminal.has(task.status) ? <section aria-label="处理任务中断" className={styles.agentRecovery}>
        <h4>{({ unknown: "结果未知，先核对原操作", known_failed: "上次操作明确失败", not_started: "上次操作尚未开始", succeeded: "原操作已有结果", source_invalid: "来源已变化，需要重新确认", version_changed: "复习内容已更新", interrupted: "执行已中断", feedback_received: "已记录题目疑问" })[task.recovery.kind]}</h4>
        <p>{task.recovery.kind === "version_changed" ? "复习内容或待确认的笔记已变化，请刷新后重新确认。" : task.recovery.message}</p>
        <div className={styles.row}>
          {task.recovery.allowedControls.includes("inspect") ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => recover("inspect")}>核对原操作结果</button> : null}
          {task.recovery.allowedControls.includes("retry") && task.recovery.kind !== "unknown" ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => recover("retry")}>{task.recovery.kind === "known_failed" ? "重试明确失败的操作" : task.recovery.kind === "not_started" ? "执行尚未开始的操作" : "继续已核对的操作"}</button> : null}
          {task.recovery.allowedControls.includes("adjust") ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => setEditing(task.id)}>重新确认本轮范围</button> : null}
          <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={end}>结束并交回本轮复习</button>
        </div>
        {task.recovery.kind === "unknown" ? <p className={styles.muted}>暂时无法确认是否完成。请先检查已有结果，以免重复生成。</p> : null}
      </section> : null}
      {approvalWaiting ? <section aria-label="待确认笔记" className={styles.agentApproval}><h4>{task.approval!.title}</h4><p>{task.approval!.summary}</p>
        <p>追加目标：{task.approval!.target}</p><p className={styles.muted}>下面是将准确追加的内容；不会覆盖原笔记。普通读取与练习不需要这项确认。</p>
        <div className={styles.frameworkNote}><p className={styles.original}>{task.approval!.content}</p></div>
        <p>材料外补充：{task.approval!.includesSupplement ? "包含，已明确标注" : "不包含"}。</p>
        {task.approval!.sources?.length ? <div className={styles.sources}>{task.approval!.sources.map((source, index) => <button key={index} type="button" onClick={() => onSource(source.materialId, source.parsed?.physicalPage ?? source.paragraph, source.parsed)}>查看笔记引用原文 {index + 1}</button>)}</div> : null}
        <div className={styles.row}><button type="button" className={styles.primary} disabled={interactionLocked || Boolean(editing) || task.status !== "waiting"} onClick={() => approvalDecision("approve")}>批准追加到个人笔记</button>
          <button type="button" disabled={interactionLocked || Boolean(editing) || task.status !== "waiting"} onClick={() => approvalDecision("reject")}>拒绝这项笔记提议</button></div>
        <p className={styles.muted}>只会保存你确认的这份内容。关闭页面不会保存；调整范围或来源变化后，需要重新确认。</p>
      </section> : null}
      {shownQuiz ? <section ref={quizSection} tabIndex={-1} className={styles.agentQuizArchive} aria-label={shownQuiz.historical ? "相关历史作答" : "本轮练习"}>
        <h4>{shownQuiz.historical ? "相关历史作答" : "本轮练习"}</h4>{quizControls}
        <p className={styles.muted}>{shownQuiz.historical ? "这组历史作答用于本轮核对，原题、作答与成绩保持不变。查看记录不会重新启动复习。"
          : terminal.has(task.status) ? "本轮已结束。题组、作答与解析保留在这里，查看记录不会重新启动复习。"
          : sourceAssociationBlocked ? "已保存的练习保留供回看。请先核对目标与来源，不要求继续作答来解决关联问题。"
          : task.status === "paused" ? "本轮已暂停。作答仍会保存，继续复习后再读取结果。"
          : "整组作答保存后，复习向导会自动读取结果并继续。你可以留在这里查看解析。"}</p>
        <LearningQuiz key={task.id + ":" + (task.version ?? 1) + ":" + shownQuiz.quizId} pageId={pageId} materials={materials} selected={selected}
          disabled={disabled || Boolean(editing)} saveSelection={saveSelection} onSource={onSource} embedded openQuizId={shownQuiz.quizId} openReview={inlineQuiz?.taskId === task.id && inlineQuiz.version === (task.version ?? 1) ? inlineQuiz.review : undefined} onAttemptSaved={savedAttempt} />
        {quizSyncError ? <p role="alert">{quizSyncError}</p> : null}
        {quizSyncError && completedWait && !pendingControl.current ? <button type="button" disabled={busy} onClick={retryQuizSync}>核对作答衔接</button> : null}
        {shownQuiz.completed && (pendingAdvance?.id === task.id || task.status === "running" || task.status === "ready")
          ? <p role="status">作答已保存，复习向导正在根据这次结果准备下一步。解析会继续保留。</p> : null}
        {shownQuiz.disputed ? <p className={styles.agentNotice}>这组题已标记为有疑问，不再用它的成绩判断薄弱点。已有作答保持原样。</p>
          : shownQuiz.attemptId && !shownQuiz.historical && task.status !== "cancelled" ? <details className={styles.agentDispute}><summary>这组题有疑问</summary><div className={styles.agentDisputeBody}>
            <label>说明题目疑问<textarea rows={2} maxLength={1000} value={quizFeedback} disabled={busy || Boolean(pendingControl.current) || Boolean(editing)} onChange={event => setQuizFeedback(event.target.value)} placeholder="说明有疑问的题目或依据，先停止用这组题判断薄弱点。" /></label>
            <button type="button" disabled={busy || !quizFeedback.trim() || Boolean(pendingControl.current) || Boolean(editing)} onClick={disputeQuiz}>提交疑问并暂停</button>
            <p className={styles.muted}>提交后暂停后续复习，并标记这组题不用于诊断。已有答案与成绩保持原样。</p>
          </div></details> : null}
      </section> : null}
      {task.explanations?.length ? <p className={styles.muted}>本轮讲解根据本轮授权材料生成，随本轮保存，不会自动写入个人笔记；材料外补充会明确标注。</p> : null}
      {task.explanations?.map((explanation, index) => <details key={explanation.id} className={styles.agentExplanation} open><summary>本轮讲解 {index + 1}</summary>
        {explanation.contentIssue?.status === "known_issue" || task.completion?.contentIssues?.some(issue => issue.explanationId === explanation.id)
          ? <p className={styles.agentNotice} role="alert">这段讲解存在内容矛盾，暂不用于判断疑问是否已解决。请核对引用原文，或说明需要重新讲清的地方。</p> : null}
        <p className={styles.original}>{explanation.text}</p>
        {explanation.sources?.length ? <div className={styles.sources}>{explanation.sources.map((source, i) => <button key={i} type="button" onClick={() => onSource(source.materialId, source.parsed?.physicalPage ?? source.paragraph, source.parsed)}>查看引用原文 {i + 1}</button>)}</div> : null}</details>)}

      {showNextStep ? <section className={styles.agentNextStep} aria-label="接下来">
        <h4>{sourceAssociationBlocked ? "先核对本轮复习" : waitingQuiz ? "完成练习，再继续复习" : "一起继续理清知识"}</h4>
        <p>{sourceAssociationBlocked ? "请使用“调整本轮复习”核对目标与材料，或先结束本轮。无需为解决来源关联问题继续答题；已有题组与作答保持原样，讲解也会保留。调整后将重新读取原文并核对关联。" : task.wait!.message}</p>
        {sourceAssociationBlocked ? <button type="button" disabled={interactionLocked} onClick={end}>结束本轮复习</button> : null}
        {!sourceAssociationBlocked && waitingQuiz && shownQuiz?.attemptId !== attemptId ? <p className={styles.muted}>下一组练习已准备好，可在本轮练习中切换查看。</p> : null}
      {task.status === "waiting" && !sourceAssociationBlocked && !waitingQuiz && !approvalWaiting && task.wait?.kind !== "confirmation" && !editing ? <div className={styles.agentFeedback}><label>你的反馈<textarea rows={3} maxLength={1000} value={feedback} disabled={busy || Boolean(pendingControl.current) || pendingAdvance?.id === task.id} onChange={event => setFeedback(event.target.value)} placeholder="例如：这段讲解有帮助，我想练习一下；或说明仍不明白的地方。" /></label>
        {explanationMissing && !explanationToConfirm ? <p className={styles.muted}>本轮还没有相关讲解。你可以先补充困惑或需要核对的材料。</p> : null}
        {explanationToConfirm ? <><p className={styles.muted}>{explanationHasKnownIssue ? "这段讲解需要重新核对。你可以说明问题，已有讲解会保留。" : "针对最近一次讲解，请明确告诉我们疑问是否已解决。只记录这次反馈，不把它当作学习检查通过。"}</p>
          <div className={styles.row}>{!explanationHasKnownIssue && !explanationMissing ? <button type="button" className={styles.primary} disabled={interactionLocked} onClick={() => explanationFeedback(explanationToConfirm.id, "resolved")}>疑问已解决</button> : null}
          <button type="button" disabled={interactionLocked} onClick={() => explanationFeedback(explanationToConfirm.id, "needs_clarification")}>仍需说明</button>
          <button type="button" disabled={interactionLocked || !feedback.trim()} onClick={() => void control("feedback")}>提交其他反馈</button></div></>
          : <button type="button" className={styles.primary} disabled={busy || !feedback.trim() || Boolean(pendingControl.current) || pendingAdvance?.id === task.id} onClick={() => void control("feedback")}>提交反馈并继续</button>}</div> : null}

      </section> : null}
      {!terminal.has(task.status) ? <div className={styles.agentTaskControls}>
        {!editing ? <button type="button" disabled={interactionLocked} onClick={() => setEditing(task.id)}>调整本轮复习</button> : null}
        <div className={styles.row}>
        {task.status === "paused" || task.status === "ready" ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => void control("resume")}>继续任务</button> : task.status !== "needs_attention" ? <button type="button" disabled={busy || Boolean(pendingControl.current) || Boolean(editing)} onClick={() => void control("pause")}>暂停任务</button> : null}
        <button type="button" className={styles.danger} disabled={busy || Boolean(pendingControl.current) || Boolean(editing)} onClick={() => void control("cancel")}>取消任务</button>
        </div>
      </div> : null}
      {pendingControl.current ? <button type="button" disabled={busy} onClick={() => void work(() => submitControl(pendingControl.current!))}>核对本次任务操作</button> : null}
    </div> : null}
    <p className={styles.agentFootnote}>题目与讲解可能有误；复习结束不代表已经掌握。</p>
  </section>;
}
