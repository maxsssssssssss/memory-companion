// @vitest-environment node
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {AgentTask} from "@/lib/domain/agent";
import {openWorkReviewDatabase} from "./db";
import {seedWorkAgentCase} from "./agent-test-fixture";
import {openWorkAgentRuntime,startWorkAgent,readWorkAgentProject} from "./agent-service";
import {WorkAgentRepository} from "./agent-repository";
import {readWorkThreads,readWorkAgentContext} from "./agent-context";
import {AgentFailure} from "@/lib/server/agent/types";
import {migrateWorkReviewSchema} from "./schema";

let db:ReturnType<typeof openWorkReviewDatabase>,fixture:ReturnType<typeof seedWorkAgentCase>,root:string;
let runner:ReturnType<typeof openWorkAgentRuntime>;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"work-agent-p1-"));db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});fixture=seedWorkAgentCase(db);
  vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("network_forbidden");}));
  runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite"),
    compare:async(context)=>structuredClone(context.meetingId===fixture.meetings[1]?fixture.m2:fixture.m3),
    decision:async(input)=>input.results.some(r=>r.tool==="work.compare_meeting"&&r.status==="succeeded")
      ?{tool:"work.preview_follow_up_changes",args:{}}:{tool:"work.compare_meeting",args:{}}});
});
afterEach(()=>{runner?.runtime.close();db?.close();rmSync(root,{recursive:true,force:true});vi.unstubAllGlobals();});
const start=(index=2)=>startWorkAgent(db,fixture.accountId,fixture.project.id,{id:randomUUID(),meetingId:fixture.meetings[index],goal:"帮我整理今天开完会之后的工作"});
async function select(task:AgentTask,keys?:string[]){
  const artifact=new WorkAgentRepository(db).read(task)!,preview=artifact.preview!;
  return runner.runtime.submitEvent(fixture.accountId,task.id,{id:randomUUID(),kind:"work_selection",refId:preview.id,version:1,
    message:JSON.stringify({previewId:preview.id,fingerprint:preview.fingerprint,keys:keys??preview.changes.map(c=>c.change.key)})},{expectedVersion:1});
}
async function approve(task:AgentTask){
  return runner.runtime.resolveApproval(fixture.accountId,task.id,{approvalId:task.approval!.id,expectedVersion:1,fingerprint:task.approval!.fingerprint,decision:"approve",eventId:randomUUID()});
}
describe("Work Agent P1 real repository/runtime acceptance",{timeout:20_000},()=>{
  it("lists confirmed project questions before any thread is created, excluding unlinked or deleted meetings",()=>{
    const view=readWorkAgentProject(db,fixture.accountId,fixture.project.id);
    expect(view.openLoops.some(l=>l.kind==="question"&&l.text.includes("日志保留期限"))).toBe(true);
    expect(view.openLoops.some(l=>l.kind==="question"&&l.text.includes("回滚重复写入问题"))).toBe(true);
    expect(db.prepare("SELECT count(*) n FROM wr_work_threads").get()).toEqual({n:0});
    const other=fixture.projects.createProject({accountId:fixture.accountId,name:"其他项目",description:null,operationKey:"other"}).project;
    expect(readWorkAgentProject(db,fixture.accountId,other.id).openLoops).toEqual([]);
    expect(()=>readWorkAgentProject(db,"account_b",fixture.project.id)).toThrow();
    const meeting=fixture.repo.getMeeting(fixture.accountId,fixture.meetings[0]);
    fixture.projects.setMeetingProjects({accountId:fixture.accountId,meetingId:meeting.id,expectedVersion:meeting.version,projectIds:[],operationKey:"unlink_questions"});
    fixture.repo.deleteMeeting({accountId:fixture.accountId,meetingId:fixture.meetings[2],linkedTodoPolicy:"detach_linked_todos"});
    expect(readWorkAgentProject(db,fixture.accountId,fixture.project.id).openLoops.filter(l=>l.kind==="question")).toEqual([]);
  });
  it("does not duplicate a recorded question or revive it as unresolved after relation retraction",async()=>{
    let task=await runner.runtime.advance(fixture.accountId,start(1).id);
    task=await approve(await select(task,["record_logs"]));
    let view=readWorkAgentProject(db,fixture.accountId,fixture.project.id);
    const thread=view.threads.find(t=>t.anchorFindingId===fixture.findings.logs)!;
    expect(view.openLoops.filter(l=>l.text.includes("日志保留期限"))).toHaveLength(1);
    new WorkAgentRepository(db).retract(fixture.accountId,fixture.project.id,thread.events[0].id,"retract_logs");
    view=readWorkAgentProject(db,fixture.accountId,fixture.project.id);
    expect(view.threads.find(t=>t.id===thread.id)?.state).toBe("unknown");
    expect(view.openLoops.some(l=>l.kind==="question"&&l.text.includes("日志保留期限"))).toBe(false);
    expect(view.openLoops.find(l=>l.threadId===thread.id)?.kind).toBe("uncertain");
  });
  it("runs M2 then M3: fixed selection, atomic Todo reuse, timeline, reopen and repeated approval",async()=>{
    let m2=await runner.runtime.advance(fixture.accountId,start(1).id);
    expect(m2.status).toBe("waiting");m2=await select(m2);m2=await approve(m2);
    expect(m2.status).toBe("ended");
    expect(readWorkThreads(db,fixture.accountId,fixture.project.id).find(t=>t.anchorFindingId===fixture.findings.a)?.state).toBe("suspended");
    let task=await runner.runtime.advance(fixture.accountId,start().id);
    expect(task.wait?.kind).toBe("work_selection");
    expect(fixture.todos.getTodo(fixture.accountId,fixture.deployment.id).title).toBe("A方案部署");
    task=await select(task,["replace","update_deploy","complete_test","close_q","monitor"]);
    expect(task.wait?.kind).toBe("confirmation");
    const approval=task.approval!,eventId=randomUUID();
    task=await runner.runtime.resolveApproval(fixture.accountId,task.id,{approvalId:approval.id,expectedVersion:1,fingerprint:approval.fingerprint,decision:"approve",eventId});
    expect(task.status,JSON.stringify(task)).toBe("ended");
    expect(fixture.todos.getTodo(fixture.accountId,fixture.deployment.id)).toMatchObject({title:"B方案部署",currentDueDate:"2026-10-30",sourceFindingId:fixture.findings.deploy});
    expect(fixture.todos.getTodo(fixture.accountId,fixture.test.id).status).toBe("completed");
    expect(fixture.todos.getTodo(fixture.accountId,fixture.vendor.id).status).toBe("open");
    const count=db.prepare("SELECT count(*) n FROM wr_todos").get();
    await runner.runtime.resolveApproval(fixture.accountId,task.id,{approvalId:approval.id,expectedVersion:1,fingerprint:approval.fingerprint,decision:"approve",eventId});
    expect(db.prepare("SELECT count(*) n FROM wr_todos").get()).toEqual(count);
    runner.runtime.close();runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite")});
    const view=readWorkAgentProject(db,fixture.accountId,fixture.project.id);
    expect(view.tasks.find(t=>t.task.id===task.id)?.artifact?.applied?.rejectedKeys).toEqual(["reject_vendor"]);
    expect(view.threads.find(t=>t.anchorFindingId===fixture.findings.a)).toMatchObject({state:"active",currentFindingId:fixture.findings.b});
    expect(view.threads.find(t=>t.anchorFindingId===fixture.findings.rollback)?.state).toBe("resolved");
    expect(view.openLoops.some(x=>x.text.includes("供应商"))).toBe(true);
    expect(view.openLoops.some(x=>x.text.includes("日志保留期限"))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a proposal replacing a final decision and cross-account/project/unlinked scopes",()=>{
    const task=start(),bad=structuredClone(fixture.m3);
    const change=bad.changes[0];if(change.kind!=="relation")throw Error("fixture");
    change.findingId=fixture.findings.b_proposal;change.sourceFindingIds=[fixture.findings.a,fixture.findings.b_proposal];
    expect(()=>new WorkAgentRepository(db).saveComparison(task,bad)).toThrow("新提议");
    expect(()=>startWorkAgent(db,"account_b",fixture.project.id,{id:randomUUID(),meetingId:fixture.meetings[2],goal:"比较"})).toThrow();
    const other=fixture.projects.createProject({accountId:fixture.accountId,name:"另一个项目",description:null,operationKey:"other"}).project;
    expect(()=>startWorkAgent(db,fixture.accountId,other.id,{id:randomUUID(),meetingId:fixture.meetings[2],goal:"比较"})).toThrow();
  });
  it("finishes comparison-only requests and continues the same saved preview without a new model result",async()=>{
    runner.runtime.close();
    const compare=vi.fn(async()=>structuredClone(fixture.m3));
    runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite"),compare,
      decision:async(input)=>input.results.some(r=>r.tool==="work.compare_meeting")?{finish:"比较已完成"}:{tool:"work.compare_meeting",args:{}}});
    const original=startWorkAgent(db,fixture.accountId,fixture.project.id,{id:randomUUID(),meetingId:fixture.meetings[2],goal:"今天这场会和之前有什么变化？"});
    let task=await runner.runtime.advance(fixture.accountId,original.id);
    expect(task.status).toBe("ended");expect(new WorkAgentRepository(db).read(task)?.preview).toBeNull();
    const continuation={id:randomUUID(),meetingId:fixture.meetings[2],goal:"保存这次比较中选中的后续工作",fromTaskId:task.id};
    task=startWorkAgent(db,fixture.accountId,fixture.project.id,continuation);
    task=await runner.runtime.advance(fixture.accountId,task.id);task=await select(task,["update_deploy"]);
    // Changing the selection cannot mutate the approval already fixed for this task.
    const before=new WorkAgentRepository(db).read(task)!.preview!;
    expect(()=>new WorkAgentRepository(db).select(task,{previewId:before.id,fingerprint:before.fingerprint,keys:["monitor"]})).toThrow();
    task=await approve(task);expect(task.status).toBe("ended");expect(compare).toHaveBeenCalledTimes(1);
    const receipt=startWorkAgent(db,fixture.accountId,fixture.project.id,continuation);
    expect(receipt.id).toBe(task.id);expect(receipt.status).toBe("ended");
    expect(()=>startWorkAgent(db,fixture.accountId,fixture.project.id,{...continuation,goal:"换一个目标"})).toThrow();
  });
  it("deduplicates confirmed relations but appends a fresh confirmation after explicit retraction",async()=>{
    runner.runtime.close();
    const comparison={...structuredClone(fixture.m3),changes:[structuredClone(fixture.m3.changes[0])]};
    runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite"),compare:async()=>comparison,
      decision:async()=>({tool:"work.compare_meeting",args:{}})});
    let task=await runner.runtime.advance(fixture.accountId,start().id);task=await approve(await select(task));
    const first=new WorkAgentRepository(db).read(task)!.applied!.eventIds[0];
    task=await runner.runtime.advance(fixture.accountId,start().id);task=await approve(await select(task));
    expect(new WorkAgentRepository(db).read(task)!.applied!.eventIds).toEqual([first]);
    new WorkAgentRepository(db).retract(fixture.accountId,fixture.project.id,first,"retract_once");
    task=await runner.runtime.advance(fixture.accountId,start().id);task=await approve(await select(task));
    const thread=readWorkThreads(db,fixture.accountId,fixture.project.id)[0];
    expect(thread.state).toBe("active");expect(thread.currentFindingId).toBe(fixture.findings.b);
    const transitions=thread.events.filter(e=>e.relation!=="retracts");
    expect(transitions).toHaveLength(2);expect(transitions[0].retracted).toBe(true);
    expect(transitions[1].id).not.toBe(first);
    expect(thread.events.filter(e=>e.relation==="retracts")).toMatchObject([{retractsId:first}]);
  });
  it("invalidates fixed preview when Todo changes, and cancels before a late comparison publishes",async()=>{
    let task=await runner.runtime.advance(fixture.accountId,start().id);task=await select(task,["update_deploy"]);
    fixture.todos.updateTodo({accountId:fixture.accountId,todoId:fixture.deployment.id,operationKey:"human_edit",expectedVersion:fixture.deployment.version,title:"用户已调整"});
    await expect(approve(task)).rejects.toThrow();
    expect(fixture.todos.getTodo(fixture.accountId,fixture.deployment.id).title).toBe("用户已调整");
    runner.runtime.close();
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite"),decision:async()=>({tool:"work.compare_meeting",args:{}}),compare:async()=>{entered();await gate;return fixture.m3;}});
    const late=start(),pending=runner.runtime.advance(fixture.accountId,late.id);await started;
    runner.runtime.control(fixture.accountId,late.id,"cancel",1);release();await pending;
    expect(new WorkAgentRepository(db).read(late)).toBeNull();
  });
  it("removes invalid evidence without resurrecting A when B is unlinked; records explicit retraction",async()=>{
    let task=await runner.runtime.advance(fixture.accountId,start(1).id);task=await approve(await select(task));
    task=await runner.runtime.advance(fixture.accountId,start().id);task=await approve(await select(task,["replace"]));
    const event=readWorkThreads(db,fixture.accountId,fixture.project.id).find(t=>t.anchorFindingId===fixture.findings.a)!.events.at(-1)!;
    new WorkAgentRepository(db).retract(fixture.accountId,fixture.project.id,event.id,"retract_once");
    expect(readWorkThreads(db,fixture.accountId,fixture.project.id).find(t=>t.anchorFindingId===fixture.findings.a)?.state).toBe("unknown");
    const meeting=fixture.repo.getMeeting(fixture.accountId,fixture.meetings[2]);
    fixture.projects.setMeetingProjects({accountId:fixture.accountId,meetingId:meeting.id,expectedVersion:meeting.version,projectIds:[],operationKey:"unlink_m3"});
    const thread=readWorkThreads(db,fixture.accountId,fixture.project.id).find(t=>t.anchorFindingId===fixture.findings.a)!;
    expect(thread.state).toBe("unknown");expect(thread.currentFindingId).toBeNull();expect(thread.events.at(-1)?.sources).toEqual([]);
    expect(new WorkAgentRepository(db).read(task)?.comparison).toBeNull();
  });
  it("recovers a committed transaction after the Agent receipt is lost without repeating writes",async()=>{
    let task=await runner.runtime.advance(fixture.accountId,start().id);task=await select(task,["replace","update_deploy","complete_test","close_q","monitor"]);
    db.exec(`CREATE TRIGGER synthetic_receipt_failure BEFORE UPDATE ON agent_actions
      WHEN NEW.tool='work.apply_confirmed_changes' AND NEW.status='succeeded'
      BEGIN SELECT RAISE(FAIL,'synthetic_crash_after_business_commit'); END;`);
    task=await approve(task);expect(task.status).toBe("needs_attention");
    expect(new WorkAgentRepository(db).read(task)?.applied?.todoIds).toHaveLength(3);
    const before=db.prepare("SELECT count(*) n FROM wr_todo_events").get();
    db.exec("DROP TRIGGER synthetic_receipt_failure");runner.runtime.close();
    runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite"),decision:async()=>{throw Error("must_not_generate_during_recovery");}});
    task=await runner.runtime.recover(fixture.accountId,task.id,{expectedVersion:1,mode:"inspect",eventId:randomUUID()});
    expect(task.status,JSON.stringify(task)).toBe("ended");expect(task.recovery?.kind).toBe("succeeded");
    expect(db.prepare("SELECT count(*) n FROM wr_todo_events").get()).toEqual(before);
  });
  it("rolls the entire approved batch back on a later Todo failure",async()=>{
    let task=await runner.runtime.advance(fixture.accountId,start().id);task=await select(task,["replace","update_deploy","monitor"]);
    db.exec(`CREATE TRIGGER synthetic_todo_failure BEFORE INSERT ON wr_todos WHEN NEW.title='同步延迟监控'
      BEGIN SELECT RAISE(ABORT,'synthetic_late_batch_failure'); END;`);
    task=await approve(task);expect(task.status).toBe("needs_attention");
    expect(fixture.todos.getTodo(fixture.accountId,fixture.deployment.id).title).toBe("A方案部署");
    expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events").get()).toEqual({n:0});
    expect(new WorkAgentRepository(db).read(task)?.applied).toBeNull();
  });
  it("rejection and repeated selection never authorize a write",async()=>{
    let task=await runner.runtime.advance(fixture.accountId,start().id);task=await select(task,["monitor"]);
    const approval=task.approval!;task=await runner.runtime.resolveApproval(fixture.accountId,task.id,{approvalId:approval.id,expectedVersion:1,fingerprint:approval.fingerprint,decision:"reject",eventId:randomUUID()});
    expect(task.status).toBe("ended");
    expect(db.prepare("SELECT count(*) n FROM wr_todos").get()).toEqual({n:3});
    expect(()=>new WorkAgentRepository(db).apply(task,approval.id)).toThrow();
    expect(new WorkAgentRepository(db).read(task)?.applied).toBeNull();
  });
  it("rejects oversized feedback before freezing selection and cancels an approved deferred write",async()=>{
    let task=await runner.runtime.advance(fixture.accountId,start().id);
    const repo=new WorkAgentRepository(db),p=repo.read(task)!.preview!;
    const event={id:"x".repeat(181),kind:"work_selection",version:1,refId:p.id,
      message:JSON.stringify({previewId:p.id,fingerprint:p.fingerprint,keys:["monitor"]})};
    await expect(runner.runtime.submitEvent(fixture.accountId,task.id,event,{expectedVersion:1})).rejects.toThrow("长度");
    expect(repo.read(task)!.preview!.selectedKeys).toBeNull();
    task=await select(task,["monitor"]);
    task=await runner.runtime.resolveApproval(fixture.accountId,task.id,{approvalId:task.approval!.id,fingerprint:task.approval!.fingerprint,
      expectedVersion:1,decision:"approve",eventId:randomUUID(),defer:true});
    runner.runtime.control(fixture.accountId,task.id,"cancel",1);
    task=await runner.runtime.advance(fixture.accountId,task.id);
    expect(task.status).toBe("cancelled");expect(repo.read(task)?.applied).toBeNull();
    expect(db.prepare("SELECT count(*) n FROM wr_todos").get()).toEqual({n:3});
  });
  it.each(["meeting","todo","finding","project"] as const)("invalidates and scrubs affected artifacts on %s deletion/version change",async target=>{
    let task=await runner.runtime.advance(fixture.accountId,start().id);task=await approve(await select(task,["replace","update_deploy","monitor"]));
    if(target==="meeting")fixture.repo.deleteMeeting({accountId:fixture.accountId,meetingId:fixture.meetings[2],linkedTodoPolicy:"detach_linked_todos"});
    if(target==="todo")fixture.todos.deleteTodo({accountId:fixture.accountId,todoId:fixture.deployment.id,expectedVersion:fixture.todos.getTodo(fixture.accountId,fixture.deployment.id).version,operationKey:"delete_todo"});
    if(target==="finding")db.prepare("UPDATE wr_findings SET version=version+1,body='合成修改' WHERE id=?").run(fixture.findings.b);
    if(target==="project"){
      const p=fixture.projects.getProject(fixture.accountId,fixture.project.id);
      const archived=fixture.projects.updateProject({accountId:fixture.accountId,projectId:p.id,expectedVersion:p.version,operationKey:"archive",status:"archived"}).project;
      fixture.projects.deleteProject({accountId:fixture.accountId,projectId:p.id,expectedVersion:archived.version});
    }
    const row=db.prepare("SELECT state,comparison_json,preview_json,applied_json FROM wr_work_agent_artifacts WHERE task_id=?").get(task.id) as Record<string,unknown>;
    expect(row).toMatchObject({state:"invalidated",comparison_json:null,preview_json:null});expect(row.applied_json).toBeTruthy();
    if(target!=="project")expect(new WorkAgentRepository(db).read(task)?.sources).toEqual([]);
  });
  it("does not replay unknown model output and enforces the shared call budget",async()=>{
    runner.runtime.close();let calls=0;
    runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite"),decision:async()=>({tool:"work.compare_meeting",args:{}}),
      compare:async(_context,ctx)=>ctx.call({kind:"synthetic_compare",inputChars:100,maxOutputTokens:100},async()=>{calls++;throw new AgentFailure("unknown","synthetic_unknown");})});
    let task=await runner.runtime.advance(fixture.accountId,start().id);expect(task.recovery?.kind).toBe("unknown");
    await runner.runtime.recover(fixture.accountId,task.id,{expectedVersion:1,mode:"inspect"});expect(calls).toBe(1);
    expect(task.usage.unknownUsageCalls).toBe(1);
    runner.runtime.close();runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"checkpoints.sqlite"),decision:async(_input,ctx)=>{
      await ctx.call({kind:"synthetic_decision",inputChars:20,maxOutputTokens:20},async()=>({value:true}));
      return {tool:"work.read_project_context",args:{}};
    }});
    task=start();db.prepare("UPDATE agent_tasks SET budget_json=json_set(budget_json,'$.maxCalls',1) WHERE id=?").run(task.id);
    task=await runner.runtime.advance(fixture.accountId,task.id);expect(task.status).toBe("budget_exhausted");expect(task.usage.calls).toBe(1);
  });
  it("reports bounded coverage and never reads pending/ignored candidate prose or Todo notes",()=>{
    db.prepare("UPDATE wr_meeting_candidates SET body='PRIVATE_PENDING_CANDIDATE_SENTINEL'").run();
    fixture.todos.updateTodo({accountId:fixture.accountId,todoId:fixture.deployment.id,expectedVersion:fixture.deployment.version,operationKey:"notes",notes:"PRIVATE_TODO_NOTES_SENTINEL"});
    for(let i=0;i<42;i++)fixture.todos.createManualTodo({accountId:fixture.accountId,title:`合成待办${i}`,kind:"self",notes:null,ownerLabel:null,currentDueDate:null,isImportant:false,myDayDate:null,projectIds:[fixture.project.id],operationKey:`manual_${i}`});
    const context=readWorkAgentContext(db,fixture.accountId,fixture.project.id,fixture.meetings[2]);
    expect(context.coverage).toMatchObject({todosRead:40,todosAvailable:45,limited:true});
    expect(JSON.stringify(context)).not.toContain("PRIVATE_");
  });
  it("migrates the existing V9 facts without backfilling confirmed relationships",()=>{
    const before=db.prepare("SELECT id,body,version FROM wr_findings ORDER BY id").all();
    const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'wr_work_agent_%'").all() as {name:string}[];
    for(const t of triggers)db.exec(`DROP TRIGGER ${t.name}`);
    for(const table of ["wr_work_agent_artifact_sources","wr_work_agent_artifacts","wr_work_thread_event_sources","wr_work_thread_events","wr_work_threads"])db.exec(`DROP TABLE ${table}`);
    db.exec("DELETE FROM wr_schema_migrations WHERE version=10; PRAGMA user_version=9;");
    migrateWorkReviewSchema(db);migrateWorkReviewSchema(db);
    expect(db.pragma("user_version",{simple:true})).toBe(10);expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT id,body,version FROM wr_findings ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT count(*) n FROM wr_work_threads").get()).toEqual({n:0});
  });
});
