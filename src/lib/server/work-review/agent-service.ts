import type Database from "better-sqlite3";
import { dirname, join } from "node:path";
import type { AgentTask } from "@/lib/domain/agent";
import { WORK_AGENT_SCENARIO, type WorkAgentTaskView, type WorkAgentProjectView, type WorkAgentSource, type WorkAgentSourceLink } from "@/lib/domain/work-agent";
import { WorkMeetingCandidateStructuredDataSchema } from "@/lib/domain/work-review";
import { AgentStore } from "@/lib/server/agent/store";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { AgentFailure, type AgentDecisionProvider } from "@/lib/server/agent/types";
import { getWorkReviewDatabase } from "./db";
import { readWorkAgentContext, readWorkAgentSource, readWorkThreads, requireWorkAgentProject, workAgentTodoInScope } from "./agent-context";
import { WorkAgentRepository } from "./agent-repository";
import { createWorkAgentScenario, withWorkSelection, type WorkCompare } from "./agent-scenario";
import { WorkProjectRepository } from "./project-repository";
import { WorkTodoRepository } from "./todo-repository";

export function openWorkAgentRuntime(db:Database.Database,options:{checkpointPath?:string;decision?:AgentDecisionProvider;compare?:WorkCompare}={}) {
  const store=new AgentStore(db);
  const runtime=new AgentRuntime({store,checkpointPath:options.checkpointPath ?? join(dirname(db.name),"work-agent-checkpoints.sqlite"),
    scenario:createWorkAgentScenario(db,options.compare),decision:withWorkSelection(db,options.decision)});
  return {store,runtime};
}
export function startWorkAgent(db:Database.Database,accountId:string,projectId:string,input:{id:string;meetingId:string;goal:string;fromTaskId?:string}) {
  const store=new AgentStore(db),repo=new WorkAgentRepository(db);
  const project=requireWorkAgentProject(db,accountId,projectId);
  if (db.prepare("SELECT 1 FROM agent_tasks WHERE id=?").get(input.id)) {
    const existing=store.getTask(accountId,input.id);
    if (existing.scenario!==WORK_AGENT_SCENARIO || existing.resourceId!==projectId || existing.goal!==input.goal.trim()
      || repo.scope(existing).meetingId!==input.meetingId || repo.scope(existing).fromTaskId!==input.fromTaskId) throw new AgentFailure("conflict","相同任务标识的目标或范围不一致。");
    return existing;
  }
  if(project.status!=="active")throw new AgentFailure("source_changed","请先恢复项目，再整理后续工作。");
  const context=readWorkAgentContext(db,accountId,projectId,input.meetingId);
  const sourceTask=input.fromTaskId ? store.getTask(accountId,input.fromTaskId):null;
  if(sourceTask && (sourceTask.resourceId!==projectId || repo.scope(sourceTask).meetingId!==input.meetingId))throw new AgentFailure("forbidden","比较不属于当前项目会议。");
  const prior=sourceTask?repo.read(sourceTask):null;
  if(sourceTask && (!prior?.comparison || prior.state==="invalidated" || prior.applied))throw new AgentFailure("source_changed","原比较不可继续，请重新比较。");
  return db.transaction(()=>{
    const task=store.createTask({id:input.id,accountId,resourceId:projectId,scenario:WORK_AGENT_SCENARIO,goal:input.goal,
      scope:{projectId,meetingId:input.meetingId,fingerprint:context.fingerprint,...(input.fromTaskId?{fromTaskId:input.fromTaskId}:{})}});
    if(prior?.comparison){repo.saveComparison(task,prior.comparison);repo.preview(task);}
    return task;
  }).immediate();
}
export function projectWorkAgentTask(db:Database.Database,task:AgentTask):WorkAgentTaskView {
  if(task.scenario!==WORK_AGENT_SCENARIO)throw new AgentFailure("forbidden","任务不属于办公复盘。");
  const repo=new WorkAgentRepository(db),artifact=repo.read(task);
  let invalid=artifact?.state==="invalidated";
  if(!artifact)try{repo.context(task);}catch{invalid=true;}
  const view:WorkAgentTaskView={task:{id:task.id,version:task.version,goal:invalid?"此前会议比较（来源已变化）":task.goal,
    status:task.status,usage:task.usage,budget:task.budget,wait:task.wait,endReason:task.endReason,recovery:task.recovery,
    approval:task.approval},artifact};
  if(invalid){
    view.task.approval=undefined;view.task.wait=undefined;
    if(!["ended","cancelled"].includes(task.status))view.task.status="needs_attention";
    view.task.endReason="来源已变化，旧比较与预览已失效；已提交操作不会重发。请重新比较。";
    view.task.recovery={kind:"source_invalid",message:view.task.endReason,allowedControls:["cancel"]};
  }
  return view;
}
export function readWorkAgentProject(db:Database.Database,accountId:string,projectId:string):WorkAgentProjectView {
  const project=requireWorkAgentProject(db,accountId,projectId),store=new AgentStore(db);
  const threads=readWorkThreads(db,accountId,projectId),projects=new WorkProjectRepository(db),todos=new WorkTodoRepository(db);
  const meetingIds=new Set(projects.listMeetingIdsByScope(accountId,{kind:"project",projectId}));
  // Project facts must not forget approved follow-ups when the generic task list's 50-row window moves on.
  const taskIds=db.prepare("SELECT id FROM agent_tasks WHERE account_id=? AND resource_id=? AND scenario=? ORDER BY created_at DESC,id")
    .all(accountId,projectId,WORK_AGENT_SCENARIO) as {id:string}[];
  const tasks=taskIds.map(({id})=>projectWorkAgentTask(db,store.getTask(accountId,id)));
  const allTodos=projects.listTodoIdsByScope(accountId,{kind:"project",projectId}).map(id=>todos.getTodo(accountId,id));
  const scopedTodos=allTodos.filter(t=>workAgentTodoInScope(db,accountId,projectId,t,meetingIds));
  const sources=new Map<string,WorkAgentSource>();
  const links=(values:WorkAgentSource[]):WorkAgentSourceLink[]=>[...new Map(values.map(s=>[s.findingId,
    {findingId:s.findingId,meetingId:s.meetingId,meetingTitle:s.meetingTitle,meetingDate:s.meetingDate}])).values()];
  const timeline:WorkAgentProjectView["timeline"]=[],openLoops:WorkAgentProjectView["openLoops"]=[];
  // No model selection limit here: this is the user's project view, not a model prompt.
  const findings=db.prepare(`SELECT f.id,f.structured_data_json,m.meeting_date FROM wr_findings f
    JOIN wr_meetings m ON m.id=f.meeting_id AND m.account_id=f.account_id
    JOIN wr_meeting_projects p ON p.meeting_id=m.id AND p.account_id=m.account_id
    WHERE f.account_id=? AND p.project_id=? AND f.user_confirmed_at IS NOT NULL
      AND m.deleted_at IS NULL AND m.ingestion_status<>'deleted' ORDER BY m.meeting_date,f.created_at,f.id`)
    .all(accountId,projectId) as {id:string;structured_data_json:string;meeting_date:string}[];
  // Keep membership even for invalid/retracted relationships: raw facts must not bypass a state barrier.
  const memberships=db.prepare(`SELECT anchor_finding_id AS id FROM wr_work_threads WHERE account_id=? AND project_id=?
    UNION SELECT finding_id FROM wr_work_thread_events WHERE account_id=? AND project_id=?
    UNION SELECT target_finding_id FROM wr_work_thread_events WHERE account_id=? AND project_id=?`)
    .all(accountId,projectId,accountId,projectId,accountId,projectId) as {id:string}[];
  const related=new Set(memberships.map(r=>r.id));
  for(const row of findings){
    try{sources.set(row.id,readWorkAgentSource(db,accountId,projectId,row.id));}
    catch{
      if(related.has(row.id))continue; // The recorded relationship supplies the content-free history below.
      timeline.push({id:`fact:${row.id}`,date:row.meeting_date,title:"会议依据已失效",text:"原文已变化，无法继续使用旧结论。",label:"依据失效",status:"source_invalid",sources:[],canRetract:false});
      openLoops.push({id:`finding:${row.id}`,kind:"uncertain",title:"会议依据已失效",text:"原文已变化，当前状态需要重新核实。",status:"source_invalid",basis:"needs_verification",reasons:["不再引用旧正文或据此判断工作未完成。"],sources:[],linkedTodos:[]});
    }
  }
  const recorded=new Set(threads.flatMap(t=>t.events.filter(e=>e.valid&&e.relation==="records").map(e=>e.findingId)));
  for(const source of sources.values()){
    if(!["decision","proposal","plan_change","open_question"].includes(source.kind)||recorded.has(source.findingId))continue;
    const candidate=source.kind==="proposal"||(source.kind==="decision"&&source.finality!=="final");
    timeline.push({id:`fact:${source.findingId}`,date:source.meetingDate,title:source.title,text:source.body,
      status:candidate?"candidate":"fact",label:candidate?"候选 / 暂定，未视为当前决定":source.kind==="decision"?"会议已确认的正式决定":source.kind==="plan_change"?"会议内计划变化":"会议已确认的问题",
      sources:links([source]),canRetract:false});
  }
  const relationLabels:Record<string,string>={records:"记录事实",suspends:"暂停决定",supersedes:"替代决定",withdraws:"撤回决定",resolves:"解决问题",reopens:"重新打开问题",tracks:"关联待办",retracts:"撤回错误关联"};
  const groupedTodos=new Set<string>();
  for(const thread of threads){
    for(const event of thread.events)timeline.push({id:event.id,threadId:thread.id,eventId:event.id,date:event.meetingDate,
      title:event.valid?thread.title:"历史关系依据已失效",text:event.label,
      status:!event.valid?"source_invalid":event.retracted?"retracted":"confirmed_relation",
      label:`${relationLabels[event.relation]??"已确认关系"}${event.retracted?"（关联已撤回）":""}`,
      sources:links(event.sources),canRetract:event.valid&&!event.retracted&&event.relation!=="retracts"});
    const evidence=thread.events.filter(e=>e.valid&&!e.retracted&&e.relation!=="retracts").flatMap(e=>e.sources);
    const threadTodos=scopedTodos.filter(t=>thread.linkedTodos.some(l=>l.id===t.id)||t.sourceFindingId===thread.anchorFindingId);
    const linkedTodos=threadTodos.map(({id,title,status})=>({id,title,status}));
    if(thread.state==="unknown")openLoops.push({id:thread.id,kind:"uncertain",threadId:thread.id,title:thread.title,
      text:`${thread.title}：依据失效或关联已撤回，需要重新核实。`,status:thread.events.some(e=>!e.valid)?"source_invalid":"needs_review",basis:"needs_verification",
      reasons:["不会自动恢复旧决定，也不把旧问题认定为仍未解决。"],sources:links(evidence),linkedTodos});
    else if(thread.state==="open" && thread.kind==="question"){
      const completed=linkedTodos.filter(t=>t.status==="completed");
      const meetingCount=new Set(evidence.map(s=>s.meetingId)).size;
      const reasons=["尚无已确认的解决关系。"];
      if(meetingCount>1)reasons.push(`已确认关联覆盖 ${meetingCount} 场会议，仍无解决记录。`);
      if(threadTodos.some(t=>t.status==="open"&&t.kind==="waiting_for_other"))reasons.push("关联待办仍在等待他人回复。");
      threadTodos.forEach(t=>groupedTodos.add(t.id));
      openLoops.push({id:thread.id,kind:"question",threadId:thread.id,title:thread.title,status:"unresolved",basis:"confirmed_relation",reasons,sources:links(evidence),linkedTodos,
        waitingForOther:threadTodos.some(t=>t.status==="open"&&t.kind==="waiting_for_other"),
        text:`${thread.title}：问题仍未解决。${completed.length?`关联待办已完成：${completed.map(t=>t.title).join("、")}；待办完成不等于问题已解决。`:""}`});
    }else if(thread.state==="open" && thread.kind==="work"){
      if(!threadTodos.length)openLoops.push({id:thread.id,kind:"uncertain",threadId:thread.id,title:thread.title,status:"no_follow_up",basis:"needs_verification",sources:links(evidence),linkedTodos,
        text:`${thread.title}：尚未关联有效待办，后续情况待核实。`,reasons:["未找到后续安排记录，不证明现实中未处理。"]});
    }else if(thread.state==="open")openLoops.push({id:thread.id,kind:"uncertain",threadId:thread.id,title:thread.title,status:"needs_review",basis:"needs_verification",sources:links(evidence),linkedTodos,
      text:`${thread.title}：尚无已确认的后续结论，需要核实。`,reasons:["提议不等于正式决定。"]});
  }
  // Approved Todo changes are follow-up records too; preserve the Todo's original provenance.
  const followUpSources=new Map<string,WorkAgentSource[]>();
  for(const {artifact} of tasks){
    if(!artifact?.applied||artifact.state==="invalidated")continue;
    for(const {change} of artifact.preview?.changes??[]){
      if(change.kind==="relation"||!artifact.applied.selectedKeys.includes(change.key))continue;
      const todoId=change.kind==="create_todo"?scopedTodos.find(t=>t.sourceFindingId===change.findingId)?.id:change.todoId;
      if(todoId)followUpSources.set(todoId,[...(followUpSources.get(todoId)??[]),...change.sourceFindingIds.flatMap(id=>sources.get(id)?[sources.get(id)!]:[])]);
    }
  }
  for(const todo of allTodos){
    if(todo.status!=="open")continue;
    if(!scopedTodos.some(t=>t.id===todo.id)){
      openLoops.push({id:todo.id,kind:"uncertain",todoId:todo.id,title:"待办依据已失效",text:"关联会议已变化或不在本项目中；待办记录仍保留，当前安排待核实。",status:"source_invalid",basis:"needs_verification",reasons:["不继续引用旧会议正文。"],sources:[],linkedTodos:[]});continue;
    }
    const evidence=[...(todo.sourceFindingId&&sources.get(todo.sourceFindingId)?[sources.get(todo.sourceFindingId)!]:[]),...(followUpSources.get(todo.id)??[])];
    const reasons=["这是待办记录状态，不证明现实中未完成。"];
    const detached=todo.origin==="detached_meeting_finding";
    const sourceChanged=!!todo.sourceFindingId&&sources.get(todo.sourceFindingId)?.version!==todo.sourceFindingVersion;
    if(detached)reasons.push("原来源已删除；按删除时的选择保留独立待办记录，不再引用旧会议。");
    if(sourceChanged)reasons.push("来源结果版本已变化，请核对当前待办；旧引用不作为有效依据。");
    if(!todo.currentDueDate)reasons.push("待办未设期限。");
    if(!todo.ownerLabel)reasons.push("待办负责人未记录。");
    const changed=threads.filter(t=>t.kind==="decision"&&t.linkedTodos.some(l=>l.id===todo.id))
      .flatMap(t=>t.events.filter(e=>e.valid&&!e.retracted&&["suspends","supersedes","withdraws"].includes(e.relation)).slice(-1));
    const unchecked=changed.filter(event=>!tasks.some(({artifact})=>artifact?.state==="applied"&&artifact.applied?.eventIds.includes(event.id)
      &&artifact.preview?.changes.some(({change})=>change.kind==="update_todo"&&change.todoId===todo.id&&artifact.applied?.selectedKeys.includes(change.key))));
    if(unchecked.length){reasons.push("关联决定已经变化，未找到随该变化一并确认的待办调整；请核对当前安排，不会自动完成待办。");evidence.push(...unchecked.flatMap(e=>e.sources));}
    if(groupedTodos.has(todo.id)){
      const group=openLoops.find(l=>l.linkedTodos.some(t=>t.id===todo.id));
      if(group){group.reasons.push(...reasons);group.sources=links([...evidence,...group.sources.flatMap(l=>sources.get(l.findingId)?[sources.get(l.findingId)!]:[])]);}continue;
    }
    openLoops.push({id:todo.id,kind:"todo",todoId:todo.id,title:todo.title,status:detached?"source_invalid":unchecked.length||sourceChanged?"needs_review":todo.kind==="waiting_for_other"?"waiting":"open",
      basis:detached||unchecked.length||sourceChanged?"needs_verification":"record",text:`${todo.kind==="waiting_for_other"?"等待他人":"未完成待办"}：${todo.title}${todo.currentDueDate?`（期限 ${todo.currentDueDate}）`:"（未设期限）"}。`,reasons,sources:links(evidence),linkedTodos:[]});
  }
  const handled=new Set([...scopedTodos.flatMap(t=>t.sourceFindingId?[t.sourceFindingId]:[]),...[...followUpSources.values()].flat().map(s=>s.findingId)]);
  for(const row of findings){
    const source=sources.get(row.id);if(!source||related.has(row.id)||handled.has(row.id))continue;
    const question=source.kind==="open_question";
    if(!question&&!["commitment","action_item"].includes(source.kind))continue;
    const metadata=WorkMeetingCandidateStructuredDataSchema.parse(JSON.parse(row.structured_data_json));
    const reasons=[question?"尚无已确认的解决关系。":"未找到已关联的待办或后续关系，不代表现实中没有处理。"];
    if(!question){
      if(!metadata.candidateOwner)reasons.push("负责人尚未结构化记录，请核对原文。");
      if(!metadata.dueAt)reasons.push("期限尚未明确记录，请核对原文。");
      if(source.actionBasis!=="explicit_commitment")reasons.push("这是行动记录，不视为已经接受的正式承诺。");
    }
    openLoops.push({id:`finding:${source.findingId}`,kind:question?"question":"uncertain",title:source.title,
      text:`${source.title}：${source.body}`,status:question?"unresolved":"no_follow_up",basis:question?"record":"needs_verification",reasons,sources:links([source]),linkedTodos:[]});
  }
  for(const {task,artifact} of tasks){
    if(!artifact?.comparison||artifact.applied||artifact.state==="invalidated"||task.status==="cancelled"||task.approval?.status==="rejected")continue;
    for(const [index,item] of artifact.comparison.items.entries()){
      if(item.status!=="suggestion")continue;
      openLoops.push({id:`suggestion:${task.id}:${index}`,kind:"uncertain",taskId:task.id,title:"待确认的关联建议",text:item.text,status:"suggestion",basis:"agent_suggestion",
        reasons:["来自 Agent 比较，尚未成为已确认的项目关系。"],sources:links(item.sourceFindingIds.flatMap(id=>sources.get(id)?[sources.get(id)!]:[])),linkedTodos:[]});
    }
  }
  timeline.sort((a,b)=>a.date.localeCompare(b.date)); // Stable order within a day is display order, not inferred chronology.
  return {project:{id:project.id,name:project.name},threads,timeline,openLoops,tasks};
}
export async function advanceWorkAgent(accountId:string,taskId:string) {
  const db=getWorkReviewDatabase(),{runtime}=openWorkAgentRuntime(db);
  try{return await runtime.advance(accountId,taskId);}finally{runtime.close();}
}
