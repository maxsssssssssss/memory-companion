// Portable exact-input validation for the d84eaa9 Windows candidate package.
// Offline only. Run from the repository with --import tsx and offline.cjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const option = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const evidenceDir = option('--evidence-dir'), outputDir = option('--output-dir');
if (!evidenceDir || !outputDir) throw Error('Required --evidence-dir <public-evidence> --output-dir <fresh directory>');
const evidence = path.resolve(evidenceDir), out = path.resolve(outputDir);
assert(!fs.existsSync(out), 'Do not overwrite an earlier replay');
assert(out !== evidence && !out.startsWith(evidence + path.sep), 'Do not write into immutable evidence');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(evidence, file), 'utf8'));
const manifest = read('MANIFEST.json');
const verify = () => {
  for (const entry of manifest) {
    const full = path.resolve(evidence, entry.path);
    assert(full.startsWith(evidence + path.sep));
    const bytes = fs.readFileSync(full);
    assert.equal(bytes.length, entry.bytes, entry.path); assert.equal(sha256(bytes), entry.sha256, entry.path);
  }
};
verify();
const originals = ['G3', 'G5'].map(id => read(`semantic/${id}-latest.json`));
const matrix = read('CANDIDATE_MATRIX.json');
assert.equal(matrix.sha, 'd84eaa97173f9fba88c596c94c04e167603589b2');
assert.equal(matrix.candidateCount, 7);
const groups = originals.flatMap((original, trajectory) => original.quizzes.map((quiz, index) => {
  assert.deepEqual(original.source, originals[0].source);
  const part = quiz.parts.find(part => part.part_id === 'questions-0');
  const diagnostic = part.diagnostics_json.candidateDiagnostics;
  assert.equal(diagnostic.truncated, false); assert.equal(diagnostic.omittedCandidates, 0);
  return { id: `${trajectory ? 'G5' : 'G3'}-${index + 1}`, taskId: original.task.id, goal: original.task.goal,
    runId: quiz.run.id, settings: quiz.run.settings_json, context: quiz.run.result_json.review.context,
    decoded: part.result_json, candidates: diagnostic.candidates,
    expected: trajectory ? [null, 'equivalent_options', null] : index ? [null, 'equivalent_options'] : [null, null] };
}));
assert.equal(groups.length, 3);
const fixture = { provenance: { sha: matrix.sha, source: 'Windows public business projection; original HTTP unavailable',
  inputFileSha256: Object.fromEntries(['G3-latest.json', 'G5-latest.json'].map(name => [name, sha256(fs.readFileSync(path.join(evidence, 'semantic', name)))])) },
  accountId: originals[0].task.account_id, pageId: originals[0].task.resource_id, source: originals[0].source, groups };
// This tracked test fixture is an exact field projection, not a second editable
// authority for the original evidence. Compare it before running business code.
const tracked = JSON.parse(fs.readFileSync('src/lib/server/learning/testing/natural-quiz-d84eaa9.fixture.json', 'utf8'));
assert.deepEqual(fixture, tracked, 'All original candidate/plan/source fields must match the frozen regression fixture');
fs.mkdirSync(out, { recursive: true });
const { replayRetainedQuizValidators } = await import(pathToFileURL(path.resolve('src/lib/server/learning/testing/natural-quiz-validator-replay.ts')).href);
try {
  const result = replayRetainedQuizValidators(fixture, path.join(out, 'data'));
  verify();
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...result, manifestVerified: manifest.length, originalEvidenceUnchanged: true }, null, 2));
  console.log(JSON.stringify({ status: result.status, candidates: result.candidates.length,
    published: result.candidates.filter(row => row.actual === 'published').length,
    equivalentRejected: result.candidates.filter(row => row.actual === 'equivalent_options').length,
    manifestVerified: manifest.length, realProviderCalls: 0 }));
} catch (error) {
  verify();
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ status: 'FAIL', message: error.message, manifestVerified: manifest.length, originalEvidenceUnchanged: true }, null, 2));
  throw error;
}
