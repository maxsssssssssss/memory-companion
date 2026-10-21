import { expect } from "vitest";
import type { SavedQuiz } from "@/lib/domain/learning-quiz";
import type { LearningRepository } from "../repository";
import { LearningQuizRepository } from "../quiz-repository";
import { QuizReviewPublication, SavedQuizReview, quizReviewQuestionKey } from "../quiz-review-purpose";

/** Test-only snapshot restoration for pre-contract historical groups. The normal
 * repository still validates and saves unchanged questions, source bindings,
 * answers and stable option identities. Only the old review annotation is then
 * restored, as if reopening a previously saved database. This is NOT a proof
 * that a new generation may publish this association. Never changes attempts,
 * scores, task/execution states, or the immutable plan; later answers use act(). */
export function completePreContractQuizFixture(learning: LearningRepository, pageId: string, id: string,
  value: unknown, review?: QuizReviewPublication) {
  new LearningQuizRepository(learning).complete(pageId, id, value);
  if (!review) return;
  const { context, candidates } = QuizReviewPublication.parse(review);
  const row = learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE page_id=? AND id=?").get(pageId, id) as { result_json: string };
  const original = JSON.parse(row.result_json) as SavedQuiz;
  const metadata = SavedQuizReview.parse({ context, checks: original.questions.flatMap((question, questionIndex) => {
    const candidate = candidates.find(item => item.questionKey === quizReviewQuestionKey(question));
    return candidate ? [{ ...candidate.check, questionIndex, semanticProvenance: "model_proposal" as const }] : [];
  }) });
  learning.database.prepare("UPDATE learning_quiz_runs SET result_json=? WHERE page_id=? AND id=?")
    .run(JSON.stringify({ ...original, review: metadata }), pageId, id);
  const restored = JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE page_id=? AND id=?").get(pageId, id) as { result_json: string }).result_json);
  const { review: restoredReview, ...unchanged } = restored;
  expect(unchanged).toEqual(original); expect(restoredReview).toEqual(metadata);
}
