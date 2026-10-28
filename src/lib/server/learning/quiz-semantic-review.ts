import { z } from "zod";
import { createHash } from "node:crypto";
import { ReferencedGeneratedQuiz, type ReferencedModelQuiz } from "@/lib/domain/learning-quiz";
import type { QuizReference } from "./quiz-grounding";
import { LearningError } from "./repository";
import { LEARNING_INPUT_BOUNDARY } from "./model-input";

type Question = ReferencedModelQuiz["items"][number];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const QUIZ_SEMANTIC_REVIEW_PROMPT = `你是独立的单选题审题员。只根据本次授权原文和完整题干场景逐项判断，不联网，不修改题目，不推测出题者原答案。输入故意不提供原答案和原解析。
${LEARNING_INPUT_BOUNDARY}
判断的是“该选项是否满足题干要求”，不是孤立句子是否真实。注意否定题、适用条件、数量、时点及多个同时成立的事实；原文不足以排除一个合理答案时必须标记uncertain。
每个candidateId和每个optionId恰好输出一次：holds（成立）、does_not_hold（不成立）或uncertain（无法确定）。reason只写简短可核对的结论及依据，不输出推理过程；evidenceIds只使用本候选提供的原文referenceId。不评价学生，不宣称教材真值已核验。
仅输出JSON：{"items":[{"candidateId":"输入ID","options":[{"optionId":"输入稳定ID","verdict":"holds|does_not_hold|uncertain","reason":"简短判断依据，160字以内","evidenceIds":["输入referenceId"]}]}]}。不能省略未知项，也不能为了单选题格式强行只认定一项成立。`;

export const QuizSemanticResponse = z.object({ items: z.array(z.object({
  candidateId: z.string().regex(/^[a-f0-9]{64}$/),
  options: z.array(z.object({ optionId: z.enum(["A", "B", "C", "D", "E", "F"]),
    verdict: z.enum(["holds", "does_not_hold", "uncertain"]), reason: z.string().trim().min(1).max(160),
    evidenceIds: z.array(z.string().regex(/^ref_[a-f0-9]{64}$/)).max(100)
  }).strict()).min(2).max(6)
}).strict()).min(1).max(3) }).strict();
const rejectCode = z.enum(["answer_not_unique", "answer_contradiction", "semantic_uncertain"]);
export const QuizSemanticReceipt = z.object({ version: z.literal(1), provenance: z.literal("independent_model_judgment"),
  items: z.array(z.object({ candidateId: z.string(), questionHash: z.string(),
    sources: z.array(z.object({ referenceId: z.string(), hash: z.string() }).strict()),
    options: QuizSemanticResponse.shape.items.element.shape.options,
    accepted: z.boolean(), rejection: rejectCode.nullable()
  }).strict()).min(1).max(3)
}).strict();
export type QuizSemanticReceipt = z.infer<typeof QuizSemanticReceipt>;
export const quizSemanticQuestionHash = (q: Question) => hash(q);

/** Deliberately exclude generator answer, explanations, hints and goal labels.
 * Opaque identity is derived only from the blind view, never from the answer. */
export function quizSemanticInput(questions: Question[], catalog: QuizReference[]) {
  return { candidates: questions.map(q => {
    const refs = new Set([...q.stemEvidenceIds, ...q.explanationEvidenceIds, ...q.options.flatMap(o => o.evidenceIds)]);
    const sources = catalog.filter(source => refs.has(source.referenceId)).map(source => ({ referenceId: source.referenceId, text: source.text }));
    if (sources.length !== refs.size) throw new LearningError(422, "quiz_grounding_invalid");
    const blind = { scenario: q.scenario ?? null, stem: q.stem, options: q.options.map(o => ({ id: o.id, text: o.text })), sources };
    return { candidateId: hash(blind), ...blind };
  }) };
}
export function judgeQuizSemantics(raw: unknown, questions: Question[], catalog: QuizReference[]): QuizSemanticReceipt {
  const response = QuizSemanticResponse.parse(raw), input = quizSemanticInput(questions, catalog);
  if (response.items.length !== questions.length || new Set(response.items.map(i => i.candidateId)).size !== questions.length)
    throw new LearningError(422, "quiz_semantic_review_invalid");
  return { version: 1, provenance: "independent_model_judgment", items: questions.map((q, index) => {
    const candidate = input.candidates[index], judged = response.items.find(i => i.candidateId === candidate.candidateId);
    if (!judged || judged.options.length !== q.options.length || new Set(judged.options.map(o => o.optionId)).size !== q.options.length
      || judged.options.some(o => !q.options.some(original => original.id === o.optionId)
        || (o.verdict !== "uncertain" && !o.evidenceIds.length) || new Set(o.evidenceIds).size !== o.evidenceIds.length
        || o.evidenceIds.some(id => !candidate.sources.some(s => s.referenceId === id))))
      throw new LearningError(422, "quiz_semantic_review_invalid");
    const holds = judged.options.filter(o => o.verdict === "holds");
    const rejection = holds.length > 1 ? "answer_not_unique" : judged.options.some(o => o.verdict === "uncertain") ? "semantic_uncertain"
      : holds.length !== 1 || holds[0].optionId !== q.correctOptionId ? "answer_contradiction" : null;
    return { candidateId: candidate.candidateId, questionHash: quizSemanticQuestionHash(q),
      sources: candidate.sources.map(source => ({ referenceId: source.referenceId, hash: hash(source.text) })),
      options: judged.options, accepted: rejection === null, rejection };
  }) };
}

/** Final publication rechecks persisted completed operations and live sources.
 * No caller-supplied 'verified' boolean can authorize an unreviewed candidate. */
export function assertQuizSemanticPublication(value: unknown, catalog: QuizReference[], records: Array<{ state: string; result_json: string | null }>) {
  const questions = ReferencedGeneratedQuiz.parse(value).items;
  const receipts = records.filter(row => row.state === "completed" && row.result_json).flatMap(row => {
    const result = QuizSemanticReceipt.safeParse(JSON.parse(row.result_json!));
    return result.success ? result.data.items : [];
  });
  for (const q of questions) {
    const receipt = receipts.find(r => r.accepted && r.rejection === null && r.questionHash === quizSemanticQuestionHash(q));
    const sources = quizSemanticInput([q], catalog).candidates[0].sources;
    if (!receipt || receipt.sources.length !== sources.length || sources.some(s => !receipt.sources.some(r => r.referenceId === s.referenceId && r.hash === hash(s.text))))
      throw new LearningError(422, "quiz_semantic_review_required");
    // Re-evaluate the saved judgments too; persisted labels alone aren't proof.
    const checked = judgeQuizSemantics({ items: [{ candidateId: receipt.candidateId, options: receipt.options }] }, [q], catalog);
    if (!checked.items[0].accepted) throw new LearningError(422, "quiz_semantic_review_required");
  }
}
