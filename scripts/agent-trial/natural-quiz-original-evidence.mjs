// Offline repository replay of retained Windows decoded Quiz outputs.
// This does not recreate the missing Provider wire response, lost candidates,
// Agent decisions, or a Windows private database. Never edits input evidence.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const evidenceDir = option('--evidence-dir'), outputDir = option('--output-dir');
const phase = option('--phase') ?? 'after';
if (!evidenceDir || !outputDir || !['before', 'after'].includes(phase)) {
  throw Error('Required: --evidence-dir <extracted ZIP root> --output-dir <new isolated directory> [--phase before|after]');
}
if (fs.existsSync(outputDir)) throw Error('Output directory already exists; choose a fresh isolated replay directory.');
const evidence = path.resolve(evidenceDir), out = path.resolve(outputDir), repo = process.cwd();
if (out === evidence || out.startsWith(evidence + path.sep)) throw Error('Replay output must be separate from immutable input evidence.');
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(evidence, file), 'utf8').replace(/^\uFEFF/, ''));
const originalManifest = fs.readFileSync(path.join(evidence, 'MANIFEST.json'));
const manifest = read('MANIFEST.json');
for (const item of manifest) {
  const file = path.resolve(evidence, item.file);
  assert(file.startsWith(evidence + path.sep), 'evidence path must remain inside archive');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, item.bytes, item.file);
  assert.equal(hash(bytes), item.sha256, item.file);
}
fs.mkdirSync(out, { recursive: true });
const { LearningRepository } = await import(pathToFileURL(path.join(repo, 'src/lib/server/learning/repository.ts')).href);
const { LearningQuizRepository } = await import(pathToFileURL(path.join(repo, 'src/lib/server/learning/quiz-repository.ts')).href);
const { quizReviewQuestionKey } = await import(pathToFileURL(path.join(repo, 'src/lib/server/learning/quiz-review-purpose.ts')).href);
const sourceData = read('semantic-audit/G1-latest.json');
const account = sourceData.task.account_id, page = sourceData.task.resource_id;
let learning = new LearningRepository(path.join(out, 'data'), account);
let quizzes = new LearningQuizRepository(learning);
learning.create({ id: page, title: '[离线原公开投影回放] 集合课程' });
learning.saveMaterials(page, [{ id: sourceData.source.id, title: sourceData.source.title,
  kind: 'text', filename: null, bytes: Buffer.from(sourceData.source.original) }]);
assert.equal(hash(sourceData.source.original), sourceData.source.sha256);
const results = [];
try {
  for (const key of ['G1', 'G3', 'G5']) {
    const data = read(`semantic-audit/${key}-latest.json`);
    assert.equal(data.source.original, sourceData.source.original);
    for (const original of data.quizzes) {
      const run = original.run;
      const decodedParts = original.parts.filter(p => p.part_id.startsWith('questions-') && p.result_json).map(p => p.result_json);
      assert.equal(decodedParts.length, 1, 'retained scenarios each have one decoded question part');
      const decoded = decodedParts[0];
      const { reviewCandidates, ...body } = decoded;
      const review = { context: run.result_json.review.context, candidates: reviewCandidates ?? [] };
      const inputBefore = hash(JSON.stringify({ body, review, original }));
      quizzes.begin(page, { id: run.id, settings: run.settings_json }, 48000);
      quizzes.complete(page, run.id, body, review);
      const summary = quizzes.list(page).find(q => q.id === run.id);
      const savedRow = learning.database.prepare('SELECT result_json,diagnostics_json FROM learning_quiz_runs WHERE id=?').get(run.id);
      const saved = JSON.parse(savedRow.result_json);
      const diagnostics = JSON.parse(savedRow.diagnostics_json ?? '{}');
      const originalRejections = run.diagnostics_json.candidateReports['questions-0'].rejected;
      assert.deepEqual(diagnostics.publicationReport.rejected, key === 'G3' && phase === 'after'
        ? [...originalRejections, { index: 1, code: 'review_source_mismatch' }] : originalRejections,
      'exact rejection stage/category: do not substitute incidental content rejection for source mismatch');
      const expectedCount = key === 'G3' && phase === 'after' ? 0 : run.result_json.questions.length;
      assert.equal(summary.count, expectedCount, `${key}: publication count`);
      assert.equal(summary.status, expectedCount ? 'completed' : 'insufficient');
      const originalKeys = new Map(run.result_json.questions.map(q => [quizReviewQuestionKey(q), q]));
      for (const q of saved.questions) {
        const prior = originalKeys.get(quizReviewQuestionKey(q));
        assert(prior, 'published question must retain original stem, stable option IDs and correct ID');
        assert.deepEqual([...q.options].sort((a,b)=>a.id.localeCompare(b.id)), [...prior.options].sort((a,b)=>a.id.localeCompare(b.id)));
        for (const field of ['stem','kind','correctOptionId','explanation','hint','stemEvidenceIds','explanationEvidenceIds','evidence']) assert.deepEqual(q[field], prior[field], field);
        assert.deepEqual(q.sources, prior.sources, 'original source IDs, paragraph hashes and boundaries remain exact');
      }
      let score = null, attemptId = null;
      if (expectedCount) {
        const prior = original.attempts[0];
        assert(prior, 'every retained published group has one actual simulated-student submission');
        let attempt = quizzes.startAttempt(page, { id: prior.id, quizId: run.id, mode: prior.mode });
        assert(!JSON.stringify(attempt).includes('correctOptionId'));
        assert(!JSON.stringify(attempt).includes('rationale'));
        for (const question of attempt.questions) {
          const response = prior.progress_json[question.index];
          assert(response.optionId && !response.hinted && !response.revealed && !response.skipped);
          attempt = quizzes.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision,
            action: 'choose', question: question.index, optionId: response.optionId });
        }
        attempt = quizzes.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: 'finish', question: 0, optionId: null });
        assert.deepEqual(attempt.score, prior.evaluation_json.score, 'same original stable-ID response must produce same score through formal repository');
        score = attempt.score; attemptId = attempt.id;
      }
      assert.equal(hash(JSON.stringify({ body, review, original })), inputBefore, 'never mutate retained evidence');
      results.push({ trajectory: key, quizId: run.id, expectedCount, actualCount: summary.count, status: summary.status,
        originalCount: run.result_json.questions.length, originalAttemptPreservedInInput: original.attempts.length,
        actualRepositoryScore: score, attemptId, diagnostics });
      console.log(`${results.length}/4 retained decoded group ${key}: ${summary.status}, ${summary.count} published`);
    }
  }
  assert.equal(results.length, 4);
  learning.close(); learning = new LearningRepository(path.join(out, 'data'), account); quizzes = new LearningQuizRepository(learning);
  for (const result of results) {
    assert.equal(quizzes.list(page).find(q => q.id === result.quizId).count, result.actualCount);
    if (result.attemptId) assert.deepEqual(quizzes.attempt(page, result.attemptId).score, result.actualRepositoryScore);
  }
  assert.equal(learning.database.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(hash(fs.readFileSync(path.join(evidence, 'MANIFEST.json'))), hash(originalManifest));
  for (const entry of manifest) assert.equal(hash(fs.readFileSync(path.join(evidence, entry.file))), entry.sha256, 'input evidence remains unchanged');
  const result = { status: 'PASS', phase, manifestVerified: manifest.length, groups: results.length, realProviderRequests: 0,
    inputUnmodified: true, restart: 'PASS', sqliteIntegrity: 'ok', results,
    layer: 'Retained decoded response → formal Quiz repository publication → answer-free attempt → original stable-ID simulated response → saved score → reopen',
    limits: ['No original Provider HTTP payload is available; five original rejected candidate bodies are missing and are not reconstructed.',
      'G3 after-repair rejects the known incompatible association before new publication. Its original Windows saved 1/1 remains untouched in evidence.',
      'This is not an AgentRuntime replay, browser interaction, original private database restoration, or real DS semantic acceptance.'] };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
} finally { if (learning.database.open) learning.close(); }
