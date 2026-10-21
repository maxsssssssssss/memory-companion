import { z } from "zod";
import { LearningId } from "@/lib/domain/learning";
import { LearningCheckPurpose, LearningCheckRole, LearningReviewPlanInput } from "@/lib/domain/learning-agent-completion";
import { ReferencedGeneratedQuiz, type ReferencedQuizResponse } from "@/lib/domain/learning-quiz";
import { frameworkHash } from "./framework-repository";
import { LearningError } from "./repository";
import type { LearningQuizRepository } from "./quiz-repository";
import { quizCandidateValidationIssues, type QuizCandidateIssue } from "./quiz-candidate-diagnostics";

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
  options: Array<{ id: string; text: string; evidenceIds?: string[] }>; stemEvidenceIds?: string[]; explanationEvidenceIds?: string[] };
/** Stable option identities and the exact published stem bind associations.
 * Neither array position nor display letter survives as an evidence identity. */
export function quizReviewQuestionKey(question: QuestionIdentity) {
  return frameworkHash(JSON.stringify({ stem: question.scenario ? `${question.scenario}\n\n${question.stem}` : question.stem,
    kind: question.kind, correctOptionId: question.correctOptionId,
    options: [...question.options].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, text }) => ({ id, text })),
    stemEvidenceIds: [...(question.stemEvidenceIds ?? [])].sort() }));
}

type QuizRequest = NonNullable<ReturnType<LearningQuizRepository["begin"]>>;
export type QuizReviewSource = { referenceId: string; source: { kind: string; materialId?: string; paragraph?: number } };

/** Narrow a generation view, never the saved selection or frozen plan. All
 * sources must already exist in the authorized, live repository snapshot. */
export function scopeQuizReviewRequest(request: QuizRequest, context: QuizReviewContext) {
  const selected = context.objectives.filter(objective => context.purpose.objectiveIds.includes(objective.id));
  const sources = selected.flatMap(objective => objective.sources);
  if (selected.some(objective => !objective.sources.some(source => request.materials.some(material => material.materialId === source.materialId
    && material.paragraphs.some(paragraph => paragraph.number === source.paragraph))))) throw new LearningError(422, "quiz_review_source_mismatch");
  return { ...request, reviewContext: context,
    materials: request.materials.map(material => ({ ...material, paragraphs: material.paragraphs.filter(paragraph =>
      sources.some(source => source.materialId === material.materialId && source.paragraph === paragraph.number)) }))
      .filter(material => material.paragraphs.length > 0) };
}

type ReviewWire = { materials: Array<{ paragraphs: Array<{ referenceId?: string }> }>; taskContext: Record<string, unknown> };
/** Build the exact annotation contract with this request's stable/short IDs.
 * Reduced model views intentionally omit material UUIDs and paragraph numbers;
 * this join keeps each frozen objective visibly tied to its actual input text. */
export function quizReviewGenerationInput<T extends ReviewWire>(wire: T, request: QuizRequest, context: QuizReviewContext) {
  const objectives = context.objectives.filter(objective => context.purpose.objectiveIds.includes(objective.id)).map(objective => ({
    objectiveId: objective.id, label: objective.label,
    requirement: objective.requirements.find(requirement => requirement.role === context.purpose.role) ?? null,
    sourceReferenceIds: request.materials.flatMap((material, materialIndex) => material.paragraphs.flatMap((paragraph, paragraphIndex) =>
      objective.sources.some(source => source.materialId === material.materialId && source.paragraph === paragraph.number)
        ? [wire.materials[materialIndex]?.paragraphs[paragraphIndex]?.referenceId].filter((id): id is string => typeof id === "string") : []))
  }));
  return { ...wire, taskContext: { ...wire.taskContext, reviewContract: {
    requiredRole: context.purpose.role, allowedObjectiveIds: context.purpose.objectiveIds, objectives,
    annotationSchema: { type: "object", additionalProperties: false, required: ["objectiveIds", "role", "rationale"], properties: {
      objectiveIds: { type: "array", minItems: 1, maxItems: 12, uniqueItems: true, items: { type: "string", enum: context.purpose.objectiveIds } },
      role: { type: "string", const: context.purpose.role }, rationale: { type: "string", minLength: 1, maxLength: 600 }
    } }
  } } };
}

function linkedSources(question: QuestionIdentity, catalog: QuizReviewSource[]) {
  const ids = new Set([...(question.stemEvidenceIds ?? []), ...(question.explanationEvidenceIds ?? []), ...question.options.flatMap(option => option.evidenceIds ?? [])]);
  return catalog.filter(source => ids.has(source.referenceId)).map(source => source.source);
}
function missingObjectiveSources(check: QuizReviewCheck, context: QuizReviewContext, sources: Array<{ kind: string; materialId?: string; paragraph?: number }>) {
  return check.objectiveIds.filter(id => !context.objectives.find(objective => objective.id === id)?.sources.some(expected =>
    sources.some(source => source.kind === "material" && source.materialId === expected.materialId && source.paragraph === expected.paragraph)));
}

/** Strip only the agent annotation before the canonical codec. Record independent
 * failures without overwriting the earlier codec's rejection or its position. */
export function decodeReviewQuiz(value: unknown, decode: (value: unknown) => ReferencedQuizResponse, context: QuizReviewContext,
  catalog: QuizReviewSource[], onIssue?: (issue: QuizCandidateIssue) => void): ReviewedQuizResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) return decode(value);
  const body = value as Record<string, unknown> & { items: unknown[] };
  const checks: Array<QuizReviewCheck | undefined> = [];
  const invalid = new Map<number, string>();
  const items = body.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const { reviewCheck, ...question } = raw as Record<string, unknown>;
    if (reviewCheck !== undefined) {
      const parsed = QuizReviewCheck.safeParse(reviewCheck);
      if (!parsed.success) {
        invalid.set(index, "annotation_schema");
        onIssue?.({ index, stage: "review", code: "annotation_schema", validationIssues: quizCandidateValidationIssues(parsed.error).map(issue => ({ ...issue, path: `reviewCheck.${issue.path}` })) });
      } else {
        if (parsed.data.role !== context.purpose.role) {
          invalid.set(index, "annotation_role"); onIssue?.({ index, stage: "review", code: "annotation_role", expectedRole: context.purpose.role, actualRole: parsed.data.role });
        }
        if (parsed.data.objectiveIds.some(id => !context.purpose.objectiveIds.includes(id))) {
          invalid.set(index, invalid.get(index) ?? "annotation_objective"); onIssue?.({ index, stage: "review", code: "annotation_objective", expectedObjectiveIds: context.purpose.objectiveIds, actualObjectiveIds: parsed.data.objectiveIds });
        }
        if (!invalid.has(index)) checks[index] = parsed.data;
      }
    } else {
      invalid.set(index, "annotation_missing"); onIssue?.({ index, stage: "review", code: "annotation_missing", validationIssues: [{ path: "reviewCheck", code: "missing_field" }] });
    }
    return question;
  });
  const decoded = decode({ ...body, items });
  const reviewCandidates: QuizReviewPublication["candidates"] = [];
  const published = decoded.items.map((raw, index) => {
    const question = ReferencedGeneratedQuiz.shape.items.element.safeParse(raw), check = checks[index];
    if (!question.success) return raw;
    if (invalid.has(index)) return { reviewCheckRejected: true, rejectionReason: invalid.get(index) };
    if (check) {
      const missing = missingObjectiveSources(check, context, linkedSources(question.data, catalog));
      if (missing.length) {
        onIssue?.({ index, stage: "review", code: "review_source_mismatch", expectedObjectiveIds: missing, actualObjectiveIds: check.objectiveIds });
        return { reviewCheckRejected: true, rejectionReason: "review_source_mismatch" };
      }
      reviewCandidates.push({ questionKey: quizReviewQuestionKey(question.data), check });
    }
    return raw;
  });
  // New agent-generated questions require an explicit valid association. This
  // does not reinterpret historical saved groups or change manual generation.
  return { ...decoded, items: published, reviewCandidates };
}

/** Recheck after resumed generation and immediately before repository publication.
 * Keep slots and content identities; reject only the mismatching candidates. */
export function filterQuizReviewPublication(value: ReferencedQuizResponse, publication: QuizReviewPublication,
  catalog: QuizReviewSource[], onIssue?: (issue: QuizCandidateIssue) => void): ReferencedQuizResponse {
  const { context, candidates } = QuizReviewPublication.parse(publication);
  return { ...value, items: value.items.map((raw, index) => {
    const parsed = ReferencedGeneratedQuiz.shape.items.element.safeParse(raw);
    if (!parsed.success) return raw;
    const mapped = candidates.find(candidate => candidate.questionKey === quizReviewQuestionKey(parsed.data));
    let code: string | undefined;
    if (!mapped) code = "annotation_missing";
    else if (mapped.check.role !== context.purpose.role) code = "annotation_role";
    else if (mapped.check.objectiveIds.some(id => !context.purpose.objectiveIds.includes(id))) code = "annotation_objective";
    else if (missingObjectiveSources(mapped.check, context, linkedSources(parsed.data, catalog)).length) code = "review_source_mismatch";
    if (!code) return raw;
    onIssue?.({ index, stage: "publication", code,
      ...(code === "annotation_role" ? { expectedRole: context.purpose.role, actualRole: mapped?.check.role } : {}),
      ...(code === "annotation_objective" || code === "review_source_mismatch" ? { expectedObjectiveIds: context.purpose.objectiveIds, actualObjectiveIds: mapped?.check.objectiveIds } : {}) });
    return { reviewCheckRejected: true, rejectionReason: code };
  }) };
}

/** Call only after the normal live-source, codec and publication fences. */
export function bindPublishedQuizReview(value: QuizReviewPublication, questions: Array<QuestionIdentity & { sources?: Array<{ kind: string; materialId?: string; paragraph?: number }> }>): SavedQuizReview {
  const { context, candidates } = QuizReviewPublication.parse(value);
  return SavedQuizReview.parse({ context, checks: questions.flatMap((question, questionIndex) => {
    const mapped = candidates.find(candidate => candidate.questionKey === quizReviewQuestionKey(question));
    if (!mapped || mapped.check.role !== context.purpose.role
      || mapped.check.objectiveIds.some(id => !context.purpose.objectiveIds.includes(id))) return [];
    if (missingObjectiveSources(mapped.check, context, question.sources ?? []).length) throw new LearningError(422, "quiz_grounding_invalid");
    return [{ ...mapped.check, questionIndex, semanticProvenance: "model_proposal" as const }];
  }) });
}

export const QUIZ_REVIEW_INSTRUCTION = `本请求taskContext.reviewContext是已固定的复习目标和本次检查目的，不是课程事实或新授权；taskContext.reviewContract给出本次必须逐字使用的role、允许的目标ID、对应知识要求和实际sourceReferenceIds。只从这些当前目标选择本题真实检查的判断，不扩大到材料其他考点。每个候选题在原字段外填写reviewCheck，严格遵循reviewContract.annotationSchema：objectiveIds是所列允许ID的非空去重子集；role必须等于requiredRole，不能写method、kind、目标名称或中文角色；rationale为1至600字的具体关联说明，不含verified或通过结论。role=boundary检查适用条件、例外或容易混淆的边界，不能因method为contrast就把role改成contrast；kind仍只用concept/relationship/application。role=followup说明本题复查哪种已有表现；priorEvidenceRefs只表示关系，不能假定旧错误已纠正或新情境已核验。每个所列目标必须有本题实际引用的来源与该目标sourceReferenceIds相交；相交只是必要来源检查，不证明题意匹配或语义已核实。不能把概念名称写进题干就声称覆盖；对照该目标本role的具体requirement安排题目。无法生成相符且唯一正确的题就少出或返回空items及原因，不编造关联。reviewCheck是唯一新增题目字段，原有唯一答案、理由、选项身份及来源契约不变。`;
