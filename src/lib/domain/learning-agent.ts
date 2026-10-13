import { z } from "zod";
import { LearningId } from "./learning";

const ids = z.array(LearningId).max(1000).refine(value => new Set(value).size === value.length);
export const LearningAgentSelection = z.object({
  materialIds: ids, chapterIds: ids, nodeIds: ids,
  includeHistory: z.boolean().default(false), includeNotes: z.boolean().default(false), includeSupplements: z.boolean().default(false)
}).strict().refine(value => value.materialIds.length + value.chapterIds.length + value.nodeIds.length > 0);
export type LearningAgentSelection = z.infer<typeof LearningAgentSelection>;
export const StartLearningAgent = z.object({ id: LearningId, goal: z.string().trim().min(1).max(2000), selection: LearningAgentSelection }).strict();
export const AdjustLearningAgent = z.object({ expectedVersion: z.number().int().positive(), goal: z.string().trim().min(1).max(2000), selection: LearningAgentSelection }).strict();
export type LearningAgentScope = {
  version: 1; pageId: string; selection: LearningAgentSelection; fingerprint: string;
  sources: Array<{ materialId: string; paragraphs: number[] }>;
};
export type LearningAgentExplanation = {
  id: string; taskId: string; taskVersion?: number; question: string; materialAnswer: string | null;
  supplements: Array<{ kind: "explanation" | "example"; text: string }>;
  items: Array<{ materialId: string; paragraph: number }>;
};
export type LearningAgentNotePreview = {
  id: string; taskId: string; taskVersion: number; explanationId: string; chapterId: string; nodeId: string;
  targetLabel: string; content: string; sources: Array<{ materialId: string; paragraph: number }>; includesSupplement: boolean;
  targetRevision: number; noteHash: string; sourceFingerprint: string;
};
