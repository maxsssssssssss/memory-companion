// Repeatable, bounded non-production runtime. No requests are made by starting Next.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import net from 'node:net';import {fileURLToPath} from 'node:url';
import {randomBytes,createHmac,timingSafeEqual,createHash} from 'node:crypto';import {parseEnv} from 'node:util';import {spawn,spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
export const root=path.resolve('output/learning-synthetic-course-20260923'),repo=process.cwd();
export const privateFile=process.platform==='win32'&&process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'DailyBriefLearningTrial','course-20260923.dpapi'):null;
function requirePrivateFile(){
 if(process.platform!=='win32')throw Error('secure_config_requires_windows_dpapi');
 if(!privateFile)throw Error('secure_config_localappdata_missing');
 return privateFile;
}
export function vault(action,value){
 const vaultFile=requirePrivateFile();
 const ps=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $p=[Environment]::GetEnvironmentVariable('LEARNING_TRIAL_VAULT'); if('${action}' -eq 'write') { $text=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($text); $sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)) | Out-Null; [IO.File]::WriteAllBytes($p,$sealed); } else { $clear=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($p),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($clear)); }`;
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{env:{...process.env,LEARNING_TRIAL_VAULT:vaultFile},input:value?JSON.stringify(value):undefined,windowsHide:true,encoding:'utf8'});if(r.status!==0){let message=r.stderr??r.error?.code??'';for(const v of Object.values(value??{}))if(typeof v==='string')message=message.replaceAll(v,'[REDACTED]');save('vault-error.json',{action,exitCode:r.status,errorCode:r.error?.code,stderr:message.slice(0,5000)});throw Error('secure_config_'+action+'_failed');}return action==='read'?JSON.parse(r.stdout):undefined;
}
export const save=(f,v)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),slash=p=>p.replaceAll('\\','/');
const cmd=process.argv[2];
if(path.resolve(process.argv[1]??'')!==fileURLToPath(import.meta.url)) { /* imported helpers */ }
else if(cmd==='status'){
 const s=fs.existsSync(root+'/runtime.json')?JSON.parse(fs.readFileSync(root+'/runtime.json','utf8')):null;
 let online=false;if(s)try{online=(await fetch(s.base+'/api/auth/session',{signal:AbortSignal.timeout(2000)})).status<500;}catch{}
 console.log(JSON.stringify({runtime:s,online,secureConfigPresent:privateFile!==null&&fs.existsSync(privateFile),counts:{ds:fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).length,asrSubmits:fs.readdirSync(root).filter(f=>/^asr-submit-learning_.*\.json$/.test(f)).length,ocrPages:fs.readdirSync(root).filter(f=>/^ocr-claim-/.test(f)).length}}));
}else if(cmd==='stop'){fs.writeFileSync(root+'/stop','stop');console.log('Stop requested for this course runtime only');}
else if(cmd==='start')await start();
else if(cmd==='credentials')throw Error('Credentials are never printed. Use: node scripts/learning-synthetic-course/open.mjs');
async function start(){
 requirePrivateFile();
 const live=process.argv.includes('--live'),production=process.argv.includes('--production'),cfg={...parseEnv(fs.readFileSync('.env.local','utf8')),...process.env};
 assert(cfg.OPENAI_API_KEY&&new URL(cfg.OPENAI_BASE_URL).hostname==='tokenhub.vision-intelligence.tech');assert(cfg.SPEAKER_ASR_BASE_URL);
 if(!fs.existsSync(privateFile))vault('write',{secret:randomBytes(48).toString('base64url'),email:'course-'+randomBytes(6).toString('hex')+'@synthetic.invalid',password:randomBytes(24).toString('base64url'),invite:randomBytes(24).toString('base64url')});
 const secure=vault('read');assert(secure.secret.length>=32);const secrets=[secure.secret,secure.password,secure.invite,secure.ocrToken,cfg.OPENAI_API_KEY];
 const redact=s=>{for(const v of secrets)if(v)s=s.replaceAll(v,'[REDACTED]');return s.replace(/capability=[^\s"&<>]+/g,'capability=[REDACTED]');};
 const appPort=37910,gatePort=37911,adminPort=37912,base='http://127.0.0.1:'+appPort;
 for(const port of[appPort,gatePort,adminPort])await new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(port,'127.0.0.1',()=>s.close(r));});
 if(fs.existsSync(root+'/stop'))fs.unlinkSync(root+'/stop');
 const run=Date.now(),children=[],previous=fs.readFileSync('next-env.d.ts');let gateway,stage='start',code=0,url;
 const event=x=>fs.appendFileSync(root+'/gateway-events.jsonl',JSON.stringify({...x,at:new Date().toISOString()})+'\n');
 const launch=(command,args,env,name)=>{const c=spawn(command,args,{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(c);for(const s of[c.stdout,c.stderr])s.on('data',b=>fs.appendFileSync(root+'/'+name,redact(String(b))));c.on('error',()=>save(name+'.error.json',{spawnFailed:true}));return c;};
 process.on('SIGTERM',()=>fs.writeFileSync(root+'/stop','stop'));process.on('SIGINT',()=>fs.writeFileSync(root+'/stop','stop'));
 try{
  if(live){
   gateway=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://localhost'),match=u.pathname.match(/^\/api\/learning\/asr-audio\/([A-Za-z0-9_-]+)\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(\d+)$/),hdr={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
    const finish=(status,reason)=>{res.writeHead(status,hdr);res.end();event({status,reason,method:req.method});};
    if(!match||!['GET','HEAD'].includes(req.method))return finish(404,'route_denied');
    const [,user,page,task,material,index]=match,expires=Number(u.searchParams.get('expires')),cap=u.searchParams.get('capability')??'',now=Math.floor(Date.now()/1000);
    const expected=createHmac('sha256',secure.secret).update(['v1','transcription',user,`learning:${page}:${task}:${material}`,index,String(expires)].join('\0')).digest('base64url');
    if(u.searchParams.get('purpose')!=='transcription'||!Number.isSafeInteger(expires)||expires<=now||expires>now+300||cap.length!==expected.length||!timingSafeEqual(Buffer.from(cap),Buffer.from(expected)))return finish(401,'invalid_capability');
    let authorized=[];try{authorized=JSON.parse(fs.readFileSync(root+'/authorized-materials.json','utf8'));}catch{}
    if(!authorized.some(s=>s.userId===user&&s.pageId===page&&s.materialId===material))return finish(403,'scope_denied');
    try{const r=await fetch(base+u.pathname+u.search,{method:req.method,headers:req.headers.range?{range:req.headers.range}:{},redirect:'error',signal:AbortSignal.timeout(90000)}),bytes=Buffer.from(await r.arrayBuffer());res.writeHead(r.status,{...hdr,...Object.fromEntries(['content-type','content-length','content-range','accept-ranges'].flatMap(k=>r.headers.has(k)?[[k,r.headers.get(k)]]:[]))});res.end(bytes);event({status:r.status,method:req.method,userId:user,pageId:page,runId:task,materialId:material,index:Number(index),bytes:bytes.length,capabilitySha256:createHash('sha256').update(cap).digest('hex'),forwardedFor:req.headers['x-forwarded-for']??null,userAgent:req.headers['user-agent']??null});}catch{finish(502,'upstream_failed');}
   });await new Promise(r=>gateway.listen(gatePort,'127.0.0.1',r));
   fs.writeFileSync(root+'/ngrok-local.yml',`version: "3"\nagent:\n  web_addr: 127.0.0.1:${adminPort}\n`);
   const ngrok=path.join(process.env.USERPROFILE,'Downloads/ngrok-v3-stable-windows-amd64/ngrok.exe'),args=['--config',path.join(process.env.LOCALAPPDATA,'ngrok/ngrok.yml'),'--config',root+'/ngrok-local.yml'];
   const check=spawnSync(ngrok,['config','check',...args],{windowsHide:true,encoding:'utf8'});assert.equal(check.status,0,'ngrok config invalid');
   const agent=launch(ngrok,['http','http://127.0.0.1:'+gatePort,...args,'--inspect=false','--log=stdout','--log-format=json'],process.env,'ngrok-'+run+'.log');
   const deadline=Date.now()+60000;while(Date.now()<deadline){assert(agent.exitCode===null,'ngrok exited');try{const r=await fetch(`http://127.0.0.1:${adminPort}/api/tunnels`,{signal:AbortSignal.timeout(1500)}),v=await r.json();url=v.tunnels?.find(t=>t.public_url?.startsWith('https://'))?.public_url;if(url)break;}catch{}await sleep(300);}assert(url,'ngrok not ready');
   const denied=await fetch(url+'/api/auth/login',{headers:{'ngrok-skip-browser-warning':'learning-course'},redirect:'manual',signal:AbortSignal.timeout(15000)});assert.equal(denied.status,404);
  }
  stage='next';const env={};for(const[k,v]of Object.entries(process.env))if(/^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|homedrive|homepath|processor_architecture|number_of_processors)$/i.test(k))env[k]=v;
  for(const k of['SPEAKER_ASR_BASE_URL','SPEAKER_ASR_LANGUAGE','SPEAKER_ASR_SPEAKER_COUNT','OPENAI_BASE_URL','OPENAI_API_KEY','OPENAI_AUTH_HEADER_MODE'])if(cfg[k])env[k]=cfg[k];
  Object.assign(env,{APP_DATA_DIR:root+'/data',DATA_DIR:root+'/data',APP_STORAGE_MODE:'local',DAILY_BRIEF_E2E_DIST_DIR:slash(path.relative(repo,root+(production?'/build':'/next'))),DAILY_BRIEF_E2E_TSCONFIG:slash(path.relative(repo,root+'/tsconfig.json')),LEARNING_VALIDATION_REPO:repo,LEARNING_TRIAL_ROOT:root,LEARNING_TRIAL_LIVE:live?'1':'0',LEARNING_ASR_AUDIO_CAPABILITY_SECRET:secure.secret,SPEAKER_ASR_AUDIO_BASE_URL:url??'https://unavailable.invalid',SPEAKER_ASR_POLL_INTERVAL_MS:'5000',LEARNING_AI_PROVIDER:live?'tokenhub':'',LEARNING_AI_MODEL:'deepseek-v4-pro',LEARNING_AI_MAX_INPUT_CHARS:'48000',LEARNING_AI_MAX_OUTPUT_TOKENS:'8000',LEARNING_PDF_SERVICE_URL:live&&secure.ocrToken?'http://127.0.0.1:37913':'',LEARNING_PDF_SERVICE_TOKEN:live?secure.ocrToken??'':'',LEARNING_PDF_KNOWN_FINDINGS_FILE:root+'/known-findings.json',NEXT_TELEMETRY_DISABLED:'1',DAILY_BRIEF_INVITE_CODES:secure.invite,PIPELINE_EXECUTION_MODE:'inline',NODE_OPTIONS:`--max-old-space-size=8192 --require="${slash(repo+'/scripts/learning-synthetic-course/guard.cjs')}"`});
  fs.mkdirSync(root+'/data',{recursive:true});save('tsconfig.json',{extends:slash(repo+'/tsconfig.json'),compilerOptions:{incremental:false,baseUrl:slash(repo),paths:{'@/*':['./src/*']}},include:[slash(repo+'/src/**/*.ts'),slash(repo+'/src/**/*.tsx')],exclude:[slash(repo+'/node_modules')]});
  const log='next-'+run+'.log',server=launch(process.execPath,['node_modules/next/dist/bin/next',production?'start':'dev','--hostname','127.0.0.1','-p',String(appPort)],env,log);
  const deadline=Date.now()+180000;while(Date.now()<deadline){assert(server.exitCode===null,'Next exited');if(fs.existsSync(root+'/'+log)&&fs.readFileSync(root+'/'+log,'utf8').includes('Ready in'))break;await sleep(300);}assert(fs.readFileSync(root+'/'+log,'utf8').includes('Ready in'),'Next not ready');
  save('runtime.json',{base,url:url??null,pid:process.pid,children:children.map(c=>c.pid),appPort,gatePort,adminPort,live,startedAt:new Date().toISOString()});console.log('Course runtime READY '+base+'; '+(live?'live calls require planned permits':'read-only Provider mode'));
  stage='ready';while(!fs.existsSync(root+'/stop')&&Date.now()-run<3*3600*1000){assert(children.every(c=>c.exitCode===null),'owned child exited');await sleep(500);}
 }catch(e){code=1;save('runtime-failure-'+run+'.json',{stage,error:redact(e.message)});console.log('Course runtime failed: '+redact(e.message));}
 finally{const cleanup=[];for(const c of children.reverse())if(c.exitCode===null){const r=spawnSync('taskkill',['/PID',String(c.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});cleanup.push({pid:c.pid,exitCode:r.status});}await new Promise(r=>gateway?gateway.close(r):r());if(fs.readFileSync('next-env.d.ts','utf8').includes('learning-synthetic-course-20260923'))fs.writeFileSync('next-env.d.ts',previous);save('runtime-exit-'+run+'.json',{code,stage,cleanup,at:new Date().toISOString()});process.exitCode=code;}
}
