import { describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionAdmittedReturnSource,
  DailyReflectionEmergingCardSource,
  DailyReflectionReturnSourceSnapshot
} from "./return-source-repository";
import { createDailyReflectionReturnService } from "./return-service";

function admitted(input: {
  memoryId: string;
  cardId?: string;
  date: string;
  title: string;
  content?: string;
  memoryType?: DailyReflectionAdmittedReturnSource["memoryType"];
  cardKind?: DailyReflectionAdmittedReturnSource["cardKind"];
  actionClaimed?: boolean;
  epistemicStatus?: DailyReflectionAdmittedReturnSource["epistemicStatus"];
  importance?: number;
}): DailyReflectionAdmittedReturnSource {
  const cardId = input.cardId ?? `card_${input.memoryId}`;
  const sourceSegmentId = `segment_${input.memoryId}`;
  return {
    memoryId: input.memoryId,
    cardId,
    reflectionId: `reflection_${input.memoryId}`,
    recordingDate: input.date,
    memoryType: input.memoryType ?? "event",
    cardKind: input.cardKind ?? "event",
    actionClaimed: input.actionClaimed ?? false,
    subjectPersonId: null,
    epistemicStatus: input.epistemicStatus ?? "explicit_user_statement",
    epistemicCaution: null,
    riskFlags: [],
    title: input.title,
    content: input.content ?? `${input.title}内容`,
    importance: input.importance ?? 0.7,
    evidence: [{
      reflectionId: `reflection_${input.memoryId}`,
      cardId,
      recordingDate: input.date,
      sourceOrigin: "user_reflection",
      sourceSegmentId,
      startSeconds: 0,
      endSeconds: 8,
      snippet: input.content ?? `${input.title}内容`
    }]
  };
}

function emerging(input: {
  cardId: string;
  date: string;
  title: string;
  cardKind?: "idea" | "insight";
  importance?: number;
}): DailyReflectionEmergingCardSource {
  return {
    cardId: input.cardId,
    reflectionIds: [`reflection_${input.cardId}`],
    recordingDates: [input.date],
    cardKind: input.cardKind ?? "idea",
    epistemicStatuses: ["explicit_user_statement"],
    riskFlags: [],
    title: input.title,
    content: `${input.title}内容`,
    importance: input.importance ?? 0.7,
    relatedCardIds: [],
    tags: [],
    evidence: [{
      reflectionId: `reflection_${input.cardId}`,
      cardId: input.cardId,
      recordingDate: input.date,
      sourceOrigin: "user_reflection",
      sourceSegmentId: `segment_${input.cardId}`,
      startSeconds: 3,
      endSeconds: 9,
      snippet: `${input.title}内容`
    }]
  };
}

function repository(snapshot: DailyReflectionReturnSourceSnapshot) {
  return { snapshot: vi.fn(() => snapshot) };
}

describe("Daily Reflection deterministic return service", () => {
  it("keeps only safe claimed open loops and produces stable account-scoped ordering", () => {
    const snapshot: DailyReflectionReturnSourceSnapshot = {
      admitted: [
        admitted({
          memoryId: "memory_unclaimed",
          date: "2026-08-23",
          title: "未认领动作",
          memoryType: "commitment",
          cardKind: "action",
          actionClaimed: false,
          importance: 0.99
        }),
        admitted({
          memoryId: "memory_unknown",
          date: "2026-08-23",
          title: "不确定内容",
          epistemicStatus: "unknown",
          importance: 0.98
        }),
        admitted({
          memoryId: "memory_inference",
          date: "2026-08-23",
          title: "模型推断",
          epistemicStatus: "ai_inference",
          importance: 0.97
        }),
        admitted({
          memoryId: "memory_question",
          date: "2026-08-22",
          title: "需要继续确认的问题",
          memoryType: "question",
          cardKind: "question",
          importance: 0.8
        }),
        admitted({
          memoryId: "memory_claimed",
          date: "2026-08-24",
          title: "整理项目复盘",
          memoryType: "commitment",
          cardKind: "action",
          actionClaimed: true,
          importance: 0.9
        }),
        admitted({
          memoryId: "memory_reported",
          date: "2026-08-21",
          title: "用户报告的事件",
          epistemicStatus: "reported_event",
          importance: 0.6
        })
      ],
      workingCards: [],
      emergingCards: [],
      relations: []
    };
    const sourceRepository = repository(snapshot);
    const service = createDailyReflectionReturnService(sourceRepository);

    const first = service.daily("account_1", "2026-08-24");
    const second = service.daily("account_1", "2026-08-24");

    expect(sourceRepository.snapshot).toHaveBeenNthCalledWith(
      1,
      "account_1",
      "0001-01-01",
      "2026-08-24"
    );
    expect(first).toEqual(second);
    expect(first.openLoops.map((item) => item.sourceMemoryIds[0])).toEqual([
      "memory_claimed",
      "memory_question"
    ]);
    expect(first.openLoops.flatMap((item) => item.sourceMemoryIds))
      .not.toEqual(expect.arrayContaining(["memory_unclaimed"]));
    expect(first.resurfacedMemories.flatMap((item) => item.sourceMemoryIds))
      .not.toEqual(expect.arrayContaining(["memory_unknown", "memory_inference"]));
    expect(first.reflectionPrompts.every((item) => (
      item.body.includes("现在情况是否有变化？")
      && !/你应该|建议你|必须/u.test(item.body)
    ))).toBe(true);
    expect(first.resurfacedMemories[0]).toMatchObject({
      sourceMemoryIds: ["memory_claimed"],
      sourceCardIds: ["card_memory_claimed"],
      evidenceIds: ["segment_memory_claimed"],
      epistemicStatuses: ["explicit_user_statement"]
    });
  });

  it("builds counted themes, ordered changed decisions, claimed commitments, and Card-only ideas", () => {
    const themeEarly = admitted({
      memoryId: "memory_theme_early",
      date: "2026-08-18",
      title: "晨间写作",
      importance: 0.65
    });
    const themeLate = admitted({
      memoryId: "memory_theme_late",
      date: "2026-08-24",
      title: "晨间写作",
      importance: 0.75
    });
    const decisionEarly = admitted({
      memoryId: "memory_decision_early",
      date: "2026-08-19",
      title: "出行方案",
      content: "最初决定坐火车。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const decisionLate = admitted({
      memoryId: "memory_decision_late",
      date: "2026-08-23",
      title: "出行方案",
      content: "后来改为开车。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const commitment = admitted({
      memoryId: "memory_commitment",
      date: "2026-08-20",
      title: "提交周报",
      memoryType: "commitment",
      cardKind: "action",
      actionClaimed: true,
      importance: 0.85
    });
    const snapshot: DailyReflectionReturnSourceSnapshot = {
      admitted: [decisionLate, themeLate, commitment, decisionEarly, themeEarly],
      workingCards: [],
      emergingCards: [emerging({
        cardId: "card_idea",
        date: "2026-08-22",
        title: "做一份主题索引"
      })],
      relations: [{
        sourceMemoryId: decisionEarly.memoryId,
        targetMemoryId: decisionLate.memoryId,
        relationType: "contradicted_by",
        confidence: 0.91
      }]
    };
    const service = createDailyReflectionReturnService(repository(snapshot));

    const result = service.weekly("account_1", "2026-08-24");

    expect(result).toMatchObject({
      startDate: "2026-08-18",
      endDate: "2026-08-24",
      timeZone: "Asia/Shanghai"
    });
    const writingTheme = result.repeatedThemes.find(
      (item) => item.title === "晨间写作"
    );
    expect(writingTheme).toMatchObject({
      sourceCount: 2,
      dates: ["2026-08-18", "2026-08-24"],
      sourceMemoryIds: ["memory_theme_early", "memory_theme_late"]
    });
    expect(result.changedDecisions).toHaveLength(1);
    expect(result.changedDecisions[0]?.body).toBe(
      "从“最初决定坐火车。”变化为“后来改为开车。”。"
    );
    expect(result.changedDecisions[0]?.sourceMemoryIds).toEqual([
      "memory_decision_early",
      "memory_decision_late"
    ]);
    expect(result.openCommitments).toHaveLength(1);
    expect(result.openCommitments[0]?.sourceMemoryIds).toEqual([
      "memory_commitment"
    ]);
    expect(result.emergingIdeas).toHaveLength(1);
    expect(result.emergingIdeas[0]).toMatchObject({
      sourceMemoryIds: [],
      sourceCardIds: ["card_idea"],
      evidenceIds: ["segment_card_idea"]
    });
  });

  it("keeps weekly ids and ordering deterministic when repository order changes", () => {
    const first = admitted({
      memoryId: "memory_a",
      date: "2026-08-18",
      title: "重复主题",
      importance: 0.5
    });
    const second = admitted({
      memoryId: "memory_b",
      date: "2026-08-24",
      title: "重复主题",
      importance: 0.5
    });
    let flip = false;
    const sourceRepository = {
      snapshot: vi.fn(() => {
        flip = !flip;
        return {
          admitted: flip ? [first, second] : [second, first],
          workingCards: [],
          emergingCards: [],
          relations: []
        } satisfies DailyReflectionReturnSourceSnapshot;
      })
    };
    const service = createDailyReflectionReturnService(sourceRepository);

    expect(service.weekly("account_1", "2026-08-24"))
      .toEqual(service.weekly("account_1", "2026-08-24"));
  });
});
