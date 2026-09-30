// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { LearningRepository,LearningError } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningQuizRepository } from "./quiz-repository";
import { organizeLearningText } from "./framework-service";
import { generateLearningQuiz } from "./quiz-service";
import { sourceBatches,sourceRequest } from "./generation-sources";
import { generationProgress,GenerationParts } from "./generation-parts";
import type { FrameworkInput } from "./framework-repository";
import { generateStudyJson } from "./framework-generator";
import { LearningStudyRepository } from "./study-repository";
import { updateLearningOverview } from "./study-service";
import { StructuredJsonResponseError } from "@/lib/server/openai/structured-json";

let root:string,repo:LearningRepository,page:string;
const config={baseURL:"https://synthetic.invalid",apiKey:"SYNTHETIC",model:"synthetic-model",maxInputChars:48000,maxOutputTokens:8000};
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"learning-large-synthetic-"));repo=new LearningRepository(root,"owner");page=randomUUID();repo.create({id:page,title:"[合成隔离测试] 大材料"});vi.stubGlobal("fetch",vi.fn(()=>{throw Error("Network forbidden");}));});
afterEach(async()=>{if(repo.database.open)repo.close();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
function material(body:string){const id=randomUUID();repo.saveMaterials(page,[{id,title:"[合成] 规则",kind:"text",filename:null,bytes:Buffer.from(body)}]);return id;}
const body=Array.from({length:70},(_,i)=>`[合成] 第${i+1}节。仅在前提成立时适用，并非反例也成立。${"完整解释、定义与例外。".repeat(180)}`).join("\n\n");
const framework=(_config:unknown,inputs:FrameworkInput[])=>Promise.resolve({overview:"[模拟] 本部分",chapters:inputs.map(m=>({title:"[模拟] "+m.paragraphs[0].number,explanation:"[模拟] 条件与例外",nodes:m.paragraphs.map(p=>({title:"[模拟] 段"+p.number,explanation:"[模拟] 保留条件",supplement:null,sources:[{materialId:m.materialId,paragraph:p.number}]}))}))});

it("covers every character of a large single paragraph, preserving original identity without a full-course limit",()=>{
  const id=randomUUID(),text="[合成] 只有条件成立。反例不能推出成立。".repeat(9000);
  const chunks=sourceBatches([{materialId:id,title:"合成",paragraphs:[{number:37,text}]}],9000);
  expect(chunks.length).toBeGreaterThan(10);
  expect(chunks.flatMap(c=>c.flatMap(m=>m.paragraphs)).map(p=>p.text).join("")).toBe(text);
  for(const c of chunks){expect(new Set(c.flatMap(m=>m.paragraphs.map(p=>p.number)))).toEqual(new Set([37]));expect(sourceRequest(c).resolve("r1")).toEqual({materialId:id,paragraph:37});}
});
it("framework aliases are exact per request, keep sparse paragraph numbers, and refuse invented IDs",()=>{
  const a=randomUUID(),b=randomUUID();const input=[{materialId:a,title:"合成一",paragraphs:[{number:9,text:"[合成] 条件"}]},{materialId:b,title:"合成二",paragraphs:[{number:72,text:"[合成] 例外"}]}];
  const c=sourceRequest(input);
  const result={overview:"[模拟]",chapters:[{title:"[模拟]",explanation:"[模拟]",nodes:[{title:"[模拟]",explanation:"[模拟]",supplement:null,sources:["r1","r2"]}]}]};
  expect(c.decodeFramework(result).chapters[0].nodes[0].sources).toEqual([{materialId:a,paragraph:9},{materialId:b,paragraph:72}]);
  expect(JSON.stringify(c.input)).not.toContain(a);expect(()=>c.resolve("r3")).toThrow("framework_invalid_source");
  expect(()=>c.decodeFramework({...result,chapters:[{...result.chapters[0],nodes:[{...result.chapters[0].nodes[0],sources:[a]}]}]})).toThrow();
});
it("organizes over 120k source characters, stages all parts, publishes together and reopens exact sources",async()=>{
  const id=material(body),run=randomUUID(),seen:string[]=[];
  const generate=vi.fn(async(c,inputs:FrameworkInput[])=>{expect(new LearningFrameworkRepository(repo).view(page).chapters).toHaveLength(0);seen.push(...inputs.flatMap(m=>m.paragraphs.map(p=>p.text)));return framework(c,inputs);});
  const v=await organizeLearningText(repo,page,{id:run,materialIds:[id]},{configure:()=>config,generate});
  expect(v.runs[0].status).toBe("completed");expect(generate.mock.calls.length).toBeGreaterThan(5);
  expect(seen.join("\n\n")).toBe(body);expect(v.chapters.flatMap(c=>c.nodes)).toHaveLength(70);
  const count=generate.mock.calls.length;repo.close();repo=new LearningRepository(root,"owner");
  expect(new LearningFrameworkRepository(repo).view(page)).toEqual(v);
  const c=v.chapters.at(-1)!;expect(new LearningFrameworkRepository(repo).source(page,c.id,c.nodes.at(-1)!.id,0).paragraph.number).toBe(70);
  await organizeLearningText(repo,page,{id:run,materialIds:[id]},{configure:()=>config,generate});expect(generate).toHaveBeenCalledTimes(count);expect(fetch).not.toHaveBeenCalled();
});
it("retains completed parts across reopen; explicit resume retries only the failed part once",async()=>{
  const id=material(body),run=randomUUID();let calls=0;
  const generate=vi.fn(async(c,inputs:FrameworkInput[])=>{if(++calls===2)throw new LearningError(422,"framework_invalid_source");return framework(c,inputs);});
  let result=await organizeLearningText(repo,page,{id:run,materialIds:[id]},{configure:()=>config,generate});
  expect(result.runs[0]).toMatchObject({status:"failed",progress:{completed:1,canResume:true}});expect(result.chapters).toEqual([]);
  const saved=repo.database.prepare("SELECT result_json FROM learning_generation_parts WHERE part_id='read-0'").get();
  repo.close();repo=new LearningRepository(root,"owner");
  result=await organizeLearningText(repo,page,{id:run,materialIds:[id],resume:true},{configure:()=>config,generate});
  expect(result.runs[0].status).toBe("completed");expect(calls).toBe(result.runs[0].progress!.total+1);
  expect(repo.database.prepare("SELECT result_json FROM learning_generation_parts WHERE part_id='read-0'").get()).toEqual(saved);
});
it("does not replay unknown transport outcomes on refresh or explicit resume",async()=>{
  const id=material(body),run=randomUUID(),generate=vi.fn().mockRejectedValue(Error("PRIVATE provider text"));
  await organizeLearningText(repo,page,{id:run,materialIds:[id]},{configure:()=>config,generate});
  expect(generationProgress(repo,page,"framework",run)).toMatchObject({uncertain:true,canResume:false});
  await organizeLearningText(repo,page,{id:run,materialIds:[id],resume:true},{configure:()=>config,generate});expect(generate).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(new LearningFrameworkRepository(repo).view(page))).not.toContain("PRIVATE");
});
it("deletion clears staged source-derived results and fences a late response; other accounts cannot resume",async()=>{
  const id=material(body),run=randomUUID();let resolve!:(v:Awaited<ReturnType<typeof framework>>)=>void;
  const generate=vi.fn((c,inputs:FrameworkInput[])=>new Promise<Awaited<ReturnType<typeof framework>>>(r=>{resolve=r;void framework(c,inputs).then(v=>{setTimeout(()=>{repo.deleteMaterial(page,id);resolve(v);},1);});}));
  const result=await organizeLearningText(repo,page,{id:run,materialIds:[id]},{configure:()=>config,generate});
  expect(result.chapters).toEqual([]);expect(repo.database.prepare("SELECT count(*) n FROM learning_generation_parts").get()).toEqual({n:0});
  const other=new LearningRepository(root,"other");try{expect(()=>generationProgress(other,page,"framework",run)).toThrow("page_not_found");}finally{other.close();}
});
it("rejects changed source versions on resume and preserves the prior failure evidence",async()=>{
  const id=material(body),run=randomUUID(),generate=vi.fn().mockRejectedValue(new LearningError(422,"framework_invalid_source"));
  await organizeLearningText(repo,page,{id:run,materialIds:[id]},{configure:()=>config,generate});
  repo.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("[合成] 已变化"),id);
  await expect(organizeLearningText(repo,page,{id:run,materialIds:[id],resume:true},{configure:()=>config,generate})).rejects.toThrow("source_changed");expect(generate).toHaveBeenCalledTimes(1);
});
it("direct large Quiz reads all selected text, uses original bundles rather than summaries, and saves answer mapping",async()=>{
  const id=material(body),run=randomUUID();let readingText="",writing=0;
  const generate=vi.fn(async(_c,name,_prompt,input)=>{
    if(name==="learning_quiz_reading"){
      readingText+=input.materials.flatMap((m:any)=>m.paragraphs.map((p:any)=>p.text)).join("");
      return {items:[{title:"[模拟索引] 条件与例外",context:"INDEX_NOT_EVIDENCE"}],limitation:null};
    }
    if(name==="learning_quiz_selection"){
      expect(input.windows.flatMap((w:any)=>w.topics)).toEqual(expect.arrayContaining([{title:"[模拟索引] 条件与例外",context:"INDEX_NOT_EVIDENCE"}]));
      return {items:[{windows:[input.windows[0].id,input.windows.at(-1).id],count:input.taskContext.count}]};
    }
    expect(JSON.stringify(input)).not.toContain("INDEX_NOT_EVIDENCE");writing++;
    const refs=input.materials.flatMap((m:any)=>m.paragraphs.map((p:any)=>p.referenceId));
    return {contractVersion:"references-v2",referenceScope:input.taskContext.referenceScope,title:"[模拟] 大资料练习",reason:null,
      materialPlan:input.materials.map((m:any,i:number)=>({material:i+1,contribution:"[模拟] 独有条件",references:m.paragraphs.map((p:any)=>p.referenceId)})),
      items:[0,1].map(i=>({focus:`[模拟] 不同条件${i}`,stem:`[模拟] 条件问题${i}`,kind:"concept",stemEvidenceIds:[refs[0],refs.at(-1)],
        explanationParts:[{text:"[模拟] 条件不能删",evidenceIds:[refs[0],refs.at(-1)]}],
        options:[{id:"A",text:"保留前提",reasonParts:[{text:"[模拟] 来自前提",evidenceIds:[refs[0]]}]},{id:"B",text:"忽略前提",reasonParts:[{text:"[模拟] 不符合原文",evidenceIds:[refs.at(-1)]}]}],correctOptionId:"A",hint:null}))};
  });
  const settings={materialIds:[id],chapterIds:[],nodeIds:[],includeNotes:false,includeSupplements:false,count:2,difficulty:"standard"};
  const rows=await generateLearningQuiz(repo,page,{id:run,settings},{configure:()=>config,generate});
  expect(rows[0].status).toBe("completed");expect(readingText).toBe(body.replace(/\n\n/g,""));expect(writing).toBe(1);expect(new LearningFrameworkRepository(repo).view(page).chapters).toEqual([]);
  const quiz=new LearningQuizRepository(repo),attempt=quiz.startAttempt(page,{id:randomUUID(),quizId:run,mode:"test"});
  expect(JSON.stringify(attempt)).not.toContain("correctOptionId");repo.close();repo=new LearningRepository(root,"owner");expect(new LearningQuizRepository(repo).attempt(page,attempt.id)).toEqual(attempt);expect(fetch).not.toHaveBeenCalled();
});
it("runs large Quiz reading and selection through the actual JSON transport root contract (synthetic SSE only)",async()=>{
  const id=material(body),run=randomUUID(),stages:string[]=[];
  const transport=vi.fn(async(_url:unknown,init:RequestInit)=>{
    const request=JSON.parse(init.body as string),input=JSON.parse(request.input.at(-1).content);
    const prompt=request.input.filter((m:{role:string})=>m.role==="system").map((m:{content:string})=>m.content).join("\n");
    expect(prompt).toContain("根对象必须包含 items 字段");
    expect(request).toMatchObject({model:config.model,reasoning:{effort:"none"},stream:true});
    const refs=(input.materials??[]).flatMap((m:any)=>m.paragraphs.map((p:any)=>p.referenceId));
    let output:unknown;
    if(input.windows){stages.push("selection");output={items:[{windows:[input.windows[0].id],count:input.taskContext.count}]};}
    else if(prompt.includes("定位索引，不生成题目")){stages.push("reading");output={items:[{title:"[模拟] 条件",context:"[模拟] 适用条件及例外"}],limitation:null};}
    else {stages.push("questions");output={contractVersion:"references-v2",referenceScope:input.taskContext.referenceScope,title:"[模拟] 传输验收",reason:null,
      materialPlan:[{material:1,contribution:"[模拟] 条件",references:[refs[0]]}],
      items:[{focus:"[模拟] 前提",stem:"[模拟] 规则是否有前提？",kind:"concept",stemEvidenceIds:[refs[0]],
        options:[{id:"A",text:"有前提",reasonParts:[{text:"[模拟] 原文保留前提",evidenceIds:[refs[0]]}]},{id:"B",text:"忽略前提",reasonParts:[{text:"[模拟] 忽略前提不成立",evidenceIds:[refs[0]]}]}],
        correctOptionId:"A",explanationParts:[{text:"[模拟] 条件仍需保留",evidenceIds:[refs[0]]}],hint:null}]};}
    const event={type:"response.completed",response:{status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(output)}]}],usage:{input_tokens:100,output_tokens:100,total_tokens:200}}};
    return new Response(`data: ${JSON.stringify(event)}\n\n`,{headers:{"content-type":"text/event-stream"}});
  });
  vi.stubGlobal("fetch",transport);
  const settings={materialIds:[id],chapterIds:[],nodeIds:[],includeNotes:false,includeSupplements:false,count:1,difficulty:"standard"};
  const rows=await generateLearningQuiz(repo,page,{id:run,settings},{configure:()=>config,generate:generateStudyJson});
  expect(rows[0].status).toBe("completed");expect(stages.filter(x=>x==="reading").length).toBeGreaterThan(5);
  expect(stages.filter(x=>x==="selection")).toHaveLength(1);expect(stages.filter(x=>x==="questions")).toHaveLength(1);
  expect(transport).toHaveBeenCalledTimes(stages.length);
});

const largeQuizSettings=(id:string)=>({materialIds:[id],chapterIds:[],nodeIds:[],includeNotes:false,includeSupplements:false,count:1,difficulty:"standard" as const});
function quizPlanningResponse(name:string,input:any,invalidReference=false) {
  if(name==="learning_quiz_reading")return {items:[{title:"[模拟索引] 前提",context:"INDEX_NOT_QUESTION_EVIDENCE"}],limitation:null};
  if(name==="learning_quiz_selection")return {items:[{windows:[input.windows[0].id],count:input.taskContext.count}]};
  expect(name).toBe("learning_quiz");
  expect(JSON.stringify(input)).not.toContain("INDEX_NOT_QUESTION_EVIDENCE");
  const ref=input.materials[0].paragraphs[0].referenceId;
  return {contractVersion:"references-v2",referenceScope:input.taskContext.referenceScope,title:"[模拟] 窗口原文题组",reason:null,
    materialPlan:[{material:1,contribution:"[模拟] 规则与前提",references:[ref]}],
    items:[{focus:"[模拟] 前提",stem:"[模拟] 规则在什么条件下适用？",kind:"concept",stemEvidenceIds:[invalidReference?"r999999":ref],
      options:[{id:"A",text:"前提成立时",reasonParts:[{text:"[模拟] 原文明确保留前提",evidenceIds:[ref]}]},
        {id:"B",text:"忽略前提",reasonParts:[{text:"[模拟] 原文没有允许忽略前提",evidenceIds:[ref]}]}],correctOptionId:"A"}]};
}

it("resumes a new Quiz reading contract without repeating completed windows or rewriting their checkpoints",async()=>{
  const id=material(body),run=randomUUID(),settings=largeQuizSettings(id);let readings=0;
  const generate=vi.fn(async(_c,name,_prompt,input)=>{
    if(name==="learning_quiz_reading"&&++readings===2)return {items:[{title:"[模拟] 缺少上下文"}],limitation:null};
    return quizPlanningResponse(name,input);
  });
  let rows=await generateLearningQuiz(repo,page,{id:run,settings},{configure:()=>config,generate});
  expect(rows[0]).toMatchObject({status:"failed",failure:"quiz_reading_invalid_result",progress:{completed:1,canResume:true}});
  const before=repo.database.prepare("SELECT input_hash,state,attempts,result_json FROM learning_generation_parts WHERE run_id=? AND part_id='reading-0'").get(run);
  expect(generate).toHaveBeenCalledTimes(2);
  repo.close();repo=new LearningRepository(root,"owner");
  rows=await generateLearningQuiz(repo,page,{id:run,settings,resume:true},{configure:()=>config,generate});
  expect(rows[0]).toMatchObject({status:"completed",count:1});
  expect(repo.database.prepare("SELECT input_hash,state,attempts,result_json FROM learning_generation_parts WHERE run_id=? AND part_id='reading-0'").get(run)).toEqual(before);
  const count=repo.database.prepare("SELECT count(*) n FROM learning_generation_parts WHERE run_id=? AND part_id LIKE 'reading-%'").get(run) as {n:number};
  expect(readings).toBe(count.n+1);
  expect(repo.database.prepare("SELECT state,attempts FROM learning_generation_parts WHERE run_id=? AND part_id='reading-1'").get(run)).toEqual({state:"completed",attempts:2});
  expect(fetch).not.toHaveBeenCalled();
});

it("requires a new Quiz for an old reading plan without calls or checkpoint changes",async()=>{
  const id=material(body),run=randomUUID(),settings=largeQuizSettings(id);let readings=0;
  const generate=vi.fn(async(_c,name,_prompt,input)=>{
    if(name==="learning_quiz_reading"&&++readings===2)return {items:[{title:"[模拟] 缺少上下文"}],limitation:null};
    return quizPlanningResponse(name,input);
  });
  await generateLearningQuiz(repo,page,{id:run,settings},{configure:()=>config,generate});
  // Synthetic compatibility fixture only; real checkpoint hashes must never be rewritten.
  repo.database.prepare("UPDATE learning_generation_parts SET input_hash=? WHERE run_id=? AND part_id='reading-0'").run("synthetic-previous-reading-contract",run);
  const before=repo.database.prepare("SELECT * FROM learning_generation_parts WHERE run_id=? ORDER BY part_id").all(run);
  const rows=await generateLearningQuiz(repo,page,{id:run,settings,resume:true},{configure:()=>config,generate});
  expect(rows[0]).toMatchObject({status:"failed",failure:"quiz_reading_restart_required"});
  expect(generate).toHaveBeenCalledTimes(2);
  expect(repo.database.prepare("SELECT * FROM learning_generation_parts WHERE run_id=? ORDER BY part_id").all(run)).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps changed material distinct from reading-contract incompatibility on Quiz resume",async()=>{
  const id=material(body),run=randomUUID(),settings=largeQuizSettings(id);
  const generate=vi.fn(async()=>({items:[{title:"[模拟] 缺少上下文"}],limitation:null}));
  await generateLearningQuiz(repo,page,{id:run,settings},{configure:()=>config,generate});
  repo.database.prepare("UPDATE learning_generation_parts SET input_hash=? WHERE run_id=? AND part_id='reading-0'").run("synthetic-previous-reading-contract",run);
  const before=repo.database.prepare("SELECT * FROM learning_generation_parts WHERE run_id=? ORDER BY part_id").all(run);
  repo.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("[合成] 原始材料已经改变。"),id);
  await expect(generateLearningQuiz(repo,page,{id:run,settings,resume:true},{configure:()=>config,generate})).rejects.toThrow("source_changed");
  expect(generate).toHaveBeenCalledTimes(1);
  expect(repo.database.prepare("SELECT failure FROM learning_quiz_runs WHERE id=?").get(run)).toEqual({failure:"quiz_reading_invalid_result"});
  expect(repo.database.prepare("SELECT * FROM learning_generation_parts WHERE run_id=? ORDER BY part_id").all(run)).toEqual(before);
});

it("preserves source_changed when a material changes between the reading source check and plan transaction",async()=>{
  const id=material(body),run=randomUUID(),originalPlan=GenerationParts.prototype.plan;let changed=false;
  const generate=vi.fn(async(_c,name,_prompt,input)=>quizPlanningResponse(name,input));
  const plan=vi.spyOn(GenerationParts.prototype,"plan").mockImplementation(function(this:GenerationParts,parts){
    originalPlan.call(this,parts);
    if(parts.length===0&&!changed){
      changed=true;
      repo.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("[合成] 首次检查后原始材料发生变化。"),id);
    }
  });
  try {
    const rows=await generateLearningQuiz(repo,page,{id:run,settings:largeQuizSettings(id)},{configure:()=>config,generate});
    expect(changed).toBe(true);
    expect(rows[0]).toMatchObject({status:"failed",failure:"source_changed",count:0});
    expect(generate).not.toHaveBeenCalled();
    expect(repo.database.prepare("SELECT count(*) n FROM learning_generation_parts WHERE run_id=?").get(run)).toEqual({n:0});
    expect(fetch).not.toHaveBeenCalled();
  } finally { plan.mockRestore(); }
});

it("publishes and reopens five questions directly from large materials after reading every source batch",async()=>{
  const id=material(body),run=randomUUID(),settings={...largeQuizSettings(id),count:5};let readingGroups=0;
  const generate=vi.fn(async(_c,name,_prompt,input)=>{
    if(name==="learning_quiz_reading")readingGroups++;
    const response=quizPlanningResponse(name,input);
    if(name!=="learning_quiz")return response;
    expect(input.taskContext.count).toBe(5);
    return {...response,items:Array.from({length:input.taskContext.count},(_,i)=>({...response.items[0],
      focus:`[模拟] 第${i+1}项前提判断`,stem:`[模拟] 第${i+1}项规则在什么条件下适用？`}))};
  });
  const rows=await generateLearningQuiz(repo,page,{id:run,settings},{configure:()=>config,generate});
  expect(readingGroups).toBeGreaterThanOrEqual(3);
  expect(rows[0]).toMatchObject({status:"completed",count:5});
  expect(new LearningFrameworkRepository(repo).view(page).chapters).toEqual([]);
  const quiz=new LearningQuizRepository(repo),attempt=quiz.startAttempt(page,{id:randomUUID(),quizId:run,mode:"test"});
  expect(attempt.questions).toHaveLength(5);
  expect(new Set(attempt.questions.map(q=>q.stem)).size).toBe(5);
  expect(JSON.stringify(attempt)).not.toContain("correctOptionId");
  repo.close();repo=new LearningRepository(root,"owner");
  expect(new LearningQuizRepository(repo).list(page)[0]).toMatchObject({id:run,status:"completed",count:5});
  expect(new LearningQuizRepository(repo).attempt(page,attempt.id)).toEqual(attempt);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["reading","schema"], ["reading","json"], ["selection","schema"], ["selection","json"]
] as const)("reports a %s %s failure before starting later Quiz stages",async(stage,failure)=>{
  const id=material(body),run=randomUUID();
  const generate=vi.fn(async(_c,name,_prompt,input)=>{
    if(name===`learning_quiz_${stage}`){
      if(failure==="json")throw new StructuredJsonResponseError("incomplete_json","[模拟] incomplete JSON");
      return stage==="reading"?{items:[{title:"[模拟] 缺上下文"}],limitation:null}:{items:[{count:1}]};
    }
    return quizPlanningResponse(name,input);
  });
  const rows=await generateLearningQuiz(repo,page,{id:run,settings:largeQuizSettings(id)},{configure:()=>config,generate});
  expect(rows[0]).toMatchObject({status:"failed",failure:`quiz_${stage}_invalid_result`,count:0});
  expect(generate.mock.calls.some(call=>call[1]==="learning_quiz")).toBe(false);
  if(stage==="reading")expect(generate).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a fabricated selection window before providing any source bundle for questions",async()=>{
  const id=material(body),run=randomUUID();
  const generate=vi.fn(async(_c,name,_prompt,input)=>name==="learning_quiz_selection"?{items:[{windows:["w999999"],count:1}]}:quizPlanningResponse(name,input));
  const rows=await generateLearningQuiz(repo,page,{id:run,settings:largeQuizSettings(id)},{configure:()=>config,generate});
  expect(rows[0]).toMatchObject({status:"failed",failure:"generation_plan_invalid",count:0});
  expect(generate.mock.calls.some(call=>call[1]==="learning_quiz")).toBe(false);
});

it("still rejects fabricated final question references and preserves an earlier published Quiz",async()=>{
  const id=material(body),settings=largeQuizSettings(id),oldRun=randomUUID(),newRun=randomUUID();
  const generate=vi.fn(async(_c,name,_prompt,input)=>quizPlanningResponse(name,input));
  const oldRows=await generateLearningQuiz(repo,page,{id:oldRun,settings},{configure:()=>config,generate});
  expect(oldRows[0]).toMatchObject({status:"completed",count:1});
  const before=repo.database.prepare("SELECT status,result_json FROM learning_quiz_runs WHERE id=?").get(oldRun);
  const invalid=vi.fn(async(_c,name,_prompt,input)=>quizPlanningResponse(name,input,true));
  const rows=await generateLearningQuiz(repo,page,{id:newRun,settings},{configure:()=>config,generate:invalid});
  expect(rows.find(r=>r.id===newRun)).toMatchObject({status:"insufficient",count:0});
  expect(repo.database.prepare("SELECT status,result_json FROM learning_quiz_runs WHERE id=?").get(oldRun)).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
});
it("partitions a large cross-batch overview using both chapters' actual sources and preserves old chapters",async()=>{
  const f=new LearningFrameworkRepository(repo),study=new LearningStudyRepository(repo),expected=new Set<string>();
  for(let batch=0;batch<2;batch++){
    const text=body.split("\n\n").slice(batch*18,batch*18+18).join("\n\n"),id=material(text),run=randomUUID();
    f.begin(page,{id:run,materialIds:[id]},48000);f.validating(page,run);
    const paragraphs=repo.source(page,id).paragraphs;paragraphs.forEach(p=>expected.add(p.text));
    f.complete(page,run,{overview:"[模拟] 批次",chapters:[{title:`[模拟] 批次${batch}`,explanation:"[模拟] 条件与例外",nodes:[{title:"[模拟] 范围",explanation:"[模拟] 各段条件",supplement:null,sources:paragraphs.map(p=>({materialId:id,paragraph:p.number}))}]}]});
  }
  const before=f.view(page),seen=new Set<string>();
  const generate=vi.fn(async(_c,_name,_prompt,input)=>{
    expect(study.overview(page).published).toBeNull();expect(new Set(input.taskContext.chapters.map((c:any)=>c.batch)).size).toBe(2);
    input.materials.flatMap((m:any)=>m.paragraphs).forEach((p:any)=>seen.add(p.text));
    return {contractVersion:"chapter-references-v1",summary:"[模拟] 关系",items:[{kind:"complement",title:"[模拟] 互补条件",explanation:"[模拟] 两批实际条件并列",chapterRefs:input.taskContext.chapters.map((c:any)=>c.ref),sources:input.materials.map((m:any)=>m.paragraphs[0].referenceId)}]};
  });
  const run=randomUUID();await updateLearningOverview(repo,page,{id:run},{configure:()=>config,generate});
  expect(generate.mock.calls.length).toBeGreaterThan(1);expect(seen).toEqual(expected);expect(f.view(page)).toEqual(before);
  expect(study.overview(page).published?.id).toBe(run);expect(study.overview(page).published?.result.items.length).toBeGreaterThan(0);
  expect(study.readSource(page,"overview",run,0,0).paragraph.text).toBeTruthy();expect(fetch).not.toHaveBeenCalled();
});
it("checkpoint claims are exclusive; completed chunks survive a restart between calls and an expired owner cannot publish",async()=>{
  const id=material(body),run=randomUUID(),f=new LearningFrameworkRepository(repo);
  f.begin(page,{id:run,materialIds:[id]},48000);
  const parts=()=>new GenerationParts(repo,page,"framework",run,[id],()=>new LearningFrameworkRepository(repo).assertSources(page,run),120000);
  parts().plan([{id:"one",input:"unchanged"},{id:"two",input:"unchanged"}]);
  let finish!:(v:unknown)=>void;const operation=vi.fn(()=>new Promise(r=>{finish=r;}));
  const first=parts().execute("one",operation,v=>v);await expect(parts().execute("one",operation,v=>v)).rejects.toThrow("generation_result_unknown");expect(operation).toHaveBeenCalledTimes(1);
  finish({saved:"[模拟]"});await first;
  repo.database.prepare("UPDATE learning_framework_runs SET deadline=0 WHERE id=?").run(run);f.view(page);
  repo.close();repo=new LearningRepository(root,"owner");
  expect(generationProgress(repo,page,"framework",run)).toMatchObject({canResume:true,completed:1,total:2});
  new LearningFrameworkRepository(repo).begin(page,{id:run,materialIds:[id],resume:true},48000);
  expect(await parts().execute("one",operation,v=>v)).toEqual({saved:"[模拟]"});expect(operation).toHaveBeenCalledTimes(1);
  const late=parts().execute("two",operation,v=>v);repo.database.prepare("UPDATE learning_framework_runs SET status='failed' WHERE id=?").run(run);finish({late:true});
  await expect(late).rejects.toThrow("framework_interrupted");
  expect(repo.database.prepare("SELECT state FROM learning_generation_parts WHERE part_id='two'").get()).toEqual({state:"failed"});
});
it("explicit retry is bounded and a changed plan is not silently rebound to old checkpoints",async()=>{
  const id=material(body),run=randomUUID(),f=new LearningFrameworkRepository(repo);f.begin(page,{id:run,materialIds:[id]},48000);
  const parts=new GenerationParts(repo,page,"framework",run,[id],()=>f.assertSources(page,run),120000);
  parts.plan([{id:"one",input:"v1"}]);expect(()=>parts.plan([{id:"one",input:"v2"}])).toThrow("source_changed");
  const operation=vi.fn(async()=>{throw new LearningError(422,"framework_invalid_source");});
  for(let i=0;i<2;i++)await expect(parts.execute("one",operation,v=>v)).rejects.toThrow("framework_invalid_source");
  await expect(parts.execute("one",operation,v=>v)).rejects.toThrow("generation_part_failed");expect(operation).toHaveBeenCalledTimes(2);
  expect(generationProgress(repo,page,"framework",run)?.canResume).toBe(false);
});
it("can resume publication after a restart even when all model parts already finished",async()=>{
  const id=material("[合成] 只有前提成立才适用。"),run=randomUUID(),f=new LearningFrameworkRepository(repo);f.begin(page,{id:run,materialIds:[id]},48000);
  const parts=new GenerationParts(repo,page,"framework",run,[id],()=>f.assertSources(page,run),120000);
  parts.plan([{id:"one",input:"same"}]);await parts.execute("one",async()=>({done:true}),v=>v);
  repo.database.prepare("UPDATE learning_framework_runs SET deadline=0 WHERE id=?").run(run);f.view(page);
  expect(generationProgress(repo,page,"framework",run)).toMatchObject({completed:1,total:1,canResume:true});
  repo.database.prepare("UPDATE learning_framework_runs SET failure='framework_invalid_result' WHERE id=?").run(run);
  expect(generationProgress(repo,page,"framework",run)?.canResume).toBe(false);
});
