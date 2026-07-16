// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";
import type { MemoryWriteInput } from "./types";

let database: Database.Database | undefined;

function memoryFixture(input: {
  id: string;
  type?: MemoryWriteInput["type"];
  date?: string;
  uploadId?: string;
  title?: string;
}): MemoryWriteInput {
  const uploadId = input.uploadId ?? "upload_1";
  return {
    id: input.id,
    type: input.type ?? "event",
    title: input.title ?? "讨论下次见面安排",
    summary: "双方讨论了下次见面的时间。",
    importance: 0.72,
    date: input.date ?? "2026-07-08",
    createdAt: "2026-07-08T10:00:00.000Z",
    updatedAt: "2026-07-08T10:00:00.000Z",
    evidence: [
      {
        id: `${input.id}_evidence`,
        sourceType: "transcript",
        sourceId: "segment_1",
        uploadId,
        date: input.date ?? "2026-07-08",
        quote: "我们周六下午再见。",
        createdAt: "2026-07-08T10:00:00.000Z"
      }
    ]
  };
}

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("memory repository", () => {
  it("rejects mismatched and cross-upload transcript evidence when source segments are supplied", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const sourceSegments = [{
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 5,
      speaker: "speaker_1",
      text: "这是逐字原文。",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }];

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      sourceSegments,
      memories: [
        {
          ...memoryFixture({ id: "memory_mismatch" }),
          evidence: [
            { ...memoryFixture({ id: "memory_mismatch" }).evidence[0], quote: "模型改写后的内容。" },
            { ...memoryFixture({ id: "memory_mismatch" }).evidence[0], id: "cross", sourceId: "other", uploadId: "upload_2" }
          ]
        }
      ]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })).toEqual([]);
  });

  it("deduplicates the same transcript source id before persistence", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const memory = memoryFixture({ id: "memory_duplicate" });
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      sourceSegments: [{
        id: "segment_1",
        uploadId: "upload_1",
        startSeconds: 0,
        endSeconds: 5,
        speaker: "speaker_1",
        text: memory.evidence[0].quote,
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }],
      memories: [{ ...memory, evidence: [...memory.evidence, { ...memory.evidence[0], id: "duplicate_id" }] }]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })[0]?.evidence).toHaveLength(1);
  });

  it("keeps derived evidence grounded in its matching source segment instead of the first memory segment", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const memory = memoryFixture({ id: "memory_derived" });
    const firstText = "第一段是背景信息。";
    const secondText = "第二段给出了明确安排。";
    memory.evidence = [
      { ...memory.evidence[0], sourceId: "segment_1", quote: firstText },
      { ...memory.evidence[0], id: "segment_2_evidence", sourceId: "segment_2", quote: secondText },
      { ...memory.evidence[0], id: "brief_evidence", sourceType: "brief", sourceId: "brief_1", quote: secondText }
    ];

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      sourceSegments: [
        { id: "segment_1", uploadId: "upload_1", startSeconds: 0, endSeconds: 5, speaker: "speaker_1", text: firstText, confidence: 0.9, sceneLabels: [], valueLabels: [] },
        { id: "segment_2", uploadId: "upload_1", startSeconds: 6, endSeconds: 11, speaker: "speaker_2", text: secondText, confidence: 0.9, sceneLabels: [], valueLabels: [] }
      ],
      memories: [memory]
    });

    const derived = repository.getRelevantMemories({ userId: "user_1" })[0]?.evidence
      .find((evidence) => evidence.sourceType === "brief");
    expect(derived?.quote).toBe(secondText);
  });

  it("accepts whitespace-only comparison differences but persists the verbatim source text", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const memory = memoryFixture({ id: "memory_whitespace" });
    memory.evidence[0].quote = "这是 逐字 原文。";

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      sourceSegments: [{
        id: "segment_1",
        uploadId: "upload_1",
        startSeconds: 0,
        endSeconds: 5,
        speaker: "speaker_1",
        text: "这是  逐字\n原文。",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      }],
      memories: [memory]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })[0]?.evidence[0].quote).toBe("这是  逐字\n原文。");
  });

  it("replaces an upload index idempotently and returns evidence-backed memories", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [memoryFixture({ id: "memory_1" })]
    });
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [memoryFixture({ id: "memory_1", title: "确认周六见面" })]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })).toEqual([
      expect.objectContaining({
        id: "memory_1",
        userId: "user_1",
        title: "确认周六见面",
        evidence: [expect.objectContaining({ sourceId: "segment_1", uploadId: "upload_1" })]
      })
    ]);
  });

  it("persists extraction reasons alongside recalculated importance reasons", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [
        {
          ...memoryFixture({ id: "memory_reason", type: "commitment" }),
          importanceReasons: ["extraction: contains future action and commitment language"]
        }
      ]
    });
    repository.rebuildUserMemories("user_1");

    expect(repository.getRelevantMemories({ userId: "user_1" })[0]?.importanceReasons).toEqual(
      expect.arrayContaining([
        "extraction: contains future action and commitment language",
        "commitment type"
      ])
    );
  });

  it("filters by date and type, then deletes memories by upload", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_old",
      memories: [memoryFixture({ id: "memory_old", type: "event", date: "2026-01-08", uploadId: "upload_old" })]
    });
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_week",
      memories: [memoryFixture({ id: "memory_week", type: "commitment", date: "2026-07-08", uploadId: "upload_week" })]
    });

    expect(
      repository.getRelevantMemories({
        userId: "user_1",
        startDate: "2026-07-07",
        endDate: "2026-07-12",
        types: ["commitment"]
      })
    ).toHaveLength(1);

    repository.deleteByUpload("user_1", "upload_week");
    expect(repository.getRelevantMemories({ userId: "user_1" }).map((item) => item.id)).toEqual(["memory_old"]);
  });

  it("deduplicates similar memories across uploads and remains idempotent", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const first = {
      ...memoryFixture({
        id: "memory_first",
        uploadId: "upload_1",
        date: "2026-07-07",
        type: "commitment",
        title: "Confirm Wednesday meeting time"
      }),
      summary: "We will confirm the Wednesday meeting time."
    };
    const second = {
      ...memoryFixture({
        id: "memory_second",
        uploadId: "upload_2",
        date: "2026-07-09",
        type: "commitment",
        title: "Wednesday meeting time confirmation"
      }),
      summary: "The Wednesday meeting time still needs confirmation."
    };

    repository.replaceUploadMemories({ userId: "user_1", uploadId: "upload_1", memories: [first] });
    repository.replaceUploadMemories({ userId: "user_1", uploadId: "upload_2", memories: [second] });
    repository.replaceUploadMemories({ userId: "user_1", uploadId: "upload_2", memories: [second] });

    const memories = repository.getRelevantMemories({ userId: "user_1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id: "memory_first",
      occurrenceCount: 2,
      firstSeenDate: "2026-07-07",
      lastSeenDate: "2026-07-09"
    });
    expect(new Set(memories[0].evidence.map((item) => item.uploadId))).toEqual(
      new Set(["upload_1", "upload_2"])
    );

    repository.deleteByUpload("user_1", "upload_2");
    expect(repository.getRelevantMemories({ userId: "user_1" })).toEqual([
      expect.objectContaining({ id: "memory_first", occurrenceCount: 1, lastSeenDate: "2026-07-07" })
    ]);
  });

  it("queries important, active, unresolved, repeated and related memories", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [
        {
          ...memoryFixture({ id: "commitment_resolved", uploadId: "upload_1", date: "2026-07-07", type: "commitment", title: "Confirm Wednesday meeting time" }),
          summary: "The Wednesday meeting time still needs confirmation."
        },
        {
          ...memoryFixture({ id: "commitment_active", uploadId: "upload_1", date: "2026-07-07", type: "commitment", title: "Book a quiet dinner table" }),
          summary: "We will book a quiet dinner table tomorrow."
        },
        {
          ...memoryFixture({ id: "question_active", uploadId: "upload_1", date: "2026-07-07", type: "question", title: "Choose the dinner location" }),
          summary: "The dinner location remains unresolved."
        }
      ]
    });
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_2",
      memories: [
        {
          ...memoryFixture({ id: "event_resolver", uploadId: "upload_2", date: "2026-07-09", type: "event", title: "Wednesday meeting time confirmed" }),
          summary: "The Wednesday meeting time was confirmed."
        },
        {
          ...memoryFixture({ id: "commitment_active_repeat", uploadId: "upload_2", date: "2026-07-09", type: "commitment", title: "Book a quiet dinner table" }),
          summary: "We will book a quiet dinner table tomorrow."
        }
      ]
    });

    expect(repository.getImportantMemories("user_1", 2)).toHaveLength(2);
    expect(repository.getActiveCommitments("user_1").map((item) => item.id)).toEqual(["commitment_active"]);
    expect(repository.getUnresolvedQuestions("user_1").map((item) => item.id)).toEqual(["question_active"]);
    expect(repository.getRepeatedMemories("user_1")).toEqual([
      expect.objectContaining({ id: "commitment_active", occurrenceCount: 2 })
    ]);
    expect(repository.getRelatedMemories("user_1", "commitment_resolved")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: expect.objectContaining({ relationType: "resolved_by" }),
          memory: expect.objectContaining({ id: "event_resolver" })
        })
      ])
    );
  });

  it("does not lose an active commitment behind the default query limit", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const memories = Array.from({ length: 51 }, (_, index) => ({
      ...memoryFixture({
        id: `commitment_${index}`,
        uploadId: "upload_many",
        type: "commitment",
        title: `UniqueTopic${index}`
      }),
      summary: `UniqueDetail${index}`
    }));
    repository.replaceUploadMemories({ userId: "user_1", uploadId: "upload_many", memories });
    database.prepare("UPDATE memory_items SET status = 'resolved', importance_score = 0.9, importance = 0.9").run();
    database.prepare(`
      UPDATE memory_items
      SET status = 'active', importance_score = 0.1, importance = 0.1
      WHERE id = 'commitment_50'
    `).run();

    expect(repository.getActiveCommitments("user_1").map((item) => item.id)).toEqual(["commitment_50"]);
  });

  it("propagates resolution through a follow-up lifecycle chain", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_plan",
      memories: [{
        ...memoryFixture({ id: "museum_plan", uploadId: "upload_plan", date: "2026-07-01", type: "commitment", title: "Museum visit plan" }),
        summary: "The museum visit time still needs confirmation."
      }]
    });
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_update",
      memories: [{
        ...memoryFixture({ id: "museum_update", uploadId: "upload_update", date: "2026-07-05", type: "event", title: "Museum visit plan updated" }),
        summary: "The museum visit was rescheduled and the entry time was updated."
      }]
    });
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_complete",
      memories: [{
        ...memoryFixture({ id: "museum_complete", uploadId: "upload_complete", date: "2026-07-12", type: "event", title: "Museum visit completed" }),
        summary: "The museum visit was completed."
      }]
    });

    const rows = database.prepare("SELECT id, status FROM memory_items ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual(expect.arrayContaining([
      { id: "museum_plan", status: "resolved" },
      { id: "museum_update", status: "resolved" },
      { id: "museum_complete", status: "active" }
    ]));
  });
});
