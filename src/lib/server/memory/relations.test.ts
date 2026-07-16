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

  it.each([
    ["博物馆参观计划", "博物馆计划调整到周日", "已经参观完博物馆"],
    ["看医生的安排", "看医生改到周四", "已经完成看医生的预约"],
    ["购买演出票计划", "演出票购买时间改到晚上", "演出票已经购买完成"],
    ["提交简历计划", "提交简历调整到周五", "简历已经提交完成"]
  ])("connects plan, update and completion lifecycle for %s", (planTitle, updateTitle, completionTitle) => {
    const plan = memory({
      id: `plan_${planTitle}`,
      type: "commitment",
      date: "2026-07-01",
      title: planTitle,
      summary: `${planTitle}仍需要确认。`
    });
    const update = memory({
      id: `update_${planTitle}`,
      type: "event",
      date: "2026-07-05",
      title: updateTitle,
      summary: `${updateTitle}，这是原计划的后续调整。`
    });
    const completion = memory({
      id: `completion_${planTitle}`,
      type: "event",
      date: "2026-07-12",
      title: completionTitle,
      summary: `${completionTitle}。`
    });
    const relations = detectMemoryRelations([plan, update, completion]);

    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceMemoryId: plan.id, targetMemoryId: update.id, relationType: "follow_up" }),
      expect.objectContaining({ sourceMemoryId: update.id, targetMemoryId: completion.id, relationType: "resolved_by" })
    ]));
  });

  it("does not connect unrelated lifecycle events that only share generic plan language", () => {
    const museum = memory({
      id: "museum_plan",
      type: "commitment",
      date: "2026-07-01",
      title: "周末博物馆计划",
      summary: "计划周末参观博物馆。"
    });
    const doctor = memory({
      id: "doctor_completed",
      type: "event",
      date: "2026-07-02",
      title: "看医生已经完成",
      summary: "今天已经完成看医生。"
    });

    expect(detectMemoryRelations([museum, doctor])).toEqual([]);
  });

  it("does not treat a negative boundary instruction as cancellation", () => {
    const boundaryPlan = memory({
      id: "pause_plan",
      type: "commitment",
      date: "2026-07-15",
      title: "Pause and resume communication plan",
      summary: "We agreed not to send repeated messages during a short pause."
    });
    const boundaryDetail = memory({
      id: "pause_detail",
      type: "event",
      date: "2026-07-15",
      title: "Pause and resume communication details",
      summary: "The pause includes a clear return time and no repeated follow-up messages."
    });

    expect(detectMemoryRelations([boundaryPlan, boundaryDetail]))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ relationType: "contradicted_by" })]));
  });

  it("keeps one strongest predecessor per target lifecycle relation", () => {
    const firstPlan = memory({
      id: "museum_plan_first",
      type: "commitment",
      date: "2026-07-01",
      title: "Museum visit plan",
      summary: "The museum visit time still needs confirmation."
    });
    const updatedPlan = memory({
      id: "museum_plan_update",
      type: "event",
      date: "2026-07-05",
      title: "Museum visit plan updated",
      summary: "The museum visit was rescheduled and the entry time was updated."
    });
    const completion = memory({
      id: "museum_visit_complete",
      type: "event",
      date: "2026-07-12",
      title: "Museum visit completed",
      summary: "The museum visit was completed."
    });
    const relations = detectMemoryRelations([firstPlan, updatedPlan, completion]);
    const completionRelations = relations.filter((relation) =>
      relation.targetMemoryId === completion.id && relation.relationType === "resolved_by"
    );

    expect(completionRelations).toEqual([
      expect.objectContaining({ sourceMemoryId: updatedPlan.id, targetMemoryId: completion.id })
    ]);
  });
});
