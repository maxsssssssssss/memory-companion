export type BenchmarkCaseContribution = {
  caseId: string;
  groupCount: number;
  hitsAt5: number;
  hitsAt10: number;
  hitsAt16: number;
  hitsAt30: number;
  firstGoldRank: number | null;
  reciprocalRank: number;
  ndcgAt10: number;
};

export type PairedMetricName = "recallAt10" | "recallAt16" | "mrr" | "ndcgAt10";

export type PairedBootstrapInterval = {
  pointDelta: number;
  lower95: number;
  upper95: number;
  probabilityPositive: number;
};

export type CaseMovement = "improved" | "unchanged" | "regressed";

function aggregate(values: readonly BenchmarkCaseContribution[]) {
  const totalGroups = values.reduce((sum, value) => sum + value.groupCount, 0);
  const mean = (selector: (value: BenchmarkCaseContribution) => number) =>
    values.reduce((sum, value) => sum + selector(value), 0) /
    Math.max(1, values.length);
  return {
    recallAt10: values.reduce((sum, value) => sum + value.hitsAt10, 0) /
      Math.max(1, totalGroups),
    recallAt16: values.reduce((sum, value) => sum + value.hitsAt16, 0) /
      Math.max(1, totalGroups),
    mrr: mean((value) => value.reciprocalRank),
    ndcgAt10: mean((value) => value.ndcgAt10)
  };
}

function xorshift32(seed: number) {
  let state = seed | 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function percentile(sorted: readonly number[], fraction: number) {
  if (sorted.length === 0) return 0;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))
  );
  return sorted[index]!;
}

export function pairedBootstrap(input: {
  baseline: readonly BenchmarkCaseContribution[];
  experiment: readonly BenchmarkCaseContribution[];
  iterations?: number;
  seed?: number;
}) {
  const baselineById = new Map(input.baseline.map((item) => [item.caseId, item]));
  const experimentById = new Map(input.experiment.map((item) => [item.caseId, item]));
  const caseIds = [...baselineById.keys()]
    .filter((caseId) => experimentById.has(caseId))
    .sort();
  if (
    caseIds.length !== baselineById.size ||
    caseIds.length !== experimentById.size
  ) {
    throw new Error("Paired bootstrap requires exactly matching case IDs");
  }
  if (caseIds.length === 0) throw new Error("Paired bootstrap requires at least one case");
  const baseline = caseIds.map((caseId) => baselineById.get(caseId)!);
  const experiment = caseIds.map((caseId) => experimentById.get(caseId)!);
  const pointBaseline = aggregate(baseline);
  const pointExperiment = aggregate(experiment);
  const metrics: PairedMetricName[] = [
    "recallAt10",
    "recallAt16",
    "mrr",
    "ndcgAt10"
  ];
  const samples = Object.fromEntries(
    metrics.map((metric) => [metric, [] as number[]])
  ) as Record<PairedMetricName, number[]>;
  const iterations = Math.max(1, Math.floor(input.iterations ?? 10_000));
  const random = xorshift32(input.seed ?? 31_415_926);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampledBaseline: BenchmarkCaseContribution[] = [];
    const sampledExperiment: BenchmarkCaseContribution[] = [];
    for (let index = 0; index < caseIds.length; index += 1) {
      const sampledIndex = Math.floor(random() * caseIds.length);
      sampledBaseline.push(baseline[sampledIndex]!);
      sampledExperiment.push(experiment[sampledIndex]!);
    }
    const baselineMetrics = aggregate(sampledBaseline);
    const experimentMetrics = aggregate(sampledExperiment);
    for (const metric of metrics) {
      samples[metric].push(experimentMetrics[metric] - baselineMetrics[metric]);
    }
  }
  return {
    caseCount: caseIds.length,
    iterations,
    seed: input.seed ?? 31_415_926,
    metrics: Object.fromEntries(metrics.map((metric) => {
      const values = samples[metric].sort((left, right) => left - right);
      return [metric, {
        pointDelta: pointExperiment[metric] - pointBaseline[metric],
        lower95: percentile(values, 0.025),
        upper95: percentile(values, 0.975),
        probabilityPositive:
          values.filter((value) => value > 0).length / Math.max(1, values.length)
      } satisfies PairedBootstrapInterval];
    })) as Record<PairedMetricName, PairedBootstrapInterval>
  };
}

export function classifyCaseMovement(input: {
  baseline: BenchmarkCaseContribution;
  experiment: BenchmarkCaseContribution;
}): CaseMovement {
  if (input.baseline.caseId !== input.experiment.caseId) {
    throw new Error("Case movement comparison requires the same case ID");
  }
  const completeAt16 = (value: BenchmarkCaseContribution) =>
    value.groupCount > 0 && value.hitsAt16 === value.groupCount ? 1 : 0;
  const rankQuality = (value: BenchmarkCaseContribution) =>
    value.firstGoldRank === null ? -Number.MAX_SAFE_INTEGER : -value.firstGoldRank;
  const baseline = [
    completeAt16(input.baseline),
    rankQuality(input.baseline),
    input.baseline.hitsAt10
  ];
  const experiment = [
    completeAt16(input.experiment),
    rankQuality(input.experiment),
    input.experiment.hitsAt10
  ];
  for (let index = 0; index < baseline.length; index += 1) {
    if (experiment[index]! > baseline[index]!) return "improved";
    if (experiment[index]! < baseline[index]!) return "regressed";
  }
  return "unchanged";
}
