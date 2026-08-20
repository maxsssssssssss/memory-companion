import {
  meaningfulTextTokens,
  sharedTokenCount
} from "@/lib/server/text-features";
import type { MemoryItem } from "@/lib/server/memory/types";
import type { MemoryOwnerMetadata } from "@/lib/server/memory/owner-attribution/types";
import type { QaRetrievedEvidence } from "../ai-qa";
import {
  cosineSimilarity,
  type EmbeddingProvider
} from "./embedding-provider";
import {
  embeddingContentHash,
  SqliteEmbeddingIndex
} from "./embedding-index";
import { parseHybridQuery, type HybridQuery } from "./query-parser";
import { reciprocalRankFusion } from "./rrf";
import type { EvidenceRankingMetadata } from "./types";

export type MemoryExpansionMode =
  | "structured"
  | "dense"
  | "structured_dense";

export type MemoryExpansionScope = "current" | "week" | "all";

export type MemoryScopeDateRange = {
  startDate: string;
  endDate: string;
};

export type MemoryRecallCandidate = {
  memory: MemoryItem;
  rank: number;
  score: number;
  reasons: string[];
};

export type MemoryExpansionCandidate = {
  evidence: QaRetrievedEvidence;
  score: number;
  reasons: string[];
  memoryIds: string[];
  mappingSourceIds: string[];
};

export type MemoryExpansionDiagnostics = {
  mode: MemoryExpansionMode;
  memoryLimit: number;
  currentScopeDisabled: boolean;
  totalMemoryCount: number;
  queryEligibleMemoryCount: number;
  typeFilteredCount: number;
  scopeFilteredCount: number;
  dateFilteredCount: number;
  retrievedMemoryCount: number;
  successfullyMappedMemoryCount: number;
  distinctMappedMemoryCount: number;
  expandedCanonicalEvidenceCount: number;
  unmappedMemoryCount: number;
  distinctUnmappedMemoryCount: number;
  mappedMemoryEvidenceCount: number;
  unmappedMemoryEvidenceCount: number;
  unmappedByReason: Record<string, number>;
  expiredFilteredCount: number;
  supersededFilteredCount: number;
  ownerFilteredCount: number;
  ownerUnknownFilteredCount: number;
  ownerConflictFilteredCount: number;
  ownerUnverifiedFilteredCount: number;
  ownerEntityMismatchFilteredCount: number;
  scopeLeakageCount: number;
  dateLeakageCount: number;
  dateFilteredMemoryEvidenceCount: number;
  rawExpansionCount: number;
  deduplicatedExpansionCount: number;
  candidateDuplicationCount: number;
  finalCandidateDuplicateCount: number;
  fallback: boolean;
  fallbackReason?: string;
};

export type MemoryIndexingResult = {
  total: number;
  embedded: number;
  unchanged: number;
  removed: number;
};

const TARGET_MEMORY_TYPES = new Set<MemoryItem["type"]>([
  "event",
  "commitment",
  "relationship_signal",
  "preference"
]);

function memoryText(memory: MemoryItem) {
  return [
    memory.title.trim(),
    memory.summary.trim(),
    ...memory.evidence.map((item) => `${item.date} ${item.quote.trim()}`)
  ].join("\n").normalize("NFKC");
}

export function memoryEmbeddingText(memory: MemoryItem) {
  return memoryText(memory);
}

function memoryQuestionEmbeddingText(question: string) {
  return [
    "Instruct: Retrieve long-term personal memories that can navigate to canonical evidence for lifecycle, preference, or relationship questions. Do not answer the question.",
    `Query: ${question.normalize("NFKC").trim()}`
  ].join("\n");
}

function providerMatchesIndex(
  provider: EmbeddingProvider,
  index: SqliteEmbeddingIndex
) {
  return provider.config.modelName === index.model.modelName &&
    provider.config.modelVersion === index.model.modelVersion &&
    provider.config.dimension === index.model.dimension;
}

export async function indexMemoryItems(input: {
  memories: readonly MemoryItem[];
  provider: EmbeddingProvider;
  index: SqliteEmbeddingIndex;
  batchSize?: number;
  onProgress?: (progress: {
    completed: number;
    total: number;
  }) => Promise<unknown> | unknown;
}): Promise<MemoryIndexingResult> {
  if (!providerMatchesIndex(input.provider, input.index)) {
    throw new Error("embedding provider and memory sidecar model configuration must match");
  }
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? 16));
  const memories = [...new Map(
    input.memories
      .filter((memory) => TARGET_MEMORY_TYPES.has(memory.type))
      .map((memory) => [memory.id, memory])
  ).values()];
  const pending = memories.flatMap((memory) => {
    const text = memoryEmbeddingText(memory);
    const contentHash = embeddingContentHash(text);
    const existing = input.index.get("memory", memory.id);
    return existing?.contentHash === contentHash
      ? []
      : [{ memory, text, contentHash }];
  });
  await input.onProgress?.({ completed: 0, total: pending.length });
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const vectors = await input.provider.embed(batch.map((item) => item.text));
    if (vectors.length !== batch.length) {
      throw new Error("embedding provider returned an unexpected memory vector count");
    }
    batch.forEach((item, index) => {
      input.index.upsert({
        objectType: "memory",
        objectId: item.memory.id,
        contentHash: item.contentHash,
        vector: vectors[index]!
      });
    });
    await input.onProgress?.({
      completed: Math.min(offset + batch.length, pending.length),
      total: pending.length
    });
  }
  const retainedIds = new Set(memories.map((memory) => memory.id));
  return {
    total: memories.length,
    embedded: pending.length,
    unchanged: memories.length - pending.length,
    removed: input.index.removeMissing("memory", retainedIds)
  };
}

function allowsSuperseded(query: HybridQuery) {
  return ["earlier", "first", "sequence"].includes(query.temporalIntent) ||
    /历史|曾经|过去|原来|最初/iu.test(query.normalized);
}

function targetTypes(query: HybridQuery) {
  const types = new Set<MemoryItem["type"]>();
  if (query.types.includes("lifecycle") || query.types.includes("decision")) {
    types.add("event");
    types.add("commitment");
  }
  if (query.types.includes("preference")) types.add("preference");
  if (query.types.includes("relationship")) types.add("relationship_signal");
  return types;
}

function memoryInDateRange(memory: MemoryItem, range: MemoryScopeDateRange | undefined) {
  if (!range) return true;
  return memory.evidence.some((item) =>
    item.date >= range.startDate && item.date <= range.endDate
  );
}

function ownerDecision(input: {
  query: HybridQuery;
  memory: MemoryItem;
  owner?: MemoryOwnerMetadata;
}) {
  const ownerSensitive =
    input.query.types.includes("preference") ||
    input.query.types.includes("relationship") ||
    input.query.relationshipMode === "owner" ||
    input.query.relationshipMode === "named_person";
  const owner = input.owner;
  const identityIds = new Set([
    ...(owner?.owner.type === "known_identity" && owner.owner.identityId
      ? [owner.owner.identityId]
      : []),
    ...(owner?.participants.flatMap((participant) =>
      participant.attribution.type === "known_identity" &&
      participant.attribution.identityId
        ? [participant.attribution.identityId]
        : []
    ) ?? [])
  ]);
  const conflict = Boolean(
    owner &&
    owner.scope === "unknown" &&
    identityIds.size > 1
  );
  if (conflict) return { allowed: false, reason: "owner_conflict" as const };
  if (!ownerSensitive) return { allowed: true, reason: "owner_not_required" as const };
  if (!owner || owner.owner.type === "unknown") {
    return { allowed: false, reason: "owner_unknown" as const };
  }
  if (owner.owner.type === "local_speaker") {
    return { allowed: false, reason: "owner_unverified" as const };
  }
  if (input.query.entities.length > 0) {
    const normalized = memoryText(input.memory).toLocaleLowerCase("en-US");
    if (!input.query.entities.some((entity) =>
      normalized.includes(entity.toLocaleLowerCase("en-US"))
    )) {
      return { allowed: false, reason: "owner_entity_not_evidenced" as const };
    }
  }
  return { allowed: true, reason: "verified_owner" as const };
}

type FilteredMemoryResult = {
  memories: MemoryItem[];
  totalMemoryCount?: number;
  queryEligibleMemoryCount?: number;
  typeFilteredCount?: number;
  scopeFilteredCount?: number;
  dateFilteredCount?: number;
  expiredFilteredCount: number;
  supersededFilteredCount: number;
  ownerFilteredCount?: number;
  ownerUnknownFilteredCount: number;
  ownerConflictFilteredCount: number;
  ownerUnverifiedFilteredCount: number;
  ownerEntityMismatchFilteredCount?: number;
};

function filterMemories(input: {
  query: HybridQuery;
  scope: MemoryExpansionScope;
  dateRange?: MemoryScopeDateRange;
  memories: readonly MemoryItem[];
  ownersByMemoryId?: ReadonlyMap<string, MemoryOwnerMetadata>;
}): FilteredMemoryResult {
  const wantedTypes = targetTypes(input.query);
  const result: FilteredMemoryResult = {
    memories: [],
    totalMemoryCount: input.memories.length,
    queryEligibleMemoryCount: 0,
    typeFilteredCount: 0,
    scopeFilteredCount: 0,
    dateFilteredCount: 0,
    expiredFilteredCount: 0,
    supersededFilteredCount: 0,
    ownerFilteredCount: 0,
    ownerUnknownFilteredCount: 0,
    ownerConflictFilteredCount: 0,
    ownerUnverifiedFilteredCount: 0,
    ownerEntityMismatchFilteredCount: 0
  };
  if (input.scope === "current") {
    result.scopeFilteredCount = input.memories.length;
    return result;
  }
  if (wantedTypes.size === 0) {
    result.typeFilteredCount = input.memories.length;
    return result;
  }
  for (const memory of input.memories) {
    if (!wantedTypes.has(memory.type)) {
      result.typeFilteredCount! += 1;
      continue;
    }
    if (memory.status === "expired") {
      result.expiredFilteredCount += 1;
      continue;
    }
    if (memory.status === "superseded" && !allowsSuperseded(input.query)) {
      result.supersededFilteredCount += 1;
      continue;
    }
    if (
      input.scope === "week" &&
      !memoryInDateRange(memory, input.dateRange)
    ) {
      result.dateFilteredCount! += 1;
      continue;
    }
    const owner = ownerDecision({
      query: input.query,
      memory,
      owner: input.ownersByMemoryId?.get(memory.id)
    });
    if (!owner.allowed) {
      result.ownerFilteredCount! += 1;
      if (owner.reason === "owner_conflict") result.ownerConflictFilteredCount += 1;
      else if (owner.reason === "owner_unverified") result.ownerUnverifiedFilteredCount += 1;
      else if (owner.reason === "owner_entity_not_evidenced") {
        result.ownerEntityMismatchFilteredCount! += 1;
      } else result.ownerUnknownFilteredCount += 1;
      continue;
    }
    result.memories.push(memory);
  }
  result.queryEligibleMemoryCount = result.memories.length;
  return result;
}

export function retrieveStructuredMemories(input: {
  question: string;
  scope: MemoryExpansionScope;
  dateRange?: MemoryScopeDateRange;
  memories: readonly MemoryItem[];
  ownersByMemoryId?: ReadonlyMap<string, MemoryOwnerMetadata>;
  limit?: number;
}) {
  const query = parseHybridQuery(input.question);
  const filtered = filterMemories({ ...input, query });
  const queryTokens = new Set(query.tokens);
  const candidates = filtered.memories
    .map((memory) => {
      const textTokens = meaningfulTextTokens(memoryText(memory));
      const shared = sharedTokenCount(queryTokens, textTokens);
      const lexical = queryTokens.size > 0 ? shared / queryTokens.size : 0;
      let typeSignal = 0;
      if (query.types.includes("preference") && memory.type === "preference") typeSignal = 1;
      if (
        query.types.includes("relationship") &&
        memory.type === "relationship_signal"
      ) typeSignal = 1;
      if (
        (query.types.includes("lifecycle") || query.types.includes("decision")) &&
        (memory.type === "event" || memory.type === "commitment")
      ) typeSignal = 1;
      const stateSignal =
        query.lifecycle.preferLatestState && memory.status === "resolved"
          ? 0.3
          : memory.status === "active"
            ? 0.1
            : 0;
      return {
        memory,
        score: lexical + typeSignal + stateSignal,
        reasons: [
          `lexical:${lexical.toFixed(4)}`,
          `type:${typeSignal.toFixed(2)}`,
          `state:${stateSignal.toFixed(2)}`
        ]
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.memory.lastSeenDate.localeCompare(left.memory.lastSeenDate) ||
      left.memory.id.localeCompare(right.memory.id)
    )
    .slice(0, Math.max(1, input.limit ?? 50))
    .map((candidate, index): MemoryRecallCandidate => ({
      ...candidate,
      rank: index + 1
    }));
  return { candidates, filtered };
}

export async function retrieveDenseMemories(input: {
  question: string;
  scope: MemoryExpansionScope;
  dateRange?: MemoryScopeDateRange;
  memories: readonly MemoryItem[];
  ownersByMemoryId?: ReadonlyMap<string, MemoryOwnerMetadata>;
  provider: EmbeddingProvider;
  index: SqliteEmbeddingIndex;
  limit?: number;
}) {
  if (!providerMatchesIndex(input.provider, input.index)) {
    throw new Error("embedding provider and memory sidecar model configuration must match");
  }
  const query = parseHybridQuery(input.question);
  const filtered = filterMemories({ ...input, query });
  if (input.scope === "current" || filtered.memories.length === 0) {
    return { candidates: [] as MemoryRecallCandidate[], filtered };
  }
  const [queryVector] = await input.provider.embed([
    memoryQuestionEmbeddingText(input.question)
  ]);
  if (!queryVector) throw new Error("embedding provider did not return a memory query vector");
  const memoryById = new Map(filtered.memories.map((memory) => [memory.id, memory]));
  const candidates = input.index.list("memory")
    .flatMap((entry) => {
      const memory = memoryById.get(entry.objectId);
      if (!memory) return [];
      if (entry.contentHash !== embeddingContentHash(memoryEmbeddingText(memory))) return [];
      return [{
        memory,
        score: cosineSimilarity(queryVector, entry.vector),
        reasons: ["memory_dense_cosine"]
      }];
    })
    .sort((left, right) =>
      right.score - left.score ||
      left.memory.id.localeCompare(right.memory.id)
    )
    .slice(0, Math.max(1, input.limit ?? 50))
    .map((candidate, index): MemoryRecallCandidate => ({
      ...candidate,
      rank: index + 1
    }));
  return { candidates, filtered };
}

function selectedMemories(input: {
  mode: MemoryExpansionMode;
  structured: readonly MemoryRecallCandidate[];
  dense: readonly MemoryRecallCandidate[];
  limit: number;
}) {
  if (input.mode === "structured") return input.structured.slice(0, input.limit);
  if (input.mode === "dense") return input.dense.slice(0, input.limit);
  const structuredById = new Map(input.structured.map((item) => [item.memory.id, item]));
  const denseById = new Map(input.dense.map((item) => [item.memory.id, item]));
  return reciprocalRankFusion({
    structured: input.structured.map((item) => ({ id: item.memory.id, rank: item.rank })),
    dense: input.dense.map((item) => ({ id: item.memory.id, rank: item.rank }))
  }, { limit: input.limit })
    .flatMap((item, index): MemoryRecallCandidate[] => {
      const source = structuredById.get(item.id) ?? denseById.get(item.id);
      return source
        ? [{
            ...source,
            rank: index + 1,
            score: item.score,
            reasons: [
              ...source.reasons,
              `memory_rrf:${item.score.toFixed(6)}`
            ]
          }]
        : [];
    });
}

function increment(result: Record<string, number>, key: string) {
  result[key] = (result[key] ?? 0) + 1;
}

export function expandMemoriesToCanonicalEvidence(input: {
  mode: MemoryExpansionMode;
  scope: MemoryExpansionScope;
  dateRange?: MemoryScopeDateRange;
  memoryLimit: number;
  structured: readonly MemoryRecallCandidate[];
  dense: readonly MemoryRecallCandidate[];
  canonicalEvidence: readonly QaRetrievedEvidence[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  filtered: FilteredMemoryResult;
  fallbackReason?: string;
}) {
  const limit = Math.max(1, Math.floor(input.memoryLimit));
  const ownerEntityMismatchFilteredCount =
    input.filtered.ownerEntityMismatchFilteredCount ?? 0;
  const ownerFilteredCount =
    input.filtered.ownerFilteredCount ??
    (
      input.filtered.ownerUnknownFilteredCount +
      input.filtered.ownerConflictFilteredCount +
      input.filtered.ownerUnverifiedFilteredCount +
      ownerEntityMismatchFilteredCount
    );
  const diagnostics: MemoryExpansionDiagnostics = {
    mode: input.mode,
    memoryLimit: limit,
    currentScopeDisabled: input.scope === "current",
    totalMemoryCount: input.filtered.totalMemoryCount ?? 0,
    queryEligibleMemoryCount:
      input.filtered.queryEligibleMemoryCount ?? input.filtered.memories.length,
    typeFilteredCount: input.filtered.typeFilteredCount ?? 0,
    scopeFilteredCount: input.filtered.scopeFilteredCount ?? 0,
    dateFilteredCount: input.filtered.dateFilteredCount ?? 0,
    retrievedMemoryCount: 0,
    successfullyMappedMemoryCount: 0,
    distinctMappedMemoryCount: 0,
    expandedCanonicalEvidenceCount: 0,
    unmappedMemoryCount: 0,
    distinctUnmappedMemoryCount: 0,
    mappedMemoryEvidenceCount: 0,
    unmappedMemoryEvidenceCount: 0,
    unmappedByReason: {},
    expiredFilteredCount: input.filtered.expiredFilteredCount,
    supersededFilteredCount: input.filtered.supersededFilteredCount,
    ownerFilteredCount,
    ownerUnknownFilteredCount: input.filtered.ownerUnknownFilteredCount,
    ownerConflictFilteredCount: input.filtered.ownerConflictFilteredCount,
    ownerUnverifiedFilteredCount: input.filtered.ownerUnverifiedFilteredCount,
    ownerEntityMismatchFilteredCount,
    scopeLeakageCount: 0,
    dateLeakageCount: 0,
    dateFilteredMemoryEvidenceCount: 0,
    rawExpansionCount: 0,
    deduplicatedExpansionCount: 0,
    candidateDuplicationCount: 0,
    finalCandidateDuplicateCount: 0,
    fallback: Boolean(input.fallbackReason),
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {})
  };
  if (diagnostics.currentScopeDisabled || diagnostics.fallback) {
    return { candidates: [] as MemoryExpansionCandidate[], diagnostics };
  }
  const selected = selectedMemories({
    mode: input.mode,
    structured: input.structured,
    dense: input.dense,
    limit
  });
  diagnostics.retrievedMemoryCount = selected.length;
  const canonicalById = new Map(
    input.canonicalEvidence.map((evidence) => [evidence.id, evidence])
  );
  const canonicalBySourceId = new Map<string, QaRetrievedEvidence[]>();
  for (const evidence of input.canonicalEvidence) {
    for (const sourceId of evidence.sourceSegmentIds) {
      const values = canonicalBySourceId.get(sourceId) ?? [];
      values.push(evidence);
      canonicalBySourceId.set(sourceId, values);
    }
  }
  const expanded = new Map<string, MemoryExpansionCandidate>();
  const mappedMemoryIds = new Set<string>();
  const unmappedMemoryIds = new Set<string>();
  const mappedMemoryEvidenceIds = new Set<string>();
  const unmappedMemoryEvidenceIds = new Set<string>();
  for (const recalled of selected) {
    let mappedMemory = false;
    for (const memoryEvidence of recalled.memory.evidence) {
      const memoryEvidenceKey = `${recalled.memory.id}\u0000${memoryEvidence.id}`;
      if (
        input.scope === "week" &&
        input.dateRange &&
        (
          memoryEvidence.date < input.dateRange.startDate ||
          memoryEvidence.date > input.dateRange.endDate
        )
      ) {
        diagnostics.dateFilteredMemoryEvidenceCount += 1;
        continue;
      }
      const direct = canonicalById.get(memoryEvidence.sourceId);
      const mapped = direct
        ? [direct]
        : canonicalBySourceId.get(memoryEvidence.sourceId) ?? [];
      if (mapped.length === 0) {
        unmappedMemoryEvidenceIds.add(memoryEvidenceKey);
        increment(diagnostics.unmappedByReason, "source_id_not_in_canonical_universe");
        continue;
      }
      let mappedMemoryEvidence = false;
      for (const evidence of mapped) {
        if (evidence.sourceSegmentIds.length === 0) {
          increment(diagnostics.unmappedByReason, "canonical_source_segments_empty");
          continue;
        }
        const recordingDate = input.metadata?.get(evidence.id)?.recordingDate;
        if (
          input.scope === "week" &&
          input.dateRange &&
          (
            !recordingDate ||
            recordingDate < input.dateRange.startDate ||
            recordingDate > input.dateRange.endDate
          )
        ) {
          diagnostics.dateLeakageCount += 1;
          continue;
        }
        mappedMemory = true;
        mappedMemoryEvidence = true;
        diagnostics.rawExpansionCount += 1;
        const existing = expanded.get(evidence.id);
        if (existing) {
          diagnostics.candidateDuplicationCount += 1;
          diagnostics.deduplicatedExpansionCount += 1;
          if (!existing.memoryIds.includes(recalled.memory.id)) {
            existing.memoryIds.push(recalled.memory.id);
          }
          if (!existing.mappingSourceIds.includes(memoryEvidence.sourceId)) {
            existing.mappingSourceIds.push(memoryEvidence.sourceId);
          }
          continue;
        }
        expanded.set(evidence.id, {
          evidence,
          score: 1 / (60 + recalled.rank),
          reasons: [
            `memory_mode:${input.mode}`,
            `memory_rank:${recalled.rank}`,
            `memory_type:${recalled.memory.type}`
          ],
          memoryIds: [recalled.memory.id],
          mappingSourceIds: [memoryEvidence.sourceId]
        });
      }
      if (mappedMemoryEvidence) {
        mappedMemoryEvidenceIds.add(memoryEvidenceKey);
        unmappedMemoryEvidenceIds.delete(memoryEvidenceKey);
      } else if (!mappedMemoryEvidenceIds.has(memoryEvidenceKey)) {
        unmappedMemoryEvidenceIds.add(memoryEvidenceKey);
      }
    }
    if (mappedMemory) {
      mappedMemoryIds.add(recalled.memory.id);
      unmappedMemoryIds.delete(recalled.memory.id);
    } else if (!mappedMemoryIds.has(recalled.memory.id)) {
      unmappedMemoryIds.add(recalled.memory.id);
    }
  }
  const candidates = [...expanded.values()]
    .sort((left, right) =>
      right.score - left.score ||
      right.evidence.priority - left.evidence.priority ||
      left.evidence.id.localeCompare(right.evidence.id)
    );
  diagnostics.distinctMappedMemoryCount = mappedMemoryIds.size;
  diagnostics.successfullyMappedMemoryCount = mappedMemoryIds.size;
  diagnostics.distinctUnmappedMemoryCount = unmappedMemoryIds.size;
  diagnostics.unmappedMemoryCount = unmappedMemoryIds.size;
  diagnostics.mappedMemoryEvidenceCount = mappedMemoryEvidenceIds.size;
  diagnostics.unmappedMemoryEvidenceCount = unmappedMemoryEvidenceIds.size;
  diagnostics.expandedCanonicalEvidenceCount = candidates.length;
  diagnostics.finalCandidateDuplicateCount =
    candidates.length - new Set(candidates.map((candidate) => candidate.evidence.id)).size;
  return { candidates, diagnostics };
}
