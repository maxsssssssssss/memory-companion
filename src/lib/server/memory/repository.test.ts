// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";
import type { MemoryOwnerResolution } from "./owner-attribution/types";
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

function ownerResolution(memory: MemoryWriteInput, identityId: string): MemoryOwnerResolution {
  const segmentIds = memory.evidence
    .filter((evidence) => evidence.sourceType === "transcript")
    .map((evidence) => evidence.sourceId);
  const owner = {
    type: "known_identity" as const,
    identityId,
    confidence: 0.95,
    source: "explicit_statement" as const
  };
  return {
    version: 1,
    memoryId: memory.id,
    memoryType: memory.type,
    scope: "individual",
    owner,
    participants: [{
      role: memory.type === "commitment" ? "actor" : "owner",
      attribution: owner,
      evidenceSegmentIds: segmentIds
    }],
    evidenceSegmentIds: segmentIds,
    observations: [],
    reasons: ["explicit_owner"]
  };
}

afterEach(() => {
  vi.restoreAllMocks();
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

  it("deduplicates evidence by memory, source and normalized quote", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const memory = memoryFixture({ id: "memory_normalized_duplicate" });
    memory.evidence = [
      { ...memory.evidence[0], id: "evidence_first", quote: "同一 条 逐字证据。" },
      { ...memory.evidence[0], id: "evidence_second", quote: " 同一条逐字证据！ " }
    ];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [memory]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })[0]?.evidence).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      "[memory-evidence-dedup] removed=1 user_id=user_1 upload_id=upload_1"
    );
  });

  it("keeps the same source evidence for different memories", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const event = memoryFixture({ id: "event_same_source", type: "event" });
    const commitment = {
      ...memoryFixture({ id: "commitment_same_source", type: "commitment" }),
      title: "确认周六见面",
      summary: "我们会确认周六见面。"
    };

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [event, commitment]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })).toHaveLength(2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_evidence").get()).toEqual({ count: 2 });
  });

  it("keeps distinct quotes from the same source", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const memory = memoryFixture({ id: "memory_distinct_quotes" });
    memory.evidence = [
      { ...memory.evidence[0], id: "evidence_first", quote: "第一条逐字内容。" },
      { ...memory.evidence[0], id: "evidence_second", quote: "第二条逐字内容。" }
    ];

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [memory]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })[0]?.evidence).toHaveLength(2);
  });

  it("merges repeated preferences for one user without changing cross-upload occurrence semantics or importance", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const first = {
      ...memoryFixture({ id: "preference_first", type: "preference", title: "饮食偏好" }),
      summary: "我不喜欢香菜。",
      evidence: [{
        ...memoryFixture({ id: "preference_first" }).evidence[0],
        id: "preference_first_evidence",
        sourceId: "segment_preference_first",
        quote: "我不喜欢香菜。"
      }]
    };
    const repeated = {
      ...memoryFixture({ id: "preference_repeated", type: "preference", title: "点餐习惯" }),
      summary: "我不吃香菜。",
      evidence: [{
        ...memoryFixture({ id: "preference_repeated" }).evidence[0],
        id: "preference_repeated_evidence",
        sourceId: "segment_preference_repeated",
        quote: "我不吃香菜。"
      }]
    };

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [first, repeated]
    });

    const memories = repository.getRelevantMemories({ userId: "user_1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ type: "preference", occurrenceCount: 1 });
    expect(memories[0]?.evidence).toHaveLength(2);
    expect(memories[0]?.importanceReasons).not.toContain("repeated_occurrence");
  });

  it("keeps different preference identities and different users separate", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const cilantro = {
      ...memoryFixture({ id: "preference_cilantro", type: "preference", title: "饮食偏好" }),
      summary: "我不喜欢香菜。",
      evidence: [{ ...memoryFixture({ id: "preference_cilantro" }).evidence[0], quote: "我不喜欢香菜。" }]
    };
    const quiet = {
      ...memoryFixture({ id: "preference_quiet", type: "preference", title: "环境偏好" }),
      summary: "我更喜欢安静的位置。",
      evidence: [{ ...memoryFixture({ id: "preference_quiet" }).evidence[0], sourceId: "segment_2", quote: "我更喜欢安静的位置。" }]
    };

    repository.replaceUploadMemories({ userId: "user_1", uploadId: "upload_1", memories: [cilantro, quiet] });
    repository.replaceUploadMemories({
      userId: "user_2",
      uploadId: "upload_1",
      memories: [{ ...cilantro, id: "preference_other_user", evidence: [{ ...cilantro.evidence[0], id: "other_user_evidence" }] }]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })).toHaveLength(2);
    expect(repository.getRelevantMemories({ userId: "user_2" })).toHaveLength(1);
  });

  it("keeps the same preference separate for different resolved owners", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const ownerA = {
      ...memoryFixture({ id: "preference_owner_a", type: "preference", title: "饮食偏好" }),
      summary: "我不太能吃辣。",
      evidence: [{
        ...memoryFixture({ id: "preference_owner_a" }).evidence[0],
        id: "evidence_owner_a",
        sourceId: "segment_owner_a",
        quote: "我不太能吃辣。"
      }]
    };
    const ownerB = {
      ...memoryFixture({ id: "preference_owner_b", type: "preference", title: "饮食偏好" }),
      summary: "我不爱吃辣。",
      evidence: [{
        ...memoryFixture({ id: "preference_owner_b" }).evidence[0],
        id: "evidence_owner_b",
        sourceId: "segment_owner_b",
        quote: "我不爱吃辣。"
      }]
    };

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [ownerA, ownerB],
      ownerAttributions: [
        ownerResolution(ownerA, "person_a"),
        ownerResolution(ownerB, "person_b")
      ]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })).toHaveLength(2);
    expect(repository.getMemoryOwnerAttributions("user_1")).toEqual([
      expect.objectContaining({ memoryId: ownerA.id, owner: expect.objectContaining({ identityId: "person_a" }) }),
      expect.objectContaining({ memoryId: ownerB.id, owner: expect.objectContaining({ identityId: "person_b" }) })
    ]);
  });

  it("merges repeated preferences for the same owner and retains owner observations", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const first = {
      ...memoryFixture({ id: "preference_first_owner", type: "preference", uploadId: "upload_1", date: "2026-07-08" }),
      summary: "我不喜欢香菜。",
      evidence: [{
        ...memoryFixture({ id: "preference_first_owner", uploadId: "upload_1", date: "2026-07-08" }).evidence[0],
        sourceId: "segment_first_owner",
        quote: "我不喜欢香菜。"
      }]
    };
    const repeated = {
      ...memoryFixture({ id: "preference_repeat_owner", type: "preference", uploadId: "upload_2", date: "2026-07-09" }),
      summary: "我不吃香菜。",
      evidence: [{
        ...memoryFixture({ id: "preference_repeat_owner", uploadId: "upload_2", date: "2026-07-09" }).evidence[0],
        sourceId: "segment_repeat_owner",
        quote: "我不吃香菜。"
      }]
    };

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [first],
      ownerAttributions: [ownerResolution(first, "person_a")]
    });
    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_2",
      memories: [repeated],
      ownerAttributions: [ownerResolution(repeated, "person_a")]
    });

    const memories = repository.getRelevantMemories({ userId: "user_1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ id: first.id, occurrenceCount: 2 });
    expect(repository.getMemoryOwnerAttributions("user_1", [first.id])).toEqual([
      expect.objectContaining({
        memoryId: first.id,
        owner: expect.objectContaining({ identityId: "person_a" }),
        evidenceSegmentIds: ["segment_first_owner", "segment_repeat_owner"]
      })
    ]);

    repository.rebuildUserMemories("user_1");
    expect(repository.getMemoryOwnerAttributions("user_1", [first.id])[0]?.evidenceSegmentIds)
      .toEqual(["segment_first_owner", "segment_repeat_owner"]);

    repository.deleteByUpload("user_1", "upload_2");
    expect(repository.getMemoryOwnerAttributions("user_1", [first.id])[0]?.evidenceSegmentIds)
      .toEqual(["segment_first_owner"]);
  });

  it("keeps similar commitments separate when their actors differ", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const commitment = (id: string, sourceId: string) => ({
      ...memoryFixture({ id, type: "commitment", title: "周二排练" }),
      summary: "我会周二晚上七点陪你排练。",
      evidence: [{
        ...memoryFixture({ id }).evidence[0],
        id: `${id}_evidence`,
        sourceId,
        quote: "我会周二晚上七点陪你排练。"
      }]
    });
    const first = commitment("commitment_actor_a", "segment_actor_a");
    const second = commitment("commitment_actor_b", "segment_actor_b");

    repository.replaceUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      memories: [first, second],
      ownerAttributions: [
        ownerResolution(first, "person_a"),
        ownerResolution(second, "person_b")
      ]
    });

    expect(repository.getRelevantMemories({ userId: "user_1" })).toHaveLength(2);
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
