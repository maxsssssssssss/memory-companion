// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const { auth, generate, frameworkGenerate, configure } = vi.hoisted(()=>({auth:vi.fn(),generate:vi.fn(),frameworkGenerate:vi.fn(),configure:vi.fn()}));
vi.mock("@/lib/server/auth/request-context",async original=>({...await original<typeof import("@/lib/server/auth/request-context")>(),requireAuthContext:auth}));
vi.mock("@/lib/server/learning/framework-generator",async original=>({...await original<typeof import("@/lib/server/learning/framework-generator")>(),generateStudyJson:generate,generateLearningFramework:frameworkGenerate,learningGenerationConfig:configure}));
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningFrameworkRepository } from "@/lib/server/learning/framework-repository";
import { GET,POST,PATCH } from "./pages/[pageId]/node-qa/route";
import { GET as overview,POST as update } from "./pages/[pageId]/overview/route";
import { GET as source } from "./pages/[pageId]/study-source/route";
import { POST as organize } from "./pages/[pageId]/framework/route";
let root:string,pageId:string,materialId:string,chapterId:string,nodeId:string;
const ctx=()=>({params:Promise.resolve({pageId})});
const req=(method="GET",body?:unknown,user="owner",suffix="",origin="http://localhost")=>new Request(`http://localhost/api/learning/pages/${pageId}/node-qa${suffix}`,{method,headers:{origin,"x-user":user,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
const ask=()=>({id:randomUUID(),conversationId:randomUUID(),chapterId,nodeId,action:"ask",question:"[合成] 解释基础术语"});
const nodeQuery=()=>`?chapter=${chapterId}&node=${nodeId}`;
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),"learning-study-routes-"));pageId=randomUUID();materialId=randomUUID();const repo=new LearningRepository(join(root,"owner"),"owner");repo.create({id:pageId,title:"[合成测试]"});repo.saveMaterials(pageId,[{id:materialId,title:"[合成]",kind:"text",filename:null,bytes:Buffer.from("[合成] 只有满足前提才适用。\n\n[合成] 不满足前提的反例。") }]);
 const f=new LearningFrameworkRepository(repo),id=randomUUID();f.begin(pageId,{id,materialIds:[materialId]},10000);f.validating(pageId,id);f.complete(pageId,id,{overview:"模拟",chapters:[{title:"合成章",explanation:"模拟",nodes:[{title:"合成点",explanation:"模拟",supplement:null,sources:[{materialId,paragraph:1}]}]}]});const c=f.view(pageId).chapters[0];chapterId=c.id;nodeId=c.nodes[0].id;repo.close();
 auth.mockImplementation(async(r:Request)=>{const id=r.headers.get("x-user");if(!id)throw Error("unauthenticated");return{user:{id},dataRootDir:join(root,id)};});
 configure.mockReturnValue({baseURL:"https://synthetic.invalid",apiKey:"SYNTHETIC",model:"mock",maxInputChars:10000,maxOutputTokens:4000});
 generate.mockResolvedValue({materialAnswer:"[模拟] 条件",supplements:[{kind:"explanation",text:"[模拟补充] 基础术语。"}],items:[{materialId,paragraph:1}]});
 frameworkGenerate.mockImplementation(async(_c,inputs)=>({overview:"模拟第二批",chapters:[{title:"追加章",explanation:"包含反例",nodes:[{title:"追加点",explanation:"模拟",supplement:null,sources:[{materialId:inputs[0].materialId,paragraph:1}]}]}]}));
 vi.stubGlobal("fetch",vi.fn(()=>{throw Error("Network forbidden");}));
});
afterEach(async()=>{vi.clearAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
it("authenticates all QA/overview/source/note routes and rejects cross-origin writes",async()=>{
 for(const user of ["","stranger"]){const status=user?404:401;expect((await GET(req("GET",undefined,user,nodeQuery()),ctx())).status).toBe(status);expect((await overview(req("GET",undefined,user),ctx())).status).toBe(status);expect((await POST(req("POST",ask(),user),ctx())).status).toBe(status);expect((await update(req("POST",{id:randomUUID()},user),ctx())).status).toBe(status);expect((await PATCH(req("PATCH",{turnId:randomUUID(),chapterId,nodeId,revision:0,section:-1},user),ctx())).status).toBe(status);expect((await source(req("GET",undefined,user,`?kind=answer&id=${randomUUID()}&item=0&index=0`),ctx())).status).toBe(status);}
 expect((await POST(req("POST",ask(),"owner","","https://foreign.invalid"),ctx())).status).toBe(403);expect(generate).not.toHaveBeenCalled();
});
it("saves/reopens a real isolated answer, serves original source, and appends only an explicitly selected note",async()=>{
 const a=ask();const result=await POST(req("POST",a),ctx());expect(result.status).toBe(200);expect(result.headers.get("cache-control")).toContain("no-store");const body=await result.json();expect((await (await GET(req("GET",undefined,"owner",nodeQuery()),ctx())).json())).toEqual(body);
 await POST(req("POST",a),ctx());expect(generate).toHaveBeenCalledTimes(1);const s=await source(req("GET",undefined,"owner",`?kind=answer&id=${a.id}&item=0&index=0`),ctx());expect((await s.json()).source.paragraph.text).toContain("只有满足前提");
 const note={turnId:a.id,chapterId,nodeId,revision:0,section:0};expect((await PATCH(req("PATCH",note),ctx())).status).toBe(200);expect((await PATCH(req("PATCH",note),ctx())).status).toBe(200);
 const l=new LearningRepository(join(root,"owner"),"owner");const n=new LearningFrameworkRepository(l).view(pageId).chapters[0].nodes[0];expect(n.explanation).toBe("模拟");expect(n.note).toContain("基础术语");l.deleteMaterial(pageId,materialId);l.close();expect((await source(req("GET",undefined,"owner",`?kind=answer&id=${a.id}&item=0&index=0`),ctx())).status).toBe(410);expect((await GET(req("GET",undefined,"owner",nodeQuery()),ctx())).status).toBe(200);
});
it("automatically attempts overview after new framework publication without replacing old chapters when overview fails",async()=>{
 generate.mockRejectedValueOnce(Error("PRIVATE"));const id=randomUUID();const response=await organize(req("POST",{id,materialIds:[materialId]}),ctx());expect(response.status).toBe(200);expect((await response.json()).framework.chapters).toHaveLength(2);expect(frameworkGenerate).toHaveBeenCalledTimes(1);expect(generate).toHaveBeenCalledTimes(1);expect((await (await overview(req(),ctx())).json()).overview.latest.status).toBe("failed");
 await organize(req("POST",{id,materialIds:[materialId]}),ctx());expect(generate).toHaveBeenCalledTimes(1);
});
it("late model answers cannot restore a deleted page; error payloads never include Provider body",async()=>{
 let done!:(v:unknown)=>void;generate.mockImplementationOnce(()=>new Promise(r=>{done=r;}));const pending=POST(req("POST",ask()),ctx());await vi.waitFor(()=>expect(generate).toHaveBeenCalled());const l=new LearningRepository(join(root,"owner"),"owner");l.deletePage(pageId);l.close();done({});expect((await pending).status).toBe(410);
});
it("replaying an old first-batch ID after later chapters exist never introduces an overview call",async()=>{
 const l=new LearningRepository(join(root,"owner"),"owner"),f=new LearningFrameworkRepository(l);const first=f.view(pageId).runs[0].id;const id=randomUUID();f.begin(pageId,{id,materialIds:[materialId]},10000);f.validating(pageId,id);f.complete(pageId,id,{overview:"模拟",chapters:[{title:"第二批",explanation:"模拟",nodes:[{title:"点",explanation:"模拟",supplement:null,sources:[{materialId,paragraph:1}]}]}]});l.close();
 expect((await organize(req("POST",{id:first,materialIds:[materialId]}),ctx())).status).toBe(200);expect(generate).not.toHaveBeenCalled();expect(frameworkGenerate).not.toHaveBeenCalled();
});
