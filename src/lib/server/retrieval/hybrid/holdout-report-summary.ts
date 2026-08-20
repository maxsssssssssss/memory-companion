import { createHash } from "node:crypto";
import { z } from "zod";
import {
  classifyCaseMovement,
  pairedBootstrap,
  type BenchmarkCaseContribution
} from "./benchmark-statistics";

const RankSchema = z.number().int().positive().nullable();
const MetricSchema = z.record(z.string(), z.number());
const SystemSchema = z.object({
  metrics: MetricSchema
}).passthrough();
const CaseSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  category: z.string().min(1),
  retrievalEvaluable: z.boolean(),
  availableExpectedGroupCount: z.number().int().nonnegative(),
  ranks: z.record(z.string(), RankSchema),
  recallAt30: z.record(z.string(), z.number()),
  candidateIds: z.record(z.string(), z.array(z.string())).optional(),
  goldGroupRanks: z.record(z.string(), z.array(RankSchema)).optional()
}).passthrough();

export const FixedHybridReportSchema = z.object({
  version: z.number(),
  kind: z.string(),
  generatedAt: z.string(),
  reproducibility: z.object({
    fixtureHash: z.string(),
    canonicalUniverseHash: z.string(),
    embeddingModel: z.object({
      modelName: z.string(),
      modelVersion: z.string(),
      dimension: z.number().int().positive()
    }).passthrough()
  }).passthrough(),
  baseline: z.record(z.string(), z.unknown()),
  indexing: z.record(z.string(), z.unknown()),
  memoryIndexing: z.record(z.string(), z.unknown()),
  systems: z.record(z.string(), SystemSchema),
  categories: z.unknown().optional(),
  phase5Experiments: z.unknown().optional(),
  phase5Categories: z.unknown().optional(),
  cases: z.array(CaseSchema)
}).passthrough();

export type FixedHybridReport = z.infer<typeof FixedHybridReportSchema>;

const REQUIRED_SYSTEMS = {
  current: "current",
  optimizedV1: "hybridOptimizedRanking",
  phase31: "hybridPhase31Ranking"
} as const;

type RequiredSystemKey = keyof typeof REQUIRED_SYSTEMS;
type ReportCase = FixedHybridReport["cases"][number];

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

function digest(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function deepEqual(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

function evaluableCases(report: FixedHybridReport) {
  return report.cases
    .filter((item) =>
      item.retrievalEvaluable && item.availableExpectedGroupCount > 0
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function assertPairedCaseIds(left: readonly ReportCase[], right: readonly ReportCase[]) {
  const leftIds = left.map((item) => item.id);
  const rightIds = right.map((item) => item.id);
  if (!deepEqual(leftIds, rightIds)) {
    throw new Error("Fixed reports must contain exactly matching evaluable case IDs");
  }
}

function requiredSystemName(key: RequiredSystemKey) {
  return REQUIRED_SYSTEMS[key];
}

function hasExactGoldGroupRanks(cases: readonly ReportCase[]) {
  return cases.every((item) =>
    Object.values(REQUIRED_SYSTEMS).every((system) => {
      const ranks = item.goldGroupRanks?.[system];
      return Boolean(
        ranks &&
        ranks.length === item.availableExpectedGroupCount
      );
    })
  );
}

function contributionFromGoldGroupRanks(
  item: ReportCase,
  system: string
): BenchmarkCaseContribution {
  const ranks = item.goldGroupRanks?.[system];
  if (!ranks || ranks.length !== item.availableExpectedGroupCount) {
    throw new Error(
      `Case ${item.id}/${system} has incomplete gold-group rank diagnostics`
    );
  }
  const finiteRanks = ranks.flatMap((rank) => rank === null ? [] : [rank]);
  const firstGoldRank =
    finiteRanks.length > 0 ? Math.min(...finiteRanks) : null;
  const hits = (limit: number) =>
    ranks.filter((rank) => rank !== null && rank <= limit).length;
  return {
    caseId: item.id,
    groupCount: ranks.length,
    hitsAt5: hits(5),
    hitsAt10: hits(10),
    hitsAt16: hits(16),
    hitsAt30: hits(30),
    firstGoldRank,
    reciprocalRank: firstGoldRank ? 1 / firstGoldRank : 0,
    ndcgAt10:
      ranks.reduce<number>((sum, rank) =>
        sum + (rank !== null && rank <= 10 ? 1 / Math.log2(rank + 1) : 0), 0
      ) / Math.max(1, ranks.length)
  };
}

function contributionFromFirstGoldRank(
  item: ReportCase,
  system: string
): BenchmarkCaseContribution {
  const rank = item.ranks[system] ?? null;
  const hit = (limit: number) => rank !== null && rank <= limit ? 1 : 0;
  return {
    caseId: item.id,
    groupCount: 1,
    hitsAt5: hit(5),
    hitsAt10: hit(10),
    hitsAt16: hit(16),
    hitsAt30: hit(30),
    firstGoldRank: rank,
    reciprocalRank: rank ? 1 / rank : 0,
    ndcgAt10: rank && rank <= 10 ? 1 / Math.log2(rank + 1) : 0
  };
}

function contributions(
  cases: readonly ReportCase[],
  system: string,
  exactGoldGroups: boolean
) {
  return cases.map((item) =>
    exactGoldGroups
      ? contributionFromGoldGroupRanks(item, system)
      : contributionFromFirstGoldRank(item, system)
  );
}

function systemMetricsProjection(report: FixedHybridReport) {
  return Object.fromEntries(
    Object.entries(report.systems)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, value.metrics])
  );
}

function categoryMetricsProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(categoryMetricsProjection);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "latency")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, categoryMetricsProjection(item)])
  );
}

function exactCandidateIdsAvailable(
  cases: readonly ReportCase[],
  systemNames: readonly string[]
) {
  return cases.every((item) =>
    systemNames.every((system) => Array.isArray(item.candidateIds?.[system]))
  );
}

function candidateOrderProjection(
  cases: readonly ReportCase[],
  systemNames: readonly string[],
  exactCandidateIds: boolean
) {
  return cases.map((item) => ({
    id: item.id,
    systems: Object.fromEntries(systemNames.map((system) => [
      system,
      exactCandidateIds
        ? item.candidateIds?.[system] ?? []
        : {
            firstGoldRank: item.ranks[system] ?? null,
            recallAt30: item.recallAt30[system] ?? 0
          }
    ]))
  }));
}

function normalizedReportProjection(
  report: FixedHybridReport,
  candidateOrder: unknown
) {
  return {
    identity: {
      version: report.version,
      kind: report.kind,
      fixtureHash: report.reproducibility.fixtureHash,
      canonicalUniverseHash: report.reproducibility.canonicalUniverseHash,
      embeddingModel: report.reproducibility.embeddingModel
    },
    baseline: report.baseline,
    indexing: {
      total: report.indexing.total ?? null
    },
    memoryIndexing: {
      total: report.memoryIndexing.total ?? null
    },
    systemMetrics: systemMetricsProjection(report),
    categories: categoryMetricsProjection(report.categories),
    phase5Experiments: categoryMetricsProjection(report.phase5Experiments),
    phase5Categories: categoryMetricsProjection(report.phase5Categories),
    candidateOrder
  };
}

function movementSummary(values: readonly string[]) {
  return {
    improved: values.filter((value) => value === "improved").length,
    unchanged: values.filter((value) => value === "unchanged").length,
    regressed: values.filter((value) => value === "regressed").length
  };
}

export function parseFixedHybridReport(value: unknown) {
  return FixedHybridReportSchema.parse(value);
}

export function summarizeFixedHybridReportPair(input: {
  runA: FixedHybridReport;
  runB: FixedHybridReport;
  runAPath?: string;
  runBPath?: string;
  runARawSha256?: string;
  runBRawSha256?: string;
  bootstrapSeed?: number;
  bootstrapIterations?: number;
}) {
  const runACases = evaluableCases(input.runA);
  const runBCases = evaluableCases(input.runB);
  assertPairedCaseIds(runACases, runBCases);

  for (const system of Object.values(REQUIRED_SYSTEMS)) {
    if (!input.runA.systems[system] || !input.runB.systems[system]) {
      throw new Error(`Fixed report is missing required system ${system}`);
    }
  }

  const systemNames = [...new Set([
    ...Object.keys(input.runA.systems),
    ...Object.keys(input.runB.systems)
  ])].sort();
  const exactCandidateIds =
    exactCandidateIdsAvailable(runACases, systemNames) &&
    exactCandidateIdsAvailable(runBCases, systemNames);
  const runAOrder = candidateOrderProjection(
    runACases,
    systemNames,
    exactCandidateIds
  );
  const runBOrder = candidateOrderProjection(
    runBCases,
    systemNames,
    exactCandidateIds
  );
  const exactGoldGroups =
    hasExactGoldGroupRanks(runACases) &&
    hasExactGoldGroupRanks(runBCases);
  const contributionSets = Object.fromEntries(
    Object.entries(REQUIRED_SYSTEMS).map(([key, system]) => [
      key,
      contributions(runACases, system, exactGoldGroups)
    ])
  ) as Record<RequiredSystemKey, BenchmarkCaseContribution[]>;
  const bySystemAndCase = Object.fromEntries(
    Object.entries(contributionSets).map(([key, values]) => [
      key,
      new Map(values.map((item) => [item.caseId, item]))
    ])
  ) as Record<RequiredSystemKey, Map<string, BenchmarkCaseContribution>>;

  const movements = runACases.map((item) => {
    const current = bySystemAndCase.current.get(item.id)!;
    const optimizedV1 = bySystemAndCase.optimizedV1.get(item.id)!;
    const phase31 = bySystemAndCase.phase31.get(item.id)!;
    return {
      caseId: item.id,
      scope: item.scope,
      category: item.category,
      groupCount: phase31.groupCount,
      firstGoldRanks: {
        current: current.firstGoldRank,
        optimizedV1: optimizedV1.firstGoldRank,
        phase31: phase31.firstGoldRank
      },
      coveredGroupsAt16: {
        current: current.hitsAt16,
        optimizedV1: optimizedV1.hitsAt16,
        phase31: phase31.hitsAt16
      },
      phase31VsCurrent: classifyCaseMovement({
        baseline: current,
        experiment: phase31
      }),
      phase31VsOptimizedV1: classifyCaseMovement({
        baseline: optimizedV1,
        experiment: phase31
      })
    };
  });

  const seed = input.bootstrapSeed ?? 31_415_926;
  const iterations = input.bootstrapIterations ?? 10_000;
  const runAProjection = normalizedReportProjection(input.runA, runAOrder);
  const runBProjection = normalizedReportProjection(input.runB, runBOrder);
  const systemMetricsA = systemMetricsProjection(input.runA);
  const systemMetricsB = systemMetricsProjection(input.runB);
  const identityA = runAProjection.identity;
  const identityB = runBProjection.identity;

  return {
    version: 1,
    kind: "daily_brief_fixed_holdout_report_summary",
    generatedAt: new Date().toISOString(),
    sources: {
      runA: {
        path: input.runAPath ?? null,
        rawSha256: input.runARawSha256 ?? null,
        generatedAt: input.runA.generatedAt
      },
      runB: {
        path: input.runBPath ?? null,
        rawSha256: input.runBRawSha256 ?? null,
        generatedAt: input.runB.generatedAt
      }
    },
    determinism: {
      evaluableCaseCount: runACases.length,
      identityEqual: deepEqual(identityA, identityB),
      systemMetricsEqual: deepEqual(systemMetricsA, systemMetricsB),
      candidateOrdering: {
        mode: exactCandidateIds
          ? "candidate_ids"
          : "first_gold_rank_and_recall_at_30_projection",
        exact: deepEqual(runAOrder, runBOrder),
        runAFingerprint: digest(runAOrder),
        runBFingerprint: digest(runBOrder),
        fullCandidateOrderSerialized: exactCandidateIds,
        caveat: exactCandidateIds
          ? null
          : "The source reports do not serialize candidate IDs; only order-derived rank projections were compared."
      },
      goldGroupRanksSerialized: exactGoldGroups,
      normalizedReportEqual: deepEqual(runAProjection, runBProjection),
      runANormalizedFingerprint: digest(runAProjection),
      runBNormalizedFingerprint: digest(runBProjection),
      ignoredFields: [
        "generatedAt",
        "latency",
        "indexing.embedded",
        "indexing.unchanged",
        "indexing.removed",
        "memoryIndexing.embedded",
        "memoryIndexing.unchanged",
        "memoryIndexing.removed"
      ]
    },
    bootstrap: {
      basis: exactGoldGroups
        ? "gold_group_ranks"
        : "first_gold_case_hit_fallback",
      caveat: exactGoldGroups
        ? null
        : "Micro gold-group Recall cannot be reconstructed from legacy reports; intervals use one first-gold hit observation per case.",
      phase31VsCurrent: pairedBootstrap({
        baseline: contributionSets.current,
        experiment: contributionSets.phase31,
        seed,
        iterations
      }),
      phase31VsOptimizedV1: pairedBootstrap({
        baseline: contributionSets.optimizedV1,
        experiment: contributionSets.phase31,
        seed,
        iterations
      })
    },
    systems: {
      current: input.runA.systems[requiredSystemName("current")]!.metrics,
      optimizedV1:
        input.runA.systems[requiredSystemName("optimizedV1")]!.metrics,
      phase31: input.runA.systems[requiredSystemName("phase31")]!.metrics
    },
    movementSummary: {
      phase31VsCurrent: movementSummary(
        movements.map((item) => item.phase31VsCurrent)
      ),
      phase31VsOptimizedV1: movementSummary(
        movements.map((item) => item.phase31VsOptimizedV1)
      )
    },
    cases: movements
  };
}
