import assert from 'node:assert/strict';

/** The answer key is used only by the simulated browser student, never sent to
 * the decision model. The source and policy are frozen before model calls. */
export function studentOption(key, displayedQuestion, savedQuestion) {
  assert(['A', 'B'].includes(key), 'unknown_student_strategy');
  assert.equal(displayedQuestion.stem, savedQuestion.stem, 'question_changed');
  const correct = savedQuestion.correctOptionId;
  assert(displayedQuestion.options.some(option => option.id === correct), 'missing_correct_option');
  const option = displayedQuestion.options.find(option => key === 'B' ? option.id === correct : option.id !== correct);
  assert(option, 'missing_strategy_option');
  return option.id;
}
