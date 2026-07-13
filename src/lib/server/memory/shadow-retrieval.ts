import { getMemoryDatabase } from "./db";
import { compareRetrievalSources, logRetrievalComparison, type JsonRetrievalEvidence, type RetrievalComparison } from "./retrieval-comparison";
import { createMemoryRepository } from "./repository";
import type { MemoryEvidence, MemoryItem, MemoryItemType, MemoryRepository } from "./types";

export type MemoryShadowScope = "week" | "all";

export type MemoryShadowDateRange = {
  startDate: string;
  endDate: string;
};

export type MemoryShadowRetrievalResult = {
  memories: MemoryItem[];
  evidence: MemoryEvidence[];
  retrievalTimeMs: number;
  count: number;
};

const MIN_SHADOW_IMPORTANCE = 0.45;
const MAX_SHADOW_MEMORIES = 40;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const memoryTypeHints: Array<{ type: MemoryItemType; pattern: RegExp }> = [
  { type: "commitment", pattern: /承诺|答应|约定|兑现|promise|commitment/i },
  { type: "question", pattern: /未解决|没解决|没说清|待确认|问题|疑问|open[_ ]?question|unresolved/i },
  { type: "relationship_signal", pattern: /关系|互动|倾听|情绪|边界|回应|回避|贬低|约会|relationship/i },
  { type: "event", pattern: /发生|讨论|重点|事件|决定|安排|进展|event|decision/i }
];

export function inferMemoryTypesForQuery(query: string): MemoryItemType[] {
  const matched = memoryTypeHints
    .filter((hint) => hint.pattern.test(query))
    .map((hint) => hint.type);

  return matched.length > 0
    ? [...new Set(matched)]
    : ["event", "commitment", "question", "relationship_signal"];
}

function assertDateRange(scope: MemoryShadowScope, dateRange?: MemoryShadowDateRange) {
  if (scope === "all") {
    return undefined;
  }
  if (
    !dateRange ||
    !DATE_KEY_PATTERN.test(dateRange.startDate) ||
    !DATE_KEY_PATTERN.test(dateRange.endDate) ||
    dateRange.startDate > dateRange.endDate
  ) {
    throw new Error("week shadow retrieval requires a valid date range");
  }
  return dateRange;
}

export function dateRangeFromScopeId(scopeId: string): MemoryShadowDateRange | undefined {
  const match = /^week_(\d{4})-?(\d{2})-?(\d{2})_(\d{4})-?(\d{2})-?(\d{2})$/.exec(scopeId);
  if (!match) {
    return undefined;
  }

  return {
    startDate: `${match[1]}-${match[2]}-${match[3]}`,
    endDate: `${match[4]}-${match[5]}-${match[6]}`
  };
}

export function retrieveMemoryShadow(input: {
  userId: string;
  scope: MemoryShadowScope;
  query: string;
  dateRange?: MemoryShadowDateRange;
  repository?: MemoryRepository;
}): MemoryShadowRetrievalResult {
  const startedAt = performance.now();
  const dateRange = assertDateRange(input.scope, input.dateRange);
  const repository = input.repository ?? createMemoryRepository(getMemoryDatabase());
  const memories = repository
    .getRelevantMemories({
      userId: input.userId,
      ...(dateRange ? { startDate: dateRange.startDate, endDate: dateRange.endDate } : {}),
      types: inferMemoryTypesForQuery(input.query),
      limit: MAX_SHADOW_MEMORIES
    })
    .filter((memory) => memory.importance >= MIN_SHADOW_IMPORTANCE);
  const evidenceById = new Map(
    memories.flatMap((memory) => memory.evidence).map((evidence) => [evidence.id, evidence])
  );

  return {
    memories,
    evidence: [...evidenceById.values()],
    retrievalTimeMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
    count: memories.length
  };
}

export function observeMemoryShadowRetrieval(input: {
  userId: string;
  scope: MemoryShadowScope;
  query: string;
  dateRange?: MemoryShadowDateRange;
  jsonEvidence: JsonRetrievalEvidence[];
  jsonRetrievalTimeMs: number;
  repository?: MemoryRepository;
}): RetrievalComparison | null {
  try {
    const memoryResult = retrieveMemoryShadow(input);
    const comparison = compareRetrievalSources({
      query: input.query,
      scope: input.scope,
      jsonEvidence: input.jsonEvidence,
      jsonRetrievalTimeMs: input.jsonRetrievalTimeMs,
      memoryResult
    });
    logRetrievalComparison(comparison);
    return comparison;
  } catch (error) {
    console.warn(
      `[memory-shadow] scope=${input.scope} failure=${error instanceof Error ? error.message : "unknown_error"}`
    );
    return null;
  }
}
