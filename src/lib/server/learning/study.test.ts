// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import { AskLearningNode } from "@/lib/domain/learning-study";
import { LearningRepository } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningStudyRepository } from "./study-repository";
import { answerLearningNode, updateLearningOverview } from "./study-service";
let root: string, learning: LearningRepository, framework: LearningFrameworkRepository, study: LearningStudyRepository, page: string;
const config = { baseURL: "https://synthetic.invalid", apiKey: "SYNTHETIC", model: "mock", maxInputChars: 10000, maxOutputTokens: 4000 };
let ids: string[];
function batch(index: number) {
  const id = randomUUID(), materialId = randomUUID(); ids.push(materialId);
  learning.saveMaterials(page, [{ id: materialId, title: `[合成测试] ${index}`, kind: "text", filename: null,
    bytes: Buffer.from(`[合成测试] 仅满足前提才能应用规则${index}。\n\n[合成测试] 反例：未满足前提，不能把它概括为适用案例。`) }]);
  framework.begin(page, { id, materialIds: [materialId] }, 10000); framework.validating(page,id);
  framework.complete(page,id,{ overview: "[模拟] 正例和前提不满足的反例并列。", chapters: [{ title: `章${index}`, explanation: "满足前提与不满足前提分别说明。", nodes: [{ title: `点${index}`, explanation: "[模拟] 仅满足前提可用。", supplement: null, sources: [{ materialId, paragraph: 1 },{materialId,paragraph:2}] }] }] });
}
function ask(extra: Partial<z.infer<typeof AskLearningNode>> = {}) {
  const c = framework.view(page).chapters[0]; return { id: randomUUID(), conversationId: randomUUID(), chapterId: c.id, nodeId: c.nodes[0].id, action: "ask" as const, question: "[合成] 为什么反例不适用？", ...extra };
}
function answer() { return { materialAnswer: "[模拟] 反例不满足前提，不能套规则。", supplements: [{ kind: "example" as const, text: "[模拟教学例子] 假设条件为门票有效，过期是反例。" }], items: [{ materialId: ids[0], paragraph: 1 },{materialId:ids[0],paragraph:2}] }; }
function overview() { return { summary: "[模拟] 联系保留条件与反例。", items: [{kind:"complement" as const,title:"条件的互补说明",explanation:"[模拟] 两批前提和反例并列。",chapterIds:framework.view(page).chapters.map(c=>c.id),sources:ids.map(materialId=>({materialId,paragraph:2}))}] }; }
function wireOverview(input:any){return {contractVersion:"chapter-references-v1",summary:overview().summary,items:[{kind:"complement",title:"条件的互补说明",explanation:"[模拟] 两批前提和反例并列。",chapterRefs:input.taskContext.chapters.map((c:any)=>c.ref),sources:input.materials.flatMap((m:any)=>m.paragraphs.slice(-1).map((p:any)=>p.referenceId))}]};}
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"learning-study-synthetic-"));learning=new LearningRepository(root,"owner");framework=new LearningFrameworkRepository(learning);study=new LearningStudyRepository(learning);page=randomUUID();ids=[];learning.create({id:page,title:"[合成测试]"});batch(1);vi.stubGlobal("fetch",vi.fn(()=>{throw Error("Network forbidden");}));});
afterEach(async()=>{if(learning.database.open)learning.close();vi.unstubAllGlobals();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});

it("keeps schema5 materials/framework/notes and adds only learning-owned tables",()=>{
  const before=framework.view(page),source=learning.source(page,ids[0]);
  learning.database.exec("DROP TABLE learning_answer_notes; DROP TABLE learning_node_turns; DROP TABLE learning_node_conversations; DROP TABLE learning_overview_runs; PRAGMA user_version=5");learning.close();
  learning=new LearningRepository(root,"owner");framework=new LearningFrameworkRepository(learning);
  expect(learning.database.pragma("user_version",{simple:true})).toBe(11);expect(framework.view(page)).toEqual(before);expect(learning.source(page,ids[0])).toEqual(source);expect(learning.database.pragma("foreign_key_check")).toEqual([]);
});
it("uses actual material paragraphs for cross-batch relations, commits together and preserves all old edits",async()=>{
  batch(2);const c=framework.view(page).chapters[0];framework.edit(page,{kind:"node",chapterId:c.id,nodeId:c.nodes[0].id,revision:0,title:"用户标题",explanation:"用户解释",note:"不应成为模型上下文的笔记"});const before=framework.view(page);
  const generate=vi.fn(async(_config,_name,_prompt,input)=>{expect(JSON.stringify(input)).toContain("反例：未满足前提");expect(JSON.stringify(input)).not.toContain("不应成为模型上下文的笔记");expect(study.overview(page).published).toBeNull();return wireOverview(input);});
  const id=randomUUID();await updateLearningOverview(learning,page,{id},{configure:()=>config,generate});
  expect(generate).toHaveBeenCalledTimes(1);expect(framework.view(page)).toEqual(before);const saved=study.overview(page);expect(saved.published?.result.items).toHaveLength(1);expect(saved.published?.stale).toBe(false);
  expect(study.readSource(page,"overview",id,0,0).paragraph.number).toBe(2);
  await updateLearningOverview(learning,page,{id},{configure:()=>config,generate});expect(generate).toHaveBeenCalledTimes(1);
  learning.close();learning=new LearningRepository(root,"owner");expect(new LearningStudyRepository(learning).overview(page)).toEqual(saved);
});
it("does not call for one batch; supports an honest empty relation set without forcing links",async()=>{
  const generate=vi.fn().mockResolvedValue({contractVersion:"chapter-references-v1",summary:"[模拟] 未发现足够联系。",items:[]});
  await updateLearningOverview(learning,page,{id:randomUUID()},{configure:()=>config,generate});expect(generate).not.toHaveBeenCalled();batch(2);
  await updateLearningOverview(learning,page,{id:randomUUID()},{configure:()=>config,generate});expect(study.overview(page).published?.result.items).toEqual([]);
});
it("holds one write transaction from the coordinator fence through overview publication",async()=>{
  batch(2);const other=new LearningRepository(root,"owner");other.database.pragma("busy_timeout=1");
  const guard=vi.fn(()=>{
    expect(learning.database.inTransaction).toBe(true);
    expect(()=>other.database.prepare("UPDATE learning_pages SET title='SYNTHETIC concurrent' WHERE id=?").run(page)).toThrow(/locked/);
  });
  try {const id=randomUUID();await updateLearningOverview(learning,page,{id},{configure:()=>config,generate:vi.fn(async(_c,_n,_p,input)=>wireOverview(input))},guard);
    expect(guard).toHaveBeenCalledTimes(4);expect(study.overview(page).published?.id).toBe(id);
  }finally{other.close();}
});
it("sends exact compact source addresses while retaining full material text and persisted version fences",()=>{
 batch(2);const id=randomUUID(),input=study.beginOverview(page,id,10000)!;
 for(const c of input.chapters)for(const n of c.nodes)for(const source of n.sources)expect(Object.keys(source).sort()).toEqual(['materialId','paragraph']);
 expect(input.materials.map(m=>m.paragraphs.map(p=>p.text))).toEqual([...ids].sort().map(id=>learning.source(page,id).paragraphs.map(p=>p.text)));
 const row=learning.database.prepare('SELECT binding_json FROM learning_overview_runs WHERE id=?').get(id) as {binding_json:string};
 expect(JSON.parse(row.binding_json).sources[0]).toHaveProperty('originalSha256');expect(JSON.parse(row.binding_json).sources[0]).toHaveProperty('paragraphSha256');
});
it("keeps last overview on failure, records limits and never silently replays failed IDs",async()=>{
  batch(2);const good=randomUUID();study.beginOverview(page,good,10000);study.completeOverview(page,good,overview());
  const generate=vi.fn().mockRejectedValue(Error("PRIVATE provider error")),id=randomUUID();
  await updateLearningOverview(learning,page,{id},{configure:()=>config,generate});await updateLearningOverview(learning,page,{id},{configure:()=>config,generate});
  expect(generate).toHaveBeenCalledTimes(1);expect(study.overview(page)).toMatchObject({latest:{status:"failed",failure:"framework_provider_failed"},published:{id:good}});
  const tooLarge=randomUUID();expect(study.beginOverview(page,tooLarge,1)?.materials).toHaveLength(2);expect(study.overview(page).latest?.status).toBe("generating");
  expect(JSON.stringify(study.overview(page))).not.toContain("PRIVATE");
});
it("records all-invalid relations as failure, distinct from no relations, without guessing IDs/sources",()=>{
  batch(2);for(const kind of ['chapter','source']){const id=randomUUID();study.beginOverview(page,id,10000);const value=overview();if(kind==='chapter')value.items[0].chapterIds[1]=randomUUID();else value.items[0].sources[0].materialId=randomUUID();study.completeOverview(page,id,value);
   expect(study.overview(page)).toMatchObject({latest:{status:'failed',failure:'overview_no_valid_relations',validation:{accepted:0,submitted:1}},published:null});}
});
it("resolves finite aliases and publishes only independent valid cross-batch relations with rejection reasons",()=>{
 batch(2);const id=randomUUID(),input=study.beginOverview(page,id,10000)!;expect(input.chapters.map(c=>[c.ref,c.batch])).toEqual([['c1','b1'],['c2','b2']]);expect(JSON.stringify(input.chapters)).not.toContain(framework.view(page).chapters[0].id);
 const legacy=overview().items[0],{chapterIds,...base}=legacy;void chapterIds;
 study.completeOverview(page,id,{contractVersion:'chapter-references-v1',summary:'[合成] 包含坏关系的概括不能直接展示',items:[{...base,chapterRefs:['c1','c2']},{...base,chapterRefs:['c1','invented']},{...base,chapterRefs:['c1','c1']},{...base,chapterRefs:['c1','c2'],sources:[{materialId:ids[0],paragraph:999}]}]});
 const result=study.overview(page).published!.result;expect(result.items).toHaveLength(1);expect(result.items[0].chapterIds).toEqual(framework.view(page).chapters.map(c=>c.id));expect(result.validation).toMatchObject({accepted:1,submitted:4,rejected:[{index:1,reason:'unknown_chapter'},{index:2,reason:'duplicate_chapter'},{index:3,reason:'source_outside_scope'}]});expect(result.summary).toContain('范围不完整');expect(result.summary).not.toContain('包含坏关系');expect(result.generatedSummary).toContain('包含坏关系');
 const bad=randomUUID();study.beginOverview(page,bad,10000);study.completeOverview(page,bad,{contractVersion:'chapter-references-v1',summary:'bad',items:[{...base,chapterRefs:['c1','c1']}]});expect(study.overview(page).published!.id).toBe(id);
});
it("keeps longer overview work fenced to its configured deadline and current sources", () => {
  batch(2); const now=Date.now(), id=randomUUID();
  study.beginOverview(page,id,10000,630000);
  vi.spyOn(Date,'now').mockReturnValue(now+160000);
  expect(study.overview(page).latest?.status).toBe('generating');
  study.completeOverview(page,id,overview());
  expect(study.overview(page).published?.id).toBe(id);
  const late=randomUUID();study.beginOverview(page,late,10000,630000);
  vi.mocked(Date.now).mockReturnValue(now+800001);
  expect(study.overview(page).latest?.status).toBe('failed');
  expect(()=>study.completeOverview(page,late,overview())).toThrow();
  expect(study.overview(page).published?.id).toBe(id);
});
it("fences chapter edits and late overview results without overwriting previous work",()=>{
  batch(2);const id=randomUUID();study.beginOverview(page,id,10000);const c=framework.view(page).chapters[0];framework.edit(page,{kind:"chapter",chapterId:c.id,revision:c.revision,title:"用户改动",explanation:"用户限定条件"});
  expect(()=>study.completeOverview(page,id,overview())).toThrow("study_content_changed");expect(framework.view(page).chapters[0].title).toBe("用户改动");
});
it("rejects distinct chapters from one batch and malformed members without losing a separate valid relation",()=>{
 const materialId=randomUUID(),runId=randomUUID();ids.push(materialId);
 learning.saveMaterials(page,[{id:materialId,title:'[合成] 第二批',kind:'text',filename:null,bytes:Buffer.from('[合成] 第二批条件与反例。')}]);
 framework.begin(page,{id:runId,materialIds:[materialId]},10000);framework.validating(page,runId);
 framework.complete(page,runId,{overview:'[模拟] 第二批',chapters:[1,2].map(i=>({title:`第二批章${i}`,explanation:'[模拟] 有条件',nodes:[{title:'点',explanation:'[模拟]',supplement:null,sources:[{materialId,paragraph:1}]}]}))});
 const id=randomUUID();study.beginOverview(page,id,10000);
 const base={kind:'connection',title:'联系',explanation:'[模拟] 条件相连',sources:[{materialId:ids[0],paragraph:1},{materialId,paragraph:1}]};
 study.completeOverview(page,id,{contractVersion:'chapter-references-v1',summary:'[模拟]',items:[{...base,chapterRefs:['c1','c2']},{...base,chapterRefs:['c2','c3']},{...base,chapterRefs:['c1','c2'],sources:[{materialId,paragraph:1}]},{title:'malformed'}]});
 expect(study.overview(page).published?.result.validation).toEqual({submitted:4,accepted:1,rejected:[{index:1,reason:'same_batch'},{index:2,reason:'chapter_evidence_missing'},{index:3,reason:'invalid_structure'}]});
});
it("persists two QA turns, includes last answer, keeps supplements and saves a chosen piece as a CAS-protected note once",async()=>{
  const a=ask(), generate=vi.fn().mockResolvedValue(answer());await answerLearningNode(learning,page,a,{configure:()=>config,generate});
  const b=ask({conversationId:a.conversationId,question:"请继续解释这个反例。"});await answerLearningNode(learning,page,b,{configure:()=>config,generate});
  const input=generate.mock.calls[1][3];expect(input.taskContext.history).toHaveLength(1);expect(input.taskContext.history[0].id).toBe(a.id);
  await answerLearningNode(learning,page,b,{configure:()=>config,generate});expect(generate).toHaveBeenCalledTimes(2);
  const c=framework.view(page).chapters[0],before=c.nodes[0];const note={turnId:b.id,chapterId:c.id,nodeId:before.id,revision:c.revision,section:0};
  study.saveNote(page,note);study.saveNote(page,note);const after=framework.view(page).chapters[0];expect(after.nodes[0].explanation).toBe(before.explanation);expect(after.nodes[0].note.match(/模拟教学例子/g)).toHaveLength(1);expect(after.nodes[0].edited).toBe(false);
  expect(()=>study.saveNote(page,{...note,turnId:a.id})).toThrow("framework_edit_conflict");
  const conversations=study.conversations(page,a.chapterId,a.nodeId);expect(conversations[0].turns).toHaveLength(2);expect(conversations[0].turns[1].savedSections).toEqual([0]);
  learning.close();learning=new LearningRepository(root,"owner");expect(new LearningStudyRepository(learning).conversations(page,a.chapterId,a.nodeId)).toEqual(conversations);
});
it("bounds recent complete-turn context separately from full durable history",()=>{
  const a=ask();study.beginAnswer(page,a,10000);study.completeAnswer(page,a.id,{...answer(),supplements:[{kind:"explanation",text:"[模拟]"+"x".repeat(3500)}]});
  const b=ask({conversationId:a.conversationId});const input=study.beginAnswer(page,b,1500)!;expect(input.history).toEqual([]);expect(input.omittedTurns).toBe(1);
  expect(study.conversations(page,a.chapterId,a.nodeId)[0].turns).toHaveLength(2);expect(study.conversations(page,a.chapterId,a.nodeId)[0].turns[0].answer?.supplements[0].text.length).toBeGreaterThan(3500);
});
it("preserves failed questions and blocks concurrent submissions and different bodies for the same ID",async()=>{
  const a=ask();study.beginAnswer(page,a,10000);expect(()=>study.beginAnswer(page,ask({conversationId:a.conversationId}),10000)).toThrow("node_qa_busy");
  expect(()=>study.beginAnswer(page,{...a,question:"different"},10000)).toThrow("submission_conflict");
  study.fail(page,"answer",a.id,"framework_provider_failed");expect(study.beginAnswer(page,a,10000)).toBeNull();expect(study.conversations(page,a.chapterId,a.nodeId)[0].turns[0].question).toBe(a.question);
});
it("rejects source/body changes and does not silently migrate conversations after editing or moving nodes",()=>{
  batch(2);const a=ask();study.beginAnswer(page,a,10000);study.completeAnswer(page,a.id,answer());
  const c=framework.view(page).chapters[0];framework.edit(page,{kind:"node",chapterId:c.id,nodeId:c.nodes[0].id,revision:c.revision,title:"改标题",explanation:"新解释",note:""});
  expect(study.conversations(page,a.chapterId,a.nodeId)[0].state).toBe("study_content_changed");expect(()=>study.beginAnswer(page,ask({conversationId:a.conversationId}),10000)).toThrow("study_content_changed");
  const fresh=ask();study.beginAnswer(page,fresh,10000);const view=framework.view(page);framework.edit(page,{kind:"move",chapterId:c.id,nodeId:c.nodes[0].id,revision:view.chapters[0].revision,targetChapterId:view.chapters[1].id,targetRevision:view.chapters[1].revision,position:1});
  expect(()=>study.completeAnswer(page,fresh.id,answer())).toThrow("study_content_changed");expect(study.conversations(page,view.chapters[1].id,a.nodeId).every(c=>c.state!=="current")).toBe(true);
});
it.each(["material","page"])("deleting %s retains or clears historical results as specified and fences late writes",kind=>{
  batch(2);const oid=randomUUID();study.beginOverview(page,oid,10000);study.completeOverview(page,oid,overview());
  const a=ask();study.beginAnswer(page,a,10000);study.completeAnswer(page,a.id,answer());const b=ask({conversationId:a.conversationId});study.beginAnswer(page,b,10000);const next=randomUUID();study.beginOverview(page,next,10000);
  const second=new LearningRepository(root,"owner");try{if(kind==="material")second.deleteMaterial(page,ids[0]);else second.deletePage(page);}finally{second.close();}
  expect(()=>study.completeAnswer(page,b.id,answer())).toThrow();expect(()=>study.completeOverview(page,next,overview())).toThrow();
  if(kind==="material"){expect(study.overview(page).published?.id).toBe(oid);expect(study.conversations(page,a.chapterId,a.nodeId)[0]).toMatchObject({state:"material_deleted"});expect(()=>study.readSource(page,"answer",a.id,0,0)).toThrow("material_deleted");expect(()=>study.beginAnswer(page,ask(),10000)).toThrow("material_deleted");}
  else {expect(()=>study.overview(page)).toThrow("page_deleted");for(const table of ["learning_overview_runs","learning_node_turns","learning_node_conversations","learning_answer_notes"])expect(learning.database.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});}
});
it("enforces account ownership even in a shared database and fails closed on expired unknown results",()=>{
  const a=ask();study.beginAnswer(page,a,10000);learning.database.exec("UPDATE learning_node_turns SET deadline=0");expect(()=>study.completeAnswer(page,a.id,answer())).toThrow("framework_terminal");expect(study.beginAnswer(page,a,10000)).toBeNull();
  const other=new LearningRepository(root,"stranger"),foreign=new LearningStudyRepository(other);try{for(const fn of [()=>foreign.overview(page),()=>foreign.conversations(page,a.chapterId,a.nodeId),()=>foreign.beginAnswer(page,ask(),10000),()=>foreign.saveNote(page,{turnId:a.id,chapterId:a.chapterId,nodeId:a.nodeId,revision:0,section:-1})])expect(fn).toThrow("page_not_found");}finally{other.close();}
});
it("failure to publish rolls back the whole relation set; source hashes invalidate changed material content",()=>{
  batch(2);const id=randomUUID();study.beginOverview(page,id,10000);learning.database.exec("CREATE TRIGGER synthetic_fail BEFORE UPDATE OF result_json ON learning_overview_runs BEGIN SELECT RAISE(ABORT,'synthetic'); END");expect(()=>study.completeOverview(page,id,overview())).toThrow();expect(study.overview(page).published).toBeNull();learning.database.exec("DROP TRIGGER synthetic_fail");
  learning.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("changed"),ids[0]);expect(()=>study.completeOverview(page,id,overview())).toThrow("source_changed");
});
