// @vitest-environment node
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {AgentTask} from "@/lib/domain/agent";
import type {WorkAgentChange,WorkAgentComparison} from "@/lib/domain/work-agent";
import {openWorkReviewDatabase} from "./db";
import {seedWorkAgentCase} from "./agent-test-fixture";
import {openWorkAgentRuntime,readWorkAgentProject,startWorkAgent} from "./agent-service";
import {WorkAgentRepository} from "./agent-repository";

let root:string,db:ReturnType<typeof openWorkReviewDatabase>,f:ReturnType<typeof seedWorkAgentCase>;
let runner:ReturnType<typeof openWorkAgentRuntime>,answer:WorkAgentComparison;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"work-agent-endpoints-"));db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});f=seedWorkAgentCase(db);
  answer=structuredClone(f.m3);answer.changes=answer.changes.filter(c=>c.key!=="reject_vendor");
  for(const c of answer.changes)if(c.kind==="relation")c.sourceFindingIds=[c.findingId];
  vi.stubGlobal("fetch",vi.fn(()=>{throw Error("network_forbidden");}));
  runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoint.sqlite"),compare:async()=>answer,decision:async()=>({tool:"work.compare_meeting",args:{}})});
});
afterEach(()=>{runner.runtime.close();db.close();rmSync(root,{recursive:true,force:true});expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();});
const start=()=>startWorkAgent(db,f.accountId,f.project.id,{id:randomUUID(),meetingId:f.meetings[2],goal:"整理后续工作"});
const repo=()=>new WorkAgentRepository(db);
const relation=(key="replace")=>answer.changes.find(c=>c.key===key) as Extract<WorkAgentChange,{kind:"relation"}>;
async function select(task:AgentTask,keys=answer.changes.map(c=>c.key)){
  const p=repo().read(task)!.preview!;
  return runner.runtime.submitEvent(f.accountId,task.id,{id:randomUUID(),kind:"work_selection",refId:p.id,version:1,message:JSON.stringify({previewId:p.id,fingerprint:p.fingerprint,keys})},{expectedVersion:1});
}
const approve=(task:AgentTask)=>runner.runtime.resolveApproval(f.accountId,task.id,{approvalId:task.approval!.id,expectedVersion:1,fingerprint:task.approval!.fingerprint,decision:"approve",eventId:randomUUID()});

describe("Deterministic relation endpoint provenance before fixed preview",{timeout:20000},()=>{
  it("preserves supplied citations and raw input, adds either missing endpoint once, and fixes the normalized preview",()=>{
    relation().sourceFindingIds=[f.findings.pause,f.findings.b]; // retain additional valid evidence
    relation("close_q").sourceFindingIds=[f.findings.rollback]; // missing the other endpoint
    const raw=JSON.stringify(answer),task=start(),saved=repo().saveComparison(task,answer);
    expect(JSON.stringify(answer)).toBe(raw);
    expect(saved.comparison!.changes[0].sourceFindingIds).toEqual([f.findings.pause,f.findings.b,f.findings.a].sort());
    expect(saved.comparison!.changes.find(c=>c.key==="close_q")!.sourceFindingIds).toEqual([f.findings.rollback,f.findings.test_done].sort());
    const preview=repo().preview(task);expect(preview.changes).toHaveLength(5);expect(preview.changes.every(c=>c.review?.status==="confirmable")).toBe(true);
    // A later save cannot replace the payload or recompute an existing fingerprint.
    answer.changes=[];expect(repo().saveComparison(task,answer).preview).toEqual(preview);expect(repo().preview(task)).toEqual(preview);
    expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events").get()).toEqual({n:0});
  });
  it("deduplicates identical record endpoints without adding another reference",()=>{
    const c=relation();c.relation="records";c.findingId=c.anchorFindingId;c.sourceFindingIds=[c.anchorFindingId];
    expect(repo().saveComparison(start(),answer).comparison!.changes[0].sourceFindingIds).toEqual([f.findings.a]);
  });
  it.each(["anchorFindingId","findingId"] as const)("does not invent a missing %s field or a nonexistent endpoint",field=>{
    const c=relation();delete (c as Partial<typeof c>)[field];
    expect(()=>repo().saveComparison(start(),answer)).toThrow();
    c[field]="wrf_nonexistent";c.sourceFindingIds=[f.findings.pause];
    expect(()=>repo().saveComparison(start(),answer)).toThrow("关系缺少两端");
    expect(db.prepare("SELECT count(*) n FROM wr_work_agent_artifacts").get()).toEqual({n:0});
  });
  it.each(["anchorFindingId","findingId"] as const)("rejects another account's %s even when it exists in the same database",field=>{
    const other=seedWorkAgentCase(db,"account_b"),c=relation();c[field]=other.findings.a;c.sourceFindingIds=[f.findings.pause];
    expect(()=>repo().saveComparison(start(),answer)).toThrow("关系缺少两端");
    expect(()=>startWorkAgent(db,"account_b",f.project.id,{id:randomUUID(),meetingId:f.meetings[2],goal:"比较"})).toThrow();
  });
  it.each(["other_project","unlinked","deleted"])("rejects an anchor with %s provenance instead of filling from global Findings",mode=>{
    const project=mode==="other_project"?f.projects.createProject({accountId:f.accountId,name:"另一个项目",description:null,operationKey:"other"}).project:null;
    if(mode==="deleted")f.repo.deleteMeeting({accountId:f.accountId,meetingId:f.meetings[0],linkedTodoPolicy:"detach_linked_todos"});
    else f.projects.setMeetingProjects({accountId:f.accountId,meetingId:f.meetings[0],expectedVersion:f.repo.getMeeting(f.accountId,f.meetings[0]).version,projectIds:project?[project.id]:[],operationKey:"move_anchor"});
    const only:WorkAgentComparison={items:[{category:"changed",text:"候选关联",status:"suggestion",sourceFindingIds:[f.findings.b]}],changes:[relation()]};
    expect(()=>repo().saveComparison(start(),only)).toThrow("关系缺少两端");
    expect(db.prepare("SELECT count(*) n FROM wr_work_agent_artifacts").get()).toEqual({n:0});
  });
  it("rejects an invalidated anchor after the task snapshot and before the fixed preview can be approved",async()=>{
    const task=await runner.runtime.advance(f.accountId,start().id);expect(task.status).toBe("waiting");
    f.repo.deleteMeeting({accountId:f.accountId,meetingId:f.meetings[0],linkedTodoPolicy:"detach_linked_todos"});
    expect(repo().read(task)?.state).toBe("invalidated");
    await expect(select(task)).rejects.toThrow();
    expect(db.prepare("SELECT count(*) n FROM agent_approvals").get()).toEqual({n:0});
  });
  it("does not discard an unknown or duplicate supplied citation while completing endpoints",()=>{
    relation().sourceFindingIds=[f.findings.b,"wrf_unknown"];
    expect(()=>repo().saveComparison(start(),answer)).toThrow("只能引用");
    relation().sourceFindingIds=[f.findings.b,f.findings.b];
    expect(()=>repo().saveComparison(start(),answer)).toThrow("只能引用");
  });
  it("retains the existing eight-reference schema bound as a known rejection after normalization",async()=>{
    relation().sourceFindingIds=Object.values(f.findings).filter(id=>id!==f.findings.a&&id!==f.findings.b).slice(0,8);
    expect(()=>repo().saveComparison(start(),answer)).toThrow();
    const task=await runner.runtime.advance(f.accountId,start().id);
    expect(task.status).toBe("needs_attention");expect(task.recovery?.kind).toBe("known_failed");
    expect(db.prepare("SELECT count(*) n FROM wr_work_agent_artifacts").get()).toEqual({n:0});
  });
  it("does not promote the proposal to a final decision by adding its anchor reference",()=>{
    relation().findingId=f.findings.b_proposal;relation().sourceFindingIds=[f.findings.b_proposal];
    expect(()=>repo().saveComparison(start(),answer)).toThrow("新提议");
  });
  it("keeps unsupported problem resolution unapprovable while independent Todo operations can be confirmed",async()=>{
    relation("close_q").findingId=f.findings.still;relation("close_q").sourceFindingIds=[f.findings.still];
    let task=await runner.runtime.advance(f.accountId,start().id);const p=repo().read(task)!.preview!;
    expect(p.changes.find(c=>c.change.key==="close_q")?.review?.status).toBe("needs_review");
    expect(()=>repo().select(task,{previewId:p.id,fingerprint:p.fingerprint,keys:["close_q"]})).toThrow("不能批准");
    task=await approve(await select(task,["update_deploy","complete_test","monitor"]));expect(task.status).toBe("ended");
    expect(f.todos.getTodo(f.accountId,f.deployment.id).title).toBe("B方案部署");expect(f.todos.getTodo(f.accountId,f.test.id).status).toBe("completed");
    expect(readWorkAgentProject(db,f.accountId,f.project.id).openLoops.some(l=>l.title==="回滚重复写入问题")).toBe(true);
    expect(repo().read(task)?.applied?.rejectedKeys).toEqual(["replace","close_q"]);
    expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events WHERE relation='resolves'").get()).toEqual({n:0});
  });
  it("rolls normalized relationships and earlier Todo updates back if a later Todo creation fails",async()=>{
    let task=await select(await runner.runtime.advance(f.accountId,start().id));
    db.exec("CREATE TRIGGER endpoint_todo_failure BEFORE INSERT ON wr_todos BEGIN SELECT RAISE(ABORT,'offline_transaction_failure'); END;");
    task=await approve(task);expect(task.status).toBe("needs_attention");
    expect(repo().read(task)?.applied).toBeNull();expect(f.todos.getTodo(f.accountId,f.deployment.id)).toEqual(f.deployment);
    expect(f.todos.getTodo(f.accountId,f.test.id)).toEqual(f.test);
    expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events").get()).toEqual({n:0});expect(db.prepare("SELECT count(*) n FROM wr_todo_events").get()).toEqual({n:3});
  });
  it("recovers a committed normalized batch after losing the Runtime receipt without another comparison or write",async()=>{
    let task=await select(await runner.runtime.advance(f.accountId,start().id));
    db.exec("CREATE TRIGGER endpoint_receipt_failure BEFORE UPDATE ON agent_actions WHEN NEW.tool='work.apply_confirmed_changes' AND NEW.status='succeeded' BEGIN SELECT RAISE(FAIL,'offline_receipt_failure'); END;");
    task=await approve(task);expect(task.status).toBe("needs_attention");expect(repo().read(task)?.applied?.selectedKeys).toHaveLength(5);
    const events=db.prepare("SELECT * FROM wr_todo_events").all(),relations=db.prepare("SELECT * FROM wr_work_thread_events").all(),bindings=db.prepare("SELECT * FROM wr_work_thread_event_sources").all();
    db.exec("DROP TRIGGER endpoint_receipt_failure");runner.runtime.close();
    runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoint.sqlite"),decision:async()=>{throw Error("must_not_regenerate");}});
    task=await runner.runtime.recover(f.accountId,task.id,{expectedVersion:1,mode:"inspect",eventId:randomUUID()});expect(task.status).toBe("ended");
    expect(db.prepare("SELECT * FROM wr_todo_events").all()).toEqual(events);expect(db.prepare("SELECT * FROM wr_work_thread_events").all()).toEqual(relations);expect(db.prepare("SELECT * FROM wr_work_thread_event_sources").all()).toEqual(bindings);
  });
});
