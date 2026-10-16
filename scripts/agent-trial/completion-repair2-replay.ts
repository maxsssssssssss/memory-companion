/** Offline replay of the supplied b7d8fcc Windows PUBLIC business projection.
 * This is not a Windows database/raw-provider-response replay. It preserves the
 * supplied text, identities, plan and student actions; SQLite scores are produced
 * by the existing Quiz service. Use completion-repair-replay.ts for the separate
 * 129-file original W2 database package. Every output lives outside the evidence.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentTask } from "../../src/lib/domain/agent";
import type { LearningAgentSelection, LearningAgentScope } from "../../src/lib/domain/learning-agent";
import type { LearningReviewPlan, LearningEvidenceProposal, LearningCompletionAssessment } from "../../src/lib/domain/learning-agent-completion";
import type { QuizAttemptView, QuizActionInput } from "../../src/lib/domain/learning-quiz";
import type { AgentContext } from "../../src/lib/server/agent/types";
import { LearningRepository, LearningError } from "../../src/lib/server/learning/repository";
import { LearningQuizRepository } from "../../src/lib/server/learning/quiz-repository";
import { LearningAgentRepository } from "../../src/lib/server/learning/agent-repository";
import { freezeLearningAgentScope } from "../../src/lib/server/learning/agent-scope";
import { establishLearningReviewPlan, validateLearningExplanationFeedback, assessLearningCompletion, guardLearningCompletionAction, recordLearningEvidenceProposal, readLearningReviewPlan } from "../../src/lib/server/learning/agent-completion";
import { withLearningCompletionDecision } from "../../src/lib/server/learning/agent-context";
import { prepareLearningPlanSourceAdjustment, materializeLearningPlanSourceAdjustment } from "../../src/lib/server/learning/agent-plan-sources";
import { AgentRuntime } from "../../src/lib/server/agent/runtime";
import { AgentStore } from "../../src/lib/server/agent/store";
import { createLearningAgentScenario } from "../../src/lib/server/learning/agent-scenario";

type ManifestEntry = { path: string; bytes: number; sha256: string };
type Material = { id: string; title: string; text: string };
type W1Input = { repairSha: string; task: Pick<AgentTask, "id" | "accountId" | "resourceId" | "goal" | "version" | "status" | "wait" | "budget" | "usage">;
  selection: LearningAgentSelection; material: Material; plan: LearningReviewPlan; explanation: { id: string; items: Array<{ materialId: string; paragraph: number }>;
    reviewContext: { purpose: import("../../src/lib/domain/learning-agent-completion").LearningCheckPurpose } };
  feedback: { explanationId: string; outcome: "resolved" }; roundId: string };
type W3Input = { repairSha: string; material: Material; task: Pick<AgentTask, "id" | "version" | "goal" | "status" | "wait" | "usage"> & {
  completion: LearningCompletionAssessment & { plan: LearningReviewPlan } }; attempt: QuizAttemptView };
const read = <T>(file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const contained = (base: string, target: string) => { const relative = path.relative(base, target); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };
const options = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert(["--evidence-dir", "--output-dir"].includes(key) && value && !value.startsWith("--") && !options.has(key), "Expected unique --evidence-dir and --output-dir");
  options.set(key, value);
}
assert(options.has("--evidence-dir"), "Supply the complete 137-entry repair evidence package");
const evidenceRoot = fs.realpathSync(path.resolve(options.get("--evidence-dir")!));
const outputRoot = path.resolve(options.get("--output-dir") ?? "output/learning-completion-repair2/replay");
assert(outputRoot !== evidenceRoot && !contained(evidenceRoot, outputRoot), "Do not write into the supplied evidence");
fs.mkdirSync(outputRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(outputRoot, "public-projection-"));
const manifest = read<{ sha: string; files: ManifestEntry[] }>(path.join(evidenceRoot, "FILES_SHA256.json"));
const checks: string[] = [], details: Record<string, unknown> = {};
let fetchAttempts = 0, modelCalls = 0, generationCalls = 0;
globalThis.fetch = async () => { fetchAttempts++; throw Error("Public evidence replay forbids network requests"); };
const check = (label: string, work: () => void) => { work(); checks.push(label); };
function verifyPackage() {
  assert.equal(manifest.sha, "b7d8fcc1ada69ffe5c76402cd9f5fe5d823aceee"); assert.equal(manifest.files.length, 137);
  for (const entry of manifest.files) {
    const file = path.resolve(evidenceRoot, entry.path);
    assert(contained(evidenceRoot, file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
    assert.equal(fs.statSync(file).size, entry.bytes, entry.path); assert.equal(digest(file), entry.sha256, entry.path);
  }
}
function fixture(name: string, task: AgentTask, material: Material, selection: LearningAgentSelection) {
  const learning = new LearningRepository(path.join(runRoot, name), task.accountId);
  learning.create({ id: task.resourceId, title: "[原公开证据离线回放] " + name });
  learning.saveMaterials(task.resourceId, [{ id: material.id, title: material.title, kind: "text", filename: null, bytes: Buffer.from(material.text) }]);
  task.scope = { ...freezeLearningAgentScope(learning, task.resourceId, selection), completionVersion: 1 };
  return { learning, task, artifacts: new LearningAgentRepository(learning), ctx: { task, actionId: "public-evidence-replay", signal: new AbortController().signal,
    assertActive: async () => {}, call: async () => { generationCalls++; throw Error("No model/generation allowed"); } } satisfies AgentContext };
}
function persist(learning: LearningRepository, task: AgentTask, id: string, kind: "explanation" | "quiz" | "evidence_proposal", body: unknown) {
  const artifacts = new LearningAgentRepository(learning), scope = task.scope as { fingerprint: string; selection: LearningAgentSelection };
  artifacts.reserve({ id, kind, taskId: task.id, taskVersion: task.version, pageId: task.resourceId, actionId: `public-import:${id}`,
    binding: scope.fingerprint, materialIds: scope.selection.materialIds });
  artifacts.complete(task.resourceId, task.id, id, body);
}
async function main() {
  console.log("[Repair2 evidence 1/4] Validate complete supplied package and the unchanged 35/36 ledger projection");
  check("All 137 original manifest entries match exact size and SHA-256", verifyPackage);
  const accounting = read<{ budget: { used: number; remaining: number; effectiveOfficialGuardMaximum: number; authorizedMaximum: number; originalLedgerReused: boolean };
    total: { count: number; inputTokens: number; outputTokens: number }; repair: { count: number }; rows: Array<{ id: number; state: string; status: number }> }>(path.join(evidenceRoot, "provider-accounting.json"));
  check("Windows ledger remains 35/36; all 18 repair requests are completed, with no Cloud request", () => {
    assert.deepEqual(accounting.total, { count: 35, inputTokens: 180126, outputTokens: 11157, missingUsage: 0, states: { completed: 35 } });
    assert.equal(accounting.budget.used, 35); assert.equal(accounting.budget.remaining, 1); assert.equal(accounting.budget.effectiveOfficialGuardMaximum, 36);
    assert.equal(accounting.budget.authorizedMaximum, 200); assert.equal(accounting.budget.originalLedgerReused, true); assert.equal(accounting.repair.count, 18);
    assert.equal(accounting.rows.length, 18); assert(accounting.rows.every(row => row.state === "completed" && row.status === 200));
  });
  details.windowsAccounting = accounting.budget;
  const w1 = read<W1Input>(path.join(evidenceRoot, "w1-explanation-source-mismatch-input.json"));
  console.log("[Repair2 evidence 2/4] Preserve actual W1 negative confirmation, now expose its explanation source blocker");
  const one = fixture("w1", { ...w1.task, scenario: "learning.adaptive-review.v1", scope: {}, actions: [], createdAt: "offline-import", updatedAt: "offline-import" }, w1.material, w1.selection);
  try {
    const plan = establishLearningReviewPlan(one.learning, one.ctx, { kind: w1.plan.kind, objectives: w1.plan.objectives });
    check("W1 original frozen plan and source fingerprint are unchanged", () => assert.deepEqual(plan, w1.plan));
    persist(one.learning, one.task, w1.explanation.id, "explanation", w1.explanation);
    check("W1 entire actual explanation and provenance are unchanged in the isolated artifact store", () =>
      assert.deepEqual(JSON.parse(one.artifacts.get(one.task.resourceId, one.task.id, w1.explanation.id)!.body_json!), w1.explanation));
    check("W1 mismatched plan still rejects explicit resolved with the original 409 safety code", () => {
      assert.throws(() => validateLearningExplanationFeedback(one.learning, one.task, w1.feedback, w1.roundId), error => error instanceof LearningError && error.status === 409 && error.code === "agent_completion_feedback_invalid");
    });
    const assessment = assessLearningCompletion(one.learning, one.task);
    check("W1 explanation mismatch is now visible without false completion or feedback write", () => {
      assert.equal(assessment.technicalBlocker?.kind, "plan_source_mismatch"); assert.deepEqual(assessment.technicalBlocker.objectiveIds, [w1.plan.objectives[0].id]);
      assert.equal(assessment.canAutoFinish, false); assert.equal(assessment.outcome, "insufficient");
      assert.equal(one.artifacts.list(one.task.resourceId, one.task.id).filter(row => row.kind === "explanation_feedback").length, 0);
    });
    const guarded = guardLearningCompletionAction(one.learning, one.ctx, "explanation", w1.explanation.reviewContext.purpose);
    check("W1 prepared explanation is handed back before any further generation", () => { assert(guarded.wait); assert.equal(generationCalls, 0); });
    const decision = await withLearningCompletionDecision(one.learning, async () => { modelCalls++; throw Error("No model call permitted"); })({ task: one.task, observation: {}, results: [], tools: [] }, one.ctx);
    check("W1 technical handback uses the existing feedback action at zero calls", () => assert("tool" in decision && decision.tool === "learning.request_feedback"));
    details.w1 = { originalTaskId: one.task.id, originalPlan: w1.plan, actualExplanationId: w1.explanation.id, assessment, guarded, decision };
  } finally { one.learning.close(); }
  console.log("[Repair2 evidence 3/4] Replay both unchanged W3 questions and original stable-ID student actions via real Quiz storage");
  const w3 = read<W3Input>(path.join(evidenceRoot, "w3-submitted-evidence.json"));
  const three = fixture("w3", { ...w3.task, accountId: w1.task.accountId, resourceId: w1.task.resourceId, scenario: "learning.adaptive-review.v1", scope: {},
    actions: [], budget: w1.task.budget, createdAt: "offline-import", updatedAt: "offline-import" }, w3.material, w1.selection);
  try {
    const { learning, task, ctx } = three, quizzes = new LearningQuizRepository(learning), plan = establishLearningReviewPlan(learning, ctx, { kind: w3.task.completion.plan.kind, objectives: w3.task.completion.plan.objectives });
    check("W3 original fixed plan and source fingerprint are unchanged", () => assert.deepEqual(plan, w3.task.completion.plan));
    quizzes.begin(task.resourceId, { id: w3.attempt.quizId, settings: { materialIds: [w3.material.id], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 2, difficulty: "standard" } }, 24000);
    // The portable file has public saved content, not the original codec envelope
    // or review annotations. Replay the established saved-content contract. Never
    // pretend generated evidenceIds or a model rationale were in the source file.
    quizzes.complete(task.resourceId, w3.attempt.quizId, { title: w3.attempt.title, reason: null, items: w3.attempt.questions.map(question => {
      assert(question.feedback);
      return { stem: question.stem, kind: question.kind, options: question.options.map(option => ({ id: option.id, text: option.text,
        reason: question.feedback!.reasons.find(reason => reason.id === option.id)!.reason })), correctOptionId: question.feedback.correctOptionId,
        explanation: question.feedback.explanation, hint: question.hint ?? null,
        sources: question.feedback.sources.map(source => { assert(source.kind === "material"); return { kind: "material", materialId: source.materialId, paragraph: source.paragraph }; }) };
    }) });
    let attempt = quizzes.startAttempt(task.resourceId, { id: w3.attempt.id, quizId: w3.attempt.quizId, mode: w3.attempt.mode });
    check("W3 before submission keeps correct answers and grades hidden", () => { assert.equal(attempt.score, null); assert(attempt.questions.every(question => !question.feedback)); });
    const act = (action: QuizActionInput["action"], question: number, optionId: string | null = null) => {
      attempt = quizzes.act(task.resourceId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action, question, optionId });
    };
    for (const question of w3.attempt.questions) {
      assert.equal(question.progress.revealed, false); assert.equal(question.progress.skipped, false); assert.equal(question.progress.submitted, true);
      if (question.progress.hinted) act("hint", question.index);
      act("choose", question.index, question.progress.optionId);
    }
    act("finish", 0);
    check("W3 real scoring reproduces original 1/2, hinted 1, unassisted 0 without writing any score", () => assert.deepEqual(attempt.score, w3.attempt.score));
    check("Both original W3 question texts, options, reasons, correct IDs and source hashes are preserved", () => {
      assert.deepEqual(attempt.questions.map(question => ({ stem: question.stem, kind: question.kind, options: question.options.map(({ id, text }) => ({ id, text })),
        progress: question.progress, feedback: question.feedback })), w3.attempt.questions.map(question => ({ stem: question.stem, kind: question.kind,
        options: question.options.map(({ id, text }) => ({ id, text })), progress: question.progress, feedback: question.feedback })));
    });
    persist(learning, task, attempt.quizId, "quiz", { attemptId: attempt.id });
    // Public invalid evidence does not retain original review rationale. Its exact
    // reference/objective/role is available. The following explicit offline
    // association marker is test metadata, never claimed to be a DS response.
    for (const objective of w3.task.completion.objectives) for (const evidence of objective.evidence) {
      const proposal: LearningEvidenceProposal = { ref: evidence.ref, objectiveId: evidence.objectiveId, role: evidence.role,
        rationale: "[离线公开投影关联] 仅重放原公开证据的题目、目标与检查角度；原模型逐题关联理由未提供。", relevance: "supported", relation: evidence.relation,
        priorEvidenceRefs: evidence.priorEvidenceRefs, contentStatus: "no_known_issue" };
      persist(learning, task, randomUUID(), "evidence_proposal", proposal);
    }
    const assessment = assessLearningCompletion(learning, task), proof = assessment.objectives.flatMap(objective => objective.evidence).sort((a, b) => a.ref.questionIndex - b.ref.questionIndex);
    check("W3 actual hinted-correct and wrong facts remain separate from the source-association blocker", () => {
      assert.equal(proof.length, 2); assert.equal(proof[0].correct, true); assert.equal(proof[0].hintedBeforeSubmission, true); assert.equal(proof[0].independentInApp, false);
      assert.equal(proof[1].correct, false); assert.equal(proof[1].hintedBeforeSubmission, false); assert(proof.every(item => item.diagnosticCode === "plan_source_mismatch" && !item.eligible));
    });
    check("W3 cannot pass or mistake source linkage for student ignorance", () => {
      assert.equal(assessment.technicalBlocker?.kind, "plan_source_mismatch"); assert.equal(assessment.canAutoFinish, false); assert.notEqual(assessment.outcome, "check_passed");
      assert(assessment.objectives.every(objective => objective.unresolvedErrors.length === 0));
    });
    const decision = await withLearningCompletionDecision(learning, async () => { modelCalls++; throw Error("No model call permitted"); })({ task, observation: {}, results: [], tools: [] }, ctx);
    check("W3 unchanged source mismatch hands back at zero calls and creates no additional Quiz", () => {
      assert("tool" in decision && decision.tool === "learning.request_feedback"); assert.equal(quizzes.list(task.resourceId).length, 1); assert.equal(modelCalls, 0);
    });
    // This continuation is explicitly LOCAL: public Quiz/plan records above are
    // imported evidence; the Agent task is created through its normal store with
    // a fresh zero-call ledger. It does not copy/reset Windows task usage or claim
    // its original checkpoint is available in this portable package.
    const localStore = AgentStore.open(path.join(runRoot, "w3", "agent-tasks.sqlite"));
    const scenario = createLearningAgentScenario(learning);
    const runtime = new AgentRuntime({ store: localStore, checkpointPath: path.join(runRoot, "w3", "agent-checkpoints.sqlite"), scenario,
      decision: async () => { modelCalls++; throw Error("Explicit source recovery must not request a model"); } });
    try {
      const before = localStore.createTask({ id: task.id, accountId: task.accountId, resourceId: task.resourceId, scenario: scenario.id,
        goal: task.goal, scope: task.scope, budget: task.budget });
      const oldPlanRow = three.artifacts.get(task.resourceId, task.id, plan.id)!;
      const originalQuizRows = learning.database.prepare("SELECT * FROM learning_quiz_runs WHERE id=?").get(attempt.quizId);
      const originalAttemptRows = learning.database.prepare("SELECT * FROM learning_quiz_attempts WHERE id=?").get(attempt.id);
      const scope: LearningAgentScope = { ...freezeLearningAgentScope(learning, task.resourceId, { ...w1.selection, includeHistory: true }), completionVersion: 1 };
      const corrections = plan.objectives.map((objective, index) => ({ objectiveId: objective.id,
        sources: (index === 0 ? [5, 7] : [6, 7]).map(paragraph => ({ materialId: w3.material.id, paragraph })) }));
      scope.planSourceAdjustment = prepareLearningPlanSourceAdjustment(learning, before, { goal: before.goal, scope }, corrections);
      const adjusted = await runtime.adjust(task.accountId, task.id, { expectedVersion: 1, eventId: randomUUID(), goal: task.goal, scope });
      const nextCtx: AgentContext = { ...ctx, task: adjusted, actionId: "public-w3-explicit-source-recovery",
        assertActive: async () => { localStore.assertVersion(task.accountId, task.id, 2); } };
      await materializeLearningPlanSourceAdjustment(learning, nextCtx);
      await materializeLearningPlanSourceAdjustment(learning, nextCtx);
      const correctedPlan = readLearningReviewPlan(learning, adjusted)!;
      check("W3 local explicit adjustment uses real version 2, preserves budget, goal/requirements and immutable old plan", () => {
        assert.equal(before.usage.calls, 0); assert.equal(adjusted.version, 2); assert.deepEqual(adjusted.usage, before.usage); assert.deepEqual(adjusted.budget, before.budget);
        assert.equal(correctedPlan.kind, plan.kind); assert.equal(correctedPlan.goal, plan.goal);
        assert.deepEqual(correctedPlan.objectives, plan.objectives.map((objective, index) => ({ ...objective, sources: corrections[index].sources })));
        assert.deepEqual(three.artifacts.get(task.resourceId, task.id, plan.id), oldPlanRow);
        assert.equal(three.artifacts.list(task.resourceId, task.id).filter(row => row.kind === "review_plan").length, 2);
      });
      let staleRejected = false;
      try { await runtime.submitEvent(task.accountId, task.id, { id: randomUUID(), kind: "quiz_submission", refId: attempt.id, version: 1 }, { expectedVersion: 1 }); }
      catch { staleRejected = true; }
      check("W3 old-version quiz event cannot advance the adjusted task", () => assert.equal(staleRejected, true));
      const reader = scenario.tools["learning.read_answers"], receipt = await reader.execute({ attemptId: attempt.id }, nextCtx);
      const answerView = await reader.readResult!({ id: "public-w3-read-answer", version: 2, tool: "learning.read_answers", status: "succeeded",
        resultRef: receipt.ref, summary: receipt.summary, createdAt: new Date().toISOString() }, nextCtx);
      check("W3 explicit history permission allows the original formal submitted answer to be reread", () => {
        assert.equal(receipt.ref?.id, attempt.id); assert(answerView && typeof answerView === "object");
      });
      for (const objective of w3.task.completion.objectives) for (const evidence of objective.evidence) {
        recordLearningEvidenceProposal(learning, { ...nextCtx, actionId: `public-w3-reassociate-${evidence.ref.questionIndex}` }, {
          ref: evidence.ref, objectiveId: evidence.objectiveId, role: evidence.role,
          rationale: "[离线明确恢复关联] 同一原题经授权重新读取，仅恢复原目标与实际教材段落的关联；不声称独立正确、迁移或误解已修正。",
          relevance: "supported", relation: evidence.relation, priorEvidenceRefs: evidence.priorEvidenceRefs, contentStatus: "no_known_issue",
        });
      }
      const restored = assessLearningCompletion(learning, adjusted), restoredEvidence = restored.objectives.flatMap(objective => objective.evidence).sort((a, b) => a.ref.questionIndex - b.ref.questionIndex);
      check("W3 corrected association removes technical blocking but retains hint and actual wrong counterevidence", () => {
        assert.equal(restored.technicalBlocker, undefined); assert.equal(restored.canAutoFinish, false); assert.notEqual(restored.outcome, "check_passed");
        assert.equal(restoredEvidence.length, 2); assert(restoredEvidence.every(item => item.eligible && item.historical && item.quality === "tentative"));
        assert.equal(restoredEvidence[0].correct, true); assert.equal(restoredEvidence[0].hintedBeforeSubmission, true); assert.equal(restoredEvidence[0].independentInApp, false);
        assert.equal(restoredEvidence[1].correct, false); assert.equal(restoredEvidence[1].hintedBeforeSubmission, false);
        assert(restored.objectives[1].unresolvedErrors.some(ref => ref.attemptId === attempt.id && ref.questionIndex === 1));
        assert(restored.objectives.every(objective => objective.requirements.every(requirement => !requirement.supported)));
      });
      const explanationGuard = guardLearningCompletionAction(learning, nextCtx, "explanation", { objectiveIds: [plan.objectives[1].id], role: "followup", method: "contrast",
        purpose: "[离线目的] 对照原材料第6、7段解释直接相加的适用条件，处理已保存的原第二题错误；不宣称已纠正。",
        priorEvidenceRefs: [restoredEvidence[1].ref] });
      check("W3 lawful targeted explanation is allowed after repair, without random new questions or fabricated success", () => {
        assert.equal(explanationGuard.wait, undefined); assert.equal(explanationGuard.stop, undefined); assert(explanationGuard.purpose);
        assert.equal(quizzes.list(task.resourceId).length, 1); assert.deepEqual(quizzes.attempt(task.resourceId, attempt.id).score, w3.attempt.score);
        assert.deepEqual(learning.database.prepare("SELECT * FROM learning_quiz_runs WHERE id=?").get(attempt.quizId), originalQuizRows);
        assert.deepEqual(learning.database.prepare("SELECT * FROM learning_quiz_attempts WHERE id=?").get(attempt.id), originalAttemptRows);
        assert.equal(localStore.getTask(task.accountId, task.id).usage.calls, 0);
      });
      details.w3ExplicitLocalRecovery = { meaning: "Offline explicit versioned recovery of exact public Quiz content/actions; not original Windows task/checkpoint recovery or DS autonomy.",
        beforeLocalUsage: before.usage, windowsUsageNotImported: task.usage, adjustedVersion: adjusted.version, correctionSnapshot: scope.planSourceAdjustment,
        correctedPlan, assessment: restored, explanationGuard, providerRequests: 0 };
    } finally { runtime.close(); localStore.close(); }
    details.w3 = { originalTaskId: task.id, originalAttemptId: attempt.id, originalQuizId: attempt.quizId, score: attempt.score, assessment, decision,
      originalCompletedAt: w3.attempt.completedAt, offlineCompletedAt: attempt.completedAt,
      replayBoundary: "Exact public saved content and stable-ID actions; new SQLite/events/timestamps. Legacy saved-content publication, not unavailable original raw codec/review metadata. Association rationale is explicitly marked offline projection metadata." };
  } finally { three.learning.close(); }
  const budget = read<{ counts: Record<string, number>; knownUnknownSeparation: Record<string, unknown> }>(path.join(evidenceRoot, "w2-budget-state-diagnostic.json"));
  check("Original W2 budget evidence contains no emitted decision 14, no unknown call and no summary operation", () => {
    assert.equal(budget.counts.taskCalls, 16); assert.equal(budget.counts.currentVersionCalls, 1); assert.equal(budget.counts.decision14Calls, 0);
    assert.equal(budget.counts.summaryCalls, 0); assert.equal(budget.counts.summaryArtifacts, 0); assert.equal(budget.counts.unknownOrRunningTaskCalls, 0);
    assert.equal(budget.knownUnknownSeparation.nextDecisionBudgetRejected, true); assert.equal(budget.knownUnknownSeparation.summaryRequestSent, false);
  });
  details.w2BudgetOriginalFacts = budget;
  check("All original files remain unchanged after every replay", verifyPackage);
  check("No model, generator, Provider or fetch request was made", () => { assert.equal(fetchAttempts, 0); assert.equal(modelCalls, 0); assert.equal(generationCalls, 0); });
}
main().then(() => console.log(`[Repair2 evidence 4/4] PASS; checks=${checks.length}; Provider=0`), error => {
  details.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; console.error("[Repair2 evidence] FAIL", details.error);
}).finally(() => {
  const result = { status: process.exitCode ? "FAIL" : "PASS", sourceSha: manifest.sha, originalManifestFiles: manifest.files.length, checks, checkCount: checks.length,
    providerRequests: 0, fetchAttempts, modelCalls, generationCalls, originalAcceptanceDatabasesOpened: false,
    evidenceTier: "offline_replay_of_original_public_synthetic_business_projection",
    limitations: ["Original public projection, not a Windows database copy or unavailable raw Provider response.", "Original W1 invalid confirmation remains a negative safety case; explicit adjustment positive/API/UI evidence is reported separately.",
      "W3 original source mismatch remains preserved. Separately labeled local explicit v2 recovery changes only consented source links; original questions/assistance/wrong-answer facts and requirements remain unchanged.", "No Windows true DS recovery or human learning effect is claimed.", "Original W1 first failed explanation parser detail remains unavailable; Windows guard stays 35/36."],
    runRoot, ...details };
  fs.writeFileSync(path.join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outputRoot, "public-evidence-replay-result.json"), JSON.stringify(result, null, 2));
});
