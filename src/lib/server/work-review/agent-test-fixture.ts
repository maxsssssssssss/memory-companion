import type Database from "better-sqlite3";
import { WorkMeetingCandidateStructuredDataSchema } from "@/lib/domain/work-review";
import type { WorkAgentComparison } from "@/lib/domain/work-agent";
import { WorkReviewRepository, type WorkCandidateKind } from "./repository";
import { WorkProjectRepository } from "./project-repository";
import { WorkTodoRepository } from "./todo-repository";

/** Synthetic three-meeting acceptance fixture. No user content, ASR or model calls. */
export function seedWorkAgentCase(db:Database.Database,accountId="account_a",texts:Record<string,string>={}) {
  const repo=new WorkReviewRepository(db),projects=new WorkProjectRepository(db),todos=new WorkTodoRepository(db);
  const project=projects.createProject({accountId,name:"合成：客户工单同步一期",description:null,operationKey:"create_project"}).project;
  const findings:Record<string,string>={},meetings:string[]=[];
  const titles:Record<string,string>={a:"一期同步方案",deploy:"A方案部署",rollback:"回滚重复写入问题",logs:"日志保留期限",vendor:"供应商配额回复",constraints:"客户约束清单",pause:"暂停A方案上线",b_proposal:"B方案候选",test:"回滚测试",b:"正式采用B方案",deploy_b:"调整B方案部署",test_done:"测试完成与回滚问题解决",monitor:"同步延迟监控",still:"仍待处理的事项"};
  const drafts:Array<Array<{key:string;kind:WorkCandidateKind;text:string;final?:boolean}>>=[
    [
      {key:"a",kind:"decision",text:"陈悦：一期正式采用方案A，实时直连供应商API。方案B只保留为备选。",final:true},
      {key:"deploy",kind:"commitment",text:"林晨：我负责A方案部署，10月28日前完成。"},
      {key:"rollback",kind:"open_question",text:"赵宁：回滚重复写入的问题还没验证，不能说解决了。"},
      {key:"logs",kind:"open_question",text:"周敏：日志保留30天是否合法还没定，负责人和截止时间都未明确。"},
      {key:"vendor",kind:"commitment",text:"周敏：我在10月9日前等供应商回复配额。"},
      {key:"constraints",kind:"commitment",text:"周敏：我来整理客户约束清单，10月9日前给大家。"},
    ],
    [
      {key:"pause",kind:"decision",text:"陈悦：供应商每秒仅2个请求，峰值需求20个；正式暂停方案A上线，但还没有批准B替代A。",final:true},
      {key:"b_proposal",kind:"proposal",text:"周敏：建议用B方案批量同步，今天只是候选，下次看结果再决定。"},
      {key:"test",kind:"commitment",text:"赵宁：我负责回滚和重复写入测试，10月16日前完成。"},
    ],
    [
      {key:"b",kind:"decision",text:"陈悦：客户已接受三分钟延迟，测试通过。正式决定一期用B替代A，原因是A的配额不能满足峰值；A不再作为本期上线方案。",final:true},
      {key:"deploy_b",kind:"commitment",text:"林晨：原部署任务调整为B配置，10月30日完成，不再新建一条部署任务。"},
      {key:"test_done",kind:"decision",text:"赵宁：回滚和重复写入测试已全部完成。陈悦：确认回滚问题已解决。",final:true},
      {key:"monitor",kind:"commitment",text:"林晨：我来新增同步延迟监控，10月29日前完成。"},
      {key:"still",kind:"open_question",text:"周敏：日志期限仍未解决；供应商还没回复。客户约束清单今天没有后续记录，不能因此认定现实没做。"},
    ],
  ];
  drafts.forEach((rows,index)=>{
    rows=rows.map(row=>({...row,text:texts[row.key]??row.text}));
    const date=["2026-10-06","2026-10-13","2026-10-27"][index];
    const created=repo.reserveMeeting({accountId,idempotencyKey:`meeting_${index}`,sourceUploadId:`upload_${accountId}_${index}`,contentHash:String(index+1).repeat(64),title:`合成M${index+1}`,meetingDate:date});
    const meetingId=created.meeting.id;meetings.push(meetingId);
    repo.publishSourceUpload({accountId,meetingId,uploadId:created.meeting.sourceUploadId,originalName:"synthetic.wav",mimeType:"audio/wav",sizeBytes:32,recordingDate:date,filePath:"synthetic-not-read.wav",contentHash:String(index+1).repeat(64)});
    repo.queueStage({accountId,meetingId,stage:"transcription"});
    const fence=repo.claimProcessingAttempt({accountId,meetingId,stage:"transcription",leaseOwner:"fixture",leaseDurationMs:60000,pipelineVersion:"fixture",providerProfile:"fixture"})!;
    const publication=repo.publishCanonicalTranscript({accountId,meetingId,fence,segments:rows.map((r,i)=>({id:`segment_${r.key}`,uploadId:created.meeting.sourceUploadId,startSeconds:i*20,endSeconds:i*20+18,speaker:"合成发言人",text:r.text,confidence:1,sceneLabels:[],valueLabels:[]}))}).publication;
    repo.queueStage({accountId,meetingId,stage:"meeting_analysis"});
    const analysis=repo.claimProcessingAttempt({accountId,meetingId,stage:"meeting_analysis",leaseOwner:"fixture",leaseDurationMs:60000,pipelineVersion:"fixture",providerProfile:"fixture"})!;
    repo.markAnalysisVerifying({accountId,meetingId,fence:analysis});
    const candidates=repo.publishAnalysisResult({accountId,meetingId,fence:analysis,canonicalContentDigest:publication.contentDigest,candidates:rows.map(r=>({kind:r.kind,title:titles[r.key],body:r.text,
      structuredData:WorkMeetingCandidateStructuredDataSchema.parse({decisionFinality:r.final?"final":null,actionBasis:r.kind==="commitment"?"explicit_commitment":null}),
      publicationAction:"show_as_candidate",riskLevel:"high",generatorProfile:"synthetic",generatorPromptVersion:"synthetic",evidenceSegmentIds:[`segment_${r.key}`],timestampQualityBySegmentId:{[`segment_${r.key}`]:"synthetic"},claims:[]}))});
    candidates.forEach((candidate,i)=>{const result=repo.reviewCandidate({accountId,meetingId,candidateId:candidate.id,expectedVersion:candidate.version,operationKey:`confirm_${index}_${i}`,action:"accept"});findings[rows[i].key]=result.finding!.id;});
    repo.completeReview({accountId,meetingId,expectedVersion:repo.getMeeting(accountId,meetingId).version,operationKey:`complete_${index}`});
    projects.setMeetingProjects({accountId,meetingId,expectedVersion:repo.getMeeting(accountId,meetingId).version,projectIds:[project.id],operationKey:`link_${index}`});
  });
  function todo(key:string,title:string,meetingIndex:number,kind:"self"|"waiting_for_other"="self") {
    return todos.createTodoFromFinding({accountId,meetingId:meetings[meetingIndex],findingId:findings[key],operationKey:`todo_${key}`,title,kind,ownerLabel:key==="test"?"赵宁":kind==="self"?"林晨":"周敏",currentDueDate:key==="test"?"2026-10-16":kind==="self"?"2026-10-28":"2026-10-09",notes:null,myDayDate:null,isImportant:false,projectIds:[project.id],ownershipOverrideConfirmed:false}).todo;
  }
  const deployment=todo("deploy","A方案部署",0),test=todo("test","回滚测试",1),vendor=todo("vendor","等待供应商回复",0,"waiting_for_other");
  const rel=(key:string,relation:"records"|"suspends"|"supersedes"|"resolves",anchor:string,finding:string,label:string)=>({key,kind:"relation" as const,relation,anchorFindingId:findings[anchor],findingId:findings[finding],todoId:null,label,sourceFindingIds:[...new Set([findings[anchor],findings[finding]])]});
  const m2:WorkAgentComparison={items:[{category:"changed",text:"A已暂停，B仍是提议。",status:"suggestion",sourceFindingIds:[findings.a,findings.pause,findings.b_proposal]}],changes:[
    rel("record_a","records","a","a","M1正式采用A"),rel("pause_a","suspends","a","pause","M2因配额暂停A，B尚未批准"),
    rel("record_q","records","rollback","rollback","回滚问题未关闭"),rel("record_logs","records","logs","logs","日志期限未解决"),
  ]};
  const m3:WorkAgentComparison={items:[
    {category:"added",text:"新增监控安排。",status:"confirmed_fact",sourceFindingIds:[findings.monitor]},
    {category:"changed",text:"B替代A，部署需调整。",status:"suggestion",sourceFindingIds:[findings.a,findings.b,findings.deploy_b]},
    {category:"resolved",text:"测试已完成，建议关闭回滚问题。",status:"suggestion",sourceFindingIds:[findings.rollback,findings.test_done]},
    {category:"unresolved",text:"日志期限和供应商等待仍未解决。",status:"uncertain",sourceFindingIds:[findings.logs,findings.vendor,findings.still]},
    {category:"uncertain",text:"客户约束清单缺少后续记录，现实完成情况待核实。",status:"uncertain",sourceFindingIds:[findings.constraints,findings.still]},
  ],changes:[rel("replace","supersedes","a","b","M3正式以B替代A：配额不足，客户接受三分钟延迟"),
    {key:"update_deploy",kind:"update_todo",todoId:deployment.id,title:"B方案部署",ownerLabel:"林晨",dueDate:"2026-10-30",label:"调整原部署待办",sourceFindingIds:[findings.deploy_b]},
    {key:"complete_test",kind:"complete_todo",todoId:test.id,label:"完成测试待办",sourceFindingIds:[findings.test_done]},
    rel("close_q","resolves","rollback","test_done","回滚问题经测试确认已解决"),
    {key:"monitor",kind:"create_todo",findingId:findings.monitor,title:"同步延迟监控",todoKind:"self",ownerLabel:"林晨",dueDate:"2026-10-29",label:"创建监控待办",sourceFindingIds:[findings.monitor]},
    {key:"reject_vendor",kind:"complete_todo",todoId:vendor.id,label:"待用户拒绝的错误建议：完成供应商等待",sourceFindingIds:[findings.still]},
  ]};
  return {accountId,project,findings,meetings,deployment,test,vendor,m2,m3,repo,projects,todos};
}
