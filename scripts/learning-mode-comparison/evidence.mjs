// Read-only data/receipt audit. The main synthetic course is never opened for writes.
import fs from 'node:fs';import {createHash} from 'node:crypto';import Database from 'better-sqlite3';import assert from 'node:assert/strict';import {root,save} from './runtime.mjs';
const phase=process.argv[2]??'current',hash=b=>createHash('sha256').update(b).digest('hex'),baseline=JSON.parse(fs.readFileSync(root+'/baseline.json','utf8')),old=JSON.parse(fs.readFileSync(root+'/old-rows.json','utf8')),session=baseline.session;
const original=baseline.source+'/data/users/'+session.userId+'/learning-organizer.sqlite';assert.equal(hash(fs.readFileSync(original)),baseline.originalDatabaseSha256,'Original course bytes changed');
const db=new Database(root+'/data/users/'+session.userId+'/learning-organizer.sqlite',{readonly:true}),tables={},current={},runs=new Map();
try{assert.equal(db.pragma('integrity_check',{simple:true}),'ok');for(const [table,rows]of Object.entries(old)){const now=db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),rowHashes=new Set(now.map(r=>hash(JSON.stringify(r))));const missing=rows.filter(r=>!rowHashes.has(hash(JSON.stringify(r)))).length;tables[table]={old:rows.length,now:now.length,missingOrChanged:missing};assert.equal(missing,0,table+' old data changed');}
 for(const table of ['learning_pages',...Object.keys(old)]){const rows=db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();current[table]={rows:rows.length,sha256:hash(JSON.stringify(rows))};}
 for(const table of ['learning_quiz_runs','learning_overview_runs'])for(const row of db.prepare('SELECT id,status,failure,result_json,diagnostics_json FROM '+table).all())runs.set(row.id,row);
 if(phase==='before-restart')save('restart-content-before.json',current);
 if(phase==='after-restart')assert.deepEqual(current,JSON.parse(fs.readFileSync(root+'/restart-content-before.json','utf8')),'Saved old and new course content must survive restart exactly');
 save('data-audit-'+phase+'.json',{status:'PASS',snapshotMethod:'SQLite online backup',originalDatabaseSha256:baseline.originalDatabaseSha256,originalUnchanged:true,tables,current});
}finally{db.close();}
const plans=['plan.json','refinement-plan.json','transport-recheck-plan.json'].flatMap(f=>JSON.parse(fs.readFileSync(root+'/'+f)).runs);
const ids=fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).map(f=>Number(f.match(/\d+/)[0])).sort((a,b)=>a-b);
const ledger=ids.map(n=>{
 const request=JSON.parse(fs.readFileSync(root+'/ds-request-'+n+'.json','utf8')),response=JSON.parse(fs.readFileSync(root+'/ds-response-'+n+'.json','utf8'));
 const planned=plans.find(p=>p.label===request.step),row=runs.get(planned.id),diagnostics=row?.diagnostics_json?JSON.parse(row.diagnostics_json):{};
 assert.equal(request.body.model,'deepseek-v4-pro');assert(request.inputChars<=48000&&request.body.max_output_tokens<=16000);
 const comparable={...request.body};delete comparable.reasoning;
 assert.equal(hash(JSON.stringify(comparable)),JSON.parse(fs.readFileSync(root+'/pair-'+planned.task+'.json')).requestWithoutReasoningSha256);
 const apiFile=root+'/'+request.step+'-api.json',api=fs.existsSync(apiFile)?JSON.parse(fs.readFileSync(apiFile)):null;
 const raw=fs.readFileSync(root+'/review-only/raw-response-'+n+'.sse','utf8'),events={};
 // Count event names only. Reasoning text is not turned into course/review content.
 for(const line of raw.split(/\r?\n/)){if(!line.startsWith('data:'))continue;try{const e=JSON.parse(line.slice(5));if(e.type)events[e.type]=(events[e.type]??0)+1;}catch{}}
 let finalJsonValid=null;if(response.text){try{JSON.parse(response.text);finalJsonValid=true;}catch{finalJsonValid=false;}}
 return{request:n,step:request.step,at:request.at,model:request.body.model,effort:request.body.reasoning.effort,
  inputChars:request.inputChars,outputLimit:request.body.max_output_tokens,timeoutMs:diagnostics.requestTimeoutMs??120000,
  requestSha256:hash(fs.readFileSync(root+'/ds-request-'+n+'.json')),bodyWithoutReasoningSha256:hash(JSON.stringify(comparable)),
  transport:response.transport??'fetch',httpStatus:response.httpStatus,terminal:response.terminal,events,
  returnedModel:response.returnedModel,returnedReasoning:response.returnedReasoning,usage:response.usage??null,
  // Initial headers are not total request duration. Failed calls with no terminal retain unknown duration.
  generationDurationMs:diagnostics.totalDurationMs??(response.terminal?response.durationMs:null),apiDurationMs:api?.durationMs??null,
  finalJsonValid,status:row?.status??null,failure:row?.failure??null,published:Boolean(row?.result_json),
  outputBudgetReached:response.usage?response.usage.output_tokens>=request.body.max_output_tokens:null};
});
assert(ids.length<=12);assert.equal(hash(fs.readFileSync(root+'/plan.json')),fs.readFileSync(root+'/plan.sha256','utf8').trim());
const known=ledger.filter(r=>r.usage!==null),sum=key=>known.reduce((s,r)=>s+r.usage[key],0);
save('ledger.json',{requests:ledger.length,requestLimit:12,ocr:0,asr:0,remoteStarts:0,usedHistoricalParsedAndAsr:true,
 usageComplete:known.length===ledger.length,unknownUsageRequests:ledger.filter(r=>!r.usage).map(r=>r.request),
 knownUsageOnly:{requests:known.length,input:sum('input_tokens'),output:sum('output_tokens'),total:sum('total_tokens')},
 totals:known.length===ledger.length?{input:sum('input_tokens'),output:sum('output_tokens'),total:sum('total_tokens')}:null,ledger});
console.log(JSON.stringify({phase,status:'PASS',originalUnchanged:true,oldRowsPreserved:Object.values(tables).reduce((n,t)=>n+t.old,0),ds:ledger.length,ocr:0,asr:0}));
