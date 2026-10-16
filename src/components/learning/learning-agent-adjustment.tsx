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
  const correctingSources = Boolean(draft.sourceCorrections);
  const sourceKey = (source: { materialId: string; paragraph: number }) => `${source.materialId}:${source.paragraph}`;
  const sourceLabel = (source: { materialId: string; paragraph: number }) => `${materials.find(material => material.id === source.materialId)?.title ?? "已不可用的材料"} · 第 ${source.paragraph} 段`;
  const stale = (task.version ?? 1) !== before.expectedVersion;
  useLearningUnsaved(draft.goal !== before.goal || JSON.stringify(draft.scope) !== JSON.stringify(before.scope) || correctingSources);
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
    {correctingSources ? <ul>{task.sourceAdjustment?.objectives.map(objective => <li key={objective.id}>
      {objective.label}：{(value.sourceCorrections?.find(item => item.objectiveId === objective.id)?.sources ?? objective.currentSources).map(sourceLabel).join("、") || "尚未选择来源"}
    </li>)}</ul> : null}
  </>;
  const invalidCorrections = correctingSources && (!task.sourceAdjustment || Boolean(draft.sourceCorrections?.some(item => !item.sources.length)));
  const toggleSource = (objectiveId: string, source: { materialId: string; paragraph: number }) => {
    setDraft(value => ({ ...value, sourceCorrections: value.sourceCorrections?.map(item => item.objectiveId !== objectiveId ? item : {
      ...item, sources: item.sources.some(existing => sourceKey(existing) === sourceKey(source))
        ? item.sources.filter(existing => sourceKey(existing) !== sourceKey(source)) : [...item.sources, source],
    }) })); setPreview(false);
  };
  const missing = (field: "materialIds" | "chapterIds" | "nodeIds", available: Array<{ id: string }>) => draft.scope[field].filter(id => !available.some(item => item.id === id)).map(id => <label className={styles.materialCheck} key={id}><input type="checkbox" checked onChange={() => toggle(field, id)} />已不可用的来源（取消勾选以撤销授权）</label>);
  return <section className={styles.agentAdjustment} aria-label="调整本轮复习">
    <h3>调整本轮复习</h3>
    <p className={styles.muted}>只调整当前学习页内的内容。确认后会按新目标和范围继续；历史练习与作答保留，待保存的笔记需要重新确认。</p>
    {stale ? <div role="alert" className={styles.error}><p>本轮复习已在其他地方更新。请先核对最新目标和范围，再提交你的调整。</p><details><summary>查看当前目标和范围</summary>{summary(snapshot(task))}</details>
      <button type="button" disabled={disabled} onClick={() => { const latest = snapshot(task); setBefore(latest); setDraft(value => ({ ...value, expectedVersion: latest.expectedVersion, sourceCorrections: undefined })); setPreview(false); }}>按最新内容重新比对</button></div> : null}
    <fieldset disabled={disabled} className={styles.quizSettings}><legend>修改目标与授权</legend>
      {task.sourceAdjustment ? <label className={styles.materialCheck}><input type="checkbox" checked={correctingSources} onChange={event => {
        const checked = event.target.checked;
        setDraft(value => ({ ...value, ...(checked ? { goal: before.goal } : {}), sourceCorrections: checked
          ? task.sourceAdjustment!.objectives.map(objective => ({ objectiveId: objective.id, sources: [...objective.currentSources] })) : undefined })); setPreview(false);
      }} />保持目标与检查要求，仅核对来源关联</label> : null}
      <label>新的复习目标<textarea rows={3} maxLength={2000} readOnly={correctingSources} value={draft.goal} onChange={event => { setDraft(value => ({ ...value, goal: event.target.value })); setPreview(false); }} /></label>
      {correctingSources && task.sourceAdjustment ? <section aria-label="核对目标与来源">
        <p>逐项目标核对相关原文并明确选择。确认后建立新版本，目标和检查要求不变；原计划、讲解、题组和成绩保留。段落关联仍需你结合内容核对，不代表系统已核验语义。</p>
        {task.sourceAdjustment.omitted ? <p className={styles.muted}>这里只列出当前可预览的授权原文；如未找到所需段落，请取消来源核对并缩小范围后再查看，不必选择无关原文。</p> : null}
        {task.sourceAdjustment.objectives.map(objective => <fieldset key={objective.id}><legend>{objective.label}</legend>
          <p>原来源：{objective.currentSources.map(sourceLabel).join("、")}</p>
          {task.sourceAdjustment!.sources.map(source => <div key={sourceKey(source)}>
            <label className={styles.materialCheck}><input type="checkbox"
              checked={Boolean(draft.sourceCorrections?.find(item => item.objectiveId === objective.id)?.sources.some(selected => sourceKey(selected) === sourceKey(source)))}
              onChange={() => toggleSource(objective.id, { materialId: source.materialId, paragraph: source.paragraph })} />{sourceLabel(source)}</label>
            <details><summary>查看原文：{sourceLabel(source)}</summary><p>{source.text}</p></details>
          </div>)}
        </fieldset>)}
        <p className={styles.muted}>如需重新关联原题作答，请明确勾选下方相关历史权限；系统不会因此重算旧成绩，也不会自动认定通过。</p>
      </section> : null}
      <fieldset><legend>本页材料</legend>{materials.map(material => <label className={styles.materialCheck} key={material.id}><input type="checkbox" checked={draft.scope.materialIds.includes(material.id)} onChange={() => toggle("materialIds", material.id)} />{material.title}</label>)}{missing("materialIds", materials)}</fieldset>
      <fieldset><legend>本页章节</legend>{chapters.map(chapter => <label className={styles.materialCheck} key={chapter.id}><input type="checkbox" checked={draft.scope.chapterIds.includes(chapter.id)} onChange={() => toggle("chapterIds", chapter.id)} />{chapter.title}</label>)}{missing("chapterIds", chapters)}{!chapters.length ? <p>当前没有可选章节。</p> : null}</fieldset>
      <fieldset><legend>本页知识点</legend>{nodes.map(node => <label className={styles.materialCheck} key={node.id}><input type="checkbox" checked={draft.scope.nodeIds.includes(node.id)} onChange={() => toggle("nodeIds", node.id)} />{node.title}</label>)}{missing("nodeIds", nodes)}{!nodes.length ? <p>当前没有可选知识点。</p> : null}</fieldset>
      <p className={styles.muted}>勾选材料授权其可用正文；只勾选章节或知识点时仅授权绑定原文。合并勾选不会缩小已勾选材料的范围。</p>
      <label className={styles.materialCheck}><input type="checkbox" checked={draft.scope.includeHistory} onChange={event => changeScope({ includeHistory: event.target.checked })} />允许读取本范围的相关作答历史</label>
      <label className={styles.materialCheck}><input type="checkbox" checked={draft.scope.includeNotes} onChange={event => changeScope({ includeNotes: event.target.checked })} />纳入本范围的个人笔记</label>
      <label className={styles.materialCheck}><input type="checkbox" checked={draft.scope.includeSupplements} onChange={event => changeScope({ includeSupplements: event.target.checked })} />允许本范围的材料外补充解释</label>
      <p className={styles.muted}>取消勾选后，后续复习不再使用对应内容；已保存的练习和笔记会保留。允许读取笔记不会自动保存新笔记，保存前仍会请你确认。</p>
      <button type="button" disabled={!draft.goal.trim() || !draft.scope.materialIds.length && !draft.scope.chapterIds.length && !draft.scope.nodeIds.length || stale || invalidCorrections} onClick={() => setPreview(true)}>预览本轮调整</button>
    </fieldset>
    {preview ? <section aria-label="调整前后预览" className={styles.agentChangePreview}><h4>调整前后预览</h4><div><section aria-label="调整前"><h4>调整前</h4>{summary(before)}</section><section aria-label="调整后"><h4>调整后</h4>{summary(draft)}</section></div>
      <p>{correctingSources ? "确认后建立新版本并重新读取所选原文。仅更正来源关联，保留既定目标和检查要求；原计划、讲解、题组和成绩保留。" : "确认后，将根据新的目标和范围继续复习。"}</p>
      <button type="button" className={styles.primary} disabled={disabled || stale || invalidCorrections} onClick={() => onSubmit({ ...draft, goal: draft.goal.trim() })}>确认调整本轮复习</button></section> : null}
    <div className={styles.row}><button type="button" disabled={disabled} onClick={onRefresh}>刷新并保留草稿</button><button type="button" disabled={disabled} onClick={onClose}>取消本次调整</button></div>
  </section>;
}
