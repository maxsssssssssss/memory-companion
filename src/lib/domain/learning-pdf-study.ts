import { z } from "zod";
import { LearningId, LEARNING_PDF_MAX_PAGES } from "./learning";

export const PdfStudySelection = z.object({
  documentId: LearningId,
  physicalPages: z.array(z.number().int().min(1).max(LEARNING_PDF_MAX_PAGES)).min(1).max(LEARNING_PDF_MAX_PAGES)
    .refine(v => new Set(v).size === v.length),
  // Permission to use unverified content, never a claim that a person verified it.
  // Missing authorization preserves existing manually selected scopes.
  acknowledgeUnverified: z.literal(true),
  authorization: z.literal("automatic").optional(),
  excludedBlockIds: z.array(LearningId).max(20000).default([]),
  acknowledgeWarnings: z.boolean()
}).strict();
export type PdfStudySelection = z.infer<typeof PdfStudySelection>;
export type LearningPdfReadiness = {
  documentId: string | null;
  status: "waiting" | "ready" | "partial" | "blocked";
  // Execution state only; never a content-quality assessment or retry permission.
  processing?: "waiting_resource" | "resuming" | "budget_exhausted" | "session_expired";
  selection: PdfStudySelection | null;
  partial: boolean;
  totalPages: number;
  completedPages: number[];
  failedPages: number[];
  pendingPages: number[];
  unknownPages: number[];
  excludedPages: number[];
  excludedBlockCount: number;
  warningCodes: string[];
  limitations: string[];
};
/** Identity of a paragraph projected from an immutable parse, never an OCR display coordinate. */
export type ParsedTextBinding = { documentId: string; version: number; blockId: string; physicalPage: number; sourceHash: string };
