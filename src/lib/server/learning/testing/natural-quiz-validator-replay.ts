// Public Windows candidate projections only. This harness never imports a
// Provider, restores private databases, or writes a score/task state directly.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import { ReferencedGeneratedQuiz, type ReferencedQuizResponse, type SavedQuiz } from "@/lib/domain/learning-quiz";
import { LearningRepository } from "../repository";
import { LearningQuizRepository } from "../quiz-repository";
import { composedQuizRequest } from "../quiz-composition";
import { compactQuizRequest } from "../quiz-compact";
import { inspectQuizCandidateDelivery, inspectQuizOptionExplanation } from "../quiz-grounding";
import { decodeReviewQuiz, quizReviewQuestionKey, scopeQuizReviewRequest, type QuizReviewContext, type QuizReviewPublication } from "../quiz-review-purpose";
import type { QuizCandidateIssue } from "../quiz-candidate-diagnostics";

type Question = z.infer<typeof ReferencedGeneratedQuiz>["items"][number];
type Group = { id: string; goal: string; runId: string; settings: unknown; context: QuizReviewContext;
  decoded: ReferencedQuizResponse & { reviewCandidates: QuizReviewPublication["candidates"] };
  candidates: Array<{ index: number; candidate: Record<string, unknown> }>; expected: Array<null | string> };
export type RetainedValidatorFixture = { provenance: unknown; accountId: string; pageId: string;
  source: { id: string; title: string; original: string; sha256: string }; groups: Group[] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Every retained field is immutable. Five rejected candidates have their exact
 * composed projection. The two published candidates have only decoded fields:
 * their full text is round-tripped through the compact codec using the actual
 * source map, never labelled a reconstructed original model response. */
export function replayRetainedQuizValidators(fixture: RetainedValidatorFixture, dataDir: string) {
  const inputHash = hash(JSON.stringify(fixture));
  assert.equal(hash(fixture.source.original), fixture.source.sha256);
  let learning = new LearningRepository(dataDir, fixture.accountId);
  let quizzes = new LearningQuizRepository(learning);
  const page = fixture.pageId;
  learning.create({ id: page, title: "[离线原公开投影回放] 集合课程" });
  learning.saveMaterials(page, [{ id: fixture.source.id, title: fixture.source.title, kind: "text", filename: null,
    bytes: Buffer.from(fixture.source.original) }]);
  const results: Array<{ id: string; count: number; expectedCount: number; status: string; attemptId: string; score: unknown;
    rows: Array<{ id: string; index: number; expected: string; actual: string; stage: string; reason: string | null; inputHash: string; evidenceTier: string }> }> = [];
  try {
    for (const group of fixture.groups) {
      const begin = quizzes.begin(page, { id: group.runId, settings: group.settings }, 48000)!;
      assert(begin);
      const request = scopeQuizReviewRequest(begin, group.context);
      const catalog = request.materials.flatMap(material => material.paragraphs.map(paragraph => ({
        referenceId: paragraph.referenceId, text: paragraph.text,
        source: { kind: "material" as const, materialId: material.materialId, paragraph: paragraph.number }
      })));
      const aliases = new Map(catalog.map((reference, index) => [reference.referenceId, `r${index + 1}`]));
      const scope = { accountId: fixture.accountId, pageId: page, requestId: group.runId, expiresAt: Date.now() + 120_000 };
      const decodedItems: unknown[] = [], checks: QuizReviewPublication["candidates"] = [], issues: QuizCandidateIssue[] = [];
      const inputRecords: Array<{ value: unknown; tier: string }> = [];
      for (let index = 0; index < group.expected.length; index++) {
        const retained = group.candidates.find(candidate => candidate.index === index);
        const onIssue = (issue: QuizCandidateIssue) => issues.push({ ...issue, index });
        if (retained) {
          const codec = composedQuizRequest(request, scope);
          const response = { contractVersion: "references-v2", title: group.decoded.title, reason: null,
            items: [structuredClone(retained.candidate)] };
          const decoded = decodeReviewQuiz(response, value => codec.decode(value, scope, onIssue), group.context, catalog, onIssue);
          decodedItems.push(decoded.items[0]); checks.push(...decoded.reviewCandidates!);
          inputRecords.push({ value: retained.candidate, tier: "Exact untruncated composed candidate diagnostic projection" });
        } else {
          const original = ReferencedGeneratedQuiz.shape.items.element.parse(group.decoded.items[index]);
          const codec = compactQuizRequest(request, scope);
          const compactIds = (ids: string[]) => ids.map(id => { const alias = aliases.get(id); assert(alias, `Missing original source ${id}`); return alias; });
          const compact = { ...original, stemEvidenceIds: compactIds(original.stemEvidenceIds),
            explanationEvidenceIds: compactIds(original.explanationEvidenceIds),
            options: original.options.map(option => ({ ...option, evidenceIds: compactIds(option.evidenceIds) })) };
          const decoded = codec.decode({ contractVersion: "references-v2", referenceScope: codec.input.taskContext.referenceScope,
            title: group.decoded.title, reason: null, items: [compact] }, scope, onIssue);
          assert.deepEqual(decoded.items[0], original, "Compact source round-trip preserves every saved question field");
          const question = decoded.items[0] as Question;
          const context = `${question.scenario ?? ""}\n${question.stem}`;
          for (const prose of [question.explanation, ...question.options.map(option => option.reason)]) {
            const bound = inspectQuizOptionExplanation(prose, question.options, question.correctOptionId, context);
            assert.equal(bound.issue, null); assert.equal(bound.text, prose);
          }
          const check = group.decoded.reviewCandidates.find(candidate => candidate.questionKey === quizReviewQuestionKey(question));
          assert(check, "Use the actual saved reviewCheck; never invent a missing association");
          decodedItems.push(question); checks.push(check);
          inputRecords.push({ value: original, tier: "Exact saved decoded candidate; deterministic compact-source round-trip, not original composed wire" });
        }
      }
      const body = { contractVersion: "references-v2" as const, title: group.decoded.title,
        // Preserve this historical envelope's recorded reason too. It may include
        // old rejection notices; the replay matrix, not that old prose, is the verdict.
        reason: group.decoded.reason, items: decodedItems };
      const report = inspectQuizCandidateDelivery(body, catalog);
      const rows = group.expected.map((expected, index) => {
        const rejection = report.rejected.find(candidate => candidate.index === index);
        const priorIssue = issues.find(issue => issue.index === index);
        assert.equal(rejection?.code ?? null, expected, `${group.id}-${index + 1}: exact publication rejection reason`);
        if (expected === "equivalent_options") assert.equal(priorIssue, undefined, "Equivalent wrong questions must reach the real equivalence gate");
        return { id: `${group.id}-${index + 1}`, index, expected: expected ?? "published", actual: rejection?.code ?? "published",
          stage: rejection ? priorIssue?.stage ?? "publication" : "saved", reason: rejection?.code ?? null,
          inputHash: hash(JSON.stringify(inputRecords[index].value)), evidenceTier: inputRecords[index].tier };
      });
      quizzes.complete(page, group.runId, body, { context: group.context, candidates: checks });
      const row = learning.database.prepare("SELECT status,result_json,diagnostics_json FROM learning_quiz_runs WHERE id=?").get(group.runId) as { status: string; result_json: string; diagnostics_json: string };
      const saved = JSON.parse(row.result_json) as SavedQuiz;
      const diagnostics = JSON.parse(row.diagnostics_json);
      assert.deepEqual(diagnostics.publicationReport.rejected, report.rejected);
      const expectedCount = group.expected.filter(expected => expected === null).length;
      assert.equal(row.status, "completed"); assert.equal(saved.questions.length, expectedCount);
      const expectedQuestions = decodedItems.filter((_, index) => group.expected[index] === null) as Question[];
      const review = quizzes.review(page, group.runId)!;
      assert.equal(review.checks.length, expectedCount);
      for (const [index, question] of saved.questions.entries()) {
        const original = expectedQuestions[index];
        assert.equal(question.stem, original.scenario ? `${original.scenario}\n\n${original.stem}` : original.stem);
        assert.equal(question.correctOptionId, original.correctOptionId);
        assert.deepEqual([...question.options].sort((a,b) => a.id.localeCompare(b.id)).map(({ id, text, reason, evidenceIds }) => ({ id, text, reason, evidenceIds })),
          [...original.options].sort((a,b) => a.id.localeCompare(b.id)));
        assert.deepEqual(question.stemEvidenceIds, original.stemEvidenceIds);
        assert.deepEqual(question.explanationEvidenceIds, original.explanationEvidenceIds);
        assert.equal(question.explanation, original.explanation);
        const expectedCheck = checks.find(candidate => candidate.questionKey === quizReviewQuestionKey(original))!.check;
        assert.deepEqual(review.checks[index], { ...expectedCheck, questionIndex: index, semanticProvenance: "model_proposal" });
        for (const evidence of question.evidence!) assert(catalog.some(reference => reference.referenceId === evidence.referenceId && reference.text === evidence.quote));
      }
      let attempt = quizzes.startAttempt(page, { id: randomUUID(), quizId: group.runId, mode: "test" });
      assert(!JSON.stringify(attempt).includes("correctOptionId")); assert(!JSON.stringify(attempt).includes("rationale"));
      // New explicitly simulated students, through the formal stable-ID action
      // service. These are not the single original Windows 1/1 submission.
      for (const question of attempt.questions) {
        assert(!("explanation" in question));
        attempt = quizzes.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision,
          action: "choose", question: question.index, optionId: saved.questions[question.index].correctOptionId });
      }
      const submit = { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null };
      attempt = quizzes.act(page, submit);
      assert.deepEqual(quizzes.act(page, submit), attempt, "Duplicate submit must reuse the saved result");
      assert.equal(attempt.score?.correct, expectedCount); assert.equal(attempt.score?.total, expectedCount);
      results.push({ id: group.id, count: saved.questions.length, expectedCount, status: row.status, attemptId: attempt.id, score: attempt.score, rows });
      console.log(`[retained publication replay] ${results.length}/${fixture.groups.length}: ${group.id} ${saved.questions.length}/${group.expected.length} published`);
    }
    learning.close(); learning = new LearningRepository(dataDir, fixture.accountId); quizzes = new LearningQuizRepository(learning);
    for (const result of results) {
      const group = fixture.groups.find(group => group.id === result.id)!;
      assert.equal(quizzes.list(page).find(quiz => quiz.id === group.runId)!.count, result.count);
      assert.deepEqual(quizzes.attempt(page, result.attemptId).score, result.score);
    }
    assert.equal(learning.database.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(hash(JSON.stringify(fixture)), inputHash, "All evidence fields remain unchanged");
    return { status: "PASS", groups: results, candidates: results.flatMap(result => result.rows), inputHash,
      realProviderCalls: 0, sqliteIntegrity: "ok", restart: "PASS", duplicateSubmit: "PASS",
      limits: ["Public candidate projections and decoded business records, not original HTTP or private Windows database.",
        "Five exact composed projections; two exact saved decoded candidates round-trip through compact source codec.",
        "Fresh isolated request scope metadata is generated locally; no claim to replay an unavailable original referenceScope.",
        "New simulated correct submissions verify scoring/storage only, not original student history or real DS success.",
        "Old envelope reason text is preserved, including historical rejection notices; the new per-candidate matrix is authoritative for this replay.",
        "The prior batch's five missing candidate bodies remain UNKNOWN."] };
  } finally { if (learning.database.open) learning.close(); }
}
