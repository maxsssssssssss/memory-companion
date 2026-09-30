import fs from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root='output/learning-compact-generation-20260923';
fs.mkdirSync(root+'/before',{recursive:true});
const save=(f,v)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2),{flag:'wx'});
const hash=b=>createHash('sha256').update(b).digest('hex');
if(!fs.existsSync(root+'/baseline.json')){
 const git={};for(const[k,args]of Object.entries({branch:['branch','--show-current'],head:['rev-parse','HEAD'],status:['status','--short'],staged:['diff','--cached','--name-only']})){const r=spawnSync('git',args,{encoding:'utf8',windowsHide:true});assert.equal(r.status,0);git[k]=r.stdout.trim();}
 const files=['quiz-service.ts','quiz-repository.ts','quiz-grounding.ts','model-input.ts','framework-generator.ts'];
 for(const f of files)fs.copyFileSync('src/lib/server/learning/'+f,root+'/before/'+f);
 save('baseline.json',{at:new Date().toISOString(),git,files:files.map(f=>({file:f,sha256:hash(fs.readFileSync(root+'/before/'+f))}))});
}
if(process.argv.includes('--metadata')){
 const cfg={...parseEnv(fs.readFileSync('.env.local','utf8')),...process.env};
 assert.equal(new URL(cfg.OPENAI_BASE_URL).hostname,'tokenhub.vision-intelligence.tech');assert(cfg.OPENAI_API_KEY);
 const auth=cfg.OPENAI_AUTH_HEADER_MODE==='raw'?cfg.OPENAI_API_KEY:'Bearer '+cfg.OPENAI_API_KEY;
 const r=await fetch('https://tokenhub.vision-intelligence.tech/v1/models',{headers:{Authorization:auth},redirect:'error',signal:AbortSignal.timeout(30000)});
 const v=await r.json();const models=Array.isArray(v.data)?v.data.filter(m=>['deepseek-v4-pro','gpt-5.5'].includes(m.id)):[];
 save('provider-metadata.json',{at:new Date().toISOString(),status:r.status,configuredTextModel:cfg.OPENAI_TEXT_MODEL,configuredQaModel:cfg.OPENAI_QA_MODEL,wire:cfg.OPENAI_QA_WIRE_API,models,generatedRequests:0});
 console.log(JSON.stringify({status:r.status,models,generatedRequests:0}));
}else console.log('Local baseline saved; no network.');
