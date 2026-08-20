import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  indexCanonicalEvidence,
  retrieveDenseEvidence,
  type DenseEvidenceCandidate,
  type EvidenceIndexingResult
} from "./dense-retrieval";
import type { EmbeddingProvider } from "./embedding-provider";
import {
  scoreHybridEvidenceCandidates,
  type EvidenceRankingExperiment,
  type RankedHybridEvidence
} from "./evidence-ranking";
import {
  generateHybridCandidatesWithDiagnostics,
  hybridCandidateCitationValidity,
  type HybridCandidateDiagnostics
} from "./hybrid-candidates";
import { SqliteEmbeddingIndex } from "./embedding-index";
import {
  expandMemoriesToCanonicalEvidence,
  indexMemoryItems,
  retrieveDenseMemories,
  retrieveStructuredMemories,
  type MemoryExpansionDiagnostics,
  type MemoryExpansionMode,
  type MemoryIndexingResult
} from "./memory-expansion";
import { parseHybridQuery } from "./query-parser";
import {
  orderHybridCandidatesByRerankerScores,
  rerankHybridCandidates
} from "./rerank";
import type { RerankerProvider } from "./reranker-provider";
import type {
  HybridEvidenceCandidate,
  HybridFusionStrategy
} from "./types";
import {
  loadHybridBenchmarkCases,
  type HybridBenchmarkCase
} from "./benchmark";
import type { QaRetrievedEvidence } from "../ai-qa";
import {
  HYBRID_OPTIMIZED_RANKING_V1,
  HYBRID_PHASE31_SHADOW_V1,
  PHASE_3_1_RANKING_VERSION
} from "./shadow-baseline";
import type { BenchmarkCaseContribution } from "./benchmark-statistics";
import {
  PHASE_3_1_REGRESSION_CASE_IDS,
  type RankingRegressionCaseId
} from "./ranking-regression-fixture";

const FUSION_STRATEGIES: HybridFusionStrategy[] = [
  "uniform_rrf",
  "weighted_rrf",
  "query_gated_rrf",
  "quota_rrf",
  "union_then_rrf",
  "dynamic_dense_rrf",
  "guarded_rrf"
];

const RANKING_EXPERIMENTS: EvidenceRankingExperiment[] = [
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
  "per_category_weights",
  "importance_capped",
  "relevance_gated_importance",
  "lifecycle_chain_reservation",
  "final_state_gated_boost",
  "calibrated_semantic",
  "exact_entity_lexical",
  "top16_chain_protection",
  "phase3_1_minimal"
];

const PRIMARY_FUSION_STRATEGY: HybridFusionStrategy = "uniform_rrf";
const PRIMARY_RANKING_EXPERIMENT: EvidenceRankingExperiment = "per_category_weights";
const PHASE_3_1_RANKING_EXPERIMENT: EvidenceRankingExperiment = "phase3_1_minimal";
const MEMORY_EXPANSION_MODES: MemoryExpansionMode[] = [
  "structured",
  "dense",
  "structured_dense"
];
const MEMORY_EXPANSION_QUOTAS = [3, 6, 10] as const;
const PRIMARY_MEMORY_QUOTA = 6;

function memoryExperimentName(mode: MemoryExpansionMode, quota: number) {
  return `memory_${mode}_top${quota}`;
}

export type BenchmarkMetricSet = {
  recallAt5: number;
  recallAt10: number;
  recallAt16: number;
  recallAt30: number;
  mrr: number;
  ndcgAt10: number;
  canonicalCandidateValidity: number;
  recoveredCompleteMisses: number;
  averageCandidateCount: number;
};

type CandidateSystemMap = Map<string, readonly QaRetrievedEvidence[]>;

function availableExpectedGroups(item: HybridBenchmarkCase) {
  const missing = new Set(item.missingExpectedGroups.map((group) => group.join("|")));
  return item.expectedGroups.filter((group) => !missing.has(group.join("|")));
}

function evaluableCases(cases: readonly HybridBenchmarkCase[]) {
  return cases.filter((item) =>
    item.retrievalEvaluable && availableExpectedGroups(item).length > 0
  );
}

function candidateHitsGroup(candidate: QaRetrievedEvidence, group: readonly string[]) {
  const expected = new Set(group);
  return candidate.sourceSegmentIds.some((id) => expected.has(id));
}

function retrievedGroupCount(
  item: HybridBenchmarkCase,
  candidates: readonly QaRetrievedEvidence[],
  limit: number
) {
  return availableExpectedGroups(item).filter((group) =>
    candidates.slice(0, limit).some((candidate) => candidateHitsGroup(candidate, group))
  ).length;
}

function firstExpectedRank(
  item: HybridBenchmarkCase,
  candidates: readonly QaRetrievedEvidence[]
) {
  const groups = availableExpectedGroups(item);
  const index = candidates.findIndex((candidate) =>
    groups.some((group) => candidateHitsGroup(candidate, group))
  );
  return index < 0 ? null : index + 1;
}

function expectedGroupRanks(
  item: HybridBenchmarkCase,
  candidates: readonly QaRetrievedEvidence[]
) {
  return availableExpectedGroups(item).map((group, groupIndex) => {
    const index = candidates.findIndex((candidate) =>
      candidateHitsGroup(candidate, group)
    );
    return {
      groupIndex,
      rank: index < 0 ? null : index + 1
    };
  });
}

export type BenchmarkGoldGroupRankRegression = {
  groupIndex: number;
  sourceSegmentIds: string[];
  goldEvidenceId: string;
  beforeRank: number;
  afterRank: number | null;
};

export function benchmarkGoldGroupRankRegressions(input: {
  item: HybridBenchmarkCase;
  beforeCandidates: readonly QaRetrievedEvidence[];
  afterCandidates: readonly QaRetrievedEvidence[];
}): BenchmarkGoldGroupRankRegression[] {
  const groups = availableExpectedGroups(input.item);
  const beforeRanks = expectedGroupRanks(input.item, input.beforeCandidates);
  const afterRanks = expectedGroupRanks(input.item, input.afterCandidates);
  return beforeRanks.flatMap((before) => {
    if (before.rank === null) return [];
    const afterRank = afterRanks[before.groupIndex]?.rank ?? null;
    if (afterRank !== null && afterRank <= before.rank) return [];
    const goldEvidence = input.beforeCandidates[before.rank - 1];
    if (!goldEvidence) return [];
    return [{
      groupIndex: before.groupIndex,
      sourceSegmentIds: [...(groups[before.groupIndex] ?? [])],
      goldEvidenceId: goldEvidence.id,
      beforeRank: before.rank,
      afterRank
    }];
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizedDiscountedGroupCoverage(
  item: HybridBenchmarkCase,
  candidates: readonly QaRetrievedEvidence[],
  limit: number
) {
  const groups = availableExpectedGroups(item);
  if (groups.length === 0) return 0;
  const covered = new Set<number>();
  let discounted = 0;
  candidates.slice(0, limit).forEach((candidate, index) => {
    groups.forEach((group, groupIndex) => {
      if (!covered.has(groupIndex) && candidateHitsGroup(candidate, group)) {
        covered.add(groupIndex);
        discounted += 1 / Math.log2(index + 2);
      }
    });
  });
  return discounted / groups.length;
}

function candidateValid(
  candidate: QaRetrievedEvidence,
  canonical: readonly QaRetrievedEvidence[]
) {
  const current = canonical.find((item) => item.id === candidate.id);
  return Boolean(
    current &&
    current.sourceSegmentIds.length > 0 &&
    current.sourceSegmentIds.length === candidate.sourceSegmentIds.length &&
    current.sourceSegmentIds.every((id, index) => id === candidate.sourceSegmentIds[index])
  );
}

export function benchmarkMetrics(input: {
  cases: readonly HybridBenchmarkCase[];
  candidates: CandidateSystemMap;
}): BenchmarkMetricSet {
  const cases = evaluableCases(input.cases);
  const totalGroups = cases.reduce(
    (sum, item) => sum + availableExpectedGroups(item).length,
    0
  );
  const recall = (limit: number) =>
    cases.reduce((sum, item) =>
      sum + retrievedGroupCount(item, input.candidates.get(item.id) ?? [], limit), 0
    ) / Math.max(1, totalGroups);
  const reciprocalRanks = cases.map((item) => {
    const rank = firstExpectedRank(item, input.candidates.get(item.id) ?? []);
    return rank ? 1 / rank : 0;
  });
  const ndcg = cases.map((item) =>
    normalizedDiscountedGroupCoverage(item, input.candidates.get(item.id) ?? [], 10)
  );
  let valid = 0;
  let total = 0;
  for (const item of input.cases) {
    for (const candidate of input.candidates.get(item.id) ?? []) {
      total += 1;
      if (candidateValid(candidate, item.canonicalEvidence)) valid += 1;
    }
  }
  const misses = cases.filter((item) =>
    item.retrievalFailures.includes("retrieval_miss")
  );
  const recoveredCompleteMisses = misses.filter((item) =>
    retrievedGroupCount(
      item,
      input.candidates.get(item.id) ?? [],
      30
    ) === availableExpectedGroups(item).length
  ).length;
  const counts = input.cases.map((item) =>
    (input.candidates.get(item.id) ?? []).length
  );
  return {
    recallAt5: recall(5),
    recallAt10: recall(10),
    recallAt16: recall(16),
    recallAt30: recall(30),
    mrr: reciprocalRanks.reduce((sum, value) => sum + value, 0) /
      Math.max(1, reciprocalRanks.length),
    ndcgAt10: ndcg.reduce((sum, value) => sum + value, 0) /
      Math.max(1, ndcg.length),
    canonicalCandidateValidity: total === 0 ? 1 : valid / total,
    recoveredCompleteMisses,
    averageCandidateCount: counts.reduce((sum, value) => sum + value, 0) /
      Math.max(1, counts.length)
  };
}

export function benchmarkCaseContribution(input: {
  item: HybridBenchmarkCase;
  candidates: readonly QaRetrievedEvidence[];
}): BenchmarkCaseContribution {
  const groupCount = availableExpectedGroups(input.item).length;
  const firstGoldRank = firstExpectedRank(input.item, input.candidates);
  return {
    caseId: input.item.id,
    groupCount,
    hitsAt5: retrievedGroupCount(input.item, input.candidates, 5),
    hitsAt10: retrievedGroupCount(input.item, input.candidates, 10),
    hitsAt16: retrievedGroupCount(input.item, input.candidates, 16),
    hitsAt30: retrievedGroupCount(input.item, input.candidates, 30),
    firstGoldRank,
    reciprocalRank: firstGoldRank ? 1 / firstGoldRank : 0,
    ndcgAt10: normalizedDiscountedGroupCoverage(input.item, input.candidates, 10)
  };
}

function latencySummary(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
  return {
    count: sorted.length,
    averageMs: sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? 0
  };
}

function systemMap(
  cases: readonly HybridBenchmarkCase[],
  values: ReadonlyMap<string, readonly QaRetrievedEvidence[]>
) {
  return new Map(cases.map((item) => [item.id, values.get(item.id) ?? []]));
}

function categoryCaseSets(cases: readonly HybridBenchmarkCase[]) {
  const categories = new Map<string, HybridBenchmarkCase[]>();
  for (const item of cases) {
    const source = categories.get(item.category) ?? [];
    source.push(item);
    categories.set(item.category, source);
    if (parseHybridQuery(item.question).types.includes("temporal")) {
      const temporal = categories.get("temporal") ?? [];
      temporal.push(item);
      categories.set("temporal", temporal);
    }
  }
  return categories;
}

function categoryMetrics(
  cases: readonly HybridBenchmarkCase[],
  systems: Readonly<Record<string, CandidateSystemMap>>
) {
  return Object.fromEntries(
    [...categoryCaseSets(cases).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, categoryCases]) => [
        category,
        {
          caseCount: categoryCases.length,
          evaluableCaseCount: evaluableCases(categoryCases).length,
          systems: Object.fromEntries(
            Object.entries(systems).map(([name, candidates]) => [
              name,
              benchmarkMetrics({
                cases: categoryCases,
                candidates: systemMap(categoryCases, candidates)
              })
            ])
          )
        }
      ])
  );
}

function scopeMetrics(
  cases: readonly HybridBenchmarkCase[],
  systems: Readonly<Record<string, CandidateSystemMap>>
) {
  return Object.fromEntries(
    (["current", "week", "all"] as const).map((scope) => {
      const scopeCases = cases.filter((item) => item.scope === scope);
      return [scope, {
        caseCount: scopeCases.length,
        evaluableCaseCount: evaluableCases(scopeCases).length,
        systems: Object.fromEntries(
          Object.entries(systems).map(([name, candidates]) => [
            name,
            benchmarkMetrics({
              cases: scopeCases,
              candidates: systemMap(scopeCases, candidates)
            })
          ])
        )
      }];
    })
  );
}

function bestMatchingCandidate(
  item: HybridBenchmarkCase,
  candidates: readonly QaRetrievedEvidence[]
) {
  const groups = availableExpectedGroups(item);
  const index = candidates.findIndex((candidate) =>
    groups.some((group) => candidateHitsGroup(candidate, group))
  );
  return index < 0 ? undefined : { candidate: candidates[index]!, rank: index + 1 };
}

function channelHasGold(
  item: HybridBenchmarkCase,
  ids: readonly string[],
  canonicalById: ReadonlyMap<string, QaRetrievedEvidence>
) {
  const groups = availableExpectedGroups(item);
  return ids.some((id) => {
    const candidate = canonicalById.get(id);
    return candidate && groups.some((group) => candidateHitsGroup(candidate, group));
  });
}

function relationshipFailureAnalysis(
  item: HybridBenchmarkCase,
  diagnostics: HybridCandidateDiagnostics
) {
  const query = diagnostics.query;
  const canonicalById = new Map(item.canonicalEvidence.map((candidate) => [
    candidate.id,
    candidate
  ]));
  const hybridCandidates = diagnostics.candidates.map((candidate) => candidate.evidence);
  const reasons: string[] = [];
  if (!query.types.includes("relationship")) reasons.push("query_parser_not_recognized");
  if (item.missingExpectedGroups.length > 0) reasons.push("gold_evidence_absent");
  if (
    query.entities.length > 0 &&
    !channelHasGold(item, diagnostics.channelIds.relationship, canonicalById)
  ) reasons.push("entity_or_alias_not_matched");
  if (!channelHasGold(item, diagnostics.channelIds.structured, canonicalById)) {
    reasons.push("structured_channel_miss");
  }
  const relationshipHasGold = channelHasGold(
    item,
    diagnostics.channelIds.relationship,
    canonicalById
  );
  if (!relationshipHasGold) reasons.push("relationship_channel_miss");
  if (
    relationshipHasGold &&
    retrievedGroupCount(item, hybridCandidates, 30) <
      availableExpectedGroups(item).length
  ) reasons.push("rrf_dilution_or_candidate_cutoff");
  if (
    retrievedGroupCount(item, hybridCandidates, 30) >
    retrievedGroupCount(item, hybridCandidates, 10)
  ) reasons.push("top_k_truncation");
  if (
    item.canonicalEvidence.some((candidate) =>
      candidate.sourceSegmentIds.some((id) =>
        availableExpectedGroups(item).some((group) => group.includes(id))
      ) && item.metadata.get(candidate.id)?.relationshipSourceValid === false
    )
  ) reasons.push("source_validation_discard");
  return {
    queryRecognized: query.types.includes("relationship"),
    entities: query.entities,
    inheritedIntent: query.inheritedRelationshipIntent,
    channelCounts: diagnostics.channelCounts,
    recallAt10: retrievedGroupCount(item, hybridCandidates, 10) /
      Math.max(1, availableExpectedGroups(item).length),
    recallAt30: retrievedGroupCount(item, hybridCandidates, 30) /
      Math.max(1, availableExpectedGroups(item).length),
    reasons
  };
}

function largestContributionDifference(
  gold: RankedHybridEvidence,
  competitor: RankedHybridEvidence | undefined
) {
  if (!competitor) return null;
  const differences = Object.keys(gold.contributions).map((name) => {
    const feature = name as keyof typeof gold.contributions;
    return {
      feature,
      gold: gold.contributions[feature],
      competitor: competitor.contributions[feature],
      deltaAgainstGold: competitor.contributions[feature] - gold.contributions[feature]
    };
  }).sort((left, right) => right.deltaAgainstGold - left.deltaAgainstGold);
  return differences[0] ?? null;
}

function rankingRegressionReason(input: {
  beforeRank: number;
  afterRank: number | null;
  missingRank: number;
}) {
  const afterRank = input.afterRank ?? input.missingRank;
  if (input.beforeRank <= 10 && afterRank > 10) {
    return "crossed_recall_at_10_boundary";
  }
  if (input.beforeRank <= 16 && afterRank > 16) {
    return "crossed_top_16_boundary";
  }
  if (input.beforeRank <= 30 && afterRank > 30) {
    return "crossed_top_30_boundary";
  }
  return "relevant_evidence_rank_worsened";
}

function sourceSetDuplicateCount(candidates: readonly QaRetrievedEvidence[]) {
  const sourceSets = candidates.map((candidate) =>
    [...candidate.sourceSegmentIds].sort().join("|")
  );
  return sourceSets.length - new Set(sourceSets).size;
}

export async function runHybridRetrievalBenchmarkV2(input: {
  reportPath: string;
  runtimePath?: string;
  provider: EmbeddingProvider;
  index: SqliteEmbeddingIndex;
  reranker?: RerankerProvider;
  rerankerEnabled?: boolean;
  batchSize?: number;
  workspaceBaseline: {
    headCommit: string;
    scopedSourceHash: string;
    algorithmSourceHash?: string;
    harnessSourceHash?: string;
    label: string;
  };
  onProgress?: (message: string) => void;
}) {
  const loaded = await loadHybridBenchmarkCases({
    reportPath: input.reportPath,
    runtimePath: input.runtimePath
  });
  const embeddingCorpus = [...new Map(
    loaded.cases
      .flatMap((item) => item.canonicalEvidence)
      .sort((left, right) => right.text.length - left.text.length)
      .map((item) => [item.id, item])
  ).values()];
  input.onProgress?.(
    `0/${loaded.cases.length} stage=indexing evidence=${embeddingCorpus.length} ` +
    `memory=${loaded.memories.length}`
  );
  const canonicalUniverseHash = createHash("sha256")
    .update(JSON.stringify(
      [...embeddingCorpus]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((evidence) => ({
          id: evidence.id,
          sourceSegmentIds: [...evidence.sourceSegmentIds].sort()
        }))
    ))
    .digest("hex");
  const canonicalContentHash = createHash("sha256")
    .update(JSON.stringify(
      [...embeddingCorpus]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((evidence) => ({
          id: evidence.id,
          title: evidence.title,
          text: evidence.text,
          priority: evidence.priority,
          startSeconds: evidence.startSeconds,
          endSeconds: evidence.endSeconds,
          sourceSegmentIds: [...evidence.sourceSegmentIds]
        }))
    ))
    .digest("hex");
  const embeddingFallbacks: Array<{
    stage:
      | "evidence_indexing"
      | "memory_indexing"
      | "evidence_query"
      | "memory_query";
    caseId: string | null;
    attempted: boolean;
    reason: string;
  }> = [];
  let evidenceEmbeddingAvailable = true;
  let memoryEmbeddingAvailable = true;
  let evidenceEmbeddingFailureReason: string | undefined;
  let memoryEmbeddingFailureReason: string | undefined;
  let indexing: EvidenceIndexingResult;
  try {
    indexing = await indexCanonicalEvidence({
      evidence: embeddingCorpus,
      provider: input.provider,
      index: input.index,
      batchSize: input.batchSize,
      onProgress: ({ completed, total }) => {
        input.onProgress?.(
          `${completed}/${total} stage=indexing object=evidence`
        );
      }
    });
  } catch (error) {
    evidenceEmbeddingAvailable = false;
    evidenceEmbeddingFailureReason = errorMessage(error);
    embeddingFallbacks.push({
      stage: "evidence_indexing",
      caseId: null,
      attempted: true,
      reason: evidenceEmbeddingFailureReason
    });
    indexing = {
      total: embeddingCorpus.length,
      embedded: 0,
      unchanged: 0,
      removed: 0
    };
  }
  let memoryIndexing: MemoryIndexingResult;
  try {
    memoryIndexing = await indexMemoryItems({
      memories: loaded.memories,
      provider: input.provider,
      index: input.index,
      batchSize: input.batchSize,
      onProgress: ({ completed, total }) => {
        input.onProgress?.(
          `${completed}/${total} stage=indexing object=memory`
        );
      }
    });
  } catch (error) {
    memoryEmbeddingAvailable = false;
    memoryEmbeddingFailureReason = errorMessage(error);
    embeddingFallbacks.push({
      stage: "memory_indexing",
      caseId: null,
      attempted: true,
      reason: memoryEmbeddingFailureReason
    });
    memoryIndexing = {
      total: loaded.memories.length,
      embedded: 0,
      unchanged: 0,
      removed: 0
    };
  }
  const rerankerHealth =
    input.reranker && input.rerankerEnabled
      ? await input.reranker.healthCheck()
      : undefined;

  const primarySystems: Record<string, CandidateSystemMap> = {
    current: new Map(),
    dense: new Map(),
    hybrid: new Map(),
    hybridOptimizedRanking: new Map(),
    hybridPhase31Ranking: new Map(),
    hybridPhase31MemoryStructured: new Map(),
    hybridPhase31MemoryDense: new Map(),
    hybridPhase31MemoryStructuredDense: new Map(),
    hybridReranker: new Map(),
    hybridRankingReranker: new Map()
  };
  const phase2Systems = Object.fromEntries(
    FUSION_STRATEGIES.map((strategy) => [strategy, new Map()])
  ) as Record<HybridFusionStrategy, CandidateSystemMap>;
  const ablationSystems = Object.fromEntries(
    RANKING_EXPERIMENTS.map((experiment) => [experiment, new Map()])
  ) as Record<EvidenceRankingExperiment, CandidateSystemMap>;
  const memorySystems = Object.fromEntries(
    MEMORY_EXPANSION_MODES.flatMap((mode) =>
      MEMORY_EXPANSION_QUOTAS.map((quota) => [
        memoryExperimentName(mode, quota),
        new Map<string, readonly QaRetrievedEvidence[]>()
      ])
    )
  ) as Record<string, CandidateSystemMap>;
  const latencies: Record<string, number[]> = {
    current: [],
    dense: [],
    hybrid: [],
    hybridOptimizedRanking: [],
    hybridPhase31Ranking: [],
    hybridPhase31MemoryStructured: [],
    hybridPhase31MemoryDense: [],
    hybridPhase31MemoryStructuredDense: [],
    hybridReranker: [],
    hybridRankingReranker: []
  };
  const phase2Latencies = FUSION_STRATEGIES.reduce(
    (result, strategy) => ({ ...result, [strategy]: [] }),
    {} as Record<HybridFusionStrategy, number[]>
  );
  const ablationLatencies = RANKING_EXPERIMENTS.reduce(
    (result, experiment) => ({ ...result, [experiment]: [] }),
    {} as Record<EvidenceRankingExperiment, number[]>
  );
  const memoryLatencies = Object.fromEntries(
    Object.keys(memorySystems).map((name) => [name, [] as number[]])
  ) as Record<string, number[]>;
  const memoryDiagnostics: Array<MemoryExpansionDiagnostics & {
    caseId: string;
    finalTop30Count: number;
    finalTop16Count: number;
    finalTop10Count: number;
  }> = [];
  const rerankerBatchTelemetry: Array<{
    caseId: string;
    path: "hybrid" | "hybrid_ranking";
    candidateCount: number;
    latencyMs: number;
    gpuPeakMemoryMb?: number;
  }> = [];
  const rerankerScoreValues: number[] = [];
  let rerankerFallbacks = 0;
  let rerankerTimeouts = 0;
  const caseDetails: Array<Record<string, unknown>> = [];
  const rankingRegressions: Array<Record<string, unknown>> = [];
  const phase31RankingRegressions: Array<Record<string, unknown>> = [];
  const phase31RegressionSet: Array<Record<string, unknown>> = [];
  const relationshipFailures: Array<Record<string, unknown>> = [];
  for (const [caseIndex, item] of loaded.cases.entries()) {
    input.onProgress?.(
      `${caseIndex}/${loaded.cases.length} stage=retrieval case=${item.id}`
    );
    latencies.current.push(item.currentLatencyMs);
    primarySystems.current.set(item.id, item.currentCandidates);

    const denseStartedAt = performance.now();
    let dense: DenseEvidenceCandidate[] = [];
    if (evidenceEmbeddingAvailable) {
      try {
        dense = await retrieveDenseEvidence({
          question: item.question,
          evidence: item.canonicalEvidence,
          provider: input.provider,
          index: input.index,
          limit: 50,
          contentHashPolicy: "object_id"
        });
      } catch (error) {
        evidenceEmbeddingAvailable = false;
        evidenceEmbeddingFailureReason = errorMessage(error);
        embeddingFallbacks.push({
          stage: "evidence_query",
          caseId: item.id,
          attempted: true,
          reason: evidenceEmbeddingFailureReason
        });
      }
    } else {
      embeddingFallbacks.push({
        stage: "evidence_query",
        caseId: item.id,
        attempted: false,
        reason: evidenceEmbeddingFailureReason ?? "evidence_embedding_unavailable"
      });
    }
    latencies.dense.push(performance.now() - denseStartedAt);
    primarySystems.dense.set(
      item.id,
      dense.slice(0, 30).map((candidate) => candidate.evidence)
    );

    const phase2Diagnostics = new Map<HybridFusionStrategy, HybridCandidateDiagnostics>();
    for (const strategy of FUSION_STRATEGIES) {
      const startedAt = performance.now();
      const diagnostics = generateHybridCandidatesWithDiagnostics({
        question: item.question,
        conversation: item.qaInput.conversation,
        evidence: item.canonicalEvidence,
        denseCandidates: dense,
        currentCandidates: item.currentCandidates,
        metadata: item.metadata,
        limit: 50,
        strategy
      });
      phase2Latencies[strategy].push(performance.now() - startedAt);
      if (!hybridCandidateCitationValidity(diagnostics.candidates, item.canonicalEvidence)) {
        throw new Error(`Canonical candidate boundary failed for ${item.id}/${strategy}`);
      }
      phase2Diagnostics.set(strategy, diagnostics);
      phase2Systems[strategy].set(
        item.id,
        diagnostics.candidates.map((candidate) => candidate.evidence)
      );
    }
    const primaryHybrid = phase2Diagnostics.get(PRIMARY_FUSION_STRATEGY)!;
    const hybridEvidence = primaryHybrid.candidates.map((candidate) => candidate.evidence);
    primarySystems.hybrid.set(item.id, hybridEvidence);
    latencies.hybrid.push(phase2Latencies[PRIMARY_FUSION_STRATEGY].at(-1)!);

    const rankedByExperiment = new Map<EvidenceRankingExperiment, RankedHybridEvidence[]>();
    for (const experiment of RANKING_EXPERIMENTS) {
      const startedAt = performance.now();
      const ranked = scoreHybridEvidenceCandidates({
        question: item.question,
        candidates: primaryHybrid.candidates,
        metadata: item.metadata,
        experiment
      });
      ablationLatencies[experiment].push(performance.now() - startedAt);
      rankedByExperiment.set(experiment, ranked);
      ablationSystems[experiment].set(
        item.id,
        ranked.map((candidate) => candidate.evidence)
      );
    }
    const optimizedRanking = rankedByExperiment.get(PRIMARY_RANKING_EXPERIMENT)!;
    const phase31Ranking = rankedByExperiment.get(PHASE_3_1_RANKING_EXPERIMENT)!;
    primarySystems.hybridOptimizedRanking.set(
      item.id,
      optimizedRanking.map((candidate) => candidate.evidence)
    );
    latencies.hybridOptimizedRanking.push(
      ablationLatencies[PRIMARY_RANKING_EXPERIMENT].at(-1)!
    );
    primarySystems.hybridPhase31Ranking.set(
      item.id,
      phase31Ranking.map((candidate) => candidate.evidence)
    );
    latencies.hybridPhase31Ranking.push(
      ablationLatencies[PHASE_3_1_RANKING_EXPERIMENT].at(-1)!
    );

    const structuredMemories = retrieveStructuredMemories({
      question: item.question,
      scope: item.scope,
      ...(item.scopeDateRange ? { dateRange: item.scopeDateRange } : {}),
      memories: loaded.memories,
      ownersByMemoryId: loaded.ownersByMemoryId,
      limit: 50
    });
    let denseMemories: Awaited<ReturnType<typeof retrieveDenseMemories>> = {
      candidates: [],
      filtered: structuredMemories.filtered
    };
    let denseMemoryFallbackReason = memoryEmbeddingAvailable
      ? undefined
      : memoryEmbeddingFailureReason ?? "memory_embedding_unavailable";
    if (memoryEmbeddingAvailable) {
      try {
        denseMemories = await retrieveDenseMemories({
          question: item.question,
          scope: item.scope,
          ...(item.scopeDateRange ? { dateRange: item.scopeDateRange } : {}),
          memories: loaded.memories,
          ownersByMemoryId: loaded.ownersByMemoryId,
          provider: input.provider,
          index: input.index,
          limit: 50
        });
      } catch (error) {
        memoryEmbeddingAvailable = false;
        memoryEmbeddingFailureReason = errorMessage(error);
        denseMemoryFallbackReason = memoryEmbeddingFailureReason;
        embeddingFallbacks.push({
          stage: "memory_query",
          caseId: item.id,
          attempted: true,
          reason: memoryEmbeddingFailureReason
        });
      }
    } else {
      embeddingFallbacks.push({
        stage: "memory_query",
        caseId: item.id,
        attempted: false,
        reason: denseMemoryFallbackReason ?? "memory_embedding_unavailable"
      });
    }
    for (const mode of MEMORY_EXPANSION_MODES) {
      for (const quota of MEMORY_EXPANSION_QUOTAS) {
        const memoryStartedAt = performance.now();
        const requiresDense = mode === "dense" || mode === "structured_dense";
        const expansion = expandMemoriesToCanonicalEvidence({
          mode,
          scope: item.scope,
          ...(item.scopeDateRange ? { dateRange: item.scopeDateRange } : {}),
          memoryLimit: quota,
          structured: structuredMemories.candidates,
          dense: denseMemories.candidates,
          canonicalEvidence: item.canonicalEvidence,
          metadata: item.metadata,
          filtered: structuredMemories.filtered,
          ...(requiresDense && denseMemoryFallbackReason
            ? { fallbackReason: denseMemoryFallbackReason }
            : {})
        });
        let memoryRanked: RankedHybridEvidence[];
        if (requiresDense && denseMemoryFallbackReason) {
          // Dense Memory variants must be an exact no-Memory Phase 3.1 fallback.
          // Structured-only remains independently evaluable because it does not
          // require the embedding service.
          memoryRanked = phase31Ranking;
        } else {
          const memoryHybrid = generateHybridCandidatesWithDiagnostics({
            question: item.question,
            conversation: item.qaInput.conversation,
            evidence: item.canonicalEvidence,
            denseCandidates: dense,
            currentCandidates: item.currentCandidates,
            memoryCandidates: expansion.candidates,
            metadata: item.metadata,
            limit: 50,
            strategy: PRIMARY_FUSION_STRATEGY
          });
          if (!hybridCandidateCitationValidity(
            memoryHybrid.candidates,
            item.canonicalEvidence
          )) {
            throw new Error(
              `Memory expansion canonical boundary failed for ${item.id}/${mode}/${quota}`
            );
          }
          memoryRanked = scoreHybridEvidenceCandidates({
            question: item.question,
            candidates: memoryHybrid.candidates,
            metadata: item.metadata,
            experiment: PHASE_3_1_RANKING_EXPERIMENT
          });
        }
        const name = memoryExperimentName(mode, quota);
        memorySystems[name]!.set(
          item.id,
          memoryRanked.map((candidate) => candidate.evidence)
        );
        memoryLatencies[name]!.push(performance.now() - memoryStartedAt);
        const expandedIds = new Set(
          requiresDense && denseMemoryFallbackReason
            ? []
            : expansion.candidates.map((candidate) => candidate.evidence.id)
        );
        memoryDiagnostics.push({
          caseId: item.id,
          ...expansion.diagnostics,
          finalTop30Count: memoryRanked
            .slice(0, 30)
            .filter((candidate) => expandedIds.has(candidate.evidence.id))
            .length,
          finalTop16Count: memoryRanked
            .slice(0, 16)
            .filter((candidate) => expandedIds.has(candidate.evidence.id))
            .length,
          finalTop10Count: memoryRanked
            .slice(0, 10)
            .filter((candidate) => expandedIds.has(candidate.evidence.id))
            .length
        });
        if (quota === PRIMARY_MEMORY_QUOTA) {
          const primaryName =
            mode === "structured"
              ? "hybridPhase31MemoryStructured"
              : mode === "dense"
                ? "hybridPhase31MemoryDense"
                : "hybridPhase31MemoryStructuredDense";
          primarySystems[primaryName]!.set(
            item.id,
            memoryRanked.map((candidate) => candidate.evidence)
          );
          latencies[primaryName]!.push(memoryLatencies[name]!.at(-1)!);
        }
      }
    }

    const rerankedHybrid = input.reranker
      ? await rerankHybridCandidates({
          question: item.question,
          candidates: primaryHybrid.candidates.slice(0, 30),
          provider: input.reranker,
          enabled: input.rerankerEnabled && rerankerHealth?.ok === true
        })
      : {
          candidates: primaryHybrid.candidates,
          latencyMs: 0,
          fallback: true,
          fallbackReason: "provider_not_configured"
        };
    latencies.hybridReranker.push(rerankedHybrid.latencyMs);
    if (rerankedHybrid.fallback) {
      rerankerFallbacks += 1;
      if (/abort|timeout/iu.test(rerankedHybrid.fallbackReason ?? "")) rerankerTimeouts += 1;
    }
    if (rerankedHybrid.scoreDistribution) {
      rerankerScoreValues.push(
        rerankedHybrid.scoreDistribution.min,
        rerankedHybrid.scoreDistribution.p50,
        rerankedHybrid.scoreDistribution.p95,
        rerankedHybrid.scoreDistribution.max
      );
    }
    for (const batch of input.reranker?.getLastBatchTelemetry?.() ?? []) {
      rerankerBatchTelemetry.push({
        caseId: item.id,
        path: "hybrid",
        candidateCount: batch.candidateCount,
        latencyMs: batch.latencyMs,
        ...(batch.gpuPeakMemoryMb !== undefined
          ? { gpuPeakMemoryMb: batch.gpuPeakMemoryMb }
          : {})
      });
    }
    primarySystems.hybridReranker.set(
      item.id,
      rerankedHybrid.candidates.map((candidate) => candidate.evidence)
    );

    const primaryTop30Ids = new Set(
      primaryHybrid.candidates.slice(0, 30).map((candidate) => candidate.evidence.id)
    );
    const rankingTop30 = optimizedRanking
      .filter((candidate) => primaryTop30Ids.has(candidate.evidence.id))
      .slice(0, 30);
    const reusableScores = new Map(
      rerankedHybrid.candidates.flatMap((candidate) =>
        "rerankerScore" in candidate &&
        typeof candidate.rerankerScore === "number"
          ? [[candidate.evidence.id, candidate.rerankerScore] as const]
          : []
      )
    );
    const rerankedRanking = input.reranker
      ? rerankedHybrid.fallback
        ? {
            candidates: rankingTop30,
            latencyMs: 0,
            fallback: true,
            fallbackReason: rerankedHybrid.fallbackReason ?? "hybrid_reranker_fallback"
          }
        : {
            candidates: orderHybridCandidatesByRerankerScores({
              candidates: rankingTop30,
              scoresByEvidenceId: reusableScores
            }),
            latencyMs: 0,
            fallback: false,
            scoreDistribution: rerankedHybrid.scoreDistribution
          }
      : {
          candidates: optimizedRanking,
          latencyMs: 0,
          fallback: true,
          fallbackReason: "provider_not_configured"
        };
    latencies.hybridRankingReranker.push(rerankedRanking.latencyMs);
    if (rerankedRanking.fallback) {
      rerankerFallbacks += 1;
      if (/abort|timeout/iu.test(rerankedRanking.fallbackReason ?? "")) rerankerTimeouts += 1;
    }
    primarySystems.hybridRankingReranker.set(
      item.id,
      rerankedRanking.candidates.map((candidate) => candidate.evidence)
    );

    if (item.category === "relationship") {
      relationshipFailures.push({
        caseId: item.id,
        question: item.question,
        ...relationshipFailureAnalysis(item, primaryHybrid)
      });
    }

    const hybridMatch = bestMatchingCandidate(item, hybridEvidence);
    const rankingEvidence = optimizedRanking.map((candidate) => candidate.evidence);
    const rankingGroupRegressions = benchmarkGoldGroupRankRegressions({
      item,
      beforeCandidates: hybridEvidence,
      afterCandidates: rankingEvidence
    });
    for (const regression of rankingGroupRegressions) {
      const rankedGold = optimizedRanking.find((candidate) =>
        candidate.evidence.id === regression.goldEvidenceId
      );
      const competitor = rankedGold && rankedGold.rank > 1
        ? optimizedRanking[rankedGold.rank - 2]
        : undefined;
      const afterRank = regression.afterRank ?? 31;
      rankingRegressions.push({
        caseId: item.id,
        goldGroupIndex: regression.groupIndex,
        goldSourceSegmentIds: regression.sourceSegmentIds,
        goldEvidenceId: regression.goldEvidenceId,
        hybridRank: regression.beforeRank,
        hybridRankingRank: rankedGold?.rank ?? null,
        bestGoldRankAfterRanking: regression.afterRank,
        crossedTop16Boundary:
          regression.beforeRank <= 16 && afterRank > 16,
        featureContributions: rankedGold?.contributions ?? null,
        largestCompetitorAdvantage: rankedGold
          ? largestContributionDifference(rankedGold, competitor)
          : null,
        finalFailureReason: rankingRegressionReason({
          beforeRank: regression.beforeRank,
          afterRank: regression.afterRank,
          missingRank: 31
        })
      });
    }

    const phase31Evidence = phase31Ranking.map((candidate) => candidate.evidence);
    const phase31Match = bestMatchingCandidate(item, phase31Evidence);
    const phase31GroupRegressions = benchmarkGoldGroupRankRegressions({
      item,
      beforeCandidates: hybridEvidence,
      afterCandidates: phase31Evidence
    });
    for (const regression of phase31GroupRegressions) {
      const phase31Gold = phase31Ranking.find((candidate) =>
        candidate.evidence.id === regression.goldEvidenceId
      );
      const competitor = phase31Gold && phase31Gold.rank > 1
        ? phase31Ranking[phase31Gold.rank - 2]
        : undefined;
      const afterRank = regression.afterRank ?? 51;
      phase31RankingRegressions.push({
        caseId: item.id,
        goldGroupIndex: regression.groupIndex,
        goldSourceSegmentIds: regression.sourceSegmentIds,
        goldEvidenceId: regression.goldEvidenceId,
        hybridRank: regression.beforeRank,
        phase31RankingRank: phase31Gold?.rank ?? null,
        bestGoldRankAfterRanking: regression.afterRank,
        crossedTop16Boundary:
          regression.beforeRank <= 16 && afterRank > 16,
        featureContributions: phase31Gold?.contributions ?? null,
        lifecycleTopicOverlap: phase31Gold?.lifecycleTopicOverlap ?? null,
        relevanceGate: phase31Gold?.relevanceGate ?? null,
        rankingGuards: phase31Gold?.rankingGuards ?? [],
        largestCompetitorAdvantage: phase31Gold
          ? largestContributionDifference(phase31Gold, competitor)
          : null,
        finalFailureReason: rankingRegressionReason({
          beforeRank: regression.beforeRank,
          afterRank: regression.afterRank,
          missingRank: 51
        })
      });
    }

    if (PHASE_3_1_REGRESSION_CASE_IDS.has(item.id as RankingRegressionCaseId)) {
      const hybridGold = hybridMatch?.candidate;
      const optimizedGold = hybridGold
        ? optimizedRanking.find((candidate) => candidate.evidence.id === hybridGold.id)
        : undefined;
      const phase31Gold = hybridGold
        ? phase31Ranking.find((candidate) => candidate.evidence.id === hybridGold.id)
        : undefined;
      phase31RegressionSet.push({
        caseId: item.id,
        question: item.question,
        scope: item.scope,
        category: item.category,
        query: parseHybridQuery(item.question),
        availableGoldGroups: availableExpectedGroups(item),
        fixtureUniverseGaps: item.missingExpectedGroups.map((group) => ({
          classification: "fixture/universe gap",
          sourceSegmentIds: group
        })),
        hybridRank: hybridMatch?.rank ?? null,
        optimizedRankingRank: optimizedGold?.rank ?? null,
        optimizedBestGoldRank: bestMatchingCandidate(
          item,
          optimizedRanking.map((candidate) => candidate.evidence)
        )?.rank ?? null,
        phase31RankingRank: phase31Gold?.rank ?? null,
        phase31BestGoldRank: phase31Match?.rank ?? null,
        goldEvidenceId: hybridGold?.id ?? null,
        optimizedFeatureContributions: optimizedGold?.contributions ?? null,
        phase31FeatureContributions: phase31Gold?.contributions ?? null,
        phase31LifecycleTopicOverlap: phase31Gold?.lifecycleTopicOverlap ?? null,
        phase31RelevanceGate: phase31Gold?.relevanceGate ?? null,
        phase31RankingGuards: phase31Gold?.rankingGuards ?? [],
        topCompetitors: phase31Ranking
          .filter((candidate) => candidate.evidence.id !== hybridGold?.id)
          .slice(0, 5)
          .map((candidate) => ({
            id: candidate.evidence.id,
            rank: candidate.rank,
            originalRank: candidate.originalRank,
            lifecycleState: candidate.lifecycleState,
            lifecycleTopicOverlap: candidate.lifecycleTopicOverlap,
            relevanceGate: candidate.relevanceGate,
            contributions: candidate.contributions,
            rankingGuards: candidate.rankingGuards
          }))
      });
    }

    caseDetails.push({
      id: item.id,
      scope: item.scope,
      category: item.category,
      question: item.question,
      retrievalEvaluable: item.retrievalEvaluable,
      originalFailures: item.retrievalFailures,
      expectedGroupCount: item.expectedGroups.length,
      availableExpectedGroupCount: availableExpectedGroups(item).length,
      missingExpectedGroups: item.missingExpectedGroups,
      currentMemoryContextCount: item.qaInput.memoryContext?.count ?? 0,
      canonicalEvidenceCount: item.canonicalEvidence.length,
      sourceSetDuplicateCounts: {
        canonical: sourceSetDuplicateCount(item.canonicalEvidence),
        hybrid: sourceSetDuplicateCount(hybridEvidence),
        hybridRanking: sourceSetDuplicateCount(rankingEvidence)
      },
      ranks: Object.fromEntries(
        Object.entries(primarySystems).map(([system, candidates]) => [
          system,
          firstExpectedRank(item, candidates.get(item.id) ?? [])
        ])
      ),
      candidateIds: Object.fromEntries(
        Object.entries(primarySystems).map(([system, candidates]) => [
          system,
          (candidates.get(item.id) ?? []).map((candidate) => candidate.id)
        ])
      ),
      goldGroupRanks: Object.fromEntries(
        Object.entries(primarySystems).map(([system, candidates]) => [
          system,
          expectedGroupRanks(item, candidates.get(item.id) ?? [])
            .map((group) => group.rank)
        ])
      ),
      recallAt30: Object.fromEntries(
        Object.entries(primarySystems).map(([system, candidates]) => [
          system,
          retrievedGroupCount(item, candidates.get(item.id) ?? [], 30) /
            Math.max(1, availableExpectedGroups(item).length)
        ])
      ),
      contributions: Object.fromEntries(
        Object.entries(primarySystems).map(([system, candidates]) => [
          system,
          benchmarkCaseContribution({
            item,
            candidates: candidates.get(item.id) ?? []
          })
        ])
      ),
      phase2: Object.fromEntries(
        FUSION_STRATEGIES.map((strategy) => [
          strategy,
          {
            firstGoldRank: firstExpectedRank(
              item,
              phase2Systems[strategy].get(item.id) ?? []
            ),
            channelCounts: phase2Diagnostics.get(strategy)!.channelCounts,
            quotas: phase2Diagnostics.get(strategy)!.appliedQuotas
          }
        ])
      ),
      reranker: {
        hybridFallback: rerankedHybrid.fallback,
        hybridFallbackReason: rerankedHybrid.fallbackReason ?? null,
        hybridLatencyMs: rerankedHybrid.latencyMs,
        rankingFallback: rerankedRanking.fallback,
        rankingFallbackReason: rerankedRanking.fallbackReason ?? null,
        rankingLatencyMs: rerankedRanking.latencyMs
      }
    });
  }
  input.onProgress?.(
    `${loaded.cases.length}/${loaded.cases.length} stage=retrieval completed=true`
  );

  const metrics = Object.fromEntries(
    Object.entries(primarySystems).map(([name, candidates]) => [
      name,
      benchmarkMetrics({ cases: loaded.cases, candidates })
    ])
  );
  const phase2Metrics = Object.fromEntries(
    FUSION_STRATEGIES.map((strategy) => [
      strategy,
      benchmarkMetrics({ cases: loaded.cases, candidates: phase2Systems[strategy] })
    ])
  );
  const ablationMetrics = Object.fromEntries(
    RANKING_EXPERIMENTS.map((experiment) => [
      experiment,
      benchmarkMetrics({ cases: loaded.cases, candidates: ablationSystems[experiment] })
    ])
  );
  const memoryMetrics = Object.fromEntries(
    Object.entries(memorySystems).map(([name, candidates]) => [
      name,
      benchmarkMetrics({ cases: loaded.cases, candidates })
    ])
  );

  const historicalDriftCases = loaded.cases.filter((item) => {
    if (item.historicalCandidates.length !== item.currentCandidates.length) return true;
    return item.historicalCandidates.some((candidate, index) => {
      const current = item.currentCandidates[index];
      return !current ||
        current.id !== candidate.id ||
        current.sourceSegmentIds.join("|") !== candidate.sourceSegmentIds.join("|");
    });
  });
  const historicalInvalidCandidateCount = loaded.cases.reduce((sum, item) =>
    sum + item.historicalCandidates.filter((candidate) =>
      !candidateValid(candidate, item.canonicalEvidence)
    ).length, 0
  );
  const unavailableCases = loaded.cases.flatMap((item) => {
    const reasons = [
      ...(!item.retrievalEvaluable ? ["source_report_not_retrieval_evaluable"] : []),
      ...(item.missingExpectedGroups.length > 0
        ? [`missing_gold_groups:${item.missingExpectedGroups.length}`]
        : [])
    ];
    return reasons.length > 0 ? [{ id: item.id, reasons }] : [];
  });
  const completeMissDetails = loaded.cases
    .filter((item) => item.retrievalFailures.includes("retrieval_miss"))
    .map((item) => ({
      id: item.id,
      category: item.category,
      question: item.question,
      missingGoldGroups: item.missingExpectedGroups.length,
      systems: Object.fromEntries(
        Object.entries(primarySystems).map(([name, candidates]) => {
          const values = candidates.get(item.id) ?? [];
          return [name, {
            firstGoldRank: firstExpectedRank(item, values),
            recoveredAllAt30:
              retrievedGroupCount(item, values, 30) ===
              availableExpectedGroups(item).length,
            recalledGroupsAt30: retrievedGroupCount(item, values, 30),
            availableGoldGroups: availableExpectedGroups(item).length
          }];
        })
      )
    }));

  const memoryExperimentReports = Object.fromEntries(
    Object.entries(memorySystems).map(([name, candidates]) => {
      const match = /^memory_(structured|dense|structured_dense)_top(\d+)$/u.exec(name);
      const mode = match?.[1] as MemoryExpansionMode;
      const memoryLimit = Number(match?.[2] ?? 0);
      const diagnostics = memoryDiagnostics.filter((item) =>
        item.mode === mode && item.memoryLimit === memoryLimit
      );
      const baselineCandidates = primarySystems.hybridPhase31Ranking;
      const originalHybridCandidates = primarySystems.hybrid;
      const rescuedGoldGroups = loaded.cases.flatMap((item) => {
        const baselineValues = baselineCandidates.get(item.id) ?? [];
        const originalHybridValues = originalHybridCandidates.get(item.id) ?? [];
        const memoryValues = candidates.get(item.id) ?? [];
        return availableExpectedGroups(item).flatMap((group, groupIndex) => {
          const baselineRank = baselineValues.findIndex((candidate) =>
            candidateHitsGroup(candidate, group)
          );
          const originalHybridRank = originalHybridValues.findIndex((candidate) =>
            candidateHitsGroup(candidate, group)
          );
          const memoryRank = memoryValues.findIndex((candidate) =>
            candidateHitsGroup(candidate, group)
          );
          if (memoryRank < 0 || memoryRank >= 30) return [];
          if (baselineRank >= 0 && baselineRank < 30) return [];
          return [{
            caseId: item.id,
            groupIndex,
            baselineRank: baselineRank < 0 ? null : baselineRank + 1,
            originalHybridRank:
              originalHybridRank < 0 ? null : originalHybridRank + 1,
            memoryRank: memoryRank + 1,
            source:
              originalHybridRank < 0
                ? "memory_found_new_event_cluster"
                : "memory_reordered_existing_evidence"
          }];
        });
      });
      const newGoldHits = rescuedGoldGroups.filter(
        (item) => item.source === "memory_found_new_event_cluster"
      );
      const benefitDetails = loaded.cases.flatMap((item) => {
        const baselineValues = baselineCandidates.get(item.id) ?? [];
        const originalHybridValues = originalHybridCandidates.get(item.id) ?? [];
        const memoryValues = candidates.get(item.id) ?? [];
        const baselineRank = firstExpectedRank(item, baselineValues);
        const originalHybridRank = firstExpectedRank(item, originalHybridValues);
        const memoryRank = firstExpectedRank(item, memoryValues);
        if (!memoryRank || (baselineRank && memoryRank >= baselineRank)) return [];
        return [{
          caseId: item.id,
          category: item.category,
          baselineFirstGoldRank: baselineRank,
          originalHybridFirstGoldRank: originalHybridRank,
          memoryFirstGoldRank: memoryRank,
          source:
            !originalHybridRank
              ? "memory_found_new_event_cluster"
              : "memory_reordered_existing_evidence"
        }];
      });
      const sum = (
        field: keyof Pick<
          MemoryExpansionDiagnostics,
          | "totalMemoryCount"
          | "queryEligibleMemoryCount"
          | "typeFilteredCount"
          | "scopeFilteredCount"
          | "dateFilteredCount"
          | "retrievedMemoryCount"
          | "successfullyMappedMemoryCount"
          | "distinctMappedMemoryCount"
          | "expandedCanonicalEvidenceCount"
          | "unmappedMemoryCount"
          | "distinctUnmappedMemoryCount"
          | "mappedMemoryEvidenceCount"
          | "unmappedMemoryEvidenceCount"
          | "expiredFilteredCount"
          | "supersededFilteredCount"
          | "ownerFilteredCount"
          | "ownerUnknownFilteredCount"
          | "ownerConflictFilteredCount"
          | "ownerUnverifiedFilteredCount"
          | "ownerEntityMismatchFilteredCount"
          | "scopeLeakageCount"
          | "dateLeakageCount"
          | "dateFilteredMemoryEvidenceCount"
          | "rawExpansionCount"
          | "deduplicatedExpansionCount"
          | "candidateDuplicationCount"
          | "finalCandidateDuplicateCount"
        >
      ) => diagnostics.reduce((total, item) => total + item[field], 0);
      return [name, {
        mode,
        memoryLimit,
        metrics: memoryMetrics[name],
        latency: latencySummary(memoryLatencies[name] ?? []),
        queryHitRate: diagnostics.filter((item) => item.retrievedMemoryCount > 0).length /
          Math.max(1, diagnostics.length),
        totalMemoryCount: loaded.memories.length,
        totalMemoryQueryAppearances: sum("totalMemoryCount"),
        queryEligibleMemoryCount: sum("queryEligibleMemoryCount"),
        typeFilteredCount: sum("typeFilteredCount"),
        scopeFilteredCount: sum("scopeFilteredCount"),
        dateFilteredCount: sum("dateFilteredCount"),
        retrievedMemoryCount: sum("retrievedMemoryCount"),
        successfullyMappedMemoryCount: sum("successfullyMappedMemoryCount"),
        distinctMappedMemoryQueryCount: sum("distinctMappedMemoryCount"),
        expandedCanonicalEvidenceCount: sum("expandedCanonicalEvidenceCount"),
        memoryOnlyNewGoldHitCount: newGoldHits.length,
        memoryOnlyNewGoldHits: newGoldHits,
        memoryRescuedGoldGroupCount: rescuedGoldGroups.length,
        memoryRescuedGoldGroups: rescuedGoldGroups,
        benefitDetails,
        finalTop30Count: diagnostics.reduce(
          (total, item) => total + item.finalTop30Count,
          0
        ),
        finalTop16Count: diagnostics.reduce(
          (total, item) => total + item.finalTop16Count,
          0
        ),
        finalTop10Count: diagnostics.reduce(
          (total, item) => total + item.finalTop10Count,
          0
        ),
        unmappedMemoryCount: sum("unmappedMemoryCount"),
        distinctUnmappedMemoryQueryCount: sum("distinctUnmappedMemoryCount"),
        mappedMemoryEvidenceCount: sum("mappedMemoryEvidenceCount"),
        unmappedMemoryEvidenceCount: sum("unmappedMemoryEvidenceCount"),
        unmappedByReason: diagnostics.reduce<Record<string, number>>(
          (result, item) => {
            for (const [reason, count] of Object.entries(item.unmappedByReason)) {
              result[reason] = (result[reason] ?? 0) + count;
            }
            return result;
          },
          {}
        ),
        expiredFilteredCount: sum("expiredFilteredCount"),
        supersededFilteredCount: sum("supersededFilteredCount"),
        ownerFilteredCount: sum("ownerFilteredCount"),
        ownerUnknownFilteredCount: sum("ownerUnknownFilteredCount"),
        ownerConflictFilteredCount: sum("ownerConflictFilteredCount"),
        ownerUnverifiedFilteredCount: sum("ownerUnverifiedFilteredCount"),
        ownerEntityMismatchFilteredCount: sum("ownerEntityMismatchFilteredCount"),
        scopeLeakageCount: sum("scopeLeakageCount"),
        dateLeakageCount: sum("dateLeakageCount"),
        dateFilteredMemoryEvidenceCount: sum("dateFilteredMemoryEvidenceCount"),
        rawExpansionCount: sum("rawExpansionCount"),
        deduplicatedExpansionCount: sum("deduplicatedExpansionCount"),
        candidateDuplicationCount: sum("candidateDuplicationCount"),
        finalCandidateDuplicateCount: sum("finalCandidateDuplicateCount"),
        fallbackCount: diagnostics.filter((item) => item.fallback).length
      }];
    })
  );

  const scoreSummary = latencySummary(rerankerScoreValues);
  return {
    version: 2,
    kind: "daily_brief_hybrid_retrieval_shadow_benchmark",
    generatedAt: new Date().toISOString(),
    experiment: {
      name: "phase3.1-fixed-universe",
      primaryFusionStrategy: PRIMARY_FUSION_STRATEGY,
      primaryRankingExperiment: PRIMARY_RANKING_EXPERIMENT,
      phase31RankingExperiment: PHASE_3_1_RANKING_EXPERIMENT,
      phase31RankingVersion: PHASE_3_1_RANKING_VERSION,
      shadowOnly: true,
      productionRetrievalChanged: false
    },
    reproducibility: {
      frozenShadowBaseline: HYBRID_OPTIMIZED_RANKING_V1,
      frozenPhase31ShadowBaseline: HYBRID_PHASE31_SHADOW_V1,
      workspaceBaseline: input.workspaceBaseline,
      fixtureHash: loaded.fixtureHash,
      canonicalUniverseHash,
      canonicalContentHash,
      reportPath: loaded.reportPath,
      runtimePath: loaded.runtimePath,
      embeddingModel: input.provider.config,
      rerankerModel: input.reranker ? {
        modelName: input.reranker.modelName,
        modelVersion: input.reranker.modelVersion,
        batchSize: input.reranker.batchSize,
        timeoutMs: input.reranker.timeoutMs
      } : null,
      deterministicOrdering: true
    },
    baseline: {
      sourceCaseCount: loaded.cases.length,
      sourceRetrievalEvaluableCaseCount: loaded.cases.filter((item) =>
        item.retrievalEvaluable
      ).length,
      benchmarkEvaluableCaseCount: evaluableCases(loaded.cases).length,
      completeRetrievalMissCount: loaded.cases.filter((item) =>
        item.retrievalFailures.includes("retrieval_miss")
      ).length,
      canonicalEvidenceAppearances: loaded.cases.reduce(
        (sum, item) => sum + item.canonicalEvidence.length,
        0
      ),
      canonicalEvidenceUniqueCount: embeddingCorpus.length,
      categoryCounts: Object.fromEntries(
        [...categoryCaseSets(loaded.cases).entries()].map(([name, cases]) => [
          name,
          cases.length
        ])
      ),
      unavailableCases,
      historicalBaselineDriftCaseCount: historicalDriftCases.length,
      historicalBaselineDriftCaseIds: historicalDriftCases.map((item) => item.id),
      historicalInvalidCandidateCount
    },
    indexing,
    memoryIndexing,
    embeddingFallback: {
      evidenceAvailableAtCompletion: evidenceEmbeddingAvailable,
      memoryAvailableAtCompletion: memoryEmbeddingAvailable,
      count: embeddingFallbacks.length,
      attemptedFailureCount: embeddingFallbacks.filter((item) => item.attempted).length,
      affectedCaseCount: new Set(
        embeddingFallbacks.flatMap((item) => item.caseId ? [item.caseId] : [])
      ).size,
      events: embeddingFallbacks
    },
    systems: Object.fromEntries(
      Object.entries(metrics).map(([name, metric]) => [
        name,
        {
          metrics: metric,
          latency: latencySummary(latencies[name] ?? [])
        }
      ])
    ),
    phase2Experiments: Object.fromEntries(
      FUSION_STRATEGIES.map((strategy) => [
        strategy,
        {
          metrics: phase2Metrics[strategy],
          latency: latencySummary(phase2Latencies[strategy])
        }
      ])
    ),
    featureAblations: Object.fromEntries(
      RANKING_EXPERIMENTS.map((experiment) => [
        experiment,
        {
          metrics: ablationMetrics[experiment],
          latency: latencySummary(ablationLatencies[experiment])
        }
      ])
    ),
    featureAblationCategories: categoryMetrics(loaded.cases, ablationSystems),
    phase5Experiments: memoryExperimentReports,
    phase5Categories: categoryMetrics(loaded.cases, memorySystems),
    categories: categoryMetrics(loaded.cases, primarySystems),
    scopes: scopeMetrics(loaded.cases, primarySystems),
    relationshipFailures,
    rankingRegressions,
    phase31RankingRegressions,
    phase31RegressionSet,
    completeMissDetails,
    reranker: {
      enabled: Boolean(input.rerankerEnabled),
      health: rerankerHealth ?? null,
      fallbackCount: rerankerFallbacks,
      timeoutCount: rerankerTimeouts,
      batchCount: rerankerBatchTelemetry.length,
      batchLatency: latencySummary(rerankerBatchTelemetry.map((item) => item.latencyMs)),
      maxGpuPeakMemoryMb: Math.max(
        0,
        ...rerankerBatchTelemetry.map((item) => item.gpuPeakMemoryMb ?? 0)
      ),
      scoreDistributionSampleSummary: scoreSummary,
      batches: rerankerBatchTelemetry
    },
    cases: caseDetails,
    caveats: [
      "All systems for a case use the same currently reconstructed Canonical Evidence universe.",
      "Historical frozen Top-16 is used only for baseline drift diagnostics and never for metrics.",
      "Current Retrieval is rerun from the production-equivalent QA input, including query-scoped SQLite Memory context for week/all, and remains capped at its production Top-16.",
      "Dense and Hybrid are shadow-only; no candidate enters QA and no citation is generated.",
      "Memory is navigation-only: every Phase 5 candidate is a current Canonical Evidence object.",
      "Current scope disables Memory expansion; week mapping is bounded by recording date.",
      "Embedding indexing/query failures are recorded; Hybrid continues with non-Dense channels and dense Memory variants fall back exactly to Phase 3.1 order.",
      "Recall is micro-averaged over available gold evidence groups.",
      "nDCG@10 is normalized discounted first coverage of each gold evidence group.",
      "Reranker only reorders the Hybrid Top-30 and falls back to Hybrid order on any failure."
    ]
  };
}
