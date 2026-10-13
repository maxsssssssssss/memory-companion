// @vitest-environment node
import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url), Database = require("better-sqlite3");
const { decision } = require("./offline-a2-fixtures.cjs"), faults = require("./offline-faults.cjs");
const materialId = "00000000-0000-4000-8000-000000000001";
const scope = { tool: "learning.read_scope", status: "succeeded", value: { materials: [{ materialId, title: "合成教材 · 集合、交集与并集", paragraphs: [3, 4, 6] }] } };
const navigation = { tool: "learning.read_navigation", status: "succeeded", value: { chapters: [{ id: "chapter", nodes: [{ id: "node", sources: [{ materialId, paragraph: 3 }] }] }] } };
const input = (goal: string, results: unknown[]) => ({ goal, results, observation: {}, tools: [] });
it("A2 note fixture uses the actual explanation identity and target bindings, never prewrites notes", () => {
  const read = { tool: "learning.read_source", status: "succeeded", value: {} };
  expect(decision(input("[A2:note] 合成目标", [scope, navigation, read])).tool).toBe("learning.explain");
  const explained = { tool: "learning.explain", status: "succeeded", value: { id: "actual-explanation", items: [{ materialId, paragraph: 3 }] } };
  expect(decision(input("[A2:note] 合成目标", [scope, navigation, read, explained]))).toMatchObject({ tool: "learning.append_note", args: { explanationId: "actual-explanation", chapterId: "chapter", nodeId: "node" } });
  expect(() => decision(input("[A2:note] 合成目标", [scope, navigation, read, { ...explained, value: { id: "another", items: [{ materialId, paragraph: 6 }] } }]))).toThrow();
});

it("receipt-loss preload matches only the isolated task/version/reference and throws once before shared write", () => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-receipt-test-"));
  try {
    writeFileSync(path.join(root, "offline-control.json"), JSON.stringify({ version: 1, faults: [
      { id: "exact-loss", point: "receipt", effect: "throw_once", accountId: "synthetic", taskId: "matching-task", version: 2, refKind: "learning.quiz" },
    ] }));
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "--require", path.resolve("scripts/agent-trial/offline-provider.cjs"), "-e", `
      const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
      const root=process.env.AGENT_TRIAL_DIR,folder=path.join(root,'data','users','synthetic');fs.mkdirSync(folder,{recursive:true});
      const db=new Database(path.join(folder,'agent-tasks.sqlite'));
      db.exec('CREATE TABLE agent_actions(id TEXT, task_id TEXT, version INTEGER,status TEXT,ref_json TEXT,wait_json TEXT,summary TEXT,handoff INTEGER)');
      db.prepare('INSERT INTO agent_actions(id,task_id,version,status) VALUES(?,?,?,?)').run('action','matching-task',2,'executing');
      const sql='UPDATE agent_actions SET status=?,ref_json=?,wait_json=?,summary=?,handoff=? WHERE id=? AND task_id=? AND version=?';
      const stmt=db.prepare(sql),ref=JSON.stringify({kind:'learning.quiz',id:'actual-business-id'});
      assert.doesNotThrow(()=>stmt.run('succeeded',ref,null,'summary',0,'action','different-task',2));
      assert.doesNotThrow(()=>stmt.run('succeeded',ref,null,'summary',0,'action','matching-task',1));
      assert.doesNotThrow(()=>stmt.run('executing',ref,null,'summary',0,'action','matching-task',2));
      assert.throws(()=>stmt.run('succeeded',ref,null,'summary',0,'action','matching-task',2),/offline_injected_business_receipt_lost/);
      assert.equal(db.prepare('SELECT status FROM agent_actions').get().status,'executing');
      assert.equal(stmt.run('succeeded',ref,null,'summary',0,'action','matching-task',2).changes,1);
      assert.equal(db.prepare('SELECT status FROM agent_actions').get().status,'succeeded');
      const ledger=new Database(path.join(root,'offline-provider.sqlite'),{readonly:true});
      assert.equal(ledger.prepare('SELECT count(*) n FROM offline_fault_claims').get().n,1);
      assert.equal(ledger.prepare('SELECT count(*) n FROM requests').get().n,0);
      ledger.close();db.close();console.log('receipt_loss_exact_match_PASS');
    `], { encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_MODE: "offline", AGENT_TRIAL_DIR: root, APP_DATA_DIR: path.join(root, "data") } });
    expect(child.status, child.stderr).toBe(0); expect(child.stdout).toContain("receipt_loss_exact_match_PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("A2 narrowed-scope fixture selects only current returned paragraph addresses", () => {
  const narrowed = { ...scope, value: { materials: [{ ...scope.value.materials[0], paragraphs: [6] }] } };
  expect(decision(input("[A2:adjusted] 仅当前原文", [narrowed, navigation]))).toMatchObject({ tool: "learning.read_source", args: { paragraph: 6 } });
});
it("A2 offline policy observes failed actions instead of repeating rejected proposals or generation", () => {
  expect(decision(input("[A2:note] 尊重实际拒绝", [scope, navigation, { tool: "learning.append_note", status: "failed", value: { summary: "用户拒绝，未执行。" } }]))).toHaveProperty("wait.kind", "feedback");
  expect(decision(input("[A2:late] 实际解释失败", [scope, navigation, { tool: "learning.explain", status: "failed", value: {} }]))).toHaveProperty("wait.kind", "feedback");
});
it("offline fault claims are persistent and one-shot, and nonmatching pages are untouched", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "a2-fault-test-"));
  const db = new Database(path.join(root, "faults.sqlite"));
  try {
    faults.initializeFaultLedger(db);
    writeFileSync(path.join(root, "offline-control.json"), JSON.stringify({ version: 1, faults: [
      { id: "one-unknown", point: "provider", kind: "decision_fixture", pageId: "page-one", effect: "unknown" },
      { id: "one-known", point: "provider", kind: "quiz_generation_fixture", effect: "known_failure" },
    ] }));
    expect(await faults.providerFault(db, root, "decision_fixture", { authorizedScope: { pageId: "page-other" } })).toBeNull();
    await expect(faults.providerFault(db, root, "decision_fixture", { authorizedScope: { pageId: "page-one" } })).rejects.toThrow("offline_injected_unknown_transport");
    expect(await faults.providerFault(db, root, "decision_fixture", { authorizedScope: { pageId: "page-one" } })).toBeNull();
    expect(await faults.providerFault(db, root, "quiz_generation_fixture", {})).toBe("known_failure");
    expect(db.prepare("SELECT count(*) n FROM offline_fault_claims").get().n).toBe(2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
