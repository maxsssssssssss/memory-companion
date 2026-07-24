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

  it("honors an internal merge policy without changing similarity detection", () => {
    const first = memory({
      id: "preference_owner_a",
      uploadId: "upload_1",
      date: "2026-07-07",
      type: "preference",
      title: "饮食偏好",
      summary: "我不喜欢太辣的食物。"
    });
    const second = memory({
      id: "preference_owner_b",
      uploadId: "upload_2",
      date: "2026-07-08",
      type: "preference",
      title: "饮食偏好",
      summary: "我不爱太辣的食物。"
    });
    const mergedPairs: string[] = [];

    const consolidated = consolidateMemories([first, second], undefined, {
      canMerge: (primary, incoming) => primary.id === incoming.id,
      onMerged: (primary, incoming) => mergedPairs.push(`${primary.id}:${incoming.id}`)
    });

    expect(findSimilarMemories(second, [first])).toHaveLength(1);
    expect(consolidated).toHaveLength(2);
    expect(mergedPairs).toEqual([]);
  });

  it("merges repeated stable preferences by their subject without relying on a specific domain", () => {
    const first = memory({
      id: "preference_1",
      uploadId: "upload_1",
      date: "2026-07-01",
      type: "preference",
      title: "明确偏好表达",
      summary: "我不喜欢音乐音量太高。"
    });
    const repeated = memory({
      id: "preference_2",
      uploadId: "upload_2",
      date: "2026-07-08",
      type: "preference",
      title: "明确偏好表达",
      summary: "我不爱音乐音量太高。"
    });
    const unrelated = memory({
      id: "preference_3",
      uploadId: "upload_3",
      date: "2026-07-08",
      type: "preference",
      title: "明确偏好表达",
      summary: "我更喜欢步行去公园。"
    });

    expect(findSimilarMemories(repeated, [first, unrelated])).toEqual([
      expect.objectContaining({ memory: first })
    ]);
  });

  it("uses verbatim transcript evidence when preference summaries are paraphrased", () => {
    const first = memory({
      id: "preference_evidence_1",
      uploadId: "upload_1",
      date: "2026-07-01",
      type: "preference",
      title: "Stable drink choice",
      summary: "A low-sugar drink is the usual choice."
    });
    first.evidence[0].quote = "I usually prefer low-sugar oat drinks.";
    const repeated = memory({
      id: "preference_evidence_2",
      uploadId: "upload_2",
      date: "2026-07-08",
      type: "preference",
      title: "Sweetness preference",
      summary: "The sweetness preference remains unchanged."
    });
    repeated.evidence[0].quote = "I prefer low-sugar oat drinks.";

    expect(findSimilarMemories(repeated, [first])).toEqual([
      expect.objectContaining({ memory: first })
    ]);
  });

  it("matches exact normalized preference identities without merging different values", () => {
    const first = memory({
      id: "preference_cilantro_first",
      uploadId: "upload_1",
      date: "2026-07-01",
      type: "preference",
      title: "饮食偏好",
      summary: "我不喜欢香菜。"
    });
    const repeated = memory({
      id: "preference_cilantro_repeat",
      uploadId: "upload_2",
      date: "2026-07-08",
      type: "preference",
      title: "点餐习惯",
      summary: "我不爱香菜。"
    });
    const distinct = memory({
      id: "preference_quiet",
      uploadId: "upload_3",
      date: "2026-07-08",
      type: "preference",
      title: "环境偏好",
      summary: "我更喜欢安静的位置。"
    });

    expect(findSimilarMemories(repeated, [first, distinct])).toEqual([
      expect.objectContaining({ memory: first })
    ]);
    expect(findSimilarMemories(distinct, [first])).toEqual([]);
  });
});
