// @vitest-environment node

import { describe, expect, it } from "vitest";
import { detectMemoryRelations } from "./relations";
import type { MemoryItem } from "./types";

function memory(input: {
  id: string;
  type: MemoryItem["type"];
  date: string;
  title: string;
  summary: string;
}): MemoryItem {
  return {
    id: input.id,
    userId: "user_1",
    type: input.type,
    title: input.title,
    summary: input.summary,
    importance: 0.7,
    importanceScore: 0.7,
    importanceReasons: [`${input.type} type`],
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
        sourceId: `${input.id}_segment`,
        uploadId: `${input.id}_upload`,
        date: input.date,
        quote: input.summary,
        createdAt: `${input.date}T10:00:00.000Z`
      }
    ]
  };
}

describe("memory relations", () => {
  it("detects a conservative resolved_by relation", () => {
    const commitment = memory({
      id: "commitment_1",
      type: "commitment",
      date: "2026-07-07",
      title: "Confirm Wednesday meeting time",
      summary: "The Wednesday meeting time still needs confirmation."
    });
    const event = memory({
      id: "event_1",
      type: "event",
      date: "2026-07-09",
      title: "Wednesday meeting time confirmed",
      summary: "The Wednesday meeting time was confirmed."
    });

    expect(detectMemoryRelations([commitment, event])).toEqual([
      expect.objectContaining({
        sourceMemoryId: commitment.id,
        targetMemoryId: event.id,
        relationType: "resolved_by"
      })
    ]);
  });

  it("detects follow_up and related relations", () => {
    const question = memory({
      id: "question_1",
      type: "question",
      date: "2026-07-07",
      title: "Choose a quiet dinner restaurant",
      summary: "Which quiet dinner restaurant should we choose?"
    });
    const followUp = memory({
      id: "event_1",
      type: "event",
      date: "2026-07-08",
      title: "Discuss quiet dinner restaurant options",
      summary: "We discussed several quiet dinner restaurant options."
    });
    const preference = memory({
      id: "preference_1",
      type: "preference",
      date: "2026-07-09",
      title: "Prefer a quiet dinner location",
      summary: "A quiet dinner location feels more comfortable."
    });

    const relations = detectMemoryRelations([question, followUp, preference]);

    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceMemoryId: question.id, targetMemoryId: followUp.id, relationType: "follow_up" }),
        expect.objectContaining({ sourceMemoryId: followUp.id, targetMemoryId: preference.id, relationType: "related" })
      ])
    );
  });

  it("detects repeated and contradicted_by relations without duplicates", () => {
    const repeatedFirst = memory({
      id: "question_1",
      type: "question",
      date: "2026-01-07",
      title: "Confirm the next meeting time",
      summary: "The next meeting time is still unclear."
    });
    const repeatedLater = memory({
      id: "question_2",
      type: "question",
      date: "2026-07-07",
      title: "Confirm the next meeting time",
      summary: "The next meeting time remains unclear."
    });
    const commitment = memory({
      id: "commitment_1",
      type: "commitment",
      date: "2026-07-08",
      title: "Meet on Friday evening",
      summary: "We planned to meet on Friday evening."
    });
    const cancellation = memory({
      id: "event_1",
      type: "event",
      date: "2026-07-09",
      title: "Friday evening meeting cancelled",
      summary: "The Friday evening meeting was cancelled."
    });

    const relations = detectMemoryRelations([repeatedFirst, repeatedLater, commitment, cancellation]);
    const keys = relations.map((relation) => `${relation.sourceMemoryId}:${relation.targetMemoryId}:${relation.relationType}`);

    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceMemoryId: repeatedFirst.id, targetMemoryId: repeatedLater.id, relationType: "repeated" }),
        expect.objectContaining({ sourceMemoryId: commitment.id, targetMemoryId: cancellation.id, relationType: "contradicted_by" })
      ])
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not relate unrelated memories solely because they share a generic title", () => {
    const first = memory({
      id: "question_1",
      type: "question",
      date: "2026-07-07",
      title: "Open question",
      summary: "Which restaurant should we choose for dinner?"
    });
    const second = memory({
      id: "question_2",
      type: "question",
      date: "2026-07-07",
      title: "Open question",
      summary: "Which server deployment error needs investigation?"
    });

    expect(detectMemoryRelations([first, second])).toEqual([]);
  });
});
