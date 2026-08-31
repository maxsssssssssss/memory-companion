import { describe, expect, it, vi } from "vitest";

import type { DailyReflectionQueryResponse } from
  "@/lib/domain/daily-reflection-query";
import type { DailyReflectionReturnEvidence } from
  "@/lib/domain/daily-reflection-return";

import {
  createDailyReflectionThinkingContextResolver
} from "./thinking-context-resolver";
import type {
  DailyReflectionAdmittedReturnSource,
  DailyReflectionGroundedCardSource,
  DailyReflectionReturnSourceSnapshot
} from "./return-source-repository";

const NOW = new Date("2026-08-26T08:00:00.000Z");

function evidence(input: {
  cardId: string;
  date?: string;
  id?: string;
  sourceOrigin?: DailyReflectionReturnEvidence["sourceOrigin"];
}): DailyReflectionReturnEvidence {
  return {
    reflectionId: `reflection_${input.cardId}`,
    cardId: input.cardId,
    recordingDate: input.date ?? "2026-08-20",
    sourceOrigin: input.sourceOrigin ?? "user_reflection",
    sourceSegmentId: input.id ?? `segment_${input.cardId}`,
    startSeconds: 5,
    endSeconds: 11,
    snippet: `${input.cardId} 的 Canonical Transcript 摘录`
  };
}

function memory(input: {
  id: string;
  cardId?: string;
  title?: string;
  content?: string;
  epistemicStatus?: DailyReflectionAdmittedReturnSource["epistemicStatus"];
  epistemicCaution?: DailyReflectionAdmittedReturnSource["epistemicCaution"];
  riskFlags?: DailyReflectionAdmittedReturnSource["riskFlags"];
  subjectPersonId?: string | null;
}): DailyReflectionAdmittedReturnSource {
  const cardId = input.cardId ?? `card_${input.id}`;
  return {
    memoryId: input.id,
    cardId,
    reflectionId: `reflection_${input.id}`,
    recordingDate: "2026-08-20",
    memoryType: "decision",
    cardKind: "decision",
    actionClaimed: false,
    subjectPersonId: input.subjectPersonId ?? null,
    epistemicStatus: input.epistemicStatus ?? "explicit_user_statement",
    epistemicCaution: input.epistemicCaution ?? null,
    riskFlags: input.riskFlags ?? [],
    title: input.title ?? "产品方向",
    content: input.content ?? "我决定先验证产品方向，再扩大投入。",
    importance: 0.8,
    evidence: [evidence({ cardId })]
  };
}

function card(input: {
  id: string;
  title?: string;
  content?: string;
  epistemicStatuses?: DailyReflectionGroundedCardSource["epistemicStatuses"];
  riskFlags?: DailyReflectionGroundedCardSource["riskFlags"];
}): DailyReflectionGroundedCardSource {
  return {
    cardId: input.id,
    reflectionIds: [`reflection_${input.id}`],
    recordingDates: ["2026-08-21"],
    cardKind: "insight",
    epistemicStatuses: input.epistemicStatuses ?? ["explicit_user_statement"],
    riskFlags: input.riskFlags ?? [],
    title: input.title ?? "产品验证灵感",
    content: input.content ?? "可以先用小实验验证产品方向。",
    importance: 0.7,
    relatedCardIds: [],
    tags: ["产品"],
    evidence: [evidence({ cardId: input.id, date: "2026-08-21" })]
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

function insufficientQueryResult(): DailyReflectionQueryResponse {
  return {
    answer: "现有可信记录里没有足够证据回答这个问题。",
    claims: [],
    intent: "memory_exploration",
    confidence: 0,
    insufficientEvidence: true,
    resurfacing: null,
    createdAt: NOW.toISOString()
  };
}

function groundedQueryResult(): DailyReflectionQueryResponse {
  const sourceEvidence = evidence({
    cardId: "card_past",
    id: "segment_past"
  });
  return {
    answer: "现有记录里，与这个主题相关的内容是：产品方向。",
    claims: [{
      text: "2026-08-20 · 产品方向\n你曾确认并保存：先做小实验。",
      sourceMemoryIds: ["memory_past"],
      sourceCardIds: ["card_past"],
      evidenceIds: [sourceEvidence.sourceSegmentId],
      evidence: [sourceEvidence],
      epistemicStatuses: ["explicit_user_statement"]
    }],
    intent: "memory_exploration",
    confidence: 0.64,
    insufficientEvidence: false,
    resurfacing: null,
    createdAt: NOW.toISOString()
  };
}

describe("Daily Reflection thinking context resolver", () => {
  it("does not call personal repositories when contextMode is none", () => {
    const sourceRepository = { snapshot: vi.fn(() => snapshot()) };
    const queryService = { query: vi.fn(() => insufficientQueryResult()) };
    const resolver = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      queryService,
      now: () => NOW
    });

    expect(resolver.resolve({
      accountId: "account_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想下一步。"
    })).toEqual({
      promptExcerpts: [],
      sources: [],
      usedPersonalContext: false,
      pastClues: null
    });
    expect(sourceRepository.snapshot).not.toHaveBeenCalled();
    expect(queryService.query).not.toHaveBeenCalled();
  });

  it("treats an empty personal snapshot as a normal zero-result", () => {
    const sourceRepository = { snapshot: vi.fn(() => snapshot()) };
    const result = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      now: () => NOW
    }).resolve({
      accountId: "account_1",
      mode: "brainstorm",
      contextMode: "personal",
      message: "一起想想下一步。"
    });

    expect(result).toMatchObject({
      sources: [],
      promptExcerpts: [],
      usedPersonalContext: false,
      pastClues: null
    });
    expect(sourceRepository.snapshot).toHaveBeenCalledWith(
      "account_1",
      "0001-01-01",
      "2026-08-26"
    );
  });

  it("returns pinned canonical Memory and saved Working Card sources first", () => {
    const admitted = memory({ id: "memory_direction" });
    const savedCard = card({ id: "card_experiment" });
    const sourceRepository = {
      snapshot: vi.fn(() => snapshot({
        admitted: [admitted],
        workingCards: [savedCard]
      }))
    };
    const result = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      now: () => NOW
    }).resolve({
      accountId: "account_1",
      mode: "extend_idea",
      contextMode: "personal",
      message: "继续想想产品方向",
      pinnedCardIds: [savedCard.cardId]
    });

    expect(result.usedPersonalContext).toBe(true);
    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "card_experiment",
      "memory_direction"
    ]);
    expect(result.sources[0]?.claim.evidenceIds).toEqual([
      "segment_card_experiment"
    ]);
    expect(result.promptExcerpts[0]).toContain("产品验证灵感");
    expect(result.promptExcerpts[0]).toContain("2026-08-21 0:05");
    expect(result.promptExcerpts[0]).toContain("Canonical Transcript 摘录");
  });

  it("keeps cross-account and unavailable pinned IDs out of context", () => {
    const accountOneMemory = memory({ id: "memory_account_one" });
    const sourceRepository = {
      snapshot: vi.fn((accountId: string) => accountId === "account_1"
        ? snapshot({ admitted: [accountOneMemory] })
        : snapshot())
    };
    const result = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      now: () => NOW
    }).resolve({
      accountId: "account_2",
      mode: "clarify_decision",
      contextMode: "personal",
      message: "产品方向",
      pinnedMemoryIds: [accountOneMemory.memoryId],
      pinnedCardIds: [
        "card_revoked",
        "card_rejected",
        "card_removed",
        "card_unavailable"
      ]
    });

    expect(sourceRepository.snapshot).toHaveBeenCalledWith(
      "account_2",
      "0001-01-01",
      "2026-08-26"
    );
    expect(result.sources).toEqual([]);
    expect(result.usedPersonalContext).toBe(false);
  });

  it("filters unknown, AI inference, unsafe risk and person-scoped facts", () => {
    const safe = memory({ id: "memory_safe" });
    const unknown = memory({
      id: "memory_unknown",
      epistemicStatus: "unknown"
    });
    const inferred = memory({
      id: "memory_inferred",
      epistemicStatus: "ai_inference"
    });
    const lowEvidence = card({
      id: "card_low_evidence",
      riskFlags: ["low_evidence"]
    });
    const personFact = memory({
      id: "memory_person_fact",
      subjectPersonId: "person_unconfirmed"
    });
    const sourceRepository = {
      snapshot: vi.fn(() => snapshot({
        admitted: [safe, unknown, inferred, personFact],
        workingCards: [lowEvidence]
      }))
    };
    const result = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      now: () => NOW
    }).resolve({
      accountId: "account_1",
      mode: "compare_directions",
      contextMode: "personal",
      message: "产品方向",
      pinnedMemoryIds: [
        unknown.memoryId,
        inferred.memoryId,
        personFact.memoryId
      ],
      pinnedCardIds: [lowEvidence.cardId]
    });

    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "memory_safe"
    ]);
    expect(result.sources[0]?.claim.epistemicStatuses).toEqual([
      "explicit_user_statement"
    ]);
  });

  it("does not scan personal repositories for an unrelated auto request", () => {
    const sourceRepository = {
      snapshot: vi.fn(() => snapshot({ admitted: [memory({ id: "memory_1" })] }))
    };
    const result = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      now: () => NOW
    }).resolve({
      accountId: "account_1",
      mode: "brainstorm",
      contextMode: "auto",
      message: "给我三个全新的包装创意"
    });

    expect(result.sources).toEqual([]);
    expect(sourceRepository.snapshot).not.toHaveBeenCalled();
  });

  it("tries auto context only when a personal-history cue has a topic", () => {
    const sourceRepository = {
      snapshot: vi.fn(() => snapshot({
        admitted: [memory({ id: "memory_auto_direction" })]
      }))
    };
    const result = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      now: () => NOW
    }).resolve({
      accountId: "account_1",
      mode: "extend_idea",
      contextMode: "auto",
      message: "我之前关于产品方向的记录能带来什么启发？"
    });

    expect(sourceRepository.snapshot).toHaveBeenCalledTimes(1);
    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "memory_auto_direction"
    ]);
  });

  it("uses the deterministic query service for grounded past clues", () => {
    const sourceRepository = { snapshot: vi.fn(() => snapshot()) };
    const queryService = { query: vi.fn(() => groundedQueryResult()) };
    const result = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      queryService,
      now: () => NOW
    }).resolve({
      accountId: "account_1",
      mode: "past_clues",
      contextMode: "personal",
      message: "过去关于产品方向有哪些线索？"
    });

    expect(queryService.query).toHaveBeenCalledWith("account_1", {
      query: "过去关于产品方向有哪些线索？",
      scope: "all"
    });
    expect(sourceRepository.snapshot).not.toHaveBeenCalled();
    expect(result.pastClues).toMatchObject({ insufficientEvidence: false });
    expect(result.pastClues?.queryResult?.claims).toHaveLength(1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.sourceId).toBe("memory_past");
    expect(result.sources[0]?.claim.evidenceIds).toEqual(["segment_past"]);
  });

  it("returns explicit insufficiency when past clues have no Evidence", () => {
    const sourceRepository = { snapshot: vi.fn(() => snapshot()) };
    const queryService = { query: vi.fn(() => insufficientQueryResult()) };
    const result = createDailyReflectionThinkingContextResolver({
      sourceRepository,
      queryService,
      now: () => NOW
    }).resolve({
      accountId: "account_1",
      mode: "past_clues",
      contextMode: "personal",
      message: "过去关于量子花园有哪些线索？",
      pinnedMemoryIds: ["memory_missing"]
    });

    expect(result.sources).toEqual([]);
    expect(result.usedPersonalContext).toBe(false);
    expect(result.pastClues).toMatchObject({
      queryResult: { claims: [], insufficientEvidence: true },
      insufficientEvidence: true
    });
    expect(sourceRepository.snapshot).not.toHaveBeenCalled();
  });
});
