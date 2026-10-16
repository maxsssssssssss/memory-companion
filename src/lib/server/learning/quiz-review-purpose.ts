import { z } from "zod";
import { LearningId } from "@/lib/domain/learning";
import { LearningCheckPurpose, LearningCheckRole, LearningReviewPlanInput } from "@/lib/domain/learning-agent-completion";
import { ReferencedGeneratedQuiz, type ReferencedQuizResponse } from "@/lib/domain/learning-quiz";
import { frameworkHash } from "./framework-repository";

/** Server-to-server generation context. It is not part of StartQuiz, and does
 * not authorize sources or establish whether an objective has been achieved. */
export const QuizReviewContext = z.object({
  planId: LearningId, taskVersion: z.number().int().positive(),
  objectives: LearningReviewPlanInput.innerType().shape.objectives,
  purpose: LearningCheckPurpose
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.objectives.map(objective => objective.id));
  if (ids.size !== value.objectives.length || value.purpose.objectiveIds.some(id => !ids.has(id))) {
    ctx.addIssue({ code: "custom", message: "quiz_review_objective_invalid" });
  }
});
export type QuizReviewContext = z.infer<typeof QuizReviewContext>;

export const QuizReviewCheck = z.object({
  objectiveIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).min(1).max(12)
    .refine(ids => new Set(ids).size === ids.length),
  role: LearningCheckRole, rationale: z.string().trim().min(1).max(600)
}).strict();
export type QuizReviewCheck = z.infer<typeof QuizReviewCheck>;
const candidate = z.object({ questionKey: z.string().regex(/^[a-f0-9]{64}$/), check: QuizReviewCheck }).strict();
export const QuizReviewPublication = z.object({ context: QuizReviewContext, candidates: z.array(candidate).max(50) }).strict();
export type QuizReviewPublication = z.infer<typeof QuizReviewPublication>;
export const SavedQuizReview = z.object({
  context: QuizReviewContext,
  checks: z.array(QuizReviewCheck.extend({ questionIndex: z.number().int().nonnegative().max(49), semanticProvenance: z.literal("model_proposal") }).strict()).max(50)
}).strict();
export type SavedQuizReview = z.infer<typeof SavedQuizReview>;
export type ReviewedQuizResponse = ReferencedQuizResponse & { reviewCandidates?: QuizReviewPublication["candidates"] };

type QuestionIdentity = { stem: string; scenario?: string | null; kind: string; correctOptionId: string;
  options: Array<{ id: string; text: string }>; stemEvidenceIds?: string[] };
/** Stable option identities and the exact published stem bind associations.
 * Neither array position nor display letter survives as an evidence identity. */
export function quizReviewQuestionKey(question: QuestionIdentity) {
  return frameworkHash(JSON.stringify({ stem: question.scenario ? `${question.scenario}\n\n${question.stem}` : question.stem,
    kind: question.kind, correctOptionId: question.correctOptionId,
    options: [...question.options].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, text }) => ({ id, text })),
    stemEvidenceIds: [...(question.stemEvidenceIds ?? [])].sort() }));
}

/** The agent-only annotation is removed before the unchanged strict codec.
 * Both codecs preserve candidate slots; the final association uses content
 * identity, so filtering a middle candidate cannot shift later mappings. */
export function decodeReviewQuiz(value: unknown, decode: (value: unknown) => ReferencedQuizResponse, context: QuizReviewContext): ReviewedQuizResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) return decode(value);
  const body = value as Record<string, unknown> & { items: unknown[] };
  const checks: Array<QuizReviewCheck | undefined> = [];
  const invalid = new Set<number>();
  const items = body.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const { reviewCheck, ...question } = raw as Record<string, unknown>;
    if (reviewCheck !== undefined) {
      const parsed = QuizReviewCheck.safeParse(reviewCheck);
      if (!parsed.success || parsed.data.role !== context.purpose.role
        || parsed.data.objectiveIds.some(id => !context.purpose.objectiveIds.includes(id))) invalid.add(index);
      else checks[index] = parsed.data;
    }
    return question;
  });
  const decoded = decode({ ...body, items });
  const reviewCandidates: QuizReviewPublication["candidates"] = [];
  const published = decoded.items.map((raw, index) => {
    if (invalid.has(index)) return { reviewCheckRejected: true };
    const question = ReferencedGeneratedQuiz.shape.items.element.safeParse(raw), check = checks[index];
    if (question.success && check) reviewCandidates.push({ questionKey: quizReviewQuestionKey(question.data), check });
    return raw;
  });
  // Missing annotations remain usable quiz content, but establish no coverage.
  return { ...decoded, items: published, reviewCandidates };
}

/** Call only after the normal live-source, codec and publication fences. */
export function bindPublishedQuizReview(value: QuizReviewPublication, questions: QuestionIdentity[]): SavedQuizReview {
  const { context, candidates } = QuizReviewPublication.parse(value);
  return SavedQuizReview.parse({ context, checks: questions.flatMap((question, questionIndex) => {
    const mapped = candidates.find(candidate => candidate.questionKey === quizReviewQuestionKey(question));
    if (!mapped || mapped.check.role !== context.purpose.role
      || mapped.check.objectiveIds.some(id => !context.purpose.objectiveIds.includes(id))) return [];
    return [{ ...mapped.check, questionIndex, semanticProvenance: "model_proposal" as const }];
  }) });
}

export const QUIZ_REVIEW_INSTRUCTION = `本请求 taskContext.reviewContext 是当前复习目标和本次检查目的，不是课程事实或新的授权。围绕所列 objectiveIds、role、method 和 purpose 选择题目；priorEvidenceRefs 只表示复查关系，不能假定旧错误已纠正或新情境已核验。不得仅把概念名写进题干就声称覆盖。每个实际候选题额外填写 reviewCheck:{"objectiveIds":["本次目的中的目标ID"],"role":"本次目的的role","rationale":"本题哪一个具体判断为该目标提供线索，保留不确定性"}。这是题目与目标的语义提案，不是通过、正确率或 verified 标记。没有合理关联就不编造关联；所有原有题目唯一答案、来源、理由、选项身份及封闭字段约束继续适用，除 reviewCheck 外不增加字段。`;
