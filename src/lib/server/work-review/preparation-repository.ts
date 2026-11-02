import type Database from "better-sqlite3";
import type { AgentTask } from "@/lib/domain/agent";
import { WorkAgendaItem, WorkPreparationDraft, WorkPreparationGeneration, WorkPreparationReview, type WorkAgendaSuggestion, type WorkPreparation, type WorkPreparationBinding,
  type WorkPreparationContext, WORK_PREPARATION_SCENARIO } from "@/lib/domain/work-preparation";
import { AgentFailure } from "@/lib/server/agent/types";
import { readWorkAgentContext, readWorkAgentSource, requireWorkAgentProject, workAgentHash, workAgentTodoInScope } from "./agent-context";
import { readWorkPreparationContext, workPreparationAgendaFacts } from "./preparation-context";
import { WorkReviewRepository } from "./repository";
import { WorkProjectRepository } from "./project-repository";
import { WorkTodoRepository } from "./todo-repository";
import { reviewWorkAgentChange } from "./agent-consistency";

export type PreparationScope = {projectId:string;preparationId:string;mode:"prepare"|"review";fingerprint:string;meetingId:string|null;preparationVersion:number|null};
type Row = {id:string;account_id:string;project_id:string;task_id:string;goal:string;version:number;state:WorkPreparation["status"];
  source_fingerprint:string;bindings_json:string;snapshot_json:string|null;generated_json:string|null;agenda_json:string;
  meeting_id:string|null;review_json:string|null;follow_up_task_id:string|null;created_at:string;updated_at:string};
type SavedReview=NonNullable<WorkPreparation["review"]> & {bindings:WorkPreparationBinding[];contextFingerprint:string;preparationVersion:number};
const decode=<T>(v:string|null):T|null=>v===null?null:JSON.parse(v) as T;
function changed(message="项目、会议或准备版本已变化，请重新打开核对。") : never {throw new AgentFailure("source_changed",message);}
function invalid(message:string):never{throw new AgentFailure("invalid_action",message);}
export class WorkPreparationRepository {
  constructor(readonly database:Database.Database){}
  scope(task:AgentTask):PreparationScope {
    const scope=task.scope as PreparationScope;
    if(task.scenario!==WORK_PREPARATION_SCENARIO||scope.projectId!==task.resourceId||!scope.preparationId)invalid("会议准备任务范围不匹配。");
    return scope;
  }
  row(accountId:string,projectId:string,id:string):Row {
    requireWorkAgentProject(this.database,accountId,projectId);
    const row=this.database.prepare("SELECT * FROM wr_meeting_preparations WHERE account_id=? AND project_id=? AND id=?").get(accountId,projectId,id) as Row|undefined;
    if(!row)throw new AgentFailure("forbidden","会议准备不存在或无权访问。");return row;
  }
  meeting(accountId:string,projectId:string,id:string,reviewed=false){
    if(!new WorkProjectRepository(this.database).listMeetingIdsByScope(accountId,{kind:"project",projectId}).includes(id))changed("会议没有明确关联本项目。");
    const meeting=new WorkReviewRepository(this.database).getMeeting(accountId,id);
    if(reviewed&&meeting.reviewStatus!=="completed")changed("请先完成整场会议核对。");return meeting;
  }
  private validBindings(accountId:string,projectId:string,bindings:WorkPreparationBinding[]){
    return bindings.map(b=>{try{const source=readWorkAgentSource(this.database,accountId,projectId,b.findingId);return source.fingerprint===b.fingerprint?source:null;}catch{return null;}});
  }
  read(accountId:string,projectId:string,id:string,context?:WorkPreparationContext):WorkPreparation {
    const row=this.row(accountId,projectId,id),bindings=JSON.parse(row.bindings_json) as WorkPreparationBinding[];
    const checked=this.validBindings(accountId,projectId,bindings),sources=checked.filter(s=>s!==null);
    const invalidIds=new Set(bindings.filter((_,i)=>!checked[i]).map(b=>b.findingId));
    const current=context??readWorkPreparationContext(this.database,accountId,projectId);
    const projects=new WorkProjectRepository(this.database),todos=new WorkTodoRepository(this.database);
    const meetingIds=new Set(projects.listMeetingIdsByScope(accountId,{kind:"project",projectId}));
    const validTodos=new Set(projects.listTodoIdsByScope(accountId,{kind:"project",projectId}).filter(id=>workAgentTodoInScope(this.database,accountId,projectId,todos.getTodo(accountId,id),meetingIds)));
    const storedAgenda=JSON.parse(row.agenda_json) as WorkPreparation["agenda"];
    const sourceInvalid=invalidIds.size>0||storedAgenda.some(a=>a.todoIds.some(id=>!validTodos.has(id)));
    let meetingTitle:string|null=null,meetingDate:string|null=null,meetingAvailable=!row.meeting_id;
    if(row.meeting_id)try{const m=this.meeting(accountId,projectId,row.meeting_id);meetingTitle=m.title;meetingDate=m.meetingDate;meetingAvailable=true;}catch{/* Retain the user's link; never infer a replacement. */}
    let review=decode<SavedReview>(row.review_json);
    if(review){
      const evidence=this.validBindings(accountId,projectId,review.bindings);
      if(!meetingAvailable||evidence.some(s=>!s))review=null;
      else {
        sources.push(...evidence.filter(s=>s!==null));
        try{review.stale=readWorkAgentContext(this.database,accountId,projectId,row.meeting_id!).fingerprint!==review.contextFingerprint;}
        catch{review.stale=true;}
      }
    }
    const agenda=storedAgenda.map(stored=>{
      // Also project legacy drafts safely without rewriting historical responses or user discussion text.
      const item={...stored,...workPreparationAgendaFacts(stored,current)};
      const failed=item.sourceFindingIds.some(id=>invalidIds.has(id))||item.todoIds.some(id=>!validTodos.has(id))
        ||item.threadIds.some(id=>current.threads.find(t=>t.id===id)?.state==="unknown");
      // User-authored plans remain theirs, clearly separate from invalidated generated summaries.
      return failed&&!item.userEdited?{...item,title:"依据失效的议题",reason:"原文或业务来源已变化，请重新核对。",background:"",currentStatus:"依据失效",
        question:"需要重新核实该议题",expectedOutcome:"",ownerLabel:null,sourceInvalid:true}:failed?{...item,reason:"原文或业务来源已变化，请重新核对。",background:"",currentStatus:"依据失效，不能作为当前事实。",sourceInvalid:true}:{...item,sourceInvalid:false};
    });
    if(sourceInvalid){
      // Remove generated source derivatives, retaining identities and user edits for history.
      this.database.prepare("UPDATE wr_meeting_preparations SET snapshot_json=NULL,generated_json=NULL,agenda_json=? WHERE id=?").run(JSON.stringify(agenda),row.id);
    }
    if(row.review_json&&!review)this.database.prepare("UPDATE wr_meeting_preparations SET review_json=NULL WHERE id=?").run(row.id);
    return {id:row.id,projectId,taskId:row.task_id,goal:row.goal,version:row.version,status:row.state,createdAt:row.created_at,updatedAt:row.updated_at,
      meetingId:row.meeting_id,meetingTitle,meetingDate,statusAsOf:current.asOf,meetingAvailable,stale:current.fingerprint!==row.source_fingerprint,sourceInvalid,agenda,
      snapshot:sourceInvalid?null:decode(row.snapshot_json),sources:[...new Map(sources.map(s=>[s.findingId,s])).values()],
      review:review?{items:review.items,addedFindingIds:review.addedFindingIds,taskId:review.taskId,fingerprint:review.fingerprint,
        confirmed:review.confirmed,stale:review.stale,coverage:review.coverage}:null,followUpTaskId:row.follow_up_task_id};
  }
  private active(task:AgentTask){
    const row=this.database.prepare("SELECT status,version FROM agent_tasks WHERE id=? AND account_id=?").get(task.id,task.accountId) as {status:string;version:number}|undefined;
    if(!row||row.version!==(task.version??1)||!["ready","running"].includes(row.status))throw new AgentFailure("inactive","任务已停止，不保存晚到结果。");
    if(requireWorkAgentProject(this.database,task.accountId,task.resourceId).status!=="active")changed("项目已归档。");
  }
  context(task:AgentTask){
    const scope=this.scope(task);
    const context=readWorkPreparationContext(this.database,task.accountId,task.resourceId);
    if(scope.mode==="prepare"){
      if(context.fingerprint!==scope.fingerprint)changed();
      if(scope.meetingId){const meeting=this.meeting(task.accountId,task.resourceId,scope.meetingId);context.meetingId=meeting.id;context.meetingDate=meeting.meetingDate;}
    }else{
      const row=this.row(task.accountId,task.resourceId,scope.preparationId);
      if(row.version!==scope.preparationVersion||row.meeting_id!==scope.meetingId||!row.meeting_id)changed();
      this.meeting(task.accountId,task.resourceId,row.meeting_id,true);
      if(this.read(task.accountId,task.resourceId,row.id,context).sourceInvalid)changed("准备的原始依据已失效，请先重新整理。");
      if(readWorkAgentContext(this.database,task.accountId,task.resourceId,row.meeting_id).fingerprint!==scope.fingerprint)changed();
    }
    return context;
  }
  saveGenerated(task:AgentTask,raw:unknown){
    return this.database.transaction(()=>{
      this.active(task);const scope=this.scope(task);
      if(this.database.prepare("SELECT 1 FROM wr_meeting_preparations WHERE id=?").get(scope.preparationId))return this.read(task.accountId,task.resourceId,scope.preparationId);
      const context=this.context(task),suggestions=WorkPreparationGeneration.parse(raw);
      const draft={agenda:suggestions.agenda.map(item=>({...item,...workPreparationAgendaFacts(item,context)}))};
      if(new Set(draft.agenda.map(a=>a.id)).size!==draft.agenda.length)invalid("议题标识重复。");
      for(const item of draft.agenda){
        this.references(item,context);
        if(!item.sourceFindingIds.length&&!item.todoIds.length&&!item.threadIds.length)invalid("生成议题缺少项目依据。");
        if(item.ownerLabel&&!context.todos.some(t=>item.todoIds.includes(t.id)&&t.ownerLabel===item.ownerLabel)
          &&!context.sources.some(s=>item.sourceFindingIds.includes(s.findingId)&&s.evidence.some(e=>e.text.includes(item.ownerLabel!))))item.ownerLabel=null;
      }
      const now=new Date().toISOString(),{currentDecisions,recentChanges,openLoops,todos,coverage}=context;
      const bindings=context.sources.map(({findingId,meetingId,fingerprint})=>({findingId,meetingId,fingerprint}));
      this.database.prepare(`INSERT INTO wr_meeting_preparations
        (id,account_id,project_id,task_id,goal,state,source_fingerprint,bindings_json,snapshot_json,generated_json,agenda_json,meeting_id,created_at,updated_at)
        VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)`).run(scope.preparationId,task.accountId,task.resourceId,task.id,task.goal,context.fingerprint,
          JSON.stringify(bindings),JSON.stringify({currentDecisions,recentChanges,openLoops,todos,coverage}),JSON.stringify(draft),
          JSON.stringify(draft.agenda.map(a=>({...a,userEdited:false,sourceInvalid:false}))),scope.meetingId,now,now);
      return this.read(task.accountId,task.resourceId,scope.preparationId,context);
    }).immediate();
  }
  private references(item:WorkAgendaSuggestion,context:WorkPreparationContext){
    if(item.sourceFindingIds.some(id=>!context.sources.some(s=>s.findingId===id))||item.todoIds.some(id=>!context.todos.some(t=>t.id===id))
      ||item.threadIds.some(id=>!context.threads.some(t=>t.id===id)))invalid("议题引用超出本次读取的项目范围。");
  }
  /** Versioned user writes with durable operation receipts; no model call or project-fact write here. */
  mutate(accountId:string,projectId:string,id:string,input:{operationKey:string;expectedVersion:number;action:string;[key:string]:unknown},write:(row:Row)=>void){
    return this.database.transaction(()=>{
      const row=this.row(accountId,projectId,id),digest=workAgentHash([projectId,id,input]);
      const prior=this.database.prepare("SELECT payload_digest FROM wr_meeting_preparation_operations WHERE account_id=? AND operation_key=?").get(accountId,input.operationKey) as {payload_digest:string}|undefined;
      if(prior){if(prior.payload_digest!==digest)throw new AgentFailure("conflict","同一操作标识的内容不同。");return this.read(accountId,projectId,id);}
      if(row.version!==input.expectedVersion)throw new AgentFailure("conflict","另一处已保存了新版本，请重新打开。你的本地编辑尚未覆盖保存内容。");
      if(requireWorkAgentProject(this.database,accountId,projectId).status!=="active")changed("项目已归档。");
      write(row);const now=new Date().toISOString();
      this.database.prepare("UPDATE wr_meeting_preparations SET version=version+1,updated_at=? WHERE id=?").run(now,id);
      const updated=this.row(accountId,projectId,id);
      this.database.prepare(`INSERT INTO wr_meeting_preparation_operations
        (account_id,project_id,preparation_id,operation_key,payload_digest,action,result_version,meeting_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(accountId,projectId,id,input.operationKey,digest,input.action,updated.version,updated.meeting_id,now);
      return this.read(accountId,projectId,id);
    }).immediate();
  }
  save(accountId:string,projectId:string,id:string,input:{operationKey:string;expectedVersion:number;agenda:WorkAgendaItem[]}){
    return this.mutate(accountId,projectId,id,{...input,action:"save"},row=>{
      const agenda=WorkPreparationDraft.parse({agenda:input.agenda}).agenda;
      if(new Set(agenda.map(a=>a.id)).size!==agenda.length)invalid("议题标识重复。");
      const generated=decode<WorkPreparationDraft>(row.generated_json);
      const prior=JSON.parse(row.agenda_json) as WorkPreparation["agenda"];
      const context=readWorkPreparationContext(this.database,accountId,projectId);
      for(const item of agenda){
        const old=prior.find(a=>a.id===item.id);
        // Keep invalid references on existing user content as history, never allow new invalid references.
        this.references({...item,sourceFindingIds:item.sourceFindingIds.filter(id=>!old?.sourceFindingIds.includes(id)),
          todoIds:item.todoIds.filter(id=>!old?.todoIds.includes(id)),threadIds:item.threadIds.filter(id=>!old?.threadIds.includes(id))},context);
      }
      const discussion=(a:WorkAgendaItem|null)=>a?(({reason:_,background:__,currentStatus:___,...rest})=>rest)(a):null;
      // Clients edit plans, never the server-owned factual projection.
      const saved=agenda.map(a=>({...a,...workPreparationAgendaFacts(a,context),userEdited:workAgentHash(discussion(a))!==workAgentHash(discussion(generated?.agenda.find(g=>g.id===a.id)??null)),sourceInvalid:false}));
      this.database.prepare("UPDATE wr_meeting_preparations SET state=?,agenda_json=?,review_json=NULL WHERE id=?")
        .run(row.meeting_id?"linked":"saved",JSON.stringify(saved),id);
    });
  }
  link(accountId:string,projectId:string,id:string,input:{operationKey:string;expectedVersion:number;meetingId:string|null}){
    return this.mutate(accountId,projectId,id,{...input,action:"link"},row=>{
      if(row.state==="draft")invalid("请先保存会议准备。");
      if(input.meetingId){this.meeting(accountId,projectId,input.meetingId);if(row.meeting_id&&row.meeting_id!==input.meetingId)invalid("这份准备已关联会议，请先明确解除原关联。");}
      this.database.prepare("UPDATE wr_meeting_preparations SET meeting_id=?,state=?,review_json=NULL,follow_up_task_id=NULL WHERE id=?")
        .run(input.meetingId,input.meetingId?"linked":"saved",id);
    });
  }
  saveReview(task:AgentTask,raw:unknown){
    return this.database.transaction(()=>{
      this.active(task);const scope=this.scope(task),row=this.row(task.accountId,task.resourceId,scope.preparationId);
      const old=decode<SavedReview>(row.review_json);if(old?.taskId===task.id)return this.read(task.accountId,task.resourceId,row.id);
      this.context(task);
      const context=readWorkAgentContext(this.database,task.accountId,task.resourceId,row.meeting_id!);
      const agenda=JSON.parse(row.agenda_json) as WorkAgendaItem[],review=WorkPreparationReview.parse(raw);
      if(review.items.length!==agenda.length||new Set(review.items.map(i=>i.agendaId)).size!==agenda.length||review.items.some(i=>!agenda.some(a=>a.id===i.agendaId)))invalid("会后对照必须覆盖保存版本的每个议题。");
      const current=context.sources.filter(s=>s.meetingId===row.meeting_id),ids=new Set(current.map(s=>s.findingId));
      if([...review.items.flatMap(i=>i.sourceFindingIds),...review.addedFindingIds].some(id=>!ids.has(id)))invalid("会后对照只能引用本次已核对会议的有效结果。");
      for(const item of review.items){
        const planned=agenda.find(a=>a.id===item.agendaId)!;
        let supported=true;
        if(item.status==="not_discussed")supported=!context.coverage.limited&&!item.sourceFindingIds.length;
        else if(item.status!=="insufficient")supported=item.sourceFindingIds.length>0;
        if(item.status==="decided")supported&&=item.sourceFindingIds.some(id=>current.some(s=>s.findingId===id&&s.kind==="decision"&&s.finality==="final"));
        if(item.status==="completed"){
          const targets=[...planned.todoIds.map(todoId=>({kind:"complete_todo" as const,todoId,key:"review",label:"核对完成依据",sourceFindingIds:item.sourceFindingIds})),
            ...planned.sourceFindingIds.filter(id=>context.sources.some(s=>s.findingId===id&&s.kind==="open_question")).map(anchorFindingId=>({kind:"relation" as const,relation:"resolves" as const,anchorFindingId,
              findingId:item.sourceFindingIds[0]??"",todoId:null,key:"review",label:"核对解决依据",sourceFindingIds:[...new Set([anchorFindingId,...item.sourceFindingIds])]}))];
          supported&&=targets.length>0&&targets.every(t=>reviewWorkAgentChange(context,t).status==="confirmable");
        }
        if(!supported){item.status="insufficient";item.text="现有依据不足以确认原建议的结果，请核实；不会据此完成待办或关闭问题。";}
      }
      const saved:SavedReview={...review,taskId:task.id,confirmed:false,stale:false,coverage:context.coverage.notice,preparationVersion:row.version,
        contextFingerprint:context.fingerprint,fingerprint:workAgentHash([task.id,row.version,context.fingerprint,review]),
        bindings:current.map(({findingId,meetingId,fingerprint})=>({findingId,meetingId,fingerprint}))};
      this.database.prepare("UPDATE wr_meeting_preparations SET review_json=?,state='awaiting_review' WHERE id=?").run(JSON.stringify(saved),row.id);
      return this.read(task.accountId,task.resourceId,row.id);
    }).immediate();
  }
  confirmReview(accountId:string,projectId:string,id:string,input:{operationKey:string;expectedVersion:number;fingerprint:string},followUp:(meetingId:string,reviewTaskId:string)=>string){
    return this.mutate(accountId,projectId,id,{...input,action:"confirm_review"},row=>{
      const review=decode<SavedReview>(row.review_json),view=this.read(accountId,projectId,id);
      if(!review||!view.review||review.fingerprint!==input.fingerprint||review.preparationVersion!==row.version||view.review.stale||!row.meeting_id)changed("对照版本或会议状态已变化，请重新核对。");
      if(view.sourceInvalid)changed();
      const taskId=followUp(row.meeting_id,review.taskId);review.confirmed=true;
      this.database.prepare("UPDATE wr_meeting_preparations SET review_json=?,state='reviewed',follow_up_task_id=? WHERE id=?").run(JSON.stringify(review),taskId,id);
    });
  }
}
