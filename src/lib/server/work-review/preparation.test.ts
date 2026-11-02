// @vitest-environment node
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {openWorkReviewDatabase} from "./db";
import {seedPreparationCase,preparationDraft,createPreparationM4,preparationReview} from "./preparation-test-fixture";
import {readWorkPreparationContext,workPreparationAgendaFacts} from "./preparation-context";
import {WorkPreparationRepository} from "./preparation-repository";
import {openWorkPreparationRuntime,startWorkPreparation,readWorkPreparations,confirmWorkPreparation} from "./preparation-service";
import {openWorkAgentRuntime,readWorkAgentProject} from "./agent-service";
import {WorkAgentRepository} from "./agent-repository";
import {AgentFailure} from "@/lib/server/agent/types";
import {AgentStore} from "@/lib/server/agent/store";
import {WorkAgendaItem,WorkPreparationGeneration,type WorkPreparation} from "@/lib/domain/work-preparation";
import original302 from "./preparation-302.test-fixture.json";
import {migrateWorkReviewSchema} from "./schema";

let root:string,db:ReturnType<typeof openWorkReviewDatabase>,f:Awaited<ReturnType<typeof seedPreparationCase>>,repo:WorkPreparationRepository;
beforeEach(async()=>{root=mkdtempSync(join(tmpdir(),"work-preparation-"));db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});
  vi.stubGlobal("fetch",vi.fn(()=>{throw Error("external_network_forbidden");}));f=await seedPreparationCase(db);repo=new WorkPreparationRepository(db);});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllGlobals();});
async function generate(goal="帮我准备下次项目会议",draft=preparationDraft){
  const task=startWorkPreparation(db,f.accountId,f.project.id,{id:randomUUID(),mode:"prepare",goal});
  const runner=openWorkPreparationRuntime(db,{checkpointPath:join(root,"prep-checkpoints.sqlite"),generate:async c=>draft(c),decision:async()=>({tool:"work.prepare_meeting",args:{}})});
  try{const result=await runner.runtime.advance(f.accountId,task.id);expect(result.status,JSON.stringify(result)).toBe("ended");}finally{runner.runtime.close();}
  return readWorkPreparations(db,f.accountId,f.project.id).preparations.find(p=>p.taskId===task.id)!;
}
const save=(p:WorkPreparation,agenda=p.agenda.map(a=>WorkAgendaItem.parse(Object.fromEntries(Object.entries(a).filter(([k])=>!["userEdited","sourceInvalid"].includes(k))))))=>repo.save(f.accountId,f.project.id,p.id,{expectedVersion:p.version,operationKey:randomUUID(),agenda});
const discussion=(p:WorkPreparation)=>p.agenda.map(({reason:_,background:__,currentStatus:___,...a})=>a);
function unlink(meetingId:string){f.projects.setMeetingProjects({accountId:f.accountId,meetingId,expectedVersion:f.repo.getMeeting(f.accountId,meetingId).version,operationKey:randomUUID(),projectIds:[]});}
async function compare(p:WorkPreparation,m4:ReturnType<typeof createPreparationM4>,transform=(x:ReturnType<typeof preparationReview>)=>x){
  const task=startWorkPreparation(db,f.accountId,f.project.id,{id:randomUUID(),mode:"review",preparationId:p.id,goal:"对照会前与会后"});
  const runner=openWorkPreparationRuntime(db,{checkpointPath:join(root,"prep-checkpoints.sqlite"),review:async input=>transform(preparationReview(input.agenda,m4)),decision:async()=>({tool:"work.review_preparation",args:{}})});
  try{expect((await runner.runtime.advance(f.accountId,task.id)).status).toBe("ended");}finally{runner.runtime.close();}
  return repo.read(f.accountId,f.project.id,p.id);
}
describe("P3 formal repositories + shared Runtime",{timeout:30000},()=>{
  it("reads M1-M3 current B, current Todos and unresolved questions without turning history into current decisions",async()=>{
    const context=readWorkPreparationContext(db,f.accountId,f.project.id);
    expect(context.coverage.meetingsRead).toBe(3);expect(context.currentDecisions.map(d=>d.findingId)).toEqual([f.findings.b]);
    expect(context.openLoops.some(l=>l.title==="日志保留期限")).toBe(true);
    expect(context.openLoops.some(l=>l.status==="waiting"&&l.todoId===f.vendor.id)).toBe(true);
    expect(context.openLoops.some(l=>l.todoId===f.test.id||l.title==="回滚重复写入问题")).toBe(false);
    expect(context.recentChanges.some(t=>t.status==="candidate"&&t.sources.some(s=>s.findingId===f.findings.b_proposal))).toBe(true);
    const p=await generate();expect(p.status).toBe("draft");expect(p.meetingId).toBeNull();expect(p.stale).toBe(false);
    expect(p.snapshot?.currentDecisions[0].findingId).toBe(f.findings.b);expect(fetch).not.toHaveBeenCalled();
  });
  it("edits, links new M4, compares, confirms into P1 and updates P2 without duplicate writes across reopen",async()=>{
    let p=await generate();const initialIds=db.prepare("SELECT id FROM wr_findings ORDER BY id").all();
    const original=p.agenda.map(a=>WorkAgendaItem.parse(Object.fromEntries(Object.entries(a).filter(([k])=>!["userEdited","sourceInvalid"].includes(k)))));
    const agenda=[original[1],original[0],original[2],original[3],{...original[4],id:"temporary",title:"临时讨论：支持交接",question:"是否需要额外支持？",sourceFindingIds:[],todoIds:[],threadIds:[]}];
    p=save(p,agenda);expect(p.agenda.map(a=>a.id)).toEqual(["logs","deployment","vendor","monitor","temporary"]);
    const saved=JSON.stringify(discussion(p)),m4=createPreparationM4(f);
    expect(repo.read(f.accountId,f.project.id,p.id)).toMatchObject({stale:true,status:"saved"});
    expect(JSON.stringify(discussion(repo.read(f.accountId,f.project.id,p.id)))).toBe(saved);
    p=repo.link(f.accountId,f.project.id,p.id,{operationKey:"link_m4_preparation",expectedVersion:p.version,meetingId:m4.meetingId});
    const before=db.prepare("SELECT * FROM wr_todo_events ORDER BY rowid").all();
    p=await compare(p,m4);
    expect(p.review?.items.map(i=>i.status)).toEqual(["decided","completed","unresolved","completed","not_discussed"]);
    expect(p.review?.addedFindingIds).toEqual([m4.findings.new_question]);expect(p.review?.confirmed).toBe(false);
    expect(db.prepare("SELECT * FROM wr_todo_events ORDER BY rowid").all()).toEqual(before);
    const confirm={operationKey:"confirm_p3",expectedVersion:p.version,fingerprint:p.review!.fingerprint};
    p=confirmWorkPreparation(db,f.accountId,f.project.id,p.id,confirm);expect(p.status).toBe("reviewed");
    expect(confirmWorkPreparation(db,f.accountId,f.project.id,p.id,confirm).followUpTaskId).toBe(p.followUpTaskId);
    const runner=openWorkAgentRuntime(db,{checkpointPath:join(root,"prep-checkpoints.sqlite"),compare:async()=>m4.comparison,decision:async()=>({tool:"work.compare_meeting",args:{}})});
    try{
      let task=await runner.runtime.advance(f.accountId,p.followUpTaskId!);const preview=new WorkAgentRepository(db).read(task)!.preview!;
      expect(preview.changes.every(c=>c.review?.status==="confirmable")).toBe(true);
      task=await runner.runtime.submitEvent(f.accountId,task.id,{id:randomUUID(),kind:"work_selection",version:1,refId:preview.id,message:JSON.stringify({previewId:preview.id,fingerprint:preview.fingerprint,keys:preview.changes.map(c=>c.change.key)})},{expectedVersion:1});
      const approval={approvalId:task.approval!.id,fingerprint:task.approval!.fingerprint,expectedVersion:1,decision:"approve" as const,eventId:randomUUID()};
      expect((await runner.runtime.resolveApproval(f.accountId,task.id,approval)).status).toBe("ended");
      const events=db.prepare("SELECT * FROM wr_todo_events ORDER BY rowid").all();
      await runner.runtime.resolveApproval(f.accountId,task.id,approval);expect(db.prepare("SELECT * FROM wr_todo_events ORDER BY rowid").all()).toEqual(events);
    }finally{runner.runtime.close();}
    expect(f.todos.getTodo(f.accountId,f.deployment.id)).toMatchObject({id:f.deployment.id,title:"B方案部署",status:"completed"});
    expect(f.todos.getTodo(f.accountId,f.vendor.id).status).toBe("open");
    const project=readWorkAgentProject(db,f.accountId,f.project.id);
    expect(project.openLoops.some(l=>l.title==="日志保留期限")).toBe(false);expect(project.openLoops.some(l=>l.title==="告警升级阈值")).toBe(true);
    expect(project.openLoops.some(l=>l.todoId===f.deployment.id||l.title==="同步延迟监控")).toBe(false);
    expect(project.threads.find(t=>t.anchorFindingId===f.findings.a)?.currentFindingId).toBe(f.findings.b);
    expect(db.prepare("SELECT id FROM wr_findings ORDER BY id").all()).toEqual(expect.arrayContaining(initialIds));
    db.close();db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});repo=new WorkPreparationRepository(db);
    expect(repo.read(f.accountId,f.project.id,p.id)).toMatchObject({status:"reviewed",version:p.version,followUpTaskId:p.followUpTaskId});
    const reopened=repo.read(f.accountId,f.project.id,p.id);
    expect(JSON.stringify(discussion(reopened))).toBe(saved);
    expect(reopened.agenda.find(a=>a.id==="deployment")!.currentStatus).toContain("已完成（正式待办记录）");
    expect(db.pragma("integrity_check",{simple:true})).toBe("ok");
  });
  it("rejects concurrent edits and operation-key reuse, restores after a failed transaction",async()=>{
    const p=await generate(),agenda=p.agenda.map(a=>{const {userEdited:_,sourceInvalid:__,...r}=a;return r;});
    const input={operationKey:"save_same",expectedVersion:p.version,agenda};
    db.exec("CREATE TRIGGER fail_preparation BEFORE INSERT ON wr_meeting_preparation_operations BEGIN SELECT RAISE(ABORT,'injected_failure'); END;");
    expect(()=>repo.save(f.accountId,f.project.id,p.id,input)).toThrow("injected_failure");expect(repo.read(f.accountId,f.project.id,p.id).version).toBe(1);
    db.exec("DROP TRIGGER fail_preparation");const saved=repo.save(f.accountId,f.project.id,p.id,input);
    expect(repo.save(f.accountId,f.project.id,p.id,input).version).toBe(saved.version);
    expect(()=>repo.save(f.accountId,f.project.id,p.id,{...input,operationKey:"late"})).toThrow(/新版本/);
    expect(()=>repo.save(f.accountId,f.project.id,p.id,{...input,agenda:[]})).toThrow(/内容不同/);
    expect(db.prepare("SELECT count(*) n FROM wr_meeting_preparation_operations").get()).toEqual({n:1});
  });
  it("does not let regeneration overwrite user-saved preparation",async()=>{
    let p=save(await generate());const agenda=p.agenda.map(a=>{const {userEdited:_,sourceInvalid:__,...r}=a;return {...r,question:"用户明确编辑的讨论重点"};});
    p=save(p,agenda);const newer=await generate("只准备最重要的三项");
    expect(newer.id).not.toBe(p.id);expect(repo.read(f.accountId,f.project.id,p.id).agenda).toEqual(p.agenda);
    expect(readWorkPreparations(db,f.accountId,f.project.id).preparations).toHaveLength(2);
  });
  it("keeps edited plans but invalidates source summaries and cannot reopen A after source unlink",async()=>{
    let p=save(await generate());const agenda=p.agenda.map(a=>{const {userEdited:_,sourceInvalid:__,...r}=a;return {...r,question:"我保存的讨论重点"};});p=save(p,agenda);
    unlink(f.meetings[2]);p=repo.read(f.accountId,f.project.id,p.id);
    expect(p).toMatchObject({stale:true,sourceInvalid:true,snapshot:null});expect(p.agenda[0].question).toBe("我保存的讨论重点");
    expect(p.agenda[0].sourceInvalid).toBe(true);expect(readWorkPreparationContext(db,f.accountId,f.project.id).currentDecisions).toEqual([]);
    expect(db.prepare("SELECT generated_json,snapshot_json FROM wr_meeting_preparations WHERE id=?").get(p.id)).toEqual({generated_json:null,snapshot_json:null});
  });
  it("enforces account/project/explicit meeting scope and one explicitly selected meeting",async()=>{
    let p=save(await generate());const other=f.projects.createProject({accountId:f.accountId,name:"另一个项目",operationKey:"other",description:null}).project;
    expect(()=>repo.read("other_account",f.project.id,p.id)).toThrow();expect(()=>repo.read(f.accountId,other.id,p.id)).toThrow();
    expect(()=>startWorkPreparation(db,f.accountId,other.id,{id:randomUUID(),mode:"prepare",goal:"会议准备",meetingId:f.meetings[0]})).toThrow();
    p=repo.link(f.accountId,f.project.id,p.id,{operationKey:"link_first",expectedVersion:p.version,meetingId:f.meetings[0]});
    expect(()=>repo.link(f.accountId,f.project.id,p.id,{operationKey:"link_second",expectedVersion:p.version,meetingId:f.meetings[1]})).toThrow(/解除/);
    unlink(f.meetings[0]);expect(repo.read(f.accountId,f.project.id,p.id).meetingAvailable).toBe(false);
  });
  it("does not call an unmentioned issue complete and retains an evidence-supported changed result",async()=>{
    let p=save(await generate());const m4=createPreparationM4(f);p=repo.link(f.accountId,f.project.id,p.id,{operationKey:"link",expectedVersion:p.version,meetingId:m4.meetingId});
    p=await compare(p,m4,r=>{r.items.find(i=>i.agendaId==="vendor")!.status="completed";const missing=r.items.find(i=>i.agendaId==="constraints")!;missing.status="completed";
      r.items.find(i=>i.agendaId==="monitor")!.status="changed";return r;});
    expect(p.review?.items.find(i=>i.agendaId==="vendor")?.status).toBe("insufficient");
    expect(p.review?.items.find(i=>i.agendaId==="constraints")?.status).toBe("insufficient");
    expect(p.review?.items.find(i=>i.agendaId==="monitor")?.status).toBe("changed");
    expect(f.todos.getTodo(f.accountId,f.vendor.id).status).toBe("open");
  });
  it("blocks stale review confirmation after Todo changes, edits or source unlink",async()=>{
    let p=save(await generate());const m4=createPreparationM4(f);p=repo.link(f.accountId,f.project.id,p.id,{operationKey:"link",expectedVersion:p.version,meetingId:m4.meetingId});p=await compare(p,m4);
    const todo=f.todos.getTodo(f.accountId,f.deployment.id);f.todos.updateTodo({accountId:f.accountId,todoId:todo.id,expectedVersion:todo.version,operationKey:"external_update",notes:"用户补充"});
    expect(()=>confirmWorkPreparation(db,f.accountId,f.project.id,p.id,{operationKey:"stale",expectedVersion:p.version,fingerprint:p.review!.fingerprint})).toThrow();
    unlink(m4.meetingId);expect(repo.read(f.accountId,f.project.id,p.id).review).toBeNull();
    expect(db.prepare("SELECT count(*) n FROM agent_tasks WHERE goal LIKE '根据已经核对%'").get()).toEqual({n:0});
  });
  it("protects cancellation and unknown without issuing automatic retries",async()=>{
    const task=startWorkPreparation(db,f.accountId,f.project.id,{id:randomUUID(),mode:"prepare",goal:"准备下次会议"});
    const generator=vi.fn(async()=>{throw new AgentFailure("unknown","synthetic_unknown");});
    let runner=openWorkPreparationRuntime(db,{generate:generator,checkpointPath:join(root,"p.sqlite"),decision:async()=>({tool:"work.prepare_meeting",args:{}})});
    expect((await runner.runtime.advance(f.accountId,task.id)).status).toBe("needs_attention");
    await runner.runtime.advance(f.accountId,task.id);expect(generator).toHaveBeenCalledTimes(1);runner.runtime.close();
    const cancelled=startWorkPreparation(db,f.accountId,f.project.id,{id:randomUUID(),mode:"prepare",goal:"准备下次会议"});
    runner=openWorkPreparationRuntime(db,{checkpointPath:join(root,"p.sqlite"),decision:async()=>({tool:"work.prepare_meeting",args:{}}),generate:async c=>{runner.runtime.control(f.accountId,cancelled.id,"cancel",1);return preparationDraft(c);}});
    try{await runner.runtime.advance(f.accountId,cancelled.id);expect(readWorkPreparations(db,f.accountId,f.project.id).preparations).toHaveLength(0);}finally{runner.runtime.close();}
  });
  it("recovers a persisted generated result without regenerating after lost tool receipt",async()=>{
    const task=startWorkPreparation(db,f.accountId,f.project.id,{id:randomUUID(),mode:"prepare",goal:"准备下次会议"});
    const original=WorkPreparationRepository.prototype.saveGenerated;
    const spy=vi.spyOn(WorkPreparationRepository.prototype,"saveGenerated").mockImplementation(function(this:WorkPreparationRepository,...args){original.apply(this,args);throw new AgentFailure("unknown","lost_receipt");});
    const generator=vi.fn(async(c:Parameters<typeof preparationDraft>[0])=>preparationDraft(c));
    const runner=openWorkPreparationRuntime(db,{generate:generator,checkpointPath:join(root,"recover.sqlite"),decision:async()=>({tool:"work.prepare_meeting",args:{}})});
    try{expect((await runner.runtime.advance(f.accountId,task.id)).status).toBe("ended");spy.mockRestore();
      await runner.runtime.recover(f.accountId,task.id,{expectedVersion:1,mode:"inspect",eventId:randomUUID()});
      expect(generator).toHaveBeenCalledTimes(1);expect(readWorkPreparations(db,f.accountId,f.project.id).preparations).toHaveLength(1);
    }finally{runner.runtime.close();}
  });
  it("upgrades V10 without changing old facts and supports backing out empty P3 tables in an isolated copy",()=>{
    const facts=db.prepare("SELECT * FROM wr_findings ORDER BY id").all(),tasks=new AgentStore(db).listTasks(f.accountId,f.project.id);
    db.exec("DROP TRIGGER wr_preparation_delete_project; DROP TABLE wr_meeting_preparation_operations; DROP TABLE wr_meeting_preparations; DELETE FROM wr_schema_migrations WHERE version=11; PRAGMA user_version=10;");
    migrateWorkReviewSchema(db);migrateWorkReviewSchema(db);expect(db.pragma("user_version",{simple:true})).toBe(11);
    expect(db.prepare("SELECT * FROM wr_findings ORDER BY id").all()).toEqual(facts);expect(new AgentStore(db).listTasks(f.accountId,f.project.id)).toEqual(tasks);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  it("deletes source derivatives and project-owned preparations through formal deletion services",async()=>{
    const p=save(await generate());f.repo.deleteMeeting({accountId:f.accountId,meetingId:f.meetings[2],linkedTodoPolicy:"detach_linked_todos"});
    const invalid=repo.read(f.accountId,f.project.id,p.id);expect(invalid.sourceInvalid).toBe(true);expect(invalid.snapshot).toBeNull();
    expect(invalid.agenda.find(a=>a.id==="deployment")?.title).toBe("依据失效的议题");
    const project=f.projects.getProject(f.accountId,f.project.id);
    const archived=f.projects.updateProject({accountId:f.accountId,projectId:project.id,expectedVersion:project.version,operationKey:"archive_p3",status:"archived"}).project;
    f.projects.deleteProject({accountId:f.accountId,projectId:project.id,expectedVersion:archived.version});
    expect(()=>repo.read(f.accountId,f.project.id,p.id)).toThrow();
    expect(db.prepare("SELECT count(*) n FROM wr_meeting_preparations").get()).toEqual({n:0});
    expect(db.prepare("SELECT count(*) n FROM wr_meeting_preparation_operations").get()).toEqual({n:0});
  });
  it("can prepare an explicitly selected existing meeting and reports capacity limits without inferring a current decision",async()=>{
    const task=startWorkPreparation(db,f.accountId,f.project.id,{id:randomUUID(),mode:"prepare",meetingId:f.meetings[2],goal:"只准备最重要的三项"});
    const runner=openWorkPreparationRuntime(db,{checkpointPath:join(root,"existing.sqlite"),generate:async c=>{expect(c.meetingDate).toBe(f.repo.getMeeting(f.accountId,f.meetings[2]).meetingDate);return {agenda:preparationDraft(c).agenda.slice(0,3)};},decision:async()=>({tool:"work.prepare_meeting",args:{}})});
    try{expect((await runner.runtime.advance(f.accountId,task.id)).status).toBe("ended");}finally{runner.runtime.close();}
    const p=readWorkPreparations(db,f.accountId,f.project.id).preparations[0];expect(p.agenda).toHaveLength(3);expect(p.meetingId).toBe(f.meetings[2]);expect(p.meetingDate).toBe(f.repo.getMeeting(f.accountId,f.meetings[2]).meetingDate);
    for(let i=0;i<42;i++)f.todos.createManualTodo({accountId:f.accountId,operationKey:`extra_p3_${i}`,title:`合成工作${i}`,kind:"self",ownerLabel:null,currentDueDate:null,notes:null,myDayDate:null,isImportant:false,projectIds:[f.project.id]});
    const c=readWorkPreparationContext(db,f.accountId,f.project.id);expect(c.coverage.limited).toBe(true);expect(c.coverage.todosRead).toBeLessThan(c.coverage.todosAvailable);
    expect(c.coverage.notice).toContain("未纳入的事实");
  });
  it("accepts the exact original #302 response while removing model-owned factual prose",()=>{
    const raw=JSON.parse(original302.response.output_text);
    expect(raw.agenda[2].reason).toContain("B已上线");expect(raw.agenda[0].reason).toContain("与准备会议日期同日");
    const parsed=WorkPreparationGeneration.parse(raw);expect(parsed.agenda).toHaveLength(3);
    expect(JSON.stringify(parsed)).not.toContain("B已上线");expect(JSON.stringify(parsed)).not.toContain("与准备会议日期同日");
    expect(parsed.agenda[0]).not.toHaveProperty("currentStatus");
    expect(parsed.agenda.map(a=>a.question)).toEqual(raw.agenda.map((a:WorkAgendaItem)=>a.question));
    expect(()=>WorkPreparationGeneration.parse({...raw,meetingDate:"2026-10-30"})).toThrow();
  });
  it("persists authoritative facts, preserves specific discussion and never derives a meeting date from a deadline",async()=>{
    const p=await generate("最多三项，优先未完成和需要决定的问题",c=>({agenda:preparationDraft(c).agenda.slice(0,3).map(a=>({...a,reason:"B已上线，与准备会议日期同日",background:"已全部完成",currentStatus:"已完成"}))}));
    expect(p.agenda).toHaveLength(3);expect(p.meetingDate).toBeNull();expect(p.statusAsOf).toMatch(/^\d{4}-/);
    expect(p.agenda[0].currentStatus).toContain("当前正式决定：正式采用B方案");
    expect(p.agenda[0].currentStatus).toContain("尚无完成确认记录");expect(p.agenda[0].currentStatus).toContain("实际进展需要核实");
    expect(p.agenda[0].currentStatus).toContain("待办截止日期");expect(p.agenda[0].currentStatus).not.toContain("尚未上线");
    expect(p.agenda[1].currentStatus).toContain("仍未解决");expect(p.agenda[2].currentStatus).toContain("等待他人回复");
    expect(p.agenda[0].question).toBe("确认B方案部署进度的进展或最终结论");
    const row=db.prepare("SELECT generated_json,agenda_json FROM wr_meeting_preparations WHERE id=?").get(p.id);
    expect(JSON.stringify(row)).not.toContain("B已上线");expect(JSON.stringify(row)).not.toContain("与准备会议日期同日");
    const c=readWorkPreparationContext(db,f.accountId,f.project.id);
    const test=workPreparationAgendaFacts({...p.agenda[0],todoIds:[f.test.id],sourceFindingIds:[],threadIds:[]},c);
    expect(test.currentStatus).toContain("已完成（正式待办记录）");expect(test.currentStatus).not.toContain("尚无完成确认");
    expect(c.openLoops.some(l=>l.todoId===f.test.id)).toBe(false);
  });
  it("does not trust facts posted by the editor, keeps user plans and recomputes state on reopen",async()=>{
    let p=await generate();const edited=p.agenda.map(({userEdited:_,sourceInvalid:__,...a})=>({...a,question:"用户具体的验收问题",currentStatus:"已全部完成",reason:"虚构的会议时间",background:"虚构背景"}));
    p=save(p,edited);expect(p.agenda[0].question).toBe("用户具体的验收问题");expect(p.agenda[0].currentStatus).toContain("open");
    expect(JSON.stringify(p.agenda)).not.toContain("虚构");
    const todo=f.todos.getTodo(f.accountId,f.deployment.id);
    f.todos.updateTodo({accountId:f.accountId,todoId:todo.id,expectedVersion:todo.version,operationKey:"change_deadline",currentDueDate:"2026-11-10"});
    db.close();db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});repo=new WorkPreparationRepository(db);
    const reopened=repo.read(f.accountId,f.project.id,p.id);expect(reopened.stale).toBe(true);
    expect(reopened.agenda[0].question).toBe("用户具体的验收问题");expect(reopened.agenda[0].currentStatus).toContain("2026-11-10");expect(reopened.meetingDate).toBeNull();
  });
});
