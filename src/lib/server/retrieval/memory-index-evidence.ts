import { getMemoryRepository } from "@/lib/server/memory";
import type {
  MemoryEvidence,
  MemoryItem,
  MemoryItemType,
  MemoryRepository
} from "@/lib/server/memory/types";
import type { MemoryOwnerMetadata } from "@/lib/server/memory/owner-attribution/types";
import { filterMemoryOwnerMetadataByEvidence } from "@/lib/server/memory/owner-attribution/storage";
import {
  resolveMemoryRetrievalSource,
  type MemoryRetrievalSourceAttribution
} from "./source-awareness";

export type MemoryIndexQaScope = "current" | "week" | "all";

export type MemoryIndexQaDateRange = {
  startDate: string;
  endDate: string;
};

export type MemoryIndexQaContext = {
  scope: MemoryIndexQaScope;
  memories: MemoryItem[];
  ownerAttributions?: MemoryOwnerMetadata[];
  sourceAttributions?: MemoryRetrievalSourceAttribution[];
  evidence: MemoryEvidence[];
  sourceIds: string[];
  distinctDates: string[];
  count: number;
  retrievalTimeMs: number;
};

type MemoryIntent = {
  types: MemoryItemType[];
  typed: boolean;
};

const ALL_MIN_IMPORTANCE_SCORE = 0.6;
const WEEK_MIN_IMPORTANCE_SCORE = 0.4;
const WEEK_PRIORITY_TYPES = new Set<MemoryItemType>([
  "commitment",
  "question",
  "relationship_signal",
  "preference"
]);
const MAX_TYPED_MEMORIES = 6;
const MAX_GENERIC_MEMORIES = 3;
const ALL_MEMORY_TYPES: MemoryItemType[] = [
  "event",
  "commitment",
  "question",
  "relationship_signal",
  "preference",
  "summary"
];

const TYPE_HINTS: Array<{ type: MemoryItemType; pattern: RegExp }> = [
  { type: "commitment", pattern: /承诺|答应|约定|兑现|说好|下一步|跟进|promise|commitment|follow[- ]?up/i },
  { type: "question", pattern: /未解决|没解决|没说清|待确认|还没确认|问题|疑问|open[_ ]?question|unresolved/i },
  { type: "relationship_signal", pattern: /关系|互动|倾听|情绪|边界|回应|回避|贬低|否定|约会|信号|relationship/i },
  { type: "preference", pattern: /喜欢|偏好|习惯|更愿意|preference|prefer/i },
  { type: "summary", pattern: /总结|概括|总览|summary|overview/i },
  { type: "event", pattern: /发生|讨论|重点|决定|安排|事件|进展|event|decision/i }
];

function inferMemoryIntent(query: string): MemoryIntent {
  const matched = TYPE_HINTS.filter((hint) => hint.pattern.test(query)).map((hint) => hint.type);
  const types = [...new Set(matched)];
  return types.length > 0 ? { types, typed: true } : { types: ALL_MEMORY_TYPES, typed: false };
}

function validateDateRange(scope: MemoryIndexQaScope, dateRange?: MemoryIndexQaDateRange) {
  if (scope === "all") {
    return undefined;
  }
  if (!dateRange || dateRange.startDate > dateRange.endDate) {
    throw new Error(`${scope} memory QA retrieval requires a valid date range`);
  }
  if (scope === "current" && dateRange.startDate !== dateRange.endDate) {
    throw new Error("current memory QA retrieval requires a single-day date range");
  }
  return dateRange;
}

function hasTranscriptEvidence(memory: MemoryItem) {
  return memory.evidence.some((item) => item.sourceType === "transcript");
}

function memoryRank(memory: MemoryItem) {
  const distinctDates = new Set(memory.evidence.map((item) => item.date)).size;
  return (
    memory.importanceScore +
    (memory.status === "active" ? 0.2 : memory.status === "resolved" ? -0.1 : -0.3) +
    (memory.occurrenceCount > 1 ? Math.min(0.16, (memory.occurrenceCount - 1) * 0.08) : 0) +
    (distinctDates > 1 ? 0.08 : 0)
  );
}

function isEligibleForScope(memory: MemoryItem, scope: MemoryIndexQaScope) {
  if (memory.status === "expired" || memory.status === "superseded") {
    return false;
  }
  if (scope === "current" || scope === "week") {
    return (
      memory.importanceScore >= WEEK_MIN_IMPORTANCE_SCORE ||
      memory.status === "active" ||
      WEEK_PRIORITY_TYPES.has(memory.type)
    );
  }
  return memory.importanceScore >= ALL_MIN_IMPORTANCE_SCORE;
}

function compareMemories(left: MemoryItem, right: MemoryItem, scope: MemoryIndexQaScope) {
  if (scope === "week" && left.status !== right.status) {
    if (left.status === "active") return -1;
    if (right.status === "active") return 1;
  }
  return (
    memoryRank(right) - memoryRank(left) ||
    right.lastSeenDate.localeCompare(left.lastSeenDate) ||
    left.id.localeCompare(right.id)
  );
}

function emptyContext(scope: MemoryIndexQaScope, startedAt: number): MemoryIndexQaContext {
  return {
    scope,
    memories: [],
    ownerAttributions: [],
    sourceAttributions: [],
    evidence: [],
    sourceIds: [],
    distinctDates: [],
    count: 0,
    retrievalTimeMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)
  };
}

export function retrieveMemoryIndexEvidence(input: {
  userId: string;
  scope: MemoryIndexQaScope;
  query: string;
  dateRange?: MemoryIndexQaDateRange;
  repository?: Pick<MemoryRepository, "getRelevantMemories"> &
    Partial<Pick<MemoryRepository, "getMemoryOwnerAttributions">>;
  sourceResolver?: typeof resolveMemoryRetrievalSource;
}): MemoryIndexQaContext {
  const startedAt = performance.now();
  if (input.scope === "current" && !input.dateRange) {
    return emptyContext(input.scope, startedAt);
  }
  const dateRange = validateDateRange(input.scope, input.dateRange);
  const intent = inferMemoryIntent(input.query);
  const repository = input.repository ?? getMemoryRepository();
  const limit = intent.typed ? MAX_TYPED_MEMORIES : MAX_GENERIC_MEMORIES;
  const candidates = repository
    .getRelevantMemories({
      userId: input.userId,
      ...(dateRange ? { startDate: dateRange.startDate, endDate: dateRange.endDate } : {}),
      types: intent.types,
      limit: 80
    })
    .filter((memory) => intent.types.includes(memory.type))
    .filter(hasTranscriptEvidence)
    .sort((left, right) => compareMemories(left, right, input.scope));
  const sourceResolver = input.sourceResolver ?? resolveMemoryRetrievalSource;
  const sourceByMemoryId = new Map(candidates.map((memory) => [
    memory.id,
    sourceResolver({ userId: input.userId, memory })
  ]));
  const memories = candidates
    .filter((memory) => {
      const source = sourceByMemoryId.get(memory.id);
      return source?.eligible === true
        && (
          isEligibleForScope(memory, input.scope)
          || source.attribution.origin === "user_reflection" && memory.status === "active"
        );
    })
    .slice(0, limit);
  const sourceAttributions = memories.flatMap((memory) => {
    const resolved = sourceByMemoryId.get(memory.id);
    return resolved ? [resolved.attribution] : [];
  });
  const evidenceById = new Map(
    memories.flatMap((memory) => memory.evidence).map((evidence) => [evidence.id, evidence])
  );
  const evidence = [...evidenceById.values()];
  let ownerAttributions: MemoryOwnerMetadata[] = [];
  try {
    const retrieved = repository.getMemoryOwnerAttributions?.(
      input.userId,
      memories.map((memory) => memory.id)
    ) ?? [];
    const selectedTranscriptIds = new Set(
      evidence
        .filter((item) => item.sourceType === "transcript")
        .map((item) => item.sourceId)
    );
    ownerAttributions = retrieved.flatMap((metadata) => {
      const scoped = filterMemoryOwnerMetadataByEvidence(metadata, selectedTranscriptIds);
      return scoped ? [scoped] : [];
    });
  } catch (error) {
    console.warn(
      `[memory-owner] retrieval_failed user_id=${input.userId} error_name=${error instanceof Error ? error.name : "unknown"}`
    );
  }

  return {
    scope: input.scope,
    memories,
    ownerAttributions,
    sourceAttributions,
    evidence,
    sourceIds: [...new Set(evidence.map((item) => item.sourceId))],
    distinctDates: [...new Set(evidence.map((item) => item.date))].sort(),
    count: memories.length,
    retrievalTimeMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)
  };
}
