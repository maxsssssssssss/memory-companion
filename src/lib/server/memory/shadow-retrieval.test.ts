// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";
import {
  inferMemoryTypesForQuery,
  observeMemoryShadowRetrieval,
  retrieveMemoryShadow
} from "./shadow-retrieval";
import type { MemoryRepository, MemoryWriteInput } from "./types";

let database: Database.Database | undefined;

function memoryFixture(input: {
  id: string;
  type: MemoryWriteInput["type"];
  date: string;
  uploadId: string;
  importance?: number;
}): MemoryWriteInput {
  return {
    id: input.id,
    type: input.type,
    title: `${input.type} memory`,
    summary: `Summary for ${input.id}`,
    importance: input.importance ?? 0.75,
    date: input.date,
    createdAt: `${input.date}T10:00:00.000Z`,
    updatedAt: `${input.date}T10:00:00.000Z`,
    evidence: [
      {
        id: `${input.id}_structured`,
        sourceType: input.type === "relationship_signal" ? "relationship_signal" : "brief",
        sourceId: `${input.id}_source`,
        uploadId: input.uploadId,
        date: input.date,
        quote: "Structured evidence",
        createdAt: `${input.date}T10:00:00.000Z`
      },
      {
        id: `${input.id}_transcript`,
        sourceType: "transcript",
        sourceId: `${input.id}_segment`,
        uploadId: input.uploadId,
        date: input.date,
        quote: "Original transcript evidence",
        createdAt: `${input.date}T10:00:00.000Z`
      }
    ]
  };
}

afterEach(() => {
  database?.close();
  database = undefined;
  vi.restoreAllMocks();
});

describe("memory shadow retrieval", () => {
  it("maps commitment and unresolved-question queries to memory types", () => {
    expect(inferMemoryTypesForQuery("之前有哪些明确承诺需要回看？")).toEqual(["commitment"]);
    expect(inferMemoryTypesForQuery("本周有哪些还没解决的问题？")).toEqual(["question"]);
  });

  it("filters by user, memory type, importance and returns traceable evidence", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [
        memoryFixture({ id: "commitment_high", type: "commitment", date: "2026-07-08", uploadId: "upload_1" }),
        memoryFixture({ id: "commitment_low", type: "commitment", date: "2026-07-08", uploadId: "upload_1", importance: 0.2 }),
        memoryFixture({ id: "question_1", type: "question", date: "2026-07-08", uploadId: "upload_1" })
      ]
    });
    repository.replaceUploadMemories({
      userId: "user_2",
      uploadId: "upload_2",
      memories: [memoryFixture({ id: "other_user", type: "commitment", date: "2026-07-08", uploadId: "upload_2" })]
    });

    const result = retrieveMemoryShadow({
      userId: "user_1",
      scope: "all",
      query: "之前有哪些明确承诺需要回看？",
      repository
    });

    expect(result.count).toBe(1);
    expect(result.memories.map((memory) => memory.id)).toEqual(["commitment_high"]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uploadId: "upload_1", date: "2026-07-08" }),
        expect.objectContaining({ sourceType: "transcript", sourceId: "commitment_high_segment" })
      ])
    );
    expect(result.retrievalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("applies the week date range and returns question memories only", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_old",
      memories: [memoryFixture({ id: "question_old", type: "question", date: "2026-06-30", uploadId: "upload_old" })]
    });
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_week",
      memories: [memoryFixture({ id: "question_week", type: "question", date: "2026-07-08", uploadId: "upload_week" })]
    });

    const result = retrieveMemoryShadow({
      userId: "user_1",
      scope: "week",
      query: "本周有哪些未解决的问题？",
      dateRange: { startDate: "2026-07-07", endDate: "2026-07-13" },
      repository
    });

    expect(result.memories).toEqual([
      expect.objectContaining({ id: "question_old", occurrenceCount: 2 })
    ]);
    expect(new Set(result.evidence.map((evidence) => evidence.date))).toEqual(new Set(["2026-07-08"]));
  });

  it("returns an empty result for a user without indexed memory", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const result = retrieveMemoryShadow({
      userId: "missing_user",
      scope: "all",
      query: "过去有哪些问题？",
      repository: createMemoryRepository(database)
    });

    expect(result).toMatchObject({ memories: [], evidence: [], count: 0 });
  });

  it("swallows repository failures so shadow retrieval cannot affect QA", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = {
      getRelevantMemories: vi.fn(() => {
        throw new Error("sqlite unavailable");
      })
    } as unknown as MemoryRepository;

    const result = observeMemoryShadowRetrieval({
      userId: "user_1",
      scope: "all",
      query: "过去有哪些问题？",
      jsonEvidence: [],
      jsonRetrievalTimeMs: 3,
      repository
    });

    expect(result).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("[memory-shadow] scope=all failure=sqlite unavailable"));
  });
});
