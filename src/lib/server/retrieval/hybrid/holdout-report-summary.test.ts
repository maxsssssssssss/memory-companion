import { describe, expect, it } from "vitest";
import {
  parseFixedHybridReport,
  summarizeFixedHybridReportPair,
  type FixedHybridReport
} from "./holdout-report-summary";

const systems = [
  "current",
  "hybridOptimizedRanking",
  "hybridPhase31Ranking"
] as const;

function report(input: {
  generatedAt?: string;
  reversePhase31?: boolean;
  includeExactDiagnostics?: boolean;
  indexingEmbedded?: number;
} = {}): FixedHybridReport {
  const includeExact = input.includeExactDiagnostics ?? true;
  const cases = [
    {
      id: "h01",
      scope: "week",
      category: "lifecycle",
      retrievalEvaluable: true,
      availableExpectedGroupCount: 2,
      ranks: {
        current: 12,
        hybridOptimizedRanking: 8,
        hybridPhase31Ranking: 3
      },
      recallAt30: {
        current: 0.5,
        hybridOptimizedRanking: 1,
        hybridPhase31Ranking: 1
      },
      ...(includeExact
        ? {
            candidateIds: {
              current: ["e2", "e1"],
              hybridOptimizedRanking: ["e1", "e2"],
              hybridPhase31Ranking: input.reversePhase31
                ? ["e2", "e1"]
                : ["e1", "e2"]
            },
            goldGroupRanks: {
              current: [12, null],
              hybridOptimizedRanking: [8, 20],
              hybridPhase31Ranking: [3, 9]
            }
          }
        : {})
    },
    {
      id: "h02",
      scope: "all",
      category: "preference",
      retrievalEvaluable: true,
      availableExpectedGroupCount: 1,
      ranks: {
        current: 2,
        hybridOptimizedRanking: 2,
        hybridPhase31Ranking: 2
      },
      recallAt30: {
        current: 1,
        hybridOptimizedRanking: 1,
        hybridPhase31Ranking: 1
      },
      ...(includeExact
        ? {
            candidateIds: {
              current: ["e3"],
              hybridOptimizedRanking: ["e3"],
              hybridPhase31Ranking: ["e3"]
            },
            goldGroupRanks: {
              current: [2],
              hybridOptimizedRanking: [2],
              hybridPhase31Ranking: [2]
            }
          }
        : {})
    }
  ];
  return parseFixedHybridReport({
    version: 2,
    kind: "daily_brief_hybrid_retrieval_shadow_benchmark",
    generatedAt: input.generatedAt ?? "2026-07-29T00:00:00.000Z",
    reproducibility: {
      fixtureHash: "fixture",
      canonicalUniverseHash: "universe",
      embeddingModel: {
        modelName: "Qwen/Qwen3-Embedding-0.6B",
        modelVersion: "revision",
        dimension: 1024
      }
    },
    baseline: { sourceCaseCount: 2, benchmarkEvaluableCaseCount: 2 },
    indexing: {
      total: 3,
      embedded: input.indexingEmbedded ?? 3,
      unchanged: 0,
      removed: 0
    },
    memoryIndexing: { total: 2, embedded: 2, unchanged: 0, removed: 0 },
    systems: Object.fromEntries(systems.map((name) => [
      name,
      {
        metrics: {
          recallAt5: name === "hybridPhase31Ranking" ? 1 : 0.5,
          recallAt10: name === "current" ? 0.5 : 1,
          recallAt16: name === "current" ? 0.5 : 1,
          recallAt30: 1,
          mrr: name === "hybridPhase31Ranking" ? 0.42 : 0.25,
          ndcgAt10: name === "hybridPhase31Ranking" ? 0.5 : 0.3,
          canonicalCandidateValidity: 1,
          recoveredCompleteMisses: 1,
          averageCandidateCount: 3
        },
        latency: { p50Ms: 1, p95Ms: 2 }
      }
    ])),
    categories: {},
    phase5Experiments: {},
    phase5Categories: {},
    cases
  });
}

describe("fixed holdout report summary", () => {
  it("ignores timestamps, latency, and first-index differences", () => {
    const summary = summarizeFixedHybridReportPair({
      runA: report({ indexingEmbedded: 3 }),
      runB: report({
        generatedAt: "2026-07-29T01:00:00.000Z",
        indexingEmbedded: 0
      }),
      bootstrapSeed: 42,
      bootstrapIterations: 500
    });

    expect(summary.determinism.identityEqual).toBe(true);
    expect(summary.determinism.systemMetricsEqual).toBe(true);
    expect(summary.determinism.candidateOrdering.mode).toBe("candidate_ids");
    expect(summary.determinism.candidateOrdering.exact).toBe(true);
    expect(summary.determinism.normalizedReportEqual).toBe(true);
    expect(summary.bootstrap.basis).toBe("gold_group_ranks");
    expect(summary.movementSummary.phase31VsCurrent).toEqual({
      improved: 1,
      unchanged: 1,
      regressed: 0
    });
  });

  it("detects a candidate-order change even when aggregate metrics match", () => {
    const summary = summarizeFixedHybridReportPair({
      runA: report(),
      runB: report({ reversePhase31: true }),
      bootstrapIterations: 100
    });

    expect(summary.determinism.systemMetricsEqual).toBe(true);
    expect(summary.determinism.candidateOrdering.exact).toBe(false);
    expect(summary.determinism.normalizedReportEqual).toBe(false);
  });

  it("marks legacy reports as a first-gold projection fallback", () => {
    const summary = summarizeFixedHybridReportPair({
      runA: report({ includeExactDiagnostics: false }),
      runB: report({ includeExactDiagnostics: false }),
      bootstrapIterations: 100
    });

    expect(summary.determinism.candidateOrdering.mode).toBe(
      "first_gold_rank_and_recall_at_30_projection"
    );
    expect(summary.determinism.candidateOrdering.fullCandidateOrderSerialized)
      .toBe(false);
    expect(summary.bootstrap.basis).toBe("first_gold_case_hit_fallback");
    expect(summary.bootstrap.caveat).toMatch(/cannot be reconstructed/u);
  });
});
