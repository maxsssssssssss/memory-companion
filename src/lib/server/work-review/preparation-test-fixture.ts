import {randomUUID} from "node:crypto";
import type Database from "better-sqlite3";
import {join,dirname} from "node:path";
import {WorkMeetingCandidateStructuredDataSchema} from "@/lib/domain/work-review";
import type {WorkAgentComparison} from "@/lib/domain/work-agent";
import type {WorkAgendaItem,WorkPreparationContext,WorkPreparationReview} from "@/lib/domain/work-preparation";
import {seedWorkAgentCase} from "./agent-test-fixture";
import {openWorkAgentRuntime,startWorkAgent} from "./agent-service";
import {WorkAgentRepository} from "./agent-repository";

export async function applyWorkFixture(db:Database.Database,f:ReturnType<typeof seedWorkAgentCase>,meetingId:string,comparison:WorkAgentComparison){
  const {runtime}=openWorkAgentRuntime(db,{checkpointPath:join(dirname(db.name),"fixture-checkpoints.sqlite"),compare:async()=>structuredClone(comparison),decision:async()=>({tool:"work.compare_meeting",args:{}})});
  try{
    let task=await runtime.advance(f.accountId,startWorkAgent(db,f.accountId,f.project.id,{id:randomUUID(),meetingId,goal:"整理后续工作"}).id);
    const p=new WorkAgentRepository(db).read(task)!.preview!;
    task=await runtime.submitEvent(f.accountId,task.id,{id:randomUUID(),kind:"work_selection",version:1,refId:p.id,message:JSON.stringify({previewId:p.id,fingerprint:p.fingerprint,keys:p.changes.filter(c=>c.review?.status==="confirmable").map(c=>c.change.key)})},{expectedVersion:1});
    return await runtime.resolveApproval(f.accountId,task.id,{approvalId:task.approval!.id,fingerprint:task.approval!.fingerprint,expectedVersion:1,decision:"approve",eventId:randomUUID()});
  }finally{runtime.close();}
}
export async function seedPreparationCase(db:Database.Database,accountId="account_a"){
  const f=seedWorkAgentCase(db,accountId);await applyWorkFixture(db,f,f.meetings[1],f.m2);await applyWorkFixture(db,f,f.meetings[2],f.m3);return f;
}
export function preparationDraft(context:WorkPreparationContext){
  const source=(title:string)=>context.sources.find(s=>s.title===title)!.findingId;
  const todo=(title:string)=>context.todos.find(t=>t.title===title)!.id;
  const item=(id:string,title:string,finding:string,todoIds:string[]=[],ownerLabel:string|null=null):WorkAgendaItem=>({id,title,reason:"需要确认当前进展和后续安排",background:"基于项目已确认记录",currentStatus:"待核实本次进展",question:`确认${title}的进展或最终结论`,expectedOutcome:"确定本次结论及下一步",priority:"high",ownerLabel,sourceFindingIds:[finding],todoIds,threadIds:[]});
  return {agenda:[item("deployment","B方案部署进度",source("正式采用B方案"),[todo("B方案部署")],"林晨"),
    item("logs","日志保留期限",source("日志保留期限")),item("vendor","供应商回复",source("供应商配额回复"),[todo("等待供应商回复")],"周敏"),
    item("monitor","同步延迟监控",source("同步延迟监控"),[todo("同步延迟监控")],"林晨"),item("constraints","客户约束清单",source("客户约束清单"),[],"周敏")]};
}
/** Publish synthetic transcript -> candidates -> explicit accept -> complete review -> explicit project link. */
export function createPreparationM4(f:ReturnType<typeof seedWorkAgentCase>){
  const rows=[
    {key:"deploy_done",title:"B方案部署完成",kind:"decision" as const,text:"林晨：B方案部署已全部完成，正式上线。",final:true},
    {key:"logs_decided",title:"日志保留期限正式确定",kind:"decision" as const,text:"陈悦：正式决定日志保留期限为30天，周敏负责执行。日志保留期限问题已解决。",final:true},
    {key:"vendor_wait",title:"供应商仍在等待",kind:"open_question" as const,text:"周敏：供应商仍未回复，继续等待，不要把等待事项标记完成。",final:false},
    {key:"monitor_done",title:"同步延迟监控完成",kind:"decision" as const,text:"林晨：同步延迟监控已全部完成，告警测试通过。",final:true},
    {key:"new_question",title:"告警升级阈值",kind:"open_question" as const,text:"赵宁：告警升级阈值还没决定，下周继续讨论。",final:false},
  ];
  const {accountId,repo,projects}=f,date="2026-11-03";
  const reserved=repo.reserveMeeting({accountId,idempotencyKey:"preparation_m4",sourceUploadId:`upload_m4_${accountId}`,contentHash:"4".repeat(64),title:"合成M4",meetingDate:date});
  const meetingId=reserved.meeting.id,uploadId=reserved.meeting.sourceUploadId;
  repo.publishSourceUpload({accountId,meetingId,uploadId,originalName:"synthetic-m4.wav",mimeType:"audio/wav",sizeBytes:32,recordingDate:date,filePath:"synthetic-not-read.wav",contentHash:"4".repeat(64)});
  repo.queueStage({accountId,meetingId,stage:"transcription"});
  const fence=repo.claimProcessingAttempt({accountId,meetingId,stage:"transcription",leaseOwner:"p3-fixture",leaseDurationMs:60000,pipelineVersion:"fixture",providerProfile:"fixture"})!;
  const publication=repo.publishCanonicalTranscript({accountId,meetingId,fence,segments:rows.map((r,i)=>({id:`m4_${r.key}`,uploadId,startSeconds:i*20,endSeconds:i*20+18,speaker:"合成发言人",text:r.text,confidence:1,sceneLabels:[],valueLabels:[]}))}).publication;
  repo.queueStage({accountId,meetingId,stage:"meeting_analysis"});
  const analysis=repo.claimProcessingAttempt({accountId,meetingId,stage:"meeting_analysis",leaseOwner:"p3-fixture",leaseDurationMs:60000,pipelineVersion:"fixture",providerProfile:"fixture"})!;
  repo.markAnalysisVerifying({accountId,meetingId,fence:analysis});
  const candidates=repo.publishAnalysisResult({accountId,meetingId,fence:analysis,canonicalContentDigest:publication.contentDigest,candidates:rows.map(r=>({kind:r.kind,title:r.title,body:r.text,
    structuredData:WorkMeetingCandidateStructuredDataSchema.parse({decisionFinality:r.final?"final":null}),publicationAction:"show_as_candidate",riskLevel:"high",generatorProfile:"synthetic",generatorPromptVersion:"synthetic",evidenceSegmentIds:[`m4_${r.key}`],timestampQualityBySegmentId:{[`m4_${r.key}`]:"synthetic"},claims:[]}))});
  const findings:Record<string,string>={};candidates.forEach((candidate,i)=>{findings[rows[i].key]=repo.reviewCandidate({accountId,meetingId,candidateId:candidate.id,expectedVersion:candidate.version,operationKey:`accept_m4_${i}`,action:"accept"}).finding!.id;});
  repo.completeReview({accountId,meetingId,expectedVersion:repo.getMeeting(accountId,meetingId).version,operationKey:"review_m4"});
  projects.setMeetingProjects({accountId,meetingId,expectedVersion:repo.getMeeting(accountId,meetingId).version,operationKey:"link_m4",projectIds:[f.project.id]});
  const monitor=f.todos.listTodos({accountId,view:"all",projectScope:{kind:"project",projectId:f.project.id}}).find(t=>t.title==="同步延迟监控")!;
  const comparison:WorkAgentComparison={items:[
    {category:"resolved",text:"部署和监控已完成，日志期限问题已解决。",status:"suggestion",sourceFindingIds:[findings.deploy_done,findings.logs_decided,findings.monitor_done]},
    {category:"unresolved",text:"供应商仍在等待，下周需讨论告警阈值。",status:"confirmed_fact",sourceFindingIds:[findings.vendor_wait,findings.new_question]},
  ],changes:[
    {key:"done_deploy",kind:"complete_todo",todoId:f.deployment.id,label:"完成原部署待办",sourceFindingIds:[findings.deploy_done]},
    {key:"done_monitor",kind:"complete_todo",todoId:monitor.id,label:"完成监控待办",sourceFindingIds:[findings.monitor_done]},
    {key:"close_logs",kind:"relation",relation:"resolves",anchorFindingId:f.findings.logs,findingId:findings.logs_decided,todoId:null,label:"日志期限已正式确定，问题已解决",sourceFindingIds:[findings.logs_decided]},
  ]};
  return {meetingId,findings,comparison};
}
export function preparationReview(agenda:WorkAgendaItem[],m4:ReturnType<typeof createPreparationM4>):WorkPreparationReview{
  return {items:agenda.map(a=>{
    const keys:Record<string,{status:WorkPreparationReview["items"][number]["status"];key:string;text:string}>={
      deployment:{status:"completed",key:"deploy_done",text:"会议明确确认B方案部署完成；待办需经后续确认更新。"},
      logs:{status:"decided",key:"logs_decided",text:"日志期限从未定变为正式确定30天。"},
      vendor:{status:"unresolved",key:"vendor_wait",text:"供应商仍未回复。"},
      monitor:{status:"completed",key:"monitor_done",text:"同步延迟监控已完成。"},
    };
    const found=keys[a.id];return {agendaId:a.id,status:found?.status??"not_discussed",text:found?.text??"本次已确认会议结果未找到该议题的讨论记录，不能因此认定完成。",sourceFindingIds:found?[m4.findings[found.key]]:[]};
  }),addedFindingIds:[m4.findings.new_question]};
}
