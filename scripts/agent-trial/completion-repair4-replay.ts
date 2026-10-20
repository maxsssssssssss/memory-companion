/** Offline replay of the 392fb07 Windows closure PUBLIC projections.
 * This is not a restoration of the Windows database, checkpoint or private tool
 * arguments. Source/plan/question/answer text is imported unchanged; scores are
 * produced by formal Quiz actions. Missing wrapper/proposal metadata is marked
 * below, never passed off as recovered DS output. No network or model runs. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentTask } from "../../src/lib/domain/agent";
import type { LearningAgentSelection } from "../../src/lib/domain/learning-agent";
import { LearningReviewPlanInput, StoredLearningReviewPlanInput,
  type LearningReviewPlan, type LearningCompletionAssessment, type LearningEvidenceProposal, type LearningCheckPurpose } from "../../src/lib/domain/learning-agent-completion";
import type { QuizActionInput, QuizAttemptView, QuizRunSummary } from "../../src/lib/domain/learning-quiz";
import type { AgentContext } from "../../src/lib/server/agent/types";
import { LearningRepository } from "../../src/lib/server/learning/repository";
import { LearningQuizRepository } from "../../src/lib/server/learning/quiz-repository";
import { LearningAgentRepository, type LearningAgentArtifact } from "../../src/lib/server/learning/agent-repository";
import { freezeLearningAgentScope } from "../../src/lib/server/learning/agent-scope";
import { assessLearningCompletion, recordExplanationFeedback, validateLearningExplanationFeedback } from "../../src/lib/server/learning/agent-completion";
import { createLearningAgentScenario } from "../../src/lib/server/learning/agent-scenario";
import { projectLearningAgentReviewSummary } from "../../src/lib/server/learning/agent-review-summary";

type PublicTask = Pick<AgentTask, "id" | "version" | "goal" | "status" | "wait" | "usage" | "budget" | "endReason"> & {
  scope: LearningAgentSelection; actions: Array<Omit<AgentTask["actions"][number], "createdAt">>;
  completion: LearningCompletionAssessment & { plan: LearningReviewPlan };
  explanations: Array<{ id: string; text: string; sources: Array<{ materialId: string; paragraph: number }> }>;
};
type ManifestEntry = { path: string; bytes: number; sha256: string };
type CandidateAudit = { summary: { runs: number; decodedCandidateSlots: number; retainedQuestions: number; rejectedMarkers: number; positionDependencyMarkers: number; reviewCheckRejectedMarkers: number; rejectedOriginalBodiesAvailable: number };
  rows: Array<{ track: string; runId: string; state: string; failure: string | null; candidates?: Array<{ index: number; status: string; retainedMarker?: unknown; decodedQuestion?: unknown; originalCandidateAvailable?: boolean }> }> };
const read = <T>(file: string) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, "")) as T;
const hash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const inside = (base: string, file: string) => { const rel = path.relative(base, file); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const [key, value] = [process.argv[i], process.argv[i + 1]];
  assert(["--evidence-dir", "--output-dir"].includes(key) && value && !options.has(key)); options.set(key, value);
}
assert(options.has("--evidence-dir"), "Supply the complete 298-entry Windows public evidence package");
const evidenceRoot = fs.realpathSync(path.resolve(options.get("--evidence-dir")!));
const outputRoot = path.resolve(options.get("--output-dir") ?? "output/learning-completion-repair4/replay");
assert(outputRoot !== evidenceRoot && !inside(evidenceRoot, outputRoot));
fs.mkdirSync(outputRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(outputRoot, "public-projection-"));
const manifest = read<{ files: ManifestEntry[] }>(path.join(evidenceRoot, "MANIFEST.json")).files;
const sourceBytes = fs.readFileSync(path.join(evidenceRoot, "synthetic-course.txt"));
const checks: string[] = [], details: Record<string, unknown> = {}, questionMatrix: Array<Record<string, unknown>> = [];
let fetchAttempts = 0, modelCalls = 0;
globalThis.fetch = async () => { fetchAttempts++; throw Error("Public-evidence replay forbids network"); };
function check(label: string, work: () => void) { work(); checks.push(label); console.log(`[${checks.length}] ${label}`); }
function taskAt(step: string) { return read<PublicTask>(path.join(evidenceRoot, "browser-steps", step, "task-latest.json")); }
function attemptAt(step: string, id: string) { return read<{ attempt: QuizAttemptView }>(path.join(evidenceRoot, "browser-steps", step, `attempt-${id}.json`)).attempt; }
function verifyPackage() {
  assert.equal(manifest.length, 298);
  for (const entry of manifest) {
    const file = path.resolve(evidenceRoot, entry.path);
    assert(inside(evidenceRoot, file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, entry.bytes, entry.path); assert.equal(hash(bytes), entry.sha256, entry.path);
  }
}
function fixture(name: string, source: PublicTask) {
  const learning = new LearningRepository(path.join(runRoot, name), "00000000-0000-4000-8000-000000000041");
  const pageId = "00000000-0000-4000-8000-000000000042";
  learning.create({ id: pageId, title: `[原公开证据离线回放] ${name}` });
  for (const id of source.scope.materialIds) learning.saveMaterials(pageId, [{ id, title: "合成教材 · 集合、交集与并集", kind: "text", filename: null, bytes: sourceBytes }]);
  const scope = { ...freezeLearningAgentScope(learning, pageId, source.scope), completionVersion: 1 };
  assert.equal(scope.fingerprint, source.completion.plan.sourceFingerprint, "Exact original material fingerprint must match");
  const task: AgentTask = { ...source, accountId: learning.accountId, resourceId: pageId, scenario: "learning.adaptive-review.v1", scope,
    actions: source.actions.map(action => ({ ...action, createdAt: "offline-public-projection:original-timestamp-not-exported" })),
    createdAt: "offline-public-import", updatedAt: "offline-public-import" };
  const artifacts = new LearningAgentRepository(learning), quizzes = new LearningQuizRepository(learning);
  const ctx: AgentContext = { task, actionId: "offline-public-import", signal: new AbortController().signal, assertActive: async () => {},
    call: async () => { modelCalls++; throw Error("No model or generation allowed"); } };
  const plan = source.completion.plan;
  StoredLearningReviewPlanInput.parse({ kind: plan.kind, objectives: plan.objectives });
  const f = { learning, task, ctx, artifacts, quizzes, plan };
  // Import an existing frozen plan using the artifact repository, not the new
  // plan action: new contracts must reject procedural requirements. Exact old
  // plan text/IDs/fingerprint remain available for safe compatibility diagnosis.
  persist(f, plan.id, "review_plan", plan);
  return f;
}
type Fixture = ReturnType<typeof fixture>;
function persist(f: Fixture, id: string, kind: LearningAgentArtifact["kind"], body: unknown, version = f.task.version ?? 1) {
  const scope = f.task.scope as ReturnType<typeof freezeLearningAgentScope>;
  f.artifacts.reserve({ id, kind, taskId: f.task.id, taskVersion: version, pageId: f.task.resourceId,
    actionId: `public-import:${id}`, binding: scope.fingerprint, materialIds: scope.selection.materialIds });
  f.artifacts.complete(f.task.resourceId, f.task.id, id, body);
}
function submitOriginal(f: Fixture, original: QuizAttemptView, artifactVersion = f.task.version ?? 1) {
  assert(original.completed && original.score && original.questions.every(question => question.feedback));
  const materialIds = (f.task.scope as ReturnType<typeof freezeLearningAgentScope>).selection.materialIds;
  f.quizzes.begin(f.task.resourceId, { id: original.quizId, settings: { materialIds, chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false,
    count: original.questions.length, difficulty: "standard" } }, 24000);
  f.quizzes.complete(f.task.resourceId, original.quizId, { title: original.title, reason: null, items: original.questions.map(q => ({ stem: q.stem, kind: q.kind,
    options: q.options.map(o => ({ id: o.id, text: o.text, reason: q.feedback!.reasons.find(reason => reason.id === o.id)!.reason })),
    correctOptionId: q.feedback!.correctOptionId, explanation: q.feedback!.explanation, hint: q.hint ?? null,
    sources: q.feedback!.sources.map(s => { assert(s.kind === "material"); return { kind: "material" as const, materialId: s.materialId, paragraph: s.paragraph }; }) })) });
  let attempt = f.quizzes.startAttempt(f.task.resourceId, { id: original.id, quizId: original.quizId, mode: original.mode });
  check(`Unsubmitted ${original.quizId} keeps correct answers and score hidden`, () => {
    assert.equal(attempt.score, null); assert(attempt.questions.every(q => !q.feedback));
  });
  const act = (action: QuizActionInput["action"], question: number, optionId: string | null = null) => {
    attempt = f.quizzes.act(f.task.resourceId, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action, question, optionId });
  };
  for (const q of original.questions) {
    assert(q.progress.submitted && !q.progress.revealed && !q.progress.skipped);
    if (q.progress.hinted) act("hint", q.index);
    act("choose", q.index, q.progress.optionId);
  }
  act("finish", 0);
  check(`Original ${original.quizId} formal saved score, stable option order, text, all reasons and source hashes match`, () => {
    assert.deepEqual(attempt.score, original.score);
    const content = (view: QuizAttemptView) => view.questions.map(q => ({ stem: q.stem, kind: q.kind, options: q.options.map(({ id, text }) => ({ id, text })), progress: q.progress, feedback: q.feedback }));
    assert.deepEqual(content(attempt), content(original));
  });
  questionMatrix.push(...original.questions.map(q => ({ quizId: original.quizId, attemptId: original.id, questionIndex: q.index,
    originalQuestion: q, formalSavedQuestion: attempt.questions[q.index], originalScore: original.score,
    scoringAuthority: "LearningQuizRepository.act", simulatedStudent: true, modelTextUnchanged: true,
    timestamps: "Submission events are new local replay events; original Windows timestamps remain in the immutable supplied projection." })));
  persist(f, original.quizId, "quiz", { attemptId: original.id }, artifactVersion);
  return attempt;
}
function importPublicProposals(f: Fixture, original: PublicTask) {
  for (const objective of original.completion.objectives) for (const proof of objective.evidence.filter(e => e.submitted)) {
    const proposal: LearningEvidenceProposal = { ref: proof.ref, objectiveId: proof.objectiveId, role: proof.role, rationale: proof.rationale,
      relevance: proof.quality === "uncertain" ? "uncertain" : "supported", contentStatus: "no_known_issue", relation: proof.relation, priorEvidenceRefs: proof.priorEvidenceRefs };
    // Only the public refs/role/rationale/relation are exact. The private
    // relevance/contentStatus parameters were not exported; this reconstruction
    // reproduces the public tentative/uncertain classification, not private DS.
    persist(f, randomUUID(), "evidence_proposal", proposal);
  }
}
async function reread(f: Fixture, id: string) {
  const tool = createLearningAgentScenario(f.learning).tools["learning.read_answers"];
  const ctx = { ...f.ctx, actionId: `offline-actual-read:${id}` };
  const result = await tool.execute({ attemptId: id }, ctx);
  const body = await tool.readResult!({ resultRef: result.ref } as never, ctx);
  f.task.actions.push({ id: ctx.actionId, version: f.task.version, tool: "learning.read_answers", status: "succeeded", resultRef: result.ref, summary: result.summary, createdAt: new Date().toISOString() });
  return body;
}
function importPublicFailedQuizzes(f: Fixture, step: string) {
  const summaries = read<{ quizzes: QuizRunSummary[] }>(path.join(evidenceRoot, "browser-steps", step, "quizzes-latest.json")).quizzes;
  const ids = new Set(read<CandidateAudit>(path.join(evidenceRoot, "rejected-candidates.json")).rows.filter(row => row.track === "W3").map(row => row.runId));
  for (const summary of summaries.filter(summary => ids.has(summary.id) && summary.status !== "completed")) {
    f.quizzes.begin(f.task.resourceId, { id: summary.id, settings: summary.settings }, 24000);
    if (summary.status === "insufficient") f.quizzes.complete(f.task.resourceId, summary.id, { title: summary.title, reason: summary.reason, items: [] });
    else { assert.equal(summary.status, "failed"); f.quizzes.fail(f.task.resourceId, summary.id, summary.failure!); }
    const scope = f.task.scope as ReturnType<typeof freezeLearningAgentScope>;
    f.artifacts.reserve({ id: summary.id, kind: "quiz", taskId: f.task.id, taskVersion: f.task.version, pageId: f.task.resourceId,
      actionId: `public-failed-import:${summary.id}`, binding: scope.fingerprint, materialIds: scope.selection.materialIds });
    // The package exposes Quiz status, not the artifact row. Preserve the
    // recorded failed outcome as failed wrapper metadata; original C1 unknown
    // generation-part state is separately retained in the candidate audit.
    f.artifacts.fail(f.task.resourceId, f.task.id, summary.id, false);
  }
}
async function main() {
  console.log("[repair4 1/5] Immutable package and exact recorded chronology");
  check("All 298 manifest entries retain exact bytes and hashes", verifyPackage);
  check("Exact seven-paragraph material matches the recorded original hash", () => assert.equal(hash(sourceBytes), "2ffac289182e253758814c73ea7b9c0e77a3075979feb0700f9b103eb6986649"));
  const ledger = read<Array<{ state: string }>>(path.join(evidenceRoot, "final-ledger-rows.json"));
  const before = read<unknown[]>(path.join(evidenceRoot, "ledger-before.json"));
  check("Original Windows ledger is unchanged: 54 old plus39 equals93, all completed; Cloud consumes zero", () => {
    assert.equal(ledger.length, 93); assert.equal(before.length, 54); assert.deepEqual(ledger.slice(0, 54), before); assert(ledger.every(row => row.state === "completed"));
  });
  const w1Step = "2026-10-20T02-21-10-101Z-24380-reload", w3Step = "2026-10-20T02-21-13-923Z-23424-inspect", w2Step = "2026-10-20T02-21-16-264Z-23860-reload";
  console.log("[repair4 2/5] W1 exact successful explanation and explicit confirmation");
  const w1Original = taskAt(w1Step), w1 = fixture("w1", w1Original);
  try {
    const explanation = w1Original.explanations[0], purpose: LearningCheckPurpose = { objectiveIds: w1.plan.objectives.map(objective => objective.id),
      role: "concept", method: "explain", purpose: "[离线wrapper元数据] 公开成功讲解对应唯一解释目标；原私有purpose未导出。", priorEvidenceRefs: [] };
    const body = { materialAnswer: explanation.text, items: explanation.sources, supplements: [], reviewContext: { planId: w1.plan.id, taskVersion: w1.task.version, purpose } };
    persist(w1, explanation.id, "explanation", body);
    check("W1 exact successful explanation without explicit feedback is not resolved", () => {
      assert.equal(assessLearningCompletion(w1.learning, w1.task).objectives[0].explanationState, "available");
      assert(!assessLearningCompletion(w1.learning, w1.task).canAutoFinish);
      assert.doesNotThrow(() => validateLearningExplanationFeedback(w1.learning, w1.task, { explanationId: explanation.id, outcome: "resolved" }));
    });
    const thanks = taskAt("2026-10-19T10-32-28-532Z-135528-feedback");
    check("Original thanks remained waiting; real explicit and repeated confirmations stayed at seven calls", () => {
      assert.equal(thanks.status, "waiting"); assert.notEqual(thanks.completion.outcome, "explanation_resolved");
      for (const step of ["2026-10-19T10-32-59-484Z-120876-resolve", "2026-10-19T10-33-52-137Z-126640-repeat-resolve",
        "2026-10-19T10-33-54-988Z-117724-repeat-resolve", w1Step]) {
        const saved = taskAt(step); assert.equal(saved.usage.calls, 7); assert.equal(saved.completion.outcome, "explanation_resolved");
      }
    });
    const feedback = { eventId: "offline-explicit-resolved", roundId: explanation.id, explanationId: explanation.id, outcome: "resolved" as const };
    const first = recordExplanationFeedback(w1.learning, w1.task, feedback);
    const duplicate = recordExplanationFeedback(w1.learning, w1.task, { ...feedback, eventId: "offline-duplicate-resolved" });
    const assessment = assessLearningCompletion(w1.learning, w1.task);
    check("Formal explicit resolution and duplicate are zero-call, idempotent, noQuiz, not long-term mastery", () => {
      assert.deepEqual(first, duplicate); assert.equal(w1.artifacts.list(w1.task.resourceId, w1.task.id).filter(row => row.kind === "explanation_feedback").length, 1);
      assert.equal(assessment.outcome, "explanation_resolved"); assert(assessment.canAutoFinish); assert.equal(assessment.longTermMastery, "unverified");
      assert.equal(w1.quizzes.list(w1.task.resourceId).length, 0); assert.equal(modelCalls, 0);
    });
    details.w1 = { original: w1Original, assessment, explanationUnchanged: body, wrapperProvenance: "Only missing private wrapper/purpose metadata reconstructed; saved text and source IDs unchanged." };
  } finally { w1.learning.close(); }
  console.log("[repair4 3/5] W3 exact old wrong/new hinted answer, summary and procedural plan");
  const w3Original = taskAt(w3Step), w3 = fixture("w3", w3Original);
  try {
    const old = submitOriginal(w3, attemptAt(w3Step, "6aa2ff2c-025a-4cca-86b6-76bf0c187427"), 1);
    const latest = submitOriginal(w3, attemptAt(w3Step, "4a9a7b5c-c77e-4863-86ad-4a0b5d8a2e48"));
    await reread(w3, old.id); await reread(w3, latest.id); importPublicProposals(w3, w3Original); importPublicFailedQuizzes(w3, w3Step);
    const assessment = assessLearningCompletion(w3.learning, w3.task), summary = projectLearningAgentReviewSummary(w3.learning, w3.task)!;
    check("W3 exact frozen procedural requirements are retained and diagnosed, not silently deleted for PASS", () => {
      assert(!LearningReviewPlanInput.safeParse({ kind: w3.plan.kind, objectives: w3.plan.objectives }).success);
      assert.deepEqual(assessment.plan, w3Original.completion.plan); assert.equal(assessment.technicalBlocker?.kind, "plan_requirement_unobservable"); assert(!assessment.canAutoFinish);
    });
    check("W3 authorized old wrong remains counterevidence and prompted correct remains non-independent", () => {
      const objective = assessment.objectives.find(o => o.id === "intersection-membership")!;
      assert(objective.unresolvedErrors.some(ref => ref.attemptId === old.id));
      assert(objective.evidence.some(e => e.ref.attemptId === old.id && e.historical && e.correct === false && e.eligible));
      assert(objective.evidence.some(e => e.ref.attemptId === latest.id && e.correct === true && e.hintedBeforeSubmission && !e.independentInApp));
      assert.notEqual(assessment.outcome, "check_passed"); assert.equal(w3.task.usage.calls, 16);
    });
    check("W3 summary includes explicitly authorized/reassociated old wrong and identifies failed generation accurately", () => {
      assert.equal(summary.stats.wrong, 1); assert.equal(summary.stats.answered, 2); assert.equal(summary.stats.hinted, 1);
      assert(summary.topics.some(topic => topic.questionRefs.some(ref => ref.attemptId === old.id)));
      assert(!summary.headline.includes("没有错题")); assert(!summary.notices.some(notice => notice.includes("因用户疑问、来源或记录不可用")));
    });
    details.w3 = { originalAssessment: w3Original.completion, originalSummary: (w3Original as unknown as { reviewSummary: unknown }).reviewSummary,
      assessment, summary, note: "Public proposal refs/roles/rationale exact; unexported relevance/contentStatus and artifact wrapper metadata reconstructed and labelled. Actual read tools executed offline. No original task/budget/grade rewritten." };
  } finally { w3.learning.close(); }
  console.log("[repair4 4/5] W2 exact new task and original continuation; no retroactive pass");
  const w2Original = taskAt(w2Step), w2 = fixture("w2-new", w2Original);
  try {
    const first = submitOriginal(w2, attemptAt(w2Step, "6b6240ef-ce09-44b9-84d0-f2d4b47988ac"));
    const second = submitOriginal(w2, attemptAt(w2Step, "7c09d35c-629a-44fe-80f8-9007b242906a"));
    importPublicProposals(w2, w2Original);
    const assessment = assessLearningCompletion(w2.learning, w2.task);
    check("W2 original workflow-only requirement is diagnosed before further generation, never removed to claim success", () => {
      assert(!LearningReviewPlanInput.safeParse({ kind: w2.plan.kind, objectives: w2.plan.objectives }).success);
      assert.deepEqual(assessment.plan, w2.plan); assert.equal(assessment.technicalBlocker?.kind, "plan_requirement_unobservable");
      assert(!assessment.canAutoFinish); assert.notEqual(assessment.outcome, "check_passed"); assert.equal(w2.task.usage.calls, 12);
    });
    check("W2 original correct responses remain selected-option observations, not self-produced explanation or verified transfer", () => {
      assert.equal(first.score!.correct, 1); assert.equal(second.score!.correct, 1);
      assert(second.questions[0].options.some(o => o.id === second.questions[0].progress.optionId));
      assert(assessment.objectives.flatMap(o => o.evidence).every(e => e.quality !== ("verified" as string) && e.semanticProvenance === "model_proposal"));
      const concept = assessment.objectives.flatMap(o => o.evidence).find(e => e.role === "concept")!;
      const originalConcept = w2Original.completion.objectives.flatMap(o => o.evidence).find(e => e.role === "concept")!;
      assert.equal(concept.rationale, originalConcept.rationale); assert.match(concept.rationale, /用自己的话解释/u);
      assert.equal(concept.responseMode, "single_choice");
      assert(concept.reasons.some(reason => reason.includes("不能证明学生曾自行口述或书写")));
      assert.equal(assessment.longTermMastery, "unverified");
    });
    details.w2New = { originalAssessment: w2Original.completion, assessment, originalPrivateAssociationUnavailable: true };
  } finally { w2.learning.close(); }
  const continuationStep = "2026-10-19T10-43-33-366Z-132772-submit", continuedOriginal = taskAt(continuationStep), continued = fixture("w2-continuation", continuedOriginal);
  try {
    const originals = ["74dbf57a-bc04-4206-8963-f5da646654bf", "e825df7d-e7ee-4348-8d00-9a8fd70692f5", "b2b8e5c0-8eca-4b77-8435-fb46acbbcdc5"].map(id => attemptAt(continuationStep, id));
    for (const original of originals) submitOriginal(continued, original);
    importPublicProposals(continued, continuedOriginal);
    const assessment = assessLearningCompletion(continued.learning, continued.task);
    const pending = attemptAt(continuationStep, "eae084da-e17f-48d0-8fe3-e7694937bbfe");
    check("Old W2 member-only item remains invalid for counting; real concept gaps justify pending fourth group", () => {
      const member = assessment.objectives.flatMap(o => o.evidence).find(e => e.ref.quizId === "e3e77d69-8b96-4588-8a87-08cee7d5531c" && e.ref.questionIndex === 2)!;
      assert.equal(member.diagnosticCode, "requirement_mismatch"); assert(!member.eligible);
      assert(assessment.objectives.some(o => o.requirements.some(r => r.role === "concept" && !r.supported))); assert(!assessment.canAutoFinish);
      assert(!pending.completed && pending.score === null && pending.questions.every(q => !q.feedback));
    });
    check("Original third-group option E wording retained as limited content issue, without changing answer or score", () => {
      const third = originals[2], reason = third.questions[0].feedback!.reasons.find(r => r.id === "E")!.reason;
      assert.equal(third.questions[0].options.find(o => o.id === "E")!.text, "3");
      assert.equal(third.questions[0].feedback!.correctOptionId, "A"); assert(reason.includes("|G|") && reason.includes("|H|"));
      assert.deepEqual(continued.quizzes.attempt(continued.task.resourceId, third.id).score, third.score);
      details.arithmeticWordingObservation = { reason, expected: "5−2=3; 4−2=2", classification: "Limited recorded distractor wording inconsistency, not a new verifier or alternative correct answer." };
    });
    details.w2Continuation = { assessmentSubmittedSubset: assessment, originalFinalAssessment: continuedOriginal.completion, pendingOriginal: pending,
      boundary: "Pending fourth question has no exposed answer and is kept only as exact public snapshot, not invented/imported into Quiz DB." };
  } finally { continued.learning.close(); }
  console.log("[repair4 5/5] Candidate availability boundary and zero external calls");
  const candidates = read<CandidateAudit>(path.join(evidenceRoot, "rejected-candidates.json"));
  check("Nine run audit preserves16 slots: four decoded bodies and12 missing originals; no false attribution of rejection", () => {
    assert.equal(candidates.rows.length, 9); assert.equal(candidates.summary.decodedCandidateSlots, 16); assert.equal(candidates.summary.retainedQuestions, 4);
    assert.equal(candidates.summary.rejectedMarkers, 12); assert.equal(candidates.summary.positionDependencyMarkers, 8); assert.equal(candidates.summary.reviewCheckRejectedMarkers, 4);
    assert.equal(candidates.summary.rejectedOriginalBodiesAvailable, 0);
    assert(candidates.rows.flatMap(row => row.candidates ?? []).filter(candidate => candidate.status === "rejected").every(candidate => !candidate.decodedQuestion && candidate.originalCandidateAvailable === false));
  });
  const w3Timeline = w3Original.actions.filter(action => action.version === 2 && action.tool === "learning.create_quiz");
  check("W3 saved repeated failure chronology retained, without inventing private failed purposes or replaying unknown", () => {
    assert.deepEqual(w3Timeline.map(action => action.status), ["failed", "failed", "succeeded", "failed", "failed"]);
    assert.equal(w3Original.status, "budget_exhausted"); assert.equal(w3Original.explanations.length, 0);
    assert(candidates.rows.some(row => row.state === "unknown"));
  });
  details.candidateAudit = candidates; details.w3OriginalCreationChronology = w3Timeline; details.questionMatrix = questionMatrix;
  check("Nine original submitted questions replayed through real Quiz actions; no answers manufactured for pending question", () => assert.equal(questionMatrix.length, 9));
  check("All original evidence remains unchanged; model/generation/network calls zero", () => { verifyPackage(); assert.equal(modelCalls, 0); assert.equal(fetchAttempts, 0); });
}
main().then(() => {
  const result = { status: "PASS", checks: checks.length, passed: checks, runRoot, modelCalls, fetchAttempts, realProviderRequests: 0, details,
    limits: ["Public projections only: no Windows full DB, checkpoint, raw Provider envelope, private args or decision reasoning.",
      "Published question text, stable IDs/order, reasons, original source hashes and original choices reproduced; event times are new local submissions.",
      "Old plan/proposal/failed-artifact wrappers are explicitly reconstructed metadata; original known fields stay unchanged.",
      "Twelve rejected candidate bodies are absent; marker integrity is not content revalidation or proof of false-positive rejection.",
      "C1 transport-boundary regression and C4 runtime adaptive-failure guard are tested separately with formal offline scenarios, not invented original private decisions.",
      "Pending original fourth Quiz has no public answer; no score/support is fabricated.", "Cloud success is not new-SHA real DS acceptance or learning-effect evidence."] };
  fs.writeFileSync(path.join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outputRoot, "final-replay-result.json"), JSON.stringify(result, null, 2));
  console.log(`PASS ${checks.length} checks; original submitted questions=${questionMatrix.length}; real Provider0; ${runRoot}`);
}).catch(error => {
  const failure = { status: "FAIL", passed: checks, error: String(error), modelCalls, fetchAttempts, details };
  fs.writeFileSync(path.join(runRoot, "failure.json"), JSON.stringify(failure, null, 2)); console.error(error); process.exitCode = 1;
});
