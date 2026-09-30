// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { getUserDataRootDir } from "@/lib/server/auth/session";
import { JsonStore } from "@/lib/server/storage/json-store";
import { LearningRepository } from "@/lib/server/learning/repository";
const {auth,afterCallbacks,generate} = vi.hoisted(()=>({auth:vi.fn(),afterCallbacks:[] as Array<()=>Promise<void>>,generate:vi.fn()}));
vi.mock("@/lib/server/auth/request-context",async(original)=>({...await original<typeof import("@/lib/server/auth/request-context")>(),requireAuthContext:auth}));
vi.mock("next/server",async(original)=>({...await original<typeof import("next/server")>(),after:(work:()=>Promise<void>)=>afterCallbacks.push(work)}));
vi.mock("@/lib/server/learning/framework-generator",async(original)=>({
  ...await original<typeof import("@/lib/server/learning/framework-generator")>(),
  learningGenerationConfig:()=>({baseURL:"https://synthetic.invalid",apiKey:"SYNTHETIC",model:"SYNTHETIC",maxInputChars:120_000,maxOutputTokens:4000}),
  generateLearningFramework:generate, generateStudyJson:vi.fn(async()=>{throw new Error("Unexpected overview Provider");})
}));
import { GET,POST } from "./pages/[pageId]/preparation/route";
import { POST as upload } from "./pages/[pageId]/materials/route";
let root:string,page:string;
const context=()=>({params:Promise.resolve({pageId:page})});
function request(method="GET",body?:unknown,account="a") {return new Request(`http://localhost/api/learning/pages/${page}/preparation`,{method,headers:{origin:"http://localhost","x-synthetic-account":account,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function drain(){for(const callback of afterCallbacks.splice(0))await callback();}
function repo(){return new LearningRepository(getUserDataRootDir("a",root),"a");}
function form(intent?:string,id=randomUUID()) {
  const body=new FormData();body.set("materials",JSON.stringify([{id,title:"SYNTHETIC",kind:"text"}]));body.append("files",new Blob(["SYNTHETIC lesson."],{type:"text/plain"}),"synthetic.txt");if(intent)body.set("intent",intent);
  return new Request(`http://localhost/api/learning/pages/${page}/materials`,{method:"POST",headers:{origin:"http://localhost","x-synthetic-account":"a"},body});
}
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),"learning-preparation-api-synthetic-"));page=randomUUID();afterCallbacks.length=0;vi.clearAllMocks();
  auth.mockImplementation(async(r:Request)=>{const id=r.headers.get("x-synthetic-account");if(!id||!["a","b"].includes(id))throw new Error("unauthenticated");const dataRootDir=getUserDataRootDir(id,root);return {user:{id,email:`${id}@synthetic.invalid`},dataRootDir,uploadsRootDir:join(dataRootDir,"uploads"),store:new JsonStore(dataRootDir)};});
  const r=repo();r.create({id:page,title:"SYNTHETIC"});r.close();
  generate.mockImplementation(async(_config,inputs:Array<{materialId:string}>)=>({overview:"SYNTHETIC",chapters:[{title:"SYNTHETIC",explanation:"SYNTHETIC",nodes:inputs.map(input=>({title:"SYNTHETIC",explanation:"SYNTHETIC",supplement:null,sources:[{materialId:input.materialId,paragraph:1}]}))}]}));
  vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("Network forbidden");}));
});
afterEach(async()=>{await drain();expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();await rm(root,{force:true,recursive:true});});
it("authenticates reads and mutations, denies foreign pages and cross-origin starts",async()=>{
  expect((await GET(request("GET",undefined,""),context())).status).toBe(401);
  expect((await POST(request("POST",{},""),context())).status).toBe(401);
  expect((await GET(request("GET",undefined,"b"),context())).status).toBe(404);
  expect((await POST(request("POST",{id:randomUUID(),materialIds:[randomUUID()]},"b"),context())).status).toBe(404);
  const foreign=request("POST",{});foreign.headers.set("origin","https://foreign.invalid");expect((await POST(foreign,context())).status).toBe(403);
  expect(generate).not.toHaveBeenCalled();
});
it("save only and refresh never prepare or generate; explicit start binds that saved material",async()=>{
  const material=randomUUID();expect((await upload(form("save",material),context())).status).toBe(200);
  const response=await GET(request(),context());expect(response.headers.get("cache-control")).toBe("private, no-store");expect(await response.json()).toEqual({runs:[]});expect(generate).not.toHaveBeenCalled();
  const id=randomUUID();expect((await POST(request("POST",{id,materialIds:[material]}),context())).status).toBe(200);await drain();
  expect((await (await GET(request(),context())).json()).runs[0]).toMatchObject({id,status:"completed",frameworkPublished:true});expect(generate).toHaveBeenCalledTimes(1);
  await POST(request("POST",{id,materialIds:[material]}),context());await drain();expect(generate).toHaveBeenCalledTimes(1);
});
it("upload organize records and runs this batch; prepare intent stops before framework",async()=>{
  const a=randomUUID();const saved=await (await upload(form("organize",a),context())).json();expect(saved.run.intent).toBe("organize");expect(saved.page.materials[0].selected).toBe(true);await drain();
  expect(generate).toHaveBeenCalledTimes(1);
  const b=randomUUID();const prepared=await (await upload(form("prepare",b),context())).json();expect(prepared.run.intent).toBe("prepare");await drain();
  const runs=(await (await GET(request(),context())).json()).runs;expect(runs[1]).toMatchObject({intent:"prepare",status:"completed",frameworkPublished:false});expect(generate).toHaveBeenCalledTimes(1);
});
it("rejects intent ambiguity and reusing a request id for a different material set",async()=>{
  const a=randomUUID(),b=randomUUID();await upload(form("save",a),context());await upload(form("save",b),context());
  const id=randomUUID();await POST(request("POST",{id,materialIds:[a],intent:"prepare"}),context());await drain();
  expect((await POST(request("POST",{id,materialIds:[b],intent:"prepare"}),context())).status).toBe(409);
  const initial=form("save"),body=await initial.formData();body.set("prepare","yes");const mixed=new Request(initial.url,{method:"POST",headers:{origin:"http://localhost","x-synthetic-account":"a"},body});
  expect((await upload(mixed,context())).status).toBe(400);expect(generate).not.toHaveBeenCalled();
});
