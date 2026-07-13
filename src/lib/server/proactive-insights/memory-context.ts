import { createHash } from "node:crypto";

import type { ProactiveInsightScope } from "@/lib/domain/proactive-insights";
import { getMemoryRepository } from "@/lib/server/memory";
import type {
  MemoryEvidence,
  MemoryItem,
  MemoryItemType,
  MemoryRelation,
  MemoryRelationType,
  MemoryRepository
} from "@/lib/server/memory/types";

const MIN_IMPORTANCE_SCORE = 0.6;
const MAX_MEMORIES = 20;
const MAX_RELATIONS = 10;
const MAX_EVIDENCE_PER_MEMORY = 4;
const MAX_QUOTE_LENGTH = 320;
const MEMORY_TYPES = [
  "commitment",
  "question",
  "relationship_signal",
  "preference",
  "event"
] as const satisfies readonly MemoryItemType[];
const TYPE_PRIORITY: Record<(typeof MEMORY_TYPES)[number], number> = {
  question: 6,
  commitment: 5,
  relationship_signal: 4,
  preference: 2,
  event: 1
};

export type ProactiveMemoryLifecycleKind =
  | "unresolved_question"
  | "active_commitment"
  | "relationship_signal"
  | "repeated_memory"
  | "preference"
  | "event";

export type ProactiveMemoryEvidence = {
  sourceType: "transcript";
  sourceId: string;
  uploadId: string;
  recordingDate: string;
  excerpt: string;
};

export type ProactiveMemoryItem = {
  evidenceId: string;
  memoryId: string;
  type: (typeof MEMORY_TYPES)[number];
  title: string;
  summary: string;
  importanceScore: number;
  confidence: "medium" | "high";
  status: MemoryItem["status"];
  lifecycleKind: ProactiveMemoryLifecycleKind;
  occurrenceCount: number;
  dates: string[];
  sourceUploadIds: string[];
  evidence: ProactiveMemoryEvidence[];
};

export type ProactiveMemoryRelation = {
  relationId: string;
  relationType: MemoryRelationType;
  confidence: number;
  sourceMemoryRef: string;
  targetMemoryRef: string;
};

export type ProactiveInsightMemoryContext = {
  scope: ProactiveInsightScope;
  currentUploadId: string;
  memories: ProactiveMemoryItem[];
  relations: ProactiveMemoryRelation[];
  truncated: boolean;
};

function compactText(value: string, maxLength = MAX_QUOTE_LENGTH) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function historicalTranscriptEvidence(memory: MemoryItem, currentUploadId: string) {
  return memory.evidence
    .filter(
      (item): item is MemoryEvidence & { sourceType: "transcript" } =>
        item.sourceType === "transcript" && item.uploadId !== currentUploadId && item.quote.trim().length > 0
    )
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) ||
        left.uploadId.localeCompare(right.uploadId) ||
        left.sourceId.localeCompare(right.sourceId)
    );
}

function pickEvidence(evidence: Array<MemoryEvidence & { sourceType: "transcript" }>) {
  const selected: Array<MemoryEvidence & { sourceType: "transcript" }> = [];
  const selectedIds = new Set<string>();
  const seenDates = new Set<string>();

  for (const item of evidence) {
    if (seenDates.has(item.date)) {
      continue;
    }
    selected.push(item);
    selectedIds.add(item.id);
    seenDates.add(item.date);
    if (selected.length >= MAX_EVIDENCE_PER_MEMORY) {
      return selected;
    }
  }

  for (const item of evidence) {
    if (selectedIds.has(item.id)) {
      continue;
    }
    selected.push(item);
    if (selected.length >= MAX_EVIDENCE_PER_MEMORY) {
      break;
    }
  }

  return selected;
}

function memoryRank(left: MemoryItem, right: MemoryItem) {
  const leftType = left.type as (typeof MEMORY_TYPES)[number];
  const rightType = right.type as (typeof MEMORY_TYPES)[number];
  return (
    TYPE_PRIORITY[rightType] - TYPE_PRIORITY[leftType] ||
    right.importanceScore - left.importanceScore ||
    right.occurrenceCount - left.occurrenceCount ||
    right.lastSeenDate.localeCompare(left.lastSeenDate) ||
    left.id.localeCompare(right.id)
  );
}

function lifecycleKind(memory: MemoryItem): ProactiveMemoryLifecycleKind {
  if (memory.type === "question") {
    return "unresolved_question";
  }
  if (memory.type === "commitment") {
    return "active_commitment";
  }
  if (memory.type === "relationship_signal") {
    return "relationship_signal";
  }
  if (memory.occurrenceCount > 1) {
    return "repeated_memory";
  }
  return memory.type === "preference" ? "preference" : "event";
}

function normalizeMemory(memory: MemoryItem, currentUploadId: string): ProactiveMemoryItem | null {
  if (!MEMORY_TYPES.some((type) => type === memory.type) || memory.status !== "active") {
    return null;
  }
  if (memory.importanceScore < MIN_IMPORTANCE_SCORE) {
    return null;
  }
  if (memory.type === "event" && memory.occurrenceCount <= 1) {
    return null;
  }

  const historicalEvidence = historicalTranscriptEvidence(memory, currentUploadId);
  if (historicalEvidence.length === 0) {
    return null;
  }

  const selectedEvidence = pickEvidence(historicalEvidence);
  return {
    evidenceId: `memory:${memory.id}`,
    memoryId: memory.id,
    type: memory.type as (typeof MEMORY_TYPES)[number],
    title: compactText(memory.title, 160),
    summary: compactText(memory.summary, 400),
    importanceScore: memory.importanceScore,
    confidence: memory.importanceScore >= 0.8 ? "high" : "medium",
    status: memory.status,
    lifecycleKind: lifecycleKind(memory),
    occurrenceCount: memory.occurrenceCount,
    dates: [...new Set(historicalEvidence.map((item) => item.date))].sort(),
    sourceUploadIds: [...new Set(historicalEvidence.map((item) => item.uploadId))].sort(),
    evidence: selectedEvidence.map((item) => ({
      sourceType: "transcript",
      sourceId: item.sourceId,
      uploadId: item.uploadId,
      recordingDate: item.date,
      excerpt: compactText(item.quote)
    }))
  };
}

function normalizeRelations(relations: MemoryRelation[], memories: ProactiveMemoryItem[]) {
  const selectedIds = new Set(memories.map((memory) => memory.memoryId));
  return relations
    .filter(
      (relation) =>
        selectedIds.has(relation.sourceMemoryId) && selectedIds.has(relation.targetMemoryId)
    )
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
    )
    .slice(0, MAX_RELATIONS)
    .map((relation) => ({
      relationId: relation.id,
      relationType: relation.relationType,
      confidence: relation.confidence,
      sourceMemoryRef: `memory:${relation.sourceMemoryId}`,
      targetMemoryRef: `memory:${relation.targetMemoryId}`
    }));
}

export function buildProactiveInsightMemoryContext(input: {
  userId: string;
  scope: ProactiveInsightScope;
  currentUploadId: string;
  repository?: Pick<MemoryRepository, "getRelevantMemories"> &
    Partial<Pick<MemoryRepository, "getMemoryRelations">>;
}): ProactiveInsightMemoryContext {
  const repository = input.repository ?? getMemoryRepository();
  const candidates = repository.getRelevantMemories({
    userId: input.userId,
    types: [...MEMORY_TYPES],
    limit: 100
  });
  const eligible = candidates
    .slice()
    .sort(memoryRank)
    .flatMap((memory) => {
      const normalized = normalizeMemory(memory, input.currentUploadId);
      return normalized ? [normalized] : [];
    });

  const memories = eligible.slice(0, MAX_MEMORIES);
  const allRelations = repository.getMemoryRelations?.(input.userId) ?? [];
  const relations = normalizeRelations(allRelations, memories);

  return {
    scope: input.scope,
    currentUploadId: input.currentUploadId,
    memories,
    relations,
    truncated: eligible.length > MAX_MEMORIES || allRelations.length > relations.length
  };
}

export function emptyProactiveInsightMemoryContext(input: {
  scope: ProactiveInsightScope;
  currentUploadId: string;
}): ProactiveInsightMemoryContext {
  return {
    scope: input.scope,
    currentUploadId: input.currentUploadId,
    memories: [],
    relations: [],
    truncated: false
  };
}

export function combineProactiveInsightSourceFingerprint(
  currentFingerprint: string,
  memoryContext: ProactiveInsightMemoryContext
) {
  if (memoryContext.memories.length === 0) {
    return currentFingerprint;
  }

  return createHash("sha256")
    .update(
      JSON.stringify({
        currentFingerprint,
        memories: memoryContext.memories.map((memory) => ({
          memoryId: memory.memoryId,
          type: memory.type,
          summary: memory.summary,
          importanceScore: memory.importanceScore,
          occurrenceCount: memory.occurrenceCount,
          status: memory.status,
          lifecycleKind: memory.lifecycleKind,
          dates: memory.dates,
          evidence: memory.evidence.map((item) => ({
            sourceId: item.sourceId,
            uploadId: item.uploadId,
            recordingDate: item.recordingDate,
            excerpt: item.excerpt
          }))
        })),
        relations: memoryContext.relations
      })
    )
    .digest("hex");
}
