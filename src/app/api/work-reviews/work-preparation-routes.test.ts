// @vitest-environment node
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {openWorkReviewDatabase} from "@/lib/server/work-review/db";
import {seedPreparationCase,preparationDraft,createPreparationM4,preparationReview} from "@/lib/server/work-review/preparation-test-fixture";
import {openWorkPreparationRuntime} from "@/lib/server/work-review/preparation-service";
import type {WorkPreparationProject} from "@/lib/domain/work-preparation";
import {GET,POST,PATCH} from "./projects/[projectId]/preparations/route";
import {responseStreamFixture} from "@/lib/server/openai/structured-json-stream.test-fixture";

const control=vi.hoisted(()=>({accountId:"account_a",enabled:true,queue:[] as Array<()=>Promise<void>>,db:undefined as unknown,checkpoint:"",m4:undefined as unknown,streaming:false}));
vi.mock("next/server",async original=>({...await original<typeof import("next/server")>(),after:(fn:()=>Promise<void>)=>control.queue.push(fn)}));
vi.mock("@/lib/server/auth/request-context",()=>({requireAuthContext:async()=>({user:{id:control.accountId}}),isUnauthenticatedError:()=>false}));
vi.mock("@/lib/server/work-review/runtime-config",async original=>({...await original<typeof import("@/lib/server/work-review/runtime-config")>(),isWorkReviewProjectsEnabled:()=>control.enabled,isWorkReviewTodoEnabled:()=>control.enabled}));
vi.mock("@/lib/server/work-review/db",async original=>({...await original<typeof import("@/lib/server/work-review/db")>(),getWorkReviewDatabase:()=>control.db}));
vi.mock("@/lib/server/work-review/preparation-service",async original=>{
  const actual=await original<typeof import("@/lib/server/work-review/preparation-service")>();
  return {...actual,advanceWorkPreparation:async(account:string,id:string)=>{
    if(control.streaming)return actual.advanceWorkPreparation(account,id);
    const runner=actual.openWorkPreparationRuntime(control.db as ReturnType<typeof openWorkReviewDatabase>,{checkpointPath:control.checkpoint,
      generate:async context=>preparationDraft(context),review:async input=>preparationReview(input.agenda,control.m4 as ReturnType<typeof createPreparationM4>),
      decision:async input=>({tool:(input.task.scope as {mode:string}).mode==="prepare"?"work.prepare_meeting":"work.review_preparation",args:{}})});
    try{await runner.runtime.advance(account,id);}finally{runner.runtime.close();}
  }};
});
let root:string,db:ReturnType<typeof openWorkReviewDatabase>,f:Awaited<ReturnType<typeof seedPreparationCase>>;
beforeEach(async()=>{root=mkdtempSync(join(tmpdir(),"work-prep-api-"));db=openWorkReviewDatabase({filePath:join(root,"work.sqlite")});
  vi.stubGlobal("fetch",vi.fn(()=>{throw Error("external_forbidden");}));f=await seedPreparationCase(db);Object.assign(control,{accountId:f.accountId,db,queue:[],enabled:true,streaming:false,checkpoint:join(root,"prep.sqlite")});});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const context=()=>({params:Promise.resolve({projectId:f.project.id})});
const request=(method:string,body?:unknown)=>new Request(`http://localhost/api/work-reviews/projects/${f.project.id}/preparations`,{method,...(body?{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
async function drain(){while(control.queue.length)await control.queue.shift()!();}
async function current(){const response=await GET(request("GET"),context());expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");return response.json() as Promise<WorkPreparationProject>;}
describe("P3 authenticated API with real SQLite",{timeout:30000},()=>{
  it("uses real SSE parsing and runtime usage for generation, persists user edit and produces a grounded M4 review",async()=>{
    control.streaming=true;
    for(const [key,value]of Object.entries({WORK_REVIEW_EXTRACTOR_PROVIDER:"tokenhub-structured-json",WORK_REVIEW_EXTRACTOR_MODEL:"deepseek-v4-pro",WORK_REVIEW_EXTRACTOR_MAX_OUTPUT_TOKENS:"6000",WORK_REVIEW_EXTRACTOR_REASONING_EFFORT:"none",OPENAI_BASE_URL:"https://tokenhub.vision-intelligence.tech/v1",OPENAI_API_KEY:"offline-fixture-key"}))vi.stubEnv(key,value);
    const transport=vi.fn<typeof fetch>(async(input,init)=>{
      const req=new Request(input,init),body=await req.json(),user=JSON.parse(body.input.find((m:{role:string})=>m.role==="user").content);
      if(!user.authorizedScope&&!user.agenda){expect(user.asOf).toMatch(/^\d{4}-/);expect(user.meetingDate).toBeNull();expect(user.context.meetingDate).toBeNull();}
      const answer=user.authorizedScope?{tool:user.authorizedScope.mode==="prepare"?"work.prepare_meeting":"work.review_preparation",args:{}}
        :user.agenda?preparationReview(user.agenda,control.m4 as ReturnType<typeof createPreparationM4>):{agenda:preparationDraft(user.context).agenda.map(({reason:_,background:__,currentStatus:___,...a})=>a)};
      const response={status:"completed",error:null,incomplete_details:null,usage:{input_tokens:123,output_tokens:45},output:[{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(answer)}]}]};
      return new Response(responseStreamFixture(response).body,{headers:{"content-type":"text/event-stream"}});
    });vi.stubGlobal("fetch",transport);vi.spyOn(console,"info").mockImplementation(()=>{});
    const start={id:randomUUID(),mode:"prepare",goal:"准备下次项目会议"};
    expect((await POST(request("POST",start),context())).status).toBe(202);await drain();
    expect((await POST(request("POST",start),context())).status).toBe(202);await drain();
    let p=(await current()).preparations[0];expect(p.snapshot?.coverage.meetingsRead).toBe(3);expect(p.meetingDate).toBeNull();
    expect(p.agenda.find(a=>a.id==="deployment")?.currentStatus).toContain("尚无完成确认记录");
    expect(p.agenda.find(a=>a.id==="vendor")?.currentStatus).toContain("等待他人回复");
    const agenda=p.agenda.map(({userEdited:_,sourceInvalid:__,...a})=>({...a,question:"用户编辑后的问题",currentStatus:"注入的错误事实"}));
    const save={id:p.id,operationKey:randomUUID(),expectedVersion:p.version,action:"save",agenda};
    expect((await PATCH(request("PATCH",save),context())).status).toBe(200);
    expect((await PATCH(request("PATCH",save),context())).status).toBe(200);p=(await current()).preparations[0];expect(p.version).toBe(2);expect(JSON.stringify(p)).not.toContain("注入的错误事实");
    const m4=createPreparationM4(f);control.m4=m4;
    expect((await PATCH(request("PATCH",{id:p.id,operationKey:randomUUID(),expectedVersion:p.version,action:"link",meetingId:m4.meetingId}),context())).status).toBe(200);
    expect((await POST(request("POST",{id:randomUUID(),mode:"review",preparationId:p.id,goal:"对照会前与会后"}),context())).status).toBe(202);await drain();
    p=(await current()).preparations[0];expect(p.meetingDate).toBe("2026-11-03");expect(p.review?.items.find(i=>i.agendaId==="deployment")?.status).toBe("completed");
    expect(p.review?.items.find(i=>i.agendaId==="constraints")?.status).toBe("not_discussed");
    expect(p.review?.confirmed).toBe(false);expect(transport).toHaveBeenCalledTimes(4);
    const calls=db.prepare("SELECT status,input_tokens,output_tokens FROM agent_calls WHERE kind LIKE 'work_meeting_preparation%' ").all();
    expect(calls).toHaveLength(2);expect(calls.every(c=>(c as {status:string}).status==="succeeded")).toBe(true);
    expect(f.todos.getTodo(f.accountId,f.deployment.id).status).toBe("open");
  });
  it("rejects foreign projects/accounts, stale versions, unlinked meetings and disabled feature",async()=>{
    await POST(request("POST",{id:randomUUID(),mode:"prepare",goal:"准备会议"}),context());await drain();
    const p=(await current()).preparations[0];
    expect((await PATCH(request("PATCH",{id:p.id,operationKey:randomUUID(),expectedVersion:99,action:"save",agenda:[]}),context())).status).toBe(409);
    control.accountId="different_account";expect((await GET(request("GET"),context())).status).toBe(404);
    control.accountId=f.accountId;const m=f.repo.getMeeting(f.accountId,f.meetings[0]);f.projects.setMeetingProjects({accountId:f.accountId,meetingId:m.id,expectedVersion:m.version,operationKey:"unlink_api",projectIds:[]});
    expect((await POST(request("POST",{id:randomUUID(),mode:"prepare",goal:"准备会议",meetingId:m.id}),context())).status).toBe(409);
    control.enabled=false;expect((await GET(request("GET"),context())).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
