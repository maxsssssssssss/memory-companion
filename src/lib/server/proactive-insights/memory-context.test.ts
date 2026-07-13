// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { MemoryItem, MemoryRelation, MemoryRepository } from "@/lib/server/memory/types";

import {
  buildProactiveInsightMemoryContext,
  combineProactiveInsightSourceFingerprint
} from "./memory-context";

function memory(input: {
  id: string;
  type: MemoryItem["type"];
  importanceScore: number;
  status?: MemoryItem["status"];
  occurrenceCount?: number;
  dates?: string[];
  uploadIds?: string[];
  withTranscript?: boolean;
}): MemoryItem {
  const dates = input.dates ?? ["2026-07-08"];
  const uploadIds = input.uploadIds ?? dates.map((_, index) => `upload_history_${index + 1}`);
  const evidence = dates.flatMap((date, index) => {
    const uploadId = uploadIds[index] ?? uploadIds[0] ?? "upload_history";
    return [
      ...(input.withTranscript === false
        ? []
        : [{
            id: `${input.id}_transcript_${index}`,
            memoryId: input.id,
            sourceType: "transcript" as const,
            sourceId: `${input.id}_segment_${index}`,
            uploadId,
            date,
            quote: `${input.id} transcript evidence ${index}`,
            createdAt: `${date}T10:00:00.000Z`
          }]),
      {
        id: `${input.id}_brief_${index}`,
        memoryId: input.id,
        sourceType: "brief" as const,
        sourceId: `${input.id}_brief_source_${index}`,
        uploadId,
        date,
        quote: `${input.id} brief evidence ${index}`,
        createdAt: `${date}T10:00:00.000Z`
      }
    ];
  });

  return {
    id: input.id,
    userId: "user_1",
    type: input.type,
    title: `${input.type} ${input.id}`,
    summary: `${input.id} summary`,
    importance: input.importanceScore,
    importanceScore: input.importanceScore,
    importanceReasons: [`${input.type} type`],
    status: input.status ?? "active",
    occurrenceCount: input.occurrenceCount ?? uploadIds.length,
    firstSeenDate: dates[0] ?? "2026-07-08",
    lastSeenDate: dates.at(-1) ?? "2026-07-08",
    accessCount: 0,
    lastAccessedAt: null,
    date: dates.at(-1) ?? "2026-07-08",
    createdAt: `${dates[0] ?? "2026-07-08"}T10:00:00.000Z`,
    updatedAt: `${dates.at(-1) ?? "2026-07-08"}T10:00:00.000Z`,
    evidence
  };
}

function repository(memories: MemoryItem[], relations: MemoryRelation[] = []) {
  return {
    getRelevantMemories: vi.fn(() => memories),
    getMemoryRelations: vi.fn(() => relations)
  } as unknown as Pick<MemoryRepository, "getRelevantMemories" | "getMemoryRelations">;
}

describe("proactive insight memory context", () => {
  it("selects active high-value traceable history and excludes current-only or unsafe memory", () => {
    const memoryRepository = repository([
      memory({ id: "commitment_active", type: "commitment", importanceScore: 0.9 }),
      memory({ id: "question_resolved", type: "question", importanceScore: 0.95, status: "resolved" }),
      memory({ id: "relationship_low", type: "relationship_signal", importanceScore: 0.59 }),
      memory({ id: "preference_untraceable", type: "preference", importanceScore: 0.88, withTranscript: false }),
      memory({
        id: "event_current_only",
        type: "event",
        importanceScore: 0.86,
        occurrenceCount: 2,
        uploadIds: ["upload_current"]
      })
    ]);

    const result = buildProactiveInsightMemoryContext({
      userId: "user_1",
      scope: "current",
      currentUploadId: "upload_current",
      repository: memoryRepository
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      evidenceId: "memory:commitment_active",
      memoryId: "commitment_active",
      type: "commitment",
      importanceScore: 0.9,
      confidence: "high",
      dates: ["2026-07-08"]
    });
    expect(result.memories[0]?.evidence).toEqual([
      expect.objectContaining({
        sourceType: "transcript",
        sourceId: "commitment_active_segment_0",
        uploadId: "upload_history_1",
        recordingDate: "2026-07-08"
      })
    ]);
    expect(memoryRepository.getRelevantMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        types: ["commitment", "question", "relationship_signal", "preference", "event"]
      })
    );
  });

  it("orders memory by product priority and only keeps repeated events", () => {
    const result = buildProactiveInsightMemoryContext({
      userId: "user_1",
      scope: "current",
      currentUploadId: "upload_current",
      repository: repository([
        memory({ id: "event_once", type: "event", importanceScore: 0.99, occurrenceCount: 1 }),
        memory({ id: "event_repeated", type: "event", importanceScore: 0.9, occurrenceCount: 2 }),
        memory({ id: "preference", type: "preference", importanceScore: 0.8 }),
        memory({ id: "relationship", type: "relationship_signal", importanceScore: 0.8 }),
        memory({ id: "question", type: "question", importanceScore: 0.8 }),
        memory({ id: "commitment", type: "commitment", importanceScore: 0.8 })
      ])
    });

    expect(result.memories.map((item) => item.memoryId)).toEqual([
      "question",
      "commitment",
      "relationship",
      "preference",
      "event_repeated"
    ]);
  });

  it("prioritizes lifecycle memory, includes repeated memory, and exposes traceable relations", () => {
    const memories = [
      memory({ id: "question_active", type: "question", importanceScore: 0.74 }),
      memory({ id: "commitment_active", type: "commitment", importanceScore: 0.78 }),
      memory({ id: "relationship", type: "relationship_signal", importanceScore: 0.82 }),
      memory({ id: "repeated_preference", type: "preference", importanceScore: 0.7, occurrenceCount: 3 }),
      memory({ id: "event_resolved", type: "event", importanceScore: 0.9, status: "resolved" })
    ];
    const relations: MemoryRelation[] = [
      {
        id: "relation_follow_up",
        sourceMemoryId: "question_active",
        targetMemoryId: "commitment_active",
        relationType: "follow_up",
        confidence: 0.83,
        createdAt: "2026-07-09T10:00:00.000Z"
      }
    ];

    const result = buildProactiveInsightMemoryContext({
      userId: "user_1",
      scope: "current",
      currentUploadId: "upload_current",
      repository: repository(memories, relations)
    });

    expect(result.memories.map((item) => item.memoryId)).toEqual([
      "question_active",
      "commitment_active",
      "relationship",
      "repeated_preference"
    ]);
    expect(result.memories.map((item) => item.lifecycleKind)).toEqual([
      "unresolved_question",
      "active_commitment",
      "relationship_signal",
      "repeated_memory"
    ]);
    expect(result.relations).toEqual([
      expect.objectContaining({
        relationId: "relation_follow_up",
        relationType: "follow_up",
        sourceMemoryRef: "memory:question_active",
        targetMemoryRef: "memory:commitment_active"
      })
    ]);
  });

  it("caps relevance candidates at twenty, caps relations at ten, and includes both in the cache fingerprint", () => {
    const relations = Array.from({ length: 12 }, (_, index): MemoryRelation => ({
      id: `relation_${index}`,
      sourceMemoryId: `commitment_${index}`,
      targetMemoryId: `commitment_${index + 1}`,
      relationType: "related",
      confidence: 0.7,
      createdAt: "2026-07-09T10:00:00.000Z"
    }));
    const result = buildProactiveInsightMemoryContext({
      userId: "user_1",
      scope: "current",
      currentUploadId: "upload_current",
      repository: repository(
        Array.from({ length: 22 }, (_, index) =>
          memory({ id: `commitment_${index}`, type: "commitment", importanceScore: 0.9 - index * 0.01 })
        ),
        relations
      )
    });

    expect(result.memories).toHaveLength(20);
    expect(result.relations).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(combineProactiveInsightSourceFingerprint("current-fingerprint", result)).not.toBe(
      "current-fingerprint"
    );
    expect(
      combineProactiveInsightSourceFingerprint("current-fingerprint", {
        ...result,
        memories: [],
        relations: [],
        truncated: false
      })
    ).toBe("current-fingerprint");
  });
});
