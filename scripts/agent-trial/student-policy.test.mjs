import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { studentOption } from './student-policy.mjs';

test('fixed simulated students follow displayed option order without rewriting questions', () => {
  const question = { stem: '合成题', options: [{ id: 'D' }, { id: 'A' }, { id: 'C' }] };
  const saved = { stem: '合成题', correctOptionId: 'A' };
  const before = JSON.stringify([question, saved]);
  assert.equal(studentOption('A', question, saved), 'D');
  assert.equal(studentOption('B', question, saved), 'A');
  assert.equal(JSON.stringify([question, saved]), before);
});
test('changed questions or unavailable keys fail closed', () => {
  assert.throws(() => studentOption('B', { stem: '改题', options: [] }, { stem: '原题', correctOptionId: 'A' }));
  assert.throws(() => studentOption('B', { stem: '题', options: [{ id: 'B' }] }, { stem: '题', correctOptionId: 'A' }));
  assert.throws(() => studentOption('C', {}, {}));
});
