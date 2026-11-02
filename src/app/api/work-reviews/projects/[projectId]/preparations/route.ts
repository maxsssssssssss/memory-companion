import {after} from "next/server";
import {z} from "zod";
import {WorkReviewIdSchema} from "@/lib/domain/work-review";
import {WorkAgendaItem,WORK_PREPARATION_SCENARIO} from "@/lib/domain/work-preparation";
import {requireAuthContext} from "@/lib/server/auth/request-context";
import {AgentFailure} from "@/lib/server/agent/types";
import {getWorkReviewDatabase} from "@/lib/server/work-review/db";
import {isWorkReviewProjectsEnabled,isWorkReviewTodoEnabled} from "@/lib/server/work-review/runtime-config";
import {workReviewPrivateJson,workReviewRouteError,workReviewFeatureDisabled} from "@/lib/server/work-review/route-utils";
import {startWorkPreparation,readWorkPreparations,openWorkPreparationRuntime,advanceWorkPreparation,confirmWorkPreparation} from "@/lib/server/work-review/preparation-service";
import {WorkPreparationRepository} from "@/lib/server/work-review/preparation-repository";
import {advanceWorkAgent} from "@/lib/server/work-review/agent-service";
import {requireWorkAgentProject} from "@/lib/server/work-review/agent-context";

export const runtime="nodejs";
type Context={params:Promise<{projectId:string}>};
const id=WorkReviewIdSchema;
const Start=z.object({id,mode:z.enum(["prepare","review"]),goal:z.string().trim().min(1).max(2000),preparationId:id.optional(),meetingId:id.optional()}).strict();
const base={id,operationKey:id,expectedVersion:z.number().int().positive()};
const Change=z.discriminatedUnion("action",[
  z.object({...base,action:z.literal("save"),agenda:z.array(WorkAgendaItem).max(20)}).strict(),
  z.object({...base,action:z.literal("link"),meetingId:id.nullable()}).strict(),
  z.object({...base,action:z.literal("confirm_review"),fingerprint:z.string().length(64)}).strict(),
  z.object({...base,action:z.enum(["pause","resume","cancel","inspect"])}).strict(),
]);
const enabled=()=>isWorkReviewProjectsEnabled()&&isWorkReviewTodoEnabled();
function errorResponse(error:unknown){return error instanceof AgentFailure?workReviewPrivateJson({error:`work_preparation_${error.code}`,message:error.message},error.code==="forbidden"?404:409):workReviewRouteError(error);}
export async function GET(request:Request,context:Context){
  if(!enabled())return workReviewFeatureDisabled();
  try{const auth=await requireAuthContext(request),projectId=id.parse((await context.params).projectId);
    return workReviewPrivateJson(readWorkPreparations(getWorkReviewDatabase(),auth.user.id,projectId));
  }catch(error){return errorResponse(error);}
}
export async function POST(request:Request,context:Context){
  if(!enabled())return workReviewFeatureDisabled();
  try{const auth=await requireAuthContext(request),projectId=id.parse((await context.params).projectId),input=Start.parse(await request.json());
    const task=startWorkPreparation(getWorkReviewDatabase(),auth.user.id,projectId,input);
    if(task.status==="ready")after(()=>advanceWorkPreparation(auth.user.id,task.id).then(()=>undefined));
    return workReviewPrivateJson({taskId:task.id,preparationId:(task.scope as {preparationId:string}).preparationId},202);
  }catch(error){return errorResponse(error);}
}
export async function PATCH(request:Request,context:Context){
  if(!enabled())return workReviewFeatureDisabled();
  let close:(()=>void)|undefined;
  try{const auth=await requireAuthContext(request),accountId=auth.user.id,projectId=id.parse((await context.params).projectId),input=Change.parse(await request.json());
    const db=getWorkReviewDatabase(),repo=new WorkPreparationRepository(db);requireWorkAgentProject(db,accountId,projectId);
    if(input.action==="save")return workReviewPrivateJson({preparation:repo.save(accountId,projectId,input.id,input)});
    if(input.action==="link")return workReviewPrivateJson({preparation:repo.link(accountId,projectId,input.id,input)});
    if(input.action==="confirm_review"){
      const preparation=confirmWorkPreparation(db,accountId,projectId,input.id,input);
      if(preparation.followUpTaskId)after(()=>advanceWorkAgent(accountId,preparation.followUpTaskId!).then(()=>undefined));
      return workReviewPrivateJson({preparation},202);
    }
    const runner=openWorkPreparationRuntime(db);close=()=>runner.runtime.close();
    const task=runner.store.assertVersion(accountId,input.id,input.expectedVersion);
    if(task.scenario!==WORK_PREPARATION_SCENARIO||task.resourceId!==projectId)throw new AgentFailure("forbidden","任务不属于本项目会议准备。");
    const result=input.action==="inspect"?await runner.runtime.recover(accountId,task.id,{expectedVersion:input.expectedVersion,eventId:input.operationKey,mode:"inspect",defer:true})
      :runner.runtime.control(accountId,task.id,input.action,input.expectedVersion);
    if(input.action==="resume"&&result.status==="ready")after(()=>advanceWorkPreparation(accountId,task.id).then(()=>undefined));
    return workReviewPrivateJson({taskId:task.id},202);
  }catch(error){return errorResponse(error);}finally{close?.();}
}
