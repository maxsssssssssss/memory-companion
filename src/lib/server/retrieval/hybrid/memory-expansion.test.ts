import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryItem } from "@/lib/server/memory/types";
import type { MemoryOwnerMetadata } from "@/lib/server/memory/owner-attribution/types";
import type { QaRetrievedEvidence } from "../ai-qa";
import type { EmbeddingProvider } from "./embedding-provider";
import { SqliteEmbeddingIndex } from "./embedding-index";
import { generateHybridCandidatesWithDiagnostics } from "./hybrid-candidates";
import {
  expandMemoriesToCanonicalEvidence,
  indexMemoryItems,
  retrieveDenseMemories,
  retrieveStructuredMemories
} from "./memory-expansion";

function memory(
  id: string,
  sourceId: string,
  overrides: Partial<MemoryItem> = {}
): MemoryItem {
  return {
    id,
    userId: "user-1",
    type: "event",
    title: "博物馆计划",
    summary: "博物馆计划后来已经完成",
    importance: 0.8,
    importanceScore: 0.8,
    importanceReasons: ["test"],
    status: "resolved",
    occurrenceCount: 1,
    firstSeenDate: "2026-07-08",
    lastSeenDate: "2026-07-08",
    accessCount: 0,
    lastAccessedAt: null,
    date: "2026-07-08",
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    evidence: [{
      id: `memory-evidence-${id}`,
      memoryId: id,
      sourceType: "transcript",
      sourceId,
      uploadId: "upload-1",
      date: "2026-07-08",
      quote: "今天终于去了博物馆，计划落实了。",
      createdAt: "2026-07-08T00:00:00.000Z"
    }],
    ...overrides
  };
}

function evidence(id = "canonical-1"): QaRetrievedEvidence {
  return {
    id,
    kind: "raw",
    title: "博物馆",
    text: "今天终于去了博物馆，计划落实了。",
    startSeconds: 10,
    endSeconds: 20,
    sourceSegmentIds: ["segment-1"],
    priority: 3
  };
}

function owner(
  memoryId: string,
  type: "known_identity" | "local_speaker" | "unknown"
): MemoryOwnerMetadata {
  const unknown = type === "unknown";
  return {
    version: 1,
    memoryId,
    memoryType: "preference",
    scope: unknown ? "unknown" : "individual",
    owner: unknown
      ? { type: "unknown", confidence: 0, source: "unknown" }
      : {
          type,
          identityId: type === "known_identity" ? "person-1" : "speaker_1",
          confidence: 0.99,
          source: type === "known_identity" ? "speaker_identity" : "explicit_statement"
        },
    participants: [],
    evidenceSegmentIds: ["segment-1"],
    reasons: [unknown ? "no_trusted_identity" : "explicit_owner"]
  };
}

function filtered() {
  return {
    memories: [],
    totalMemoryCount: 0,
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
}

describe("Phase 5 Memory expansion", () => {
  it("maps Memory sourceId to the original Canonical Evidence without mutation", () => {
    const canonical = evidence();
    const recalled = [
      {
        memory: memory("memory-1", "segment-1"),
        rank: 1,
        score: 1,
        reasons: ["test"]
      },
      {
        memory: memory("memory-direct", "canonical-1"),
        rank: 2,
        score: 0.9,
        reasons: ["test"]
      }
    ];
    const result = expandMemoriesToCanonicalEvidence({
      mode: "structured",
      scope: "all",
      memoryLimit: 3,
      structured: recalled,
      dense: [],
      canonicalEvidence: [canonical],
      filtered: filtered()
    });

    expect(result.candidates[0]?.evidence).toBe(canonical);
    expect(result.candidates[0]?.evidence.sourceSegmentIds).toEqual(["segment-1"]);
    expect(result.candidates[0]?.memoryIds).toEqual(["memory-1", "memory-direct"]);
    expect(result.diagnostics.successfullyMappedMemoryCount).toBe(2);
  });

  it("discards unmapped Memory and deduplicates repeated canonical mappings", () => {
    const recalled = [
      {
        memory: memory("mapped", "segment-1"),
        rank: 1,
        score: 1,
        reasons: ["test"]
      },
      {
        memory: memory("duplicate", "segment-1"),
        rank: 2,
        score: 0.9,
        reasons: ["test"]
      },
      {
        memory: memory("unmapped", "missing-segment"),
        rank: 3,
        score: 0.8,
        reasons: ["test"]
      }
    ];
    const result = expandMemoriesToCanonicalEvidence({
      mode: "structured",
      scope: "all",
      memoryLimit: 10,
      structured: recalled,
      dense: [],
      canonicalEvidence: [evidence()],
      filtered: filtered()
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.memoryIds).toEqual(["mapped", "duplicate"]);
    expect(result.diagnostics.unmappedMemoryCount).toBe(1);
    expect(result.diagnostics.distinctMappedMemoryCount).toBe(2);
    expect(result.diagnostics.distinctUnmappedMemoryCount).toBe(1);
    expect(result.diagnostics.mappedMemoryEvidenceCount).toBe(2);
    expect(result.diagnostics.unmappedMemoryEvidenceCount).toBe(1);
    expect(result.diagnostics.rawExpansionCount).toBe(2);
    expect(result.diagnostics.deduplicatedExpansionCount).toBe(1);
    expect(result.diagnostics.candidateDuplicationCount).toBe(1);
    expect(result.diagnostics.finalCandidateDuplicateCount).toBe(0);
  });

  it("disables current scope and prevents week date leakage", () => {
    const mixedDateMemory = memory("memory-1", "segment-1");
    mixedDateMemory.evidence.push({
      ...mixedDateMemory.evidence[0]!,
      id: "memory-evidence-outside-week",
      date: "2026-07-01"
    });
    const recalled = [{
      memory: mixedDateMemory,
      rank: 1,
      score: 1,
      reasons: ["test"]
    }];
    const current = expandMemoriesToCanonicalEvidence({
      mode: "structured",
      scope: "current",
      memoryLimit: 3,
      structured: recalled,
      dense: [],
      canonicalEvidence: [evidence()],
      filtered: filtered()
    });
    const week = expandMemoriesToCanonicalEvidence({
      mode: "structured",
      scope: "week",
      dateRange: { startDate: "2026-07-06", endDate: "2026-07-12" },
      memoryLimit: 3,
      structured: recalled,
      dense: [],
      canonicalEvidence: [evidence()],
      metadata: new Map([["canonical-1", { recordingDate: "2026-07-01" }]]),
      filtered: filtered()
    });

    expect(current.candidates).toEqual([]);
    expect(current.diagnostics.currentScopeDisabled).toBe(true);
    expect(week.candidates).toEqual([]);
    expect(week.diagnostics.dateLeakageCount).toBe(1);
    expect(week.diagnostics.dateFilteredMemoryEvidenceCount).toBe(1);
  });

  it("filters expired, superseded, unknown, and local-speaker owners", () => {
    const memories = [
      memory("expired", "segment-1", { type: "preference", status: "expired" }),
      memory("superseded", "segment-1", { type: "preference", status: "superseded" }),
      memory("unknown", "segment-1", { type: "preference" }),
      memory("local", "segment-1", { type: "preference" }),
      memory("verified", "segment-1", {
        type: "preference",
        title: "Alice 的偏好",
        summary: "Alice 长期喜欢安静的咖啡馆"
      })
    ];
    const result = retrieveStructuredMemories({
      question: "Alice 长期喜欢什么？",
      scope: "all",
      memories,
      ownersByMemoryId: new Map([
        ["unknown", owner("unknown", "unknown")],
        ["local", owner("local", "local_speaker")],
        ["verified", owner("verified", "known_identity")]
      ])
    });

    expect(result.candidates.map((item) => item.memory.id)).toEqual(["verified"]);
    expect(result.filtered.expiredFilteredCount).toBe(1);
    expect(result.filtered.supersededFilteredCount).toBe(1);
    expect(result.filtered.ownerUnknownFilteredCount).toBe(1);
    expect(result.filtered.ownerUnverifiedFilteredCount).toBe(1);
  });

  it("reports exclusive type, date, owner, and query-eligible Memory counts", () => {
    const outsideWeekBase = memory("outside-week", "segment-1", {
      type: "preference"
    });
    const outsideWeek = {
      ...outsideWeekBase,
      evidence: outsideWeekBase.evidence.map((item) => ({
        ...item,
        date: "2026-06-01"
      }))
    };
    const conflictingOwner: MemoryOwnerMetadata = {
      ...owner("conflict", "known_identity"),
      scope: "unknown",
      participants: [{
        role: "owner",
        attribution: {
          type: "known_identity",
          identityId: "person-2",
          confidence: 0.99,
          source: "manual_mapping"
        },
        evidenceSegmentIds: ["segment-1"]
      }]
    };
    const memories = [
      memory("irrelevant-type", "segment-1", { type: "summary" }),
      memory("expired", "segment-1", { type: "preference", status: "expired" }),
      memory("superseded", "segment-1", {
        type: "preference",
        status: "superseded"
      }),
      outsideWeek,
      memory("unknown", "segment-1", { type: "preference" }),
      memory("local", "segment-1", { type: "preference" }),
      memory("conflict", "segment-1", { type: "preference" }),
      memory("entity-mismatch", "segment-1", {
        type: "preference",
        title: "Bob preference",
        summary: "Bob prefers quiet cafes"
      }),
      memory("eligible", "segment-1", {
        type: "preference",
        title: "Alice preference",
        summary: "Alice prefers quiet cafes"
      })
    ];
    const result = retrieveStructuredMemories({
      question: "What does Alice prefer?",
      scope: "week",
      dateRange: { startDate: "2026-07-06", endDate: "2026-07-12" },
      memories,
      ownersByMemoryId: new Map([
        ["outside-week", owner("outside-week", "known_identity")],
        ["local", owner("local", "local_speaker")],
        ["conflict", conflictingOwner],
        ["entity-mismatch", owner("entity-mismatch", "known_identity")],
        ["eligible", owner("eligible", "known_identity")]
      ])
    });

    expect(result.filtered.totalMemoryCount).toBe(9);
    expect(result.filtered.queryEligibleMemoryCount).toBe(1);
    expect(result.filtered.typeFilteredCount).toBe(1);
    expect(result.filtered.dateFilteredCount).toBe(1);
    expect(result.filtered.expiredFilteredCount).toBe(1);
    expect(result.filtered.supersededFilteredCount).toBe(1);
    expect(result.filtered.ownerFilteredCount).toBe(4);
    expect(result.filtered.ownerUnknownFilteredCount).toBe(1);
    expect(result.filtered.ownerUnverifiedFilteredCount).toBe(1);
    expect(result.filtered.ownerConflictFilteredCount).toBe(1);
    expect(result.filtered.ownerEntityMismatchFilteredCount).toBe(1);
    expect(result.filtered.memories.map((item) => item.id)).toEqual(["eligible"]);

    const expansion = expandMemoriesToCanonicalEvidence({
      mode: "structured",
      scope: "week",
      dateRange: { startDate: "2026-07-06", endDate: "2026-07-12" },
      memoryLimit: 3,
      structured: result.candidates,
      dense: [],
      canonicalEvidence: [evidence()],
      metadata: new Map([["canonical-1", { recordingDate: "2026-07-08" }]]),
      filtered: result.filtered
    });
    expect(expansion.diagnostics.totalMemoryCount).toBe(9);
    expect(expansion.diagnostics.queryEligibleMemoryCount).toBe(1);
    expect(expansion.diagnostics.typeFilteredCount).toBe(1);
    expect(expansion.diagnostics.dateFilteredCount).toBe(1);
    expect(expansion.diagnostics.ownerFilteredCount).toBe(4);
  });

  it("reports every loaded Memory as scope-filtered when current expansion is disabled", () => {
    const recall = retrieveStructuredMemories({
      question: "What decision did I make?",
      scope: "current",
      memories: [
        memory("event", "segment-1"),
        memory("summary", "segment-1", { type: "summary" })
      ]
    });
    const expansion = expandMemoriesToCanonicalEvidence({
      mode: "structured",
      scope: "current",
      memoryLimit: 3,
      structured: recall.candidates,
      dense: [],
      canonicalEvidence: [evidence()],
      filtered: recall.filtered
    });

    expect(recall.filtered.totalMemoryCount).toBe(2);
    expect(recall.filtered.queryEligibleMemoryCount).toBe(0);
    expect(recall.filtered.scopeFilteredCount).toBe(2);
    expect(expansion.candidates).toEqual([]);
    expect(expansion.diagnostics.currentScopeDisabled).toBe(true);
    expect(expansion.diagnostics.totalMemoryCount).toBe(2);
    expect(expansion.diagnostics.queryEligibleMemoryCount).toBe(0);
    expect(expansion.diagnostics.scopeFilteredCount).toBe(2);
  });

  it("fails closed when owner metadata contains conflicting verified identities", () => {
    const item = memory("conflict", "segment-1", {
      type: "preference",
      title: "Alice 的偏好",
      summary: "Alice 长期喜欢安静的咖啡馆"
    });
    const conflictingOwner: MemoryOwnerMetadata = {
      ...owner("conflict", "known_identity"),
      scope: "unknown",
      participants: [{
        role: "owner",
        attribution: {
          type: "known_identity",
          identityId: "person-2",
          confidence: 0.99,
          source: "manual_mapping"
        },
        evidenceSegmentIds: ["segment-1"]
      }]
    };
    const result = retrieveStructuredMemories({
      question: "Alice 长期喜欢什么？",
      scope: "all",
      memories: [item],
      ownersByMemoryId: new Map([["conflict", conflictingOwner]])
    });

    expect(result.candidates).toEqual([]);
    expect(result.filtered.ownerConflictFilteredCount).toBe(1);
  });

  it("falls back to no Memory candidates on dense service failure", () => {
    const result = expandMemoriesToCanonicalEvidence({
      mode: "dense",
      scope: "all",
      memoryLimit: 6,
      structured: [],
      dense: [],
      canonicalEvidence: [evidence()],
      filtered: filtered(),
      fallbackReason: "service unavailable"
    });

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.fallback).toBe(true);
  });

  it("preserves Hybrid order when a failed dense Memory service yields no candidates", () => {
    const canonical = [evidence("canonical-1"), evidence("canonical-2")];
    const input = {
      question: "Alice 和我的关系是什么？",
      evidence: canonical,
      currentCandidates: canonical,
      denseCandidates: [
        { evidence: canonical[1], score: 0.9, rank: 1 },
        { evidence: canonical[0], score: 0.8, rank: 2 }
      ],
      limit: 30,
      strategy: "uniform_rrf" as const
    };

    const baseline = generateHybridCandidatesWithDiagnostics(input);
    const fallback = generateHybridCandidatesWithDiagnostics({
      ...input,
      memoryCandidates: []
    });

    expect(fallback.candidates.map((candidate) => candidate.evidence.id)).toEqual(
      baseline.candidates.map((candidate) => candidate.evidence.id)
    );
  });

  it("isolates Memory vectors by revision and invalidates changed content hashes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memory-expansion-")), "index.sqlite");
    const vector = (hotIndex: number) =>
      Array.from({ length: 1_024 }, (_, index) => index === hotIndex ? 1 : 0);
    const provider = (version: string): EmbeddingProvider => ({
      config: { modelName: "test-memory-model", modelVersion: version, dimension: 1_024 },
      embed: async (texts) => texts.map((text) =>
        text.includes("changed") ? vector(1) : vector(0)
      )
    });
    const v1 = new SqliteEmbeddingIndex(path, provider("v1").config);
    const item = memory("memory-indexed", "segment-1");
    const first = await indexMemoryItems({
      memories: [item],
      provider: provider("v1"),
      index: v1
    });
    const reused = await indexMemoryItems({
      memories: [item],
      provider: provider("v1"),
      index: v1
    });
    const changed = await indexMemoryItems({
      memories: [{ ...item, summary: "changed" }],
      provider: provider("v1"),
      index: v1
    });
    expect(first.embedded).toBe(1);
    expect(reused.unchanged).toBe(1);
    expect(changed.embedded).toBe(1);
    v1.close();

    const v2 = new SqliteEmbeddingIndex(path, provider("v2").config);
    expect(v2.list("memory")).toEqual([]);
    v2.close();
  });

  it("does not turn Memory into citation evidence during dense recall", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memory-dense-")), "index.sqlite");
    const provider: EmbeddingProvider = {
      config: {
        modelName: "test-memory-model",
        modelVersion: "v1",
        dimension: 1_024
      },
      embed: async (texts) => texts.map(() =>
        Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      )
    };
    const index = new SqliteEmbeddingIndex(path, provider.config);
    const item = memory("memory-1", "segment-1");
    await indexMemoryItems({ memories: [item], provider, index });
    const dense = await retrieveDenseMemories({
      question: "博物馆后来完成了吗？",
      scope: "all",
      memories: [item],
      provider,
      index
    });
    const expanded = expandMemoriesToCanonicalEvidence({
      mode: "dense",
      scope: "all",
      memoryLimit: 3,
      structured: [],
      dense: dense.candidates,
      canonicalEvidence: [evidence()],
      filtered: dense.filtered
    });

    expect(expanded.candidates[0]?.evidence.id).toBe("canonical-1");
    expect(expanded.candidates.some((item) => item.evidence.id === "memory-1")).toBe(false);
    index.close();
  });
});
