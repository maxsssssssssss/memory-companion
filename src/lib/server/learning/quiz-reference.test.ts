import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { ReferencedGeneratedQuiz, type ReferencedModelQuiz, type SavedQuiz } from "@/lib/domain/learning-quiz";
import { arrangeQuizOptions, hasQuizPositionDependency } from "./quiz-grounding";

let root: string, learning: LearningRepository, repo: LearningQuizRepository, page: string, material: string;
const settings = () => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 2, difficulty: "standard" });
function begin() { const id = randomUUID(); return { id, input: repo.begin(page, { id, settings: settings() }, 48000)! }; }
function response(input: ReturnType<typeof begin>["input"]): ReferencedModelQuiz {
  const p = input.materials[0].paragraphs;
  return { contractVersion: "references-v2", title: "[合成] 依据ID", reason: "本范围两题", items: [0, 1].map(i => ({
    stem: `[合成] ${i + 1}：应如何区分适用前提与实际结果？`, kind: "relationship", stemEvidenceIds: [p[0].referenceId, p[1].referenceId], explanationEvidenceIds: [p[1].referenceId, p[0].referenceId],
    options: [{ id: "A", text: "前提不成立时不适用", reason: "不能将未校准说成已校准", evidenceIds: [p[0].referenceId, p[1].referenceId] }, { id: "B", text: "已经适用且判定失败", reason: "材料未给出适用后的结果", evidenceIds: [p[1].referenceId, p[0].referenceId] }],
    correctOptionId: "A", explanation: "前提是必要条件，不保证通过", hint: "先检查前提与结果"
  })) };
}
const saved = (id: string) => JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as {result_json:string}).result_json) as SavedQuiz;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "learning-reference-synthetic-")); learning = new LearningRepository(root, "owner"); repo = new LearningQuizRepository(learning); page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成]" }); learning.saveMaterials(page, [{ id: material, title: "[合成]", kind: "text", filename: null, bytes: Buffer.from("[合成] 标题：适用前提。\n\n[合成] 设备尚未校准，所以不能应用规则；这不同于已应用规则后失败。") }]); });
afterEach(async () => { if (learning.database.open) learning.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("uses a bounded explicit deadline without disabling expiry or deletion fencing", () => {
  const now = Date.now(), id = randomUUID();
  const input = repo.begin(page, { id, settings: settings() }, 48000, 630000)!;
  vi.spyOn(Date, 'now').mockReturnValue(now + 160000);
  expect(repo.list(page).find(r => r.id === id)?.status).toBe('generating');
  repo.complete(page, id, response(input));
  expect(repo.list(page).find(r => r.id === id)?.status).toBe('completed');
  const expired = randomUUID(), next = repo.begin(page, { id: expired, settings: settings() }, 48000, 630000)!;
  vi.mocked(Date.now).mockReturnValue(now + 800001);
  expect(repo.list(page).find(r => r.id === expired)?.failure).toBe('framework_interrupted');
  expect(() => repo.complete(page, expired, response(next))).toThrow();
  const deleted = randomUUID(), last = repo.begin(page, { id: deleted, settings: settings() }, 48000, 630000)!;
  learning.deletePage(page);
  expect(() => repo.complete(page, deleted, response(last))).toThrow();
});

it("derives the complete source union and stable per-option evidence without positional indexes", () => {
  const {id,input}=begin(), value=response(input); repo.complete(page,id,ReferencedGeneratedQuiz.parse(value));
  const q=saved(id).questions[0]; expect(q.sources.map(s=>s.kind==='material'&&s.paragraph)).toEqual([1,2]);
  expect(q.options.find(o=>o.id==='A')?.evidenceIds).toEqual(input.materials[0].paragraphs.map(p=>p.referenceId)); expect(q.evidence?.map(e=>e.id)).toEqual(input.materials[0].paragraphs.map(p=>p.referenceId));
  expect(q.stemEvidenceIds).toEqual(input.materials[0].paragraphs.map(p=>p.referenceId)); expect(q.evidence?.map(e=>e.quote)).toEqual(input.materials[0].paragraphs.map(p=>p.text)); expect(q.hint).not.toContain('答案A');
  expect(q.options.every(o=>o.evidenceIndexes===undefined)).toBe(true);
});
it("keeps valid items, explicitly rejects unknown heading/option IDs and position-dependent explanations without filling them", () => {
  for(const mutate of [(q:ReferencedModelQuiz['items'][number])=>{q.stemEvidenceIds=['ref_'+'f'.repeat(64)];},(q:ReferencedModelQuiz['items'][number])=>{q.options[0].evidenceIds=['ref_'+'f'.repeat(64)];},(q:ReferencedModelQuiz['items'][number])=>{q.options[1].text='A和B均正确';},(q:ReferencedModelQuiz['items'][number])=>{q.explanation='因此B准确';}]) {
    const {id,input}=begin(), value=response(input); mutate(value.items[0]); repo.complete(page,id,value);
    expect(saved(id).questions).toHaveLength(1); expect(saved(id).reason).toContain('第 1 题'); expect(repo.list(page)[0].count).toBe(1);
  }
});
it("cannot infer semantic sufficiency from valid IDs; condition and case mappings remain inspectable", () => {
  const {id,input}=begin(), value=response(input); value.items[0].options[1].evidenceIds=[input.materials[0].paragraphs[0].referenceId];
  repo.complete(page,id,value); expect(saved(id).questions[0].options.find(o=>o.id==='B')?.evidenceIds).toEqual([input.materials[0].paragraphs[0].referenceId]);
  // Deliberately insufficient case evidence remains a semantic-review issue, never auto-verified.
  expect(JSON.stringify(saved(id))).not.toContain('verified');
});
it("rejects an entire malformed question without discarding its valid independent neighbour or inventing references",()=>{
 for(const mutate of [(q:ReferencedModelQuiz['items'][number])=>{q.options[0].evidenceIds=['ref_placeholder'];},(q:ReferencedModelQuiz['items'][number])=>{Object.assign(q.options[0],{evidenceOverride:'guessed'});}]){
  const {id,input}=begin(),v=response(input);mutate(v.items[0]);repo.complete(page,id,v);
  expect(saved(id).questions).toHaveLength(1);expect(saved(id).reason).toContain('第 1 题题目结构或依据ID格式不合法');
  expect(saved(id).questions[0].stem).toBe(v.items[1].stem);
 }
});
it("rejects choose-letter prose before shuffling new questions; retains unaffected items",()=>{
 for(const text of ['因此应选择D；其余不成立。','所以选 A。','Choose B.','Select C.']){
  const {id,input}=begin(),value=response(input);value.items[0].explanation=text;repo.complete(page,id,value);
  expect(saved(id).questions).toHaveLength(1);expect(saved(id).reason).toContain('依赖排列位置');
 }
});
it("rejects correct-item letter references observed in a real response without rewriting saved history",()=>{
 for(const text of ['正确项B符合这一限定。','正确项 B 符合这一限定。','错误项C遗漏条件。']){
  const {id,input}=begin(),value=response(input);value.items[0].explanation=text;
  repo.complete(page,id,value);
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).reason).toContain('依赖排列位置');
  expect(saved(id).questions[0].stem).toBe(value.items[1].stem);
 }
 for(const text of ['正确项属于方案B的说明','正确项描述的是A组','正确项Balance是材料定义的名称'])expect(hasQuizPositionDependency(text)).toBe(false);
});
it("checks scenario, stem, all options/reasons, explanation and hint without confusing material names",()=>{
 const setters: Array<(q:ReferencedModelQuiz['items'][number])=>void> = [q=>{q.scenario='应选择 D';},q=>{q.stem='答案是选项A吗？';},q=>{q.options[0].text='A和B都成立';},q=>{q.options[1].reason='应选 A';},q=>{q.hint='答案 A';}];
 for(const set of setters){const {id,input}=begin(),v=response(input);set(v.items[0]);repo.complete(page,id,v);expect(saved(id).questions).toHaveLength(1);}
 for(const text of ['方案A和B满足不同条件','选择A组先讨论，B组旁听','方案A正确，方案B缺条件','Plan A and B are named plans','A组与B组'])expect(hasQuizPositionDependency(text)).toBe(false);
 const {id,input}=begin(),v=response(input);v.items[0].scenario='假设一个新案例：A组尚未完成本站，下一站两个位置均已预约。';v.items[0].stem='这两个障碍能否同时存在？';repo.complete(page,id,v);
 expect(saved(id).questions[0].stem).toBe(v.items[0].scenario+'\n\n'+v.items[0].stem);expect(saved(id).questions[0].stemEvidenceIds).toEqual(v.items[0].stemEvidenceIds);
});
it("shuffles once as complete option objects and persists identical order, grading and evidence through reopening", () => {
  expect(arrangeQuizOptions([{id:'A',reason:'a'},{id:'B',reason:'b'},{id:'C',reason:'c'}],()=>0)).toEqual([{id:'B',reason:'b'},{id:'C',reason:'c'},{id:'A',reason:'a'}]);
  const {id,input}=begin(); repo.complete(page,id,response(input)); const original=saved(id);
  let a=repo.startAttempt(page,{id:randomUUID(),quizId:id,mode:'test'});
  a=repo.act(page,{id:randomUUID(),attemptId:a.id,revision:a.revision,action:'choose',question:0,optionId:'A'});
  learning.close();learning=new LearningRepository(root,'owner');repo=new LearningQuizRepository(learning);
  expect(saved(id)).toEqual(original);expect(repo.attempt(page,a.id)).toEqual(a);
  a=repo.act(page,{id:randomUUID(),attemptId:a.id,revision:a.revision,action:'finish',question:0,optionId:null});expect(a.score?.correct).toBe(1);
  expect(a.questions[0].feedback?.reasons.find(o=>o.id==='A')?.reason).toBe(original.questions[0].options.find(o=>o.id==='A')?.reason);
  expect(()=>repo.complete(page,id,response(input))).toThrow('framework_terminal');expect(saved(id)).toEqual(original);
});
it("binds reference IDs to selected content and source version; deletion fences late completion",()=>{
  const {id,input}=begin(); repo.fail(page,id,'synthetic'); const next=begin();expect(next.input).toEqual(input);
  learning.deleteMaterial(page,material);expect(()=>repo.complete(page,next.id,response(next.input))).toThrow('framework_terminal');
});
it("does not parse malformed whole responses or silently accept old provider output",()=>{
  const {input}=begin();expect(()=>ReferencedGeneratedQuiz.parse({...response(input),contractVersion:undefined})).toThrow();
  const value=response(input);(value.items[0] as unknown as {sources:string[]}).sources=['guessed'];expect(()=>ReferencedGeneratedQuiz.parse(value)).toThrow();
});
it("rejects provider-added option control fields without silently discarding evidence",()=>{
  const {input}=begin(), value=response(input);
  Object.assign(value.items[0].options[1], { reasonNoOverride: true, evidenceIdsNoOverride: value.items[0].options[1].evidenceIds });
  const parsed=ReferencedGeneratedQuiz.safeParse(value);
  expect(parsed.success).toBe(false);
  if(!parsed.success) expect(parsed.error.issues.some(i=>i.code==='unrecognized_keys'&&i.path.join('.')==='items.0.options.1')).toBe(true);
});
