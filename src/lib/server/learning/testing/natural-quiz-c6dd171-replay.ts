// Retained public evidence only. No private Windows database or Provider access.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ReferencedGeneratedQuiz, type SavedQuiz } from "@/lib/domain/learning-quiz";
import { LearningRepository } from "../repository";
import { LearningQuizRepository } from "../quiz-repository";
import { generateLearningQuiz } from "../quiz-service";
import type { generateStudyJson } from "../framework-generator";
import { quizReviewQuestionKey } from "../quiz-review-purpose";
import { replayRetainedQuizValidators, type RetainedValidatorFixture } from "./natural-quiz-validator-replay";
import { offlineQuizSemanticResponse } from "./quiz-semantic-fixture";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The original seven are exercised by the existing retained replay. This is a
 * thin extension for the seven new c6dd171 candidates and the exact boundary
 * candidate's three separate facts: raw enum rejection, explicit input alias,
 * and successful generation/publication with untouched mathematical content. */
export async function replayC6RetainedQuizValidators(fixture: RetainedValidatorFixture, dataDir: string) {
  const inputHash = hash(fixture);
  const published = replayRetainedQuizValidators(fixture, join(dataDir, "publication"));
  const group = fixture.groups.find(group => group.id === "G5-R1")!;
  assert(group);
  const retained = group.candidates.find(candidate => candidate.index === 2)!;
  assert(retained);
  const strictKind = ReferencedGeneratedQuiz.shape.items.element.shape.kind.safeParse(retained.candidate.kind);
  assert.equal(retained.candidate.kind, "boundary");
  assert.equal(strictKind.success, false, "The saved domain enum must remain strict");
  if (strictKind.success) throw Error("Expected strict enum rejection before normalization");

  const root = join(dataDir, "generation");
  let learning = new LearningRepository(root, fixture.accountId);
  let repo = new LearningQuizRepository(learning);
  const page = fixture.pageId, runId = group.runId;
  const raw = { contractVersion: "references-v2", title: group.decoded.title, reason: null,
    items: group.candidates.map(candidate => structuredClone(candidate.candidate)) };
  const rawHash = hash(raw);
  let offlineResponses = 0, semanticReviewResponses = 0;
  const generate = (async (_config, schema, _instruction, input) => {
    // The retained disjoint-sets candidate has been checked offline: A is the
    // sole correct option. This fixture is not real model-review evidence.
    if (schema === "learning_quiz_semantic_review") {
      semanticReviewResponses++;
      return offlineQuizSemanticResponse(input, "A");
    }
    assert.equal(schema, "learning_quiz");
    offlineResponses++;
    return structuredClone(raw);
  }) as typeof generateStudyJson;
  try {
    learning.create({ id: page, title: "[离线原投影] 已知题型别名生成回放" });
    learning.saveMaterials(page, [{ id: fixture.source.id, title: fixture.source.title, kind: "text", filename: null,
      bytes: Buffer.from(fixture.source.original) }]);
    const runs = await generateLearningQuiz(learning, page, { id: runId, settings: group.settings }, {
      configure: () => ({ baseURL: "https://unused.invalid/v1", apiKey: "synthetic-only", model: "offline", maxInputChars: 48000, maxOutputTokens: 8000 }),
      generate, reviewContext: group.context,
      diagnosticContext: { taskId: "retained-c6-G5", taskVersion: group.context.taskVersion, actionId: "retained-c6-G5:quiz" }
    });
    const run = runs.find(row => row.id === runId)!;
    assert.equal(run.status, "completed"); assert.equal(run.count, 1); assert.equal(offlineResponses, 1); assert.equal(semanticReviewResponses, 1);
    const part = learning.database.prepare("SELECT diagnostics_json,result_json FROM learning_generation_parts WHERE run_id=? AND part_id='questions-0'")
      .get(runId) as { diagnostics_json: string; result_json: string };
    const details = JSON.parse(part.diagnostics_json).candidateDiagnostics;
    const normalization = details.normalizations.find((entry: { index: number }) => entry.index === 2);
    assert(normalization, "The actual service must persist the explicit normalization separately from rejection");
    assert.equal(normalization.originalKind, "boundary"); assert.equal(normalization.normalizedKind, "application");
    assert.equal(details.issues.some((entry: { index: number }) => entry.index === 2), false, "Normalization is not a rejected candidate");
    assert.deepEqual(details.candidates.find((entry: { index: number }) => entry.index === 2).candidate, retained.candidate,
      "Keep the exact original final candidate, including its boundary value");
    const body = JSON.parse(part.result_json);
    // Deterministic rejection now happens before independent review. Original
    // index 2 remains in diagnostics; only that one candidate is forwarded.
    assert.equal(body.items.length, 1);
    const normalized = body.items[0];
    assert.equal(normalized.kind, "application");
    assert.equal(normalized.stem, retained.candidate.stem);
    assert.equal(normalized.scenario, retained.candidate.scenario);
    assert.equal(normalized.correctOptionId, retained.candidate.correctOptionId);
    const rawOptions = retained.candidate.options as Array<{ id: string; text: string; reasonParts: Array<{ text: string }> }>;
    for (const original of rawOptions) {
      const option = normalized.options.find((candidate: { id: string }) => candidate.id === original.id);
      assert.equal(option.text, original.text); assert.equal(option.reason, original.reasonParts.map(part => part.text).join("\n"));
    }
    assert.equal(body.reviewCandidates.find((entry: { questionKey: string }) => entry.questionKey === quizReviewQuestionKey(normalized))?.check.role, "concept");
    const record = learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(runId) as { result_json: string };
    const saved = JSON.parse(record.result_json) as SavedQuiz;
    assert.equal(saved.questions.length, 1); assert.equal(saved.questions[0].kind, "application");
    assert.equal(repo.review(page, runId)!.checks[0].questionIndex, 0, "Filtered candidate index 2 maps to published index 0");
    let attempt = repo.startAttempt(page, { id: randomUUID(), quizId: runId, mode: "test" });
    assert(!JSON.stringify(attempt).includes("correctOptionId")); assert(!JSON.stringify(attempt).includes("candidateDiagnostics"));
    attempt = repo.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: saved.questions[0].correctOptionId });
    const finish = { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null };
    attempt = repo.act(page, finish); assert.deepEqual(repo.act(page, finish), attempt);
    assert.equal(attempt.score?.correct, 1); assert.equal(attempt.score?.total, 1);
    learning.close(); learning = new LearningRepository(root, fixture.accountId); repo = new LearningQuizRepository(learning);
    assert.deepEqual(repo.attempt(page, attempt.id).score, attempt.score);
    assert.equal(learning.database.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(hash(raw), rawHash); assert.equal(hash(fixture), inputHash);
    // The older reusable harness numbers display rows from 1. The Windows
    // matrix for this package uses zero-based IDs; keep both without changing
    // any candidate input or silently shifting the original evidence identity.
    const groups = published.groups.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row,
      replayId: row.id, originalEvidenceId: `${group.id}-${row.index}`, originalIndex: row.index })) }));
    return { ...published, groups, candidates: groups.flatMap(group => group.rows),
      rawKindContract: { value: "boundary", accepted: false, issues: strictKind.error.issues.map(issue => ({ code: issue.code, path: "kind" })) },
      normalization: { ...normalization, originalCandidateUnchanged: true, retainedCandidateHash: hash(retained.candidate),
        normalizedKind: normalized.kind, reviewRoleUnchanged: true, normalizedQuestionKey: quizReviewQuestionKey(normalized) },
      generationService: { status: run.status, published: run.count, offlineResponses, semanticReviewResponses, realProviderCalls: 0, score: attempt.score,
        filteredOriginalIndex: 2, publishedIndex: 0, duplicateSubmit: "PASS", restart: "PASS", sqliteIntegrity: "ok" },
      limits: ["Exact public final candidate projections and saved decoded questions; not original HTTP or private Windows DB replay.",
        "Four raw composed candidates and three saved decoded candidates use the existing official codecs and unchanged source bindings.",
        "boundary remains invalid in the stored enum; its explicit input-only normalization is recorded separately and does not alter the retained raw candidate.",
        "New offline simulated submissions verify business storage/scoring; they are not original Windows student history or real DS quality evidence.",
        "The original G3 second group remains unanswered in Windows; no original score has been changed.",
        "Unobtained historical HTTP and candidate bodies remain UNKNOWN."] };
  } finally { if (learning.database.open) learning.close(); }
}
