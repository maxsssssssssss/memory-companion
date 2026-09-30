import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {ReferencedGeneratedQuiz} from '../../src/lib/domain/learning-quiz.ts';
import {resolveReferencedQuiz} from '../../src/lib/server/learning/quiz-grounding.ts';
const root=path.resolve('output/learning-synthetic-course-20260923'),read=f=>JSON.parse(fs.readFileSync(root+'/'+f,'utf8'));
const first=ReferencedGeneratedQuiz.safeParse(JSON.parse(read('ds-response-1.json').text));assert(!first.success);assert(first.error.issues.some(i=>i.code==='unrecognized_keys'));
const wire=ReferencedGeneratedQuiz.parse(JSON.parse(read('ds-response-11.json').text)),saved=JSON.parse(read('quiz-cross-batch-quiz.json').result_json),map=new Map();
for(const q of saved.questions)for(const e of q.evidence)map.set(e.referenceId,{referenceId:e.referenceId,source:e.source,text:e.quote});
const resolved=resolveReferencedQuiz(wire,[...map.values()]);assert.equal(saved.questions.length,4);assert.equal(resolved.items.length,3);assert(resolved.reason.includes('第 1 题'));assert(!resolved.items.some(q=>q.explanation.includes('选择D')));
const audio=read('asr-source.json').value.source,request=read('ds-request-3.json'),actualInput=JSON.parse(request.body.input.find(x=>x.role==='user').content),sent=actualInput.materials.find(m=>m.materialId===audio.material.id);
assert.deepEqual(sent.paragraphs.map(p=>p.text),audio.paragraphs.map(p=>p.text));assert(sent.paragraphs.some(p=>p.text.includes('16组')),'ASR raw error preserved, not replaced by authored transcript');
for(const n of [2,11]){const input=JSON.parse(read('ds-request-'+n+'.json').body.input.find(x=>x.role==='user').content);assert.equal(input.extras.length,0);}
const withNotes=JSON.parse(read('ds-request-7.json').body.input.find(x=>x.role==='user').content);assert(withNotes.extras.some(e=>e.kind==='note'));assert(!JSON.stringify(withNotes).includes('【用户编辑】'));
const result={status:'PASS',evidenceTier:'offline replay of this batch actual JSON, no new Provider call or saved-question mutation',initialResponseRejected:first.error.issues.map(i=>({code:i.code,path:i.path})),oldCrossBatchQuestions:saved.questions.length,newGuardWouldRetain:resolved.items.length,originalASRInputExact:true,defaultExtrasEmpty:true,explicitNotesIncluded:true,editedFrameworkNotMaterial:true};fs.writeFileSync(root+'/offline-real-output-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
