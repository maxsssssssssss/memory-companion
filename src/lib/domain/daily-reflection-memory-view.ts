import { z } from "zod";

import {
  DailyReflectionIdSchema,
  ReflectionCardEpistemicStatusSchema
} from "./daily-reflection";
import { DailyReflectionMemoryProposalEpistemicCautionSchema } from "./daily-reflection-memory-proposal";
import { DailyReflectionReturnEvidenceSchema } from "./daily-reflection-return";
import { DailyReflectionWorkingCardKindSchema } from "./daily-reflection-working-card";

const DailyReflectionMemoryViewSchema = z.object({
  id: DailyReflectionIdSchema,
  cardId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  recordingDate: z.string().date(),
  memoryType: z.enum([
    "summary",
    "question",
    "decision",
    "commitment",
    "preference",
    "person_fact",
    "event"
  ]),
  cardKind: DailyReflectionWorkingCardKindSchema,
  epistemicStatus: ReflectionCardEpistemicStatusSchema,
  epistemicCaution: DailyReflectionMemoryProposalEpistemicCautionSchema,
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(20_000),
  sourceCount: z.number().int().positive(),
  evidence: z.array(DailyReflectionReturnEvidenceSchema).min(1).max(128)
}).strict();

export const DailyReflectionMemoryListResponseSchema = z.object({
  memories: z.array(DailyReflectionMemoryViewSchema).max(1_000),
  total: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.total !== value.memories.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["total"], message: "total must match memories" });
  }
  if (new Set(value.memories.map((memory) => memory.id)).size !== value.memories.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["memories"], message: "memory ids must be unique" });
  }
});

export const DailyReflectionMemoryDetailResponseSchema = z.object({
  memory: DailyReflectionMemoryViewSchema
}).strict();

export type DailyReflectionMemoryView = z.infer<typeof DailyReflectionMemoryViewSchema>;
export type DailyReflectionMemoryListResponse = z.infer<typeof DailyReflectionMemoryListResponseSchema>;
export type DailyReflectionMemoryDetailResponse = z.infer<typeof DailyReflectionMemoryDetailResponseSchema>;
