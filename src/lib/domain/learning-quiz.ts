import { z } from "zod";
import { LearningId } from "./learning";
import type { FrameworkSource } from "./learning-framework";

// Bound one response/attempt, not a pedagogical target or Work's list limit.
export const QUIZ_MAX_QUESTIONS = 50;
const ids = z.array(LearningId).max(1000).refine(v => new Set(v).size === v.length);
export const QuizSettings = z.object({
  materialIds: ids, chapterIds: ids, nodeIds: ids,
  includeNotes: z.boolean(), includeSupplements: z.boolean(),
  count: z.number().int().min(1).max(QUIZ_MAX_QUESTIONS), difficulty: z.enum(["basic", "standard", "challenging"])
}).strict().refine(v => v.materialIds.length + v.chapterIds.length + v.nodeIds.length > 0);
export const StartQuiz = z.object({ id: LearningId, settings: QuizSettings, resume: z.literal(true).optional() }).strict();
export type QuizConfig = z.infer<typeof QuizSettings>;
const text = z.string().trim().min(1).max(8000);
export const QuizModelSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("material"), materialId: LearningId, paragraph: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("note"), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("supplement"), id: z.string().min(1).max(200) }).strict()
]);
export const GeneratedQuiz = z.object({
  title: z.string().trim().min(1).max(200), reason: z.string().trim().max(8000).nullable(),
  items: z.array(z.object({
    stem: text, kind: z.enum(["concept", "relationship", "application"]),
    options: z.array(z.object({ id: z.enum(["A", "B", "C", "D", "E", "F"]), text, reason: text, evidenceIndexes: z.array(z.number().int().nonnegative()).min(1).max(100).optional(), evidenceIds: z.array(z.string()).optional() }).strict()).min(2).max(6),
    correctOptionId: z.enum(["A", "B", "C", "D", "E", "F"]), explanation: text,
    hint: z.string().trim().min(1).max(3000).nullable(),
    sources: z.array(QuizModelSource).min(1).max(100),
    evidence: z.array(z.object({source:QuizModelSource,quote:z.string().min(1).max(4000),id:z.string().optional(),referenceId:z.string().optional()}).strict()).min(1).max(100).optional(),
    stemEvidenceIds: z.array(z.string()).optional(), explanationEvidenceIds: z.array(z.string()).optional()
  }).strict().superRefine((q, ctx) => {
    if (new Set(q.options.map(o => o.id)).size !== q.options.length || !q.options.some(o => o.id === q.correctOptionId)
      || new Set(q.options.map(o => o.text.trim().toLowerCase())).size !== q.options.length)
      ctx.addIssue({ code: "custom", message: "Invalid single-choice options" });
  })).max(QUIZ_MAX_QUESTIONS)
}).strict();
// New provider responses must carry the actual facts used by each option reason.
// Historical saved questions remain readable without retroactive rewriting.
export const GroundedGeneratedQuiz = GeneratedQuiz.superRefine((v,ctx)=>{
  for(const q of v.items)if(!q.evidence?.length||q.options.some(o=>!o.evidenceIndexes?.length||o.evidenceIndexes.some(i=>i>=q.evidence!.length)))ctx.addIssue({code:"custom",message:"quiz_grounding_required"});
});
export type ModelQuiz = z.infer<typeof GeneratedQuiz>;
const evidenceId = z.string().regex(/^ref_[a-f0-9]{64}$/);
const evidenceIds = z.array(evidenceId).min(1).max(100).refine(ids => new Set(ids).size === ids.length);
// Provider wire contract only. Saved legacy groups keep their original contract and order.
export const ReferencedGeneratedQuiz = z.object({
  contractVersion: z.literal("references-v2"), title: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(8000).nullable(),
  items: z.array(z.object({
    stem: text, kind: z.enum(["concept", "relationship", "application"]),
    scenario: z.string().trim().min(1).max(4000).nullable().optional(),
    options: z.array(z.object({ id: z.enum(["A", "B", "C", "D", "E", "F"]), text, reason: text, evidenceIds }).strict()).min(2).max(6),
    correctOptionId: z.enum(["A", "B", "C", "D", "E", "F"]), explanation: text,
    hint: z.string().trim().min(1).max(3000).nullable(), stemEvidenceIds: evidenceIds, explanationEvidenceIds: evidenceIds
  }).strict()).max(QUIZ_MAX_QUESTIONS)
}).strict();
export type ReferencedModelQuiz = z.infer<typeof ReferencedGeneratedQuiz>;
// The envelope remains closed. Each independent question still has to pass the
// complete strict item schema before any source binding or publication.
export const ReferencedQuizEnvelope = ReferencedGeneratedQuiz.extend({ items: z.array(z.unknown()).max(QUIZ_MAX_QUESTIONS) });
export type ReferencedQuizResponse = z.infer<typeof ReferencedQuizEnvelope>;
export type QuizSource = ({ kind: "material" } & FrameworkSource) | { kind: "note" | "supplement"; id: string; sha256: string; nodeId: string; chapterId: string };
export type SavedQuiz = Omit<ModelQuiz, "items"> & { optionOrderVersion?: 1; questions: Array<Omit<ModelQuiz["items"][number], "sources"> & { sources: QuizSource[] }> };
export const BeginQuizAttempt = z.object({ id: LearningId, quizId: LearningId, mode: z.enum(["practice", "test"]) }).strict();
export const QuizAction = z.object({
  id: LearningId, attemptId: LearningId, revision: z.number().int().nonnegative(),
  action: z.enum(["choose", "submit", "hint", "skip", "reveal", "finish"]),
  question: z.number().int().nonnegative().max(QUIZ_MAX_QUESTIONS - 1), optionId: z.string().max(1).nullable()
}).strict();
export type QuizActionInput = z.infer<typeof QuizAction>;
export type QuizProgress = { optionId: string | null; submitted: boolean; skipped: boolean; hinted: boolean; revealed: boolean };
export type QuizRunSummary = { id: string; createdAt: string; status: "generating" | "completed" | "insufficient" | "failed"; failure: string | null; settings: QuizConfig; title: string | null; count: number; reason: string | null; attemptId: string | null;
  progress?: {completed:number;total:number;canResume:boolean;uncertain:boolean} };
export type QuizAttemptView = {
  id: string; quizId: string; title: string; mode: "practice" | "test"; revision: number; completed: boolean; createdAt: string; completedAt: string | null;
  questions: Array<{ index: number; stem: string; kind: string; options: Array<{ id: string; text: string; label?: string }>; progress: QuizProgress;
    hint?: string | null; feedback?: { correct: boolean; correctOptionId: string; explanation: string; reasons: Array<{ id: string; reason: string }>; sources: Array<QuizSource & { state: string }> } }>;
  score: null | { correct: number; total: number; unassistedCorrect: number; hinted: number; revealed: number; skipped: number };
};
