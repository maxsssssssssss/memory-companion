// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { retrieveMemoryIndexEvidence } from "./memory-index-evidence";
import type { MemoryItem, MemoryRepository } from "@/lib/server/memory/types";

function memory(input: {
  id: string;
  type: MemoryItem["type"];
  importanceScore: number;
  status?: MemoryItem["status"];
  occurrenceCount?: number;
  date?: string;
  withTranscript?: boolean;
}): MemoryItem {
  const date = input.date ?? "2026-07-08";
  const uploadId = `${input.id}_upload`;
  const evidence = [
    {
      id: `${input.id}_brief_evidence`,
      memoryId: input.id,
      sourceType: "brief" as const,
      sourceId: `${input.id}_brief`,
      uploadId,
      date,
      quote: `${input.id} structured evidence`,
      createdAt: `${date}T10:00:00.000Z`
    },
    ...(input.withTranscript === false
      ? []
      : [{
          id: `${input.id}_transcript_evidence`,
          memoryId: input.id,
          sourceType: "transcript" as const,
          sourceId: `${input.id}_segment`,
          uploadId,
          date,
          quote: `${input.id} original transcript`,
          createdAt: `${date}T10:00:00.000Z`
        }])
  ];

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
    occurrenceCount: input.occurrenceCount ?? 1,
    firstSeenDate: date,
    lastSeenDate: date,
    accessCount: 0,
    lastAccessedAt: null,
    date,
    createdAt: `${date}T10:00:00.000Z`,
    updatedAt: `${date}T10:00:00.000Z`,
    evidence
  };
}

function repository(memories: MemoryItem[]) {
  return {
    getRelevantMemories: vi.fn(() => memories)
  } as unknown as MemoryRepository;
}

describe("memory index QA evidence adapter", () => {
  it("does not load historical memory for current scope", () => {
    const memoryRepository = repository([memory({ id: "commitment_1", type: "commitment", importanceScore: 0.9 })]);

    const result = retrieveMemoryIndexEvidence({
      userId: "user_1",
      scope: "current",
      query: "这次有哪些明确承诺？",
      repository: memoryRepository
    });

    expect(result).toMatchObject({ scope: "current", memories: [], evidence: [], sourceIds: [], count: 0 });
    expect(memoryRepository.getRelevantMemories).not.toHaveBeenCalled();
  });

  it("returns high-value commitment memory and excludes low-value or untraceable items", () => {
    const memoryRepository = repository([
      memory({ id: "commitment_high", type: "commitment", importanceScore: 0.88, occurrenceCount: 2 }),
      memory({ id: "event_low", type: "event", importanceScore: 0.5 }),
      memory({ id: "commitment_untraceable", type: "commitment", importanceScore: 0.95, withTranscript: false })
    ]);

    const result = retrieveMemoryIndexEvidence({
      userId: "user_1",
      scope: "all",
      query: "之前答应过什么？",
      repository: memoryRepository
    });

    expect(result.memories.map((item) => item.id)).toEqual(["commitment_high"]);
    expect(result.sourceIds).toEqual(
      expect.arrayContaining(["commitment_high_brief", "commitment_high_segment"])
    );
    expect(result.evidence.every((item) => item.memoryId === "commitment_high")).toBe(true);
  });

  it("filters memory types for unresolved and relationship questions", () => {
    const memories = [
      memory({ id: "commitment_1", type: "commitment", importanceScore: 0.8 }),
      memory({ id: "question_1", type: "question", importanceScore: 0.8 }),
      memory({ id: "relationship_1", type: "relationship_signal", importanceScore: 0.8 })
    ];

    expect(
      retrieveMemoryIndexEvidence({
        userId: "user_1",
        scope: "all",
        query: "过去有哪些未解决的问题？",
        repository: repository(memories)
      }).memories.map((item) => item.type)
    ).toEqual(["question"]);

    expect(
      retrieveMemoryIndexEvidence({
        userId: "user_1",
        scope: "all",
        query: "有没有重复出现的关系信号？",
        repository: repository(memories)
      }).memories.map((item) => item.type)
    ).toEqual(["relationship_signal"]);
  });

  it("prioritizes active and repeated memory ahead of resolved memory", () => {
    const memoryRepository = repository([
      memory({ id: "resolved", type: "commitment", importanceScore: 0.92, status: "resolved" }),
      memory({ id: "active", type: "commitment", importanceScore: 0.82, status: "active", occurrenceCount: 2 })
    ]);

    const result = retrieveMemoryIndexEvidence({
      userId: "user_1",
      scope: "all",
      query: "过去有哪些承诺？",
      repository: memoryRepository
    });

    expect(result.memories.map((item) => item.id)).toEqual(["active", "resolved"]);
  });

  it("passes week date range and bounds generic queries to three memories", () => {
    const memoryRepository = repository(
      Array.from({ length: 6 }, (_, index) =>
        memory({ id: `memory_${index}`, type: "event", importanceScore: 0.9 - index * 0.01 })
      )
    );

    const result = retrieveMemoryIndexEvidence({
      userId: "user_1",
      scope: "week",
      query: "有什么值得回看的内容？",
      dateRange: { startDate: "2026-07-06", endDate: "2026-07-12" },
      repository: memoryRepository
    });

    expect(result.memories).toHaveLength(3);
    expect(memoryRepository.getRelevantMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        startDate: "2026-07-06",
        endDate: "2026-07-12"
      })
    );
  });

  it("uses a relaxed week threshold while preserving the strict all-memory threshold", () => {
    const recent = memory({
      id: "recent_question",
      type: "question",
      importanceScore: 0.4,
      status: "active",
      date: "2026-07-10"
    });

    const week = retrieveMemoryIndexEvidence({
      userId: "user_1",
      scope: "week",
      query: "本周有哪些未解决的问题？",
      dateRange: { startDate: "2026-07-06", endDate: "2026-07-12" },
      repository: repository([recent])
    });
    const all = retrieveMemoryIndexEvidence({
      userId: "user_1",
      scope: "all",
      query: "过去有哪些未解决的问题？",
      repository: repository([recent])
    });

    expect(week.memories.map((item) => item.id)).toEqual(["recent_question"]);
    expect(all.memories).toEqual([]);
  });

  it("prioritizes an active week commitment ahead of a resolved item", () => {
    const result = retrieveMemoryIndexEvidence({
      userId: "user_1",
      scope: "week",
      query: "本周有哪些承诺？",
      dateRange: { startDate: "2026-07-06", endDate: "2026-07-12" },
      repository: repository([
        memory({ id: "resolved_high", type: "commitment", importanceScore: 0.9, status: "resolved" }),
        memory({ id: "active_recent", type: "commitment", importanceScore: 0.4, status: "active" })
      ])
    });

    expect(result.memories.map((item) => item.id)).toEqual(["active_recent", "resolved_high"]);
  });
});
