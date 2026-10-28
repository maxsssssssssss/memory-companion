import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AgentAction, AgentTask } from "@/lib/domain/agent";
import { ReferencedGeneratedQuiz, type SavedQuiz } from "@/lib/domain/learning-quiz";
import type { AgentContext } from "@/lib/server/agent/types";
import { LearningRepository } from "../repository";
import { LearningQuizRepository } from "../quiz-repository";
import { compactQuizRequest } from "../quiz-compact";
import { composedQuizRequest } from "../quiz-composition";
import { inspectQuizCandidateDelivery } from "../quiz-grounding";
import { inspectLiteralSetMembership } from "../quiz-set-membership";
import { QuizReviewContext, QuizReviewPublication, scopeQuizReviewRequest, quizReviewQuestionKey } from "../quiz-review-purpose";
import { generateLearningQuiz } from "../quiz-service";
import type { generateStudyJson } from "../framework-generator";
import { freezeLearningAgentScope } from "../agent-scope";
import { LearningAgentRepository } from "../agent-repository";
import { createLearningAgentScenario } from "../agent-scenario";
import { assessLearningCompletion, establishLearningReviewPlan } from "../agent-completion";
import fixture from "./final-g5-3c34ced.fixture.json";
import { offlineQuizSemanticResponse } from "./quiz-semantic-fixture";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const { reviewCandidates, ...originalEnvelope } = fixture.decoded;
const original = ReferencedGeneratedQuiz.parse(originalEnvelope);
const checks = QuizReviewPublication.parse({ context: fixture.reviewContext, candidates: reviewCandidates }).candidates;
const context = QuizReviewContext.parse(fixture.reviewContext);

/** Replays immutable saved candidate projections, not unavailable HTTP. Rebuilt
 * short-reference envelopes retain all question/answer/reason/source content.
 * All submissions and objective associations below use actual business services. */
export async function replayFinalG5Publication(directory: string) {
  const inputHash = hash(fixture), accountId = randomUUID(), page = fixture.source.page_id;
  let learning = new LearningRepository(directory, accountId), quizzes = new LearningQuizRepository(learning);
  let offlineResponses = 0, semanticReviewResponses = 0;
  const matrix: Array<{ index: number; candidateHash: string; composition: string; publication: string; savedIndex: number | null }> = [];
  try {
    learning.create({ id: page, title: "[离线原题投影] FINAL-G5-1" });
    learning.saveMaterials(page, [{ id: fixture.source.id, title: fixture.source.title, kind: "text", filename: null, bytes: Buffer.from(fixture.source.original) }]);
    const { count: _count, difficulty: _difficulty, ...selection } = fixture.settings;
    const scope = freezeLearningAgentScope(learning, page, { ...selection, includeHistory: false });
    const task: AgentTask = { id: randomUUID(), accountId, resourceId: page, scenario: "learning.adaptive-review.v1", version: 1,
      goal: fixture.goal, scope: { ...scope, completionVersion: 1 }, status: "running", actions: [],
      budget: { maxCalls: 16, maxSteps: 16, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 600000, maxNoProgress: 3 },
      usage: { calls: 0, steps: 0, computeMs: 0, unknownUsageCalls: 0, inputTokens: null, outputTokens: null }, createdAt: "synthetic", updatedAt: "synthetic" };
    const ctx: AgentContext = { task, actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {},
      call: async (_request, invoke) => (await invoke()).value };
    const plan = establishLearningReviewPlan(learning, ctx, fixture.plan);
    const currentContext = { ...context, planId: plan.id };
    const runId = randomUUID(), request = scopeQuizReviewRequest(quizzes.begin(page, { id: runId, settings: fixture.settings }, 48000)!, currentContext);
    const catalog = request.materials.flatMap(material => material.paragraphs.map(paragraph => ({ referenceId: paragraph.referenceId, text: paragraph.text,
      source: { kind: "material" as const, materialId: material.materialId, paragraph: paragraph.number } })));
    const aliases = new Map(catalog.map((reference, index) => [reference.referenceId, `r${index + 1}`]));
    const short = (ids: string[]) => ids.map(id => { const alias = aliases.get(id); assert(alias, "Never guess a source ID"); return alias; });
    const requestScope = { accountId, pageId: page, requestId: runId, expiresAt: Date.now() + 120000 };
    const compact = compactQuizRequest(request, requestScope);
    const compactItems = original.items.map(q => ({ ...q, stemEvidenceIds: short(q.stemEvidenceIds), explanationEvidenceIds: short(q.explanationEvidenceIds),
      options: q.options.map(option => ({ ...option, evidenceIds: short(option.evidenceIds) })) }));
    const decoded = compact.decode({ ...original, referenceScope: compact.input.taskContext.referenceScope, items: compactItems }, requestScope);
    assert.deepEqual(decoded.items, original.items, "Exact saved candidate content and stable evidence IDs survive codec round trip");
    const report = inspectQuizCandidateDelivery(decoded, catalog);
    assert.deepEqual(report.rejected, [{ index: 3, code: "answer_not_unique" }]);
    const composed = composedQuizRequest(request, requestScope);
    // This is a deterministic wire adaptation of saved decoded content, NOT an
    // original response. No stem, option, correct ID, reason or evidence is fixed.
    const wireItems = original.items.map(q => ({ scenario: q.scenario, stem: q.stem, kind: q.kind, hint: q.hint,
      stemEvidenceIds: short(q.stemEvidenceIds), correctOptionId: q.correctOptionId,
      explanationParts: [{ text: q.explanation, evidenceIds: short(q.explanationEvidenceIds) }],
      options: q.options.map(option => ({ id: option.id, text: option.text,
        reasonParts: [{ text: option.reason, evidenceIds: short(option.evidenceIds) }] })) }));
    const wire = { contractVersion: "references-v2", title: original.title, reason: original.reason, items: wireItems };
    const issues: Array<{ index: number; stage: string; code: string }> = [];
    const composedDecoded = composed.decode(wire, requestScope, issue => issues.push(issue));
    assert.deepEqual(issues, [{ index: 3, stage: "composition", code: "answer_not_unique" }]);
    assert.deepEqual(composedDecoded.items.slice(0, 3), original.items.slice(0, 3));
    // The final fence also rejects the unchanged compact/stable candidate: it
    // cannot rely solely on a marker emitted by the earlier composition codec.
    quizzes.complete(page, runId, decoded, { context: currentContext, candidates: checks });
    const row = learning.database.prepare("SELECT status,result_json,diagnostics_json FROM learning_quiz_runs WHERE id=?").get(runId) as { status: string; result_json: string; diagnostics_json: string };
    const saved = JSON.parse(row.result_json) as SavedQuiz;
    assert.equal(row.status, "completed"); assert.equal(saved.questions.length, 3);
    assert.deepEqual(JSON.parse(row.diagnostics_json).publicationReport, report);
    for (const [index, q] of original.items.entries()) {
      matrix.push({ index, candidateHash: hash(q), composition: index === 3 ? "answer_not_unique" : "accepted",
        publication: index === 3 ? "answer_not_unique" : "published", savedIndex: index < 3 ? index : null });
      if (index === 3) continue;
      const actual = saved.questions[index], previous = fixture.saved.questions[index];
      const sort = <T extends { id: string }>(options: T[]) => [...options].sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual({ ...actual, options: sort(actual.options) }, { ...previous, options: sort(previous.options) }, "Only the new display order may differ");
    }
    const review = quizzes.review(page, runId)!;
    assert.deepEqual(review.checks.map(check => check.questionIndex), [0, 1, 2]);
    assert(!saved.questions.some(q => quizReviewQuestionKey(q) === checks[3].questionKey));
    let attempt = quizzes.startAttempt(page, { id: randomUUID(), quizId: runId, mode: "test" });
    assert(!JSON.stringify(attempt).includes("correctOptionId"));
    assert(!JSON.stringify(attempt).includes(original.items[3].options[3].reason));
    const artifacts = new LearningAgentRepository(learning);
    artifacts.reserve({ id: runId, taskId: task.id, taskVersion: 1, pageId: page, kind: "quiz", actionId: randomUUID(), binding: scope.fingerprint, materialIds: [fixture.source.id] });
    artifacts.complete(page, task.id, runId, { attemptId: attempt.id });
    for (const optionId of ["D", "A"]) assert.throws(() => quizzes.act(page, { id: randomUUID(), attemptId: attempt.id,
      revision: attempt.revision, action: "choose", question: 3, optionId }), /invalid_input/);
    assert.equal(quizzes.attempt(page, attempt.id).revision, 0, "Rejected nonexistent question creates no progress/event");
    for (const [index, q] of saved.questions.entries()) attempt = quizzes.act(page, { id: randomUUID(), attemptId: attempt.id,
      revision: attempt.revision, action: "choose", question: index, optionId: q.correctOptionId });
    const finish = { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null };
    attempt = quizzes.act(page, finish); assert.deepEqual(quizzes.act(page, finish), attempt);
    assert.equal(attempt.score?.correct, 3); assert.equal(attempt.score?.total, 3);
    const scenario = createLearningAgentScenario(learning);
    const runTool = async (name: string, input: unknown) => {
      ctx.actionId = randomUUID(); await scenario.validate(ctx);
      const tool = scenario.tools[name], result = await tool.execute(tool.parameters.parse(input), ctx);
      const receipt: AgentAction = { id: ctx.actionId, tool: name, version: 1, status: "succeeded", summary: result.summary, createdAt: "synthetic", resultRef: result.ref };
      task.actions.push(receipt);
      return tool.readResult?.(receipt, ctx);
    };
    const answers = await runTool("learning.read_answers", { attemptId: attempt.id }) as { questions: Array<{ index: number }> };
    assert.deepEqual(answers.questions.map(q => q.index), [0, 1, 2]);
    const proposal = (index: number) => ({ ref: { quizId: runId, attemptId: attempt.id, questionIndex: index }, objectiveId: checks[0].check.objectiveIds[0],
      role: "application", rationale: checks[Math.min(index, 3)].check.rationale, relevance: "supported", relation: "initial", contentStatus: "no_known_issue", priorEvidenceRefs: [] });
    await assert.rejects(runTool("learning.associate_evidence", proposal(3)), /agent_completion_evidence_invalid/);
    for (let index = 0; index < 3; index++) await runTool("learning.associate_evidence", proposal(index));
    const assessment = assessLearningCompletion(learning, task);
    assert.deepEqual(assessment.objectives[0].evidence.map(e => e.ref.questionIndex), [0, 1, 2]);
    assert.deepEqual(assessment.objectives[0].unresolvedErrors, []);
    assert.notEqual(assessment.outcome, "check_passed");
    assert(assessment.objectives[0].requirements.some(r => r.role === "concept" && !r.supported));
    artifacts.dispute(page, task.id, attempt.id);
    assert(assessLearningCompletion(learning, task).objectives[0].evidence.every(e => e.quality === "disputed"));
    assert.equal(quizzes.attempt(page, attempt.id).score?.correct, 3, "A dispute does not rewrite grades");
    // Exercise the real generation entry as well, using one explicitly offline
    // response derived from the exact saved candidates and annotation mapping.
    const generatedId = randomUUID();
    const generate = (async (_config, schema, _instruction, input) => {
      if (schema === "learning_quiz_semantic_review") { semanticReviewResponses++; return offlineQuizSemanticResponse(input); }
      offlineResponses++; return { ...wire, items: wire.items.map((q, i) => ({ ...q, reviewCheck: checks[i].check })) };
    }) as typeof generateStudyJson;
    const runs = await generateLearningQuiz(learning, page, { id: generatedId, settings: fixture.settings }, {
      configure: () => ({ baseURL: "https://unused.invalid/v1", apiKey: "synthetic-only", model: "offline", maxInputChars: 48000, maxOutputTokens: 8000 }), generate,
      reviewContext: currentContext, diagnosticContext: { taskId: task.id, taskVersion: 1, actionId: randomUUID() } });
    const generated = runs.find(run => run.id === generatedId)!;
    assert.equal(generated.status, "completed"); assert.equal(generated.count, 3); assert.equal(offlineResponses, 1); assert.equal(semanticReviewResponses, 1);
    const part = learning.database.prepare("SELECT diagnostics_json FROM learning_generation_parts WHERE run_id=?").get(generatedId) as { diagnostics_json: string };
    const diagnostics = JSON.parse(part.diagnostics_json).candidateDiagnostics;
    assert.deepEqual(diagnostics.issues, [{ index: 3, stage: "composition", code: "answer_not_unique" }]);
    assert.deepEqual(diagnostics.candidates[0].candidate, { ...wireItems[3], reviewCheck: checks[3].check });
    learning.close(); learning = new LearningRepository(directory, accountId); quizzes = new LearningQuizRepository(learning);
    assert.deepEqual(quizzes.act(page, finish), attempt);
    assert.equal(learning.database.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(hash(fixture), inputHash);
    assert.equal(fixture.originalAttempt.revision, 0); assert.deepEqual(fixture.originalAttempt.events_json, []);
    return { status: "PASS", layer: "Exact saved public candidates; formal offline codec/publication/SQLite/submission/evidence services, not original HTTP or real DS",
      inputHash, matrix, publicationReport: report,
      membership: inspectLiteralSetMembership(`${original.items[3].scenario}\n${original.items[3].stem}`, original.items[3].options, original.items[3].correctOptionId),
      score: attempt.score, readAnswerIndexes: answers.questions.map(q => q.index), objectiveAssessment: assessment,
      rejectedQuestionSubmission: "invalid_input; zero events", rejectedQuestionEvidence: "agent_completion_evidence_invalid; zero proposals",
      generation: { published: generated.count, offlineResponses, semanticReviewResponses, issues: diagnostics.issues },
      originalWindowsAttempt: "Unanswered, unchanged", originalInputUnchanged: true, duplicateSubmit: "PASS", restart: "PASS", dispute: "PASS", sqliteIntegrity: "ok", realProviderCalls: 0 };
  } finally { if (learning.database.open) learning.close(); }
}
