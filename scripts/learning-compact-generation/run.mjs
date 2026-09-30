import fs from 'node:fs';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {root,environment,save} from './runtime.mjs';
const label=process.argv[2],initial=fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).length;
assert(!fs.existsSync(root+'/'+label+'-exit.json'),'Do not replay a finished step');
let exitCode=1;
try{save('ds-permits.json',[{label}]);const r=spawnSync(process.execPath,['--import','tsx','scripts/learning-compact-generation/step.mjs',label],{env:{...environment(true),LEARNING_AI_REQUEST_TIMEOUT_MS:'240000'},encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});
 fs.writeFileSync(root+'/'+label+'-process.log',(r.stdout??'')+(r.stderr??''));exitCode=r.status??1;
 console.log(JSON.stringify({label,exitCode,error:r.error?.code,completed:fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).length,budget:16,output:r.stdout?.trim()}));
}finally{save('ds-permits.json',[]);save(label+'-exit.json',{exitCode,initial,at:new Date().toISOString()});process.exitCode=exitCode;}
