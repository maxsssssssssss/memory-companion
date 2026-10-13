"use client";

import { useState } from "react";
import type { LearningMaterial } from "@/lib/domain/learning";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import type { LearningAgentAdjustment, LearningAgentScope, LearningAgentTaskView } from "@/lib/client/learning-agent-api";
import { useLearningUnsaved } from "./use-learning-unsaved";
import styles from "./learning.module.css";

function snapshot(task: LearningAgentTaskView): LearningAgentAdjustment {
  return { goal: task.goal, scope: structuredClone(task.scope), expectedVersion: task.version ?? 1 };
}

export function LearningAgentAdjustmentForm({ task, materials, chapters, disabled, onSubmit, onRefresh, onClose }: {
  task: LearningAgentTaskView; materials: LearningMaterial[]; chapters: FrameworkChapter[]; disabled: boolean;
  onSubmit: (value: LearningAgentAdjustment) => void; onRefresh: () => void; onClose: () => void;
}) {
  const [before, setBefore] = useState(() => snapshot(task));
  const [draft, setDraft] = useState(() => snapshot(task));
  const [preview, setPreview] = useState(false);
  const stale = (task.version ?? 1) !== before.expectedVersion;
  useLearningUnsaved(draft.goal !== before.goal || JSON.stringify(draft.scope) !== JSON.stringify(before.scope));
  const changeScope = (update: Partial<LearningAgentScope>) => { setDraft(value => ({ ...value, scope: { ...value.scope, ...update } })); setPreview(false); };
  const toggle = (field: "materialIds" | "chapterIds" | "nodeIds", id: string) => changeScope({ [field]: draft.scope[field].includes(id) ? draft.scope[field].filter(value => value !== id) : [...draft.scope[field], id] });
  const nodes = chapters.flatMap(chapter => chapter.nodes);
  const label = (field: "materialIds" | "chapterIds" | "nodeIds", id: string) => (field === "materialIds" ? materials : field === "chapterIds" ? chapters : nodes).find(item => item.id === id)?.title ?? "已不可用的来源";
  const summary = (value: LearningAgentAdjustment) => <>
    <p>目标：{value.goal}</p>
    <p>材料：{value.scope.materialIds.map(id => label("materialIds", id)).join("、") || "无"}</p>
    <p>章节：{value.scope.chapterIds.map(id => label("chapterIds", id)).join("、") || "无"}</p>
    <p>知识点：{value.scope.nodeIds.map(id => label("nodeIds", id)).join("、") || "无"}</p>
    <p>相关历史：{value.scope.includeHistory ? "允许" : "不读取"}；个人笔记：{value.scope.includeNotes ? "已纳入" : "未纳入"}；材料外补充：{value.scope.includeSupplements ? "允许" : "不允许"}。</p>
  </>;
  const missing = (field: "materialIds" | "chapterIds" | "nodeIds", available: Array<{ id: string }>) => draft.scope[field].filter(id => !available.some(item => item.id === id)).map(id => <label className={styles.materialCheck} key={id}><input type="checkbox" checked onChange={() => toggle(field, id)} />已不可用的来源（取消勾选以撤销授权）</label>);
  return <section className={styles.agentAdjustment} aria-label="调整本轮复习">
    <h3>调整本轮复习</h3>
    <p className={styles.muted}>只调整这个学习页。新选择需再次确认；已用预算累计，历史题组和作答不改写。旧等待与未执行的笔记确认将失效。</p>
    {stale ? <div role="alert" className={styles.error}><p>本轮已更新到版本 {task.version}，编辑草稿仍基于版本 {before.expectedVersion}。先比对最新目标和范围。</p><details><summary>查看服务器当前版本</summary>{summary(snapshot(task))}</details>
      <button type="button" disabled={disabled} onClick={() => { const latest = snapshot(task); setBefore(latest); setDraft(value => ({ ...value, expectedVersion: latest.expectedVersion })); setPreview(false); }}>按最新版本重新比对</button></div> : null}
    <fieldset disabled={disabled} className={styles.quizSettings}><legend>修改目标与授权</legend>
      <label>新的复习目标<textarea rows={3} maxLength={2000} value={draft.goal} onChange={event => { setDraft(value => ({ ...value, goal: event.target.value })); setPreview(false); }} /></label>
      <fieldset><legend>本页材料</legend>{materials.map(material => <label className={styles.materialCheck} key={material.id}><input type="checkbox" checked={draft.scope.materialIds.includes(material.id)} onChange={() => toggle("materialIds", material.id)} />{material.title}</label>)}{missing("materialIds", materials)}</fieldset>
      <fieldset><legend>本页章节</legend>{chapters.map(chapter => <label className={styles.materialCheck} key={chapter.id}><input type="checkbox" checked={draft.scope.chapterIds.includes(chapter.id)} onChange={() => toggle("chapterIds", chapter.id)} />{chapter.title}</label>)}{missing("chapterIds", chapters)}{!chapters.length ? <p>当前没有可选章节。</p> : null}</fieldset>
      <fieldset><legend>本页知识点</legend>{nodes.map(node => <label className={styles.materialCheck} key={node.id}><input type="checkbox" checked={draft.scope.nodeIds.includes(node.id)} onChange={() => toggle("nodeIds", node.id)} />{node.title}</label>)}{missing("nodeIds", nodes)}{!nodes.length ? <p>当前没有可选知识点。</p> : null}</fieldset>
      <p className={styles.muted}>勾选材料授权其可用正文；只勾选章节或知识点时仅授权绑定原文。合并勾选不会缩小已勾选材料的范围。</p>
      <label className={styles.materialCheck}><input type="checkbox" checked={draft.scope.includeHistory} onChange={event => changeScope({ includeHistory: event.target.checked })} />允许读取本范围的相关作答历史</label>
      <label className={styles.materialCheck}><input type="checkbox" checked={draft.scope.includeNotes} onChange={event => changeScope({ includeNotes: event.target.checked })} />纳入本范围的个人笔记</label>
      <label className={styles.materialCheck}><input type="checkbox" checked={draft.scope.includeSupplements} onChange={event => changeScope({ includeSupplements: event.target.checked })} />允许本范围的材料外补充解释</label>
      <p className={styles.muted}>撤销后下一步不再读取对应内容；已保存业务记录保留。读取个人笔记的授权不等于写入授权，每项新增笔记仍需单独确认。</p>
      <button type="button" disabled={!draft.goal.trim() || !draft.scope.materialIds.length && !draft.scope.chapterIds.length && !draft.scope.nodeIds.length || stale} onClick={() => setPreview(true)}>预览本轮调整</button>
    </fieldset>
    {preview ? <section aria-label="调整前后预览" className={styles.agentChangePreview}><h4>调整前后预览</h4><div><section aria-label="调整前"><h4>调整前 · 版本 {before.expectedVersion}</h4>{summary(before)}</section><section aria-label="调整后"><h4>调整后</h4>{summary(draft)}</section></div>
      <p>确认后开始新的任务版本，重新检查来源并选择下一步；不会重置本任务已用调用、计算时间和步数。</p>
      <button type="button" className={styles.primary} disabled={disabled || stale} onClick={() => onSubmit({ ...draft, goal: draft.goal.trim() })}>确认调整本轮复习</button></section> : null}
    <div className={styles.row}><button type="button" disabled={disabled} onClick={onRefresh}>刷新并保留草稿</button><button type="button" disabled={disabled} onClick={onClose}>取消本次调整</button></div>
  </section>;
}
