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
    { AGENT_TRIAL_MAX_REQUESTS: "37", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "1" }, { AGENT_TRIAL_MAX_REQUESTS: "2", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "3" }])
    expect(() => realTrialBudget(input)).toThrow("agent_trial_explicit_budget_required");
  expect(realTrialBudget({ AGENT_TRIAL_MAX_REQUESTS: "4", AGENT_TRIAL_PROTOCOL_MAX_REQUESTS: "1" })).toEqual({ total: 4, protocol: 1 });
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
