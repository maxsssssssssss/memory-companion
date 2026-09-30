import { z } from "zod";
import { LearningId, LearningTitle } from "./learning";

// Resource guards, not a target number of learning points. Never truncate to fit.
export const FRAMEWORK_MAX_INPUT_CHARS = 120_000;
export const FRAMEWORK_MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const FRAMEWORK_DEADLINE_MS = 150_000;
export const StartLearningFramework = z.object({
  id: LearningId,
  resume: z.literal(true).optional(),
  materialIds: z.array(LearningId).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length)
}).strict();
const explanation = z.string().trim().min(1).max(20000);
const modelSource = z.object({ materialId: LearningId, paragraph: z.number().int().positive() }).strict();
export const GeneratedLearningFramework = z.object({
  overview: explanation,
  chapters: z.array(z.object({
    title: LearningTitle, explanation,
    nodes: z.array(z.object({
      title: LearningTitle, explanation,
      supplement: z.string().trim().max(10000).nullable(),
      sources: z.array(modelSource).min(1).max(100)
    }).strict()).min(1).max(1000)
  }).strict()).min(1).max(200)
}).strict();
export type GeneratedFramework = z.infer<typeof GeneratedLearningFramework>;
export type FrameworkSource = {
  materialId: string; paragraph: number; start: number; end: number;
  originalSha256: string; paragraphSha256: string;
  parsed?: import("./learning-pdf-study").ParsedTextBinding;
  startSeconds?: number; endSeconds?: number;
};
export type FrameworkNode = {
  id: string; title: string; explanation: string; supplement: string | null;
  sources: FrameworkSource[]; note: string; edited: boolean;
};
export type FrameworkChapter = {
  id: string; runId: string; revision: number; title: string; explanation: string;
  edited: boolean; nodes: FrameworkNode[];
};
export type FrameworkRun = {
  id: string; status: "generating" | "validating" | "completed" | "failed";
  materialIds: string[]; createdAt: string; deadline: number; failure: string | null;
  overview: string | null;
  progress?: { completed: number; total: number; canResume: boolean; uncertain: boolean };
};
export type FrameworkView = {
  runs: FrameworkRun[]; chapters: FrameworkChapter[];
  // Derived from current titles/explanations; never another editable authority.
  overview: Array<{ id: string; title: string; explanation: string }>;
};
const revision = z.number().int().nonnegative();
export const EditLearningFramework = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chapter"), chapterId: LearningId, revision,
    title: LearningTitle, explanation }).strict(),
  z.object({ kind: z.literal("node"), chapterId: LearningId, revision, nodeId: LearningId,
    title: LearningTitle, explanation, note: z.string().max(20000) }).strict(),
  z.object({ kind: z.literal("move"), chapterId: LearningId, revision, nodeId: LearningId,
    targetChapterId: LearningId, targetRevision: revision, position: z.number().int().nonnegative() }).strict()
]);
export type FrameworkEdit = z.infer<typeof EditLearningFramework>;
