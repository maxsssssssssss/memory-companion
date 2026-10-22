// Offline replay of the c6dd171 evidence and its original d84eaa9 seven-candidate
// baseline. Unzip both public packages first; no private database is required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const evidenceDir = option('--evidence-dir'), originalDir = option('--original-evidence-dir'), outputDir = option('--output-dir');
assert(evidenceDir && originalDir && outputDir, 'Required --evidence-dir <new package> --original-evidence-dir <inner public-evidence> --output-dir <fresh output>');
const evidence = path.resolve(evidenceDir), original = path.resolve(originalDir), out = path.resolve(outputDir);
assert(!fs.existsSync(out), 'Do not overwrite a previous replay');
for (const source of [evidence, original]) assert(out !== source && !out.startsWith(source + path.sep), 'Keep output separate from immutable inputs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''));
const manifest = read(evidence, 'MANIFEST.json'), originalManifest = read(original, 'MANIFEST.json');
assert.equal(manifest.sha, 'c6dd17158df3d6ac57e90c23554089d0eecfac94');
assert.equal(manifest.files.length, 46); assert.equal(originalManifest.length, 91);
const verify = (root, entries) => {
  for (const entry of entries) {
    const file = path.resolve(root, entry.path.replaceAll('\\', '/'));
    assert(file.startsWith(root + path.sep), 'Manifest path must remain inside evidence');
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, entry.bytes, entry.path); assert.equal(hash(bytes), entry.sha256, entry.path);
  }
};
verify(evidence, manifest.files); verify(original, originalManifest);
assert.equal(hash(fs.readFileSync(path.join(evidence, 'offline-baseline/original-91-evidence.zip'))), '773f79d63db86985f9657bb7c4648c781fccc49a89ff83a9d6fa690f56dfc11f');
const projections = ['G3', 'G5'].map(name => read(evidence, `semantic-audit/${name}-latest.json`));
assert.deepEqual(projections[0].source, projections[1].source);
const groups = projections.flatMap((projection, trajectory) => projection.quizzes.map((quiz, index) => {
  const part = quiz.parts.find(part => part.part_id === 'questions-0');
  const diagnostics = part.diagnostics_json.candidateDiagnostics;
  if (diagnostics) { assert.equal(diagnostics.truncated, false); assert.equal(diagnostics.omittedCandidates, 0); }
  return { id: `${trajectory ? 'G5' : 'G3'}-R${index + 1}`, taskId: projection.task.id, goal: projection.task.goal,
    runId: quiz.run.id, settings: quiz.run.settings_json, context: quiz.run.result_json.review.context,
    decoded: part.result_json, candidates: diagnostics?.candidates ?? [],
    expected: trajectory ? ['equivalent_options', 'equivalent_options', null] : index ? ['equivalent_options', null] : [null, 'equivalent_options'] };
}));
const fixture = { provenance: { sha: manifest.sha, source: 'Exact retained Windows public candidate projections and decoded records; original HTTP unavailable',
  inputFileSha256: Object.fromEntries(['G3-latest.json', 'G5-latest.json'].map(name => [name, hash(fs.readFileSync(path.join(evidence, 'semantic-audit', name)))])) },
  accountId: projections[0].task.account_id, pageId: projections[0].task.resource_id, source: projections[0].source, groups };
const tracked = read(process.cwd(), 'src/lib/server/learning/testing/natural-quiz-c6dd171.fixture.json');
assert.deepEqual(fixture, tracked, 'Every retained candidate/answer/source/reason/check field must equal the original projection');

const olderProjections = ['G3', 'G5'].map(name => read(original, `semantic/${name}-latest.json`));
const olderFixture = read(process.cwd(), 'src/lib/server/learning/testing/natural-quiz-d84eaa9.fixture.json');
for (const [trajectory, projection] of olderProjections.entries()) {
  assert.deepEqual(projection.source, olderFixture.source);
  for (const [index, quiz] of projection.quizzes.entries()) {
    const group = olderFixture.groups.find(group => group.id === `${trajectory ? 'G5' : 'G3'}-${index + 1}`);
    const part = quiz.parts.find(part => part.part_id === 'questions-0');
    assert.deepEqual(group.decoded, part.result_json); assert.deepEqual(group.candidates, part.diagnostics_json.candidateDiagnostics.candidates);
    assert.deepEqual(group.context, quiz.run.result_json.review.context); assert.deepEqual(group.settings, quiz.run.settings_json);
  }
}
fs.mkdirSync(out, { recursive: true });
const moduleAt = file => import(pathToFileURL(path.resolve(file)).href);
const { replayRetainedQuizValidators } = await moduleAt('src/lib/server/learning/testing/natural-quiz-validator-replay.ts');
const { replayC6RetainedQuizValidators } = await moduleAt('src/lib/server/learning/testing/natural-quiz-c6dd171-replay.ts');
let originalResult;
let fetchAttempts = 0;
globalThis.fetch = async () => { fetchAttempts++; throw Error('Real Provider prohibited in retained replay'); };
try {
  console.log('[evidence replay 1/2] unchanged original seven');
  originalResult = replayRetainedQuizValidators(olderFixture, path.join(out, 'original-data'));
  fs.writeFileSync(path.join(out, 'original-seven.json'), JSON.stringify(originalResult, null, 2));
  console.log('[evidence replay 2/2] seven new retained candidates; raw kind / normalization / publication separated');
  const current = await replayC6RetainedQuizValidators(tracked, path.join(out, 'current-data'));
  verify(evidence, manifest.files); verify(original, originalManifest); assert.equal(fetchAttempts, 0);
  const result = { status: 'PASS', evidenceLayer: 'Public retained candidates through formal offline services; not original HTTP or real DS quality acceptance',
    manifest: { outer: manifest.files.length, inner: originalManifest.length, unchanged: true }, original: originalResult, current,
    originalSeven: { published: 5, equivalentRejected: 2 }, currentSeven: { published: 3, equivalentRejected: 4, explicitlyNormalized: 1 }, realProviderCalls: 0, fetchAttempts };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, originalSeven: result.originalSeven, currentSeven: result.currentSeven, realProviderCalls: 0 }));
} catch (error) {
  verify(evidence, manifest.files); verify(original, originalManifest);
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ status: 'FAIL', message: error.message, originalCompleted: !!originalResult,
    originalEvidenceUnchanged: true, realProviderCalls: 0, fetchAttempts }, null, 2));
  throw error;
}
