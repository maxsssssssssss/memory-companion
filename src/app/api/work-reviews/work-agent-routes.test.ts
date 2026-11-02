// @vitest-environment node
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {openWorkReviewDatabase} from "@/lib/server/work-review/db";
import {seedWorkAgentCase} from "@/lib/server/work-review/agent-test-fixture";
import {openWorkAgentRuntime} from "@/lib/server/work-review/agent-service";
import {GET,POST,PATCH} from "./projects/[projectId]/agent/route";
import type {WorkAgentProjectView,WorkAgentTaskView} from "@/lib/domain/work-agent";
import {responseStreamFixture} from "@/lib/server/openai/structured-json-stream.test-fixture";

const control=vi.hoisted(()=>({accountId:"account_a",enabled:true,streaming:false,queue:[] as Array<()=>Promise<void>>,db:undefined as unknown,checkpoint:"",compare:undefined as unknown}));
vi.mock("next/server",async original=>({...await original<typeof import("next/server")>(),after:(fn:()=>Promise<void>)=>control.queue.push(fn)}));
vi.mock("@/lib/server/auth/request-context",()=>({requireAuthContext:async()=>({user:{id:control.accountId}}),isUnauthenticatedError:()=>false}));
vi.mock("@/lib/server/work-review/runtime-config",async original=>({...await original<typeof import("@/lib/server/work-review/runtime-config")>(),isWorkReviewProjectsEnabled:()=>control.enabled,isWorkReviewTodoEnabled:()=>control.enabled}));
vi.mock("@/lib/server/work-review/db",async original=>({...await original<typeof import("@/lib/server/work-review/db")>(),getWorkReviewDatabase:()=>control.db}));
vi.mock("@/lib/server/work-review/agent-service",async original=>{
  const actual=await original<typeof import("@/lib/server/work-review/agent-service")>();
  return {...actual,advanceWorkAgent:async(account:string,id:string)=>{
    if(control.streaming)return actual.advanceWorkAgent(account,id);
    const {runtime}=actual.openWorkAgentRuntime(control.db as ReturnType<typeof openWorkReviewDatabase>,{checkpointPath:control.checkpoint,
      compare:control.compare as NonNullable<Parameters<typeof openWorkAgentRuntime>[1]>["compare"],
      decision:async input=>input.results.some(r=>r.tool==="work.compare_meeting")?{tool:"work.preview_follow_up_changes",args:{}}:{tool:"work.compare_meeting",args:{}}});
    try{await runtime.advance(account,id);}finally{runtime.close();}
  }};
});
let root:string,db:ReturnType<typeof openWorkReviewDatabase>,fixture:ReturnType<typeof seedWorkAgentCase>;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"work-agent-api-"));db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});fixture=seedWorkAgentCase(db);
  control.db=db;control.checkpoint=join(root,"work-agent-checkpoints.sqlite");control.accountId=fixture.accountId;control.enabled=true;control.streaming=false;control.queue=[];
  control.compare=async()=>structuredClone(fixture.m3);vi.stubGlobal("fetch",vi.fn(()=>{throw Error("network_forbidden");}));});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const context=()=>({params:Promise.resolve({projectId:fixture.project.id})});
const request=(method:string,body?:unknown)=>new Request(`http://localhost/api/work-reviews/projects/${fixture.project.id}/agent`,{method,...(body?{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
async function drain(){while(control.queue.length)await control.queue.shift()!();}
async function current(id:string){const response=await GET(request("GET"),context());expect(response.status).toBe(200);const value=await response.json() as WorkAgentProjectView;return value.tasks.find(t=>t.task.id===id)!;}
describe("Work Agent authenticated routes with real Work database and Runtime",()=>{
  it("normalizes omitted relation endpoints before API selection and keeps approved provenance stable on repeated confirmation",async()=>{
    const answer=structuredClone(fixture.m3);answer.changes=answer.changes.filter(c=>c.key!=="reject_vendor");
    for(const change of answer.changes)if(change.kind==="relation")change.sourceFindingIds=[change.findingId];
    control.compare=async()=>answer;
    const id=randomUUID();expect((await POST(request("POST",{id,meetingId:fixture.meetings[2],goal:"整理后续工作"}),context())).status).toBe(202);await drain();
    let view=await current(id);const p=view.artifact!.preview!;expect(p.changes).toHaveLength(5);
    for(const {change,review} of p.changes){expect(review?.status).toBe("confirmable");if(change.kind==="relation")expect(change.sourceFindingIds).toEqual(expect.arrayContaining([change.anchorFindingId,change.findingId]));}
    const select={id,eventId:randomUUID(),expectedVersion:1,action:"select",selection:{previewId:p.id,fingerprint:p.fingerprint,keys:p.changes.map(c=>c.change.key)}};
    expect((await PATCH(request("PATCH",select),context())).status).toBe(202);await drain();view=await current(id);
    const a=view.task.approval!,approval={id,eventId:randomUUID(),expectedVersion:1,action:"approval",approvalId:a.id,fingerprint:a.fingerprint,decision:"approve"};
    expect((await PATCH(request("PATCH",approval),context())).status).toBe(202);await drain();view=await current(id);
    expect(view.task.status).toBe("ended");expect(view.artifact!.preview!.fingerprint).toBe(p.fingerprint);
    expect(fixture.todos.getTodo(fixture.accountId,fixture.deployment.id)).toMatchObject({id:fixture.deployment.id,title:"B方案部署",version:1});
    expect(fixture.todos.getTodo(fixture.accountId,fixture.test.id).status).toBe("completed");
    for(const eventId of view.artifact!.applied!.eventIds){
      const event=db.prepare("SELECT finding_id,target_finding_id FROM wr_work_thread_events WHERE id=?").get(eventId) as {finding_id:string;target_finding_id:string};
      const sources=db.prepare("SELECT finding_id FROM wr_work_thread_event_sources WHERE event_id=?").all(eventId) as {finding_id:string}[];
      expect(sources.map(s=>s.finding_id)).toEqual(expect.arrayContaining([event.finding_id,event.target_finding_id]));
    }
    const events=db.prepare("SELECT * FROM wr_todo_events").all(),relations=db.prepare("SELECT * FROM wr_work_thread_events").all();
    expect((await PATCH(request("PATCH",approval),context())).status).toBe(202);await drain();
    expect((await current(id)).artifact).toEqual(view.artifact);expect(db.prepare("SELECT * FROM wr_todo_events").all()).toEqual(events);expect(db.prepare("SELECT * FROM wr_work_thread_events").all()).toEqual(relations);
    expect(answer.changes.filter(c=>c.kind==="relation").every(c=>c.sourceFindingIds.length===1)).toBe(true);expect(fetch).not.toHaveBeenCalled();
  },20000);
  it("runs M2/M3 through actual SDK SSE parsing, API selection, atomic writes and persisted reopen",async()=>{
    control.streaming=true;
    vi.spyOn(console,"info").mockImplementation(()=>{});
    for(const [key,value] of Object.entries({WORK_REVIEW_EXTRACTOR_PROVIDER:"tokenhub-structured-json",WORK_REVIEW_EXTRACTOR_MODEL:"deepseek-v4-pro",
      WORK_REVIEW_EXTRACTOR_MAX_OUTPUT_TOKENS:"6000",WORK_REVIEW_EXTRACTOR_REASONING_EFFORT:"none",WORK_REVIEW_EXTRACTOR_TIMEOUT_MS:"90000",
      OPENAI_BASE_URL:"https://tokenhub.vision-intelligence.tech/v1",OPENAI_API_KEY:"offline-only"}))vi.stubEnv(key,value);
    let answer=fixture.m2;const streams:number[]=[];
    const transport=vi.fn<typeof fetch>(async(input,init)=>{
      const req=new Request(input,init),payload=await req.json();
      expect(payload).toMatchObject({stream:true,store:false,model:"deepseek-v4-pro"});
      const comparison=payload.input.some((m:{role:string;content:string})=>m.role==="system"&&m.content.startsWith("你是办公复盘项目会后比较助手"));
      const text=JSON.stringify(comparison?answer:{tool:"work.compare_meeting",args:{}});
      const response={status:"completed",error:null,incomplete_details:null,
        usage:comparison?{input_tokens:6102,output_tokens:1365,total_tokens:7467}:{input_tokens:11,output_tokens:7,total_tokens:18},
        output:[{type:"message",role:"assistant",content:[{type:"output_text",text}]}]};
      const stream=responseStreamFixture(response,2);streams.push(stream.eventBytes);
      return new Response(stream.body,{headers:{"content-type":"text/event-stream"}});
    });
    vi.stubGlobal("fetch",transport);
    async function begin(index:number){
      const id=randomUUID();expect((await POST(request("POST",{id,meetingId:fixture.meetings[index],goal:"帮我整理今天开完会之后的工作"}),context())).status).toBe(202);
      await drain();const view=await current(id);expect(view.task.wait?.kind).toBe("work_selection");return view;
    }
    async function choose(view:WorkAgentTaskView,keys:string[]){
      const p=view.artifact!.preview!;
      const selection={id:view.task.id,eventId:randomUUID(),expectedVersion:1,action:"select",selection:{previewId:p.id,fingerprint:p.fingerprint,keys}};
      expect((await PATCH(request("PATCH",selection),context())).status).toBe(202);await drain();return current(view.task.id);
    }
    async function confirm(view:WorkAgentTaskView){
      const a=view.task.approval!,approval={id:view.task.id,eventId:randomUUID(),expectedVersion:1,action:"approval",approvalId:a.id,fingerprint:a.fingerprint,decision:"approve"};
      expect((await PATCH(request("PATCH",approval),context())).status).toBe(202);await drain();return approval;
    }
    let m2=await begin(1);
    expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events").get()).toEqual({n:0});
    m2=await choose(m2,m2.artifact!.preview!.changes.map(c=>c.change.key));await confirm(m2);
    let project=await(await GET(request("GET"),context())).json() as WorkAgentProjectView;
    expect(project.threads.find(t=>t.anchorFindingId===fixture.findings.a)).toMatchObject({state:"suspended",currentFindingId:null});
    expect(project.threads.some(t=>t.currentFindingId===fixture.findings.b_proposal)).toBe(false);
    expect(project.timeline.find(t=>t.id===`fact:${fixture.findings.b_proposal}`)?.status).toBe("candidate");
    expect(project.timeline.some(t=>t.label==="暂停决定")).toBe(true);
    answer=fixture.m3;let m3=await begin(2);
    expect(m3.task.usage).toMatchObject({calls:2,inputTokens:6113,outputTokens:1372,unknownUsageCalls:0});
    expect(streams.at(-1)).toBeGreaterThan(200_000);
    const deployment=m3.artifact!.preview!.changes.find(c=>c.change.key==="update_deploy")!;
    expect(deployment.review?.status).toBe("confirmable");
    expect(m3.artifact!.preview!.changes.find(c=>c.change.key==="reject_vendor")?.review?.status).toBe("blocked");
    expect(deployment.before).toContain("A方案部署");expect(deployment.after).toContain("B方案部署");
    expect(fixture.todos.getTodo(fixture.accountId,fixture.deployment.id).title).toBe("A方案部署");
    m3=await choose(m3,["replace","update_deploy","complete_test","close_q","monitor"]);
    expect(fixture.todos.getTodo(fixture.accountId,fixture.test.id).status).toBe("open");
    const approval=await confirm(m3);
    expect(fixture.todos.getTodo(fixture.accountId,fixture.deployment.id)).toMatchObject({title:"B方案部署",currentDueDate:"2026-10-30",sourceFindingId:fixture.findings.deploy});
    expect(fixture.todos.getTodo(fixture.accountId,fixture.test.id).status).toBe("completed");
    expect(fixture.todos.getTodo(fixture.accountId,fixture.vendor.id).status).toBe("open");
    expect(db.prepare("SELECT count(*) n FROM wr_todos").get()).toEqual({n:4});
    const events=db.prepare("SELECT * FROM wr_todo_events ORDER BY rowid").all();
    expect((await PATCH(request("PATCH",approval),context())).status).toBe(202);await drain();
    expect(db.prepare("SELECT * FROM wr_todo_events ORDER BY rowid").all()).toEqual(events);
    // Each request opens/closes the actual Runtime; GET re-reads the persisted database.
    project=await(await GET(request("GET"),context())).json() as WorkAgentProjectView;
    expect(project.tasks.find(t=>t.task.id===m3.task.id)?.artifact?.applied).toMatchObject({selectedKeys:["close_q","complete_test","monitor","replace","update_deploy"],rejectedKeys:["reject_vendor"]});
    const timeline=project.threads.find(t=>t.anchorFindingId===fixture.findings.a)!;
    expect(timeline).toMatchObject({state:"active",currentFindingId:fixture.findings.b});
    expect(timeline.events.map(e=>e.relation)).toEqual(["records","suspends","supersedes"]);
    expect(project.threads.find(t=>t.anchorFindingId===fixture.findings.rollback)?.state).toBe("resolved");
    expect(project.openLoops.some(l=>l.text.includes("日志保留期限"))).toBe(true);
    expect(project.openLoops.some(l=>l.text.includes("供应商"))).toBe(true);
    expect(project.timeline.filter(t=>t.threadId===timeline.id).map(t=>[t.date,t.label])).toEqual([
      ["2026-10-06","记录事实"],["2026-10-13","暂停决定"],["2026-10-27","替代决定"]]);
    expect(project.openLoops.find(l=>l.todoId===fixture.vendor.id)?.status).toBe("waiting");
    expect(project.openLoops.some(l=>l.todoId===fixture.test.id)).toBe(false);
    expect(project.openLoops.find(l=>l.title==="同步延迟监控")?.sources.some(s=>s.findingId===fixture.findings.monitor)).toBe(true);
    expect(project.openLoops.some(l=>l.title==="回滚重复写入问题")).toBe(false);
    expect(project.openLoops.find(l=>l.title==="客户约束清单")?.status).toBe("no_follow_up");
    for(const item of project.timeline)for(const ref of item.sources){
      const evidence=await GET(new Request(`${request("GET").url}?findingId=${ref.findingId}`),context());
      expect(evidence.status).toBe(200);expect((await evidence.json()).source.meetingId).toBe(ref.meetingId);
    }
    const source=await GET(new Request(`${request("GET").url}?findingId=${fixture.findings.b}`),context());
    expect((await source.json()).source.evidence[0].text).toContain("正式决定一期用B替代A");
    expect(transport).toHaveBeenCalledTimes(4); // Decisions + internal comparisons; approvals never call the model.
    expect(db.prepare("SELECT count(*) n FROM agent_calls WHERE status='succeeded'").get()).toEqual({n:4});
  },20000);
  it("starts, selects only approved changes, refreshes, opens sources and replays double clicks",async()=>{
    const id=randomUUID(),body={id,meetingId:fixture.meetings[2],goal:"帮我整理今天开完会之后的工作"};
    expect((await POST(request("POST",body),context())).status).toBe(202);await drain();
    let view=await current(id);expect(view.task.wait?.kind).toBe("work_selection");
    const p=view.artifact!.preview!,select={id,eventId:randomUUID(),expectedVersion:1,action:"select",selection:{previewId:p.id,fingerprint:p.fingerprint,keys:["update_deploy","complete_test","close_q","monitor"]}};
    expect((await PATCH(request("PATCH",select),context())).status).toBe(202);await drain();
    view=await current(id);expect(view.task.approval?.status).toBe("pending");
    const a=view.task.approval!,approval={id,eventId:randomUUID(),expectedVersion:1,action:"approval",approvalId:a.id,fingerprint:a.fingerprint,decision:"approve"};
    expect((await PATCH(request("PATCH",approval),context())).status).toBe(202);await drain();
    expect((await current(id)).task.status).toBe("ended");
    expect((await PATCH(request("PATCH",approval),context())).status).toBe(202);await drain();
    expect((await current(id)).artifact?.applied?.selectedKeys).toHaveLength(4);
    expect(db.prepare("SELECT count(*) AS n FROM wr_todos WHERE title='同步延迟监控'").get()).toEqual({n:1});
    // As in real acceptance, no records relation was proposed for the log question.
    const project=await(await GET(request("GET"),context())).json() as WorkAgentProjectView;
    expect(project.threads.some(t=>t.anchorFindingId===fixture.findings.logs)).toBe(false);
    expect(project.openLoops.some(l=>l.kind==="question"&&l.text.includes("日志保留期限"))).toBe(true);
    expect(project.openLoops.some(l=>l.todoId===fixture.vendor.id)).toBe(true);
    expect(project.openLoops.some(l=>l.todoId===fixture.test.id)).toBe(false);
    expect(project.threads.find(t=>t.anchorFindingId===fixture.findings.rollback)?.state).toBe("resolved");
    expect(project.openLoops.some(l=>l.kind==="question"&&l.text.includes("回滚重复写入问题"))).toBe(false);
    const source=await GET(new Request(`${request("GET").url}?findingId=${fixture.findings.b}`),context());
    expect(source.headers.get("cache-control")).toBe("private, no-store");expect((await source.json()).source.evidence[0].text).toContain("正式决定");
    expect(fetch).not.toHaveBeenCalled();
  },20000);
  it("rejects both observed unsafe operations through the API and preserves the saved suggestions for review",async()=>{
    const answer=structuredClone(fixture.m3),deploy=answer.changes.find(c=>c.key==="update_deploy")!;
    if(deploy.kind!=="update_todo")throw Error("fixture");deploy.label="调整B方案部署";deploy.title="A方案部署";
    control.compare=async()=>answer;
    const id=randomUUID();await POST(request("POST",{id,meetingId:fixture.meetings[2],goal:"整理后续工作"}),context());await drain();
    const view=await current(id),p=view.artifact!.preview!;
    for(const key of ["reject_vendor","update_deploy"]){
      expect(p.changes.find(c=>c.change.key===key)?.review?.status).toBe("blocked");
      const response=await PATCH(request("PATCH",{id,eventId:randomUUID(),expectedVersion:1,action:"select",selection:{previewId:p.id,fingerprint:p.fingerprint,keys:[key]}}),context());
      expect(response.status).toBe(409);await drain();
    }
    expect((await current(id)).artifact?.preview?.selectedKeys).toBeNull();
    expect(db.prepare("SELECT count(*) n FROM agent_approvals").get()).toEqual({n:0});
    expect(db.prepare("SELECT count(*) n FROM wr_todo_events").get()).toEqual({n:3});
    expect(fixture.todos.getTodo(fixture.accountId,fixture.vendor.id)).toEqual(fixture.vendor);
    expect(fixture.todos.getTodo(fixture.accountId,fixture.deployment.id)).toEqual(fixture.deployment);
    expect(fetch).not.toHaveBeenCalled();
  },20000);
  it("rejects tampered preview/fingerprint, cross-account access, unlinked sources and disabled capability",async()=>{
    const id=randomUUID();await POST(request("POST",{id,meetingId:fixture.meetings[2],goal:"安排后续"}),context());await drain();
    const view=await current(id),p=view.artifact!.preview!;
    const response=await PATCH(request("PATCH",{id,eventId:randomUUID(),expectedVersion:1,action:"select",selection:{previewId:p.id,fingerprint:"f".repeat(64),keys:["monitor"]}}),context());
    expect(response.status).toBe(409);expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events").get()).toEqual({n:0});
    control.accountId="account_b";expect((await GET(request("GET"),context())).status).toBe(404);
    control.accountId=fixture.accountId;const meeting=fixture.repo.getMeeting(fixture.accountId,fixture.meetings[0]);
    fixture.projects.setMeetingProjects({accountId:fixture.accountId,meetingId:meeting.id,expectedVersion:meeting.version,projectIds:[],operationKey:"remove"});
    expect((await GET(new Request(`${request("GET").url}?findingId=${fixture.findings.a}`),context())).status).toBe(409);
    expect((await current(id)).artifact?.comparison).toBeNull();
    control.enabled=false;expect((await POST(request("POST",{}),context())).status).toBe(404);
  },20000);
});
