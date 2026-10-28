// Explicitly invoked, isolated Agent acceptance. No Provider calls on startup.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnOwned, stopOwned } from '../lib/owned-process.mjs';
import { cloudEnvironment, assertCleanConfig } from '../cloud/environment.mjs';
import { assertEvidenceDirectory } from './evidence-directory.cjs';
import { credentialSelection, trialCredentialEnvironment } from './credential-adapter.mjs';
import { realTrialBudget } from './request-budget.cjs';
const real=process.argv.includes('--real');
const repo=process.cwd(),root=path.resolve(process.env.AGENT_TRIAL_DIR||(real?'output/agent-a2-windows':'output/agent-a2-offline'));
const base='http://127.0.0.1:37951',runtimeFile=path.join(root,'runtime.json'),stopFile=path.join(root,'stop');
const mode=process.argv[2];
if(!['start','stop','status'].includes(mode))throw Error('Use start [--production] [--real --credential-env OPENAI_API_KEY for authorized Windows acceptance only], stop [--real], or status [--real]');
if(mode==='start'||mode==='stop')assertEvidenceDirectory(root,real?'real':'offline');
const requestBudget=mode==='start'&&real?realTrialBudget(process.env):null;
if(mode==='stop'){
  if(!fs.existsSync(runtimeFile))console.log('No recorded trial process; nothing stopped and no directory created.');
  else {
    const state=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));
    if(state.stoppedAt)console.log('Recorded trial already stopped; synthetic course/task data retained.');
    else {fs.writeFileSync(stopFile,'stop');console.log('Stop requested from the owning launcher; synthetic course/task data retained.');}
  }
}
else if(mode==='status'){
  if(!fs.existsSync(runtimeFile))console.log('not started');
  else {
    const state=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));
    const keys=['base','dataRoot','evidenceMode','pid','childPid','mode','startedAt','stoppedAt','exitCode','signal','error'];
    console.log(JSON.stringify(Object.fromEntries(keys.filter(key=>state[key]!==undefined).map(key=>[key,state[key]])),null,2));
  }
}
else if(mode==='start'){
  assertCleanConfig(repo);
  const credentials=trialCredentialEnvironment(process.env,{real,credentialEnv:credentialSelection(process.argv)});
  await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(37951,'127.0.0.1',()=>s.close(resolve));});
  const env=cloudEnvironment(repo,process.env,false);
  // Manual Learning regression is also offline. This never changes a real
  // user's manual-generation defaults or enables a second remote Provider.
  if(!real)Object.assign(env,{LEARNING_AI_PROVIDER:'tokenhub',LEARNING_AI_MODEL:'deepseek-v4-pro',
    LEARNING_AI_MAX_INPUT_CHARS:'47000',LEARNING_AI_MAX_OUTPUT_TOKENS:'8000'});
  if(real)for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR'])
    if(process.env[name])env[name]=process.env[name];
  Object.assign(env,{APP_DATA_DIR:path.join(root,'data'),DATA_DIR:path.join(root,'data'),APP_STORAGE_MODE:'local',PIPELINE_EXECUTION_MODE:'inline',
    DAILY_BRIEF_INVITE_CODES:'agent-synthetic-only',NODE_USE_ENV_PROXY:'1',NEXT_TELEMETRY_DISABLED:'1',
    NODE_OPTIONS:(real?`--require=${JSON.stringify(path.join(repo,'scripts/agent-trial/guard.cjs'))}`:
      `--require=${JSON.stringify(path.join(repo,'scripts/cloud/offline.cjs'))} --require=${JSON.stringify(path.join(repo,'scripts/agent-trial/offline-provider.cjs'))}`)+' --max-old-space-size=4096',
    AGENT_TRIAL_DIR:root,AGENT_TRIAL_PHASE:'trajectory',AGENT_TRIAL_MODE:real?'real':'offline',OPENAI_BASE_URL:'https://tokenhub.vision-intelligence.tech/v1',
    ...credentials,
    ...(requestBudget?{AGENT_TRIAL_MAX_REQUESTS:String(requestBudget.total),AGENT_TRIAL_PROTOCOL_MAX_REQUESTS:String(requestBudget.protocol)}:{}),
    LANGSMITH_TRACING:'false',LANGSMITH_TRACING_V2:'false',LANGCHAIN_TRACING:'false',LANGCHAIN_TRACING_V2:'false'});
  for(const prefix of ['LEARNING_AGENT_DECISION','LEARNING_AGENT_GENERATION'])Object.assign(env,{
    [`${prefix}_PROVIDER`]:'tokenhub',[`${prefix}_MODEL`]:'deepseek-v4-pro',
    [`${prefix}_MAX_INPUT_CHARS`]:prefix.endsWith('DECISION')?(process.env.LEARNING_AGENT_DECISION_MAX_INPUT_CHARS??'200000'):'47000',
    [`${prefix}_MAX_OUTPUT_TOKENS`]:prefix.endsWith('DECISION')?'2000':'8000',[`${prefix}_REQUEST_TIMEOUT_MS`]:'120000'});
  const command=process.argv.includes('--production')?'start':'dev';
  fs.mkdirSync(root,{recursive:true});
  const log=fs.openSync(path.join(root,`app-${Date.now()}.log`),'a');
  if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
  const child=spawnOwned(process.execPath,['node_modules/next/dist/bin/next',command,'--hostname','127.0.0.1','-p','37951'],
    {cwd:repo,env,stdio:['ignore',log,log]});
  const state={base,dataRoot:env.APP_DATA_DIR,evidenceMode:real?'real':'offline',inviteCode:'agent-synthetic-only',pid:process.pid,childPid:child.pid,mode:command,startedAt:new Date().toISOString()};
  fs.writeFileSync(runtimeFile,JSON.stringify(state,null,2));
  let stopping;
  const stop=()=>{stopping??=stopOwned(child).catch(()=>{console.error('Owned trial process cleanup failed; inspect this launcher and local port.');process.exitCode=1;});return stopping;};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const poll=setInterval(()=>{if(fs.existsSync(stopFile))stop();},500);
  child.on('error',()=>{clearInterval(poll);fs.closeSync(log);fs.writeFileSync(runtimeFile,JSON.stringify({...state,stoppedAt:new Date().toISOString(),exitCode:1,error:'trial_child_start_failed'},null,2));process.exitCode=1;});
  child.on('exit',(code,signal)=>{clearInterval(poll);fs.closeSync(log);fs.writeFileSync(runtimeFile,JSON.stringify({...state,stoppedAt:new Date().toISOString(),exitCode:code,signal},null,2));process.exitCode=code??0;});
  console.log(`Isolated synthetic experience starting: ${base}; ${real?`explicit Windows real mode, newly authorized ${requestBudget.total}-request ledger`:'OFFLINE controlled Provider, external networking blocked'}.`);
}
