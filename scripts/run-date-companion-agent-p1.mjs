// Narrow offline acceptance runner using the existing network guard and Playwright setup.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
const root = process.cwd(), stamp = new Date().toISOString().replace(/[:.]/g, '-');
const phase = process.argv.includes('--p3') ? 'p3' : process.argv.includes('--p2') ? 'p2' : 'p1';
const artifacts = resolve(root, `output/date-companion-agent-${phase}`, stamp);
const dev = process.argv.includes('--dev'), reuse = process.argv.includes('--reuse-build');
await mkdir(join(artifacts, 'data'), { recursive: true });
const previousNextEnv = await readFile('next-env.d.ts');
const port = await new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const env = { ...process.env, NEXT_TELEMETRY_DISABLED:'1', NEXT_WEBPACK_PARALLELISM:'2',
  APP_DATA_DIR:join(artifacts,'data'), APP_STORAGE_MODE:'local', PIPELINE_EXECUTION_MODE:'inline', REDIS_URL:'',
  DAILY_BRIEF_INVITE_CODES:'date-agent-fixture', DATE_AGENT_ARTIFACTS:artifacts, DATE_AGENT_FIXTURE_PHASE:phase, DATE_AGENT_BASE_URL:`http://127.0.0.1:${port}`,
  ...(phase === 'p3' ? { DAILY_BRIEF_TOY_SYNC_ENABLED: 'true' } : {}),
  TRANSCRIPTION_PROVIDER:'none', TRANSCRIPTION_FALLBACK_PROVIDER:'none', LANGCHAIN_TRACING:'false', LANGSMITH_TRACING:'false',
  OPENAI_BASE_URL:'https://tokenhub.vision-intelligence.tech/v1', OPENAI_API_KEY:'offline-date-agent-key', OPENAI_AUTH_HEADER_MODE:'raw',
  QA_HYBRID_RETRIEVAL_MODE:'off', MEMORY_RELEVANCE_PROVIDER:'none', DATE_COMPANION_MEMORY_BRIDGE_ENABLED:'false', DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED:'false',
  AUDIO_INSIGHT_PROVIDER:'rule', EXTRACTION_PROVIDER:'rule', RELATIONSHIP_SIGNAL_PROVIDER:'none', EMOTION_SIGNAL_PROVIDER:'none', PROACTIVE_INSIGHT_PROVIDER:'none',
  NODE_OPTIONS:`--max-old-space-size=4096 --require=${resolve('scripts/date-companion-e2e-network-guard.cjs').replaceAll('\\','/')} --require=${resolve('scripts/date-companion-agent-fixture.cjs').replaceAll('\\','/')}` };
for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|SECRET|BASE_URL|REDIS_URL)$/.test(key) && !['OPENAI_API_KEY','OPENAI_BASE_URL','DATE_AGENT_BASE_URL'].includes(key)) env[key]='';
if (phase === 'p3' && !dev) {
  if (reuse && !env.DAILY_BRIEF_E2E_DIST_DIR) throw Error('Select the verified P3 build with DAILY_BRIEF_E2E_DIST_DIR.');
  const runDir = relative(root, artifacts).replaceAll('\\','/');
  if (!reuse) {
    env.DAILY_BRIEF_E2E_DIST_DIR = `${runDir}/production`;
    env.DAILY_BRIEF_E2E_TSCONFIG = `${runDir}/build-tsconfig.json`;
    await writeFile(env.DAILY_BRIEF_E2E_TSCONFIG, JSON.stringify({
      extends:'../../../tsconfig.json', compilerOptions:{baseUrl:'../../..',incremental:false},
      include:['../../../next-env.d.ts','../../../src/**/*.ts','../../../src/**/*.tsx','../../../scripts/**/*.ts','../../../e2e/**/*.ts','production/types/**/*.ts']
    },null,2));
  }
}
const summary = { artifacts, phase, baseURL:env.DATE_AGENT_BASE_URL, buildExit:null, browserExit:null, realProviderRequests:0, blockedExternalAttempts:0, mode:dev?'development':'production' };
let server;
function launch(args, name, command=process.execPath) {
  const child=spawn(command,args,{cwd:root,env,windowsHide:true,shell:command.endsWith('.cmd'),stdio:['ignore','pipe','pipe']});
  const capture=data=>{summary.blockedExternalAttempts+=(data.toString().match(/\[date-companion-e2e-network\] blocked_external_request/g)??[]).length;
    process.stdout.write(data);void appendFile(join(artifacts,`${name}.log`),data);};
  child.stdout.on('data',capture);child.stderr.on('data',capture);return child;
}
const wait=child=>new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});
try {
  console.log('[date-agent] 0/3 preparing isolated data and offline transport');
  if(!dev&&!reuse){summary.buildExit=await wait(launch(['run','build'],'build',process.platform==='win32'?'npm.cmd':'npm'));if(summary.buildExit!==0)throw Error('Build failed');}
  if(!dev) summary.buildId=(await readFile(join(env.DAILY_BRIEF_E2E_DIST_DIR || '.next','BUILD_ID'),'utf8')).trim();
  console.log('[date-agent] 1/3 starting owned loopback server');
  server=launch(['node_modules/next/dist/bin/next',dev?'dev':'start','-H','127.0.0.1','-p',String(port)],'server');
  let ready=false;
  for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error('Server exited');try{if((await fetch(env.DATE_AGENT_BASE_URL)).status<500){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  if(!ready)throw Error('Server readiness failed');
  const group=phase==='p3' ? process.argv.find(arg => /^--group=[ABC]$/.test(arg))?.at(-1) : undefined;
  const groupTitle={A:'A old entries',B:'B long discussion',C:'C P2 grant'};
  console.log(`[date-agent] 2/3 running ${group ? 'group '+group : 'three page/API/SQLite/Runtime fixture flows'}`);
  summary.browserExit=await wait(launch(['node_modules/@playwright/test/cli.js','test',`e2e/date-companion-agent-${phase}.spec.ts`,'--workers=1','--retries=0','--reporter=line',...(group?['--grep',groupTitle[group]]:[]),`--output=${join(artifacts,'playwright')}`],'browser'));
  if(summary.browserExit!==0)throw Error('Browser acceptance failed');
  if(summary.blockedExternalAttempts)throw Error('Offline guard blocked an unexpected external attempt');
  console.log('[date-agent] 3/3 offline acceptance passed');
}catch(error){summary.failure=error.message;process.exitCode=1;}
finally{
  if(server&&server.exitCode===null){const exit=wait(server);server.kill();await exit;}
  await writeFile('next-env.d.ts',previousNextEnv);
  await writeFile(join(artifacts,'summary.json'),JSON.stringify(summary,null,2));
  console.log(`Evidence: ${artifacts}`);
}
