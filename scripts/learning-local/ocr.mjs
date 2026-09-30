import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const handRoot='C:/Codex/learning-ocr-handoff/20260921-171314';
// Retained until a reviewed runtime has actually been installed and selected.
const legacyRemote='/data/lyc/paddleocr-vllm-trial-20260921-111817/core-local-study-20260929-retry1';
const alias='ubuntu-dev-lyc';
const digest=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function readOcrRuntimeSelection(configPath=process.env.LEARNING_LOCAL_OCR_RUNTIME_CONFIG) {
  if(!configPath)return {mode:'legacy-trial',remote:legacyRemote};
  const cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
  assert.equal(cfg.version,'learning-ocr-resource-v1','Unsupported OCR runtime selection');
  assert(/^\/data\/lyc\/paddleocr-vllm-trial-20260921-111817\/core-learning-runtime-[a-z0-9-]+$/.test(cfg.remote),'Invalid OCR runtime directory');
  assert(/^[a-f0-9]{64}$/.test(cfg.policyManifestSha256),'Missing reviewed patch identity');
  assert(typeof cfg.integrityRevision==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(cfg.integrityRevision),'Missing installed integrity revision');
  const manifestPath=path.resolve(path.dirname(path.resolve(configPath)),cfg.policyManifest);
  const bytes=fs.readFileSync(manifestPath);
  assert.equal(digest(bytes),cfg.policyManifestSha256,'Reviewed OCR policy changed');
  const manifest=JSON.parse(bytes);
  assert.equal(manifest.version,cfg.version);
  const caps=manifest.plan_changes.budgets;
  assert.deepEqual(Object.keys(caps).sort(),['http','pages','starts'],'Invalid runtime budget keys');
  for(const cap of Object.values(caps))assert(cap===null||(Number.isSafeInteger(cap)&&cap>0),'Invalid runtime budget');
  assert(manifest.plan_changes.session_seconds===null||(Number.isSafeInteger(manifest.plan_changes.session_seconds)&&manifest.plan_changes.session_seconds>0),'Invalid OCR session lifetime');
  return {mode:'learning-runtime',remote:cfg.remote,policyManifestSha256:cfg.policyManifestSha256,
    integrityRevision:cfg.integrityRevision,plan:manifest.plan_changes};
}
export function localOcrPreflight(configPath) {
  const service=fs.readFileSync(handRoot+'/service-handoff.json');
  assert.equal(digest(service),'5b9bc6eccde6b3c595c7b3269635422252159186c28364abae251b7142261453','handoff identity changed');
  const manifest=JSON.parse(fs.readFileSync(handRoot+'/file-manifest.json','utf8'));
  for(const entry of manifest.files) {
    const target=path.resolve(handRoot,entry.path);assert(target.startsWith(path.resolve(handRoot)+path.sep));
    const bytes=fs.readFileSync(target);assert.equal(bytes.length,entry.bytes,entry.path+' bytes');assert.equal(digest(bytes),entry.sha256,entry.path+' hash');
  }
  const hand=JSON.parse(service);assert.equal(hand.entrypoint.parse_path,'/parse-pdf');assert.equal(hand.entrypoint.base_url,'http://127.0.0.1:46238');
  const sample=JSON.parse(fs.readFileSync(handRoot+'/examples/success/response.json','utf8'));assert(sample.document&&sample.pages.length);
  assert(fs.existsSync(path.join(process.env.USERPROFILE,'.ssh/config')),'SSH config absent');
  return {hand,selection:readOcrRuntimeSelection(configPath),verifiedFiles:manifest.files.length+1,manifestSha256:digest(fs.readFileSync(handRoot+'/file-manifest.json'))};
}
const ssh=(command,input,allowPending=false)=>{
  const r=spawnSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=12',alias,command],{input,encoding:'utf8',windowsHide:true,timeout:65000,maxBuffer:2*1024*1024});
  if(r.error||(r.status!==0&&!(allowPending&&r.status===3)))throw Error('OCR SSH command failed: '+(r.error?.code??r.status));return r.stdout;
};

function activeSnapshot(py,remote,command) {
  const code=["import pathlib,json,psutil","r=pathlib.Path("+JSON.stringify(remote)+");f=r/'evidence/active-instance.json'",
    "v=json.loads(f.read_text()) if f.exists() else None",'live=False','if v:',
    " try:","  proc=psutil.Process(v['pid']);live=proc.create_time()==v['born'] and proc.status()!=psutil.STATUS_ZOMBIE and str(r/'scripts/trial_session.py') in proc.cmdline()",
    " except psutil.NoSuchProcess:pass","print(json.dumps(v if live else None))"].join('\n');
  return JSON.parse(command(py+' -',code));
}
function identityBinding(selection,active) {
  assert(active&&Number.isSafeInteger(active.pid)&&active.pid>0&&Number.isFinite(active.born)&&active.born>0,'OCR process identity unavailable');
  assert(/^session-[1-9][0-9]*$/.test(active.instance)&&active.mode==='pdf','OCR instance is not the PDF service');
  assert.equal(active.out,selection.remote+'/outputs/'+active.instance,'OCR runtime ownership changed');
  return {remote:selection.remote,pid:active.pid,born:active.born,instance:active.instance,
    epoch:selection.mode==='learning-runtime'?digest(selection.remote+'\0'+active.out):null,
    policyManifestSha256:selection.policyManifestSha256??null,integrityRevision:selection.integrityRevision??null};
}
export function stopOcr({record,binding,configPath},dependencies={}) {
  const {hand,selection}=(dependencies.preflight??localOcrPreflight)(configPath),command=dependencies.ssh??ssh;
  assert.equal(binding.remote,selection.remote,'OCR runtime selection changed; refusing stop');
  assert.equal(binding.policyManifestSha256,selection.policyManifestSha256??null,'OCR reviewed policy changed; refusing stop');
  assert.equal(binding.integrityRevision,selection.integrityRevision??null,'OCR installed revision changed; refusing stop');
  const expected=identityBinding(selection,{pid:binding.pid,born:binding.born,instance:binding.instance,mode:'pdf',out:selection.remote+'/outputs/'+binding.instance});
  assert.equal(binding.epoch,expected.epoch,'OCR epoch changed; refusing stop');
  const spec=Buffer.from(JSON.stringify(binding)).toString('base64');
  // Pin the stop file to the checked session; stop.py would reread active-instance.
  const code=['import pathlib,json,base64,time,psutil',"b=json.loads(base64.b64decode('"+spec+"'));r=pathlib.Path(b['remote']);out=r/'outputs'/b['instance']",
    "a=json.loads((r/'evidence/active-instance.json').read_text())",
    "assert a['pid']==b['pid'] and a['born']==b['born'] and a['instance']==b['instance'] and a['out']==str(out) and a['mode']=='pdf','OCR ownership changed; refusing stop'",
    "if b['epoch'] is not None:"," import hashlib"," assert hashlib.sha256((str(r)+'\\0'+str(out)).encode()).hexdigest()==b['epoch'],'OCR epoch changed; refusing stop'",
    "try:"," p=psutil.Process(b['pid']);assert p.create_time()==b['born'] and str(r/'scripts/trial_session.py') in p.cmdline(),'OCR process identity changed; refusing stop'",
    " if p.status()!=psutil.STATUS_ZOMBIE:","  target=out/'stop-request.json';tmp=out/'stop-request.json.local.new';tmp.write_text(json.dumps({'instance':b['instance'],'reason':'requested_normal_stop'}));tmp.replace(target)",
    "except psutil.NoSuchProcess:pass","for _ in range(150):"," f=out/'summary.json'"," if f.exists():","  summary=json.loads(f.read_text());assert summary['cleanup_verified'],'OCR cleanup not verified';print(json.dumps({'stopped':True,'cleanup_verified':True,'instance':b['instance']}));break"," time.sleep(.2)","else:raise RuntimeError('Stop not verified within30seconds; do not kill by port/name')"].join('\n');
  const result=JSON.parse(command(hand.lifecycle.python+' -',code));record('ocr-stop.json',{result,at:new Date().toISOString()});return result;
}
export async function startOcr({record,launch,configPath},dependencies={}) {
  const preflight=dependencies.preflight??localOcrPreflight,command=dependencies.ssh??ssh,wait=dependencies.sleep??sleep,now=dependencies.now??Date.now,request=dependencies.fetch??fetch;
  const {hand,selection,...local}=preflight(configPath),py=hand.lifecycle.python,remote=selection.remote;
  const persistent=selection.mode==='learning-runtime'&&selection.plan.session_seconds===null;
  record('ocr-preflight.json',{...local,mode:selection.mode,remote});
  const encoded=Buffer.from(JSON.stringify(selection)).toString('base64');
  const inspection=[
    'import sys,pathlib,json,base64,subprocess',
    "spec=json.loads(base64.b64decode('"+encoded+"'))",
    "p=pathlib.Path(spec['remote']);sys.path.insert(0,str(p/'scripts'));import common",
    "revision=common.verify();assert common.R==p,'wrong runtime root'",
    "plan=common.PLAN;budget=json.loads((p/'evidence/budget.json').read_text())",
    "a=p/'evidence/start-attempts.jsonl';n=len(a.read_text().splitlines()) if a.exists() else 0",
    "if spec['mode']=='learning-runtime':",
    " assert revision==spec['integrityRevision'],'installed revision differs'",
    " receipt=json.loads((p/'evidence/runtime-authorization.json').read_text())",
    " assert receipt['patch_manifest_sha256']==spec['policyManifestSha256'],'installed policy differs'",
    " for key,value in spec['plan'].items():assert plan[key]==value,'installed plan differs'",
    " threshold=plan['resource_policy']['startup_free_mib']",
    'else:',
    " assert plan['budgets']=={'starts':1,'pages':30,'http':500},'authorized trial caps changed'",
    " threshold=plan['preflight_free_mib']",
    "exhausted=[]",
    "for kind in ['starts','pages','http']:",
    " used=n if kind=='starts' else budget[kind];cap=plan['budgets'][kind]",
    " assert used>=0,'invalid runtime ledger'",
    " if cap is not None and used>=cap:exhausted.append(kind)",
    "print(json.dumps({'batch':p.name,'attempts':n,'used':budget,'caps':plan['budgets'],'startupRequiredMiB':threshold,'budgetExhausted':exhausted}))"
  ].join('\n');
  const before=JSON.parse(command(py+' -',inspection));record('ocr-budget-before.json',before);
  let active=activeSnapshot(py,remote,command),owned,binding,health,serviceReady=false,started=false;
  if(active){
    assert(persistent,'OCR instance already running; refusing duplicate finite-trial start');
    binding=identityBinding(selection,active);
    health=JSON.parse(command(py+" '"+remote+"/scripts/health.py'",undefined,true));
    assert(health.ready&&health.instance===binding.instance&&health.service_epoch===binding.epoch&&health.resource_policy_version==='learning-ocr-resource-v1','Existing OCR instance is not ready or does not match this reviewed runtime');
    serviceReady=true;record('ocr-attached.json',binding);
  }else{
    assert(Array.isArray(before.budgetExhausted)&&before.budgetExhausted.length===0,
      'OCR 运行预算已用完（'+(before.budgetExhausted??[]).join('/')+'）；原账本保留，尚未启动；请明确选择新的运行预算，不自动清零或重启');
    const resourceCode=["import sys,pathlib,json,subprocess","p=pathlib.Path("+JSON.stringify(remote)+");sys.path.insert(0,str(p/'scripts'));import common",
      "free=int(subprocess.check_output(['nvidia-smi','-i',common.PLAN['gpu_uuid'],'--query-gpu=memory.free','--format=csv,noheader,nounits'],text=True).strip())","print(json.dumps({'freeMiB':free}))"].join('\n');
    const free=JSON.parse(command(py+' -',resourceCode)).freeMiB;
    assert(Number.isFinite(free)&&free>=before.startupRequiredMiB,'OCR 等待资源：空闲 '+free+' MiB，当前启动配置需 '+before.startupRequiredMiB+' MiB；尚未启动或消耗处理额度');
    record('ocr-start-intent.json',{remote,at:new Date().toISOString(),attempt:1});
    owned=JSON.parse(command(py+" '"+remote+"/scripts/start.py' pdf"));started=true;record('ocr-owned.json',{...owned,remote});
  }
  const stop=()=>{assert(binding,'OCR ownership unavailable; refusing unfenced stop');return stopOcr({record,binding,configPath},{preflight,ssh:command});};
  try {
    const deadline=now()+730000;
    while(!serviceReady&&now()<deadline) {
      active=activeSnapshot(py,remote,command);
      if(active){assert.equal(active.pid,owned.supervisor_pid,'OCR ownership changed during startup');assert.equal(active.instance,'session-'+owned.session);binding=identityBinding(selection,active);}
      health=JSON.parse(command(py+" '"+remote+"/scripts/health.py'",undefined,true));record('ocr-health.json',health);
      if(health.ready&&binding){
        if(binding.epoch){assert.equal(health.service_epoch,binding.epoch);assert.equal(health.instance,binding.instance);assert.equal(health.resource_policy_version,'learning-ocr-resource-v1');}
        serviceReady=true;break;
      }
      await wait(4000);
    }
    assert(serviceReady,'OCR readiness timeout');record('ocr-binding.json',binding);
    const token=command("cat '"+remote+"/private/api-key'").trim();assert(token.length>=20);
    const tunnel=launch('ssh',['-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-L','127.0.0.1:37913:127.0.0.1:46238',alias],process.env,'ssh');
    let ready=false,identity;const until=now()+30000;
    while(now()<until) {
      assert(tunnel.exitCode===null,'SSH forward exited');
      let info;
      try{const r=await request('http://127.0.0.1:37913/health',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(1500)});if(r.ok)info=await r.json();}catch{}
      if(info){
        if(selection.mode==='learning-runtime'){
          assert.equal(info.resource_policy_version,'learning-ocr-resource-v1');
          assert.equal(info.instance,binding.instance);assert.equal(info.service_epoch,binding.epoch);
          identity={epoch:info.service_epoch,instance:info.instance};
        }
        record('ocr-local-health.json',info);ready=info.ready===true;if(ready)break;
      }
      await wait(300);
    }
    assert(ready,'SSH health not ready');
    return {token,stop,binding,persistent,attached:!started,budget:before,remote,identity,sessionSeconds:selection.mode==='learning-runtime'?selection.plan.session_seconds:3600,readyAt:new Date().toISOString()};
  }catch(error){
    if(started&&(!persistent||!serviceReady))try{stop();}catch{record('ocr-cleanup-error.json',{needsManualCheck:true});}
    else if(serviceReady)record('ocr-preserved.json',{binding,reason:'ready_persistent_service_detached'});
    throw error;
  }
}
