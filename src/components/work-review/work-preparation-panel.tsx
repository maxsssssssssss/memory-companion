"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import Link from "next/link";
import {ProductState} from "@/components/product-system/product-primitives";
import type {WorkAgendaItem,WorkPreparation,WorkPreparationProject} from "@/lib/domain/work-preparation";
import styles from "./work-review.module.css";
import local from "./work-agent.module.css";

const key=()=>crypto.randomUUID();
const states={draft:"草稿",saved:"已保存",linked:"已关联会议",awaiting_review:"待会后对照确认",reviewed:"已完成会后对照"};
const outcomes={completed:"已完成",decided:"已形成正式决定",unresolved:"仍未解决",changed:"发生变化",not_discussed:"本次未见讨论记录",insufficient:"当前证据不足"};
const taskStates={ready:"准备执行",running:"正在整理",waiting:"等待处理",paused:"已暂停",ended:"已结束",cancelled:"已取消",needs_attention:"需要处理",budget_exhausted:"已达执行上限"};
const strip=(item:WorkPreparation["agenda"][number]):WorkAgendaItem=>{
  const {userEdited:_,sourceInvalid:__,...value}=item;return value;
};
async function request<T>(url:string,method="GET",body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method,credentials:"same-origin",cache:"no-store",signal,
    ...(body===undefined?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.message??(response.status===404?"项目或会议准备不可用。":"暂时无法保存，请重新核对；本地编辑仍保留。"));}
  return response.json() as Promise<T>;
}
function PreparationEditor({value,busy,onSave,onSource}:{value:WorkPreparation;busy:boolean;onSave:(agenda:WorkAgendaItem[])=>Promise<void>;onSource:(id:string)=>void}){
  const [agenda,setAgenda]=useState<WorkAgendaItem[]>(()=>value.agenda.map(strip));
  const update=(index:number,patch:Partial<WorkAgendaItem>)=>setAgenda(items=>items.map((item,i)=>i===index?{...item,...patch}:item));
  const move=(index:number,offset:number)=>setAgenda(items=>{const next=[...items];[next[index],next[index+offset]]=[next[index+offset],next[index]];return next;});
  return <form onSubmit={e=>{e.preventDefault();void onSave(agenda);}} aria-label="编辑会议议程">
    <p>下方标题、讨论重点和预期结果是待核实的讨论建议，不是已确认事实；保存会议计划不会变更项目决定或待办。业务状态由系统记录提供。</p>
    {!agenda.length?<ProductState title="暂无议题" description="可以添加临时议题，或按新的目标重新整理。" tone="empty"/>:null}
    {agenda.map((item,index)=><fieldset className={local.agendaItem} key={item.id} disabled={busy}>
      <legend>议题 {index+1}</legend>
      <p>{value.agenda.find(a=>a.id===item.id)?.userEdited?"用户保存的讨论计划":"Agent 讨论建议 · 待核实"}</p>
      <label>议题名称<input value={item.title} required maxLength={240} onChange={e=>update(index,{title:e.target.value})}/></label>
      <label>讨论重点<textarea value={item.question} required maxLength={1000} onChange={e=>update(index,{question:e.target.value})}/></label>
      <label>预期结果<textarea value={item.expectedOutcome} maxLength={1000} onChange={e=>update(index,{expectedOutcome:e.target.value})}/></label>
      <details><summary>背景、优先级与依据</summary>
        <div aria-label={`系统业务记录 ${index+1}`}>
          <p>当前记录：{value.agenda.find(a=>a.id===item.id)?.currentStatus||"用户临时议题，尚未关联业务记录"}</p>
          <p>需核对：{value.agenda.find(a=>a.id===item.id)?.reason||"用户临时添加"}</p><p>历史依据：{value.agenda.find(a=>a.id===item.id)?.background||"未关联"}</p>
        </div>
        <p>相关负责人：{item.ownerLabel||"尚未明确"}</p>
        <label>建议优先级<select value={item.priority} onChange={e=>update(index,{priority:e.target.value as WorkAgendaItem["priority"]})}><option value="high">优先讨论</option><option value="normal">普通</option><option value="low">可后续讨论</option></select></label>
        {value.agenda.find(a=>a.id===item.id)?.sourceInvalid?<p role="status">来源已失效，内容仅保留为用户计划，不能作为项目事实。</p>:
          <div className={local.actions}>{item.sourceFindingIds.map((id,i)=><button type="button" className={styles.sourceButton} key={id} onClick={()=>onSource(id)}>议题原文 {i+1}</button>)}
            {item.todoIds.length?<Link href="/work-review/todos">查看关联待办</Link>:null}</div>}
      </details>
      <div className={local.actions}><button type="button" className={styles.secondaryButton} disabled={index===0} aria-label={`上移议题 ${index+1}`} onClick={()=>move(index,-1)}>上移</button>
        <button type="button" className={styles.secondaryButton} disabled={index===agenda.length-1} aria-label={`下移议题 ${index+1}`} onClick={()=>move(index,1)}>下移</button>
        <button type="button" className={styles.secondaryButton} aria-label={`删除议题 ${index+1}`} onClick={()=>setAgenda(items=>items.filter(a=>a.id!==item.id))}>删除议题</button></div>
    </fieldset>)}
    <div className={local.actions}><button type="button" className={styles.secondaryButton} disabled={busy||agenda.length>=20} onClick={()=>setAgenda(items=>[...items,{id:key(),title:"临时讨论",reason:"用户添加的临时议题",background:"",currentStatus:"待讨论",question:"需要讨论什么？",expectedOutcome:"",priority:"normal",ownerLabel:null,sourceFindingIds:[],todoIds:[],threadIds:[]}])}>增加临时议题</button>
      <button type="submit" className={styles.primaryButton} disabled={busy}>保存会议准备</button></div>
  </form>;
}
export function WorkPreparationPanel({projectId,meetingId,prepareMeetingId,onSource,onFollowUp}:{projectId:string;meetingId?:string;prepareMeetingId?:string;onSource:(id:string)=>void;onFollowUp:(id:string)=>Promise<void>}){
  const url=`/api/work-reviews/projects/${encodeURIComponent(projectId)}/preparations`;
  const [data,setData]=useState<WorkPreparationProject|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const [goal,setGoal]=useState("帮我准备一下这个项目下一次会议，重点看看还剩什么没处理，以及需要确认哪些事情。"),[selected,setSelected]=useState<string|null>(null);
  const [linkMeeting,setLinkMeeting]=useState(meetingId??prepareMeetingId??"");
  const lock=useRef(false),operation=useRef<{digest:string;key:string}|null>(null),scope=useRef(url);scope.current=url;
  const reload=useCallback(async(signal?:AbortSignal)=>{const value=await request<WorkPreparationProject>(url,"GET",undefined,signal);if(!signal?.aborted&&scope.current===url)setData(value);},[url]);
  useEffect(()=>{const abort=new AbortController();setData(null);setSelected(null);setError(null);void reload(abort.signal).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[reload]);
  const active=data?.tasks.some(t=>["ready","running"].includes(t.status));
  useEffect(()=>{if(!active)return;const abort=new AbortController();const timer=setInterval(()=>void reload(abort.signal).catch(e=>{if(!abort.signal.aborted)setError(e.message);}),1500);return()=>{clearInterval(timer);abort.abort();};},[active,reload]);
  const mutate=async(body:Record<string,unknown>,method="PATCH")=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError(null);
    const digest=JSON.stringify([method,body]);if(operation.current?.digest!==digest)operation.current={digest,key:key()};
    try{const result=await request<{preparation?:WorkPreparation;preparationId?:string}>(url,method,{...body,...(method==="POST"?{id:operation.current.key}:{operationKey:operation.current.key})});
      if(scope.current!==url)return;
      if(result.preparationId)setSelected(result.preparationId);else if(result.preparation)setSelected(result.preparation.id);
      await reload();operation.current=null;
      if(body.action==="confirm_review"&&result.preparation?.followUpTaskId)await onFollowUp(result.preparation.followUpTaskId);
    }catch(e){if(scope.current===url)setError((e as Error).message);}finally{lock.current=false;setBusy(false);}
  };
  const chosen=data?.preparations.find(p=>p.id===selected)??(!selected?data?.preparations[0]:undefined);
  const start=(newGoal=goal)=>mutate({mode:"prepare",goal:newGoal,...(prepareMeetingId?{meetingId:prepareMeetingId}:{})},"POST");
  const agendaTitle=(id:string)=>chosen?.agenda.find(a=>a.id===id)?.title??"议题";
  return <section id="work-preparation" aria-labelledby="work-preparation-title">
    <h2 id="work-preparation-title">会议准备</h2><p>从当前项目事实准备议程；保存后可以关联实际会议，再核对会前与会后的变化。</p>
    <form className={local.form} onSubmit={e=>{e.preventDefault();void start();}}><label htmlFor="work-preparation-goal">下次会议想重点讨论什么？</label>
      <textarea id="work-preparation-goal" value={goal} onChange={e=>setGoal(e.target.value)} required maxLength={2000}/>
      {prepareMeetingId?<p>本次草稿将关联你选择的项目会议。</p>:null}
      <button className={styles.primaryButton} disabled={busy||!!active||!goal.trim()} type="submit">生成会议准备</button></form>
    {error?<ProductState title="会议准备需要核对" description={error} tone="error" action={<button type="button" className={styles.secondaryButton} onClick={()=>void reload().then(()=>setError(null)).catch(e=>setError(e.message))}>重新读取</button>}/>:null}
    {!data&&!error?<ProductState title="正在读取会议准备…" tone="loading"/>:null}
    {data?.tasks.filter(t=>!["ended","cancelled"].includes(t.status)).map(task=><div key={task.id} role="status"><p>{task.mode==="prepare"?"会前准备":"会后对照"} · {taskStates[task.status]}{task.message?` · ${task.message}`:""}</p><div className={local.actions}>
      {["ready","running"].includes(task.status)?<button className={styles.secondaryButton} type="button" disabled={busy} onClick={()=>void mutate({id:task.id,expectedVersion:task.version,action:"pause"})}>暂停整理</button>:null}
      {task.status==="paused"?<button className={styles.secondaryButton} type="button" disabled={busy} onClick={()=>void mutate({id:task.id,expectedVersion:task.version,action:"resume"})}>继续原整理</button>:null}
      {task.status==="needs_attention"||task.status==="running"?<button className={styles.secondaryButton} type="button" disabled={busy} onClick={()=>void mutate({id:task.id,expectedVersion:task.version,action:"inspect"})}>检查已保存结果</button>:null}
      <button className={styles.secondaryButton} type="button" disabled={busy} onClick={()=>void mutate({id:task.id,expectedVersion:task.version,action:"cancel"})}>取消整理</button></div></div>)}
    {data?.preparations.length?<div className={local.history} aria-label="已保存的会议准备">{data.preparations.map(p=><button type="button" key={p.id} className={styles.secondaryButton} aria-pressed={p.id===chosen?.id} onClick={()=>setSelected(p.id)}>{p.goal} · {states[p.status]} · 版本 {p.version}</button>)}</div>:data&&!active?<ProductState title="还没有会议准备" description="说说下次会议的重点，生成草稿后可以编辑保存。" tone="empty"/>:null}
    {chosen?<article className={local.result} aria-label="会议准备材料">
      <header><h3>{states[chosen.status]} · 版本 {chosen.version}</h3><p>创建于 {new Date(chosen.createdAt).toLocaleString()} · 修改于 {new Date(chosen.updatedAt).toLocaleString()}</p>
        <p>状态更新于 {new Date(chosen.statusAsOf).toLocaleString()} · 会议时间：{chosen.meetingDate??"未指定"}</p></header>
      {["awaiting_review","reviewed"].includes(chosen.status)&&!chosen.review?<p role="status">此前对照的依据已失效，需要重新核对；不会据此更新项目状态。</p>:null}
      {chosen.stale?<ProductState title="这份会议准备可能已经过期" description="项目近期有新的决定和工作变化。原议程保持不变，可以重新整理为新草稿后自行选择内容。" tone="empty" action={<button type="button" className={styles.secondaryButton} disabled={busy||!!active} onClick={()=>void start(chosen.goal)}>重新整理为新草稿</button>}/>:null}
      {chosen.sourceInvalid?<p role="status">部分原始来源已失效；保留用户计划，不能继续把旧生成内容当作项目事实。</p>:null}
      {chosen.snapshot?<details open><summary>生成时的项目会前简报</summary><p className={local.notice}>{chosen.snapshot.coverage.notice}</p>
        <h4>当时的当前正式决定</h4>{chosen.snapshot.currentDecisions.length?chosen.snapshot.currentDecisions.map(d=><p key={d.threadId}>{d.body} <button type="button" className={styles.sourceButton} onClick={()=>onSource(d.findingId)}>查看决定原文</button></p>):<p>尚无足够已确认关系确定当前决定；历史决定不自动视为仍然有效。</p>}
        <h4>需要关注的工作与问题</h4><ul>{chosen.snapshot.openLoops.map(l=><li key={l.id}>{l.text}<div className={local.actions}>{l.sources.map(s=><button className={styles.sourceButton} type="button" key={s.findingId} onClick={()=>onSource(s.findingId)}>查看依据 · {s.meetingTitle}</button>)}{l.todoId?<Link href="/work-review/todos">查看当前待办</Link>:null}</div></li>)}</ul>
        <details><summary>近期决定与历史变化</summary><ul>{chosen.snapshot.recentChanges.map(t=><li key={t.id}>{t.date} · {t.label} · {t.text}</li>)}</ul></details>
      </details>:null}
      <h3>建议议程与用户编辑</h3><PreparationEditor key={`${chosen.id}:${chosen.version}`} value={chosen} busy={busy} onSource={onSource}
        onSave={agenda=>mutate({id:chosen.id,expectedVersion:chosen.version,action:"save",agenda})}/>
      <h3>关联实际会议</h3>
      {chosen.meetingId?<><p>{chosen.meetingAvailable?`已关联：${chosen.meetingTitle}`:"已关联的会议已删除或不再属于本项目，依据失效。"}</p>
        <button className={styles.secondaryButton} type="button" disabled={busy} onClick={()=>void mutate({id:chosen.id,expectedVersion:chosen.version,action:"link",meetingId:null})}>解除会议关联</button></>:
        <><p>是否将这场会议与之前的会议准备关联？仅列出当前项目已明确关联的会议。</p><label>选择实际会议<select value={linkMeeting} onChange={e=>setLinkMeeting(e.target.value)}><option value="">请选择会议</option>{data?.meetings.map(m=><option value={m.id} key={m.id}>{m.title} · {m.meetingDate}{m.reviewed?" · 已核对":" · 尚未完成核对"}</option>)}</select></label>
        <button className={styles.secondaryButton} type="button" disabled={busy||chosen.status==="draft"||!linkMeeting} onClick={()=>void mutate({id:chosen.id,expectedVersion:chosen.version,action:"link",meetingId:linkMeeting})}>确认关联会议</button></>}
      {chosen.meetingId&&chosen.meetingAvailable&&chosen.status!=="draft"?<div className={local.actions}>
        <Link href={`/work-review/meetings/${encodeURIComponent(chosen.meetingId)}`}>打开关联会议</Link>
        <button type="button" className={styles.primaryButton} disabled={busy||!!active||chosen.sourceInvalid||!data?.meetings.find(m=>m.id===chosen.meetingId)?.reviewed} onClick={()=>void mutate({mode:"review",preparationId:chosen.id,goal:"对照保存的会前议程与本次正式会议结果，标明完成、变化、未解决和未讨论事项。"},"POST")}>生成会后对照</button>
        {!data?.meetings.find(m=>m.id===chosen.meetingId)?.reviewed?<p>完成整场会议核对后才能生成对照。</p>:null}</div>:null}
      {chosen.review?<section aria-label="会前会后对照"><h3>会后对照 · {chosen.review.confirmed?"用户已核对":"关联建议，待核对"}</h3><p>{chosen.review.coverage}</p>
        <p>未见讨论记录不代表现实中已完成。以下对照不自动更新项目决定或待办。</p>
        {chosen.review.stale?<p role="status">对照后项目状态已有变化，请结合下方当前时间线和待办核实。</p>:null}
        <ul>{chosen.review.items.map(item=><li key={item.agendaId}><strong>{agendaTitle(item.agendaId)} · {outcomes[item.status]}</strong><p>{item.text}</p><div className={local.actions}>{item.sourceFindingIds.map((id,i)=><button type="button" key={id} className={styles.sourceButton} onClick={()=>onSource(id)}>会后原文 {i+1}</button>)}</div></li>)}</ul>
        <h4>本次新增事项</h4>{chosen.review.addedFindingIds.length?chosen.review.addedFindingIds.map(id=><p key={id}>{chosen.sources.find(s=>s.findingId===id)?.body}<button type="button" className={styles.sourceButton} onClick={()=>onSource(id)}>查看新增事项原文</button></p>):<p>本轮未识别到议程以外的新增事项。</p>}
        {!chosen.review.confirmed?<button type="button" className={styles.primaryButton} disabled={busy||chosen.review.stale||chosen.sourceInvalid} onClick={()=>void mutate({id:chosen.id,expectedVersion:chosen.version,action:"confirm_review",fingerprint:chosen.review!.fingerprint})}>确认对照，整理会后工作</button>:null}
      </section>:null}
      {chosen.followUpTaskId?<button type="button" className={styles.secondaryButton} onClick={()=>void onFollowUp(chosen.followUpTaskId!)}>查看后续工作固定预览与保存结果</button>:null}
    </article>:null}
  </section>;
}
