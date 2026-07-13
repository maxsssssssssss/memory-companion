// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";
import { upgradeMemoryIndex } from "./upgrade";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function insertLegacyMemory(input: {
  id: string;
  type: "event" | "commitment" | "question";
  title: string;
  summary: string;
  date: string;
  uploadId: string;
}) {
  database!.prepare(`
    INSERT INTO memory_items (id, user_id, type, title, summary, importance, date, created_at, updated_at)
    VALUES (?, 'user_1', ?, ?, ?, 0.5, ?, ?, ?)
  `).run(
    input.id,
    input.type,
    input.title,
    input.summary,
    input.date,
    `${input.date}T10:00:00.000Z`,
    `${input.date}T10:00:00.000Z`
  );
  database!.prepare(`
    INSERT INTO memory_evidence (id, memory_id, source_type, source_id, upload_id, date, quote, created_at)
    VALUES (?, ?, 'transcript', ?, ?, ?, ?, ?)
  `).run(
    `${input.id}_evidence`,
    input.id,
    `${input.id}_segment`,
    input.uploadId,
    input.date,
    input.summary,
    `${input.date}T10:00:00.000Z`
  );
}

describe("memory index upgrade", () => {
  it("recalculates legacy rows, merges duplicates, preserves evidence and is idempotent", async () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    insertLegacyMemory({
      id: "commitment_1",
      type: "commitment",
      title: "Confirm Wednesday meeting time",
      summary: "The Wednesday meeting time still needs confirmation.",
      date: "2026-07-07",
      uploadId: "upload_1"
    });
    insertLegacyMemory({
      id: "commitment_2",
      type: "commitment",
      title: "Wednesday meeting time confirmation",
      summary: "We still need to confirm the Wednesday meeting time.",
      date: "2026-07-09",
      uploadId: "upload_2"
    });
    insertLegacyMemory({
      id: "question_1",
      type: "question",
      title: "Choose the dinner location",
      summary: "The dinner location remains unresolved.",
      date: "2026-07-07",
      uploadId: "upload_1"
    });
    insertLegacyMemory({
      id: "event_1",
      type: "event",
      title: "Dinner location decided",
      summary: "The dinner location was decided and confirmed.",
      date: "2026-07-09",
      uploadId: "upload_2"
    });

    const first = await upgradeMemoryIndex({ database, logger: { info() {}, warn() {} } });
    const repository = createMemoryRepository(database);
    const firstSnapshot = {
      memories: repository.getRelevantMemories({ userId: "user_1", limit: 100 }),
      relations: repository.getMemoryRelations("user_1")
    };
    const second = await upgradeMemoryIndex({ database, logger: { info() {}, warn() {} } });
    const secondSnapshot = {
      memories: repository.getRelevantMemories({ userId: "user_1", limit: 100 }),
      relations: repository.getMemoryRelations("user_1")
    };

    expect(first).toMatchObject({ usersProcessed: 1, memoriesBefore: 4, memoriesAfter: 3, duplicatesMerged: 1, failures: 0 });
    expect(second).toMatchObject({ usersProcessed: 1, memoriesBefore: 3, memoriesAfter: 3, duplicatesMerged: 0, failures: 0 });
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(firstSnapshot.memories.find((item) => item.type === "commitment")).toMatchObject({
      occurrenceCount: 2,
      firstSeenDate: "2026-07-07",
      lastSeenDate: "2026-07-09"
    });
    expect(firstSnapshot.memories.flatMap((item) => item.evidence)).toHaveLength(4);
    expect(firstSnapshot.memories.every((item) => item.importanceReasons.length > 0)).toBe(true);
    expect(firstSnapshot.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ relationType: "resolved_by" })])
    );
  });
});
