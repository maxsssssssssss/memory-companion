// @vitest-environment node
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {WorkAgentComparison} from "@/lib/domain/work-agent";
import {openWorkReviewDatabase} from "./db";
import {seedWorkAgentCase} from "./agent-test-fixture";
import {WorkAgentRepository} from "./agent-repository";
import {readWorkAgentSource} from "./agent-context";
import {openWorkAgentRuntime,readWorkAgentProject,startWorkAgent} from "./agent-service";

let root:string,db:ReturnType<typeof openWorkReviewDatabase>,f:ReturnType<typeof seedWorkAgentCase>,runner:ReturnType<typeof openWorkAgentRuntime>;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"work-p2-"));db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});f=seedWorkAgentCase(db);vi.stubGlobal("fetch",vi.fn(()=>{throw Error("network_forbidden");}));});
afterEach(()=>{runner?.runtime.close();db.close();rmSync(root,{recursive:true,force:true});vi.unstubAllGlobals();});
const view=()=>readWorkAgentProject(db,f.accountId,f.project.id);
async function apply(answer:WorkAgentComparison,index:number,keys=answer.changes.map(c=>c.key),decision:"approve"|"reject"="approve"){
  runner?.runtime.close();runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoint.sqlite"),compare:async()=>structuredClone(answer),decision:async()=>({tool:"work.compare_meeting",args:{}})});
  let task=await runner.runtime.advance(f.accountId,startWorkAgent(db,f.accountId,f.project.id,{id:randomUUID(),meetingId:f.meetings[index],goal:"整理后续工作"}).id);
  const p=new WorkAgentRepository(db).read(task)!.preview!;
  task=await runner.runtime.submitEvent(f.accountId,task.id,{id:randomUUID(),kind:"work_selection",version:1,refId:p.id,message:JSON.stringify({previewId:p.id,fingerprint:p.fingerprint,keys})},{expectedVersion:1});
  task=await runner.runtime.resolveApproval(f.accountId,task.id,{eventId:randomUUID(),approvalId:task.approval!.id,fingerprint:task.approval!.fingerprint,expectedVersion:1,decision});
  expect(task.status,JSON.stringify(task)).toBe("ended");return task;
}
function trackDecision(){
  f.m2.changes.push({key:"track_deploy",kind:"relation",relation:"tracks",anchorFindingId:f.findings.a,findingId:f.findings.deploy,todoId:f.deployment.id,label:"部署跟进一期决定",sourceFindingIds:[f.findings.a,f.findings.deploy]});
}
describe("P2 shared project facts, real repositories and persistent Runtime",{timeout:20_000},()=>{
  it("shows legacy confirmed facts and outstanding work without inventing relations",()=>{
    const result=view();expect(result.threads).toEqual([]);
    expect(result.timeline.find(t=>t.id===`fact:${f.findings.b_proposal}`)).toMatchObject({status:"candidate",canRetract:false});
    expect(result.timeline.find(t=>t.id===`fact:${f.findings.a}`)).toMatchObject({status:"fact",date:"2026-10-06"});
    expect(result.timeline.map(t=>t.date)).toEqual(result.timeline.map(t=>t.date).sort());
    expect(result.openLoops.find(l=>l.id===`finding:${f.findings.constraints}`)).toMatchObject({status:"no_follow_up",basis:"needs_verification"});
    expect(result.openLoops.find(l=>l.id===`finding:${f.findings.constraints}`)?.reasons.join()).toContain("负责人尚未结构化记录");
    expect(result.openLoops.find(l=>l.todoId===f.vendor.id)?.status).toBe("waiting");
    expect(result.openLoops.find(l=>l.id===`finding:${f.findings.logs}`)?.status).toBe("unresolved");
    expect(result.openLoops.filter(l=>l.sources.some(s=>s.findingId===f.findings.deploy))).toHaveLength(1);
    expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events").get()).toEqual({n:0});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("projects A, suspension, B and a Todo adjustment from the same confirmed events",async()=>{
    const originalFindings=db.prepare("SELECT id,body,version FROM wr_findings ORDER BY id").all();
    const m1:WorkAgentComparison={items:[{category:"added",text:"M1正式采用A，回滚和日志问题仍待处理。",status:"confirmed_fact",sourceFindingIds:[f.findings.a,f.findings.logs,f.findings.rollback]}],
      changes:f.m2.changes.filter(c=>c.key.startsWith("record_"))};
    await apply(m1,0);expect(view().threads.find(t=>t.anchorFindingId===f.findings.a)).toMatchObject({state:"active",currentFindingId:f.findings.a});
    trackDecision();await apply(f.m2,1);
    let result=view();const decision=result.threads.find(t=>t.anchorFindingId===f.findings.a)!;
    expect(decision).toMatchObject({state:"suspended",currentFindingId:null});
    expect(result.openLoops.find(l=>l.todoId===f.deployment.id)?.status).toBe("needs_review");
    expect(result.timeline.find(t=>t.id===`fact:${f.findings.b_proposal}`)?.status).toBe("candidate");
    f.m3.changes.push({key:"repeat_logs",kind:"relation",relation:"records",anchorFindingId:f.findings.logs,findingId:f.findings.still,todoId:null,label:"M3再次确认日志期限仍未解决",sourceFindingIds:[f.findings.logs,f.findings.still]});
    await apply(f.m3,2,f.m3.changes.filter(c=>c.key!=="reject_vendor").map(c=>c.key));
    result=view();expect(result.threads.find(t=>t.id===decision.id)).toMatchObject({state:"active",currentFindingId:f.findings.b});
    expect(result.timeline.filter(t=>t.threadId===decision.id).map(t=>t.label)).toEqual(["记录事实","关联待办","暂停决定","替代决定"]);
    expect(result.openLoops.find(l=>l.todoId===f.deployment.id)).toMatchObject({title:"B方案部署",status:"open"});
    expect(result.openLoops.some(l=>l.todoId===f.test.id)).toBe(false);
    expect(result.openLoops.find(l=>l.todoId===f.vendor.id)?.status).toBe("waiting");
    expect(result.openLoops.filter(l=>l.threadId===result.threads.find(t=>t.anchorFindingId===f.findings.logs)!.id)).toHaveLength(1);
    expect(result.openLoops.find(l=>l.title==="日志保留期限")?.reasons.join()).toContain("2 场会议");
    expect(result.openLoops.some(l=>l.title==="回滚重复写入问题")).toBe(false);
    expect(result.openLoops.find(l=>l.title==="同步延迟监控")?.sources[0].findingId).toBe(f.findings.monitor);
    for(const item of result.timeline)for(const source of item.sources)expect(readWorkAgentSource(db,f.accountId,f.project.id,source.findingId).evidence.length).toBeGreaterThan(0);
    const before=db.prepare("SELECT * FROM wr_todo_events ORDER BY rowid").all();
    runner.runtime.close();expect(view()).toEqual(result);expect(db.prepare("SELECT * FROM wr_todo_events ORDER BY rowid").all()).toEqual(before);
    expect(f.todos.getTodo(f.accountId,f.deployment.id).sourceFindingId).toBe(f.findings.deploy);
    expect(db.prepare("SELECT id,body,version FROM wr_findings ORDER BY id").all()).toEqual(originalFindings);
    expect(db.pragma("integrity_check")).toEqual([{integrity_check:"ok"}]);
  });
  it("does not change confirmed states for a pending or rejected model suggestion",async()=>{
    const rejected=await apply(f.m3,2,[]);
    expect(view().threads).toEqual([]);expect(f.todos.getTodo(f.accountId,f.deployment.id).title).toBe("A方案部署");
    expect(new WorkAgentRepository(db).read(rejected)?.applied?.selectedKeys).toEqual([]);
    // A comparison-only task has suggestions, never confirmed relations.
    runner.runtime.close();runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"comparison.sqlite"),compare:async()=>structuredClone(f.m3),decision:async input=>input.results.length?{finish:"比较完成"}:{tool:"work.compare_meeting",args:{}}});
    await runner.runtime.advance(f.accountId,startWorkAgent(db,f.accountId,f.project.id,{id:randomUUID(),meetingId:f.meetings[2],goal:"比较变化"}).id);
    expect(view().openLoops.some(l=>l.basis==="agent_suggestion"&&l.status==="suggestion")).toBe(true);
    expect(view().timeline.some(t=>t.status==="confirmed_relation")).toBe(false);
  });
  it("does not resurface explicitly rejected suggestions as awaiting confirmation",async()=>{
    await apply(f.m3,2,["replace"],"reject");
    expect(view().openLoops.some(l=>l.status==="suggestion")).toBe(false);
    expect(view().threads).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events").get()).toEqual({n:0});
  });
  it("groups a waiting Todo under its unresolved question without losing either state",async()=>{
    f.m2.changes.push({key:"track_wait",kind:"relation",relation:"tracks",anchorFindingId:f.findings.rollback,findingId:f.findings.vendor,todoId:f.vendor.id,label:"供应商回复用于核对回滚问题",sourceFindingIds:[f.findings.rollback,f.findings.vendor]});
    await apply(f.m2,1);
    const result=view(),thread=result.threads.find(t=>t.anchorFindingId===f.findings.rollback)!;
    expect(result.openLoops.find(l=>l.threadId===thread.id)).toMatchObject({status:"unresolved",waitingForOther:true,linkedTodos:[{id:f.vendor.id,status:"open"}]});
    expect(result.openLoops.some(l=>l.todoId===f.vendor.id)).toBe(false);
  });
  it("keeps approved follow-up provenance beyond the generic 50-task window",async()=>{
    await apply(f.m3,2,["replace","update_deploy"]);
    for(let i=0;i<51;i++)startWorkAgent(db,f.accountId,f.project.id,{id:randomUUID(),meetingId:f.meetings[2],goal:`合成未执行比较 ${i+1}`});
    const result=view();expect(result.tasks).toHaveLength(52);
    expect(result.openLoops.some(l=>l.id===`finding:${f.findings.deploy_b}`)).toBe(false);
    expect(result.openLoops.find(l=>l.todoId===f.deployment.id)?.sources.some(s=>s.findingId===f.findings.deploy_b)).toBe(true);
  });
  it.each(["unlink","delete"])("keeps invalid history without restoring A after M3 %s",async(mode)=>{
    await apply(f.m2,1);await apply(f.m3,2,["replace","close_q","monitor"]);
    const monitor=view().openLoops.find(l=>l.title==="同步延迟监控")!;
    if(mode==="unlink")f.projects.setMeetingProjects({accountId:f.accountId,meetingId:f.meetings[2],expectedVersion:f.repo.getMeeting(f.accountId,f.meetings[2]).version,projectIds:[],operationKey:"unlink_m3"});
    else f.repo.deleteMeeting({accountId:f.accountId,meetingId:f.meetings[2],linkedTodoPolicy:"detach_linked_todos"});
    const result=view();expect(result.threads.find(t=>t.anchorFindingId===f.findings.a)).toMatchObject({state:"unknown",currentFindingId:null});
    const invalid=result.timeline.filter(t=>t.status==="source_invalid");expect(invalid.length).toBeGreaterThan(0);expect(invalid.every(t=>!t.sources.length&&!t.canRetract)).toBe(true);
    expect(JSON.stringify(result.timeline)).not.toContain("客户已接受三分钟延迟");
    expect(result.openLoops.some(l=>l.status==="source_invalid")).toBe(true);
    expect(result.openLoops.find(l=>l.todoId===monitor.todoId)?.status).toBe("source_invalid");
    expect(result.openLoops.some(l=>l.kind==="question"&&l.title==="回滚重复写入问题")).toBe(false);
  });
  it("preserves a distinct retraction entry and isolates projects/accounts",async()=>{
    await apply(f.m2,1);await apply(f.m3,2,["replace"]);
    const thread=view().threads.find(t=>t.anchorFindingId===f.findings.a)!,event=thread.events.find(e=>e.relation==="supersedes")!;
    new WorkAgentRepository(db).retract(f.accountId,f.project.id,event.id,"retract_p2");
    const result=view();expect(result.threads.find(t=>t.id===thread.id)?.state).toBe("unknown");
    expect(result.timeline.find(t=>t.id===event.id)?.status).toBe("retracted");
    expect(result.timeline.some(t=>t.label==="撤回错误关联")).toBe(true);
    const other=f.projects.createProject({accountId:f.accountId,name:"其他项目",description:null,operationKey:"other"}).project;
    expect(readWorkAgentProject(db,f.accountId,other.id)).toMatchObject({threads:[],timeline:[],openLoops:[],tasks:[]});
    expect(()=>readWorkAgentProject(db,"account_b",f.project.id)).toThrow();
  });
  it("shows explicit withdrawal without restoring a candidate or changing the Todo",async()=>{
    f=seedWorkAgentCase(db,"withdraw_account",{b:"陈悦：正式撤回方案A，本期不再上线。方案B仍然只是候选。"});
    await apply(f.m2,1);
    const answer=structuredClone(f.m3);answer.changes=[{key:"withdraw",kind:"relation",relation:"withdraws",anchorFindingId:f.findings.a,findingId:f.findings.b,todoId:null,label:"撤回A",sourceFindingIds:[f.findings.a,f.findings.b]}];
    await apply(answer,2);
    const result=view();expect(result.threads.find(t=>t.anchorFindingId===f.findings.a)).toMatchObject({state:"withdrawn",currentFindingId:null});
    expect(result.timeline.some(t=>t.label==="撤回决定"&&t.status==="confirmed_relation")).toBe(true);
    expect(f.todos.getTodo(f.accountId,f.deployment.id).status).toBe("open");
    expect(result.openLoops.some(l=>l.threadId===result.threads.find(t=>t.anchorFindingId===f.findings.a)!.id)).toBe(false);
  });
  it("reopens an independent issue only through a new confirmed relation",async()=>{
    f=seedWorkAgentCase(db,"reopen_account",{still:"陈悦：发现新的回滚重复写入问题，正式重新打开回滚问题，继续核查。"});
    await apply(f.m2,1);await apply(f.m3,2,["complete_test","close_q"]);
    expect(view().threads.find(t=>t.anchorFindingId===f.findings.rollback)?.state).toBe("resolved");
    const answer=structuredClone(f.m3);answer.changes=[{key:"reopen",kind:"relation",relation:"reopens",anchorFindingId:f.findings.rollback,findingId:f.findings.still,todoId:null,label:"重新打开回滚问题",sourceFindingIds:[f.findings.rollback,f.findings.still]}];
    await apply(answer,2);
    const result=view(),thread=result.threads.find(t=>t.anchorFindingId===f.findings.rollback)!;
    expect(thread.state).toBe("open");expect(result.openLoops.find(l=>l.threadId===thread.id)?.status).toBe("unresolved");
    expect(f.todos.getTodo(f.accountId,f.test.id).status).toBe("completed");
    expect(result.timeline.filter(t=>t.threadId===thread.id).map(t=>t.label)).toEqual(["记录事实","解决问题","重新打开问题"]);
  });
});
