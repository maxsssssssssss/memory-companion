// @vitest-environment node
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initializeBudget, completedBudgetSnapshot, feedbackBudgetSnapshot, claimFinalResume } from './run-date-companion-agent-real.mjs';

const { installGuard } = createRequire(import.meta.url)('./reflection-thinking-real-network-guard.cjs');
const model = 'deepseek-v4-pro';
const scenario = 'date_companion_preparation_v1';

test('explicit final campaign has its own single allowance and does not reset the historical P1 ledger',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'date-agent-final-budget-'));
  try {
    const p1=join(temporary,'p1'), final=join(temporary,'final');
    initializeBudget(p1,'historical');
    const oldAuthorization=readFileSync(join(p1,'historical','AUTHORIZATION.json'));
    assert.equal(initializeBudget(final,'current',null,false,true),0);
    const authorization=JSON.parse(readFileSync(join(final,'current','AUTHORIZATION.json'),'utf8'));
    assert.equal(authorization.campaign,'date-companion-p1-p3-final-2026-11-06');
    assert.equal(authorization.maxRequests,12);
    assert.equal(authorization.captureSyntheticInput,true);
    assert.throws(()=>initializeBudget(final,'reset',null,false,true),/already exists/u);
    assert.deepEqual(readFileSync(join(p1,'historical','AUTHORIZATION.json')),oldAuthorization);
  } finally {rmSync(temporary,{recursive:true,force:true});}
});

/** The guard under test receives a fake transport. No sockets or Provider credentials. */
function openSyntheticRun(directory) {
  const data = join(directory, 'data');
  const business = new Database(join(data,'date-companion.sqlite'));
  business.exec(`CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY,scenario TEXT,resource_id TEXT,scope_json TEXT);
    CREATE TABLE IF NOT EXISTS agent_calls(id TEXT PRIMARY KEY,status TEXT,kind TEXT,task_id TEXT,model TEXT,diagnostics_json TEXT);`);
  const scope = {preparationId:'synthetic-prep',generationId:'synthetic-generation',version:1};
  business.prepare('INSERT OR IGNORE INTO agent_tasks VALUES(?,?,?,?)').run('task',scenario,scope.preparationId,JSON.stringify(scope));
  let transportCalls = 0;
  const api = installGuard({environment:{THINKING_P1_REAL_DIR:directory,APP_DATA_DIR:data},stdout:()=>{},fetch:async()=>{
    transportCalls++;
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[]}})+'\n\n');
  }});
  return {
    api, business, transportCalls:()=>transportCalls,
    async send() {
      const id = randomUUID();
      business.prepare('INSERT INTO agent_calls(id,status,kind,task_id,model) VALUES(?,?,?,?,?)').run(id,'running','agent_decision','task',model);
      const response = await globalThis.fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',headers:{'x-client-request-id':id,'x-stainless-retry-count':'0'},
        body:JSON.stringify({model,stream:true,store:false,reasoning:{effort:'none'},max_output_tokens:10,input:[{role:'user',content:JSON.stringify({authorizedScope:scope})}]})});
      await response.text();
      business.prepare("UPDATE agent_calls SET status='succeeded' WHERE id=?").run(id);
    },
    close(){business.close();api.close();}
  };
}

test('five prior attempts plus seven in a fresh account DB share one twelve-request dispatch gate', async()=>{
  const temporary = mkdtempSync(join(tmpdir(),'date-agent-budget-'));
  const batches=join(temporary,'batch'), previous=join(batches,'first'), next=join(batches,'first-retest');
  try {
    assert.equal(initializeBudget(batches,'first'),0);
    const old = openSyntheticRun(previous);
    try {
      for(let i=0;i<5;i++)await old.send();
      writeFileSync(join(previous,'summary.json'),JSON.stringify({serverExit:{code:null,signal:'SIGTERM'},transport:old.api.snapshot()}));
      assert.equal(old.transportCalls(),5);
    } finally {old.close();}
    const original = readFileSync(join(previous,'network-ledger.sqlite'));
    assert.throws(()=>initializeBudget(batches,'fresh-budget'), /already exists/u);
    assert.throws(()=>initializeBudget(batches,'different-suffix','first'), /single successor/u);
    assert.equal(initializeBudget(batches,'first-retest','first'),5);
    assert.throws(()=>initializeBudget(batches,'first-retest','first'), /already claimed/u);
    const current = openSyntheticRun(next);
    try {
      assert.equal(current.api.snapshot().sent,5);
      for(let i=0;i<7;i++)await current.send();
      await assert.rejects(current.send(),/request_budget_exhausted/u);
      assert.equal(current.transportCalls(),7);
      assert.equal(current.api.snapshot().sent,12);
      assert.deepEqual(readFileSync(join(previous,'network-ledger.sqlite')),original);
    } finally {current.close();}
    const prior = new Database(join(previous,'data','date-companion.sqlite'));
    try {prior.exec("UPDATE agent_calls SET status='unknown' WHERE rowid=1");} finally {prior.close();}
    assert.throws(()=>completedBudgetSnapshot(previous), /receipts differ/u);
  } finally {rmSync(temporary,{recursive:true,force:true});}
});

test('explicit final resume retains both databases and failed evidence, with only eight dispatches left after four',async()=>{
  const workspace=mkdtempSync(join(tmpdir(),'date-agent-final-resume-'));
  const root=join(workspace,'output/date-companion-agent-final-real'), run='acceptance', directory=join(root,run);
  const diagnostic={layer:'action_json',reasonCode:'action_json_invalid',response:{responseStatus:'completed',parseResult:'failed',validationResult:'not_started',stream:{completionReceived:true}}};
  try {
    initializeBudget(root,run,null,false,true);
    const initial=openSyntheticRun(directory);
    try {
      for(let i=0;i<4;i++)await initial.send();
      initial.business.prepare("UPDATE agent_calls SET status='failed',diagnostics_json=? WHERE rowid=3").run(JSON.stringify(diagnostic));
      writeFileSync(join(directory,'summary.json'),JSON.stringify({finalAcceptance:true,mode:'production',syntheticData:true,budget:12,serverExit:{code:null,signal:'SIGTERM'},transport:initial.api.snapshot()}));
    } finally {initial.close();}
    const originalSummary=readFileSync(join(directory,'summary.json'));
    const originalNetwork=readFileSync(join(directory,'network-ledger.sqlite'));
    const originalBusiness=readFileSync(join(directory,'data/date-companion.sqlite'));
    const resume=claimFinalResume(workspace,run);
    assert.equal(resume.priorRequests,4); assert.equal(resume.remaining,8); assert.equal(resume.suffix,'resume-001');
    assert.equal(resume.acceptedActionFailures.length,1);
    assert.equal(resume.acceptedActionFailures[0].layer,'action_json');
    assert.deepEqual(readFileSync(join(directory,'summary.json')),originalSummary);
    assert.deepEqual(readFileSync(join(directory,'network-ledger.sqlite')),originalNetwork);
    assert.deepEqual(readFileSync(join(directory,'data/date-companion.sqlite')),originalBusiness);
    assert.throws(()=>claimFinalResume(workspace,run),/ENOENT/u,'A claimed attempt without a closed server receipt cannot resume concurrently');
    const resumed=openSyntheticRun(directory);
    try {
      assert.equal(resumed.api.snapshot().sent,4);
      for(let i=0;i<8;i++)await resumed.send();
      assert.equal(resumed.transportCalls(),8); assert.equal(resumed.api.snapshot().sent,12);
      await assert.rejects(resumed.send(),/request_budget_exhausted/u);
      assert.equal(resumed.transportCalls(),8);
      writeFileSync(join(directory,'summary-resume-001.json'),JSON.stringify({finalAcceptance:true,mode:'production',syntheticData:true,budget:12,resumeAttempt:1,serverExit:{code:0},transport:resumed.api.snapshot()}));
    } finally {resumed.close();}
    assert.throws(()=>claimFinalResume(workspace,run),/exhausted/u);
    assert.deepEqual(readFileSync(join(directory,'summary.json')),originalSummary);
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test('final resume rejects unknown, unsupported failures, changed IDs, campaign, halt and unclosed server receipts',async()=>{
  const workspace=mkdtempSync(join(tmpdir(),'date-agent-final-resume-denied-'));
  const root=join(workspace,'output/date-companion-agent-final-real'), run='acceptance', directory=join(root,run);
  const summaryPath=join(directory,'summary.json'), authorizationPath=join(directory,'AUTHORIZATION.json');
  try {
    initializeBudget(root,run,null,false,true);
    const initial=openSyntheticRun(directory);
    let summary;
    try {
      await initial.send();
      summary={finalAcceptance:true,mode:'production',syntheticData:true,budget:12,serverExit:{code:0},transport:initial.api.snapshot()};
      writeFileSync(summaryPath,JSON.stringify(summary));
    } finally {initial.close();}
    const business=new Database(join(directory,'data/date-companion.sqlite'));
    const network=new Database(join(directory,'network-ledger.sqlite'));
    try {
      for (const status of ['running','unknown','failed']) {
        business.prepare('UPDATE agent_calls SET status=?').run(status);
        assert.throws(()=>claimFinalResume(workspace,run),/receipts differ/u);
      }
      business.exec("UPDATE agent_calls SET status='succeeded'");
      const oldId=business.prepare('SELECT id FROM agent_calls').get().id;
      business.prepare('UPDATE agent_calls SET id=?').run(randomUUID());
      assert.throws(()=>claimFinalResume(workspace,run),/receipts differ/u);
      business.prepare('UPDATE agent_calls SET id=?').run(oldId);
      network.exec("UPDATE requests SET state='unknown'");
      assert.throws(()=>claimFinalResume(workspace,run),/unresolved/u);
      network.exec("UPDATE requests SET state='completed'; UPDATE guard_state SET halted=1");
      assert.throws(()=>claimFinalResume(workspace,run),/unresolved/u);
      network.exec('UPDATE guard_state SET halted=0');
      const authorization=readFileSync(authorizationPath);
      writeFileSync(authorizationPath,JSON.stringify({...JSON.parse(authorization),campaign:'different'}));
      assert.throws(()=>claimFinalResume(workspace,run),/authorization differs/u);
      writeFileSync(authorizationPath,authorization);
      writeFileSync(summaryPath,JSON.stringify({...summary,serverExit:{code:null,signal:null}}));
      assert.throws(()=>claimFinalResume(workspace,run),/closed local server/u);
      writeFileSync(summaryPath,JSON.stringify(summary));
      const diagnostic={layer:'action_schema',reasonCode:'action_schema_invalid',response:{responseStatus:'completed',parseResult:'success',validationResult:'failed',stream:{completionReceived:true}}};
      for (const invalid of [
        {...diagnostic,layer:'transport'},
        {...diagnostic,reasonCode:'other_failure'},
        {...diagnostic,response:{...diagnostic.response,stream:{completionReceived:false}}},
        {...diagnostic,response:{...diagnostic.response,parseResult:'failed'}},
      ]) {
        business.prepare("UPDATE agent_calls SET status='failed',diagnostics_json=?").run(JSON.stringify(invalid));
        assert.throws(()=>claimFinalResume(workspace,run),/receipts differ/u);
      }
      business.prepare("UPDATE agent_calls SET status='failed',diagnostics_json=?").run(JSON.stringify(diagnostic));
      const claim=claimFinalResume(workspace,run);
      assert.equal(claim.priorRequests,1); assert.equal(claim.acceptedActionFailures[0].layer,'action_schema');
    } finally {business.close();network.close();}
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test('independent follow-up inherits both batches, accepts only proven schema failure, and spends at most five more attempts',async()=>{
  const temporary=mkdtempSync(join(tmpdir(),'date-agent-feedback-budget-'));
  const batches=join(temporary,'batch'), first=join(batches,'first'), second=join(batches,'first-retest');
  const feedbackName='first-retest-feedback';
  try {
    initializeBudget(batches,'first');
    const original=openSyntheticRun(first);
    try {
      for(let i=0;i<5;i++)await original.send();
      writeFileSync(join(first,'summary.json'),JSON.stringify({serverExit:{code:0},transport:original.api.snapshot()}));
    } finally {original.close();}
    initializeBudget(batches,'first-retest','first');
    const retest=openSyntheticRun(second);
    try {
      await retest.send(); await retest.send();
      writeFileSync(join(second,'summary.json'),JSON.stringify({serverExit:{code:0},priorRun:'first',priorRequests:5,transport:retest.api.snapshot()}));
      const diagnostic = {layer:'action_schema',reasonCode:'action_schema_invalid',response:{responseStatus:'completed',parseResult:'success',validationResult:'failed',stream:{completionReceived:true}}};
      const update=retest.business.prepare('UPDATE agent_calls SET status=?,diagnostics_json=? WHERE rowid=2');
      update.run('unknown',JSON.stringify(diagnostic));
      assert.throws(()=>feedbackBudgetSnapshot(second), /receipts differ/u);
      update.run('failed',JSON.stringify({...diagnostic,response:{...diagnostic.response,stream:{completionReceived:false}}}));
      assert.throws(()=>feedbackBudgetSnapshot(second), /receipts differ/u);
      update.run('failed',JSON.stringify(diagnostic));
    } finally {retest.close();}
    const good=feedbackBudgetSnapshot(second);
    assert.equal(good.sent,7);
    // Even a fully settled prior branch must prove the exact inherited rows.
    const changed=new Database(join(second,'network-ledger.sqlite'));
    try {
      const row=changed.prepare('SELECT request_body_sha256 FROM requests WHERE id=1').get();
      const set=changed.prepare('UPDATE requests SET request_body_sha256=? WHERE id=1');
      set.run('tampered'); assert.throws(()=>feedbackBudgetSnapshot(second), /Inherited ledger proof differs/u); set.run(row.request_body_sha256);
    } finally {changed.close();}
    const bytesFirst=readFileSync(join(first,'network-ledger.sqlite')), bytesSecond=readFileSync(join(second,'network-ledger.sqlite'));
    assert.equal(initializeBudget(batches,feedbackName,'first-retest',true),7);
    assert.throws(()=>initializeBudget(batches,feedbackName,'first-retest',true),/already claimed/u);
    const feedback=openSyntheticRun(join(batches,feedbackName));
    try {
      assert.equal(feedback.api.snapshot().sent,7);
      for(let i=0;i<5;i++)await feedback.send();
      await assert.rejects(feedback.send(),/request_budget_exhausted/u);
      assert.equal(feedback.transportCalls(),5);
      assert.equal(feedback.api.snapshot().sent,12);
    } finally {feedback.close();}
    assert.deepEqual(readFileSync(join(first,'network-ledger.sqlite')),bytesFirst);
    assert.deepEqual(readFileSync(join(second,'network-ledger.sqlite')),bytesSecond);
  } finally {rmSync(temporary,{recursive:true,force:true});}
});
