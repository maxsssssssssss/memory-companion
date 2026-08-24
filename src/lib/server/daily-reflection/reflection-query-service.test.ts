import { describe, expect, it, vi } from "vitest";

import type { DailyReflectionReturnEvidence } from
  "@/lib/domain/daily-reflection-return";

import { createDailyReflectionQueryService } from "./reflection-query-service";
import type {
  DailyReflectionAdmittedReturnSource,
  DailyReflectionGroundedCardSource,
  DailyReflectionReturnSourceSnapshot
} from "./return-source-repository";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function evidence(input: {
  cardId: string;
  date: string;
  id?: string;
  startSeconds?: number;
}): DailyReflectionReturnEvidence {
  const id = input.id ?? `segment_${input.cardId}_${input.date}`;
  const startSeconds = input.startSeconds ?? 5;
  return {
    reflectionId: `reflection_${input.cardId}_${input.date}`,
    cardId: input.cardId,
    recordingDate: input.date,
    sourceOrigin: "user_reflection",
    sourceSegmentId: id,
    startSeconds,
    endSeconds: startSeconds + 6,
    snippet: `${input.cardId} 的可核对原话`
  };
}

function memory(input: {
  memoryId: string;
  cardId?: string;
  date: string;
  title: string;
  content: string;
  memoryType?: DailyReflectionAdmittedReturnSource["memoryType"];
  cardKind?: DailyReflectionAdmittedReturnSource["cardKind"];
  actionClaimed?: boolean;
  subjectPersonId?: string | null;
  epistemicStatus?: DailyReflectionAdmittedReturnSource["epistemicStatus"];
  epistemicCaution?: DailyReflectionAdmittedReturnSource["epistemicCaution"];
  riskFlags?: DailyReflectionAdmittedReturnSource["riskFlags"];
  importance?: number;
}): DailyReflectionAdmittedReturnSource {
  const cardId = input.cardId ?? `card_${input.memoryId}`;
  return {
    memoryId: input.memoryId,
    cardId,
    reflectionId: `reflection_${input.memoryId}`,
    recordingDate: input.date,
    memoryType: input.memoryType ?? "event",
    cardKind: input.cardKind ?? "event",
    actionClaimed: input.actionClaimed ?? false,
    subjectPersonId: input.subjectPersonId ?? null,
    epistemicStatus: input.epistemicStatus ?? "explicit_user_statement",
    epistemicCaution: input.epistemicCaution ?? null,
    riskFlags: input.riskFlags ?? [],
    title: input.title,
    content: input.content,
    importance: input.importance ?? 0.7,
    evidence: [evidence({ cardId, date: input.date })]
  };
}

function card(input: {
  cardId: string;
  dates: string[];
  title: string;
  content: string;
  cardKind?: DailyReflectionGroundedCardSource["cardKind"];
  relatedCardIds?: string[];
  epistemicStatuses?: DailyReflectionGroundedCardSource["epistemicStatuses"];
  riskFlags?: DailyReflectionGroundedCardSource["riskFlags"];
  importance?: number;
}): DailyReflectionGroundedCardSource {
  return {
    cardId: input.cardId,
    reflectionIds: input.dates.map((date) => `reflection_${input.cardId}_${date}`),
    recordingDates: input.dates,
    cardKind: input.cardKind ?? "insight",
    epistemicStatuses: input.epistemicStatuses ?? ["explicit_user_statement"],
    riskFlags: input.riskFlags ?? [],
    title: input.title,
    content: input.content,
    importance: input.importance ?? 0.7,
    relatedCardIds: input.relatedCardIds ?? [],
    tags: [],
    evidence: input.dates.map((date, index) => evidence({
      cardId: input.cardId,
      date,
      startSeconds: index * 10 + 5
    }))
  };
}

function snapshot(
  input: Partial<DailyReflectionReturnSourceSnapshot> = {}
): DailyReflectionReturnSourceSnapshot {
  const workingCards = input.workingCards ?? [];
  return {
    admitted: input.admitted ?? [],
    workingCards,
    emergingCards: input.emergingCards ?? workingCards.filter(
      (item): item is DailyReflectionGroundedCardSource & {
        cardKind: "idea" | "insight";
      } => item.cardKind === "idea" || item.cardKind === "insight"
    ),
    relations: input.relations ?? []
  };
}

function service(value: DailyReflectionReturnSourceSnapshot) {
  const repository = { snapshot: vi.fn(() => value) };
  const personAuthority = {
    getConfirmedPerson: vi.fn((accountId: string, personId: string) => (
      accountId === "account_1" && personId === "person_alice_01" ? {} : null
    ))
  };
  return {
    repository,
    personAuthority,
    query: createDailyReflectionQueryService(repository, {
      now: () => NOW,
      personAuthority
    }).query
  };
}

describe("Daily Reflection explainable query service", () => {
  it("retrieves a decision and related saved Card without using unrelated content", () => {
    const decision = memory({
      memoryId: "memory_decision_ev",
      cardId: "card_decision_ev",
      date: "2026-08-20",
      title: "新能源车决定",
      content: "最后决定购买新能源车，因为日常通勤成本更低。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const reason = card({
      cardId: "card_reason_ev",
      dates: ["2026-08-19"],
      title: "新能源车通勤成本",
      content: "因为新能源车更符合日常通勤预算，所以把它作为选择理由。",
      relatedCardIds: ["card_decision_ev"]
    });
    const unrelated = memory({
      memoryId: "memory_unrelated_ev",
      date: "2026-08-23",
      title: "周末露营",
      content: "准备周末露营装备。",
      memoryType: "decision",
      cardKind: "decision",
      importance: 0.99
    });
    const fixture = service(snapshot({
      admitted: [unrelated, decision],
      workingCards: [reason]
    }));

    const result = fixture.query("account_1", {
      query: "我为什么最后选择新能源车？",
      scope: "all"
    });

    expect(result.intent).toBe("decision_reasoning");
    expect(result.insufficientEvidence).toBe(false);
    expect(result.claims.flatMap((claim) => claim.sourceMemoryIds))
      .toEqual(["memory_decision_ev"]);
    expect(result.claims.flatMap((claim) => claim.sourceCardIds))
      .toEqual(["card_decision_ev", "card_reason_ev"]);
    expect(result.answer).not.toContain("露营");
  });

  it("does not promote a saved decision Card into Decision Memory", () => {
    const savedOnly = card({
      cardId: "card_saved_decision_only",
      dates: ["2026-08-19"],
      title: "新能源车决定",
      content: "考虑选择新能源车。",
      cardKind: "decision"
    });
    const result = service(snapshot({ workingCards: [savedOnly] }))
      .query("account_1", {
        query: "我为什么选择新能源车？",
        scope: "all"
      });
    expect(result.insufficientEvidence).toBe(true);
    expect(result.claims).toEqual([]);
  });

  it("does not invent a reason from a Decision Memory without causal Evidence", () => {
    const decision = memory({
      memoryId: "memory_decision_without_reason",
      date: "2026-08-20",
      title: "换工作决定",
      content: "我决定换工作。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const relatedButNotReason = card({
      cardId: "card_related_without_reason",
      dates: ["2026-08-19"],
      title: "工作近况",
      content: "今天整理了工作资料。",
      relatedCardIds: [decision.cardId]
    });
    const result = service(snapshot({
      admitted: [decision],
      workingCards: [relatedButNotReason]
    })).query("account_1", { query: "我为什么决定换工作？", scope: "all" });
    expect(result).toMatchObject({ insufficientEvidence: true, claims: [] });
  });

  it("returns the earliest valid Idea/Insight Evidence deterministically", () => {
    const early = card({
      cardId: "card_early_project",
      dates: ["2026-07-01"],
      title: "晨间写作计划",
      content: "第一次想到建立晨间写作计划。",
      cardKind: "idea"
    });
    const late = card({
      cardId: "card_late_project",
      dates: ["2026-07-20"],
      title: "晨间写作复盘",
      content: "再次讨论晨间写作计划。",
      cardKind: "insight",
      importance: 0.99
    });
    const fixture = service(snapshot({ workingCards: [late, early] }));
    const input = { query: "我最早什么时候想到晨间写作？", scope: "all" as const };

    const first = fixture.query("account_1", input);
    const second = fixture.query("account_1", input);

    expect(first).toEqual(second);
    expect(first.intent).toBe("first_appearance");
    expect(first.claims[0]?.sourceCardIds).toEqual(["card_early_project"]);
    expect(first.claims[0]?.text).toContain("2026-07-01");
  });

  it("fails closed when first appearance is ambiguous across same-day recordings", () => {
    const first = card({
      cardId: "card_same_day_a",
      dates: ["2026-07-01"],
      title: "晨间写作想法",
      content: "想试试晨间写作。",
      cardKind: "idea"
    });
    const second = card({
      cardId: "card_same_day_b",
      dates: ["2026-07-01"],
      title: "晨间写作计划",
      content: "也记录了晨间写作。",
      cardKind: "insight"
    });
    const result = service(snapshot({ workingCards: [first, second] }))
      .query("account_1", {
        query: "最早什么时候想到晨间写作？",
        scope: "all"
      });
    expect(result.insufficientEvidence).toBe(true);
  });

  it("requires an explicit high-confidence contradiction relation for belief change", () => {
    const early = memory({
      memoryId: "memory_plan_early",
      date: "2026-08-05",
      title: "出行计划",
      content: "最初计划坐火车。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const late = memory({
      memoryId: "memory_plan_late",
      date: "2026-08-18",
      title: "出行计划",
      content: "后来决定开车。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const withRelation = service(snapshot({
      admitted: [late, early],
      relations: [{
        sourceMemoryId: early.memoryId,
        targetMemoryId: late.memoryId,
        relationType: "contradicted_by",
        confidence: 0.91
      }]
    })).query("account_1", { query: "我的出行计划后来如何变化？", scope: "all" });
    const withoutRelation = service(snapshot({ admitted: [early, late] }))
      .query("account_1", { query: "我的出行计划后来如何变化？", scope: "all" });

    expect(withRelation.claims[0]?.text).toMatch(/2026-08-05.*2026-08-18/u);
    expect(withRelation.claims[0]?.sourceMemoryIds).toEqual([
      "memory_plan_early",
      "memory_plan_late"
    ]);
    expect(withoutRelation).toMatchObject({
      insufficientEvidence: true,
      claims: [],
      confidence: 0
    });
  });

  it("orders a same-recording belief change by segment time", () => {
    const early = memory({
      memoryId: "memory_same_record_early",
      date: "2026-08-18",
      title: "采购方案",
      content: "开始倾向方案 A。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const late = memory({
      memoryId: "memory_same_record_late",
      date: "2026-08-18",
      title: "采购方案",
      content: "后来改为方案 B。",
      memoryType: "decision",
      cardKind: "decision"
    });
    early.evidence[0]!.reflectionId = "reflection_same_record";
    early.evidence[0]!.startSeconds = 10;
    early.evidence[0]!.endSeconds = 16;
    late.evidence[0]!.reflectionId = "reflection_same_record";
    late.evidence[0]!.startSeconds = 80;
    late.evidence[0]!.endSeconds = 86;
    const result = service(snapshot({
      admitted: [late, early],
      relations: [{
        sourceMemoryId: early.memoryId,
        targetMemoryId: late.memoryId,
        relationType: "contradicted_by",
        confidence: 0.9
      }]
    })).query("account_1", { query: "采购计划后来如何变化？", scope: "all" });
    expect(result.claims[0]?.text).toMatch(/方案 A.*方案 B/u);
  });

  it("rejects reverse, cross-type, reported, and unrelated belief relations", () => {
    const early = memory({
      memoryId: "memory_belief_early",
      date: "2026-08-05",
      title: "通勤方案",
      content: "最初选择公交。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const late = memory({
      memoryId: "memory_belief_late",
      date: "2026-08-18",
      title: "通勤方案",
      content: "后来改为骑车。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const preference = memory({
      memoryId: "memory_belief_preference",
      date: "2026-08-18",
      title: "通勤方案",
      content: "更喜欢骑车。",
      memoryType: "preference",
      cardKind: "insight"
    });
    const reported = memory({
      memoryId: "memory_belief_reported",
      date: "2026-08-18",
      title: "通勤方案",
      content: "听说骑车更好。",
      memoryType: "decision",
      cardKind: "decision",
      epistemicStatus: "reported_event"
    });
    const unrelated = memory({
      memoryId: "memory_belief_unrelated",
      date: "2026-08-18",
      title: "午餐方案",
      content: "后来决定自带午餐。",
      memoryType: "decision",
      cardKind: "decision"
    });
    const cases = [
      { sourceMemoryId: late.memoryId, targetMemoryId: early.memoryId },
      { sourceMemoryId: early.memoryId, targetMemoryId: preference.memoryId },
      { sourceMemoryId: early.memoryId, targetMemoryId: reported.memoryId },
      { sourceMemoryId: early.memoryId, targetMemoryId: unrelated.memoryId }
    ];
    for (const relation of cases) {
      const result = service(snapshot({
        admitted: [early, late, preference, reported, unrelated],
        relations: [{
          ...relation,
          relationType: "contradicted_by",
          confidence: 0.95
        }]
      })).query("account_1", {
        query: "通勤计划后来如何变化？",
        scope: "all"
      });
      expect(result).toMatchObject({ insufficientEvidence: true, claims: [] });
    }
  });

  it("uses conservative confidence and labels scoped first occurrence", () => {
    const first = card({
      cardId: "card_scoped_first",
      dates: ["2026-08-20"],
      title: "学习计划",
      content: "第一次想到制定学习计划。",
      cardKind: "idea"
    });
    const result = service(snapshot({ workingCards: [first] })).query(
      "account_1",
      { query: "最早什么时候想到学习计划？", scope: "last_7_days" }
    );
    expect(result.claims[0]?.text).toContain("所选时间范围内最早");
    expect(result.confidence).toBe(0.82);
  });

  it("returns only explicitly claimed commitments", () => {
    const fixture = service(snapshot({
      admitted: [
        memory({
          memoryId: "memory_claimed_action",
          date: "2026-08-22",
          title: "提交方案",
          content: "我答应周五提交方案。",
          memoryType: "commitment",
          cardKind: "action",
          actionClaimed: true
        }),
        memory({
          memoryId: "memory_unclaimed_action",
          date: "2026-08-23",
          title: "可能整理资料",
          content: "也许可以整理资料。",
          memoryType: "commitment",
          cardKind: "action",
          actionClaimed: false,
          importance: 0.99
        })
      ]
    }));
    const result = fixture.query("account_1", {
      query: "我答应过什么？",
      scope: "all"
    });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.sourceMemoryIds).toEqual(["memory_claimed_action"]);
  });

  it("uses person context only for an exact explicit personId", () => {
    const personMemory = memory({
      memoryId: "memory_person_project",
      date: "2026-08-20",
      title: "项目讨论",
      content: "我和 Alice 讨论了项目计划。",
      subjectPersonId: "person_alice_01"
    });
    const fixture = service(snapshot({ admitted: [personMemory] }));

    expect(fixture.query("account_1", {
      query: "Alice 和我讨论过什么？",
      scope: "all"
    }).insufficientEvidence).toBe(true);
    expect(fixture.query("account_1", {
      query: "What did Alice and I discuss?",
      scope: "all"
    }).insufficientEvidence).toBe(true);
    expect(fixture.query("account_1", {
      query: "关于项目讨论的记录",
      personId: "person_bob_01",
      scope: "all"
    }).insufficientEvidence).toBe(true);
    expect(fixture.query("account_1", {
      query: "关于项目讨论的记录",
      personId: "person_alice_01",
      scope: "all"
    }).claims[0]?.sourceMemoryIds).toEqual(["memory_person_project"]);
    expect(fixture.personAuthority.getConfirmedPerson).toHaveBeenCalledWith(
      "account_1",
      "person_alice_01"
    );
  });

  it("fails closed for inferred, uncertain, and low-evidence sources", () => {
    const unsafe = [
      memory({
        memoryId: "memory_ai",
        date: "2026-08-20",
        title: "创业",
        content: "模型猜测喜欢冒险。",
        epistemicStatus: "ai_inference"
      }),
      memory({
        memoryId: "memory_reported_inference",
        date: "2026-08-20",
        title: "创业",
        content: "可能喜欢冒险。",
        epistemicCaution: "reported_inference"
      }),
      memory({
        memoryId: "memory_low_evidence",
        date: "2026-08-20",
        title: "创业",
        content: "证据不足的判断。",
        riskFlags: ["low_evidence"]
      })
    ];
    const unsafeCard = card({
      cardId: "card_unknown",
      dates: ["2026-08-21"],
      title: "创业",
      content: "不确定的人格推断。",
      epistemicStatuses: ["unknown"]
    });
    const result = service(snapshot({
      admitted: unsafe,
      workingCards: [unsafeCard]
    })).query("account_1", { query: "回顾创业相关记录", scope: "all" });

    expect(result).toMatchObject({
      insufficientEvidence: true,
      claims: [],
      confidence: 0
    });
    expect(result.answer).not.toMatch(/喜欢冒险|人格/u);
  });

  it("uses server-owned seven and thirty day boundaries", () => {
    const fixture = service(snapshot());
    fixture.query("account_1", { query: "回顾项目记录", scope: "last_7_days" });
    fixture.query("account_1", { query: "回顾项目记录", scope: "last_30_days" });
    expect(fixture.repository.snapshot).toHaveBeenNthCalledWith(
      1, "account_1", "2026-08-18", "2026-08-24"
    );
    expect(fixture.repository.snapshot).toHaveBeenNthCalledWith(
      2, "account_1", "2026-07-26", "2026-08-24"
    );
  });

  it("adds a dismissible-view resurfacing payload only for repeated dates", () => {
    const repeated = card({
      cardId: "card_repeated_theme",
      dates: ["2026-07-01", "2026-08-01"],
      title: "晨间写作",
      content: "持续记录晨间写作。"
    });
    const result = service(snapshot({ workingCards: [repeated] }))
      .query("account_1", { query: "回顾晨间写作", scope: "all" });
    expect(result.resurfacing).toMatchObject({
      earliestDate: "2026-07-01",
      evidence: { recordingDate: "2026-07-01" }
    });
  });

  it("preserves account scope and performs no writes", () => {
    const fixture = service(snapshot());
    fixture.query("account_private", { query: "回顾项目记录", scope: "all" });
    expect(fixture.repository.snapshot).toHaveBeenCalledWith(
      "account_private", "0001-01-01", "2026-08-24"
    );
    expect(Object.keys(fixture.repository)).toEqual(["snapshot"]);
  });
});
