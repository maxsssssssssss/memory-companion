// @vitest-environment node

import { describe, expect, it } from "vitest";
import { consolidateMemories, findSimilarMemories, mergeMemories } from "./deduplication";
import type { MemoryItem } from "./types";

function memory(input: {
  id: string;
  uploadId: string;
  date: string;
  type?: MemoryItem["type"];
  title: string;
  summary: string;
  importanceScore?: number;
}): MemoryItem {
  return {
    id: input.id,
    userId: "user_1",
    type: input.type ?? "commitment",
    title: input.title,
    summary: input.summary,
    importance: input.importanceScore ?? 0.7,
    importanceScore: input.importanceScore ?? 0.7,
    importanceReasons: [`${input.type ?? "commitment"} type`],
    status: "active",
    occurrenceCount: 1,
    firstSeenDate: input.date,
    lastSeenDate: input.date,
    accessCount: 0,
    lastAccessedAt: null,
    date: input.date,
    createdAt: `${input.date}T10:00:00.000Z`,
    updatedAt: `${input.date}T10:00:00.000Z`,
    evidence: [
      {
        id: `${input.id}_evidence`,
        memoryId: input.id,
        sourceType: "transcript",
        sourceId: `${input.uploadId}_segment`,
        uploadId: input.uploadId,
        date: input.date,
        quote: input.summary,
        createdAt: `${input.date}T10:00:00.000Z`
      }
    ]
  };
}

describe("memory deduplication", () => {
  it("finds similar same-type memories within a conservative date window", () => {
    const existing = memory({
      id: "memory_1",
      uploadId: "upload_1",
      date: "2026-07-07",
      title: "Confirm Wednesday meeting time",
      summary: "We will confirm the Wednesday meeting time."
    });
    const incoming = memory({
      id: "memory_2",
      uploadId: "upload_2",
      date: "2026-07-09",
      title: "Wednesday meeting time confirmation",
      summary: "The Wednesday meeting time still needs confirmation."
    });

    expect(findSimilarMemories(incoming, [existing])).toEqual([
      expect.objectContaining({ memory: existing, score: expect.any(Number) })
    ]);
  });

  it("does not merge unrelated or different-type memories", () => {
    const incoming = memory({
      id: "memory_2",
      uploadId: "upload_2",
      date: "2026-07-09",
      title: "Confirm Wednesday meeting time",
      summary: "We will confirm the meeting time."
    });
    const unrelated = memory({
      id: "memory_3",
      uploadId: "upload_3",
      date: "2026-07-09",
      title: "Buy groceries",
      summary: "Pick up vegetables and milk."
    });
    const differentType = memory({
      id: "memory_4",
      uploadId: "upload_4",
      date: "2026-07-09",
      type: "event",
      title: incoming.title,
      summary: incoming.summary
    });

    expect(findSimilarMemories(incoming, [unrelated, differentType])).toEqual([]);
  });

  it("does not merge unrelated records solely because they share a generic title", () => {
    const first = memory({
      id: "memory_1",
      uploadId: "upload_1",
      date: "2026-07-07",
      type: "event",
      title: "Conversation summary",
      summary: "Discussed restaurant choices and dinner timing."
    });
    const second = memory({
      id: "memory_2",
      uploadId: "upload_2",
      date: "2026-07-08",
      type: "event",
      title: "Conversation summary",
      summary: "Reviewed a software deployment error and server logs."
    });

    expect(findSimilarMemories(second, [first])).toEqual([]);
  });

  it("merges evidence and recomputes occurrence and date metadata", () => {
    const first = memory({
      id: "memory_1",
      uploadId: "upload_1",
      date: "2026-07-07",
      title: "Confirm Wednesday meeting time",
      summary: "We will confirm the Wednesday meeting time.",
      importanceScore: 0.7
    });
    const second = memory({
      id: "memory_2",
      uploadId: "upload_2",
      date: "2026-07-09",
      title: "Wednesday meeting time confirmation",
      summary: "The Wednesday meeting time still needs confirmation.",
      importanceScore: 0.8
    });

    const merged = mergeMemories(first, second);

    expect(merged.id).toBe("memory_1");
    expect(merged.title).toBe(second.title);
    expect(merged.occurrenceCount).toBe(2);
    expect(merged.firstSeenDate).toBe("2026-07-07");
    expect(merged.lastSeenDate).toBe("2026-07-09");
    expect(merged.date).toBe("2026-07-09");
    expect(merged.evidence.map((item) => item.uploadId).sort()).toEqual(["upload_1", "upload_2"]);
    expect(merged.evidence.every((item) => item.memoryId === "memory_1")).toBe(true);
    expect(merged.importanceScore).toBeGreaterThan(0.8);
  });

  it("consolidates a duplicate set without merging unrelated records", () => {
    const records = [
      memory({
        id: "memory_1",
        uploadId: "upload_1",
        date: "2026-07-07",
        title: "Confirm Wednesday meeting time",
        summary: "We will confirm the Wednesday meeting time."
      }),
      memory({
        id: "memory_2",
        uploadId: "upload_2",
        date: "2026-07-09",
        title: "Wednesday meeting time confirmation",
        summary: "The Wednesday meeting time still needs confirmation."
      }),
      memory({
        id: "memory_3",
        uploadId: "upload_3",
        date: "2026-07-09",
        title: "Buy groceries",
        summary: "Pick up vegetables and milk."
      })
    ];

    const consolidated = consolidateMemories(records);

    expect(consolidated).toHaveLength(2);
    expect(consolidated.find((item) => item.id === "memory_1")?.occurrenceCount).toBe(2);
  });
});
