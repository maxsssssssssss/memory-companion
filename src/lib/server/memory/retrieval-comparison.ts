import type { MemoryShadowRetrievalResult, MemoryShadowScope } from "./shadow-retrieval";

export type JsonRetrievalEvidence = {
  id: string;
  kind: string;
  title: string;
  text: string;
  sourceSegmentIds: string[];
};

export type RetrievalComparison = {
  query: string;
  scope: MemoryShadowScope;
  jsonEvidenceCount: number;
  memoryCount: number;
  memoryEvidenceCount: number;
  overlapCount: number;
  onlyMemory: string[];
  onlyJson: string[];
  jsonSourceTypes: Record<string, number>;
  memoryTypes: Record<string, number>;
  memoryEvidenceSourceTypes: Record<string, number>;
  jsonDates: string[];
  memoryDates: string[];
  latency: {
    jsonMs: number;
    sqliteMs: number;
  };
};

function countValues(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort();
}

function datesFromJsonEvidence(evidence: JsonRetrievalEvidence[]) {
  return sortedUnique(
    evidence.flatMap((item) => `${item.title}\n${item.text}`.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])
  );
}

export function compareRetrievalSources(input: {
  query: string;
  scope: MemoryShadowScope;
  jsonEvidence: JsonRetrievalEvidence[];
  jsonRetrievalTimeMs: number;
  memoryResult: MemoryShadowRetrievalResult;
}): RetrievalComparison {
  const jsonSourceIds = new Set(
    input.jsonEvidence.flatMap((item) => [item.id, ...item.sourceSegmentIds])
  );
  const memorySourceIds = new Set(input.memoryResult.evidence.map((evidence) => evidence.sourceId));
  const overlap = [...memorySourceIds].filter((sourceId) => jsonSourceIds.has(sourceId));

  return {
    query: input.query,
    scope: input.scope,
    jsonEvidenceCount: input.jsonEvidence.length,
    memoryCount: input.memoryResult.count,
    memoryEvidenceCount: input.memoryResult.evidence.length,
    overlapCount: overlap.length,
    onlyMemory: [...memorySourceIds].filter((sourceId) => !jsonSourceIds.has(sourceId)).sort(),
    onlyJson: [...jsonSourceIds].filter((sourceId) => !memorySourceIds.has(sourceId)).sort(),
    jsonSourceTypes: countValues(input.jsonEvidence.map((item) => item.kind)),
    memoryTypes: countValues(input.memoryResult.memories.map((memory) => memory.type)),
    memoryEvidenceSourceTypes: countValues(input.memoryResult.evidence.map((evidence) => evidence.sourceType)),
    jsonDates: datesFromJsonEvidence(input.jsonEvidence),
    memoryDates: sortedUnique([
      ...input.memoryResult.memories.map((memory) => memory.date),
      ...input.memoryResult.evidence.map((evidence) => evidence.date)
    ]),
    latency: {
      jsonMs: Math.max(0, input.jsonRetrievalTimeMs),
      sqliteMs: Math.max(0, input.memoryResult.retrievalTimeMs)
    }
  };
}

function compactQuery(query: string) {
  const compacted = query.replace(/\s+/g, " ").trim();
  return compacted.length <= 120 ? compacted : `${compacted.slice(0, 119)}…`;
}

export function logRetrievalComparison(comparison: RetrievalComparison) {
  console.info(
    `[memory-shadow] scope=${comparison.scope} query=${JSON.stringify(compactQuery(comparison.query))} ` +
      `json_evidence=${comparison.jsonEvidenceCount} sqlite_memories=${comparison.memoryCount} ` +
      `sqlite_evidence=${comparison.memoryEvidenceCount} overlap=${comparison.overlapCount} ` +
      `latency_json=${comparison.latency.jsonMs}ms latency_sqlite=${comparison.latency.sqliteMs}ms ` +
      `memory_empty=${comparison.memoryCount === 0}`
  );
}
