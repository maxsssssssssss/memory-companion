import { z } from "zod";
import { LearningId } from "./learning";

export type LearningPreparationMaterial = {
  materialId: string; title: string; kind: "text" | "txt" | "pdf" | "audio";
  status: "waiting" | "ready" | "partial" | "blocked";
  processing?: "waiting_resource" | "resuming" | "budget_exhausted" | "session_expired";
  completed: number; total: number; issues: string[];
};
export type LearningPreparationRun = {
  id: string; pageId: string; materialIds: string[]; intent: "organize" | "prepare";
  status: "preparing" | "needs_attention" | "generating" | "completed" | "failed" | "interrupted";
  materials: LearningPreparationMaterial[]; completed: number; total: number;
  frameworkRunId: string | null; frameworkPublished: boolean; error: string | null;
  createdAt: string; updatedAt: string; canContinue: boolean; canResume: boolean;
  generation?: {completed:number;total:number;canResume:boolean;uncertain:boolean};
};
export const ResumeLearningPreparation = z.object({
  id: LearningId,
  materialIds: z.array(LearningId).min(1).max(23).refine(ids => new Set(ids).size === ids.length).optional(),
  continueWithAvailable: z.literal(true).optional(),
  intent: z.enum(["organize", "prepare"]).optional()
}).strict();
