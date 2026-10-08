import assert from 'node:assert/strict';
import { spawnOwned, stopOwned } from './lib/owned-process.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { learningWorkflowBrowser } from './validate-learning-workflow-flows.mjs';

const repo=process.cwd(), root=path.join(repo,'output/playwright/learning-workflow-20260922');
const run=path.join(root,'browser-'+Date.now()), data=path.join(run,'isolated-data');
const dist=path.join(root,'next-dev'), config=path.join(root,'tsconfig-browser.json');
const slash=s=>s.replaceAll('\\','/');
await mkdir(data,{recursive:true}); await writeFile(path.join(run,'mock-control.json'),JSON.stringify({pdfMode:'warning'}));
await writeFile(path.join(run,'findings.json'),'[]');
await writeFile(config,JSON.stringify({extends:slash(path.join(repo,'tsconfig.json')),compilerOptions:{incremental:false,baseUrl:slash(repo),paths:{'@/*':['./src/*']}},include:[slash(path.join(repo,'src/**/*.ts')),slash(path.join(repo,'src/**/*.tsx')),slash(path.join(dist,'types/**/*.ts'))],exclude:[slash(path.join(repo,'node_modules'))]},null,2));
const previous=await readFile('next-env.d.ts');
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const base='http://127.0.0.1:'+port, env={};
for(const [k,v] of Object.entries(process.env))if(/^(path|home|lang|lc_all|xdg_cache_home|playwright_browsers_path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|homedrive|homepath|processor_architecture|number_of_processors)$/i.test(k))env[k]=v;
Object.assign(env,{APP_DATA_DIR:data,DATA_DIR:data,APP_STORAGE_MODE:'local',DAILY_BRIEF_E2E_DIST_DIR:slash(path.relative(repo,dist)),DAILY_BRIEF_E2E_TSCONFIG:slash(path.relative(repo,config)),
  LEARNING_VALIDATION_REPO:repo,NODE_OPTIONS:'--max-old-space-size=8192 --require="'+slash(path.join(repo,'scripts/learning-workflow-browser-mock.cjs'))+'"',NEXT_TELEMETRY_DISABLED:'1',
  DAILY_BRIEF_INVITE_CODES:'synthetic-learning-workflow-only',DAILY_REFLECTION_UPLOAD_ENABLED:'true',WORK_REVIEW_ENABLED:'true',PIPELINE_EXECUTION_MODE:'inline',
  OPENAI_BASE_URL:'https://tokenhub.vision-intelligence.tech/v1',OPENAI_API_KEY:'SYNTHETIC_FRAMEWORK_NO_REAL_KEY',LEARNING_AI_PROVIDER:'tokenhub',LEARNING_AI_MODEL:'deepseek-v4-pro',LEARNING_AI_MAX_INPUT_CHARS:'48000',LEARNING_AI_MAX_OUTPUT_TOKENS:'8000',LEARNING_FRAMEWORK_MOCK_OUTPUT:run,
  SPEAKER_ASR_BASE_URL:'https://company-asr.synthetic.invalid',SPEAKER_ASR_AUDIO_BASE_URL:base,LEARNING_ASR_AUDIO_CAPABILITY_SECRET:'SYNTHETIC_ONLY_LEARNING_ASR_SECRET_32',
  LEARNING_PDF_SERVICE_URL:'http://127.0.0.1:9',LEARNING_PDF_SERVICE_TOKEN:'SYNTHETIC_NO_OCR_KEY',LEARNING_PDF_KNOWN_FINDINGS_FILE:path.join(run,'findings.json')});
const server=spawnOwned(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','-p',String(port)],{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='', browser;
for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{log+=chunk;});
console.log('[learning-workflow] isolated run '+run);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await browser?.close().catch(()=>{}); await stopOwned(server); process.exit(signal==='SIGINT'?130:143); });
try {
  await writeFile(path.join(root,'current-browser.json'),JSON.stringify({run,port,pid:server.pid,base}));
  const deadline=Date.now()+180000;
  while(true){if(server.exitCode!==null)throw Error('Next exited');let r;try{r=await fetch(base,{signal:AbortSignal.timeout(30000)});}catch{}if(r?.ok)break;if(Date.now()>deadline)throw Error('Next readiness timeout');await new Promise(r=>setTimeout(r,500));}
  browser=await chromium.launch({headless:true});
  await learningWorkflowBrowser({browser,base,run,inviteCode:env.DAILY_BRIEF_INVITE_CODES});
  assert(!log.includes('blocked_external_request'));assert(!/Environments:.*\.env/.test(log));
} catch(error) {
  const page=browser?.contexts().flatMap(c=>c.pages()).at(-1);
  if(page){await page.screenshot({path:path.join(run,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(run,'failure.html'),await page.content().catch(()=>''));}
  await writeFile(path.join(run,'failure.json'),JSON.stringify({error:String(error)},null,2));throw error;
} finally {
  await browser?.close().catch(()=>{});
  await stopOwned(server);
  await writeFile(path.join(run,'server.log'),log);
  const current=await readFile('next-env.d.ts','utf8');if(current.includes(slash(path.relative(repo,dist))))await writeFile('next-env.d.ts',previous);
  const closed=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('error',()=>resolve(true));socket.once('connect',()=>{socket.destroy();resolve(false);});});
  await writeFile(path.join(run,'cleanup.json'),JSON.stringify({ownedPort:port,closed,browserClosed:true}));
  console.log('[learning-workflow] cleanup local port closed='+closed);
}
