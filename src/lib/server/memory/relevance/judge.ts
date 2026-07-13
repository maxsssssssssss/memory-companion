import type { ProactiveInsightContext } from "@/lib/domain/proactive-insights";
import {
  emptyProactiveInsightMemoryContext,
  type ProactiveInsightMemoryContext
} from "@/lib/server/proactive-insights/memory-context";

import { getMemoryRelevanceJudge } from "./deepseek-judge";
import type {
  MemoryRelevanceCandidate,
  MemoryRelevanceCurrentContext,
  MemoryRelevanceJudge
} from "./types";
import { validateMemoryRelevanceResults, type MemoryRelevanceRejectionReason } from "./validator";

type Logger = Pick<Console, "info" | "warn">;

const MAX_CURRENT_CONTEXT_ITEMS = 8;
const MAX_TEXT_LENGTH = 240;

function compactText(value: string, maxLength = MAX_TEXT_LENGTH) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function uniqueStrings(values: string[], limit = MAX_CURRENT_CONTEXT_ITEMS) {
  return [...new Set(values.map((value) => compactText(value)).filter(Boolean))].slice(0, limit);
}

export function buildMemoryRelevanceCurrentContext(
  context: ProactiveInsightContext
): MemoryRelevanceCurrentContext {
  return {
    referenceDate: context.referenceDate,
    topics: uniqueStrings(context.evidence.map((item) => item.title)),
    briefItems: uniqueStrings(
      context.evidence
        .filter((item) => item.kind === "brief")
        .map((item) => `${item.title}: ${item.summary}`)
    ),
    semanticSummaries: uniqueStrings(
      context.evidence
        .filter((item) => item.kind === "semantic_segment")
        .map((item) => `${item.title}: ${item.summary}`)
    ),
    relationshipSignals: uniqueStrings(
      context.evidence
        .filter((item) => item.kind === "relationship_signal")
        .map((item) => `${item.title}: ${item.summary}`)
    )
  };
}

export function buildMemoryRelevanceCandidates(
  memoryContext: ProactiveInsightMemoryContext
): MemoryRelevanceCandidate[] {
  return memoryContext.memories.slice(0, 20).map((memory) => ({
    memoryId: memory.memoryId,
    memoryRef: memory.evidenceId,
    type: memory.type,
    summary: compactText(`${memory.title}: ${memory.summary}`, 400),
    dates: memory.dates,
    importanceScore: memory.importanceScore,
    status: memory.status,
    occurrenceCount: memory.occurrenceCount,
    evidenceSummaries: memory.evidence
      .slice(0, 2)
      .map((evidence) => compactText(`${evidence.recordingDate}: ${evidence.excerpt}`, 180))
  }));
}

function filterMemoryContext(
  context: ProactiveInsightMemoryContext,
  acceptedMemoryIds: string[]
): ProactiveInsightMemoryContext {
  const acceptedIds = new Set(acceptedMemoryIds);
  return {
    ...context,
    memories: context.memories.filter((memory) => acceptedIds.has(memory.memoryId)),
    relations: context.relations.filter(
      (relation) =>
        acceptedIds.has(relation.sourceMemoryRef.slice("memory:".length)) &&
        acceptedIds.has(relation.targetMemoryRef.slice("memory:".length))
    )
  };
}

function formatRejectionReasons(
  rejectionReasons: Partial<Record<MemoryRelevanceRejectionReason, number>>
) {
  return Object.entries(rejectionReasons)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
}

export type MemoryRelevanceGateResult = {
  memoryContext: ProactiveInsightMemoryContext;
  candidates: number;
  accepted: number;
  rejected: number;
  averageRelevanceScore: number;
  fallback: boolean;
  failureCode?: string;
};

export async function applyMemoryRelevanceGate(input: {
  context: ProactiveInsightContext;
  memoryContext: ProactiveInsightMemoryContext;
  judge?: MemoryRelevanceJudge;
  logger?: Logger;
}): Promise<MemoryRelevanceGateResult> {
  const logger = input.logger ?? console;
  const candidates = buildMemoryRelevanceCandidates(input.memoryContext);
  const currentOnlyContext = emptyProactiveInsightMemoryContext({
    scope: input.memoryContext.scope,
    currentUploadId: input.memoryContext.currentUploadId
  });

  if (candidates.length === 0) {
    logger.info("[memory-relevance] candidates=0 accepted=0 rejected=0 avg_score=0.00 fallback=false");
    return {
      memoryContext: currentOnlyContext,
      candidates: 0,
      accepted: 0,
      rejected: 0,
      averageRelevanceScore: 0,
      fallback: false
    };
  }

  try {
    const judge = input.judge ?? getMemoryRelevanceJudge();
    const runResult = await judge.judge({
      current: buildMemoryRelevanceCurrentContext(input.context),
      candidates
    });
    if (runResult.status !== "judged") {
      logger.warn(
        `[memory-relevance] candidates=${candidates.length} accepted=0 rejected=${candidates.length} avg_score=0.00 fallback=true failure=${runResult.failureCode ?? runResult.status}`
      );
      return {
        memoryContext: currentOnlyContext,
        candidates: candidates.length,
        accepted: 0,
        rejected: candidates.length,
        averageRelevanceScore: 0,
        fallback: true,
        failureCode: runResult.failureCode ?? runResult.status
      };
    }

    const validation = validateMemoryRelevanceResults({
      candidates,
      memories: input.memoryContext.memories,
      rawResults: runResult.rawResults
    });
    const filteredContext = filterMemoryContext(
      input.memoryContext,
      validation.acceptedMemoryIds
    );
    const rejectionSummary = formatRejectionReasons(validation.rejectionReasons);
    logger.info(
      `[memory-relevance] candidates=${candidates.length} accepted=${filteredContext.memories.length} rejected=${candidates.length - filteredContext.memories.length} avg_score=${validation.averageRelevanceScore.toFixed(2)} fallback=false reasons=${rejectionSummary || "none"} elapsed_ms=${runResult.elapsedMs}`
    );

    return {
      memoryContext: filteredContext,
      candidates: candidates.length,
      accepted: filteredContext.memories.length,
      rejected: candidates.length - filteredContext.memories.length,
      averageRelevanceScore: validation.averageRelevanceScore,
      fallback: false
    };
  } catch {
    logger.warn(
      `[memory-relevance] candidates=${candidates.length} accepted=0 rejected=${candidates.length} avg_score=0.00 fallback=true failure=unexpected_error`
    );
    return {
      memoryContext: currentOnlyContext,
      candidates: candidates.length,
      accepted: 0,
      rejected: candidates.length,
      averageRelevanceScore: 0,
      fallback: true,
      failureCode: "unexpected_error"
    };
  }
}
