import { after } from "next/server";
import { z } from "zod";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { AgentFailure } from "@/lib/server/agent/types";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { isWorkReviewProjectsEnabled, isWorkReviewTodoEnabled } from "@/lib/server/work-review/runtime-config";
import { workReviewPrivateJson, workReviewRouteError, workReviewFeatureDisabled } from "@/lib/server/work-review/route-utils";
import { startWorkAgent, openWorkAgentRuntime, readWorkAgentProject, projectWorkAgentTask, advanceWorkAgent } from "@/lib/server/work-review/agent-service";
import { WorkAgentRepository } from "@/lib/server/work-review/agent-repository";
import { WorkAgentSelection } from "@/lib/server/work-review/agent-scenario";
import { readWorkAgentSource, requireWorkAgentProject } from "@/lib/server/work-review/agent-context";

export const runtime="nodejs";
type Context={params:Promise<{projectId:string}>};
const id=WorkReviewIdSchema,version=z.number().int().positive();
const Start=z.object({id,meetingId:id,goal:z.string().trim().min(1).max(2000),fromTaskId:id.optional()}).strict();
const identity={id,eventId:id,expectedVersion:version};
const Control=z.discriminatedUnion("action",[
  z.object({...identity,action:z.literal("select"),selection:WorkAgentSelection}).strict(),
  z.object({...identity,action:z.literal("approval"),approvalId:z.string().min(1).max(180),fingerprint:z.string().length(64),decision:z.enum(["approve","reject"])}).strict(),
  z.object({...identity,action:z.enum(["pause","resume","cancel","end"])}).strict(),
  z.object({...identity,action:z.literal("recover"),mode:z.enum(["inspect","retry"])}).strict(),
  z.object({...identity,action:z.literal("feedback"),message:z.string().trim().min(1).max(2000)}).strict(),
  z.object({action:z.literal("retract"),eventId:id,operationKey:id}).strict(),
]);
function errorResponse(error:unknown){
  if(error instanceof AgentFailure)return workReviewPrivateJson({error:`work_agent_${error.code}`},error.code==="forbidden"?404:409);
  return workReviewRouteError(error);
}
function enabled(){return isWorkReviewProjectsEnabled() && isWorkReviewTodoEnabled();}
export async function GET(request:Request,context:Context){
  if(!enabled())return workReviewFeatureDisabled();
  try{
    const auth=await requireAuthContext(request),projectId=id.parse((await context.params).projectId),db=getWorkReviewDatabase();
    const findingId=new URL(request.url).searchParams.get("findingId");
    return workReviewPrivateJson(findingId?{source:readWorkAgentSource(db,auth.user.id,projectId,id.parse(findingId))}:readWorkAgentProject(db,auth.user.id,projectId));
  }catch(error){return errorResponse(error);}
}
export async function POST(request:Request,context:Context){
  if(!enabled())return workReviewFeatureDisabled();
  try{
    const auth=await requireAuthContext(request),projectId=id.parse((await context.params).projectId),input=Start.parse(await request.json()),db=getWorkReviewDatabase();
    const task=startWorkAgent(db,auth.user.id,projectId,input);
    if(task.status==="ready")after(()=>advanceWorkAgent(auth.user.id,task.id).then(()=>undefined));
    return workReviewPrivateJson({task:projectWorkAgentTask(db,task)},202);
  }catch(error){return errorResponse(error);}
}
export async function PATCH(request:Request,context:Context){
  if(!enabled())return workReviewFeatureDisabled();
  let close:(()=>void)|undefined;
  try{
    const auth=await requireAuthContext(request),accountId=auth.user.id,projectId=id.parse((await context.params).projectId),value=Control.parse(await request.json()),db=getWorkReviewDatabase();
    requireWorkAgentProject(db,accountId,projectId);
    if(value.action==="retract"){
      new WorkAgentRepository(db).retract(accountId,projectId,value.eventId,value.operationKey);
      return workReviewPrivateJson(readWorkAgentProject(db,accountId,projectId));
    }
    const {store,runtime:runner}=openWorkAgentRuntime(db);close=()=>runner.close();
    let task=store.assertVersion(accountId,value.id,value.expectedVersion);
    if(task.resourceId!==projectId)throw new AgentFailure("forbidden","任务不属于当前项目。");
    let scheduled=false;
    if(value.action==="select"){
      const event={id:value.eventId,kind:"work_selection",refId:value.selection.previewId,version:value.expectedVersion,message:JSON.stringify(value.selection)};
      task=await runner.submitEvent(accountId,task.id,event,{expectedVersion:value.expectedVersion,defer:true});
      scheduled=!store.acceptedEvent(accountId,task.id,event)?.consumed;
    }else if(value.action==="approval"){
      task=await runner.resolveApproval(accountId,task.id,{...value,defer:true});
      scheduled=!["ended","cancelled"].includes(task.status);
    }else if(value.action==="recover"){
      task=await runner.recover(accountId,task.id,{expectedVersion:value.expectedVersion,mode:value.mode,eventId:value.eventId,defer:true});
      scheduled=value.mode==="retry" && task.status==="ready";
    }else if(value.action==="feedback"){
      task=await runner.submitEvent(accountId,task.id,{id:value.eventId,kind:"feedback",version:value.expectedVersion,message:value.message},
        {expectedVersion:value.expectedVersion,defer:true});scheduled=true;
    }else if(value.action==="end")task=runner.end(accountId,task.id,value);
    else{task=runner.control(accountId,task.id,value.action,value.expectedVersion);scheduled=value.action==="resume"&&task.status==="ready";}
    if(scheduled)after(()=>advanceWorkAgent(accountId,task.id).then(()=>undefined));
    return workReviewPrivateJson({task:projectWorkAgentTask(db,task),scheduled},202);
  }catch(error){return errorResponse(error);}finally{close?.();}
}
