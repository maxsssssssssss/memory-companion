// @vitest-environment node
import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { composedQuizRequest } from "../../src/lib/server/learning/quiz-composition";
import { ReferencedGeneratedQuiz } from "../../src/lib/domain/learning-quiz";
import { GeneratedNodeAnswer } from "../../src/lib/domain/learning-study";
const require = createRequire(import.meta.url);
const fixture = require("./offline-fixtures.cjs");
const materialId = "00000000-0000-4000-8000-000000000001";
const scopeResult = { tool: "learning.read_scope", status: "succeeded", value: { materials: [{ materialId, title: "合成教材 · 集合、交集与并集", paragraphs: [3, 4, 6] }] } };
const navigationResult = { tool: "learning.read_navigation", status: "succeeded", value: { chapters: [], history: [] } };
const decisionInput = (results: unknown[]) => ({ goal: "复习目标", observation: {}, results, tools: [] });

it("offline choice changes with the actual scope receipt; no synthetic state bypass", () => {
  expect(fixture.decision(decisionInput([])).tool).toBe("learning.read_scope");
  expect(fixture.decision(decisionInput([{ ...scopeResult, value: { materials: [] } }]))).toHaveProperty("wait");
  expect(fixture.decision(decisionInput([scopeResult])).tool).toBe("learning.read_navigation");
});

it("offline policy explicitly reads the saved answer and branches on returned score, independent of goal/account", () => {
  const results = [scopeResult, navigationResult, { tool: "learning.create_quiz", status: "succeeded", value: { quizId: "quiz", attemptId: "attempt", submitted: true } }];
  expect(fixture.decision(decisionInput(results))).toMatchObject({ tool: "learning.read_answers", args: { attemptId: "attempt" } });
  const answer = (correct: number) => ({ tool: "learning.read_answers", status: "succeeded", value: { attemptId: "attempt", score: { correct, total: 2 } } });
  expect(fixture.decision(decisionInput([...results, answer(0)]))).toMatchObject({ tool: "learning.read_source", args: { paragraph: 6 } });
  expect(fixture.decision(decisionInput([...results, answer(2)]))).toMatchObject({ tool: "learning.request_feedback" });
  expect(() => fixture.decision(decisionInput([...results, { ...answer(2), value: { attemptId: "different", score: { correct: 2, total: 2 } } }]))).toThrow();
});

it("hand-authored quiz responses pass the real compact codec and references-v2 schema", () => {
  const paragraphs = [
    "交集 A∩B 包含同时属于 A 和 B 的元素。若 A={1,2,3}，B={3,4}，则 A∩B={3}。",
    "并集 A∪B 包含属于 A 或属于 B 的元素，这里的或允许同时属于二者。若 A={1,2,3}，B={3,4}，则 A∪B={1,2,3,4}。",
  ].map((text, i) => ({ number: i + 3, text, referenceId: `ref_${String(i + 1).padStart(64, "0")}` }));
  const input = { count: 2, difficulty: "basic" as const, materials: [{ materialId, kind: "text" as const, title: "合成教材", paragraphs }], extras: [] };
  const scope = { accountId: "synthetic", pageId: "page", requestId: "request", expiresAt: Date.now() + 10000 };
  const codec = composedQuizRequest(input, scope), raw = fixture.quiz(codec.input);
  const result = ReferencedGeneratedQuiz.parse(codec.decode(raw, scope));
  expect(result.items).toHaveLength(2);
  expect(result.items.every(question => question.options.length === 3 && question.correctOptionId === "A")).toBe(true);
  expect(() => codec.decode({ ...raw, referenceScope: "f".repeat(64) }, scope)).toThrow();
});

it("offline explanation carries only supplied material and official source bindings", () => {
  const input = { question: "合成问题", materials: [{ materialId, paragraph: 3, text: "合成原文。" }] };
  expect(GeneratedNodeAnswer.parse(fixture.explanation(input))).toMatchObject({ supplements: [], items: [{ materialId, paragraph: 3 }] });
  expect(() => fixture.respond({ arbitrary: true })).toThrow("offline_unexpected_provider_request");
});

it("preloaded response fixture makes zero network requests and socket/API bypasses remain denied", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-offline-preload-"));
  try {
    const child = spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), "--require", path.resolve("scripts/agent-trial/offline-provider.cjs"), "--input-type=module", "-e", `
      import assert from 'node:assert/strict'; import net from 'node:net';
      await assert.rejects(fetch('https://synthetic.invalid/api/learning'), /offline_external_destination_denied/);
      assert.throws(() => net.createConnection({host:'synthetic.invalid', port:443}), /external socket blocked/);
      const result = await fetch('https://tokenhub.vision-intelligence.tech/v1/responses', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stream:true,store:false,max_output_tokens:100,input:[{role:'user',content:JSON.stringify({goal:'合成',observation:{},tools:[],results:[]})}]})});
      assert.equal(result.status,200); assert.match(await result.text(),/learning.read_scope/); console.log('offline_guard_and_fixture_PASS');
    `], { encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_MODE: "offline", AGENT_TRIAL_DIR: root, APP_DATA_DIR: path.join(root, "data") } });
    expect(child.status, child.stderr).toBe(0); expect(child.stdout).toContain("offline_guard_and_fixture_PASS");
    const Database = require("better-sqlite3"), db = new Database(path.join(root, "offline-provider.sqlite"), { readonly: true });
    try { expect(db.prepare("SELECT count(*) calls,sum(actual_network_requests) network FROM requests").get()).toEqual({ calls: 1, network: 0 }); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["real", "offline"] as const)("%s launch and preload refuse opposite-tier evidence before modifying the directory", mode => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-evidence-boundary-"));
  const opposite = mode === "real" ? "offline" : "real";
  const oppositeLedger = opposite === "offline" ? "offline-provider.sqlite" : "network-ledger.sqlite";
  const runtimePath = path.join(root, "runtime.json");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_MODE: mode, AGENT_TRIAL_DIR: root, APP_DATA_DIR: path.join(root, "data") };
  const preload = mode === "real" ? "guard.cjs" : "offline-provider.cjs";
  const commands = [
    ["--require", path.resolve("scripts/cloud/offline.cjs"), "--require", path.resolve("scripts/agent-trial", preload), "-e", "throw Error('unexpected_preload_success')"],
    ["--require", path.resolve("scripts/cloud/offline.cjs"), "scripts/agent-trial/launch.mjs", "start", ...(mode === "real" ? ["--real"] : [])],
  ];
  try {
    // Cover the label alone and the ledger alone. Neither may be silently
    // replaced, including before credential checks or server startup.
    for (const evidence of ["runtime", "ledger"]) {
      const filename = evidence === "runtime" ? runtimePath : path.join(root, oppositeLedger);
      writeFileSync(filename, evidence === "runtime" ? JSON.stringify({ evidenceMode: opposite, sentinel: "preserve-original" }) : "sentinel-ledger-not-opened");
      const names = readdirSync(root), before = readFileSync(filename);
      for (const args of commands) {
        const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000, env });
        expect(child.status).not.toBe(0); expect(child.stderr).toContain("agent_trial_evidence_mode_conflict");
        expect(readdirSync(root)).toEqual(names); expect(readFileSync(filename)).toEqual(before);
      }
      rmSync(filename);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
