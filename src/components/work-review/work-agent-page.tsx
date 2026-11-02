"use client";

import Link from "next/link";
import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";
import {ProductDialog,ProductEvidence,ProductState} from "@/components/product-system/product-primitives";
import type {WorkAgentProjectView,WorkAgentSource,WorkAgentTaskView} from "@/lib/domain/work-agent";
import styles from "./work-review.module.css";
import local from "./work-agent.module.css";
import {WorkPreparationPanel} from "./work-preparation-panel";

const categories={added:"新增事项",changed:"变化与关联建议",resolved:"建议关闭的问题",unresolved:"尚未解决",uncertain:"待核实 / 缺少后续记录"};
const states={open:"未关闭",active:"当前有效",suspended:"已暂停",withdrawn:"已撤回",resolved:"已解决",unknown:"待核实"};
const labels={ready:"准备中",running:"正在比较",waiting:"等待你的选择",paused:"已暂停",cancelled:"已取消",ended:"本轮已结束",needs_attention:"需要处理",budget_exhausted:"已达本轮执行上限"};
const attentionStates={open:"待办未完成",waiting:"等待他人",unresolved:"问题未解决",no_follow_up:"缺少后续记录",needs_review:"需要核实",source_invalid:"依据失效",suggestion:"Agent 建议，待确认"};
const bases={record:"记录事实",confirmed_relation:"已确认关系",needs_verification:"需用户核实",agent_suggestion:"Agent 关联建议"};
const key=()=>crypto.randomUUID();
async function request<T>(url:string,method="GET",body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method,credentials:"same-origin",cache:"no-store",signal,
    ...(body===undefined?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
  if(!response.ok)throw new Error(response.status===409?"会议、待办或任务状态已变化。请刷新并重新核对预览。":response.status===404?"项目或来源不可用，请返回会议核对项目关联。":"暂时无法完成操作，请刷新核对结果后重试。");
  return response.json() as Promise<T>;
}
function readable(value:string){
  try{const fields=JSON.parse(value) as Record<string,unknown>;return Object.entries(fields).filter(([k])=>k!=="version").map(([k,v])=>`${({title:"内容",status:"状态",owner:"负责人",due:"期限",kind:"归属"} as Record<string,string>)[k]??k}：${v==="open"?"未完成":v==="completed"?"已完成":v==="self"?"我的待办":v==="waiting_for_other"?"等待他人":v??"未设置"}`).join("；");}catch{return value;}
}
function TaskResult({view,busy,onControl,onSource,onContinue}:{view:WorkAgentTaskView;busy:boolean;onControl:(body:Record<string,unknown>)=>Promise<void>;onSource:(id:string)=>void;onContinue:()=>void}){
  const {task,artifact}=view,preview=artifact?.preview;
  const [selected,setSelected]=useState<string[]>(()=>preview?.selectedKeys ?? []);
  const [feedback,setFeedback]=useState("");
  const [confirming,setConfirming]=useState(false);
  const send=(body:Record<string,unknown>)=>onControl({id:task.id,eventId:key(),expectedVersion:task.version??1,...body});
  const canSelect=task.status==="waiting"&&task.wait?.kind==="work_selection"&&preview&&!preview.selectedKeys;
  const eligibleKeys=preview?.changes.filter(c=>c.review?.status==="confirmable").map(c=>c.change.key)??[];
  const canApprove=preview?.selectedKeys?.every(k=>eligibleKeys.includes(k))??false;
  return <article className={local.result} aria-label="会后比较结果">
    <header><h2>{task.goal}</h2><p role="status">{labels[task.status]}</p></header>
    {artifact?.coverage?<p className={local.notice}>{artifact.coverage.notice}</p>:null}
    {task.endReason?<p>{task.endReason}</p>:null}
    {artifact?.comparison?Object.entries(categories).map(([category,title])=>{
      const items=artifact.comparison!.items.filter(i=>i.category===category);
      return items.length?<section key={category}><h3>{title}</h3><ul>{items.map((item,i)=><li key={i}>
        <p><small>{item.status==="confirmed_fact"?"会议已确认事实":item.status==="suggestion"?artifact.applied?"比较建议（采用情况见下方）":"关联建议，待确认":"待核实"}</small> · {item.text}</p>
        <div className={local.actions}>{item.sourceFindingIds.map((id,index)=><button type="button" className={styles.sourceButton} key={id} onClick={()=>onSource(id)}>查看原文 {index+1}</button>)}</div>
      </li>)}</ul></section>:null;
    }):null}
    {artifact?.applied?<ProductState title={`已保存 ${artifact.applied.selectedKeys.length} 项，未采用 ${artifact.applied.rejectedKeys.length} 项`} description="操作结果已持久保存。待办后续变化以待办页当前状态为准。" tone="empty"/>:null}
    {preview&&artifact?.state!=="invalidated"?<section><h3>修改预览</h3><p>逐项核对旧状态与新状态。只有选中并最终确认的修改会保存。</p>
      <p>只允许选择可确认的建议。有限规则检查不等于语义已验证，仍需核对原文；被阻止或待核实的建议需调整后重新比较。</p>
      {canSelect?<div className={local.actions}>
        <button type="button" disabled={busy} className={styles.secondaryButton} onClick={()=>setSelected(eligibleKeys)}>选中全部</button>
        <button type="button" disabled={busy} className={styles.secondaryButton} onClick={()=>setSelected([])}>全部不采用</button>
      </div>:null}
      <ul className={local.preview}>{preview.changes.map(({change,before,after,review})=><li key={change.key}>
        <label><input type="checkbox" disabled={!canSelect||busy||review?.status!=="confirmable"} checked={(preview.selectedKeys??selected).includes(change.key)} onChange={e=>setSelected(current=>e.target.checked?[...current,change.key]:current.filter(k=>k!==change.key))}/><strong>{change.label}</strong></label>
        {review?<p><strong>{review.status==="blocked"?"已阻止":review.status==="needs_review"?"待核实，暂不能批准":artifact.applied?artifact.applied.selectedKeys.includes(change.key)?"已确认并保存":"未采用":"待用户确认"}</strong> · {review.status==="confirmable"&&artifact.applied?"以上为当时的固定预览，当前待办状态以待办页为准。":review.reason}</p>:null}
        <dl><div><dt>旧状态</dt><dd>{readable(before)}</dd></div><div><dt>新状态</dt><dd>{readable(after)}</dd></div></dl>
        <div className={local.actions}>{change.sourceFindingIds.map((id,index)=><button className={styles.sourceButton} type="button" key={id} onClick={()=>onSource(id)}>核对依据 {index+1}</button>)}</div>
        {review?.sourceFindingIds.filter(id=>!change.sourceFindingIds.includes(id)).map(id=><button className={styles.sourceButton} type="button" key={id} onClick={()=>onSource(id)}>查看冲突依据</button>)}
      </li>)}</ul>
      {canSelect?<button className={styles.primaryButton} type="button" disabled={busy} onClick={()=>void send({action:"select",selection:{previewId:preview.id,fingerprint:preview.fingerprint,keys:selected}})}>核对选中的 {selected.length} 项修改</button>:null}
    </section>:null}
    {task.status==="ended"&&artifact?.comparison&&!artifact.applied?<button type="button" className={styles.secondaryButton} disabled={busy} onClick={onContinue}>选择并保存这次比较的后续工作</button>:null}
    {task.approval?.status==="pending"&&task.status==="waiting"?<div className={local.actions}>
      {!canApprove?<p>已选建议存在矛盾或仍待核实，不能保存。请拒绝本次修改并调整建议。</p>:null}
      <button type="button" className={styles.primaryButton} disabled={busy||!canApprove} onClick={()=>setConfirming(true)}>确认保存选中的修改</button>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>void send({action:"approval",approvalId:task.approval!.id,fingerprint:task.approval!.fingerprint,decision:"reject"})}>拒绝这次修改</button>
    </div>:null}
    {task.wait?.kind==="feedback"?<form onSubmit={e=>{e.preventDefault();void send({action:"feedback",message:feedback});}}>
      <label>{task.wait.message}<textarea value={feedback} onChange={e=>setFeedback(e.target.value)} required maxLength={2000}/></label><button disabled={busy} type="submit">回复</button>
    </form>:null}
    <div className={local.actions}>
      {["running","ready"].includes(task.status)?<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>void send({action:"pause"})}>暂停</button>:null}
      {task.status==="paused"||(task.status==="ready"&&task.recovery)?<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>void send({action:"resume"})}>继续原任务</button>:null}
      {task.recovery?.allowedControls.includes("inspect")||task.status==="running"?<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>void send({action:"recover",mode:"inspect"})}>检查原操作结果</button>:null}
      {task.recovery?.allowedControls.includes("retry")?<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>void send({action:"recover",mode:"retry"})}>重试已确认未成功的操作</button>:null}
      {!["ended","cancelled"].includes(task.status)?<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>void send({action:"cancel"})}>取消本轮</button>:null}
    </div>
    <ProductDialog open={confirming&&!!task.approval} title="保存固定预览" onClose={()=>setConfirming(false)} footer={<div className={local.actions}>
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>setConfirming(false)}>返回核对</button>
      <button type="button" className={styles.primaryButton} disabled={busy||!canApprove} onClick={()=>void send({action:"approval",approvalId:task.approval!.id,fingerprint:task.approval!.fingerprint,decision:"approve"}).then(()=>setConfirming(false))}>确认保存 {preview?.selectedKeys?.length??0} 项</button>
    </div>}><p>将保存以上固定预览中选中的关系与待办修改，未选中的建议保持不变。</p></ProductDialog>
  </article>;
}
function ProjectFacts({data,busy,onSource,onRetract,onTask}:{data:WorkAgentProjectView;busy:boolean;onSource:(id:string)=>void;onRetract:(id:string)=>void;onTask:(id:string)=>void}){
  const [filter,setFilter]=useState("all");
  const items=data.openLoops.filter(item=>filter==="all"||filter==="waiting"&&(item.status==="waiting"||item.waitingForOther)||filter==="review"&&["needs_review","source_invalid","suggestion","no_follow_up"].includes(item.status));
  return <>
    <nav className={local.actions} aria-label="项目事实导航"><a href="#work-timeline">决策时间线</a><a href="#work-radar">未闭环事项雷达</a><a href="#work-comparisons">会后比较与确认</a></nav>
    <section id="work-timeline" aria-labelledby="work-timeline-title"><h2 id="work-timeline-title">决策时间线</h2>
      <p>只有已确认关系会改变项目当前状态。提议保留为候选，历史会议事实不被改写。</p>
      {!data.threads.length?<ProductState title="尚未建立持续关系" description="下方可查看已有的已确认会议事实。记录不足以还原完整变化过程，不推定哪个历史决定仍然有效。" tone="empty"/>:data.threads.map(thread=>{
        const current=thread.events.flatMap(e=>e.sources).find(s=>s.findingId===thread.currentFindingId);
        return <article className={local.thread} key={thread.id}><h3>{thread.title} · {thread.kind==="work"&&thread.state==="open"?"工作记录":thread.kind==="question"&&thread.state==="open"?"问题未解决":states[thread.state]}</h3>
          {current?<p>当前决定：{current.body}</p>:null}
          {thread.state==="unknown"?<p>依据失效或关联已撤回；不会自动恢复旧决定。</p>:null}
          {thread.linkedTodos.map(todo=><p key={todo.id}>关联待办：{todo.title} · {todo.status==="completed"?"已完成":"未完成"}</p>)}
          {thread.kind==="question"&&thread.state==="open"&&thread.linkedTodos.some(t=>t.status==="completed")?<p>关联待办已完成，独立问题仍未解决；需要明确的解决依据和确认关系。</p>:null}
        </article>;
      })}
      {!data.timeline.length?<ProductState title="还没有可展示的历史" description="关联会议并确认结果后，这里会显示会议事实与已保存的关系。" tone="empty"/>:
      <details className={local.historyDetails}><summary>查看历史与来源（{data.timeline.length} 条）</summary>
        <p className={local.notice}>按会议日期展示；同日记录的排列不表示已确认先后。未建立关系的事实不代表当前仍有效。撤回错误关联按操作日期保留。</p>
        <ol className={local.timeline}>{data.timeline.map(item=><li key={item.id}>
          <details><summary><time>{item.date}</time> · {item.label} · {item.title}{item.status==="source_invalid"?" · 依据失效":null}</summary>
            <p>{item.text}</p>
            <div className={local.actions}>{item.sources.map(source=><button type="button" className={styles.sourceButton} key={source.findingId} onClick={()=>onSource(source.findingId)}>查看原文 · {source.meetingTitle} · {source.meetingDate}</button>)}</div>
            {item.canRetract&&item.eventId?<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>onRetract(item.eventId!)}>撤回错误关联</button>:null}
          </details>
        </li>)}</ol>
      </details>}
    </section>
    <section id="work-radar" aria-labelledby="work-radar-title"><h2 id="work-radar-title">未闭环事项雷达</h2>
      <p>依据当前项目的已确认记录。没有后续记录不证明现实中未处理；待办完成与独立问题解决分别判断。</p>
      <div className={local.actions} aria-label="筛选未闭环事项">{[["all","全部"],["waiting","等待他人"],["review","需要核实或确认"]].map(([value,label])=><button type="button" key={value} className={styles.secondaryButton} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div>
      {!items.length?<ProductState title={data.openLoops.length?"此分类暂无事项":"暂未发现需要关注的记录"} description="这只反映项目中已记录的状态，不代表现实中所有工作均已完成。" tone="empty"/>:
      <ul className={local.radar}>{items.map(item=><li key={item.id}><details>
        <summary><strong>{item.title}</strong> · {attentionStates[item.status]}{item.waitingForOther?" · 含等待他人事项":""} <small>（{bases[item.basis]}）</small></summary>
        <p>{item.text}</p><ul>{item.reasons.map((reason,i)=><li key={i}>{reason}</li>)}</ul>
        {item.linkedTodos.map(todo=><p key={todo.id}>关联待办：{todo.title} · {todo.status==="completed"?"已完成":"未完成"}</p>)}
        <div className={local.actions}>{item.sources.map(source=><button type="button" className={styles.sourceButton} key={source.findingId} onClick={()=>onSource(source.findingId)}>查看依据 · {source.meetingTitle} · {source.meetingDate}</button>)}
          {item.todoId||item.linkedTodos.length?<Link href="/work-review/todos">打开待办页</Link>:null}
          {item.taskId?<button type="button" className={styles.secondaryButton} onClick={()=>onTask(item.taskId!)}>查看待确认比较</button>:null}
        </div>
      </details></li>)}</ul>}
    </section>
  </>;
}
export function WorkAgentPage({projectId,meetingId,prepareMeetingId}:{projectId:string;meetingId?:string;prepareMeetingId?:string}){
  const url=`/api/work-reviews/projects/${encodeURIComponent(projectId)}/agent`;
  const [data,setData]=useState<WorkAgentProjectView|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const [goal,setGoal]=useState("今天这场会和之前有什么变化？"),[source,setSource]=useState<WorkAgentSource|null>(null);
  const [current,setCurrent]=useState<string|null>(null),[retract,setRetract]=useState<string|null>(null);
  const lock=useRef(false),startId=useRef<string|null>(null);
  const scopeUrl=useRef(url);scopeUrl.current=url;
  const reload=useCallback(async(signal?:AbortSignal)=>{const value=await request<WorkAgentProjectView>(url,"GET",undefined,signal);if(!signal?.aborted&&scopeUrl.current===url)setData(value);},[url]);
  useEffect(()=>{const controller=new AbortController();setData(null);setSource(null);setCurrent(null);setError(null);void reload(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[reload]);
  const active=data?.tasks.some(v=>["ready","running"].includes(v.task.status));
  useEffect(()=>{if(!active)return;const controller=new AbortController();const timer=setInterval(()=>void reload(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e.message);}),2000);return()=>{clearInterval(timer);controller.abort();};},[active,reload]);
  const mutate=async(body:Record<string,unknown>,method="PATCH")=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError(null);
    try{const result=await request<{task?:WorkAgentTaskView}>(url,method,body);if(result.task)setCurrent(result.task.task.id);await reload();}
    catch(e){setError((e as Error).message);throw e;}finally{lock.current=false;setBusy(false);}
  };
  const send=async(body:Record<string,unknown>)=>{try{await mutate(body);}catch{/* Visible error, retain selection and operation identity. */}};
  const start=async(event?:FormEvent,from?:WorkAgentTaskView)=>{
    event?.preventDefault();const target=from?.artifact?.meetingId??meetingId;if(!target)return;
    startId.current??=key();
    try{await mutate({id:startId.current,meetingId:target,goal:from?"保存这次比较中选中的后续工作":goal,...(from?{fromTaskId:from.task.id}:{})},"POST");startId.current=null;}catch{/* Retry same task identity. */}
  };
  const openSource=async(id:string)=>{setSource(null);try{const value=await request<{source:WorkAgentSource}>(`${url}?findingId=${encodeURIComponent(id)}`);if(scopeUrl.current===url)setSource(value.source);}catch(e){if(scopeUrl.current===url)setError((e as Error).message);}};
  const chosen=data?.tasks.find(v=>v.task.id===current)??data?.tasks[0];
  return <main className={local.page}>
    <Link className={styles.backLink} href="/work-review/projects">← 返回项目</Link>
    <header><p>项目会议衔接</p><h1>{data?.project.name??"项目工作脉络"}</h1><p>准备下次会议，比较已核对结果，确认后保存工作安排。会前简报、时间线和未闭环提示使用同一份项目事实。</p></header>
    <WorkPreparationPanel projectId={projectId} meetingId={meetingId} prepareMeetingId={prepareMeetingId} onSource={id=>void openSource(id)}
      onFollowUp={async id=>{await reload();setCurrent(id);document.getElementById("work-comparisons")?.scrollIntoView({block:"start"});}}/>
    {error?<ProductState title="需要核对" description={error} tone="error" action={<button type="button" className={styles.secondaryButton} onClick={()=>void reload().then(()=>setError(null)).catch(e=>setError(e.message))}>刷新结果</button>}/>:null}
    {meetingId?<form className={local.form} onSubmit={e=>void start(e)}><label htmlFor="work-agent-goal">这场会之后，你想整理什么？</label>
      <textarea id="work-agent-goal" value={goal} onChange={e=>{setGoal(e.target.value);startId.current=null;}} required maxLength={2000}/>
      <button type="submit" className={styles.primaryButton} disabled={busy||!goal.trim()}>与项目历史对比</button></form>:<p>从已完成核对的会议进入，可以开始新一轮比较。</p>}
    {!data&&!error?<ProductState title="正在读取项目成果…" tone="loading"/>:null}
    {data?<ProjectFacts data={data} busy={busy} onSource={id=>void openSource(id)} onRetract={setRetract} onTask={id=>{setCurrent(id);document.getElementById("work-comparisons")?.scrollIntoView({block:"start"});}}/>:null}
    <section id="work-comparisons"><h2>会后比较与确认</h2>
    {data?.tasks.length?<div className={local.history}>{data.tasks.map(v=><button key={v.task.id} className={styles.secondaryButton} type="button" aria-pressed={chosen?.task.id===v.task.id} onClick={()=>setCurrent(v.task.id)}>{v.task.goal} · {labels[v.task.status]}</button>)}</div>:null}
    {chosen?<TaskResult key={`${chosen.task.id}:${chosen.task.version}`} view={chosen} busy={busy} onControl={send} onSource={id=>void openSource(id)} onContinue={()=>void start(undefined,chosen)}/>:null}
    </section>
    <ProductDialog open={!!source} title={source?`${source.meetingTitle} · ${source.meetingDate}`:"会议依据"} onClose={()=>setSource(null)}>
      {source?<><p>已确认结果：{source.body}</p>{source.evidence.map(e=><ProductEvidence key={e.segmentId} label="会议原文" meta={`${e.startSeconds}–${e.endSeconds} 秒 · ${e.timestampQuality}`}><p>{e.text}</p></ProductEvidence>)}<Link href={`/work-review/meetings/${encodeURIComponent(source.meetingId)}`}>打开会议</Link></>:null}
    </ProductDialog>
    <ProductDialog open={!!retract} title="撤回错误关联" onClose={()=>setRetract(null)} footer={<button type="button" className={styles.primaryButton} disabled={busy} onClick={()=>void send({action:"retract",eventId:retract,operationKey:key()}).then(()=>setRetract(null))}>确认撤回关联</button>}><p>将保留撤回历史，当前状态转为待核实；不会改写会议或自动恢复旧决定。</p></ProductDialog>
  </main>;
}
