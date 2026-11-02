// @vitest-environment node
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {openWorkReviewDatabase} from "./db";
import {seedWorkAgentCase} from "./agent-test-fixture";
import {WorkAgentRepository} from "./agent-repository";
import {openWorkAgentRuntime,readWorkAgentProject,startWorkAgent} from "./agent-service";
import type {WorkAgentComparison} from "@/lib/domain/work-agent";
import type {AgentTask} from "@/lib/domain/agent";
import {readWorkAgentContext} from "./agent-context";
import {reviewWorkAgentChange} from "./agent-consistency";
import * as consistency from "./agent-consistency";

let root:string,db:ReturnType<typeof openWorkReviewDatabase>,f:ReturnType<typeof seedWorkAgentCase>;
let runner:ReturnType<typeof openWorkAgentRuntime>;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"work-agent-consistency-"));db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});f=seedWorkAgentCase(db);
  vi.stubGlobal("fetch",vi.fn(()=>{throw Error("network_forbidden");}));
});
afterEach(()=>{runner?.runtime.close();db.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllGlobals();});
function start(answer:WorkAgentComparison=f.m3,index=2){
  runner?.runtime.close();runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoint.sqlite"),compare:async()=>structuredClone(answer),
    decision:async()=>({tool:"work.compare_meeting",args:{}})});
  return startWorkAgent(db,f.accountId,f.project.id,{id:randomUUID(),meetingId:f.meetings[index],goal:"整理后续工作"});
}
async function apply(task:AgentTask,keys:string[]){
  const p=new WorkAgentRepository(db).read(task)!.preview!;
  task=await runner.runtime.submitEvent(f.accountId,task.id,{id:randomUUID(),kind:"work_selection",refId:p.id,version:1,
    message:JSON.stringify({previewId:p.id,fingerprint:p.fingerprint,keys})},{expectedVersion:1});
  return runner.runtime.resolveApproval(f.accountId,task.id,{approvalId:task.approval!.id,fingerprint:task.approval!.fingerprint,expectedVersion:1,decision:"approve",eventId:randomUUID()});
}
describe("Work Agent evidence/action consistency and Todo projection",{timeout:20_000},()=>{
  it("blocks the observed negative-evidence completion and unchanged deployment payload before selection",async()=>{
    const answer=structuredClone(f.m3),change=answer.changes.find(c=>c.key==="update_deploy")!;
    if(change.kind!=="update_todo")throw Error("fixture");change.label="调整B方案部署";change.title="A方案部署";
    const task=await runnerAdvance(start(answer)),repo=new WorkAgentRepository(db),p=repo.read(task)!.preview!;
    expect(p.changes.find(c=>c.change.key==="reject_vendor")?.review).toMatchObject({status:"blocked"});
    expect(p.changes.find(c=>c.change.key==="update_deploy")?.review).toMatchObject({status:"blocked"});
    expect(()=>repo.select(task,{previewId:p.id,fingerprint:p.fingerprint,keys:["reject_vendor"]})).toThrow(/依据|矛盾|核实/);
    expect(()=>repo.select(task,{previewId:p.id,fingerprint:p.fingerprint,keys:["update_deploy"]})).toThrow(/内容|调整|矛盾/);
    expect(f.todos.getTodo(f.accountId,f.vendor.id).status).toBe("open");
    expect(f.todos.getTodo(f.accountId,f.deployment.id).title).toBe("A方案部署");
  });
  it("keeps the five correct M3 operations confirmable and persists original identities, receipts and sources",async()=>{
    const task=await runnerAdvance(start()),repo=new WorkAgentRepository(db),p=repo.read(task)!.preview!;
    const keys=p.changes.filter(c=>c.review?.status==="confirmable").map(c=>c.change.key);
    expect(keys).toEqual(["replace","update_deploy","complete_test","close_q","monitor"]);
    const result=await apply(task,keys);expect(result.status).toBe("ended");
    expect(f.todos.getTodo(f.accountId,f.deployment.id)).toMatchObject({id:f.deployment.id,title:"B方案部署",sourceFindingId:f.findings.deploy,currentDueDate:"2026-10-30"});
    expect(f.todos.getTodo(f.accountId,f.test.id).status).toBe("completed");
    expect(f.todos.getTodo(f.accountId,f.vendor.id)).toEqual(f.vendor);
    expect(db.prepare("SELECT count(*) n FROM wr_todo_events").get()).toEqual({n:6});
    expect(repo.read(result)?.applied).toMatchObject({rejectedKeys:["reject_vendor"],todoIds:[f.deployment.id,f.test.id,expect.any(String)]});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps an independent tracked question unresolved after its Todo completes, then resolves only on confirmed evidence",async()=>{
    const answer=structuredClone(f.m2);
    answer.changes.push({key:"track_question",kind:"relation",relation:"tracks",anchorFindingId:f.findings.rollback,findingId:f.findings.test,todoId:f.test.id,label:"测试跟进回滚问题",sourceFindingIds:[f.findings.rollback,f.findings.test]});
    let task=await runnerAdvance(start(answer,1));await apply(task,answer.changes.map(c=>c.key));
    task=await runnerAdvance(start());await apply(task,["complete_test"]);
    let view=readWorkAgentProject(db,f.accountId,f.project.id);
    const question=view.threads.find(t=>t.anchorFindingId===f.findings.rollback)!;
    expect(question).toMatchObject({state:"open",kind:"question",linkedTodos:[{id:f.test.id,status:"completed"}]});
    expect(view.openLoops.find(l=>l.threadId===question.id)?.text).toContain("关联待办已完成");
    expect(view.openLoops.some(l=>l.todoId===f.test.id)).toBe(false);
    task=await runnerAdvance(start());await apply(task,["close_q"]);
    view=readWorkAgentProject(db,f.accountId,f.project.id);
    expect(view.threads.find(t=>t.id===question.id)?.state).toBe("resolved");
    expect(view.openLoops.some(l=>l.threadId===question.id)).toBe(false);
    expect(view.openLoops.some(l=>l.text.includes("日志保留期限"))).toBe(true);
    expect(view.openLoops.some(l=>l.todoId===f.vendor.id)).toBe(true);
  });
  it("rechecks a pending pre-fix approval without rewriting its preview or applying the unsafe item",async()=>{
    // Simulate the former checker contract through the real services; no business
    // state is inserted to manufacture success, and raw suggestions are retained.
    const old=vi.spyOn(consistency,"reviewWorkAgentChange").mockReturnValue({status:"confirmable",reason:"legacy",sourceFindingIds:[]});
    let task=await runnerAdvance(start());const repo=new WorkAgentRepository(db),p=repo.read(task)!.preview!;
    task=await runner.runtime.submitEvent(f.accountId,task.id,{id:randomUUID(),kind:"work_selection",refId:p.id,version:1,
      message:JSON.stringify({previewId:p.id,fingerprint:p.fingerprint,keys:["reject_vendor"]})},{expectedVersion:1});
    const before=db.prepare("SELECT preview_json FROM wr_work_agent_artifacts WHERE task_id=?").get(task.id);
    old.mockRestore();
    expect(repo.read(task)?.preview?.changes.find(c=>c.change.key==="reject_vendor")?.review?.status).toBe("blocked");
    await expect(runner.runtime.resolveApproval(f.accountId,task.id,{approvalId:task.approval!.id,fingerprint:task.approval!.fingerprint,expectedVersion:1,decision:"approve",eventId:randomUUID()})).rejects.toThrow();
    expect(db.prepare("SELECT preview_json FROM wr_work_agent_artifacts WHERE task_id=?").get(task.id)).toEqual(before);
    expect(repo.read(task)?.applied).toBeNull();expect(f.todos.getTodo(f.accountId,f.vendor.id)).toEqual(f.vendor);
  });
  it.each([
    ["财务对账尚未完成。","blocked"],
    ["财务对账已完成；合同条款尚未确认。","confirmable"],
    ["财务对账是否已完成？","needs_review"],
    ["财务对账完成了吗？","needs_review"],
    ["财务对账已完成？","needs_review"],
    ["如果财务对账未完成，明天再看。","needs_review"],
    ["如果财务对账已完成，明天发布。","needs_review"],
    ["财务对账没有后续记录。","needs_review"],
    ["财务对账此前尚未完成；财务对账现在已全部完成。","confirmable"],
    ["合同条款已完成。","needs_review"],
    ["财务对账还没完成；财务对账已完成。","blocked"],
  ])("checks subject-scoped completion without fixture names: %s",(text,status)=>{
    const context=readWorkAgentContext(db,f.accountId,f.project.id,f.meetings[2]);
    context.todos.find(t=>t.id===f.vendor.id)!.title="财务对账";
    const source=context.sources.find(s=>s.findingId===f.findings.still)!;source.evidence[0].text=text;
    const change=f.m3.changes.find(c=>c.key==="reject_vendor")!;
    expect(reviewWorkAgentChange(context,change).status).toBe(status);
  });
  it.each([
    ["旧接口迁移调整为赤狐配置，10月30日完成。","赤狐接口迁移","confirmable"],
    ["旧接口迁移调整为赤狐配置，10月30日完成。","蓝鲸接口迁移","blocked"],
    ["旧接口迁移调整为赤狐配置，10月30日完成。","调整接口迁移","blocked"],
    ["旧接口迁移如果调整为赤狐配置，10月30日完成。","赤狐接口迁移","needs_review"],
    ["旧接口迁移调整为赤狐配置，10月30日完成。","不采用赤狐接口迁移","blocked"],
    ["旧接口迁移调整为赤狐配置，10月30日完成。","考虑赤狐接口迁移","needs_review"],
  ])("checks actual update payload against literal instructions: %s / %s",(text,title,status)=>{
    const context=readWorkAgentContext(db,f.accountId,f.project.id,f.meetings[2]);
    context.todos.find(t=>t.id===f.deployment.id)!.title="旧接口迁移";
    context.sources.find(s=>s.findingId===f.findings.deploy_b)!.evidence[0].text=text;
    const change=structuredClone(f.m3.changes.find(c=>c.key==="update_deploy")!);
    if(change.kind!=="update_todo")throw Error("fixture");change.title=title;
    expect(reviewWorkAgentChange(context,change).status).toBe(status);
  });
  it.each([
    ["supersedes","正式决定暂缓原方案，但没有批准新方案替代原方案。","blocked"],
    ["supersedes","正式决定采用新方案替代原方案。","confirmable"],
    ["withdraws","原决定尚未撤回。","blocked"],
    ["resolves","回滚问题仍未解决。","blocked"],
  ] as const)("checks relation predicate %s against its own canonical evidence",(relation,text,status)=>{
    const context=readWorkAgentContext(db,f.accountId,f.project.id,f.meetings[2]);
    const change=structuredClone(f.m3.changes.find(c=>c.key===(relation==="resolves"?"close_q":"replace"))!);
    if(change.kind!=="relation")throw Error("fixture");change.relation=relation;
    context.sources.find(s=>s.findingId===change.findingId)!.evidence[0].text=text;
    expect(reviewWorkAgentChange(context,change).status).toBe(status);
  });
  it.each(["owner","deadline"])("does not demand a title change for a supported %s-only update",field=>{
    const context=readWorkAgentContext(db,f.accountId,f.project.id,f.meetings[2]);
    const change=structuredClone(f.m3.changes.find(c=>c.key==="update_deploy")!);
    if(change.kind!=="update_todo")throw Error("fixture");
    change.title=f.deployment.title;change.ownerLabel=field==="owner"?"周敏":f.deployment.ownerLabel;
    change.dueDate=field==="deadline"?"2026-10-30":f.deployment.currentDueDate;
    context.sources.find(s=>s.findingId===f.findings.deploy_b)!.evidence[0].text=field==="owner"?"部署任务负责人改为周敏。":"部署任务截止日期调整为10月30日。";
    expect(reviewWorkAgentChange(context,change).status).toBe("confirmable");
  });
  it("does not present a completed tracked commitment as an unresolved question",async()=>{
    const answer=structuredClone(f.m2);
    answer.changes.push({key:"track_test",kind:"relation",relation:"tracks",anchorFindingId:f.findings.test,findingId:f.findings.test,todoId:f.test.id,label:"跟进测试工作",sourceFindingIds:[f.findings.test]});
    let task=await runnerAdvance(start(answer,1));await apply(task,answer.changes.map(c=>c.key));
    task=await runnerAdvance(start());await apply(task,["complete_test"]);
    const view=readWorkAgentProject(db,f.accountId,f.project.id),thread=view.threads.find(t=>t.anchorFindingId===f.findings.test)!;
    expect(f.todos.getTodo(f.accountId,f.test.id).status).toBe("completed");
    expect(view.openLoops.filter(x=>x.todoId===f.test.id||x.threadId===thread.id)).toEqual([]);
    expect(view.threads.find(t=>t.anchorFindingId===f.findings.rollback)?.state).toBe("open");
  });
});
async function runnerAdvance(task:AgentTask){return runner.runtime.advance(f.accountId,task.id);}
