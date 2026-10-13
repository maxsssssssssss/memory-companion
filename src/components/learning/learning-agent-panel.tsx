"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LearningMaterial } from "@/lib/domain/learning";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import { LearningApiError, learningApi, LEARNING_INVALIDATION_CHANNEL } from "@/lib/client/learning-api";
import { learningAgentApi, learningAgentErrorMessage, type LearningAgentTaskView, type LearningAgentControl, type LearningAgentMutation, type LearningAgentAdjustment, type StartLearningAgent } from "@/lib/client/learning-agent-api";
import { LearningAgentAdjustmentForm } from "./learning-agent-adjustment";
import styles from "./learning.module.css";

const statusLabels: Record<LearningAgentTaskView["status"], string> = {
  ready: "准备执行", running: "正在复习", waiting: "等待你的反馈", paused: "已暂停", cancelled: "用户已取消",
  ended: "本次任务已结束", budget_exhausted: "本次预算已用完", needs_attention: "结果需要核对",
};
const actionLabels: Record<string, string> = {
  "learning.read_scope": "查看授权范围", "learning.read_navigation": "查看框架与历史", "learning.read_source": "回到材料原文",
  "learning.create_quiz": "准备复习题组", "learning.read_answers": "读取已保存作答", "learning.explain": "生成任务内解释",
  "learning.request_feedback": "等待用户反馈", "learning.finish": "结束本次任务",
  "learning.append_note": "追加个人笔记（需确认）",
};
const terminal = new Set(["cancelled", "ended", "budget_exhausted"]);
const actionStatusLabels: Record<string, string> = { prepared: "等待执行", running: "执行中", succeeded: "已完成", failed: "明确失败", unknown: "结果未知" };
const progressSignature = (task: LearningAgentTaskView) => JSON.stringify([task.version ?? 1, task.status, task.wait, task.approval?.status, task.actions.map(action => [action.id, action.status]), task.usage?.calls]);
const knownRequestFailure = (reason: unknown) => reason instanceof LearningApiError && (reason.status < 500 || ["agent_not_configured", "agent_decision_not_configured", "learning_generation_not_configured"].includes(reason.code));

export function LearningAgentPanel({ pageId, materials, selected, disabled, active = true, saveSelection, onQuiz, onSource }: {
  pageId: string; materials: LearningMaterial[]; selected: string[]; disabled: boolean; active?: boolean;
  saveSelection: () => Promise<void>; onQuiz: (id: string) => void; onSource: (id: string, paragraph: number, parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding) => void;
}) {
  const [tasks, setTasks] = useState<LearningAgentTaskView[]>([]), [chosenId, setChosenId] = useState<string | null>(null);
  const [chapters, setChapters] = useState<FrameworkChapter[]>([]);
  const [loaded, setLoaded] = useState(false), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [goal, setGoal] = useState(""), [scopeMode, setScopeMode] = useState("materials");
  const [chapterIds, setChapterIds] = useState<string[]>([]), [nodeIds, setNodeIds] = useState<string[]>([]);
  const [includeHistory, setHistory] = useState(false), [includeNotes, setNotes] = useState(false), [includeSupplements, setSupplements] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingAdvance, setPendingAdvance] = useState<{ id: string; signature: string } | null>(null);
  const alive = useRef(true), locked = useRef(false), sequence = useRef(0), initialized = useRef(false);
  const pendingStart = useRef<StartLearningAgent | null>(null), pendingControl = useRef<LearningAgentMutation | null>(null);
  const task = tasks.find(item => item.id === chosenId) ?? tasks[0] ?? null;
  const selectTask = (id: string) => {
    setChosenId(id); setCreating(false); setFeedback("");
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
        if (input.action === "adjust") setEditing(null);
        setPendingAdvance(result.scheduled ? { id: result.task.id, signature: progressSignature(result.task) } : null);
      }
    }
    catch (reason) { if (knownRequestFailure(reason)) pendingControl.current = null; throw reason; }
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
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id];
  const scopedNodes = chapters.flatMap(chapter => chapter.nodes.filter(node => scopeMode === "chapters" ? chapterIds.includes(chapter.id) : nodeIds.includes(node.id)));
  const scopeMaterials = materials.filter(material => scopeMode === "materials" ? selected.includes(material.id) : scopedNodes.some(node => node.sources.some(source => source.materialId === material.id)));
  const hasScope = scopeMode === "materials" ? selected.length > 0 : scopeMode === "chapters" ? chapterIds.length > 0 : nodeIds.length > 0;
  const quizLinks = task?.quizLinks ?? [];
  const waitingQuiz = task?.wait?.kind === "quiz_submission";
  const attemptId = waitingQuiz ? task.wait?.refId : undefined;
  const approvalWaiting = task?.approval?.status === "pending" && task.approval.taskVersion === (task.version ?? 1);
  const interactionLocked = busy || Boolean(pendingControl.current) || Boolean(task && pendingAdvance?.id === task.id);
  const scopeDescription = (value: LearningAgentTaskView["scope"]) => [
    ...value.materialIds.map(id => materials.find(item => item.id === id)?.title ?? "已不可用的材料"),
    ...value.chapterIds.map(id => chapters.find(item => item.id === id)?.title ?? "已不可用的章节"),
    ...value.nodeIds.map(id => chapters.flatMap(item => item.nodes).find(item => item.id === id)?.title ?? "已不可用的知识点"),
  ].join("、");
  return <section className={styles.section} aria-label="自适应复习·试用">
    <div className={styles.sectionHeader}><h2>自适应复习·试用</h2><div className={styles.row}>
      <button type="button" disabled={busy} onClick={() => void load()}>刷新任务</button>
      {task && !creating ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => { setCreating(true); setError(""); }}>开始另一项复习</button> : null}
    </div></div>
    <p className={styles.muted}>根据目标与实际反馈选择下一步。题目与解释可能有误；任务结束不代表已经掌握。</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {!loaded ? <p role="status">正在读取复习任务…</p> : null}
    {loaded && (creating || !task) ? <div className={styles.agentPanel}>
      <fieldset className={styles.quizSettings} disabled={disabled || busy || Boolean(pendingStart.current)}><legend>确认本次复习</legend>
        <label>复习目标<textarea maxLength={1000} rows={3} value={goal} placeholder="例如：我不理解条件概率，先帮我理清它的含义。" onChange={event => setGoal(event.target.value)} /></label>
        <label>复习范围<select value={scopeMode} onChange={event => setScopeMode(event.target.value)}><option value="materials">当前勾选材料（{selected.length} 份）</option><option value="chapters">明确选择章节</option><option value="nodes">明确选择知识点</option></select></label>
        {scopeMode !== "materials" ? <div>{chapters.length ? chapters.map(chapter => <div key={chapter.id}>
          {scopeMode === "chapters" ? <label className={styles.materialCheck}><input type="checkbox" checked={chapterIds.includes(chapter.id)} onChange={() => setChapterIds(toggle(chapterIds, chapter.id))} />{chapter.title}</label>
            : <><strong>{chapter.title}</strong>{chapter.nodes.map(node => <label key={node.id} className={styles.materialCheck}><input type="checkbox" checked={nodeIds.includes(node.id)} onChange={() => setNodeIds(toggle(nodeIds, node.id))} />{node.title}</label>)}</>}
        </div>) : <p>尚无章节或知识点，请先选择已保存材料。</p>}</div> : null}
        <p>本次材料：{scopeMaterials.map(item => item.title).join("、") || "尚未选择，请先在材料页勾选或选择上方章节 / 知识点。"}</p>
        <p className={styles.muted}>{scopeMode === "materials" ? "仅读取所选材料的可用正文；PDF 沿用已明确保存的解析页与区域。" : "只读取所选章节或知识点绑定的原文段落。"} 调整本轮目标或授权需再次明确确认，不扩展到其他学习页或产品。</p>
        <label className={styles.materialCheck}><input type="checkbox" checked={includeHistory} onChange={event => setHistory(event.target.checked)} />允许读取本范围的相关作答历史</label>
        <label className={styles.materialCheck}><input type="checkbox" checked={includeNotes} onChange={event => setNotes(event.target.checked)} />纳入本范围的个人笔记</label>
        <label className={styles.materialCheck}><input type="checkbox" checked={includeSupplements} onChange={event => setSupplements(event.target.checked)} />允许本范围的材料外补充解释</label>
        <p className={styles.muted}>勾选补充后，可读取本范围已保存的补充，并在本次解释中提供明确标注的材料外补充。解释保存在本任务中，不自动写入个人笔记。不联网寻找新材料。</p>
        <button type="button" className={styles.primary} disabled={!goal.trim() || !hasScope} onClick={() => void start()}>明确开始复习</button>
      </fieldset>
      {pendingStart.current ? <button type="button" disabled={busy} onClick={() => void start()}>核对本次任务是否已开始</button> : null}
      {task ? <button type="button" disabled={busy || Boolean(pendingStart.current)} onClick={() => setCreating(false)}>返回当前任务</button> : null}
    </div> : task ? <div className={styles.agentPanel}>
      {tasks.length > 1 ? <label>已保存任务<select value={task.id} disabled={interactionLocked || Boolean(editing)} onChange={event => selectTask(event.target.value)}>{tasks.map(item => <option key={item.id} value={item.id}>{item.goal} · {statusLabels[item.status]}</option>)}</select></label> : null}
      <h3>{task.goal}</h3><p role="status">{statusLabels[task.status]}{task.currentAction ? ` · ${actionLabels[task.currentAction] ?? task.currentAction}` : ""}</p>
      <p className={styles.muted}>本轮版本 {task.version ?? 1}</p>
      {pendingAdvance?.id === task.id ? <p role="status">反馈已受理，正在读取任务进度…</p> : null}
      <p>固定范围：{scopeDescription(task.scope)}</p><p className={styles.muted}>相关历史：{task.scope.includeHistory ? "允许" : "不读取"} · 个人笔记：{task.scope.includeNotes ? "已纳入" : "未纳入"} · 材料外补充：{task.scope.includeSupplements ? "已纳入" : "未纳入"}</p>
      {task.budget ? <p className={styles.agentBudget}>本任务预算：调用 {task.usage?.calls ?? "未知"}/{task.budget.maxCalls} 次，决策 {task.usage?.steps ?? "未知"}/{task.budget.maxSteps} 步，计算 {task.usage ? Math.ceil(task.usage.computeMs / 1000) : "未知"}/{Math.ceil(task.budget.maxComputeMs / 1000)} 秒{task.usage?.computeEstimated ? "（含崩溃后保守估算）" : ""}。调整目标与范围不重置已用预算；等待时间不计入计算时间。</p> : null}
      {task.wait ? <p className={styles.frameworkNote}>{task.wait.message}</p> : null}
      {task.endReason ? <p>{task.endReason}</p> : null}
      {!terminal.has(task.status) && !editing ? <button type="button" disabled={interactionLocked} onClick={() => setEditing(task.id)}>调整本轮复习</button> : null}
      {editing === task.id ? <LearningAgentAdjustmentForm key={task.id} task={task} materials={materials} chapters={chapters} disabled={interactionLocked}
        onSubmit={adjust} onRefresh={() => void load()} onClose={() => setEditing(null)} /> : null}
      {task.recovery && !terminal.has(task.status) ? <section aria-label="处理任务中断" className={styles.agentRecovery}>
        <h4>{({ unknown: "结果未知，先核对原操作", known_failed: "上次操作明确失败", not_started: "上次操作尚未开始", succeeded: "原操作已有结果", source_invalid: "来源已变化，需要重新确认", version_changed: "任务版本已变化", interrupted: "执行已中断" })[task.recovery.kind]}</h4>
        <p>{task.recovery.message}</p>
        <div className={styles.row}>
          {task.recovery.allowedControls.includes("inspect") ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => recover("inspect")}>核对原操作结果</button> : null}
          {task.recovery.allowedControls.includes("retry") && task.recovery.kind !== "unknown" ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => recover("retry")}>{task.recovery.kind === "known_failed" ? "重试明确失败的操作" : task.recovery.kind === "not_started" ? "执行尚未开始的操作" : "继续已核对的操作"}</button> : null}
          {task.recovery.allowedControls.includes("adjust") ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => setEditing(task.id)}>重新确认本轮范围</button> : null}
          <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={end}>结束并交回本轮复习</button>
        </div>
        {task.recovery.kind === "unknown" ? <p className={styles.muted}>未知不等于失败。核对不会重新发送原生成请求，不能用重试猜测结果。</p> : null}
      </section> : null}
      {approvalWaiting ? <section aria-label="待确认笔记" className={styles.agentApproval}><h4>{task.approval!.title}</h4><p>{task.approval!.summary}</p>
        <p>追加目标：{task.approval!.target}</p><p className={styles.muted}>下面是将准确追加的内容；不会覆盖原笔记。普通读取与练习不需要这项确认。</p>
        <div className={styles.frameworkNote}><p className={styles.original}>{task.approval!.content}</p></div>
        <p>材料外补充：{task.approval!.includesSupplement ? "包含，已明确标注" : "不包含"}。</p>
        {task.approval!.sources?.length ? <div className={styles.sources}>{task.approval!.sources.map((source, index) => <button key={index} type="button" onClick={() => onSource(source.materialId, source.parsed?.physicalPage ?? source.paragraph, source.parsed)}>查看笔记引用原文 {index + 1}</button>)}</div> : null}
        <div className={styles.row}><button type="button" className={styles.primary} disabled={interactionLocked || Boolean(editing) || task.status !== "waiting"} onClick={() => approvalDecision("approve")}>批准追加到个人笔记</button>
          <button type="button" disabled={interactionLocked || Boolean(editing) || task.status !== "waiting"} onClick={() => approvalDecision("reject")}>拒绝这项笔记提议</button></div>
        <p className={styles.muted}>本次确认仅适用于当前目标、范围、来源、笔记位置和版本。关闭页面不会批准；修改范围或来源变化后旧确认失效。</p>
      </section> : null}
      {quizLinks.length ? <div className={styles.row}>{quizLinks.map((link, index) => <button type="button" key={link.quizId} disabled={Boolean(editing)} onClick={() => { selectTask(task.id); onQuiz(link.quizId); }}>打开题组 {index + 1}</button>)}</div> : null}
      {task.explanations?.map((explanation, index) => <details key={explanation.id} className={styles.agentExplanation} open><summary>任务内解释 {index + 1}</summary><p className={styles.original}>{explanation.text}</p>
        {explanation.sources?.length ? <div className={styles.sources}>{explanation.sources.map((source, i) => <button key={i} type="button" onClick={() => onSource(source.materialId, source.parsed?.physicalPage ?? source.paragraph, source.parsed)}>查看引用原文 {i + 1}</button>)}</div> : null}</details>)}
      {!terminal.has(task.status) ? <div className={styles.row}>
        {task.status === "paused" || task.status === "ready" ? <button type="button" disabled={interactionLocked || Boolean(editing)} onClick={() => void control("resume")}>继续任务</button> : task.status !== "needs_attention" ? <button type="button" disabled={busy || Boolean(pendingControl.current) || Boolean(editing)} onClick={() => void control("pause")}>暂停任务</button> : null}
        <button type="button" className={styles.danger} disabled={busy || Boolean(pendingControl.current) || Boolean(editing)} onClick={() => void control("cancel")}>取消任务</button>
      </div> : null}
      {task.status === "waiting" && waitingQuiz && !editing ? <div className={styles.agentFeedback}><p>先在原有 Quiz 中完成作答，再读取已保存结果继续。等待期间不会调用模型。</p>
        <button type="button" className={styles.primary} disabled={busy || !attemptId || Boolean(pendingControl.current) || pendingAdvance?.id === task.id} onClick={() => void control("feedback", attemptId ?? undefined)}>已完成作答，继续复习</button>
        {!attemptId ? <p className={styles.muted}>打开题组开始作答；回到这里后可刷新任务。</p> : null}
        <label>这道题有疑问<textarea rows={2} maxLength={1000} value={feedback} disabled={busy || Boolean(pendingControl.current) || pendingAdvance?.id === task.id} onChange={event => setFeedback(event.target.value)} placeholder="说明有疑问的题目或依据，先停止用这组题判断薄弱点。" /></label>
        <button type="button" disabled={busy || !attemptId || !feedback.trim() || Boolean(pendingControl.current) || pendingAdvance?.id === task.id} onClick={() => void control("feedback", attemptId, true)}>提交疑问并继续</button>
        <p className={styles.muted}>提交后暂停用这组题判断薄弱点，已有答案与成绩保持原样。</p></div> : null}
      {task.status === "waiting" && !waitingQuiz && !approvalWaiting && task.wait?.kind !== "confirmation" && !editing ? <div className={styles.agentFeedback}><label>你的反馈<textarea rows={3} maxLength={1000} value={feedback} disabled={busy || Boolean(pendingControl.current) || pendingAdvance?.id === task.id} onChange={event => setFeedback(event.target.value)} placeholder="例如：这个解释有帮助，我想练习一下；或说明仍不明白的地方。" /></label>
        <button type="button" className={styles.primary} disabled={busy || !feedback.trim() || Boolean(pendingControl.current) || pendingAdvance?.id === task.id} onClick={() => void control("feedback")}>提交反馈并继续</button></div> : null}
      {pendingControl.current ? <button type="button" disabled={busy} onClick={() => void work(() => submitControl(pendingControl.current!))}>核对本次任务操作</button> : null}
      <details className={styles.agentLog}><summary>行动记录 · {task.actions.length} 次</summary>{task.actions.length ? <ol>{task.actions.map(action => <li key={action.id}><strong>{actionLabels[action.tool] ?? action.tool}</strong><span> · {actionStatusLabels[action.status] ?? action.status}</span><p>{action.summary}</p>{action.reason ? <p className={styles.muted}>行动理由：{action.reason}</p> : null}{action.resultRef ? <small>结果 ID：{action.resultRef.id}</small> : null}</li>)}</ol> : <p>尚无已记录行动。</p>}</details>
      {task.usage ? <p className={styles.muted}>模型请求：{task.usage.calls}；输入 tokens：{task.usage.inputTokens ?? "未知"}；输出 tokens：{task.usage.outputTokens ?? "未知"}{task.usage.unknownUsageCalls ? `；${task.usage.unknownUsageCalls} 次用量未知` : ""}。未提供价格时不估算金额。</p> : null}
    </div> : null}
  </section>;
}
