// Explicitly invoked, isolated A0/A1 experience. No Provider calls on startup.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { cloudEnvironment, assertCleanConfig } from '../cloud/environment.mjs';
import { assertEvidenceDirectory } from './evidence-directory.cjs';
const real=process.argv.includes('--real');
const repo=process.cwd(),root=path.resolve(process.env.AGENT_TRIAL_DIR||(real?'output/agent-a0-a1-windows':'output/agent-a0-a1-offline'));
const base='http://127.0.0.1:37951',runtimeFile=path.join(root,'runtime.json'),stopFile=path.join(root,'stop');
const mode=process.argv[2];
if(mode==='start')assertEvidenceDirectory(root,real?'real':'offline');
fs.mkdirSync(root,{recursive:true});
if(mode==='stop'){fs.writeFileSync(stopFile,'stop');console.log('Stop requested; synthetic course/task data retained.');}
else if(mode==='status'){console.log(fs.existsSync(runtimeFile)?fs.readFileSync(runtimeFile,'utf8'):'not started');}
else if(mode==='start'){
  assertCleanConfig(repo);
  if(real && !process.env.DAILY_BRIEF_OPENAI_API_KEY)throw Error('Configured trial credential missing');
  await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(37951,'127.0.0.1',()=>s.close(resolve));});
  const env=cloudEnvironment(repo,process.env,false);
  if(real)for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR'])
    if(process.env[name])env[name]=process.env[name];
  Object.assign(env,{APP_DATA_DIR:path.join(root,'data'),DATA_DIR:path.join(root,'data'),APP_STORAGE_MODE:'local',PIPELINE_EXECUTION_MODE:'inline',
    DAILY_BRIEF_INVITE_CODES:'agent-synthetic-only',NODE_USE_ENV_PROXY:'1',NEXT_TELEMETRY_DISABLED:'1',
    NODE_OPTIONS:(real?`--require=${JSON.stringify(path.join(repo,'scripts/agent-trial/guard.cjs'))}`:
      `--require=${JSON.stringify(path.join(repo,'scripts/cloud/offline.cjs'))} --require=${JSON.stringify(path.join(repo,'scripts/agent-trial/offline-provider.cjs'))}`)+' --max-old-space-size=4096',
    AGENT_TRIAL_DIR:root,AGENT_TRIAL_PHASE:'trajectory',AGENT_TRIAL_MODE:real?'real':'offline',OPENAI_BASE_URL:'https://tokenhub.vision-intelligence.tech/v1',
    OPENAI_API_KEY:real?process.env.DAILY_BRIEF_OPENAI_API_KEY:'offline-fixture',LEARNING_AGENT_API_KEY:real?process.env.DAILY_BRIEF_OPENAI_API_KEY:'offline-fixture',
    LANGSMITH_TRACING:'false',LANGSMITH_TRACING_V2:'false',LANGCHAIN_TRACING:'false',LANGCHAIN_TRACING_V2:'false'});
  for(const prefix of ['LEARNING_AGENT_DECISION','LEARNING_AGENT_GENERATION'])Object.assign(env,{
    [`${prefix}_PROVIDER`]:'tokenhub',[`${prefix}_MODEL`]:'deepseek-v4-pro',[`${prefix}_MAX_INPUT_CHARS`]:'47000',
    [`${prefix}_MAX_OUTPUT_TOKENS`]:prefix.endsWith('DECISION')?'2000':'8000',[`${prefix}_REQUEST_TIMEOUT_MS`]:'120000'});
  const command=process.argv.includes('--production')?'start':'dev';
  const log=fs.openSync(path.join(root,`app-${Date.now()}.log`),'a');
  if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next',command,'--hostname','127.0.0.1','-p','37951'],
    {cwd:repo,env,stdio:['ignore',log,log]});
  const state={base,dataRoot:env.APP_DATA_DIR,evidenceMode:real?'real':'offline',inviteCode:'agent-synthetic-only',pid:process.pid,childPid:child.pid,mode:command,startedAt:new Date().toISOString()};
  fs.writeFileSync(runtimeFile,JSON.stringify(state,null,2));
  const stop=()=>{if(child.exitCode===null)child.kill('SIGTERM');};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const poll=setInterval(()=>{if(fs.existsSync(stopFile))stop();},500);
  child.on('exit',(code)=>{clearInterval(poll);fs.closeSync(log);fs.writeFileSync(runtimeFile,JSON.stringify({...state,stoppedAt:new Date().toISOString(),exitCode:code},null,2));process.exitCode=code??0;});
  console.log(`Isolated synthetic experience starting: ${base}; ${real?'explicit Windows real mode, persistent 36-request ledger':'OFFLINE controlled Provider, external networking blocked'}.`);
}else throw Error('Use start [--production] [--real for authorized Windows acceptance only], stop [--real], or status [--real]');
