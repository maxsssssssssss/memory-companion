// @vitest-environment node
import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const { realTrialBudget } = createRequire(import.meta.url)("./request-budget.cjs");
it("requires newly explicit real budgets without inheriting the historical 36/6 allowance", () => {
  for (const input of [{}, { AGENT_TRIAL_MAX_REQUESTS: "36" }, { AGENT_TRIAL_MAX_REQUESTS: "0", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "1" },
    { AGENT_TRIAL_MAX_REQUESTS: "320", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "1" }, { AGENT_TRIAL_MAX_REQUESTS: "2", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "3" }])
    expect(() => realTrialBudget(input)).toThrow("agent_trial_explicit_budget_required");
  expect(realTrialBudget({ AGENT_TRIAL_MAX_REQUESTS: "4", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "1" })).toEqual({ total: 4, protocol: 1 });
  expect(realTrialBudget({ AGENT_TRIAL_MAX_REQUESTS: "67", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" })).toEqual({ total: 67, protocol: 2 });
  expect(realTrialBudget({ AGENT_TRIAL_MAX_REQUESTS: "200", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" })).toEqual({ total: 200, protocol: 2 });
  expect(realTrialBudget({ AGENT_TRIAL_MAX_REQUESTS: "225", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" })).toEqual({ total: 225, protocol: 2 });
  expect(realTrialBudget({ AGENT_TRIAL_MAX_REQUESTS: "227", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" })).toEqual({ total: 227, protocol: 2 });
  expect(realTrialBudget({ AGENT_TRIAL_MAX_REQUESTS: "319", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" })).toEqual({ total: 319, protocol: 2 });
});
it.each(["guard", "launch"])("%s rejects absent budget before credentials, ledger creation or directory mutation", command => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-budget-test-"));
  try {
    const args = command === "guard"
      ? ["--require", path.resolve("scripts/agent-trial/guard.cjs"), "-e", "throw Error('unexpected_execution')"]
      : ["scripts/agent-trial/launch.mjs", "start", "--real", "--credential-env", "OPENAI_API_KEY"];
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), ...args], {
      encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_DIR: root },
    });
    expect(child.status).not.toBe(0); expect(child.stderr).toContain("agent_trial_explicit_budget_required");
    expect(child.stderr).not.toContain("Configured trial credential missing"); expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("guard enforces the supplied total/protocol ceilings against one persistent ledger using a synthetic fetch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-budget-ledger-test-"));
  try {
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict');let fakeRequests=0;
      globalThis.fetch=async()=>{fakeRequests++;return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:2,output_tokens:1}}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}})};
      require('./scripts/agent-trial/guard.cjs');
      const request=()=>fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})});
      (async()=>{process.env.AGENT_TRIAL_PHASE='protocol';await(await request()).text();
        await assert.rejects(request(),/trial_protocol_budget_exhausted/);
        process.env.AGENT_TRIAL_PHASE='trajectory';await(await request()).text();
        await assert.rejects(request(),/trial_total_budget_exhausted/);assert.equal(fakeRequests,2);
        console.log('synthetic_fetch_budget_PASS');})().catch(()=>process.exitCode=1);
    `], { encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_DIR: root, AGENT_TRIAL_MAX_REQUESTS: "2", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "1" } });
    expect(child.status, child.stderr).toBe(0); expect(child.stdout).toContain("synthetic_fetch_budget_PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("adds UUID-only request correlation while preserving all 17 synthetic prior ledger rows and the same cumulative ceiling", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-diagnostic-ledger-test-"));
  try {
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path');
      const db=new Database(path.join(process.env.AGENT_TRIAL_DIR,'network-ledger.sqlite'));
      db.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY, phase TEXT, started TEXT, state TEXT,model TEXT,input_chars INTEGER,output_limit INTEGER,status INTEGER,input_tokens INTEGER,output_tokens INTEGER)');
      const insert=db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?)');
      for(let i=1;i<=17;i++)insert.run(i,'trajectory','synthetic-prior-'+i,'completed','deepseek-v4-pro',100,20,200,10,5);
      const before=db.prepare('SELECT * FROM requests ORDER BY id').all();let fakeRequests=0;
      globalThis.fetch=async()=>{fakeRequests++;return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:2,output_tokens:1}}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}})};
      require('./scripts/agent-trial/guard.cjs');
      const request=id=>fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',headers:id?{'X-Client-Request-Id':id}:{},body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})});
      (async()=>{const uuid='f636f4a5-c5c4-4162-a25d-8f1c25bf30b4';
        await(await request(uuid)).text();await(await request('synthetic-secret-header')).text();await(await request()).text();
        await assert.rejects(request(uuid),/trial_total_budget_exhausted/);assert.equal(fakeRequests,3);
        const rows=db.prepare('SELECT * FROM requests ORDER BY id').all();
        assert.deepEqual(rows.slice(0,17),before.map(row=>({...row,client_request_id:null})));
        assert.deepEqual(rows.slice(17).map(row=>row.client_request_id),[uuid,null,null]);
        assert.equal(JSON.stringify(rows).includes('synthetic-secret-header'),false);
        assert.deepEqual(db.prepare('SELECT count(*) calls,sum(input_tokens) input,sum(output_tokens) output FROM requests').get(),{calls:20,input:176,output:88});
        console.log('synthetic_request_correlation_legacy_budget_PASS');db.close();})().catch(error=>{console.error(error);process.exitCode=1});
    `], { encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_DIR: root, AGENT_TRIAL_MAX_REQUESTS: "20", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "1" } });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("synthetic_request_correlation_legacy_budget_PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps 35 historical completed/failed/unknown requests, permits only 32 more and preserves the protocol sublimit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-budget-67-test-"));
  try {
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path');
      const db=new Database(path.join(process.env.AGENT_TRIAL_DIR,'network-ledger.sqlite'));
      db.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY, phase TEXT, started TEXT, state TEXT,model TEXT,input_chars INTEGER,output_limit INTEGER,status INTEGER,input_tokens INTEGER,output_tokens INTEGER,client_request_id TEXT)');
      const insert=db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for(let i=1;i<=35;i++)insert.run(i,i<=2?'protocol':'trajectory','synthetic-prior-'+i,
        i%3===0?'unknown':i%3===1?'failed':'completed','deepseek-v4-pro',100,20,i%3===0?null:i%3===1?500:200,10,5,null);
      const before=db.prepare('SELECT * FROM requests ORDER BY id').all();let fakeRequests=0;
      globalThis.fetch=async()=>{fakeRequests++;return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:2,output_tokens:1}}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}})};
      require('./scripts/agent-trial/guard.cjs');
      const request=()=>fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})});
      (async()=>{process.env.AGENT_TRIAL_PHASE='protocol';await assert.rejects(request(),/trial_protocol_budget_exhausted/);
        assert.equal(fakeRequests,0);process.env.AGENT_TRIAL_PHASE='trajectory';
        for(let i=0;i<32;i++)await(await request()).text();
        await assert.rejects(request(),/trial_total_budget_exhausted/);assert.equal(fakeRequests,32);
        const rows=db.prepare('SELECT * FROM requests ORDER BY id').all();assert.equal(rows.length,67);
        assert.deepEqual(rows.slice(0,35),before);assert.equal(rows.slice(35).every(row=>row.state==='completed'),true);
        assert.equal(db.prepare("SELECT count(*) n FROM requests WHERE phase='protocol'").get().n,2);
        console.log('synthetic_35_plus_32_cumulative_budget_PASS');db.close();})().catch(error=>{console.error(error);process.exitCode=1});
    `], { encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_DIR: root, AGENT_TRIAL_MAX_REQUESTS: "67", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" } });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("synthetic_35_plus_32_cumulative_budget_PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("preserves 116 synthetic prior requests, counts all 109 new outcomes through request 225, and rejects 226 across restart before fetch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-budget-225-test-"));
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_DIR: root, AGENT_TRIAL_MAX_REQUESTS: "225", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" };
  try {
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path'),fs=require('node:fs');
      const db=new Database(path.join(process.env.AGENT_TRIAL_DIR,'network-ledger.sqlite'));
      db.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY, phase TEXT, started TEXT, state TEXT,model TEXT,input_chars INTEGER,output_limit INTEGER,status INTEGER,input_tokens INTEGER,output_tokens INTEGER,client_request_id TEXT)');
      const insert=db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for(let i=1;i<=116;i++)insert.run(i,i<=2?'protocol':'trajectory','synthetic-prior-'+i,
        'completed','deepseek-v4-pro',100,20,200,10,5,null);
      const before=db.prepare('SELECT * FROM requests ORDER BY id').all();let fakeRequests=0;
      globalThis.fetch=async()=>{
        fakeRequests++; const reserved=db.prepare('SELECT id,state FROM requests ORDER BY id DESC LIMIT 1').get();
        assert.deepEqual(reserved,{id:116+fakeRequests,state:'dispatched'});
        if(fakeRequests===1)return new Response('synthetic_failed',{status:500});
        if(fakeRequests===2)throw Error('synthetic_transport_failure');
        if(fakeRequests===3)return new Response('data: '+JSON.stringify({type:'response.created'})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
        return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:2,output_tokens:1}}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
      };
      require('./scripts/agent-trial/guard.cjs');
      const request=()=>fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})});
      (async()=>{
        process.env.AGENT_TRIAL_PHASE='protocol';await assert.rejects(request(),/trial_protocol_budget_exhausted/);
        assert.equal(fakeRequests,0);assert.equal(db.prepare('SELECT count(*) n FROM requests').get().n,116);
        process.env.AGENT_TRIAL_PHASE='trajectory';
        for(let i=1;i<=109;i++){
          if(i===2)await assert.rejects(request(),/agent_trial_transport_unknown/);
          else {const response=await request();await response.text();assert.equal(response.status,i===1?500:200);}
          assert.equal(fakeRequests,i);
        }
        assert.equal(fakeRequests,109);await assert.rejects(request(),/trial_total_budget_exhausted/);assert.equal(fakeRequests,109);
        const rows=db.prepare('SELECT * FROM requests ORDER BY id').all();assert.equal(rows.length,225);
        assert.deepEqual(rows.slice(0,116),before);
        assert.deepEqual(rows.slice(116,119).map(row=>row.state),['failed','unknown','unknown']);
        assert.equal(rows.slice(119).every(row=>row.state==='completed'),true);
        assert.deepEqual(db.prepare('SELECT state,count(*) n FROM requests GROUP BY state ORDER BY state').all(),
          [{state:'completed',n:222},{state:'failed',n:1},{state:'unknown',n:2}]);
        assert.equal(db.prepare("SELECT count(*) n FROM requests WHERE phase='protocol'").get().n,2);
        assert.deepEqual(db.prepare('SELECT sum(input_tokens) input,sum(output_tokens) output FROM requests').get(),{input:1372,output:686});
        fs.writeFileSync(path.join(process.env.AGENT_TRIAL_DIR,'synthetic-final-rows.json'),JSON.stringify(rows));
        assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
        console.log('synthetic_116_plus_109_cumulative_budget_PASS');db.close();
      })().catch(error=>{console.error(error);process.exitCode=1});
    `], { encoding: "utf8", timeout: 20000, env });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("synthetic_116_plus_109_cumulative_budget_PASS");
    const restarted = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path'),fs=require('node:fs');
      const before=JSON.parse(fs.readFileSync(path.join(process.env.AGENT_TRIAL_DIR,'synthetic-final-rows.json'),'utf8'));
      let fakeRequests=0;globalThis.fetch=async()=>{fakeRequests++;throw Error('unexpected_fetch_after_restart')};
      require('./scripts/agent-trial/guard.cjs');
      const db=new Database(path.join(process.env.AGENT_TRIAL_DIR,'network-ledger.sqlite'));
      (async()=>{
        process.env.AGENT_TRIAL_PHASE='trajectory';
        await assert.rejects(fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})}),/trial_total_budget_exhausted/);
        assert.equal(fakeRequests,0);assert.deepEqual(db.prepare('SELECT * FROM requests ORDER BY id').all(),before);
        assert.equal(db.prepare('SELECT count(*) n FROM requests').get().n,225);
        assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
        console.log('synthetic_restart_226_rejected_before_fetch_PASS');db.close();
      })().catch(error=>{console.error(error);process.exitCode=1});
    `], { encoding: "utf8", timeout: 10000, env });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(restarted.stdout).toContain("synthetic_restart_226_rejected_before_fetch_PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

it("preserves 177 synthetic prior requests, counts all 50 new outcomes through request 227, and rejects 228 across restart before fetch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-budget-227-test-"));
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_DIR: root, AGENT_TRIAL_MAX_REQUESTS: "227", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" };
  try {
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path'),fs=require('node:fs');
      const db=new Database(path.join(process.env.AGENT_TRIAL_DIR,'network-ledger.sqlite'));
      db.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY, phase TEXT, started TEXT, state TEXT,model TEXT,input_chars INTEGER,output_limit INTEGER,status INTEGER,input_tokens INTEGER,output_tokens INTEGER,client_request_id TEXT)');
      const insert=db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for(let i=1;i<=177;i++)insert.run(i,i<=2?'protocol':'trajectory','synthetic-prior-'+i,
        i===101?'unknown':'completed','deepseek-v4-pro',100,20,i===101?null:200,i===101?null:10,i===101?null:5,null);
      const before=db.prepare('SELECT * FROM requests ORDER BY id').all();let fakeRequests=0;
      globalThis.fetch=async()=>{
        fakeRequests++; const reserved=db.prepare('SELECT id,state FROM requests ORDER BY id DESC LIMIT 1').get();
        assert.deepEqual(reserved,{id:177+fakeRequests,state:'dispatched'});
        if(fakeRequests===1)return new Response('synthetic_failed',{status:500});
        if(fakeRequests===2)throw Error('synthetic_transport_failure');
        if(fakeRequests===3)return new Response('data: '+JSON.stringify({type:'response.created'})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
        return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:2,output_tokens:1}}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
      };
      require('./scripts/agent-trial/guard.cjs');
      const request=()=>fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})});
      (async()=>{
        process.env.AGENT_TRIAL_PHASE='protocol';await assert.rejects(request(),/trial_protocol_budget_exhausted/);
        assert.equal(fakeRequests,0);assert.equal(db.prepare('SELECT count(*) n FROM requests').get().n,177);
        process.env.AGENT_TRIAL_PHASE='trajectory';
        for(let i=1;i<=50;i++){
          if(i===2)await assert.rejects(request(),/agent_trial_transport_unknown/);
          else {const response=await request();await response.text();assert.equal(response.status,i===1?500:200);}
          assert.equal(fakeRequests,i);
        }
        assert.equal(fakeRequests,50);await assert.rejects(request(),/trial_total_budget_exhausted/);assert.equal(fakeRequests,50);
        const rows=db.prepare('SELECT * FROM requests ORDER BY id').all();assert.equal(rows.length,227);
        assert.deepEqual(rows.slice(0,177),before);
        assert.deepEqual(rows.slice(177,180).map(row=>row.state),['failed','unknown','unknown']);
        assert.equal(rows.slice(180).every(row=>row.state==='completed'),true);
        assert.deepEqual(db.prepare('SELECT state,count(*) n FROM requests GROUP BY state ORDER BY state').all(),
          [{state:'completed',n:223},{state:'failed',n:1},{state:'unknown',n:3}]);
        assert.equal(db.prepare("SELECT count(*) n FROM requests WHERE phase='protocol'").get().n,2);
        assert.deepEqual(db.prepare('SELECT sum(input_tokens) input,sum(output_tokens) output FROM requests').get(),{input:1854,output:927});
        fs.writeFileSync(path.join(process.env.AGENT_TRIAL_DIR,'synthetic-final-rows.json'),JSON.stringify(rows));
        assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
        console.log('synthetic_177_plus_50_cumulative_budget_PASS');db.close();
      })().catch(error=>{console.error(error);process.exitCode=1});
    `], { encoding: "utf8", timeout: 20000, env });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("synthetic_177_plus_50_cumulative_budget_PASS");
    const restarted = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path'),fs=require('node:fs');
      const before=JSON.parse(fs.readFileSync(path.join(process.env.AGENT_TRIAL_DIR,'synthetic-final-rows.json'),'utf8'));
      let fakeRequests=0;globalThis.fetch=async()=>{fakeRequests++;throw Error('unexpected_fetch_after_restart')};
      require('./scripts/agent-trial/guard.cjs');
      const db=new Database(path.join(process.env.AGENT_TRIAL_DIR,'network-ledger.sqlite'));
      (async()=>{
        process.env.AGENT_TRIAL_PHASE='trajectory';
        await assert.rejects(fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})}),/trial_total_budget_exhausted/);
        assert.equal(fakeRequests,0);assert.deepEqual(db.prepare('SELECT * FROM requests ORDER BY id').all(),before);
        assert.equal(db.prepare('SELECT count(*) n FROM requests').get().n,227);
        assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
        console.log('synthetic_restart_228_rejected_before_fetch_PASS');db.close();
      })().catch(error=>{console.error(error);process.exitCode=1});
    `], { encoding: "utf8", timeout: 10000, env });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(restarted.stdout).toContain("synthetic_restart_228_rejected_before_fetch_PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

it("preserves 219 synthetic prior requests, counts all 100 new outcomes through request 319, and rejects 320 across restart before fetch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-budget-319-test-"));
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_DIR: root, AGENT_TRIAL_MAX_REQUESTS: "319", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "2" };
  try {
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path'),fs=require('node:fs');
      const db=new Database(path.join(process.env.AGENT_TRIAL_DIR,'network-ledger.sqlite'));
      db.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY, phase TEXT, started TEXT, state TEXT,model TEXT,input_chars INTEGER,output_limit INTEGER,status INTEGER,input_tokens INTEGER,output_tokens INTEGER,client_request_id TEXT)');
      const insert=db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for(let i=1;i<=219;i++)insert.run(i,i<=2?'protocol':'trajectory','synthetic-prior-'+i,
        i===101?'unknown':'completed','deepseek-v4-pro',100,20,i===101?null:200,i===101?null:10,i===101?null:5,null);
      const before=db.prepare('SELECT * FROM requests ORDER BY id').all();let fakeRequests=0;
      globalThis.fetch=async()=>{
        fakeRequests++; const reserved=db.prepare('SELECT id,state FROM requests ORDER BY id DESC LIMIT 1').get();
        assert.deepEqual(reserved,{id:219+fakeRequests,state:'dispatched'});
        if(fakeRequests===1)return new Response('synthetic_failed',{status:500});
        if(fakeRequests===2)throw Error('synthetic_transport_failure');
        if(fakeRequests===3)return new Response('data: '+JSON.stringify({type:'response.created'})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
        return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:2,output_tokens:1}}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
      };
      require('./scripts/agent-trial/guard.cjs');
      const request=()=>fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})});
      (async()=>{
        process.env.AGENT_TRIAL_PHASE='protocol';await assert.rejects(request(),/trial_protocol_budget_exhausted/);
        assert.equal(fakeRequests,0);assert.equal(db.prepare('SELECT count(*) n FROM requests').get().n,219);
        process.env.AGENT_TRIAL_PHASE='trajectory';
        for(let i=1;i<=100;i++){
          if(i===2)await assert.rejects(request(),/agent_trial_transport_unknown/);
          else {const response=await request();await response.text();assert.equal(response.status,i===1?500:200);}
          assert.equal(fakeRequests,i);
        }
        assert.equal(fakeRequests,100);await assert.rejects(request(),/trial_total_budget_exhausted/);assert.equal(fakeRequests,100);
        const rows=db.prepare('SELECT * FROM requests ORDER BY id').all();assert.equal(rows.length,319);
        assert.deepEqual(rows.slice(0,219),before);
        assert.deepEqual(rows.slice(219,222).map(row=>row.state),['failed','unknown','unknown']);
        assert.equal(rows.slice(222).every(row=>row.state==='completed'),true);
        assert.deepEqual(db.prepare('SELECT state,count(*) n FROM requests GROUP BY state ORDER BY state').all(),
          [{state:'completed',n:315},{state:'failed',n:1},{state:'unknown',n:3}]);
        assert.equal(db.prepare("SELECT count(*) n FROM requests WHERE phase='protocol'").get().n,2);
        assert.deepEqual(db.prepare('SELECT sum(input_tokens) input,sum(output_tokens) output FROM requests').get(),{input:2374,output:1187});
        fs.writeFileSync(path.join(process.env.AGENT_TRIAL_DIR,'synthetic-final-rows.json'),JSON.stringify(rows));
        assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
        console.log('synthetic_219_plus_100_cumulative_budget_PASS');db.close();
      })().catch(error=>{console.error(error);process.exitCode=1});
    `], { encoding: "utf8", timeout: 20000, env });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("synthetic_219_plus_100_cumulative_budget_PASS");
    const restarted = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "-e", `
      const assert=require('node:assert/strict'),Database=require('better-sqlite3'),path=require('node:path'),fs=require('node:fs');
      const before=JSON.parse(fs.readFileSync(path.join(process.env.AGENT_TRIAL_DIR,'synthetic-final-rows.json'),'utf8'));
      let fakeRequests=0;globalThis.fetch=async()=>{fakeRequests++;throw Error('unexpected_fetch_after_restart')};
      require('./scripts/agent-trial/guard.cjs');
      const db=new Database(path.join(process.env.AGENT_TRIAL_DIR,'network-ledger.sqlite'));
      (async()=>{
        process.env.AGENT_TRIAL_PHASE='trajectory';
        await assert.rejects(fetch('https://tokenhub.vision-intelligence.tech/v1/responses',{method:'POST',body:JSON.stringify({model:'deepseek-v4-pro',max_output_tokens:20,store:false,stream:true,input:[]})}),/trial_total_budget_exhausted/);
        assert.equal(fakeRequests,0);assert.deepEqual(db.prepare('SELECT * FROM requests ORDER BY id').all(),before);
        assert.equal(db.prepare('SELECT count(*) n FROM requests').get().n,319);
        assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
        console.log('synthetic_restart_320_rejected_before_fetch_PASS');db.close();
      })().catch(error=>{console.error(error);process.exitCode=1});
    `], { encoding: "utf8", timeout: 10000, env });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(restarted.stdout).toContain("synthetic_restart_320_rejected_before_fetch_PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
