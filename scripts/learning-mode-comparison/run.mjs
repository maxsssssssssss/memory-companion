// Real application APIs; no mock or direct injection into saved model outputs.
import fs from 'node:fs';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {root,base,save,vault} from './runtime.mjs';
import {nativeFetch} from './native-fetch.cjs';
const label=process.argv[2],plan=JSON.parse(fs.readFileSync(root+'/plan.json')),extra=fs.existsSync(root+'/refinement-plan.json')?JSON.parse(fs.readFileSync(root+'/refinement-plan.json')).runs:[],transportRuns=fs.existsSync(root+'/transport-recheck-plan.json')?JSON.parse(fs.readFileSync(root+'/transport-recheck-plan.json')).runs:[],step=[...plan.runs,...extra,...transportRuns].find(r=>r.label===label),map=JSON.parse(fs.readFileSync(root+'/review-only/mode-map.json')),session=JSON.parse(fs.readFileSync(root+'/session.json')),secure=vault('read');
assert(step,'Frozen step required');assert(!fs.existsSync(root+'/'+label+'-api.json'),'Do not retry a finished step');
const initial=fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).length;let exitCode=0;
try{
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:secure.email,password:secure.password})});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 save('ds-permits.json',[{name:label,task:step.task,effort:step.effort??map[label],paired:true,promptMarker:step.kind==='quiz'?'你是学习单选题编写助手':'任务：在不同批次'}]);
 const start=Date.now(),q=new Request(base+'/api/learning/pages/'+step.pageId+'/'+step.kind,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify(step.kind==='quiz'?{id:step.id,settings:step.settings}:{id:step.id}),signal:AbortSignal.timeout(step.longWait?660000:240000)}),r=step.nativeHttp?await nativeFetch(q):await fetch(q),value=await r.json();save(label+'-api.json',{status:r.status,value,durationMs:Date.now()-start});
 const db=new Database(root+'/data/users/'+session.userId+'/learning-organizer.sqlite',{readonly:true});let row;try{row=db.prepare('SELECT * FROM '+(step.kind==='quiz'?'learning_quiz_runs':'learning_overview_runs')+' WHERE id=?').get(step.id);save(label+'-stored.json',row??null);}finally{db.close();}
 const count=fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).length;assert.equal(count,initial+1,'Expected exactly one real call');
 const response=JSON.parse(fs.readFileSync(root+'/ds-response-'+count+'.json'));save('blind/'+label+'.json',{label,kind:step.kind,publishedStatus:row?.status,failure:row?.failure,rawFinalText:response.text,published:row?.result_json?JSON.parse(row.result_json):null});
 console.log(JSON.stringify({completed:count,plannedPairs:8,label,httpStatus:r.status,published:row?.status,failure:row?.failure}));
}catch(e){exitCode=1;save(label+'-failure.json',{message:e.message,code:e.code??e.cause?.code??null});console.error(label+': '+e.message);}
finally{save('ds-permits.json',[]);save(label+'-exit.json',{exitCode,at:new Date().toISOString()});process.exitCode=exitCode;}
