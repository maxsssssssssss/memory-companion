import type { ProactiveMemoryItem } from "@/lib/server/proactive-insights/memory-context";

import { MemoryRelevanceResultSchema, type MemoryRelevanceCandidate, type MemoryRelevanceResult } from "./types";

const MIN_RELEVANCE_SCORE = 0.55;
const MIN_USEFULNESS_SCORE = 0.55;
const MAX_ACCEPTED_MEMORIES = 5;

const unsafeJudgmentPatterns = [
  /渣男|渣女/u,
  /有病|人格障碍|心理疾病|心理诊断/u,
  /应该分手|建议分手|必须分手/u,
  /(?:他|她|对方)(?:就是|一定|肯定|总是)/u,
  /manipulat(?:e|ion|ive)/iu,
  /personality disorder|mental illness|break up with/iu
];

export type MemoryRelevanceRejectionReason =
  | "unrelated_topic"
  | "not_useful_now"
  | "rejected_by_judge"
  | "capacity_limit"
  | "invalid_result"
  | "unsafe_judgment";

export type ValidatedMemoryRelevance = {
  acceptedMemoryIds: string[];
  decisions: MemoryRelevanceResult[];
  rejectionReasons: Partial<Record<MemoryRelevanceRejectionReason, number>>;
  averageRelevanceScore: number;
};

function isUnsafeJudgment(result: MemoryRelevanceResult) {
  const text = `${result.reason} ${result.caution ?? ""}`;
  return unsafeJudgmentPatterns.some((pattern) => pattern.test(text));
}

function acceptanceRank(
  left: MemoryRelevanceResult,
  right: MemoryRelevanceResult,
  memoryById: Map<string, ProactiveMemoryItem>
) {
  const leftMemory = memoryById.get(left.memoryId);
  const rightMemory = memoryById.get(right.memoryId);
  const leftScore = left.relevanceScore * 0.55 + left.usefulnessScore * 0.35 + (leftMemory?.importanceScore ?? 0) * 0.1;
  const rightScore = right.relevanceScore * 0.55 + right.usefulnessScore * 0.35 + (rightMemory?.importanceScore ?? 0) * 0.1;
  return rightScore - leftScore || left.memoryId.localeCompare(right.memoryId);
}

function incrementReason(
  reasons: Partial<Record<MemoryRelevanceRejectionReason, number>>,
  reason: MemoryRelevanceRejectionReason
) {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

export function validateMemoryRelevanceResults(input: {
  candidates: MemoryRelevanceCandidate[];
  memories: ProactiveMemoryItem[];
  rawResults: unknown[];
  maxItems?: number;
}): ValidatedMemoryRelevance {
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.memoryId));
  const memoryById = new Map(input.memories.map((memory) => [memory.memoryId, memory] as const));
  const seenIds = new Set<string>();
  const decisions: MemoryRelevanceResult[] = [];
  const rejectionReasons: Partial<Record<MemoryRelevanceRejectionReason, number>> = {};

  for (const rawResult of input.rawResults) {
    const parsed = MemoryRelevanceResultSchema.safeParse(rawResult);
    if (!parsed.success || !candidateIds.has(parsed.data.memoryId) || seenIds.has(parsed.data.memoryId)) {
      incrementReason(rejectionReasons, "invalid_result");
      continue;
    }

    seenIds.add(parsed.data.memoryId);
    if (isUnsafeJudgment(parsed.data)) {
      incrementReason(rejectionReasons, "unsafe_judgment");
      continue;
    }
    decisions.push(parsed.data);
  }

  for (const candidate of input.candidates) {
    if (!seenIds.has(candidate.memoryId)) {
      incrementReason(rejectionReasons, "invalid_result");
    }
  }

  const eligible = decisions
    .filter((decision) => {
      if (!decision.shouldUse) {
        const reason = decision.relevanceScore < MIN_RELEVANCE_SCORE
          ? "unrelated_topic"
          : decision.usefulnessScore < MIN_USEFULNESS_SCORE
            ? "not_useful_now"
            : "rejected_by_judge";
        incrementReason(rejectionReasons, reason);
        return false;
      }
      if (decision.relevanceScore < MIN_RELEVANCE_SCORE) {
        incrementReason(rejectionReasons, "unrelated_topic");
        return false;
      }
      if (decision.usefulnessScore < MIN_USEFULNESS_SCORE) {
        incrementReason(rejectionReasons, "not_useful_now");
        return false;
      }
      return true;
    })
    .sort((left, right) => acceptanceRank(left, right, memoryById));
  const limit = Math.min(MAX_ACCEPTED_MEMORIES, Math.max(0, input.maxItems ?? MAX_ACCEPTED_MEMORIES));
  const accepted = eligible.slice(0, limit);
  for (let index = limit; index < eligible.length; index += 1) {
    incrementReason(rejectionReasons, "capacity_limit");
  }

  const averageRelevanceScore = decisions.length === 0
    ? 0
    : decisions.reduce((total, decision) => total + decision.relevanceScore, 0) / decisions.length;

  return {
    acceptedMemoryIds: accepted.map((decision) => decision.memoryId),
    decisions,
    rejectionReasons,
    averageRelevanceScore
  };
}
