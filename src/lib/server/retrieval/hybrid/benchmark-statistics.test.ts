import { describe, expect, it } from "vitest";
import {
  classifyCaseMovement,
  pairedBootstrap,
  type BenchmarkCaseContribution
} from "./benchmark-statistics";

function contribution(
  caseId: string,
  rank: number | null,
  hitsAt10: number
): BenchmarkCaseContribution {
  return {
    caseId,
    groupCount: 1,
    hitsAt5: rank !== null && rank <= 5 ? 1 : 0,
    hitsAt10,
    hitsAt16: rank !== null && rank <= 16 ? 1 : 0,
    hitsAt30: rank !== null && rank <= 30 ? 1 : 0,
    firstGoldRank: rank,
    reciprocalRank: rank ? 1 / rank : 0,
    ndcgAt10: rank && rank <= 10 ? 1 / Math.log2(rank + 1) : 0
  };
}

describe("holdout benchmark statistics", () => {
  it("produces deterministic paired bootstrap intervals with a fixed seed", () => {
    const baseline = [
      contribution("h01", 12, 0),
      contribution("h02", 4, 1),
      contribution("h03", null, 0)
    ];
    const experiment = [
      contribution("h01", 3, 1),
      contribution("h02", 2, 1),
      contribution("h03", 9, 1)
    ];
    const first = pairedBootstrap({
      baseline,
      experiment,
      iterations: 2_000,
      seed: 42
    });
    const second = pairedBootstrap({
      baseline,
      experiment,
      iterations: 2_000,
      seed: 42
    });
    expect(first).toEqual(second);
    expect(first.metrics.recallAt10.pointDelta).toBeCloseTo(2 / 3);
    expect(first.metrics.mrr.probabilityPositive).toBeGreaterThan(0.9);
  });

  it("rejects unpaired case sets", () => {
    expect(() => pairedBootstrap({
      baseline: [contribution("h01", 1, 1)],
      experiment: [contribution("h02", 1, 1)]
    })).toThrow(/matching case IDs/u);
  });

  it("classifies complete Top-16 coverage before rank quality", () => {
    expect(classifyCaseMovement({
      baseline: contribution("h01", 2, 1),
      experiment: contribution("h01", 17, 0)
    })).toBe("regressed");
    expect(classifyCaseMovement({
      baseline: contribution("h01", 8, 1),
      experiment: contribution("h01", 3, 1)
    })).toBe("improved");
  });
});
