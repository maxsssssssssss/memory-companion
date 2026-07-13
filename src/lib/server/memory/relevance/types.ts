import { z } from "zod";

import type { MemoryItemType, MemoryStatus } from "@/lib/server/memory/types";

export const MemoryRelevanceResultSchema = z.object({
  memoryId: z.string().trim().min(1).max(512),
  shouldUse: z.boolean(),
  relevanceScore: z.number().min(0).max(1),
  usefulnessScore: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(360),
  caution: z.string().trim().min(1).max(240).optional()
}).strict();

export const MemoryRelevanceResponseSchema = z.object({
  results: z.array(z.unknown()).max(20)
}).strict();

export type MemoryRelevanceResult = z.infer<typeof MemoryRelevanceResultSchema>;

export type MemoryRelevanceCurrentContext = {
  referenceDate: string;
  topics: string[];
  briefItems: string[];
  semanticSummaries: string[];
  relationshipSignals: string[];
};

export type MemoryRelevanceCandidate = {
  memoryId: string;
  memoryRef: string;
  type: MemoryItemType;
  summary: string;
  dates: string[];
  importanceScore: number;
  status: MemoryStatus;
  occurrenceCount: number;
  evidenceSummaries: string[];
};

export type MemoryRelevanceFailureCode =
  | "disabled"
  | "missing_api_key"
  | "invalid_base_url"
  | "invalid_model"
  | "empty_response"
  | "invalid_json"
  | "invalid_schema"
  | "api_error"
  | "timeout";

export type MemoryRelevanceJudgeRunResult = {
  status: "judged" | "fallback" | "disabled";
  rawResults: unknown[];
  provider: "deepseek" | "none";
  model?: string;
  elapsedMs: number;
  failureCode?: MemoryRelevanceFailureCode;
};

export type MemoryRelevanceJudge = {
  judge(input: {
    current: MemoryRelevanceCurrentContext;
    candidates: MemoryRelevanceCandidate[];
  }): Promise<MemoryRelevanceJudgeRunResult>;
};

