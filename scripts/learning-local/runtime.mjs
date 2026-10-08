// Local startup using the configured account store. No Provider requests on start.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {parseEnv} from 'node:util';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {vault} from '../learning-synthetic-course/trial.mjs';
import {learningAudioGateway} from './audio-gateway.mjs';
import {localOcrPreflight,startOcr,stopOcr} from './ocr.mjs';
export const root=path.resolve('output/learning-local-runtime'),base='http://127.0.0.1:37941';
export function localDataDirectory(env,trial=false) {
  return path.resolve(trial?'output/learning-input-scope-20260924/data':env.APP_DATA_DIR?.trim()||env.DATA_DIR?.trim()||'.data');
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),slash=p=>p.replaceAll('\\','/');
export function localEnvironment(cfg,secure,audioOrigin,ocrToken,trial=false,ocrIdentity) {
  // Keep existing product configuration; only storage/queue execution and the
  // learning-specific input/Provider settings are scoped to this local trial.
  const env={...process.env,...cfg};
  const data=localDataDirectory(env,trial);
  delete env.NODE_OPTIONS;
  for(const key of Object.keys(env))if(/^LEARNING_(CLOSURE|TRIAL|FRAMEWORK_MOCK|VALIDATION)/.test(key))delete env[key];
  Object.assign(env,{
    APP_DATA_DIR:data,DATA_DIR:data,APP_STORAGE_MODE:'local',PIPELINE_EXECUTION_MODE:'inline',
    DAILY_BRIEF_INVITE_CODES:secure.invite,NEXT_TELEMETRY_DISABLED:'1',
    DAILY_BRIEF_E2E_DIST_DIR:slash(path.relative(process.cwd(),root+'/next')),
    DAILY_BRIEF_E2E_TSCONFIG:slash(path.relative(process.cwd(),root+'/tsconfig.json')),
    LEARNING_AI_PROVIDER:'tokenhub',LEARNING_AI_MODEL:'deepseek-v4-pro',LEARNING_AI_MAX_INPUT_CHARS:'120000',LEARNING_AI_MAX_OUTPUT_TOKENS:'16000',LEARNING_AI_REQUEST_TIMEOUT_MS:'240000',
    LEARNING_ASR_AUDIO_CAPABILITY_SECRET:secure.secret,LEARNING_ASR_AUDIO_BASE_URL:audioOrigin,
    LEARNING_PDF_SERVICE_URL:ocrToken?'http://127.0.0.1:37913':'',LEARNING_PDF_SERVICE_TOKEN:ocrToken??'',
    LEARNING_PDF_SERVICE_EPOCH:ocrToken&&ocrIdentity?.epoch?ocrIdentity.epoch:'',LEARNING_PDF_SERVICE_INSTANCE:ocrToken&&ocrIdentity?.instance?ocrIdentity.instance:'',
    LEARNING_PDF_KNOWN_FINDINGS_FILE:path.resolve('output/learning-synthetic-course-20260923/known-findings.json'),
    NODE_OPTIONS:'--max-old-space-size=8192'
  });return env;
}
async function freePort(port) {await new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(port,'127.0.0.1',()=>s.close(r));});}
export async function preflight(ocr=false,trial=false) {
  assert.equal(process.platform,'win32','Local Learning launcher requires Windows DPAPI and ngrok');
  assert(process.env.USERPROFILE&&process.env.LOCALAPPDATA,'Windows USERPROFILE and LOCALAPPDATA are required');
  const ngrok=path.join(process.env.USERPROFILE,'Downloads/ngrok-v3-stable-windows-amd64/ngrok.exe');
  const ngrokConfig=path.join(process.env.LOCALAPPDATA,'ngrok/ngrok.yml');
  const cfg=parseEnv(fs.readFileSync('.env.local','utf8')),secure=vault('read');
  const data=localDataDirectory({...process.env,...cfg},trial);
  assert(cfg.OPENAI_API_KEY&&new URL(cfg.OPENAI_BASE_URL).hostname==='tokenhub.vision-intelligence.tech','Learning TokenHub config absent');
  assert(cfg.SPEAKER_ASR_BASE_URL&&['https:','http:'].includes(new URL(cfg.SPEAKER_ASR_BASE_URL).protocol),'Company ASR config absent');
  assert(secure.secret?.length>=32&&secure.invite,'Learning secure config absent');
  assert(fs.existsSync(data)&&fs.statSync(data).isDirectory(),'Configured local data missing; refusing to create another empty app');
  assert(fs.existsSync(ngrok)&&fs.existsSync(ngrokConfig),'ngrok configuration missing');
  const check=spawnSync(ngrok,['config','check','--config',ngrokConfig],{windowsHide:true,stdio:'ignore'});assert.equal(check.status,0,'ngrok config invalid');
  const findings=JSON.parse(fs.readFileSync('output/learning-synthetic-course-20260923/known-findings.json','utf8'));assert(Array.isArray(findings));
  const hand=ocr?localOcrPreflight():null;
  for(const port of[37941,37942,37943,...ocr?[37913]:[]])await freePort(port);
  return {cfg,secure,ngrok,ngrokConfig,receipt:{dataRoot:data,dataProfile:trial?'learning-trial':'configured',portsFree:true,secureConfigured:true,companyAsrConfigured:true,learningGenerationConfigured:true,ocrFiles:hand?.verifiedFiles??null}};
}
export function cleanupLocalOcr(ownedOcr,record,{explicitStop=false}={}) {
  if(!ownedOcr||explicitStop)return;
  if(ownedOcr.persistent){record('ocr-preserved.json',{binding:ownedOcr.binding,reason:'local_app_stopped_service_retained'});return;}
  try{ownedOcr.stop();}catch{record('ocr-cleanup-pending.json',{needsManualCheck:true});}
}
export function stopConfiguredOcr(saved,record,stopRemote=stopOcr) {
  assert(saved?.ocr?.binding,'No bound OCR instance recorded; refusing unfenced stop');
  return stopRemote({record,binding:saved.ocr.binding});
}
async function start(ocr,trial=false) {
  fs.mkdirSync(root,{recursive:true});const {cfg,secure,ngrok,ngrokConfig,receipt}=await preflight(ocr,trial),run=Date.now(),runRoot=root+'/runs/'+run;
  fs.mkdirSync(runRoot,{recursive:true});const record=(f,v)=>{fs.writeFileSync(runRoot+'/'+f,JSON.stringify(v,null,2));if(f==='ocr-binding.json')fs.writeFileSync(root+'/ocr-binding.json',JSON.stringify(v,null,2));};record('preflight.json',receipt);
  const secrets=[...Object.entries(cfg).filter(([k])=>/KEY|SECRET|TOKEN|PASSWORD/.test(k)).map(([,v])=>v),...Object.values(secure)].filter(v=>typeof v==='string'&&v.length>7);
  const redact=s=>{for(const v of secrets)s=s.replaceAll(v,'[REDACTED]');return s.replace(/capability=[^\s"&<>]+/g,'capability=[REDACTED]');};
  const children=[];let gateway,ownedOcr,code=0;const previous=fs.readFileSync('next-env.d.ts');
  const launch=(cmd,args,env,name)=>{const c=spawn(cmd,args,{env,cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(c);for(const s of[c.stdout,c.stderr])s.on('data',b=>fs.appendFileSync(runRoot+'/'+name+'.log',redact(String(b))));c.on('error',()=>record(name+'-spawn.json',{failed:true}));return c;};
  const stop=root+'/stop';if(fs.existsSync(stop))fs.unlinkSync(stop);
  process.on('SIGTERM',()=>fs.writeFileSync(stop,'stop'));process.on('SIGINT',()=>fs.writeFileSync(stop,'stop'));
  try {
    if(ocr){console.log('1/4 OCR: checking existing lock, budget and readiness');ownedOcr=await startOcr({record,launch});secrets.push(ownedOcr.token);}
    console.log('2/4 ngrok: learning signed audio routes only');
    gateway=learningAudioGateway({base,secret:secure.secret,event:e=>fs.appendFileSync(runRoot+'/audio-access.jsonl',JSON.stringify({...e,at:new Date().toISOString()})+'\n')});
    await new Promise(r=>gateway.listen(37942,'127.0.0.1',r));
    fs.writeFileSync(runRoot+'/ngrok.yml','version: "3"\nagent:\n  web_addr: 127.0.0.1:37943\n');
    const agent=launch(ngrok,['http','http://127.0.0.1:37942','--config',ngrokConfig,'--config',runRoot+'/ngrok.yml','--inspect=false','--log=stdout','--log-format=json'],process.env,'ngrok');
    let origin;const deadline=Date.now()+60000;
    while(Date.now()<deadline){assert(agent.exitCode===null,'ngrok exited');try{const r=await fetch('http://127.0.0.1:37943/api/tunnels',{signal:AbortSignal.timeout(1500)});const v=await r.json();origin=v.tunnels?.find(t=>t.public_url?.startsWith('https://'))?.public_url;if(origin)break;}catch{}await sleep(300);}
    assert(origin,'ngrok not ready');
    const env=localEnvironment(cfg,secure,origin,ownedOcr?.token,trial,ownedOcr?.identity);
    fs.writeFileSync(root+'/tsconfig.json',JSON.stringify({extends:slash(path.resolve('tsconfig.json')),compilerOptions:{incremental:false,baseUrl:slash(process.cwd()),paths:{'@/*':['./src/*']}},include:[slash(path.resolve('src/**/*.ts')),slash(path.resolve('src/**/*.tsx'))],exclude:[slash(path.resolve('node_modules'))]}));
    console.log('3/4 Next.js: current source, preserved account data, configured learning services');
    const app=launch(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','-p','37941'],env,'next');
    let ready=false;const until=Date.now()+180000;
    while(Date.now()<until){assert(app.exitCode===null,'Next exited');try{ready=[200,401].includes((await fetch(base+'/api/auth/me',{signal:AbortSignal.timeout(5000)})).status);if(ready)break;}catch{}await sleep(400);}
    assert(ready,'Next not ready');
    const denied=await fetch(origin+'/api/auth/login',{headers:{'ngrok-skip-browser-warning':'learning-local'},redirect:'manual',signal:AbortSignal.timeout(15000)});assert.equal(denied.status,404,'Public route isolation failed');
    const state={base,dataRoot:receipt.dataRoot,dataProfile:receipt.dataProfile,pid:process.pid,children:children.map(c=>c.pid),runRoot,startedAt:new Date().toISOString(),audioOrigin:origin,learningGenerationConfigured:true,companyAsrConfigured:true,ocr:ownedOcr?{remote:ownedOcr.remote,readyAt:ownedOcr.readyAt,budget:ownedOcr.budget,lifetimeSeconds:ownedOcr.sessionSeconds,instance:ownedOcr.identity?.instance??null,persistent:ownedOcr.persistent,binding:ownedOcr.binding}:null};
    fs.writeFileSync(root+'/runtime.json',JSON.stringify(state,null,2));console.log('4/4 READY '+base+' (manual user actions can call configured services)');
    while(!fs.existsSync(stop)){assert(children.every(c=>c.exitCode===null),'Owned local process exited');await sleep(500);}
  }catch(error){code=1;record('failure.json',{message:redact(error.message)});console.log('Local startup failed: '+redact(error.message));}
  finally {
    cleanupLocalOcr(ownedOcr,record,{explicitStop:fs.existsSync(stop)&&fs.readFileSync(stop,'utf8')==='stop-ocr'});
    for(const child of children.reverse())if(child.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    if(gateway){gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}
    if(fs.readFileSync('next-env.d.ts','utf8').includes('learning-local-runtime'))fs.writeFileSync('next-env.d.ts',previous);
    record('exit.json',{code,at:new Date().toISOString()});process.exitCode=code;
  }
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)) {
  const mode=process.argv[2];
  if(mode==='start')await start(process.argv.includes('--ocr'),process.argv.includes('--trial-data'));
  else if(mode==='stop'){
    fs.mkdirSync(root,{recursive:true});fs.writeFileSync(root+'/stop',process.argv.includes('--ocr')?'stop-ocr':'stop');
    if(process.argv.includes('--ocr')){
      const saved=fs.existsSync(root+'/runtime.json')?JSON.parse(fs.readFileSync(root+'/runtime.json','utf8')):null;
      const bound=fs.existsSync(root+'/ocr-binding.json')?JSON.parse(fs.readFileSync(root+'/ocr-binding.json','utf8')):saved?.ocr?.binding;
      stopConfiguredOcr({ocr:{binding:bound}},(name,value)=>fs.writeFileSync(root+'/'+Date.now()+'-'+name,JSON.stringify(value,null,2)));
      console.log('Stop requested for local processes and the verified bound OCR instance');
    }else console.log('Local stop requested; a ready persistent OCR service is retained');
  }
  else if(mode==='preflight'){const {receipt}=await preflight(process.argv.includes('--ocr'),process.argv.includes('--trial-data'));console.log(JSON.stringify(receipt));}
  else if(mode==='status'){
    const saved=fs.existsSync(root+'/runtime.json')?JSON.parse(fs.readFileSync(root+'/runtime.json','utf8')):null;
    let app=false,ngrok=false;try{app=[200,401].includes((await fetch(base+'/api/auth/me',{signal:AbortSignal.timeout(5000)})).status);}catch{}
    try{ngrok=(await fetch('http://127.0.0.1:37943/api/tunnels',{signal:AbortSignal.timeout(1500)})).ok;}catch{}
    console.log(JSON.stringify({base,app,ngrok,dataRoot:saved?.dataRoot??null,dataProfile:saved?.dataProfile??null,ocr:saved?.ocr??null,lastStartup:saved?.startedAt??null}));
  }else throw Error('Use start [--ocr] [--trial-data], preflight [--ocr] [--trial-data], status, stop [--ocr]');
}
