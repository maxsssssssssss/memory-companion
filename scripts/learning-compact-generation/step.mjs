import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {LearningRepository} from '../../src/lib/server/learning/repository.ts';
import {generateLearningQuiz} from '../../src/lib/server/learning/quiz-service.ts';
import {learningGenerationConfig,generateStudyJson} from '../../src/lib/server/learning/framework-generator.ts';
const root=process.env.LEARNING_CLOSURE_ROOT,label=process.argv[2],save=(f,v)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2));
const plan=JSON.parse(fs.readFileSync(root+'/plan.json')),session=JSON.parse(fs.readFileSync(root+'/session.json'));
const step=[...plan.runs,...(fs.existsSync(root+'/recheck-plan.json')?JSON.parse(fs.readFileSync(root+'/recheck-plan.json')).runs:[])].find(r=>r.label===label);assert(step);
const learning=new LearningRepository(path.join(root,'data/users',session.userId),session.userId),started=Date.now();
try{
 const configured=learningGenerationConfig();
 const runs=await generateLearningQuiz(learning,step.pageId,{id:step.id,settings:step.settings},{configure:()=>({...configured,model:step.model}),generate:generateStudyJson,referenceEncoding:step.encoding});
 save(label+'-api.json',{entry:'actual generateLearningQuiz application service (same route service), no SDK-only bypass',value:runs,durationMs:Date.now()-started});
 const row=learning.database.prepare('SELECT * FROM learning_quiz_runs WHERE id=?').get(step.id);save(label+'-stored.json',row);
 const n=fs.readdirSync(root).filter(f=>/^ds-response-\d+\.json$/.test(f)).length,response=JSON.parse(fs.readFileSync(root+'/ds-response-'+n+'.json'));
 assert.equal(response.step,label);save('blind/'+label+'.json',{label,publishedStatus:row.status,failure:row.failure,rawFinalText:response.text,published:row.result_json?JSON.parse(row.result_json):null});
 console.log(JSON.stringify({label,published:row.status,count:row.result_json?JSON.parse(row.result_json).questions.length:0,durationMs:Date.now()-started}));
}finally{learning.close();}
