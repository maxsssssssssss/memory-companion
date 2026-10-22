// Exact public-projection replay. Run with the mandatory offline preload:
// node --require ./scripts/cloud/offline.cjs --import tsx <this file>
//   --evidence-dir <unpacked Windows ZIP> --output-dir <fresh directory>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert(option('--evidence-dir') && option('--output-dir'), 'Required --evidence-dir and --output-dir');
const evidence = path.resolve(option('--evidence-dir')), out = path.resolve(option('--output-dir'));
assert(!fs.existsSync(out), 'Do not overwrite prior evidence or data');
assert(!out.startsWith(evidence + path.sep) && out !== evidence, 'Keep immutable inputs separate');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = read(path.join(evidence, 'manifest.json'));
assert.equal(manifest.sha, '3c34ced00bbaa64fa179556bb96169f8529fe254');
const verify = () => {
  for (const entry of manifest.files) {
    const file = path.resolve(evidence, entry.path.replaceAll('\\', '/'));
    assert(file.startsWith(evidence + path.sep));
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, entry.bytes, entry.path); assert.equal(hash(bytes), entry.sha256, entry.path);
  }
};
verify();
const business = read(path.join(evidence, 'real/G5-business.json'));
const exact = read(path.join(evidence, 'g5-grading-repro/exact-question-evidence.json'));
const fixture = read('src/lib/server/learning/testing/final-g5-3c34ced.fixture.json');
for (const [file, expected] of Object.entries(fixture.provenance.files)) assert.equal(hash(fs.readFileSync(path.join(evidence, file))), expected);
assert.deepEqual(fixture.decoded, business.quizzes[0].parts[0].result_json);
assert.deepEqual(fixture.saved, business.quizzes[0].run.result_json);
assert.deepEqual(fixture.decoded.items[3], exact.question);
assert.deepEqual(fixture.saved.questions[3], exact.savedQuestion);
assert.deepEqual(fixture.source, exact.source); assert.deepEqual(fixture.settings, exact.settings);
assert.deepEqual(fixture.reviewContext, exact.reviewContext); assert.deepEqual(fixture.plan, business.actions[0].args_json);
assert.equal(fixture.goal, business.task.goal);
fs.mkdirSync(out, { recursive: true });
let fetchAttempts = 0;
globalThis.fetch = async () => { fetchAttempts++; throw Error('Real Provider prohibited'); };
try {
  const { replayFinalG5Publication } = await import(pathToFileURL(path.resolve('src/lib/server/learning/testing/final-g5-3c34ced-replay.ts')).href);
  const result = await replayFinalG5Publication(path.join(out, 'isolated-data'));
  assert.equal(fetchAttempts, 0); verify();
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...result, manifestFiles: manifest.files.length, originalEvidenceUnchanged: true, fetchAttempts }, null, 2));
  result.matrix.forEach((row, index) => console.log(`[exact candidate ${index + 1}/4] index=${row.index} composition=${row.composition} publication=${row.publication}`));
  console.log(JSON.stringify({ status: result.status, score: result.score, generation: result.generation, realProviderCalls: 0 }));
} catch (error) {
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ status: 'FAIL', error: error.message, fetchAttempts }, null, 2));
  throw error;
}
