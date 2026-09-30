// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { LearningRepository,LearningError } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { generateLearningQuiz,quizDuplicatePreview } from "./quiz-service";
import { checkInputBudget } from "./framework-generator";

let root:string,repo:LearningRepository,page:string;
const config={baseURL:"https://synthetic.invalid",apiKey:"SYNTHETIC",model:"synthetic-model",maxInputChars:48000,maxOutputTokens:16000};
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"learning-quiz-fit-synthetic-"));repo=new LearningRepository(root,"owner");page=randomUUID();repo.create({id:page,title:"[合成隔离] 请求恢复"});vi.stubGlobal("fetch",vi.fn(()=>{throw Error("Network forbidden");}));});
afterEach(async()=>{repo.close();vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
function create(){const material=randomUUID();repo.saveMaterials(page,[{id:material,title:"[合成] 完整规则",kind:"text",filename:null,bytes:Buffer.from(Array.from({length:75},(_,i)=>`[合成] 第${i}条。${"适用条件与明确例外。".repeat(100)}`).join("\n\n"))}]);return {materialIds:[material],chapterIds:[],nodeIds:[],includeNotes:false,includeSupplements:false,count:5,difficulty:"standard" as const};}
function result(input:any,index:number){const ref=input.materials[0].paragraphs[0].referenceId;return {contractVersion:"references-v2",referenceScope:input.taskContext.referenceScope,title:"[模拟] 新题组",reason:null,materialPlan:[],items:Array.from({length:input.taskContext.count},(_,i)=>({scenario:null,stem:`[模拟] 条件判断${index+i}如何成立？`,kind:"concept",stemEvidenceIds:[ref],options:[{id:"A",text:"满足前提",reasonParts:[{text:"[模拟] 满足适用条件",evidenceIds:[ref]}]},{id:"B",text:"忽略前提",reasonParts:[{text:"[模拟] 不允许忽略前提",evidenceIds:[ref]}]}],correctOptionId:"A",hint:null}))};}
it.each([false,true])("keeps completed checkpoints when the request allowance increases, legacy=%s",async(legacy)=>{
  const settings=create(),run=randomUUID();let questions=0,index=0;
  const planning=legacy?vi.spyOn(LearningQuizRepository.prototype,"planning").mockReturnValue({inputChars:48000,perGroup:12,legacy:true,legacyLarge:true}):undefined;
  const generate=vi.fn(async(c,name,prompt,input:any)=>{
    checkInputBudget(c,prompt,input,"items");
    if(name==="learning_quiz_reading")return {items:[{title:"[模拟] 条件",context:"[模拟] 保留完整条件与例外"}],limitation:null};
    if(name==="learning_quiz_selection")return {items:[{windows:["w1"],count:2},{windows:["w2"],count:1},{windows:["w1","w2"],count:1},{windows:["w1","w3"],count:1}]};
    if(++questions===3)throw new LearningError(503,"generation_request_does_not_fit");
    const r=result(input,index);index+=input.taskContext.count;return r;
  });
  let rows=await generateLearningQuiz(repo,page,{id:run,settings},{configure:()=>config,generate});
  expect(rows[0]).toMatchObject({status:"failed",failure:"generation_request_does_not_fit"});
  planning?.mockRestore();
  // Reproduce the legacy local-only double count in an isolated fixture, never real data.
  repo.database.prepare("UPDATE learning_generation_parts SET attempts=2 WHERE run_id=? AND part_id='questions-2'").run(run);
  const saved=repo.database.prepare("SELECT part_id,input_hash,attempts,result_json FROM learning_generation_parts WHERE run_id=? AND state='completed' ORDER BY part_id").all(run);
  const before=generate.mock.calls.length;
  repo.close();repo=new LearningRepository(root,"owner");
  rows=await generateLearningQuiz(repo,page,{id:run,settings,resume:true},{configure:()=>({...config,maxInputChars:120000}),generate});
  expect(rows[0]).toMatchObject({status:"completed",count:5});
  expect(generate.mock.calls.slice(before).map(call=>call[1])).toEqual(["learning_quiz","learning_quiz"]);
  expect(repo.database.prepare("SELECT part_id,input_hash,attempts,result_json FROM learning_generation_parts WHERE run_id=? AND state='completed' AND part_id NOT IN ('questions-2','questions-3') ORDER BY part_id").all(run)).toEqual(saved);
  const recovered=repo.database.prepare("SELECT attempts,diagnostics_json FROM learning_generation_parts WHERE run_id=? AND part_id='questions-2'").get(run) as {attempts:number;diagnostics_json:string};
  expect(recovered.attempts).toBe(1);expect(JSON.parse(recovered.diagnostics_json).localPreflightRecovery).toEqual({attempts:2,failure:"generation_request_does_not_fit"});
  expect(fetch).not.toHaveBeenCalled();
});
it("bounds only duplicate-prevention previews after JSON escaping without changing saved stems",()=>{
  const stems=["普通正文".repeat(100),'\\"\n\t'.repeat(100),"😀".repeat(200)];
  for(const stem of stems){const original=stem,preview=quizDuplicatePreview(stem);expect(JSON.stringify(preview).length).toBeLessThanOrEqual(162);expect(stem.startsWith(preview)).toBe(true);expect(stem).toBe(original);expect(preview).not.toMatch(/[\uD800-\uDBFF]$/);}
});
it.each(["reading","selection"] as const)("uses the increased sending allowance without replanning saved %s work",async(stage)=>{
  const settings=create(),run=randomUUID();let fail=true,index=0;
  const generate=vi.fn(async(c,name,prompt,input:any)=>{
    checkInputBudget(c,prompt,input,"items");
    if(name===`learning_quiz_${stage}`&&fail){fail=false;throw new LearningError(503,"generation_request_does_not_fit");}
    if(name==="learning_quiz_reading")return {items:[{title:"[模拟] 条件",context:"[模拟] 保留例外"}],limitation:null};
    if(name==="learning_quiz_selection")return {items:[{windows:["w1"],count:5}]};
    const r=result(input,index);index+=input.taskContext.count;return r;
  });
  await generateLearningQuiz(repo,page,{id:run,settings},{configure:()=>config,generate});
  repo.database.prepare("UPDATE learning_generation_parts SET attempts=2 WHERE run_id=? AND state='failed'").run(run);
  const saved=repo.database.prepare("SELECT part_id,input_hash,result_json FROM learning_generation_parts WHERE run_id=? AND state='completed' ORDER BY part_id").all(run);
  const before=generate.mock.calls.length;
  const rows=await generateLearningQuiz(repo,page,{id:run,settings,resume:true},{configure:()=>({...config,maxInputChars:120000}),generate});
  expect(rows[0]).toMatchObject({status:"completed",count:5});
  expect(generate.mock.calls.slice(before).every(call=>call[0].maxInputChars===120000)).toBe(true);
  for(const part of saved as {part_id:string;input_hash:string;result_json:string}[])expect(repo.database.prepare("SELECT part_id,input_hash,result_json FROM learning_generation_parts WHERE run_id=? AND part_id=?").get(run,part.part_id)).toEqual(part);
  expect(fetch).not.toHaveBeenCalled();
});
