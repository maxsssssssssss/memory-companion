import { describe, expect, it } from "vitest";
import type { QaRetrievedEvidence } from "../ai-qa";
import {
  rankHybridEvidence,
  rankHybridEvidenceForReview,
  scoreHybridEvidenceCandidates,
  type EvidenceRankingExperiment
} from "./evidence-ranking";
import type {
  EvidenceRankingMetadata,
  HybridEvidenceCandidate
} from "./types";

function candidate(
  id: string,
  text: string,
  denseScore = 0.8,
  overrides: Partial<QaRetrievedEvidence> = {}
): HybridEvidenceCandidate {
  return {
    evidence: {
      id,
      kind: "raw",
      title: id,
      text,
      startSeconds: 0,
      endSeconds: 10,
      sourceSegmentIds: [`segment-${id}`],
      priority: 1,
      ...overrides
    },
    rrfScore: 0.02,
    channelRanks: { dense: 1 },
    denseScore
  };
}

describe("Hybrid Evidence ranking", () => {
  it("ranks the final resolved lifecycle state above the initial plan", () => {
    const initial = candidate("initial", "我最初想买车，还在考虑燃油车。", 0.92);
    const changed = candidate("changed", "后来开始考虑新能源车，但还没有决定。", 0.9);
    const final = candidate("final", "最终明确决定购买新能源车，已经完成下单。", 0.82);
    const metadata = new Map<string, EvidenceRankingMetadata>([
      ["initial", { recordingDate: "2026-06-29", memoryStatus: "active" }],
      ["changed", { recordingDate: "2026-07-03", memoryStatus: "active" }],
      ["final", { recordingDate: "2026-07-09", memoryStatus: "resolved" }]
    ]);

    const ranked = rankHybridEvidence({
      question: "后来最终选择了什么车？",
      candidates: [initial, changed, final],
      metadata
    });

    expect(ranked[0]?.evidence.id).toBe("final");
    expect(ranked[0]?.lifecycleState).toBe("resolved");
    expect(ranked[0]!.features.lifecycle).toBeGreaterThan(
      ranked.find((item) => item.evidence.id === "initial")!.features.lifecycle
    );
  });

  it("uses occurrence, distinct dates, and active state for long-term preferences", () => {
    const oneOff = candidate("one-off", "我今天喜欢喝乌龙茶。", 0.93);
    const repeated = candidate("repeated", "多次记录显示我更喜欢乌龙茶。", 0.83);
    const metadata = new Map<string, EvidenceRankingMetadata>([
      ["one-off", {
        memoryType: "preference",
        memoryStatus: "resolved",
        occurrenceCount: 1,
        distinctDates: 1
      }],
      ["repeated", {
        memoryType: "preference",
        memoryStatus: "active",
        occurrenceCount: 5,
        distinctDates: 4
      }]
    ]);

    const ranked = rankHybridEvidence({
      question: "我长期喜欢喝什么？",
      candidates: [oneOff, repeated],
      metadata
    });

    expect(ranked[0]?.evidence.id).toBe("repeated");
    expect(ranked[0]!.features.preference).toBeGreaterThan(ranked[1]!.features.preference);
  });

  it("uses entity and relationship signal features and keeps Top-16", () => {
    const alice = candidate("alice", "Alice 在我焦虑时认真倾听。", 0.78, {
      kind: "relationship_signal",
      relationshipSignal: {
        sourceId: "card-alice",
        label: "active_listening",
        category: "positive",
        confidence: 0.9,
        caution: "单次信号",
        recordingDate: "2026-07-09"
      }
    });
    const bob = candidate("bob", "Bob 提供了一些建议。", 0.9, {
      kind: "relationship_signal"
    });
    const noise = Array.from({ length: 20 }, (_, index) =>
      candidate(`noise-${index}`, `普通记录 ${index}`, 0.5)
    );

    const ranked = rankHybridEvidence({
      question: "Alice 和我的关系是什么？",
      candidates: [bob, ...noise, alice],
      metadata: new Map([
        ["alice", { entities: ["Alice"], memoryType: "relationship_signal" }],
        ["bob", { entities: ["Bob"], memoryType: "relationship_signal" }]
      ])
    });

    expect(ranked).toHaveLength(16);
    expect(ranked[0]?.evidence.id).toBe("alice");
    expect(ranked[0]!.features.entity).toBe(1);
    expect(ranked[0]!.features.relationship).toBeGreaterThan(0.8);
  });

  it("keeps every feature ablation deterministic and exposes its contribution breakdown", () => {
    const candidates = [
      candidate("initial", "最初考虑换工作。", 0.84),
      candidate("final", "后来最终决定换工作。", 0.81),
      candidate("noise", "普通记录。", 0.76)
    ];
    const metadata = new Map<string, EvidenceRankingMetadata>([
      ["initial", {
        recordingDate: "2026-07-01",
        recordingId: "day-1",
        memoryStatus: "active"
      }],
      ["final", {
        recordingDate: "2026-07-08",
        recordingId: "day-8",
        memoryStatus: "resolved"
      }]
    ]);
    const experiments: EvidenceRankingExperiment[] = [
      "semantic_only",
      "lexical_only",
      "temporal_only",
      "entity_only",
      "lifecycle_only",
      "preference_only",
      "relationship_only",
      "importance_only",
      "current_full",
      "query_category_gated",
      "per_category_weights"
    ];

    for (const experiment of experiments) {
      const first = scoreHybridEvidenceCandidates({
        question: "后来最终为什么决定换工作？",
        candidates,
        metadata,
        experiment
      });
      const second = scoreHybridEvidenceCandidates({
        question: "后来最终为什么决定换工作？",
        candidates,
        metadata,
        experiment
      });
      expect(second.map((item) => item.evidence.id)).toEqual(
        first.map((item) => item.evidence.id)
      );
      for (const item of first) {
        expect(Object.values(item.contributions).reduce((sum, value) => sum + value, 0))
          .toBeCloseTo(item.score);
      }
    }
  });

  it("preserves the Current Top-10 floor for the optimized temporal ranking", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      ...candidate(`e-${index}`, `第 ${index} 条时间记录`, 0.99 - index / 100),
      channelRanks: {
        dense: 20 - index,
        ...(index < 16 ? { current: index + 1 } : {})
      }
    }));

    const ranked = scoreHybridEvidenceCandidates({
      question: "最近发生了什么？",
      candidates: candidates.slice().reverse(),
      metadata: new Map(
        candidates.map((item, index) => [
          item.evidence.id,
          {
            recordingDate: `2026-07-${String((index % 20) + 1).padStart(2, "0")}`,
            recordingId: `recording-${index}`
          }
        ])
      ),
      experiment: "per_category_weights"
    });

    expect(new Set(ranked.slice(0, 10).map((item) => item.evidence.id))).toEqual(
      new Set(Array.from({ length: 10 }, (_, index) => `e-${index}`))
    );
  });

  it("preserves Current relationship order while keeping explainable scores", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      ...candidate(`relationship-${index}`, `双方互动记录 ${index}`, 0.6 + index / 100),
      channelRanks: {
        dense: 20 - index,
        ...(index < 16 ? { current: index + 1 } : {})
      }
    })).reverse();

    const ranked = scoreHybridEvidenceCandidates({
      question: "双方有哪些沟通方式和约定？",
      candidates,
      experiment: "per_category_weights"
    });

    expect(ranked.slice(0, 16).map((item) => item.evidence.id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `relationship-${index}`)
    );
    expect(ranked.every((item) => Number.isFinite(item.score))).toBe(true);
  });

  it("gates lifecycle state by topic relevance in Phase 3.1", () => {
    const unrelatedResolved = candidate(
      "unrelated-resolved",
      "健身房会员已经完成续费。",
      0.86
    );
    const museumFinal = candidate(
      "museum-final",
      "博物馆计划今天已经落实，两个展项都看完了。",
      0.78
    );
    const ranked = scoreHybridEvidenceCandidates({
      question: "博物馆计划最后落实了吗，结果是什么？",
      candidates: [unrelatedResolved, museumFinal],
      metadata: new Map([
        ["unrelated-resolved", { memoryStatus: "resolved", recordingDate: "2026-07-09" }],
        ["museum-final", { memoryStatus: "resolved", recordingDate: "2026-07-08" }]
      ]),
      experiment: "phase3_1_minimal"
    });

    const final = ranked.find((item) => item.evidence.id === "museum-final")!;
    const unrelated = ranked.find(
      (item) => item.evidence.id === "unrelated-resolved"
    )!;
    expect(final.lifecycleTopicOverlap).toBeGreaterThan(0);
    expect(unrelated.features.lifecycle).toBeLessThan(final.features.lifecycle);
  });

  it("caps and relevance-gates importance so it cannot outrank direct evidence", () => {
    const relevant = candidate(
      "relevant",
      "简历检查的完整批注已经交付。",
      0.72,
      { priority: 1 }
    );
    const importantNoise = candidate(
      "important-noise",
      "今天安排了一个非常重要的牙科预约。",
      0.83,
      { priority: 20 }
    );
    const ranked = scoreHybridEvidenceCandidates({
      question: "简历完整检查是否交付？",
      candidates: [importantNoise, relevant],
      metadata: new Map([
        ["important-noise", { importanceScore: 1 }],
        ["relevant", { memoryStatus: "resolved", importanceScore: 0.1 }]
      ]),
      experiment: "phase3_1_minimal"
    });

    expect(ranked[0]?.evidence.id).toBe("relevant");
    expect(ranked[1]!.features.importance).toBeLessThanOrEqual(0.35);
  });

  it("reserves initial, change, and final lifecycle representatives in Top-16", () => {
    const chain = [
      candidate("initial-plan", "最初计划周六去博物馆。", 0.54),
      candidate("changed-plan", "后来因为大雨取消，准备改期。", 0.52),
      candidate("final-result", "最终已经去了博物馆，计划落实。", 0.5)
    ];
    const noise = Array.from({ length: 20 }, (_, index) =>
      candidate(`noise-chain-${index}`, `其他事项 ${index}`, 0.99 - index / 100)
    );
    const ranked = scoreHybridEvidenceCandidates({
      question: "博物馆计划从最初提出、后来改期到最终完成的完整过程是什么？",
      candidates: [...noise, ...chain],
      metadata: new Map([
        ["initial-plan", { recordingDate: "2026-07-01", memoryStatus: "active" }],
        ["changed-plan", { recordingDate: "2026-07-04", memoryStatus: "active" }],
        ["final-result", { recordingDate: "2026-07-08", memoryStatus: "resolved" }]
      ]),
      experiment: "phase3_1_minimal"
    });
    const top16 = new Set(ranked.slice(0, 16).map((item) => item.evidence.id));

    expect(top16.has("initial-plan")).toBe(true);
    expect(top16.has("changed-plan")).toBe(true);
    expect(top16.has("final-result")).toBe(true);
  });

  it("keeps Phase 3.1 feature contributions deterministic", () => {
    const candidates = [
      candidate("direct", "Alice 希望计划变化时提前说明。", 0.8),
      candidate("noise", "普通记录。", 0.9)
    ];
    const run = () => scoreHybridEvidenceCandidates({
      question: "Alice 提出的沟通边界是什么？",
      candidates,
      metadata: new Map([["direct", { entities: ["Alice"] }]]),
      experiment: "phase3_1_minimal"
    });
    const first = run();
    const second = run();

    expect(second).toEqual(first);
    expect(first[0]?.evidence.id).toBe("direct");
  });

  it("exposes a review-only Top-30 whose prefix matches the production Top-16", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      ...candidate(
        `review-${index}`,
        `review evidence ${index}`,
        0.99 - index / 100
      ),
      channelRanks: {
        dense: index + 1
      }
    }));
    const input = {
      question: "What evidence is available?",
      candidates,
      experiment: "phase3_1_minimal" as const
    };

    const reviewTop30 = rankHybridEvidenceForReview(input);
    const productionTop16 = rankHybridEvidence({
      ...input,
      limit: 30
    });

    expect(reviewTop30).toHaveLength(30);
    expect(productionTop16).toHaveLength(16);
    expect(productionTop16).toEqual(reviewTop30.slice(0, 16));
    expect(reviewTop30[0]).toMatchObject({
      rank: 1,
      features: expect.any(Object),
      weights: expect.any(Object),
      contributions: expect.any(Object),
      rankingGuards: expect.any(Array)
    });
  });
});
