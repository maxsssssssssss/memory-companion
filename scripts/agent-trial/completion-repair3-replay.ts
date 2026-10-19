/** Offline replay of the 24eead0 Windows public business evidence. No original
 * database, private tool arguments or raw Provider envelope is included. Import
 * only the supplied business text/IDs/answers, then submit the original stable-ID
 * choices through the real Quiz service. Added association metadata is explicitly
 * labelled as replay metadata, never represented as an original DS response. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentTask } from "../../src/lib/domain/agent";
import type { LearningAgentSelection } from "../../src/lib/domain/learning-agent";
import type { LearningReviewPlan, LearningCompletionAssessment, LearningEvidenceProposal, LearningCheckPurpose } from "../../src/lib/domain/learning-agent-completion";
import type { QuizAttemptView, QuizActionInput } from "../../src/lib/domain/learning-quiz";
import type { AgentContext } from "../../src/lib/server/agent/types";
import { LearningRepository, LearningError } from "../../src/lib/server/learning/repository";
import { LearningQuizRepository } from "../../src/lib/server/learning/quiz-repository";
import { LearningAgentRepository } from "../../src/lib/server/learning/agent-repository";
import { freezeLearningAgentScope } from "../../src/lib/server/learning/agent-scope";
import { establishLearningReviewPlan, validateLearningExplanationFeedback, assessLearningCompletion, recordLearningEvidenceProposal, guardLearningCompletionAction } from "../../src/lib/server/learning/agent-completion";
import { createLearningAgentScenario } from "../../src/lib/server/learning/agent-scenario";

type SourcePreview = { materialId: string; paragraph: number; title: string; text: string };
type PublicTask = Pick<AgentTask, "id" | "version" | "goal" | "status" | "wait" | "usage" | "budget" | "actions" | "endReason"> & {
  scope: LearningAgentSelection; completion: LearningCompletionAssessment & { plan: LearningReviewPlan };
  explanations: Array<{ id: string; text: string; sources: Array<{ materialId: string; paragraph: number }> }>;
  sourceAdjustment?: { sources: SourcePreview[] };
};
type Business = { sha: string; currentTasks: Record<"W1" | "W3" | "W2New" | "W2Original", PublicTask>;
  originalW3: PublicTask; publicAttempts: QuizAttemptView[];
  originalW3SubmittedEvidence: { attempt: QuizAttemptView; material: { id: string; title: string; text: string } };
};
type ManifestEntry = { path: string; bytes: number; sha256: string };
const read = <T>(file: string) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, "")) as T;
const hash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const within = (base: string, file: string) => { const relative = path.relative(base, file); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const [key, value] = [process.argv[i], process.argv[i + 1]];
  assert(["--evidence-dir", "--output-dir", "--phase"].includes(key) && value && !options.has(key), "Supply unique --evidence-dir/--output-dir/--phase values"); options.set(key, value);
}
assert(options.has("--evidence-dir"), "Supply the complete 257-entry public evidence package");
const evidenceRoot = fs.realpathSync(path.resolve(options.get("--evidence-dir")!));
const outputRoot = path.resolve(options.get("--output-dir") ?? "output/learning-completion-repair3/replay");
assert(outputRoot !== evidenceRoot && !within(evidenceRoot, outputRoot)); fs.mkdirSync(outputRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(outputRoot, "public-projection-"));
const phase = options.get("--phase") ?? "final"; assert(["baseline", "final"].includes(phase));
const manifest = read<ManifestEntry[]>(path.join(evidenceRoot, "FILES_SHA256.json"));
const business = read<Business>(path.join(evidenceRoot, "business-evidence.json"));
const checks: string[] = [], details: Record<string, unknown> = {};
const preservedQuestionMatrix: Array<Record<string, unknown>> = [];
let fetchAttempts = 0, generationCalls = 0;
globalThis.fetch = async () => { fetchAttempts++; throw Error("This evidence replay forbids network requests"); };
function check(label: string, work: () => void) { work(); checks.push(label); console.log(`[${checks.length}] ${label}`); }
function verifyPackage() {
  assert.equal(manifest.length, 257); assert.equal(business.sha, "24eead02f2825dbc029ab4b62c211c291982de73");
  for (const entry of manifest) { const file = path.resolve(evidenceRoot, entry.path); assert(within(evidenceRoot, file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()); const bytes = fs.readFileSync(file); assert.equal(bytes.length, entry.bytes, entry.path); assert.equal(hash(bytes), entry.sha256, entry.path); }
}
function fixture(name: string, source: PublicTask, previews: SourcePreview[]) {
  const learning = new LearningRepository(path.join(runRoot, name), "00000000-0000-4000-8000-000000000031");
  const pageId = "00000000-0000-4000-8000-000000000032"; learning.create({ id: pageId, title: "[原公开证据离线重放] " + name });
  for (const materialId of source.scope.materialIds) {
    const paragraphs = previews.filter(p => p.materialId === materialId).sort((a, b) => a.paragraph - b.paragraph);
    assert.equal(paragraphs.length, 7, "All seven exact original material paragraphs required");
    assert(paragraphs.every((p, i) => p.paragraph === i + 1));
    learning.saveMaterials(pageId, [{ id: materialId, title: paragraphs[0].title, kind: "text", filename: null, bytes: Buffer.from(paragraphs.map(p => p.text).join("\n\n")) }]);
  }
  const task: AgentTask = { ...source, accountId: learning.accountId, resourceId: pageId, scenario: "learning.adaptive-review.v1", scope: {
    ...freezeLearningAgentScope(learning, pageId, source.scope), completionVersion: 1 }, actions: [], createdAt: "offline-import", updatedAt: "offline-import" };
  const artifacts = new LearningAgentRepository(learning), quizzes = new LearningQuizRepository(learning);
  const ctx: AgentContext = { task, actionId: "public-import", signal: new AbortController().signal, assertActive: async () => {}, call: async () => { generationCalls++; throw Error("No model/generation allowed"); } };
  const plan = establishLearningReviewPlan(learning, ctx, { kind: source.completion.plan.kind, objectives: source.completion.plan.objectives });
  assert.deepEqual(plan, source.completion.plan, "Exact original plan, identity and source fingerprint");
  return { learning, task, ctx, artifacts, quizzes, plan };
}
type Fixture = ReturnType<typeof fixture>;
function persist(f: Fixture, id: string, kind: "explanation" | "quiz" | "evidence_proposal", body: unknown, version = f.task.version ?? 1) {
  const scope = f.task.scope as { fingerprint: string; selection: LearningAgentSelection };
  f.artifacts.reserve({ id, kind, taskId: f.task.id, taskVersion: version, pageId: f.task.resourceId, actionId: `public-import:${id}`, binding: scope.fingerprint, materialIds: scope.selection.materialIds });
  f.artifacts.complete(f.task.resourceId, f.task.id, id, body);
}
function submitOriginalAttempt(f: Fixture, original: QuizAttemptView, artifactVersion = f.task.version ?? 1) {
  assert(original.completed && original.score && original.questions.every(q => q.feedback));
  f.quizzes.begin(f.task.resourceId, { id: original.quizId, settings: { materialIds: (f.task.scope as { selection: LearningAgentSelection }).selection.materialIds,
    chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: original.questions.length, difficulty: "standard" } }, 24000);
  f.quizzes.complete(f.task.resourceId, original.quizId, { title: original.title, reason: null, items: original.questions.map(q => ({ stem: q.stem, kind: q.kind,
    options: q.options.map(o => ({ id: o.id, text: o.text, reason: q.feedback!.reasons.find(r => r.id === o.id)!.reason })), correctOptionId: q.feedback!.correctOptionId,
    explanation: q.feedback!.explanation, hint: q.hint ?? null, sources: q.feedback!.sources.map(s => { assert(s.kind === "material"); return { kind: "material" as const, materialId: s.materialId, paragraph: s.paragraph }; }) })) });
  let attempt = f.quizzes.startAttempt(f.task.resourceId, { id: original.id, quizId: original.quizId, mode: original.mode });
  check(`Unsubmitted ${original.quizId} keeps answers/grades hidden`, () => { assert.equal(attempt.score, null); assert(attempt.questions.every(q => !q.feedback)); });
  const act = (action: QuizActionInput["action"], question: number, optionId: string | null = null) => {
    attempt = f.quizzes.act(f.task.resourceId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action, question, optionId });
  };
  for (const question of original.questions) { assert(!question.progress.revealed && !question.progress.skipped && question.progress.submitted); if (question.progress.hinted) act("hint", question.index); act("choose", question.index, question.progress.optionId); }
  act("finish", 0);
  check(`Original ${original.quizId} scores/text/stable IDs/reasons/sources reproduced through real Quiz service`, () => {
    assert.deepEqual(attempt.score, original.score);
    const content = (view: QuizAttemptView) => view.questions.map(q => ({ stem: q.stem, kind: q.kind, options: q.options.map(({ id, text }) => ({ id, text })), progress: q.progress, feedback: q.feedback }));
    assert.deepEqual(content(attempt), content(original));
  });
  preservedQuestionMatrix.push(...original.questions.map(q => ({ quizId: original.quizId, attemptId: original.id, questionIndex: q.index,
    stableOptionOrder: q.options.map(o => o.id), originalQuestion: q, formalSavedQuestion: attempt.questions[q.index], originalScore: original.score,
    modelTextUnchanged: true, scoringAuthority: "LearningQuizRepository.act", syntheticStudentReplay: true,
    timestampBoundary: "Replay submission timestamps are newly generated local events; original timestamp stays in originalQuestion/attached projection and is not rewritten." })));
  persist(f, original.quizId, "quiz", { attemptId: original.id }, artifactVersion); return attempt;
}
function publicProposals(f: Fixture, source: PublicTask) {
  // Exact published refs, roles, rationale and relations survive. Relevance and
  // contentStatus are not exported: conservatively reconstruct public uncertain
  // quality as an explicitly labelled replay uncertainty, never infer raw args.
  for (const objective of source.completion.objectives) for (const proof of objective.evidence.filter(e => e.submitted)) {
    const proposal: LearningEvidenceProposal = { ref: proof.ref, objectiveId: proof.objectiveId, role: proof.role, rationale: proof.rationale || "[离线公开投影：原理由未提供]",
      relevance: proof.quality === "uncertain" ? "uncertain" : "supported", contentStatus: "no_known_issue", relation: proof.relation, priorEvidenceRefs: proof.priorEvidenceRefs };
    persist(f, randomUUID(), "evidence_proposal", proposal);
  }
}
async function main() {
  console.log("[repair3 1/4] Full original package integrity/accounting");
  check("All 257 original entries retain exact hashes", verifyPackage);
  const ledger = read<{ originalCount: number; totalCount: number; newCount: number; guardMaximum: number; remaining: number; unknown: number }>(path.join(evidenceRoot, "integrity/provider-accounting.json"));
  check("Original Windows ledger stays 54/67, original35/new19, remaining13, unknown0", () => {
    assert.equal(ledger.originalCount, 35); assert.equal(ledger.totalCount, 54); assert.equal(ledger.newCount, 19); assert.equal(ledger.guardMaximum, 67); assert.equal(ledger.remaining, 13); assert.equal(ledger.unknown, 0);
  }); details.accounting = ledger;
  console.log("[repair3 2/4] W1 current explanation absence and exact real contradictory text");
  const w1 = fixture("w1", business.currentTasks.W1, business.currentTasks.W1.sourceAdjustment!.sources);
  try {
    const absent = assessLearningCompletion(w1.learning, w1.task);
    check("W1 exact corrected plan cannot pass before a current explanation", () => { assert(!absent.canAutoFinish); assert.equal(absent.outcome, "insufficient"); });
    if (phase === "final") check("W1 missing current explanation is explicit, not waiting-for-resolution fiction", () => {
      assert.equal(absent.objectives[0].explanationState, "missing"); assert.match(absent.headline, /尚未生成/); assert(!absent.objectives[0].gaps.some(g => g.includes("明确解决确认")));
    });
    const explanation = business.currentTasks.W1.explanations[0];
    const purpose: LearningCheckPurpose = { objectiveIds: w1.plan.objectives.map(o => o.id), role: "concept", method: "explain", purpose: "[离线关联元数据] 原公开讲解对应唯一当前解释目标；未提供原私有purpose参数。", priorEvidenceRefs: [] };
    const body = { materialAnswer: explanation.text, items: explanation.sources, supplements: [], reviewContext: { planId: w1.plan.id, taskVersion: w1.task.version, purpose } };
    persist(w1, explanation.id, "explanation", body);
    check("W1 exact contradictory text and actual3/4 sources remain unmodified", () => { assert.deepEqual(JSON.parse(w1.artifacts.get(w1.task.resourceId, w1.task.id, explanation.id)!.body_json!), body); assert(explanation.text.includes("不满足交集的双条件")); });
    let resolvedRejected = false;
    try { validateLearningExplanationFeedback(w1.learning, w1.task, { explanationId: explanation.id, outcome: "resolved" }); }
    catch (error) { if (!(error instanceof LearningError)) throw error; resolvedRejected = true; }
    details.w1 = { exactOriginalExplanation: explanation, originalPlan: w1.plan, absent, withExplanation: assessLearningCompletion(w1.learning, w1.task), resolvedRejected,
      reconstruction: "Only artifact wrapper/purpose reconstructed; explanation text/source IDs and plan exact. No resolved feedback written." };
    if (phase === "final") {
      check("Known contradictory W1 explanation cannot accept resolved", () => assert(resolvedRejected));
      check("W1 known contradiction stays visible and permits honest needs-clarification feedback", () => {
        const assessed = assessLearningCompletion(w1.learning, w1.task);
        assert.equal(assessed.objectives[0].explanationState, "needs_review"); assert(assessed.contentIssues?.some(issue => issue.explanationId === explanation.id));
        assert.doesNotThrow(() => validateLearningExplanationFeedback(w1.learning, w1.task, { explanationId: explanation.id, outcome: "needs_clarification" }));
        assert(!assessed.canAutoFinish);
      });
    }
  } finally { w1.learning.close(); }
  console.log("[repair3 3/4] W3 exact original1/2 and new1/1; no silent inheritance");
  const w3 = fixture("w3", business.currentTasks.W3, business.originalW3.sourceAdjustment!.sources);
  try {
    const old = submitOriginalAttempt(w3, business.originalW3SubmittedEvidence.attempt, 1);
    const latest = business.publicAttempts.find(a => a.id === "e73742b8-1f7b-4b00-8c68-5c01a5b1d359")!; submitOriginalAttempt(w3, latest);
    publicProposals(w3, business.currentTasks.W3);
    const before = assessLearningCompletion(w3.learning, w3.task);
    check("W3 public followup-role/initial-relation never proves correction; authorized old answers not silently inherited", () => {
      assert(!before.canAutoFinish); assert.notEqual(before.outcome, "check_passed");
      assert(before.objectives.every(o => o.evidence.every(e => e.ref.attemptId !== old.id))); assert(before.objectives.every(o => o.requirements.every(r => !r.supported)));
    });
    const scenario = createLearningAgentScenario(w3.learning), navigation = scenario.tools["learning.read_navigation"], answers = scenario.tools["learning.read_answers"];
    const nav = await navigation.execute({}, w3.ctx); const navigationResult = await navigation.readResult!({ resultRef: nav.ref } as never, w3.ctx);
    const result = await answers.execute({ attemptId: old.id }, { ...w3.ctx, actionId: "offline-explicit-authorized-old-read" });
    const oldRead = await answers.readResult!({ resultRef: result.ref } as never, { ...w3.ctx, actionId: "offline-explicit-authorized-old-read" });
    // This is an isolated domain-function replay, not a restart/resume of the
    // original ended Windows task. The receipt below records the tool actually
    // executed above; no original task status, budget or action is overwritten.
    w3.task.actions.push({ id: "offline-explicit-authorized-old-read", version: w3.task.version, tool: "learning.read_answers", status: "succeeded", resultRef: result.ref,
      summary: result.summary, createdAt: new Date().toISOString() });
    if (phase === "final") {
      for (const question of old.questions) {
        const objective = w3.plan.objectives[question.index];
        recordLearningEvidenceProposal(w3.learning, { ...w3.ctx, actionId: `offline-explicit-old-association-${question.index}` }, {
          ref: { quizId: old.quizId, attemptId: old.id, questionIndex: question.index }, objectiveId: objective.id, role: "followup", relevance: "supported", relation: "initial", priorEvidenceRefs: [], contentStatus: "no_known_issue",
          rationale: question.index === 0 ? "[离线新关联] 原题要求判断共同元素重复计数，直接关联本目标；提示事实保留，不能据此证明独立纠正。" : "[离线新关联] 原题要求判断直接相加条件，正式保存选择在有共同元素时相加，实际错误仍是反证。" });
      }
      const recovered = assessLearningCompletion(w3.learning, w3.task);
      check("W3 explicit authorized read/reassociation preserves original hint and real counterevidence", () => {
        const original = recovered.objectives.flatMap(o => o.evidence).filter(e => e.ref.attemptId === old.id);
        assert.equal(original.length, 2); assert(original.every(e => e.eligible && e.historical));
        assert(original.some(e => e.correct && e.hintedBeforeSubmission && !e.independentInApp));
        assert(recovered.objectives.find(o => o.id === "set-count-add-rule")!.unresolvedErrors.some(ref => ref.attemptId === old.id && ref.questionIndex === 1));
        assert(!recovered.canAutoFinish); assert(recovered.objectives.every(o => o.requirements.every(r => !r.supported)));
        assert.deepEqual(w3.quizzes.attempt(w3.task.resourceId, old.id).score, old.score);
      });
      const purpose: LearningCheckPurpose = { objectiveIds: ["set-count-add-rule"], role: "followup", method: "contrast", purpose: "[离线新目的] 对比有共同元素与无共同元素，解释原错误相加条件，不把简单新题自动当作纠正。",
        priorEvidenceRefs: [{ quizId: old.quizId, attemptId: old.id, questionIndex: 1 }] };
      check("W3 a concrete explanation of preserved counterevidence is allowed without inventing another quiz", () => {
        const guarded = guardLearningCompletionAction(w3.learning, { ...w3.ctx, actionId: "offline-related-explanation-preflight" }, "explanation", purpose);
        assert(!guarded.stop && !guarded.wait); assert.equal(w3.quizzes.list(w3.task.resourceId).length, 2); assert.equal(generationCalls, 0);
      });
      details.w3Recovered = { assessment: recovered, purpose, statusBoundary: "Domain-function acceptance only; original ended task status unchanged. Official runtime/API recovery is covered by separate integration tests, not claimed here." };
    }
    details.w3 = { originalPlan: w3.plan, originalWindowsAssessment: business.currentTasks.W3.completion, before, navigationResult, oldRead,
      originalScore: old.score, latestScore: latest.score, reconstruction: "Current-version source/history already explicitly authorized in supplied snapshot; old read here is a new OFFLINE recovery, not observed Windows behavior." };
  } finally { w3.learning.close(); }
  console.log("[repair3 4/4] W2 exact4 submitted questions and requirements; pending public question preserved separately");
  const w2 = fixture("w2", business.currentTasks.W2New, business.currentTasks.W2New.sourceAdjustment!.sources);
  try {
    const groups = business.publicAttempts.filter(a => ["e3e77d69-8b96-4588-8a87-08cee7d5531c", "23b857f0-0124-4bf7-8a0e-dd85ca6dd228"].includes(a.quizId));
    assert.equal(groups.length, 2); for (const attempt of groups) submitOriginalAttempt(w2, attempt);
    publicProposals(w2, business.currentTasks.W2New);
    const assessment = assessLearningCompletion(w2.learning, w2.task), all = assessment.objectives.flatMap(o => o.evidence), counting = all.find(e => e.ref.questionIndex === 2)!;
    check("W2 unchanged goals still have real gaps and cannot pass after3/3 plus1/1", () => { assert(!assessment.canAutoFinish); assert.notEqual(assessment.outcome, "check_passed"); assert(assessment.objectives.some(o => o.requirements.some(r => !r.supported))); });
    const pending = business.publicAttempts.find(a => a.quizId === "1db977de-e2ce-4643-8a07-8dcb9a7fe2f2")!;
    check("W2 original third group remains unanswered and its hidden answer is not invented", () => { assert(!pending.completed); assert.equal(pending.score, null); assert(pending.questions.every(q => !q.feedback)); });
    if (phase === "final") {
      check("W2 membership-only index2 cannot support formula counting application", () => { assert(!counting.eligible); assert.equal(counting.diagnosticCode, "requirement_mismatch"); });
      check("W2 actual numerical index1 and actual membership-boundary item keep tentative support", () => {
        assert(all.some(e => e.ref.questionIndex === 1 && e.role === "application" && e.eligible && e.quality === "tentative"));
        assert(all.some(e => e.ref.quizId === "23b857f0-0124-4bf7-8a0e-dd85ca6dd228" && e.role === "boundary" && e.eligible));
        const first = all.find(e => e.ref.quizId === groups[0].quizId && e.ref.questionIndex === 0)!;
        assert.equal(first.quality, "uncertain"); assert(!first.eligible);
      });
      const answers = createLearningAgentScenario(w2.learning).tools["learning.read_answers"], readCtx = { ...w2.ctx, actionId: "offline-w2-explicit-read" };
      const receipt = await answers.execute({ attemptId: groups[0].id }, readCtx); await answers.readResult!({ resultRef: receipt.ref } as never, readCtx);
      w2.task.actions.push({ id: readCtx.actionId, version: w2.task.version, tool: "learning.read_answers", status: "succeeded", resultRef: receipt.ref, summary: receipt.summary, createdAt: new Date().toISOString() });
      const original = business.currentTasks.W2New.completion.objectives.find(o => o.id === "membership_judgment")!.evidence.find(e => e.ref.questionIndex === 0)!;
      recordLearningEvidenceProposal(w2.learning, { ...w2.ctx, actionId: "offline-w2-reassess-membership" }, { ref: original.ref, objectiveId: original.objectiveId, role: original.role,
        rationale: original.rationale, relevance: "supported", relation: original.relation, priorEvidenceRefs: original.priorEvidenceRefs, contentStatus: "no_known_issue" });
      const reassessed = assessLearningCompletion(w2.learning, w2.task);
      check("W2 explicit new offline reassociation may resolve mapping uncertainty; never promotes to verified or whole-task pass", () => {
        const proof = reassessed.objectives.find(o => o.id === "membership_judgment")!.evidence.find(e => e.ref.questionIndex === 0)!;
        assert.equal(proof.quality, "tentative"); assert(proof.eligible); assert.equal(proof.semanticProvenance, "model_proposal");
        assert(!reassessed.canAutoFinish); assert.notEqual(reassessed.outcome, "check_passed");
        assert.deepEqual(w2.quizzes.attempt(w2.task.resourceId, groups[0].id).score, groups[0].score);
      });
      details.w2OfflineReassociation = { assessment: reassessed, rationale: "New offline proposal after actual read; supplied original uncertain proposal is not modified or relabelled as DS success." };
    }
    details.w2 = { originalPlan: w2.plan, assessmentSubmittedSubset: assessment, originalFinalAssessment: business.currentTasks.W2New.completion, pendingPublicAttempt: pending,
      reconstruction: "Submitted public business facts formally imported; pending third answer/private review metadata absent and NOT invented/imported. Assessment shown for submitted subset, not a full Windows DB replay." };
  } finally { w2.learning.close(); }
  details.questionMatrix = preservedQuestionMatrix;
  check("All seven submitted original questions were replayed without substituting new content", () => assert.equal(preservedQuestionMatrix.length, 7));
  check("No model/generation/network requested; immutable source package preserved", () => { assert.equal(fetchAttempts, 0); assert.equal(generationCalls, 0); verifyPackage(); });
}
main().then(() => {
  const result = { phase, status: "PASS", checks: checks.length, passed: checks, fetchAttempts, generationCalls, realProviderRequests: 0, runRoot, details,
    limits: ["Public projections only; no raw Provider envelope, private args, original SQLite/checkpoint or secret opened.", "Original pending third Quiz has no revealed answer and is retained as public evidence, not invented in the replay DB.", "Semantic proposals and explicit recovery metadata are offline test proposals, not original DS decisions or verified teaching conclusions."] };
  fs.writeFileSync(path.join(runRoot, "public-evidence-replay-result.json"), JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(outputRoot, `${phase}-replay-result.json`), JSON.stringify(result, null, 2)); console.log(`PASS ${checks.length} checks; real Provider0; ${runRoot}`);
}).catch(error => { fs.writeFileSync(path.join(runRoot, "failure.json"), JSON.stringify({ phase, status: "FAIL", passed: checks, error: String(error), fetchAttempts, generationCalls, details }, null, 2)); console.error(error); process.exitCode = 1; });
