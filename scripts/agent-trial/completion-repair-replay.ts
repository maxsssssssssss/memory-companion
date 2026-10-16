/**
 * Replays the supplied 2026-10-16 Windows W2 synthetic business evidence.
 * No Provider, credentials, reseed, score edits, or original database writes.
 *
 * node --require ./scripts/cloud/offline.cjs --import tsx \
 *   scripts/agent-trial/completion-repair-replay.ts \
 *   --evidence-dir output/agent-v1-1-windows-final-20261016 \
 *   --output-dir output/learning-completion-repair
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LearningCheckPurpose } from "../../src/lib/domain/learning-agent-completion";
import type { AgentContext } from "../../src/lib/server/agent/types";
import { AgentStore } from "../../src/lib/server/agent/store";
import { LearningRepository } from "../../src/lib/server/learning/repository";
import { assessLearningCompletion, guardLearningCompletionAction } from "../../src/lib/server/learning/agent-completion";
import { withLearningCompletionDecision } from "../../src/lib/server/learning/agent-context";

const sourceSha = "495c2e1fa81a892080f55cc5bcf56cbfe3ab48e6";
const taskId = "1cbcc1cb-820c-4551-9c9a-60bd3fc2e783";
const firstQuiz = "25b17c74-9e3d-416f-8c6c-e23fccf5bd4d";
const secondQuiz = "6de1a8ab-810c-4435-8b40-233f043897b4";
const thirdQuiz = "d364fdae-da9e-4aa7-8c00-780c4630f860";
type ManifestEntry = { path: string; bytes: number; sha256: string };
type SavedAction = { id: string; tool: string; args_json: string; created_at: string; status: string };
type Provenance = { accountId: string; pageId: string; sourceSha: string; sourceTaskId: string;
  credentialsCopied: boolean; networkLedgerCopied: boolean; copiedFiles: Record<string, { bytes: number; sha256: string }> };
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const contained = (base: string, target: string) => {
  const relative = path.relative(base, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const options = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert(["--evidence-dir", "--output-dir"].includes(key) && value && !value.startsWith("--"), "Expected explicit --evidence-dir and optional --output-dir");
  assert(!options.has(key), "Duplicate option");
  options.set(key, value);
}
assert(options.has("--evidence-dir"), "Supply the complete evidence package; synthetic replacements are not accepted");
const evidenceRoot = fs.realpathSync(path.resolve(options.get("--evidence-dir")!));
const outputRoot = path.resolve(options.get("--output-dir") ?? "output/learning-completion-repair");
assert(outputRoot !== evidenceRoot && !contained(evidenceRoot, outputRoot), "Write results outside the original evidence directory");
fs.mkdirSync(outputRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(outputRoot, "original-w2-"));
let fetchAttempts = 0, modelCalls = 0, toolGenerationCalls = 0;
globalThis.fetch = async () => { fetchAttempts++; throw Error("Original evidence replay forbids every fetch"); };
const checks: string[] = [];
function check(label: string, run: () => void) { run(); checks.push(label); }
let learning: LearningRepository | undefined, store: AgentStore | undefined;
const details: Record<string, unknown> = {};
const manifest = read<ManifestEntry[]>(path.join(evidenceRoot, "FILES_SHA256.json"));
function verifyPackage() {
  for (const entry of manifest) {
    const file = path.resolve(evidenceRoot, entry.path);
    assert(contained(evidenceRoot, file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), "Manifest path must be a contained regular file");
    assert.equal(fs.statSync(file).size, entry.bytes, `Evidence length changed: ${entry.path}`);
    assert.equal(digest(file), entry.sha256, `Evidence hash changed: ${entry.path}`);
  }
}
async function main() {
  console.log("[Completion repair 1/5] verify complete evidence and original ledger");
  check("Every supplied manifest entry matches its immutable bytes", verifyPackage);
  const provenance = read<Provenance>(path.join(evidenceRoot, "deterministic-replay-data/provenance.json"));
  const ledger = read<{ summary: Record<string, unknown>; rows: Array<{ state: string; status: number; input_tokens: number; output_tokens: number }>; agentCalls: unknown[] }>(path.join(evidenceRoot, "network-ledger-export.json"));
  check("Original 17 completed requests and usage totals remain unchanged", () => {
    assert.equal(ledger.rows.length, 17); assert.equal(ledger.agentCalls.length, 17);
    assert(ledger.rows.every(row => row.status === 200 && row.state === "completed"));
    assert.equal(ledger.rows.reduce((sum, row) => sum + row.input_tokens, 0), 98533);
    assert.equal(ledger.rows.reduce((sum, row) => sum + row.output_tokens, 0), 6734);
    assert.equal(ledger.summary.authorizedMaximum, 200); assert.equal(ledger.summary.effectiveGuardMaximum, 36);
    assert.equal(ledger.summary.remainingAuthorization, 183); assert.equal(ledger.summary.remainingGuard, 19);
  });
  details.originalLedger = ledger.summary;
  const records = read<Array<{ account: string; tables: { agent_actions: SavedAction[]; agent_tasks: Array<{ id: string; status: string }> } }>>(path.join(evidenceRoot, "business-records.json"));
  const accountA = records.find(record => record.account === "A"), accountB = records.find(record => record.account === "B");
  assert(accountA && accountB);
  check("W1/W3 have no saved action; their original rejected tool/args remain unavailable", () => {
    assert.equal(accountA.tables.agent_actions.length, 0);
    assert.equal(accountA.tables.agent_tasks.length, 2);
    assert(accountA.tables.agent_tasks.every(task => task.status === "needs_attention"));
    const gap = read<{ rawRealResponseAvailable: boolean; canIdentifyW1OrW3ExactToolOrParameter: boolean }>(path.join(evidenceRoot, "schema-contract-gap.json"));
    assert.equal(gap.rawRealResponseAvailable, false); assert.equal(gap.canIdentifyW1OrW3ExactToolOrParameter, false);
  });
  const secondAction = accountB.tables.agent_actions.find(action => action.id === `${taskId}:9`);
  const thirdAction = accountB.tables.agent_actions.find(action => action.id === `${taskId}:12`);
  assert(secondAction && thirdAction);
  details.originalTimeline = accountB.tables.agent_actions.map(({ id, tool, status, created_at }) => ({ id, tool, status, created_at }));
  const source = path.join(evidenceRoot, "deterministic-replay-data/users", provenance.accountId);
  const destination = path.join(runRoot, "account");
  check("Only the explicitly supplied synthetic account databases are copied", () => {
    assert.equal(provenance.sourceSha, sourceSha); assert.equal(provenance.sourceTaskId, taskId);
    assert.equal(provenance.credentialsCopied, false); assert.equal(provenance.networkLedgerCopied, false);
    assert(contained(evidenceRoot, source));
    const allowed = /^(?:learning-organizer|agent-tasks|agent-checkpoints)\.sqlite(?:-wal|-shm)?$/;
    for (const file of fs.readdirSync(source)) assert(allowed.test(file), "Unexpected file in the synthetic account copy");
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  });
  learning = new LearningRepository(destination, provenance.accountId);
  store = AgentStore.open(path.join(destination, "agent-tasks.sqlite"));
  const task = store.getTask(provenance.accountId, taskId);
  assert.equal(task.resourceId, provenance.pageId);
  details.currentTaskMetadata = { status: task.status, version: task.version, wait: task.wait, budget: task.budget,
    meaning: "The latest original task metadata is used unchanged for every projection; historical task status or budget counters are not reconstructed." };
  const repository = learning;
  const facts = () => ["learning_agent_artifacts", "learning_quiz_runs", "learning_quiz_attempts", "learning_materials"].map(table => ({ table,
    rows: repository.database.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all() }));
  const originalFacts = facts();
  const ctxFor = (action: SavedAction): AgentContext => ({ task, actionId: action.id, signal: new AbortController().signal,
    assertActive: async () => {}, call: async () => { toolGenerationCalls++; throw Error("Replay must not invoke generation"); } });
  console.log("[Completion repair 2/5] assess exact current snapshot, including the third pending group");
  const current = assessLearningCompletion(repository, task);
  check("Original correct source-mismatched answer stays excluded; later valid answer stays eligible", () => {
    const counting = current.objectives.find(objective => objective.id === "dedupe_union_count");
    assert(counting);
    assert.equal(counting.status, "uncertain"); assert.equal(counting.unresolvedErrors.length, 0);
    const old = counting.evidence.find(evidence => evidence.ref.quizId === firstQuiz && evidence.ref.questionIndex === 1);
    const replacement = counting.evidence.find(evidence => evidence.ref.quizId === secondQuiz);
    assert(old && replacement); assert.equal(old.correct, true); assert.equal(old.quality, "invalid"); assert.equal(old.eligible, false);
    assert.equal(old.diagnosticCode, "plan_source_mismatch");
    assert.equal(replacement.correct, true); assert.equal(replacement.eligible, true); assert.equal(replacement.independentInApp, true);
    assert(current.objectives.every(objective => objective.requirements.every(requirement => requirement.supported)));
  });
  check("Current snapshot honestly remains partial with its original unanswered third Quiz", () => {
    assert.equal(current.outcome, "partial"); assert.equal(current.canAutoFinish, false);
    assert(current.pending.includes("等待实际作答"));
    assert(current.objectives.some(objective => objective.evidence.some(evidence => evidence.ref.quizId === thirdQuiz && evidence.quality === "pending" && !evidence.submitted)));
    assert.equal(current.technicalBlocker?.kind, "plan_source_mismatch");
  });
  details.currentSnapshot = current;
  // A TEMP VIEW selects immutable original artifact rows existing before the
  // original action timestamp. It does not UPDATE/DELETE any business row or
  // synthesize a historical task state. Actual completed attempt facts are used
  // only when their original artifact and completion predate the cutoff.
  const projections: unknown[] = [];
  for (const [label, action, expectedQuizCount] of [["before_second_generation", secondAction, 1], ["before_third_generation", thirdAction, 2]] as const) {
    console.log(`[Completion repair 3/5] temporal artifact projection: ${label}`);
    assert(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(action.created_at));
    repository.database.exec(`CREATE TEMP VIEW completion_replay_artifacts AS SELECT rowid AS rowid,* FROM main.learning_agent_artifacts WHERE created_at < '${action.created_at}'`);
    // Production repository constructors idempotently ensure main-table indexes.
    // Keep those operations on the copied main schema; route only SELECTs over
    // artifacts through the temporal view, preserving original row values/order.
    const projectedDatabase = new Proxy(repository.database, { get(target, key) {
      if (key === "prepare") return (sql: string) => target.prepare(/^\s*SELECT\b/i.test(sql)
        ? sql.replace(/\blearning_agent_artifacts\b/g, "completion_replay_artifacts") : sql);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const projectedLearning = new Proxy(repository, { get(target, key) { return key === "database" ? projectedDatabase : Reflect.get(target, key); } });
    try {
      const assessment = assessLearningCompletion(projectedLearning, task);
      const visible = projectedDatabase.prepare("SELECT id FROM learning_agent_artifacts WHERE kind='quiz'").all() as Array<{ id: string }>;
      check(`${label}: only original completed attempts before this boundary are visible`, () => {
        assert.equal(visible.length, expectedQuizCount);
        for (const { id } of visible) {
          const attempt = repository.database.prepare("SELECT completed_at FROM learning_quiz_attempts WHERE quiz_id=?").get(id) as { completed_at: string | null };
          assert(attempt.completed_at && attempt.completed_at < action.created_at);
        }
        assert(!assessment.pending.includes("等待实际作答"));
        assert.equal(assessment.technicalBlocker?.kind, "plan_source_mismatch");
        assert.equal(assessment.canAutoFinish, false); assert.notEqual(assessment.outcome, "check_passed");
        if (expectedQuizCount === 2) assert(assessment.objectives.every(objective => objective.requirements.every(requirement => requirement.supported)));
      });
      const purpose = (JSON.parse(action.args_json) as { purpose: LearningCheckPurpose }).purpose;
      const guarded = guardLearningCompletionAction(projectedLearning, ctxFor(action), "quiz", purpose);
      check(`${label}: original generation request is handed back before generating`, () => {
        assert(guarded.wait); assert.match(guarded.wait, /调整/); assert.equal(toolGenerationCalls, 0);
      });
      const decide = withLearningCompletionDecision(projectedLearning, async () => { modelCalls++; throw Error("Technical blockage must not call the model"); });
      const decision = await decide({ task, observation: {}, results: [], tools: [] }, ctxFor(action));
      check(`${label}: decision gate requests precise user adjustment with zero model calls`, () => {
        assert("tool" in decision && decision.tool === "learning.request_feedback"); assert.equal(modelCalls, 0);
      });
      projections.push({ label, cutoff: action.created_at, actualActionId: action.id, visibleQuizIds: visible.map(row => row.id),
        mechanism: "Time-bounded TEMP VIEW of unchanged persisted artifacts, including evidence proposals/feedback; not a historical full-database snapshot. Latest original task state and all business rows remain unchanged.", assessment, generationGuard: guarded, decision });
    } finally { repository.database.exec("DROP VIEW temp.completion_replay_artifacts"); }
  }
  details.temporalProjections = projections;
  console.log("[Completion repair 4/5] verify unchanged business facts, original package and zero calls");
  check("No original question, options, score, attempt, material, plan or artifact row was edited", () => assert.deepEqual(facts(), originalFacts));
  check("Restoring full visibility reproduces the same current pending assessment", () => assert.deepEqual(assessLearningCompletion(repository, task), current));
  check("No model, generator, or fetch was invoked", () => { assert.equal(modelCalls, 0); assert.equal(toolGenerationCalls, 0); assert.equal(fetchAttempts, 0); });
  check("All original evidence files still match their supplied manifest", verifyPackage);
}
main().then(() => {
  console.log(`[Completion repair 5/5] PASS; checks=${checks.length}; Provider=0; current original task is still partial/pending`);
}, error => {
  details.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  console.error("[Completion repair] FAIL", details.error);
}).finally(() => {
  store?.close(); learning?.database.close();
  const result = { status: process.exitCode ? "FAIL" : "PASS", sourceSha, taskId,
    evidenceTier: "offline_formal_replay_of_real_provider_synthetic_business_state", checks, checkCount: checks.length,
    originalManifestFiles: manifest.length, providerRequests: 0, modelCalls, toolGenerationCalls, fetchAttempts,
    w1W3OriginalRejectedDecision: "UNAVAILABLE; original tool/args and exact validation issue cannot be reconstructed",
    limitations: "Temporal projection is an offline verification, not time travel or a Windows recovery execution. No original plan source correction or current pending-task PASS is claimed.",
    runRoot, ...details };
  fs.writeFileSync(path.join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outputRoot, "original-w2-repair-result.json"), JSON.stringify(result, null, 2));
});
