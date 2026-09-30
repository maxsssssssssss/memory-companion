import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readOcrRuntimeSelection,startOcr,stopOcr} from './ocr.mjs';

function fixture(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'learning-ocr-config-'));
  try{
    const manifest={version:'learning-ocr-resource-v1',plan_changes:{budgets:{starts:null,pages:null,http:null},session_seconds:28800}};
    const raw=JSON.stringify(manifest),sha=createHash('sha256').update(raw).digest('hex');
    const cfg={version:manifest.version,remote:'/data/lyc/paddleocr-vllm-trial-20260921-111817/core-learning-runtime-synthetic',
      policyManifest:'manifest.json',policyManifestSha256:sha,integrityRevision:'synthetic-reviewed-v1'};
    fs.writeFileSync(path.join(root,'manifest.json'),raw);
    const file=path.join(root,'runtime.json');fs.writeFileSync(file,JSON.stringify(cfg));fn({root,cfg,file});
  }finally{assert(root.startsWith(path.join(os.tmpdir(),'learning-ocr-config-')));fs.rmSync(root,{recursive:true});}
}
test('legacy selection remains explicit and cannot silently clear old quotas',()=>{
  assert.equal(readOcrRuntimeSelection(null).mode,'legacy-trial');
  assert(readOcrRuntimeSelection(null).remote.endsWith('core-local-study-20260929-retry1'));
});
test('new runtime selection uses reviewed manifest identity and retained counter-only budget',()=>fixture(({file})=>{
  const result=readOcrRuntimeSelection(file);
  assert.equal(result.mode,'learning-runtime');assert.deepEqual(result.plan.budgets,{starts:null,pages:null,http:null});
  assert.equal(result.plan.session_seconds,28800);
}));
test('changed policy bytes, unknown revision and path injection fail locally before SSH',()=>fixture(({root,cfg,file})=>{
  fs.writeFileSync(file,JSON.stringify({...cfg,remote:cfg.remote+"'; touch bad"}));
  assert.throws(()=>readOcrRuntimeSelection(file),/Invalid OCR runtime/);
  fs.writeFileSync(file,JSON.stringify({...cfg,integrityRevision:''}));
  assert.throws(()=>readOcrRuntimeSelection(file),/integrity revision/);
  fs.writeFileSync(file,JSON.stringify(cfg));fs.appendFileSync(path.join(root,'manifest.json'),' ');
  assert.throws(()=>readOcrRuntimeSelection(file),/policy changed/);
}));


test('reviewed finite budgets are configurable without changing legacy ledgers',()=>fixture(({root,cfg,file})=>{
  for(const pages of [300,0,-1,1.5,"300"]){
    const manifest={version:cfg.version,plan_changes:{budgets:{starts:4,pages,http:5000},session_seconds:28800}};
    const raw=JSON.stringify(manifest);fs.writeFileSync(path.join(root,'manifest.json'),raw);
    fs.writeFileSync(file,JSON.stringify({...cfg,policyManifestSha256:createHash('sha256').update(raw).digest('hex')}));
    if(pages===300)assert.deepEqual(readOcrRuntimeSelection(file).plan.budgets,{starts:4,pages:300,http:5000});
    else assert.throws(()=>readOcrRuntimeSelection(file),/Invalid runtime budget/);
  }
}));

test('null lifetime stays continuous and invalid lifetime fails before any transport',()=>fixture(({root,cfg,file})=>{
  for(const duration of [null,3600,0,-1,'continuous']){
    const manifest={version:cfg.version,plan_changes:{budgets:{starts:null,pages:null,http:null},session_seconds:duration}};
    const raw=JSON.stringify(manifest);fs.writeFileSync(path.join(root,'manifest.json'),raw);
    fs.writeFileSync(file,JSON.stringify({...cfg,policyManifestSha256:createHash('sha256').update(raw).digest('hex')}));
    if(duration===null||duration===3600)assert.equal(readOcrRuntimeSelection(file).plan.session_seconds,duration);
    else assert.throws(()=>readOcrRuntimeSelection(file),/session lifetime/);
  }
}));
function mockRuntime({existing=false,finite=false,ready=true,tunnelReady=true,exhausted=false}={}){
  const remote='/data/lyc/paddleocr-vllm-trial-20260921-111817/core-learning-runtime-synthetic';
  const selection={mode:'learning-runtime',remote,policyManifestSha256:'a'.repeat(64),integrityRevision:'synthetic-v1',
    plan:{budgets:{starts:null,pages:null,http:null},session_seconds:finite?3600:null}};
  const identity=()=>({pid:456,born:1000.5,instance:'session-3',out:remote+'/outputs/session-3',mode:'pdf'});
  const epoch=createHash('sha256').update(remote+'\0'+remote+'/outputs/session-3').digest('hex');
  const state={active:existing?identity():null,starts:0,stops:0,resources:0,launches:0,clock:0,records:[],stopPrograms:[]};
  const health=()=>({ready,instance:'session-3',service_epoch:epoch,resource_policy_version:'learning-ocr-resource-v1'});
  const deps={preflight:()=>({hand:{lifecycle:{python:'/synthetic/python'}},selection,verifiedFiles:71}),now:()=>state.clock,
    sleep:async ms=>{state.clock+=ms;},fetch:async()=>Response.json({...health(),ready:tunnelReady}),
    ssh:(command,input)=>{
      if(input?.includes('revision=common.verify()'))return JSON.stringify({budgetExhausted:exhausted?['starts']:[],startupRequiredMiB:16384,attempts:99,used:{pages:100,http:200}});
      if(input?.includes('live=False'))return JSON.stringify(state.active);
      if(input?.includes('query-gpu=memory.free')){state.resources++;return JSON.stringify({freeMiB:22000});}
      if(command.includes('/scripts/start.py')){state.starts++;state.active=identity();return JSON.stringify({supervisor_pid:456,session:3,mode:'pdf'});}
      if(command.includes('/scripts/health.py'))return JSON.stringify(health());
      if(command.includes('/private/api-key'))return 'SYNTHETIC_ONLY_NOT_A_REAL_SECRET_000';
      if(input?.includes('requested_normal_stop')){
        state.stopPrograms.push(input);const b=JSON.parse(Buffer.from(input.match(/base64.b64decode\('([^']+)'\)/)[1],'base64'));
        assert.equal(state.active.pid,b.pid,'OCR ownership changed');assert.equal(state.active.born,b.born,'OCR ownership changed');assert.equal(state.active.instance,b.instance);
        state.stops++;return JSON.stringify({stopped:true,cleanup_verified:true,instance:b.instance});
      }
      throw Error('Unexpected simulated command');
    }};
  const args={record:(name,value)=>state.records.push([name,value]),launch:()=>{state.launches++;return {exitCode:null};}};
  return {state,deps,args,selection};
}
test('continuous start attaches a healthy reviewed instance without startup GPU checks or another budget consumption',async()=>{
  const mock=mockRuntime({existing:true,exhausted:true}),result=await startOcr(mock.args,mock.deps);
  assert.equal(result.attached,true);assert.equal(result.persistent,true);assert.equal(result.sessionSeconds,null);
  assert.equal(mock.state.starts,0);assert.equal(mock.state.resources,0);assert.equal(mock.state.launches,1);
  assert.equal(result.binding.pid,456);assert.equal(result.binding.born,1000.5);
  assert(!JSON.stringify(mock.state.records).includes('SYNTHETIC_ONLY_NOT_A_REAL_SECRET'));
});
test('new continuous startup retains null lifetime and an explicit stop uses its exact process birth and epoch',async()=>{
  const mock=mockRuntime(),result=await startOcr(mock.args,mock.deps);
  assert.equal(mock.state.starts,1);assert.equal(mock.state.resources,1);assert.equal(result.attached,false);assert.equal(result.sessionSeconds,null);
  result.stop();assert.equal(mock.state.stops,1);
  const stop=mock.state.stopPrograms[0];assert(stop.includes("p.create_time()==b['born']"));assert(stop.includes("==b['epoch']"));
  assert(stop.includes("out/'stop-request.json'"));assert(!stop.includes('scripts/stop.py'));
});
test('finite reviewed trials remain finite and a new startup failure before readiness cleans only its bound instance',async()=>{
  const finite=mockRuntime({finite:true}),result=await startOcr(finite.args,finite.deps);
  assert.equal(result.sessionSeconds,3600);assert.equal(result.persistent,false);
  const pending=mockRuntime({ready:false});await assert.rejects(startOcr(pending.args,pending.deps),/readiness timeout/);
  assert.equal(pending.state.starts,1);assert.equal(pending.state.stops,1);
});
test('a ready persistent service survives a failed local tunnel without an engine restart or remote stop',async()=>{
  for(const existing of [false,true]){
    const mock=mockRuntime({existing,tunnelReady:false});await assert.rejects(startOcr(mock.args,mock.deps),/SSH health not ready/);
    assert.equal(mock.state.starts,existing?0:1);assert.equal(mock.state.stops,0);
    assert(mock.state.records.some(([name])=>name==='ocr-binding.json'));
    assert(mock.state.records.some(([name])=>name==='ocr-preserved.json'));
  }
});
test('unready existing instances and changed ownership fail without stopping or replacing another service',async()=>{
  const unready=mockRuntime({existing:true,ready:false});await assert.rejects(startOcr(unready.args,unready.deps),/Existing OCR instance/);
  assert.equal(unready.state.starts,0);assert.equal(unready.state.stops,0);
  const mock=mockRuntime({existing:true}),result=await startOcr(mock.args,mock.deps);mock.state.active.born++;
  assert.throws(()=>result.stop(),/ownership changed/);assert.equal(mock.state.stops,0);
  assert.throws(()=>stopOcr({record:mock.args.record,binding:{...result.binding,epoch:'f'.repeat(64)}},mock.deps),/epoch changed/);
  assert.throws(()=>stopOcr({record:mock.args.record,binding:{...result.binding,remote:result.remote+'-other'}},mock.deps),/selection changed/);
});
