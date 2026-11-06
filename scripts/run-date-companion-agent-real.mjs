// Explicit local acceptance. Each explicitly authorized campaign owns one cumulative allowance.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const limit = 12;
const model = 'deepseek-v4-pro';
const scenario = 'date_companion_preparation_v1';
const finalCampaign = 'date-companion-p1-p3-final-2026-11-06';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validRunName = value => typeof value === 'string' && /^[\w-]{1,72}$/.test(value);

/** Read-only snapshot of the predecessor. Only a stopped, fully reconciled batch can continue. */
export function completedBudgetSnapshot(previous, predecessor = null) {
  function original(name) {
    const file = join(previous, name);
    if (relative(file, realpathSync(file)) !== '') throw Error('Unexpected prior evidence path');
    return file;
  }
  const authorization = readFileSync(original('AUTHORIZATION.json'));
  const profile = JSON.parse(authorization);
  const summary = JSON.parse(readFileSync(original('summary.json'), 'utf8'));
  if (profile.mode !== 'real' || profile.maxRequests !== limit || profile.scenario !== scenario || profile.model !== model || !profile.haltOnUnknown ||
      profile.accountScope !== 'new local synthetic account only' || !summary.serverExit ||
      (summary.serverExit.code === null && !summary.serverExit.signal)) throw Error('Predecessor has no closed, authorized Date Companion run');
  const network = new Database(original('network-ledger.sqlite'), {readonly:true,fileMustExist:true});
  try {
    const state = network.prepare('SELECT * FROM guard_state WHERE id=1').get();
    const rows = network.prepare('SELECT * FROM requests ORDER BY id').all();
    const report = summary.transport;
    if (state?.halted !== 0 || state.authorization_sha256 !== sha256(authorization) || state.max_requests !== limit || state.model !== model ||
        !rows.length || rows.length >= limit || rows.some(row => row.state !== 'completed' || row.model !== model) ||
        report?.sent !== rows.length || report.completed !== rows.length || report.unknown !== 0 || report.active !== 0 || report.halted !== false) {
      throw Error('Prior requests unresolved, exhausted, or inconsistent');
    }
    const inherited = predecessor?.sent ?? 0;
    if (predecessor) {
      const receipt = JSON.parse(readFileSync(original('budget-continuation.json'),'utf8'));
      if (receipt.priorRun !== predecessor.run || summary.priorRun !== predecessor.run || summary.priorRequests !== inherited ||
          receipt.priorRequests !== inherited || receipt.maxRequests !== limit || receipt.remaining !== limit - inherited ||
          receipt.authorizationSha256 !== sha256(authorization) || !predecessor.authorization.equals(authorization) ||
          receipt.priorLedgerSnapshotSha256 !== sha256(predecessor.ledger) || rows.length <= inherited ||
          sha256(JSON.stringify(rows.slice(0,inherited))) !== predecessor.rowsHash) throw Error('Inherited ledger proof differs');
    }
    const batchRows = rows.slice(inherited);
    const business = new Database(original('data/date-companion.sqlite'), {readonly:true,fileMustExist:true});
    try {
      const calls = business.prepare('SELECT c.id,c.status,c.model,c.kind,c.diagnostics_json,t.scenario FROM agent_calls c LEFT JOIN agent_tasks t ON t.id=c.task_id').all();
      const byId = new Map(calls.map(call=>[call.id,call]));
      const verified = row => {
        const call=byId.get(row.request_id);
        if (!call || call.model!==model || call.kind!=='agent_decision' || call.scenario!==scenario) return false;
        if (call.status==='succeeded') return true;
        // Only the independent feedback test may follow this known failure. Verify
        // that the SDK observed a completed stream and rejected the decoded action.
        if (!predecessor || call.status!=='failed' || !call.diagnostics_json) return false;
        const d=JSON.parse(call.diagnostics_json);
        return d?.layer==='action_schema' && d.reasonCode==='action_schema_invalid' && d.response?.responseStatus==='completed' &&
          d.response.parseResult==='success' && d.response.validationResult==='failed' && d.response.stream?.completionReceived===true;
      };
      if (calls.length !== batchRows.length || !batchRows.every(verified)) {
        throw Error('Prior network and business receipts differ');
      }
    } finally { business.close(); }
    return {authorization, ledger:network.serialize(), sent:rows.length, run:previous.split(/[\\/]/u).at(-1), rowsHash:sha256(JSON.stringify(rows))};
  } finally { network.close(); }
}

export function feedbackBudgetSnapshot(previous) {
  const name=previous.split(/[\\/]/u).at(-1);
  if(!validRunName(name) || !name.endsWith('-retest')) throw Error('Independent feedback requires a completed retest predecessor');
  const initial=name.slice(0,-'-retest'.length);
  if(!validRunName(initial)) throw Error('Invalid first batch name');
  return completedBudgetSnapshot(previous, completedBudgetSnapshot(join(dirname(previous),initial)));
}

export function initializeBudget(evidenceRoot, run, from, feedbackOnly=false, finalAcceptance=false) {
  const suffix=feedbackOnly?'feedback':'retest';
  if (!validRunName(run) || (feedbackOnly && !from) || (from && (!validRunName(from) || run !== `${from}-${suffix}`))) throw Error(`Use the single successor named <prior>-${suffix}`);
  const directory = join(evidenceRoot, run);
  let snapshot;
  if (from) {
    const batches = readdirSync(evidenceRoot, {withFileTypes:true}).filter(entry => entry.isDirectory());
    const required=feedbackOnly?[from.slice(0,-'-retest'.length),from]:[from];
    if (batches.length !== required.length || !required.every(name=>batches.some(batch=>batch.name===name))) throw Error('Prior batch missing or its successor allowance is already claimed');
    snapshot = feedbackOnly?feedbackBudgetSnapshot(join(evidenceRoot,from)):completedBudgetSnapshot(join(evidenceRoot,from));
  } else {
    mkdirSync(dirname(evidenceRoot), {recursive:true});
    if (existsSync(evidenceRoot)) throw Error('An acceptance budget already exists; continuation requires --continue-from=<prior>');
    mkdirSync(evidenceRoot); // Atomic first claim, even when two launchers start simultaneously.
  }
  mkdirSync(directory); // Atomic successor claim. Never overwrite an existing network ledger.
  mkdirSync(join(directory, 'data'));
  const authorization = snapshot?.authorization ?? JSON.stringify({mode:'real',model,scenario,maxRequests:limit,haltOnUnknown:true,accountScope:'new local synthetic account only',
    ...(finalAcceptance ? { campaign:finalCampaign,captureSyntheticInput:true } : {})},null,2);
  writeFileSync(join(directory,'AUTHORIZATION.json'), authorization, {flag:'wx'});
  if (snapshot) {
    writeFileSync(join(directory,'network-ledger.sqlite'),snapshot.ledger,{flag:'wx'});
    writeFileSync(join(directory,'budget-continuation.json'),JSON.stringify({priorRun:from,priorRequests:snapshot.sent,maxRequests:limit,remaining:limit-snapshot.sent,
      authorizationSha256:sha256(authorization),priorLedgerSnapshotSha256:sha256(snapshot.ledger)},null,2),{flag:'wx'});
  }
  return snapshot?.sent ?? 0;
}

/** Explicit, same-database final retest. Never clears a halt or recreates an allowance. */
export function claimFinalResume(workspace, run) {
  if (!validRunName(run)) throw Error('Invalid final run');
  const directory = resolve(workspace, 'output/date-companion-agent-final-real', run);
  const original = name => {
    const file = join(directory, name);
    if (relative(file, realpathSync(file)) !== '') throw Error('Unexpected final evidence path');
    return file;
  };
  if (relative(directory, realpathSync(directory)) !== '') throw Error('Unexpected final run path');
  const authorization = readFileSync(original('AUTHORIZATION.json'));
  const profile = JSON.parse(authorization);
  if (profile.mode !== 'real' || profile.model !== model || profile.scenario !== scenario || profile.maxRequests !== limit ||
      profile.campaign !== finalCampaign || profile.captureSyntheticInput !== true || profile.haltOnUnknown !== true ||
      profile.accountScope !== 'new local synthetic account only') throw Error('Final campaign authorization differs');
  const priorClaims = readdirSync(directory).filter(name => /^final-resume-\d{3}\.json$/u.test(name)).sort();
  if (priorClaims.length >= 99 || priorClaims.some((name, index) => name !== `final-resume-${String(index + 1).padStart(3, '0')}.json`))
    throw Error('Final resume claims are not consecutive');
  const precedingSummary = priorClaims.length ? `summary-resume-${String(priorClaims.length).padStart(3, '0')}.json` : 'summary.json';
  const summaryBytes = readFileSync(original(precedingSummary));
  const summary = JSON.parse(summaryBytes);
  const closed = Number.isInteger(summary.serverExit?.code) || typeof summary.serverExit?.signal === 'string' && summary.serverExit.signal.length > 0;
  if (!closed || summary.finalAcceptance !== true || summary.mode !== 'production' || summary.syntheticData !== true ||
      summary.budget !== limit || (priorClaims.length && summary.resumeAttempt !== priorClaims.length))
    throw Error('Final predecessor has no closed local server receipt');
  const network = new Database(original('network-ledger.sqlite'), { readonly:true, fileMustExist:true });
  const business = new Database(original('data/date-companion.sqlite'), { readonly:true, fileMustExist:true });
  let receipt;
  try {
    const state = network.prepare('SELECT * FROM guard_state WHERE id=1').get();
    const rows = network.prepare('SELECT * FROM requests ORDER BY id').all();
    const transport = summary.transport;
    if (state?.halted !== 0 || state.authorization_sha256 !== sha256(authorization) || state.max_requests !== limit || state.model !== model ||
        !rows.length || rows.length >= limit || rows.some((row,index) => row.id !== index + 1 || row.state !== 'completed' || row.model !== model) ||
        transport?.sent !== rows.length || transport.completed !== rows.length || transport.unknown !== 0 || transport.active !== 0 || transport.halted !== false)
      throw Error('Final requests unresolved, exhausted, or inconsistent');
    const calls = business.prepare('SELECT c.id,c.status,c.model,c.kind,c.diagnostics_json,t.scenario FROM agent_calls c LEFT JOIN agent_tasks t ON t.id=c.task_id ORDER BY c.id').all();
    const byId = new Map(calls.map(call => [call.id,call]));
    const acceptedActionFailures = [];
    if (calls.length !== rows.length || !rows.every(row => {
      const call = byId.get(row.request_id);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(row.request_id) || !call || call.model !== model || call.kind !== 'agent_decision' || call.scenario !== scenario) return false;
      if (call.status === 'succeeded') return true;
      if (call.status !== 'failed' || !call.diagnostics_json) return false;
      let d;
      try { d = JSON.parse(call.diagnostics_json); } catch { return false; }
      const completedActionFailure = d?.response?.responseStatus === 'completed' && d.response.stream?.completionReceived === true &&
        (d.layer === 'action_schema' && d.reasonCode === 'action_schema_invalid' && d.response.parseResult === 'success' && d.response.validationResult === 'failed' ||
         d.layer === 'action_json' && d.reasonCode === 'action_json_invalid' && d.response.parseResult === 'failed' && d.response.validationResult === 'not_started');
      if (completedActionFailure) acceptedActionFailures.push({ requestId:call.id, layer:d.layer, reasonCode:d.reasonCode });
      return completedActionFailure;
    })) throw Error('Final network and business receipts differ');
    // A resumed attempt must preserve the exact rows that were already accounted.
    for (const name of priorClaims) {
      const claim = JSON.parse(readFileSync(original(name),'utf8'));
      if (claim.authorizationSha256 !== sha256(authorization) || !Number.isSafeInteger(claim.priorRequests) || claim.priorRequests < 1 || claim.priorRequests > rows.length ||
          claim.networkRowsSha256 !== sha256(JSON.stringify(rows.slice(0,claim.priorRequests)))) throw Error('Final inherited ledger proof differs');
    }
    receipt = { campaign:finalCampaign, recordedAt:new Date().toISOString(), resumeAttempt:priorClaims.length + 1,
      priorRequests:rows.length, maxRequests:limit, remaining:limit - rows.length, acceptedActionFailures,
      authorizationSha256:sha256(authorization), precedingSummary, precedingSummarySha256:sha256(summaryBytes),
      networkRowsSha256:sha256(JSON.stringify(rows)), sharedRowsSha256:sha256(JSON.stringify(calls)) };
  } finally { business.close(); network.close(); }
  const suffix = `resume-${String(receipt.resumeAttempt).padStart(3, '0')}`;
  writeFileSync(join(directory, `final-${suffix}.json`), JSON.stringify(receipt,null,2), { flag:'wx' });
  return { ...receipt, suffix };
}

async function main() {

const root=process.cwd(), run=process.argv[2];
const finalAcceptance=process.env.DATE_AGENT_FINAL_REAL==='1';
const arg=process.argv[3], feedbackOnly=Boolean(arg?.startsWith('--feedback-from='));
const resumeFinal=arg==='--resume-final';
const from=feedbackOnly?arg.slice('--feedback-from='.length):(arg?.startsWith('--continue-from=') ? arg.slice('--continue-from='.length) : null);
if(!validRunName(run) || (arg && !resumeFinal && !validRunName(from)) || (resumeFinal && !finalAcceptance) || process.argv.length>4 || process.env.DATE_AGENT_REAL_AUTHORIZED!=='1')
  throw Error('Explicit acceptance run name and real authorization required');
const artifacts=resolve(root,finalAcceptance?'output/date-companion-agent-final-real':'output/date-companion-agent-real',run), data=join(artifacts,'data');
const config={...parseEnv(readFileSync(process.env.DATE_AGENT_LOCAL_CONFIG??'.env.local','utf8')),...process.env};
const endpoint=new URL(config.OPENAI_BASE_URL);
if(!config.OPENAI_API_KEY?.trim() || endpoint.hostname!=='tokenhub.vision-intelligence.tech' || endpoint.username || endpoint.password ||
   endpoint.port || endpoint.search || endpoint.hash || !['/','/v1','/v1/'].includes(endpoint.pathname) || !['https:','http:'].includes(endpoint.protocol))
  throw Error('Date product configuration unavailable');
const dist=process.env.DAILY_BRIEF_E2E_DIST_DIR?.trim() || '.next';
const buildPath=resolve(root,dist,'BUILD_ID'), rel=relative(root,realpathSync(buildPath));
if(isAbsolute(rel)||rel.startsWith('..'))throw Error('Expected local build output');
const build=readFileSync(buildPath,'utf8').trim(), builtAt=statSync(buildPath).mtimeMs;
const newer=readdirSync('src',{recursive:true,withFileTypes:true}).filter(f=>f.isFile()&&!f.name.includes('.test.')&&statSync(join(f.parentPath,f.name)).mtimeMs>builtAt);
if(newer.length)throw Error('Production source modified since the selected build');
if(existsSync(artifacts) && !resumeFinal)throw Error('Run directory exists; do not recreate a budget or replay an unknown call');
const resume=resumeFinal?claimFinalResume(root,run):null;
const baselineSent=resume?.priorRequests??initializeBudget(dirname(artifacts),run,from,feedbackOnly,finalAcceptance);
const attemptName=name=>resume?name.replace(/(\.[^.]+)$/u,`-${resume.suffix}$1`):name;
const auth=JSON.parse(readFileSync(join(artifacts,'AUTHORIZATION.json'),'utf8'));
const save=(name,v)=>writeFileSync(join(artifacts,name),JSON.stringify(v,null,2));
const port=await new Promise((done,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>done(p));});});
const baseURL='http://127.0.0.1:'+port;
const common={...process.env,NEXT_TELEMETRY_DISABLED:'1',APP_DATA_DIR:data,DATA_DIR:data,APP_STORAGE_MODE:'local',
  PIPELINE_EXECUTION_MODE:'inline',REDIS_URL:'',DAILY_BRIEF_INVITE_CODES:'date-agent-fixture',
  DATE_AGENT_ARTIFACTS:artifacts,DATE_AGENT_BASE_URL:baseURL,DATE_AGENT_REAL:'1',DATE_AGENT_REAL_FEEDBACK_ONLY:feedbackOnly?'1':'0',DATE_AGENT_FINAL_RESUME:resumeFinal?'1':'0',DATE_AGENT_FINAL_RECOVERY:resumeFinal?'1':'0',
  QA_HYBRID_RETRIEVAL_MODE:'off',WORK_REVIEW_ENABLED:'false',LEARNING_ENABLED:'false',
  TRANSCRIPTION_PROVIDER:'none',TRANSCRIPTION_FALLBACK_PROVIDER:'none',AUDIO_INSIGHT_PROVIDER:'rule',
  MEMORY_RELEVANCE_PROVIDER:'none',EXTRACTION_PROVIDER:'rule',RELATIONSHIP_SIGNAL_PROVIDER:'none',
  EMOTION_SIGNAL_PROVIDER:'none',PROACTIVE_INSIGHT_PROVIDER:'none',DATE_COMPANION_MEMORY_BRIDGE_ENABLED:'false',
  DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED:'false',LANGCHAIN_TRACING:'false',LANGSMITH_TRACING:'false'};
for(const k of Object.keys(common))if(/API_KEY|ACCESS_TOKEN|SECRET|REDIS_URL|_PROXY$|OPENAI_|NODE_OPTIONS|THINKING_/.test(k))delete common[k];
const serverEnv={...common,REDIS_URL:'',OPENAI_API_KEY:config.OPENAI_API_KEY,OPENAI_BASE_URL:config.OPENAI_BASE_URL,
  OPENAI_AUTH_HEADER_MODE:config.OPENAI_AUTH_HEADER_MODE??'bearer',THINKING_P1_REAL_DIR:artifacts,
  ...(finalAcceptance?{THINKING_REAL_CAPTURE_SYNTHETIC_INPUT:'1'}:{}),
  NODE_OPTIONS:'--require="'+resolve('scripts/reflection-thinking-real-network-guard.cjs').replaceAll('\\','/')+'"'};
function launch(args,env,log){
  const child=spawn(process.execPath,args,{env,cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const capture=chunk=>appendFileSync(join(artifacts,log),chunk.toString().replaceAll(config.OPENAI_API_KEY,'[redacted]'));
  child.stdout.on('data',capture);child.stderr.on('data',capture);return child;
}
const server=launch(['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',String(port)],serverEnv,attemptName('server.log'));
const wait=child=>new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});
const serverExit=wait(server);let browser, browserExit, lastProgress='';
const monitor=setInterval(()=>{
  const state=join(artifacts,'state.json');
  if(!existsSync(state))return;
  const s=JSON.parse(readFileSync(state,'utf8')), key=[s.sent,s.completed,s.unknown,s.halted].join('/');
  if(key!==lastProgress){lastProgress=key;console.log(`Budget ${s.sent}/12, completed=${s.completed}, unknown=${s.unknown}, halted=${s.halted}`);}
},1000);
const stop=()=>{if(browser && browser.exitCode===null)browser.kill();if(server.exitCode===null)server.kill();};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
const summary={build,dist,port,pid:server.pid,budget:limit,priorRun:from,priorRequests:baselineSent,batchAllowance:limit-baselineSent,feedbackOnly,finalAcceptance,resumeAttempt:resume?.resumeAttempt??null,mode:'production',syntheticData:true};
try{
  let ready=false;
  for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error('Local server exited');try{if((await fetch(baseURL)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
  if(!ready)throw Error('Local server not ready');
  const proof=JSON.parse(readFileSync(join(artifacts,'guard-ready-'+server.pid+'.json'),'utf8'));
  if(proof.maxRequests!==12 || proof.pid!==server.pid || proof.model!==auth.model || proof.authorizationSha256!==createHash('sha256').update(readFileSync(join(artifacts,'AUTHORIZATION.json'))).digest('hex'))throw Error('Budget guard not bound');
  const startState=JSON.parse(readFileSync(join(artifacts,'state.json'),'utf8'));
  if(startState.sent!==baselineSent || startState.completed!==baselineSent || startState.active!==0 || startState.unknown!==0 || startState.halted!==false)throw Error('Guard did not inherit the verified budget');
  console.log(`${baselineSent}/${limit} requests already accounted, ${limit-baselineSent} remaining. Evidence: ${artifacts}`);
  browser=launch(['node_modules/@playwright/test/cli.js','test','e2e/date-companion-agent-real.spec.ts',...(finalAcceptance?['--grep',resumeFinal?(process.env.DATE_AGENT_FINAL_ATTRIBUTION==='1'?'@final-attribution':'@final-recovery'):'@final$']:feedbackOnly?['--grep','@independent-feedback']:['--grep-invert','@independent-feedback|@final']),'--workers=1','--retries=0','--reporter=line','--output='+join(artifacts,resume?`playwright-${resume.suffix}`:'playwright')],common,attemptName('browser.log'));
  browserExit=await wait(browser);summary.browserExit=browserExit.code;process.exitCode=browserExit.code??1;
}catch(error){summary.error=error.message;process.exitCode=1;}
finally{clearInterval(monitor);stop();summary.serverExit=await serverExit;const state=join(artifacts,'state.json');if(existsSync(state))summary.transport=JSON.parse(readFileSync(state,'utf8'));save(attemptName('summary.json'),summary);console.log(JSON.stringify(summary));}
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) await main();
