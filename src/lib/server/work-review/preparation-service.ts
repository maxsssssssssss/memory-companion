import type Database from "better-sqlite3";
import {dirname,join} from "node:path";
import {z} from "zod";
import type {AgentTask} from "@/lib/domain/agent";
import {WORK_PREPARATION_SCENARIO,type WorkPreparationProject} from "@/lib/domain/work-preparation";
import {AgentStore} from "@/lib/server/agent/store";
import {AgentRuntime} from "@/lib/server/agent/runtime";
import {AgentFailure,type AgentDecisionProvider,type AgentScenario} from "@/lib/server/agent/types";
import {readWorkAgentContext,requireWorkAgentProject,workAgentId} from "./agent-context";
import {readWorkPreparationContext} from "./preparation-context";
import {WorkPreparationRepository,type PreparationScope} from "./preparation-repository";
import {generateWorkPreparation,compareWorkPreparation} from "./preparation-model";
import {decideWorkAgent} from "./agent-model";
import {WorkReviewRepository} from "./repository";
import {getWorkReviewDatabase} from "./db";
import {startWorkAgent} from "./agent-service";

type Models={generate?:typeof generateWorkPreparation;review?:typeof compareWorkPreparation;decision?:AgentDecisionProvider;checkpointPath?:string};
export function openWorkPreparationRuntime(db:Database.Database,models:Models={}){
  const repo=new WorkPreparationRepository(db),store=new AgentStore(db);
  const result=(task:AgentTask)=>{
    const scope=repo.scope(task);
    try{const value=repo.read(task.accountId,task.resourceId,scope.preparationId);return scope.mode==="prepare"||value.review?.taskId===task.id?value:null;}
    catch(error){if(error instanceof AgentFailure&&error.code==="forbidden")return null;throw error;}
  };
  const scenario:AgentScenario={id:WORK_PREPARATION_SCENARIO,
    instructions:"这是项目会议准备。先读取当前项目事实；根据任务mode调用work.prepare_meeting或work.review_preparation保存草稿。草稿可编辑，不是项目决定。成果已保存即可结束，不调用会后写入工具。",
    async validate(ctx){requireWorkAgentProject(db,ctx.task.accountId,ctx.task.resourceId);if(!result(ctx.task))repo.context(ctx.task);},
    async observe(ctx){const scope=repo.scope(ctx.task);return {mode:scope.mode,projectId:ctx.task.resourceId,resultSaved:!!result(ctx.task),coverage:repo.context(ctx.task).coverage};},
    async finish(_reason,ctx){if(!result(ctx.task))throw new AgentFailure("invalid_action","必须先保存本轮会议准备成果。");return repo.scope(ctx.task).mode==="prepare"?"会议准备草稿已生成，请编辑并保存。":"会后对照建议已保存，请核对后继续会后工作确认。";},
    tools:{
      "work.read_project_context":{description:"读取P1/P2同一项目当前决定、已确认会议事实、当前Todo与未闭环提示。",parameters:z.object({}).strict(),
        async execute(_args,ctx){repo.context(ctx.task);return {ref:{kind:"work_preparation_context",id:ctx.task.resourceId},summary:"已读取项目状态和覆盖范围。"};},
        async readResult(_receipt,ctx){return repo.context(ctx.task);}},
      "work.prepare_meeting":{description:"按用户目标生成会议议程草稿，等待用户编辑保存；不修改项目事实。",parameters:z.object({}).strict(),
        async execute(_args,ctx){if(repo.scope(ctx.task).mode!=="prepare")throw new AgentFailure("invalid_action","本任务是会后对照。");
          let saved=result(ctx.task);if(!saved){const draft=await (models.generate??generateWorkPreparation)(repo.context(ctx.task),ctx);await ctx.assertActive();saved=repo.saveGenerated(ctx.task,draft);}
          return {ref:{kind:"work_preparation",id:saved.id},summary:"会议准备草稿已保存。",handoff:"编辑议程并保存会议准备。"};},
        async readResult(_receipt,ctx){return result(ctx.task);},
        async validateResult(receipt,ctx){const saved=result(ctx.task);if(!saved||saved.id!==receipt.ref?.id||saved.sourceInvalid)throw new AgentFailure("source_changed","未核对到本轮有效的准备成果。");},
        async recover(_action,ctx){const saved=result(ctx.task);return saved?{ref:{kind:"work_preparation",id:saved.id},summary:"找到已保存的原草稿。",handoff:"原草稿已恢复。"}:null;}},
      "work.review_preparation":{description:"对照已保存议程与明确关联且已核对的会议，保存有依据的会后对照建议。",parameters:z.object({}).strict(),
        async execute(_args,ctx){const scope=repo.scope(ctx.task);if(scope.mode!=="review")throw new AgentFailure("invalid_action","本任务是会前准备。");
          let saved=result(ctx.task);if(!saved){repo.context(ctx.task);const preparation=repo.read(ctx.task.accountId,ctx.task.resourceId,scope.preparationId);
            const comparison=await (models.review??compareWorkPreparation)({agenda:preparation.agenda,context:readWorkAgentContext(db,ctx.task.accountId,ctx.task.resourceId,scope.meetingId!)},ctx);
            await ctx.assertActive();saved=repo.saveReview(ctx.task,comparison);}
          return {ref:{kind:"work_preparation",id:saved.id},summary:"会后对照建议已保存。",handoff:"请核对对照结果，再确认后续工作。"};},
        async readResult(_receipt,ctx){return result(ctx.task);},
        async validateResult(receipt,ctx){const saved=result(ctx.task);if(!saved||saved.id!==receipt.ref?.id||!saved.review||saved.review.stale)throw new AgentFailure("source_changed","未核对到本轮有效的对照成果。");},
        async recover(_action,ctx){const saved=result(ctx.task);return saved?{ref:{kind:"work_preparation",id:saved.id},summary:"找到已保存的原对照。",handoff:"原对照已恢复。"}:null;}},
    },
  };
  const decision:AgentDecisionProvider=async(input,ctx)=>result(ctx.task)?{finish:"本轮成果已保存。"}:(models.decision??decideWorkAgent)(input,ctx);
  return {store,runtime:new AgentRuntime({store,scenario,decision,checkpointPath:models.checkpointPath??join(dirname(db.name),"work-agent-checkpoints.sqlite")})};
}
export function startWorkPreparation(db:Database.Database,accountId:string,projectId:string,input:{id:string;mode:"prepare"|"review";goal:string;preparationId?:string;meetingId?:string}){
  const project=requireWorkAgentProject(db,accountId,projectId),repo=new WorkPreparationRepository(db),store=new AgentStore(db);
  if(db.prepare("SELECT 1 FROM agent_tasks WHERE id=?").get(input.id)){
    const task=store.getTask(accountId,input.id),scope=repo.scope(task);
    if(task.resourceId!==projectId||task.goal!==input.goal.trim()||scope.mode!==input.mode||input.mode==="review"&&scope.preparationId!==input.preparationId
      ||input.mode==="prepare"&&scope.meetingId!==(input.meetingId??null))throw new AgentFailure("conflict","相同任务标识的内容不同。");return task;
  }
  if(project.status!=="active")throw new AgentFailure("source_changed","项目已归档。");
  let scope:PreparationScope;
  if(input.mode==="prepare"){
    if(input.meetingId)repo.meeting(accountId,projectId,input.meetingId);
    const context=readWorkPreparationContext(db,accountId,projectId);
    scope={projectId,preparationId:workAgentId([input.id,"preparation"]),mode:"prepare",fingerprint:context.fingerprint,meetingId:input.meetingId??null,preparationVersion:null};
  }else{
    if(!input.preparationId)throw new AgentFailure("invalid_action","请先选择保存的准备材料。");
    const preparation=repo.read(accountId,projectId,input.preparationId);
    if(preparation.status==="draft"||!preparation.meetingId||preparation.sourceInvalid)throw new AgentFailure("source_changed","请先保存准备并关联有效会议。");
    const context=readWorkAgentContext(db,accountId,projectId,preparation.meetingId);
    scope={projectId,preparationId:preparation.id,mode:"review",fingerprint:context.fingerprint,meetingId:preparation.meetingId,preparationVersion:preparation.version};
  }
  return store.createTask({id:input.id,accountId,resourceId:projectId,scenario:WORK_PREPARATION_SCENARIO,goal:input.goal,scope});
}
export function readWorkPreparations(db:Database.Database,accountId:string,projectId:string):WorkPreparationProject{
  const context=readWorkPreparationContext(db,accountId,projectId),repo=new WorkPreparationRepository(db),store=new AgentStore(db);
  const ids=db.prepare("SELECT id FROM wr_meeting_preparations WHERE account_id=? AND project_id=? ORDER BY created_at DESC,id").all(accountId,projectId) as {id:string}[];
  return {preparations:ids.map(({id})=>repo.read(accountId,projectId,id,context)),
    tasks:store.listTasks(accountId,projectId).filter(task=>task.scenario===WORK_PREPARATION_SCENARIO).map(task=>({id:task.id,preparationId:repo.scope(task).preparationId,mode:repo.scope(task).mode,status:task.status,
      version:task.version??1,message:task.endReason??null,recovery:task.recovery})),
    meetings:new WorkReviewRepository(db).listMeetings(accountId,{kind:"project",projectId}).map(m=>({id:m.id,title:m.title,meetingDate:m.meetingDate,reviewed:m.reviewStatus==="completed"}))};
}
export function confirmWorkPreparation(db:Database.Database,accountId:string,projectId:string,id:string,input:{operationKey:string;expectedVersion:number;fingerprint:string}){
  return new WorkPreparationRepository(db).confirmReview(accountId,projectId,id,input,(meetingId,reviewTaskId)=>{
    const task=startWorkAgent(db,accountId,projectId,{id:workAgentId([id,reviewTaskId,"follow_up"]).replace("wra_","wrp3-"),meetingId,goal:"根据已经核对的会后结果，整理后续工作并生成待确认的修改预览。"});return task.id;
  });
}
export async function advanceWorkPreparation(accountId:string,taskId:string){
  const {runtime}=openWorkPreparationRuntime(getWorkReviewDatabase());try{return await runtime.advance(accountId,taskId);}finally{runtime.close();}
}
