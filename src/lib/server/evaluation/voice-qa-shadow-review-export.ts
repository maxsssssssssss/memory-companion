import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getDataRootDir } from "@/lib/server/storage/paths";
import {
  VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION
} from "./voice-qa-shadow-review";
import {
  VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS
} from "./voice-qa-shadow-review-repository";
import type {
  StoredVoiceQaShadowReviewCaseBundle,
  StoredVoiceQaShadowRetrievalRun,
  VoiceQaShadowReviewRepository,
  VoiceQaShadowReviewScope,
  VoiceQaShadowReviewSystem
} from "./voice-qa-shadow-review-repository";

export const VOICE_QA_SHADOW_REVIEW_EXPORT_VERSION =
  "voice_qa_shadow_review_export_v1";
export const VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_SEED = 0x51a7_2026;
export const VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_ITERATIONS = 10_000;

export const VOICE_QA_SHADOW_REVIEW_EXPORT_FILES = [
  "dataset-manifest.json",
  "retrieval-comparison.json",
  "answer-blind-review.json",
  "latency-and-fallback.json",
  "per-case-movements.json",
  "decision-report.md"
] as const;

type JsonExportFileName =
  Exclude<(typeof VOICE_QA_SHADOW_REVIEW_EXPORT_FILES)[number], "decision-report.md">;
type ReviewReadSource = Pick<
  VoiceQaShadowReviewRepository,
  "listCases" | "getCaseBundle" | "listFaultRuns"
>;
type NullableMetric = number | null;

type LatencySummary = {
  count: number;
  p50Ms: NullableMetric;
  p95Ms: NullableMetric;
  maxMs: NullableMetric;
};

type CaseQuality = {
  recallAt5: number;
  recallAt10: number;
  recallAt16: number;
  recallAt30: number;
  reciprocalRank: number;
  ndcgAt10: number;
  completeMiss: boolean;
  hitGroupsAt16: Set<number>;
  hitGroupsAt30: Set<number>;
};

type InternalCase = {
  bundle: StoredVoiceQaShadowReviewCaseBundle;
  canonicalEvidenceIds: Set<string> | null;
  goldGroups: string[][];
  qualityEligible: boolean;
};

type SystemCaseEvaluation = {
  internalCase: InternalCase;
  primary: StoredVoiceQaShadowRetrievalRun | null;
  replay: StoredVoiceQaShadowRetrievalRun | null;
  quality: CaseQuality | null;
  canonicalValidity: boolean | null;
  replayInputConsistent: boolean | null;
  replayOrderConsistent: boolean | null;
};

type SystemEvaluation = {
  system: VoiceQaShadowReviewSystem;
  cases: SystemCaseEvaluation[];
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rounded(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? null : rounded(numerator / denominator);
}

function percentagePoints(value: number | null) {
  return value === null ? null : rounded(value * 100, 3);
}

function latencySummary(values: readonly number[]): LatencySummary {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const percentile = (percent: number) => {
    if (sorted.length === 0) return null;
    const index = Math.max(
      0,
      Math.min(sorted.length - 1, Math.ceil(percent * sorted.length) - 1)
    );
    return rounded(sorted[index]!);
  };
  return {
    count: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.length > 0 ? rounded(sorted[sorted.length - 1]!) : null
  };
}

function primaryRun(
  bundle: StoredVoiceQaShadowReviewCaseBundle,
  system: VoiceQaShadowReviewSystem
) {
  return bundle.retrievalRuns.find(
    (run) => run.system === system && run.replayIndex === 0
  ) ?? null;
}

function replayRun(
  bundle: StoredVoiceQaShadowReviewCaseBundle,
  system: VoiceQaShadowReviewSystem
) {
  return bundle.retrievalRuns.find(
    (run) => run.system === system && run.replayIndex === 1
  ) ?? null;
}

function candidateRank(
  run: StoredVoiceQaShadowRetrievalRun,
  evidenceId: string,
  cutoff: 5 | 10 | 16 | 30
) {
  let best: number | null = null;
  for (const candidate of run.candidates) {
    if (candidate.evidenceId !== evidenceId) continue;
    const rank = cutoff === 30 ? candidate.rank : candidate.selectedRank;
    if (rank === null || rank > cutoff) continue;
    best = best === null ? rank : Math.min(best, rank);
  }
  return best;
}

function hitGroups(
  run: StoredVoiceQaShadowRetrievalRun,
  groups: readonly (readonly string[])[],
  cutoff: 5 | 10 | 16 | 30
) {
  const hits = new Set<number>();
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]!;
    if (
      group.some((evidenceId) =>
        candidateRank(run, evidenceId, cutoff) !== null
      )
    ) {
      hits.add(groupIndex);
    }
  }
  return hits;
}

function evaluateQuality(
  run: StoredVoiceQaShadowRetrievalRun,
  groups: readonly (readonly string[])[]
): CaseQuality {
  const hit5 = hitGroups(run, groups, 5);
  const hit10 = hitGroups(run, groups, 10);
  const hit16 = hitGroups(run, groups, 16);
  const hit30 = hitGroups(run, groups, 30);
  let firstRank: number | null = null;
  for (const group of groups) {
    for (const evidenceId of group) {
      const rank = candidateRank(run, evidenceId, 16);
      if (rank !== null) firstRank = firstRank === null
        ? rank
        : Math.min(firstRank, rank);
    }
  }

  const coveredGroups = new Set<number>();
  let dcg = 0;
  const selected = run.candidates
    .filter((candidate) =>
      candidate.selectedRank !== null && candidate.selectedRank <= 10
    )
    .sort((left, right) => left.selectedRank! - right.selectedRank!);
  for (const candidate of selected) {
    const newlyRelevantGroup = groups.findIndex(
      (group, groupIndex) =>
        !coveredGroups.has(groupIndex) &&
        group.includes(candidate.evidenceId)
    );
    if (newlyRelevantGroup < 0) continue;
    coveredGroups.add(newlyRelevantGroup);
    dcg += 1 / Math.log2(candidate.selectedRank! + 1);
  }
  let idealDcg = 0;
  for (let rank = 1; rank <= Math.min(10, groups.length); rank += 1) {
    idealDcg += 1 / Math.log2(rank + 1);
  }

  return {
    recallAt5: hit5.size / groups.length,
    recallAt10: hit10.size / groups.length,
    recallAt16: hit16.size / groups.length,
    recallAt30: hit30.size / groups.length,
    reciprocalRank: firstRank === null ? 0 : 1 / firstRank,
    ndcgAt10: idealDcg === 0 ? 0 : dcg / idealDcg,
    completeMiss: hit30.size === 0,
    hitGroupsAt16: hit16,
    hitGroupsAt30: hit30
  };
}

function canonicalValidity(
  internalCase: InternalCase,
  run: StoredVoiceQaShadowRetrievalRun | null
) {
  if (!run || !internalCase.canonicalEvidenceIds) return null;
  return (
    run.candidateValidity &&
    run.candidates.every((candidate) =>
      internalCase.canonicalEvidenceIds!.has(candidate.evidenceId)
    )
  );
}

function evaluateSystem(
  internalCases: readonly InternalCase[],
  system: VoiceQaShadowReviewSystem
): SystemEvaluation {
  return {
    system,
    cases: internalCases.map((internalCase) => {
      const primary = primaryRun(internalCase.bundle, system);
      const replay = replayRun(internalCase.bundle, system);
      return {
        internalCase,
        primary,
        replay,
        quality:
          primary && internalCase.qualityEligible
            ? evaluateQuality(primary, internalCase.goldGroups)
            : null,
        canonicalValidity: canonicalValidity(internalCase, primary),
        replayInputConsistent:
          primary && replay ? primary.inputHash === replay.inputHash : null,
        replayOrderConsistent:
          primary && replay ? primary.orderHash === replay.orderHash : null
      };
    })
  };
}

function average(values: readonly number[]) {
  return values.length === 0
    ? null
    : rounded(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function aggregateSystem(evaluation: SystemEvaluation) {
  const validCases = evaluation.cases.filter(
    (item) => item.internalCase.bundle.case.status === "valid"
  );
  const primaryCases = validCases.filter((item) => item.primary !== null);
  const qualityCases = evaluation.cases.filter((item) => item.quality !== null);
  const qualitySummary = (
    selectedCases: readonly SystemCaseEvaluation[]
  ) => {
    const goldGroupCount = selectedCases.reduce(
      (sum, item) => sum + item.internalCase.goldGroups.length,
      0
    );
    const groupHits = (cutoff: 5 | 10 | 16 | 30) =>
      selectedCases.reduce((sum, item) => {
      const quality = item.quality!;
      if (cutoff === 5) {
        return sum + Math.round(
          quality.recallAt5 * item.internalCase.goldGroups.length
        );
      }
      if (cutoff === 10) {
        return sum + Math.round(
          quality.recallAt10 * item.internalCase.goldGroups.length
        );
      }
      if (cutoff === 16) return sum + quality.hitGroupsAt16.size;
      return sum + quality.hitGroupsAt30.size;
      }, 0);
    return {
      evaluatedCaseCount: selectedCases.length,
      goldGroupCount,
      recallAt5: ratio(groupHits(5), goldGroupCount),
      recallAt10: ratio(groupHits(10), goldGroupCount),
      recallAt16: ratio(groupHits(16), goldGroupCount),
      recallAt30: ratio(groupHits(30), goldGroupCount),
      mrr: average(selectedCases.map((item) => item.quality!.reciprocalRank)),
      ndcgAt10: average(selectedCases.map((item) => item.quality!.ndcgAt10)),
      completeMissCount: selectedCases.filter(
        (item) => item.quality!.completeMiss
      ).length
    };
  };
  const overallQuality = qualitySummary(qualityCases);
  const categories = [...new Set(qualityCases.flatMap(
    (item) => item.internalCase.bundle.gold?.categories ?? []
  ))].sort();
  const byCategory = Object.fromEntries(categories.map((category) => [
    category,
    qualitySummary(qualityCases.filter(
      (item) => item.internalCase.bundle.gold?.categories.includes(category)
    ))
  ]));
  const categoryRecallValues = categories.flatMap((category) => {
    const value = byCategory[category]?.recallAt16;
    return value === null || value === undefined
      ? []
      : [{ category, value }];
  });
  const worstCategoryRecall = categoryRecallValues.length === 0
    ? null
    : Math.min(...categoryRecallValues.map((item) => item.value));
  const worstCategories = worstCategoryRecall === null
    ? []
    : categoryRecallValues
        .filter((item) => item.value === worstCategoryRecall)
        .map((item) => item.category);
  const allCandidates = primaryCases.flatMap(
    (item) => item.primary?.candidates ?? []
  );
  const canonicalCandidateCount = primaryCases.reduce((sum, item) => {
    if (!item.internalCase.canonicalEvidenceIds) return sum;
    return sum + item.primary!.candidates.filter((candidate) =>
      item.internalCase.canonicalEvidenceIds!.has(candidate.evidenceId)
    ).length;
  }, 0);
  const canonicalAssessedCandidateCount = primaryCases.reduce(
    (sum, item) =>
      sum +
      (item.internalCase.canonicalEvidenceIds
        ? item.primary!.candidates.length
        : 0),
    0
  );
  const replayAssessed = validCases.filter(
    (item) =>
      item.replayInputConsistent !== null &&
      item.replayOrderConsistent !== null
  );
  const replayConsistent = replayAssessed.filter(
    (item) =>
      item.replayInputConsistent === true &&
      item.replayOrderConsistent === true
  ).length;

  return {
    system: evaluation.system,
    primaryRunCoverage: {
      validCaseCount: validCases.length,
      runCount: primaryCases.length,
      ratio: ratio(primaryCases.length, validCases.length)
    },
    quality: {
      ...overallQuality,
      byCategory,
      worstCategoryByRecallAt16: {
        categories: worstCategories,
        recallAt16: worstCategoryRecall
      }
    },
    canonicalValidity: {
      candidateCount: allCandidates.length,
      assessedCandidateCount: canonicalAssessedCandidateCount,
      validCandidateCount: canonicalCandidateCount,
      ratio: ratio(
        canonicalCandidateCount,
        canonicalAssessedCandidateCount
      ),
      runPassCount: primaryCases.filter(
        (item) => item.canonicalValidity === true
      ).length,
      runAssessedCount: primaryCases.filter(
        (item) => item.canonicalValidity !== null
      ).length,
      allAssessedRunsValid:
        primaryCases.length > 0 &&
        primaryCases.every((item) => item.canonicalValidity === true)
    },
    latency: {
      total: latencySummary(
        primaryCases.map((item) => item.primary!.totalLatencyMs)
      ),
      dense: latencySummary(
        primaryCases.flatMap((item) =>
          item.primary!.denseLatencyMs === null
            ? []
            : [item.primary!.denseLatencyMs]
        )
      )
    },
    fallback: {
      count: primaryCases.filter(
        (item) =>
          item.primary!.status === "fallback" ||
          item.primary!.fallbackReason !== null
      ).length,
      ratio: ratio(
        primaryCases.filter(
          (item) =>
            item.primary!.status === "fallback" ||
            item.primary!.fallbackReason !== null
        ).length,
        primaryCases.length
      )
    },
    replayConsistency: {
      assessedCaseCount: replayAssessed.length,
      identicalCaseCount: replayConsistent,
      ratio: ratio(replayConsistent, replayAssessed.length),
      allAssessedIdentical:
        replayAssessed.length > 0 &&
        replayConsistent === replayAssessed.length
    }
  };
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quantile(sorted: readonly number[], position: number) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function pairedBootstrap(
  pairs: readonly { baseline: number; challenger: number }[],
  seed: number
) {
  if (pairs.length === 0) {
    return {
      seed,
      iterations: VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_ITERATIONS,
      pairedCaseCount: 0,
      meanDifference: null,
      ci95: { lower: null, upper: null }
    };
  }
  const random = mulberry32(seed);
  const differences: number[] = [];
  for (
    let iteration = 0;
    iteration < VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_ITERATIONS;
    iteration += 1
  ) {
    let sum = 0;
    for (let sample = 0; sample < pairs.length; sample += 1) {
      const pair = pairs[Math.floor(random() * pairs.length)]!;
      sum += pair.challenger - pair.baseline;
    }
    differences.push(sum / pairs.length);
  }
  differences.sort((left, right) => left - right);
  const observed = pairs.reduce(
    (sum, pair) => sum + pair.challenger - pair.baseline,
    0
  ) / pairs.length;
  return {
    seed,
    iterations: VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_ITERATIONS,
    pairedCaseCount: pairs.length,
    meanDifference: rounded(observed),
    ci95: {
      lower: rounded(quantile(differences, 0.025)!),
      upper: rounded(quantile(differences, 0.975)!)
    }
  };
}

function compareSystems(
  baseline: SystemEvaluation,
  challenger: SystemEvaluation,
  seed: number
) {
  const baselineByCase = new Map(
    baseline.cases.map((item) => [item.internalCase.bundle.case.caseId, item])
  );
  let top16GoldGains = 0;
  let top16GoldLosses = 0;
  let recoveredCompleteMisses = 0;
  const pairs: Array<{ baseline: number; challenger: number }> = [];
  const pairedCases: Array<{
    caseId: string;
    baseline: SystemCaseEvaluation;
    challenger: SystemCaseEvaluation;
  }> = [];
  for (const challengerCase of challenger.cases) {
    const caseId = challengerCase.internalCase.bundle.case.caseId;
    const baselineCase = baselineByCase.get(caseId);
    if (!baselineCase?.quality || !challengerCase.quality) continue;
    pairs.push({
      baseline: baselineCase.quality.recallAt16,
      challenger: challengerCase.quality.recallAt16
    });
    pairedCases.push({
      caseId,
      baseline: baselineCase,
      challenger: challengerCase
    });
    for (
      let groupIndex = 0;
      groupIndex < challengerCase.internalCase.goldGroups.length;
      groupIndex += 1
    ) {
      const baselineHit = baselineCase.quality.hitGroupsAt16.has(groupIndex);
      const challengerHit =
        challengerCase.quality.hitGroupsAt16.has(groupIndex);
      if (!baselineHit && challengerHit) top16GoldGains += 1;
      if (baselineHit && !challengerHit) top16GoldLosses += 1;
    }
    if (
      baselineCase.quality.completeMiss &&
      !challengerCase.quality.completeMiss
    ) {
      recoveredCompleteMisses += 1;
    }
  }
  const bootstrap = pairedBootstrap(pairs, seed);
  return {
    baseline: baseline.system,
    challenger: challenger.system,
    pairedCaseCount: pairedCases.length,
    recallAt16Difference: bootstrap.meanDifference,
    recallAt16DifferencePercentagePoints:
      percentagePoints(bootstrap.meanDifference),
    top16GoldGains,
    top16GoldLosses,
    netTop16GoldGroups: top16GoldGains - top16GoldLosses,
    recoveredCompleteMisses,
    pairedBootstrap95: bootstrap
  };
}

function scoreObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const fields = [
    "factualCorrectness",
    "completeness",
    "citationSupport",
    "uncertainty",
    "directness"
  ] as const;
  return Object.fromEntries(
    fields.flatMap((field) => {
      const score = finiteNumber(source[field]);
      return score === null ? [] : [[field, score]];
    })
  ) as Partial<Record<(typeof fields)[number], number>>;
}

function weightedBlindScore(scores: ReturnType<typeof scoreObject>) {
  const required = {
    factualCorrectness: 0.35,
    completeness: 0.25,
    citationSupport: 0.2,
    uncertainty: 0.1,
    directness: 0.1
  } as const;
  if (
    Object.keys(required).some(
      (key) => scores[key as keyof typeof required] === undefined
    )
  ) {
    return null;
  }
  return rounded(
    Object.entries(required).reduce(
      (sum, [key, weight]) =>
        sum + scores[key as keyof typeof required]! * weight,
      0
    )
  );
}

function buildBlindReviewReport(internalCases: readonly InternalCase[]) {
  const bySystem = (["A", "B"] as const).map((system) => {
    const answers = internalCases.flatMap((item) =>
      item.bundle.blindAnswers
        .filter((answer) => answer.system === system)
        .map((answer) => ({ caseId: item.bundle.case.caseId, answer }))
    );
    const answerByKey = new Map(
      answers.map(({ caseId, answer }) => [
        `${caseId}\0${answer.round}\0${answer.label}`,
        answer
      ])
    );
    const reviews = internalCases.flatMap((item) =>
      item.bundle.blindReviews.flatMap((review) => {
        const key = `${item.bundle.case.caseId}\0${review.round}\0${review.label}`;
        return answerByKey.has(key)
          ? [{ caseId: item.bundle.case.caseId, review }]
          : [];
      })
    );
    const scores = reviews.map(({ review }) => scoreObject(review.scores));
    const weightedScores = scores.flatMap((score) => {
      const weighted = weightedBlindScore(score);
      return weighted === null ? [] : [weighted];
    });
    const hardViolations = new Map<string, number>();
    for (const { review } of reviews) {
      for (const violation of review.hardViolations) {
        hardViolations.set(
          violation,
          (hardViolations.get(violation) ?? 0) + 1
        );
      }
    }
    const outcomes = {
      win: reviews.filter(({ review }) => review.outcome === "win").length,
      tie: reviews.filter(({ review }) => review.outcome === "tie").length,
      loss: reviews.filter(({ review }) => review.outcome === "loss").length,
      unscored: reviews.filter(({ review }) => review.outcome === "unscored")
        .length
    };
    return {
      system,
      generatedAnswerCount: answers.length,
      reviewedAnswerCount: reviews.length,
      citationValidity: {
        assessedCount: answers.filter(
          ({ answer }) => answer.citationValidity !== null
        ).length,
        passedCount: answers.filter(
          ({ answer }) => answer.citationValidity === true
        ).length,
        ratio: ratio(
          answers.filter(({ answer }) => answer.citationValidity === true)
            .length,
          answers.filter(({ answer }) => answer.citationValidity !== null)
            .length
        )
      },
      averageWeightedScore: average(weightedScores),
      averageScores: Object.fromEntries(
        [
          "factualCorrectness",
          "completeness",
          "citationSupport",
          "uncertainty",
          "directness"
        ].map((field) => [
          field,
          average(
            scores.flatMap((score) => {
              const value = score[field as keyof typeof score];
              return value === undefined ? [] : [value];
            })
          )
        ])
      ),
      outcomes,
      hardViolationCount: [...hardViolations.values()].reduce(
        (sum, count) => sum + count,
        0
      ),
      hardViolations: Object.fromEntries(
        [...hardViolations.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      )
    };
  });

  let twoRoundCompleteCaseCount = 0;
  let roundInconsistentSystemCaseCount = 0;
  const conservativeOutcomes = { win: 0, tie: 0, loss: 0, unscored: 0 };
  for (const item of internalCases) {
    let complete = true;
    for (const system of ["A", "B"] as const) {
      const answers = item.bundle.blindAnswers.filter(
        (answer) => answer.system === system
      );
      const reviews = answers.flatMap((answer) =>
        item.bundle.blindReviews.filter(
          (review) =>
            review.round === answer.round &&
            review.label === answer.label
        )
      );
      const byRound = new Map(reviews.map((review) => [review.round, review]));
      if (!byRound.has(1) || !byRound.has(2)) {
        complete = false;
        continue;
      }
      const first = byRound.get(1)!.outcome;
      const second = byRound.get(2)!.outcome;
      if (first !== second) roundInconsistentSystemCaseCount += 1;
      const conservative =
        first === "loss" || second === "loss"
          ? "loss"
          : first === "win" && second === "win"
            ? "win"
            : first === "unscored" || second === "unscored"
              ? "unscored"
              : "tie";
      conservativeOutcomes[conservative] += 1;
    }
    if (complete) twoRoundCompleteCaseCount += 1;
  }
  return {
    version: VOICE_QA_SHADOW_REVIEW_EXPORT_VERSION,
    privacy: {
      containsQuestionText: false,
      containsEvidenceText: false,
      containsAnswerText: false,
      containsUserId: false,
      blindAnswerMaterialLocation: "user_scoped_sqlite_only"
    },
    scoringWeights: {
      factualCorrectness: 0.35,
      completeness: 0.25,
      citationSupport: 0.2,
      uncertainty: 0.1,
      directness: 0.1
    },
    twoRoundCompleteCaseCount,
    roundInconsistentSystemCaseCount,
    conservativeOutcomes,
    systems: bySystem
  };
}

function scopeCounts(
  cases: readonly InternalCase[],
  predicate: (item: InternalCase) => boolean
) {
  return Object.fromEntries(
    (["current", "week", "all"] as const).map((scope) => [
      scope,
      cases.filter(
        (item) => item.bundle.case.scope === scope && predicate(item)
      ).length
    ])
  ) as Record<VoiceQaShadowReviewScope, number>;
}

function caseMovement(
  internalCase: InternalCase,
  evaluations: Record<VoiceQaShadowReviewSystem, SystemEvaluation>
) {
  const bySystem = Object.fromEntries(
    (["A", "B"] as const).map((system) => {
      const item = evaluations[system].cases.find(
        (candidate) =>
          candidate.internalCase.bundle.case.caseId ===
          internalCase.bundle.case.caseId
      )!;
      return [system, {
        primaryAvailable: item.primary !== null,
        replayAvailable: item.replay !== null,
        recallAt5: item.quality ? rounded(item.quality.recallAt5) : null,
        recallAt10: item.quality ? rounded(item.quality.recallAt10) : null,
        recallAt16: item.quality ? rounded(item.quality.recallAt16) : null,
        recallAt30: item.quality ? rounded(item.quality.recallAt30) : null,
        reciprocalRank: item.quality
          ? rounded(item.quality.reciprocalRank)
          : null,
        ndcgAt10: item.quality ? rounded(item.quality.ndcgAt10) : null,
        completeMiss: item.quality?.completeMiss ?? null,
        canonicalValidity: item.canonicalValidity,
        replayInputConsistent: item.replayInputConsistent,
        replayOrderConsistent: item.replayOrderConsistent,
        totalLatencyMs: item.primary?.totalLatencyMs ?? null,
        fallback: item.primary
          ? item.primary.status === "fallback" ||
            item.primary.fallbackReason !== null
          : null
      }];
    })
  ) as Record<VoiceQaShadowReviewSystem, {
    primaryAvailable: boolean;
    replayAvailable: boolean;
    recallAt5: number | null;
    recallAt10: number | null;
    recallAt16: number | null;
    recallAt30: number | null;
    reciprocalRank: number | null;
    ndcgAt10: number | null;
    completeMiss: boolean | null;
    canonicalValidity: boolean | null;
    replayInputConsistent: boolean | null;
    replayOrderConsistent: boolean | null;
    totalLatencyMs: number | null;
    fallback: boolean | null;
  }>;

  const movement = (
    baseline: VoiceQaShadowReviewSystem,
    challenger: VoiceQaShadowReviewSystem
  ) => {
    const baselineItem = evaluations[baseline].cases.find(
      (item) =>
        item.internalCase.bundle.case.caseId ===
        internalCase.bundle.case.caseId
    )!;
    const challengerItem = evaluations[challenger].cases.find(
      (item) =>
        item.internalCase.bundle.case.caseId ===
        internalCase.bundle.case.caseId
    )!;
    if (!baselineItem.quality || !challengerItem.quality) {
      return {
        state: "unscored",
        recallAt16Difference: null,
        top16GoldGains: null,
        top16GoldLosses: null,
        recoveredCompleteMiss: null
      };
    }
    let gains = 0;
    let losses = 0;
    for (
      let index = 0;
      index < internalCase.goldGroups.length;
      index += 1
    ) {
      const baselineHit = baselineItem.quality.hitGroupsAt16.has(index);
      const challengerHit = challengerItem.quality.hitGroupsAt16.has(index);
      if (!baselineHit && challengerHit) gains += 1;
      if (baselineHit && !challengerHit) losses += 1;
    }
    const difference =
      challengerItem.quality.recallAt16 -
      baselineItem.quality.recallAt16;
    return {
      state: difference > 0 ? "improved" : difference < 0 ? "regressed" : "same",
      recallAt16Difference: rounded(difference),
      top16GoldGains: gains,
      top16GoldLosses: losses,
      recoveredCompleteMiss:
        baselineItem.quality.completeMiss &&
        !challengerItem.quality.completeMiss
    };
  };

  return {
    caseId: internalCase.bundle.case.caseId,
    scope: internalCase.bundle.case.scope,
    collectionStatus: internalCase.bundle.case.status,
    goldStatus: internalCase.bundle.gold?.status ?? "missing",
    goldCategories: internalCase.bundle.gold?.categories ?? [],
    goldGroupCount: internalCase.goldGroups.length,
    systems: bySystem,
    movements: {
      bVsA: movement("A", "B")
    }
  };
}

export function getVoiceQaShadowReviewExportDirectory(
  dataRoot = getDataRootDir()
) {
  return resolve(join(dataRoot, "evaluation", "voice-qa-shadow-review-v1"));
}

export function buildVoiceQaShadowReviewReports(
  source: ReviewReadSource,
  input: { generatedAt?: string } = {}
) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const faultRuns = source.listFaultRuns();
  const cases = source.listCases({ limit: 10_000 });
  const internalCases = cases.flatMap((reviewCase) => {
    const bundle = source.getCaseBundle(reviewCase.caseId);
    if (!bundle) return [];
    const goldGroups = bundle.gold?.status === "evaluable"
      ? bundle.gold.evidenceGroups
      : [];
    return [{
      bundle,
      canonicalEvidenceIds: bundle.canonicalSnapshot
        ? new Set(
            bundle.canonicalSnapshot.evidence.map((item) => item.evidenceId)
          )
        : null,
      goldGroups,
      qualityEligible:
        bundle.case.status === "valid" &&
        bundle.gold?.status === "evaluable" &&
        goldGroups.length > 0
    } satisfies InternalCase];
  }).sort((left, right) =>
    left.bundle.case.caseId.localeCompare(right.bundle.case.caseId)
  );

  const evaluations = Object.fromEntries(
    (["A", "B"] as const).map((system) => [
      system,
      evaluateSystem(internalCases, system)
    ])
  ) as Record<VoiceQaShadowReviewSystem, SystemEvaluation>;
  const systems = (["A", "B"] as const).map((system) =>
    aggregateSystem(evaluations[system])
  );
  const bVsA = compareSystems(
    evaluations.A,
    evaluations.B,
    VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_SEED
  );
  const blindReview = buildBlindReviewReport(internalCases);

  const validScopeCounts = scopeCounts(
    internalCases,
    (item) => item.bundle.case.status === "valid"
  );
  const goldScopeCounts = scopeCounts(
    internalCases,
    (item) => item.qualityEligible
  );
  const statusCounts = Object.fromEntries(
    (["pending", "valid", "invalid", "ambiguous"] as const).map((status) => [
      status,
      internalCases.filter((item) => item.bundle.case.status === status).length
    ])
  );
  const goldStatusCounts = Object.fromEntries(
    (["missing", "evaluable", "ambiguous", "excluded"] as const).map(
      (status) => [
        status,
        internalCases.filter(
          (item) => (item.bundle.gold?.status ?? "missing") === status
        ).length
      ]
    )
  );
  const goldCategoryCounts = Object.fromEntries(
    [...new Set(internalCases.flatMap(
      (item) => item.bundle.gold?.categories ?? []
    ))].sort().map((category) => [
      category,
      internalCases.filter(
        (item) => item.bundle.gold?.categories.includes(category)
      ).length
    ])
  );
  const validCaseCount = statusCounts.valid;
  const validInternalCases = internalCases.filter(
    (item) => item.bundle.case.status === "valid"
  );
  const frozenValues = {
    codeFingerprints: [...new Set(
      validInternalCases.map((item) => item.bundle.case.codeFingerprint)
    )].sort(),
    modelFingerprints: [...new Set(
      validInternalCases.map((item) => item.bundle.case.modelFingerprint)
    )].sort(),
    flatSnapshotIds: [...new Set(
      validInternalCases.map(
        (item) => item.bundle.case.flatSnapshotId ?? "missing"
      )
    )].sort(),
    canonicalEvidenceVersions: [...new Set(
      validInternalCases.map(
        (item) =>
          String(
            objectRecord(item.bundle.case.modelMetadata)
              ?.canonicalEvidenceVersion ?? "missing"
          )
      )
    )].sort(),
    replayInputVersions: [...new Set(
      validInternalCases.map(
        (item) => item.bundle.replayInput?.version ?? "missing"
      )
    )].sort()
  };
  const frozenCollectionReady =
    validInternalCases.length >= 60 &&
    frozenValues.codeFingerprints.length === 1 &&
    !["pending", "unresolved"].includes(
      frozenValues.codeFingerprints[0] ?? "unresolved"
    ) &&
    frozenValues.modelFingerprints.length === 1 &&
    !["pending", "unresolved"].includes(
      frozenValues.modelFingerprints[0] ?? "unresolved"
    ) &&
    frozenValues.flatSnapshotIds.length === 1 &&
    frozenValues.flatSnapshotIds[0] !== "missing" &&
    frozenValues.canonicalEvidenceVersions.length === 1 &&
    frozenValues.canonicalEvidenceVersions[0] ===
      VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION &&
    frozenValues.replayInputVersions.length === 1 &&
    frozenValues.replayInputVersions[0] ===
      "voice_qa_shadow_replay_input_v1";
  const qualityCaseCount = internalCases.filter(
    (item) => item.qualityEligible
  ).length;
  const runCompleteCount = internalCases.filter(
    (item) =>
      item.bundle.case.status === "valid" &&
      (["A", "B"] as const).every(
        (system) => primaryRun(item.bundle, system) !== null
      )
  ).length;
  const replayCompleteCount = internalCases.filter(
    (item) =>
      item.bundle.case.status === "valid" &&
      (["A", "B"] as const).every(
        (system) =>
          primaryRun(item.bundle, system) !== null &&
          replayRun(item.bundle, system) !== null
      )
  ).length;
  const questionInputCaseCount = validInternalCases.filter(
    (item) => item.bundle.questionInput !== null
  ).length;
  const strictRetrievalCases = validInternalCases.filter((item) => {
    if (!item.canonicalEvidenceIds) return false;
    const primary = (["A", "B"] as const).map((system) =>
      primaryRun(item.bundle, system)
    );
    const replay = (["A", "B"] as const).map((system) =>
      replayRun(item.bundle, system)
    );
    if (
      [...primary, ...replay].some(
        (run) =>
          !run ||
          run.status !== "completed" ||
          run.fallbackReason !== null ||
          run.candidateValidity !== true ||
          run.candidates.some(
            (candidate) => !item.canonicalEvidenceIds!.has(candidate.evidenceId)
          )
      )
    ) {
      return false;
    }
    const primaryInputHashes = new Set(primary.map((run) => run!.inputHash));
    const replayInputHashes = new Set(replay.map((run) => run!.inputHash));
    return (
      primaryInputHashes.size === 1 &&
      replayInputHashes.size === 1 &&
      primary[0]!.inputHash === replay[0]!.inputHash &&
      primary.every(
        (run, index) =>
          run!.inputHash === replay[index]!.inputHash &&
          run!.orderHash === replay[index]!.orderHash
      )
    );
  });
  const strictRetrievalScopeCounts = Object.fromEntries(
    (["current", "week", "all"] as const).map((scope) => [
      scope,
      strictRetrievalCases.filter(
        (item) => item.bundle.case.scope === scope
      ).length
    ])
  ) as Record<VoiceQaShadowReviewScope, number>;
  const citationValidCases = validInternalCases.filter((item) => {
    const citations = objectRecord(item.bundle.officialAnswer?.citations);
    return citations?.citationValidity === true;
  });
  const blindCitationValidCases = validInternalCases.filter((item) =>
    item.bundle.blindAnswers.length === 6 &&
    item.bundle.blindAnswers.every(
      (answer) => answer.citationValidity === true
    )
  );
  const officialTerminalCases = validInternalCases.filter((item) => {
    const official = item.bundle.officialAnswer;
    return (
      item.bundle.case.asrLatencyMs !== null &&
      official !== null &&
      official.streamingComplete === true &&
      official.completeLatencyMs !== null &&
      official.firstPlayableSentenceLatencyMs !== null &&
      official.firstAudioLatencyMs !== null
    );
  });
  const validBlindReviewCompleteCases = validInternalCases.filter((item) => {
    const answerKeys = new Set(
      item.bundle.blindAnswers.map(
        (answer) => `${answer.round}:${answer.label}`
      )
    );
    const reviewKeys = new Set(
      item.bundle.blindReviews.map(
        (review) => `${review.round}:${review.label}`
      )
    );
    return (
      item.bundle.blindAnswers.length === 4 &&
      item.bundle.blindReviews.length === 4 &&
      answerKeys.size === 4 &&
      reviewKeys.size === 4 &&
      [...answerKeys].every((key) => reviewKeys.has(key))
    );
  });
  const passedRequiredFaultScenarios = new Set(
    faultRuns.flatMap((run) => {
      const hashesMatch =
        run.expectedOfficialAnswerHash !== null &&
        run.expectedOfficialAnswerHash === run.actualOfficialAnswerHash &&
        run.expectedCitationHash !== null &&
        run.expectedCitationHash === run.actualCitationHash;
      const metadata = objectRecord(run.metadata);
      const redisBoundaryValid =
        run.scenario !== "redis_6380_restart" ||
        (
          metadata?.redisPort === 6380 &&
          metadata.touchedRedis6379 === false
        );
      return (
        run.status === "completed" &&
        run.voiceUninterrupted === true &&
        run.lexicalFailOpen === true &&
        run.citationsValid === true &&
        hashesMatch &&
        redisBoundaryValid
      )
        ? [run.scenario]
        : [];
    })
  );
  const missingRequiredFaultScenarios =
    VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS.filter(
      (scenario) => !passedRequiredFaultScenarios.has(scenario)
    );
  const collectionReady =
    validCaseCount >= 60 &&
    validScopeCounts.current >= 15 &&
    validScopeCounts.week >= 20 &&
    validScopeCounts.all >= 25;
  const questionInputsReady =
    validCaseCount >= 60 &&
    questionInputCaseCount === validCaseCount;
  const goldReady =
    validCaseCount >= 60 &&
    qualityCaseCount === validCaseCount &&
    goldScopeCounts.current >= 15 &&
    goldScopeCounts.week >= 20 &&
    goldScopeCounts.all >= 25;
  const retrievalReady =
    validCaseCount >= 60 &&
    strictRetrievalCases.length === validCaseCount &&
    strictRetrievalScopeCounts.current >= 15 &&
    strictRetrievalScopeCounts.week >= 20 &&
    strictRetrievalScopeCounts.all >= 25;
  const canonicalAndCitationReady =
    validCaseCount >= 60 &&
    strictRetrievalCases.length === validCaseCount &&
    citationValidCases.length === validCaseCount &&
    blindCitationValidCases.length === validCaseCount;
  const officialTerminalMetricsReady =
    validCaseCount >= 60 &&
    officialTerminalCases.length === validCaseCount;
  const requiredFaultCoverageReady =
    missingRequiredFaultScenarios.length === 0;
  const blindReviewReady =
    validCaseCount >= 60 &&
    validBlindReviewCompleteCases.length === validCaseCount;
  const notReadyReasons: string[] = [];
  if (!collectionReady) {
    notReadyReasons.push(
      `valid_holdout_below_requirement:${validCaseCount}/60` +
      `;scope=${validScopeCounts.current}/15,${validScopeCounts.week}/20,${validScopeCounts.all}/25`
    );
  }
  if (!questionInputsReady) {
    notReadyReasons.push(
      `question_inputs_below_requirement:${questionInputCaseCount}/60`
    );
  }
  if (!frozenCollectionReady) {
    notReadyReasons.push(
      "frozen_collection_inconsistent:" +
      `code=${frozenValues.codeFingerprints.length};` +
      `model=${frozenValues.modelFingerprints.length};` +
      `flat=${frozenValues.flatSnapshotIds.length};` +
      `canonical_version=${frozenValues.canonicalEvidenceVersions.length};` +
      `replay_version=${frozenValues.replayInputVersions.length}`
    );
  }
  if (!goldReady) {
    notReadyReasons.push(
      `independent_gold_below_requirement:${qualityCaseCount}/60` +
      `;scope=${goldScopeCounts.current}/15,${goldScopeCounts.week}/20,${goldScopeCounts.all}/25`
    );
  }
  if (!retrievalReady) {
    notReadyReasons.push(
      `two_system_or_replay_incomplete:primary=${runCompleteCount}/60` +
      `;replay=${replayCompleteCount}/60` +
      `;strict_identical=${strictRetrievalCases.length}/60` +
      `;scope=${strictRetrievalScopeCounts.current}/15,` +
      `${strictRetrievalScopeCounts.week}/20,` +
      `${strictRetrievalScopeCounts.all}/25`
    );
  }
  if (!canonicalAndCitationReady) {
    notReadyReasons.push(
      `canonical_or_citation_validity_incomplete:` +
      `canonical=${strictRetrievalCases.length}/60;` +
      `official_citation=${citationValidCases.length}/60;` +
      `blind_citation=${blindCitationValidCases.length}/60`
    );
  }
  if (!officialTerminalMetricsReady) {
    notReadyReasons.push(
      `official_voice_terminal_metrics_incomplete:` +
      `${officialTerminalCases.length}/60`
    );
  }
  if (!requiredFaultCoverageReady) {
    notReadyReasons.push(
      `required_fault_coverage_incomplete:` +
      `${passedRequiredFaultScenarios.size}/` +
      `${VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS.length};` +
      `missing=${missingRequiredFaultScenarios.join(",")}`
    );
  }
  if (!blindReviewReady) {
    notReadyReasons.push(
      `two_round_blind_review_incomplete:${blindReview.twoRoundCompleteCaseCount}/60`
    );
  }
  const humanDecisionReady =
    collectionReady &&
    frozenCollectionReady &&
    questionInputsReady &&
    goldReady &&
    retrievalReady &&
    canonicalAndCitationReady &&
    officialTerminalMetricsReady &&
    requiredFaultCoverageReady &&
    blindReviewReady;
  const reviewStatus = humanDecisionReady
    ? "READY_FOR_HUMAN_DECISION"
    : "NOT_READY";
  const questionInputRecords = internalCases.flatMap((item) => {
    const questionInput = item.bundle.questionInput;
    return questionInput
      ? [{
          caseId: item.bundle.case.caseId,
          expectedTextHash: questionInput.expectedTextHash,
          audioSha256: questionInput.audioSha256,
          sourceKind: questionInput.sourceKind,
          exactAsrTextHashMatch:
            questionInput.expectedTextHash === item.bundle.case.asrTextHash
        }]
      : [];
  });
  const questionSourceCounts = Object.fromEntries(
    (["real_microphone", "synthetic_voice", "recorded_holdout"] as const).map(
      (sourceKind) => [
        sourceKind,
        questionInputRecords.filter(
          (record) => record.sourceKind === sourceKind
        ).length
      ]
    )
  );

  const manifest = {
    version: VOICE_QA_SHADOW_REVIEW_EXPORT_VERSION,
    generatedAt,
    reviewStatus,
    automaticPromotionAllowed: false,
    sourceMode: "read_only_user_scoped_sqlite",
    knownMeasurementRisks: [
      "Flat snapshot synchronization must be verified from the frozen fingerprints for every valid case.",
      "Shadow collection is asynchronous and has no durable task queue; process termination can leave a case incomplete."
    ],
    datasetFingerprint: sha256(JSON.stringify(
      internalCases.map((item) => ({
        caseId: item.bundle.case.caseId,
        scope: item.bundle.case.scope,
        status: item.bundle.case.status,
        goldStatus: item.bundle.gold?.status ?? "missing",
        canonicalContentHash:
          item.bundle.canonicalSnapshot?.contentHash ?? null,
        expectedTextHash:
          item.bundle.questionInput?.expectedTextHash ?? null,
        questionAudioSha256:
          item.bundle.questionInput?.audioSha256 ?? null,
        questionSourceKind:
          item.bundle.questionInput?.sourceKind ?? null
      }))
    )),
    privacy: {
      containsQuestionText: false,
      containsEvidenceText: false,
      containsAnswerText: false,
      containsUserId: false
    },
    counts: {
      totalCases: internalCases.length,
      collectionStatus: statusCounts,
      validByScope: validScopeCounts,
      goldStatus: goldStatusCounts,
      goldCategories: goldCategoryCounts,
      qualityEligibleByScope: goldScopeCounts,
      twoSystemPrimaryComplete: runCompleteCount,
      twoSystemReplayComplete: replayCompleteCount,
      twoSystemStrictIdentical: strictRetrievalCases.length,
      strictIdenticalByScope: strictRetrievalScopeCounts,
      officialCitationValid: citationValidCases.length,
      blindAnswerCitationValid: blindCitationValidCases.length,
      officialVoiceTerminalMetricsComplete: officialTerminalCases.length,
      requiredFaultScenariosPassed: passedRequiredFaultScenarios.size,
      twoRoundBlindReviewComplete:
        validBlindReviewCompleteCases.length
    },
    questionInputs: {
      count: questionInputRecords.length,
      missingCount: internalCases.length - questionInputRecords.length,
      validCaseCount: questionInputCaseCount,
      bySourceKind: questionSourceCounts,
      exactAsrTextHashMatchCount: questionInputRecords.filter(
        (record) => record.exactAsrTextHashMatch
      ).length,
      records: questionInputRecords
    },
    readiness: {
      collectionReady,
      frozenCollectionReady,
      frozenValues,
      questionInputsReady,
      goldReady,
      retrievalAndReplayReady: retrievalReady,
      canonicalAndCitationReady,
      officialTerminalMetricsReady,
      requiredFaultCoverageReady,
      requiredFaultScenarios: [
        ...VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS
      ],
      missingRequiredFaultScenarios,
      blindReviewReady,
      humanDecisionReady,
      reasons: notReadyReasons
    },
    outputFiles: [...VOICE_QA_SHADOW_REVIEW_EXPORT_FILES]
  };

  const retrievalComparison = {
    version: VOICE_QA_SHADOW_REVIEW_EXPORT_VERSION,
    generatedAt,
    reviewStatus,
    automaticPromotionAllowed: false,
    metricDefinitions: {
      recallAt5At10At16:
        "gold-group recall over actual selected Top-16 ranks",
      recallAt30: "gold-group recall over the stored Top-30 candidate pool",
      completeMiss: "no gold group found in the stored Top-30 candidate pool",
      mrr: "mean reciprocal rank of the first gold evidence in selected Top-16",
      ndcgAt10: "binary gold-group relevance over selected Top-10",
      canonicalValidity:
        "candidate IDs must belong to the case canonical snapshot and the run must declare validity",
      bootstrap:
        `paired case bootstrap with fixed seed and ${VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_ITERATIONS} iterations`
    },
    systems,
    comparisons: {
      bVsA
    }
  };

  const validCases = internalCases.filter(
    (item) => item.bundle.case.status === "valid"
  );
  const officialAnswers = validCases.flatMap((item) =>
    item.bundle.officialAnswer ? [item.bundle.officialAnswer] : []
  );
  const qaAttempts = validCases.flatMap((item) => item.bundle.qaAttempts);
  const qaAttemptSummary = (
    attempts: typeof qaAttempts
  ) => ({
    count: attempts.length,
    status: {
      completed: attempts.filter((attempt) => attempt.status === "completed")
        .length,
      failed: attempts.filter((attempt) => attempt.status === "failed").length,
      aborted: attempts.filter((attempt) => attempt.status === "aborted").length
    },
    fallbackCount: attempts.filter(
      (attempt) => attempt.fallbackReason !== null
    ).length,
    latency: latencySummary(attempts.flatMap((attempt) =>
      attempt.latencyMs === null ? [] : [attempt.latencyMs]
    ))
  });
  const shadowCompletionValues = validCases.flatMap((item) => {
    const values = (["B"] as const).flatMap((system) => {
      const run = primaryRun(item.bundle, system);
      return run ? [run.totalLatencyMs] : [];
    });
    return values.length === 0 ? [] : [Math.max(...values)];
  });
  const faultScenarios = new Map<string, number>();
  for (const faultRun of faultRuns) {
    const safeScenario = /^[a-z][a-z0-9_:-]{0,127}$/.test(faultRun.scenario)
      ? faultRun.scenario
      : "other";
    faultScenarios.set(
      safeScenario,
      (faultScenarios.get(safeScenario) ?? 0) + 1
    );
  }
  const assessedBoolean = (
    read: (faultRun: (typeof faultRuns)[number]) => boolean | null
  ) => {
    const values = faultRuns.flatMap((faultRun) => {
      const value = read(faultRun);
      return value === null ? [] : [value];
    });
    const passed = values.filter(Boolean).length;
    return {
      assessedCount: values.length,
      passedCount: passed,
      ratio: ratio(passed, values.length)
    };
  };
  const latencyAndFallback = {
    version: VOICE_QA_SHADOW_REVIEW_EXPORT_VERSION,
    generatedAt,
    reviewStatus,
    asr: latencySummary(validCases.flatMap((item) =>
      item.bundle.case.asrLatencyMs === null
        ? []
        : [item.bundle.case.asrLatencyMs]
    )),
    retrieval: Object.fromEntries(
      systems.map((system) => [
        system.system,
        {
          latency: system.latency,
          fallback: system.fallback
        }
      ])
    ),
    voice: {
      officialAnswerCount: officialAnswers.length,
      officialCitationValidity: {
        assessedCount: validInternalCases.filter(
          (item) => item.bundle.officialAnswer !== null
        ).length,
        passedCount: citationValidCases.length,
        ratio: ratio(
          citationValidCases.length,
          validInternalCases.filter(
            (item) => item.bundle.officialAnswer !== null
          ).length
        )
      },
      terminalMetricsCompleteCount: officialTerminalCases.length,
      qaAttempts: {
        primary: qaAttemptSummary(qaAttempts.filter(
          (attempt) =>
            attempt.kind === "stream_primary" ||
            attempt.kind === "sync_primary"
        )),
        automaticRetry: qaAttemptSummary(qaAttempts.filter(
          (attempt) => attempt.kind === "sync_fallback"
        )),
        finalProjection: qaAttemptSummary(qaAttempts.filter(
          (attempt) => attempt.kind === "final_projection"
        )),
        byKind: Object.fromEntries(
          ([
            "stream_primary",
            "sync_primary",
            "sync_fallback",
            "final_projection"
          ] as const).map(
            (kind) => [
              kind,
              qaAttemptSummary(qaAttempts.filter(
                (attempt) => attempt.kind === kind
              ))
            ]
          )
        )
      },
      llmFirstToken: latencySummary(officialAnswers.flatMap((answer) =>
        answer.llmFirstTokenLatencyMs === null
          ? []
          : [answer.llmFirstTokenLatencyMs]
      )),
      firstPlayableSentence: latencySummary(
        officialAnswers.flatMap((answer) =>
          answer.firstPlayableSentenceLatencyMs === null
            ? []
            : [answer.firstPlayableSentenceLatencyMs]
        )
      ),
      firstAudio: latencySummary(officialAnswers.flatMap((answer) =>
        answer.firstAudioLatencyMs === null
          ? []
          : [answer.firstAudioLatencyMs]
      )),
      complete: latencySummary(officialAnswers.flatMap((answer) =>
        answer.completeLatencyMs === null ? [] : [answer.completeLatencyMs]
      )),
      streamingCompleteCount: officialAnswers.filter(
        (answer) => answer.streamingComplete === true
      ).length,
      ttsFailureCount: officialAnswers.filter(
        (answer) => answer.ttsFailure !== null
      ).length
    },
    shadowBackgroundComplete: latencySummary(shadowCompletionValues),
    faultRuns: {
      totalCount: faultRuns.length,
      requiredScenarios: [
        ...VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS
      ],
      passedRequiredScenarios: [...passedRequiredFaultScenarios].sort(),
      missingRequiredScenarios: missingRequiredFaultScenarios,
      status: {
        completed: faultRuns.filter((run) => run.status === "completed").length,
        failed: faultRuns.filter((run) => run.status === "failed").length,
        aborted: faultRuns.filter((run) => run.status === "aborted").length
      },
      scenarios: Object.fromEntries(
        [...faultScenarios.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      shadowErrorCount: faultRuns.filter(
        (run) => run.shadowError !== null
      ).length,
      voiceUninterrupted: assessedBoolean(
        (run) => run.voiceUninterrupted
      ),
      lexicalFailOpen: assessedBoolean((run) => run.lexicalFailOpen),
      citationsValid: assessedBoolean((run) => run.citationsValid),
      shadowLatency: latencySummary(faultRuns.flatMap((run) =>
        run.shadowLatencyMs === null ? [] : [run.shadowLatencyMs]
      ))
    },
    privacy: {
      fallbackReasonBodiesExported: false,
      qaAttemptAnswerBodiesExported: false,
      qaAttemptCitationBodiesExported: false,
      ttsFailureBodiesExported: false,
      faultErrorBodiesExported: false
    }
  };

  const perCaseMovements = {
    version: VOICE_QA_SHADOW_REVIEW_EXPORT_VERSION,
    generatedAt,
    reviewStatus,
    privacy: {
      containsQuestionText: false,
      containsEvidenceText: false,
      containsAnswerText: false,
      containsUserId: false,
      evidenceIdsExported: false
    },
    cases: internalCases.map((item) => caseMovement(item, evaluations))
  };

  const metric = (value: number | null) =>
    value === null ? "N/A" : value.toFixed(4);
  const systemByCode = new Map(systems.map((system) => [system.system, system]));
  const decisionReport = [
    "# Voice QA Shadow Review v1",
    "",
    `Review status: ${reviewStatus}`,
    "",
    "**Automatic promotion: DISABLED**",
    "",
    "This export never changes retrieval configuration or emits an automatic promotion decision. " +
      "When all data gates are complete it only becomes READY_FOR_HUMAN_DECISION.",
    "",
    "## Dataset readiness",
    "",
    `- Valid holdout: ${validCaseCount}/60`,
    `- Scope current/week/all: ${validScopeCounts.current}/15, ` +
      `${validScopeCounts.week}/20, ${validScopeCounts.all}/25`,
    `- Attached private question inputs: ${questionInputCaseCount}/60`,
    `- Independent Gold eligible: ${qualityCaseCount}/60`,
    `- Two-system primary retrieval: ${runCompleteCount}/60`,
    `- Two identical replays: ${replayCompleteCount}/60`,
    `- Strict A/B replay consistency: ${strictRetrievalCases.length}/60`,
    `- Official citation validity: ${citationValidCases.length}/60`,
    `- Blind-answer citation validity: ${blindCitationValidCases.length}/60`,
    `- Official Voice terminal metrics: ${officialTerminalCases.length}/60`,
    `- Required fault scenarios: ${passedRequiredFaultScenarios.size}/` +
      `${VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS.length}`,
    `- Two-round blind review: ${blindReview.twoRoundCompleteCaseCount}/60`,
    "",
    "## Retrieval summary",
    "",
    "| System | Recall@16 | MRR | nDCG@10 | Complete misses | P95 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...(["A", "B"] as const).map((system) => {
      const value = systemByCode.get(system)!;
      return `| ${system} | ${metric(value.quality.recallAt16)} | ` +
        `${metric(value.quality.mrr)} | ${metric(value.quality.ndcgAt10)} | ` +
        `${value.quality.completeMissCount} | ${metric(value.latency.total.p95Ms)} |`;
    }),
    "",
    "## Paired movements",
    "",
    `- B vs A Recall@16 difference: ${metric(bVsA.recallAt16Difference)} ` +
      `(95% CI ${metric(bVsA.pairedBootstrap95.ci95.lower)} to ` +
      `${metric(bVsA.pairedBootstrap95.ci95.upper)}), gains/losses ` +
      `${bVsA.top16GoldGains}/${bVsA.top16GoldLosses}.`,
    "",
    "## Blocking reasons",
    "",
    ...(notReadyReasons.length > 0
      ? notReadyReasons.map((reason) => `- ${reason}`)
      : [
          "- None at export completeness level. Promotion still requires the user's human gate review."
        ]),
    "",
    "## Decision boundary",
    "",
    reviewStatus === "NOT_READY"
      ? "No promotion conclusion is valid from the currently stored data."
      : "The dataset is complete enough for the user's fixed human promotion criteria; no automatic promotion was performed.",
    ""
  ].join("\n");

  return {
    "dataset-manifest.json": manifest,
    "retrieval-comparison.json": retrievalComparison,
    "answer-blind-review.json": {
      ...blindReview,
      generatedAt,
      reviewStatus
    },
    "latency-and-fallback.json": latencyAndFallback,
    "per-case-movements.json": perCaseMovements,
    "decision-report.md": decisionReport
  };
}

export async function exportVoiceQaShadowReviewReports(
  source: ReviewReadSource,
  input: {
    outputDirectory?: string;
    dataRoot?: string;
    generatedAt?: string;
  } = {}
) {
  const outputDirectory = resolve(
    input.outputDirectory ??
      getVoiceQaShadowReviewExportDirectory(input.dataRoot)
  );
  const reports = buildVoiceQaShadowReviewReports(source, {
    generatedAt: input.generatedAt
  });
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    VOICE_QA_SHADOW_REVIEW_EXPORT_FILES.map(async (fileName) => {
      const value = reports[fileName];
      const content = fileName === "decision-report.md"
        ? value as string
        : `${JSON.stringify(value, null, 2)}\n`;
      await writeFile(join(outputDirectory, fileName), content, "utf8");
    })
  );
  return {
    outputDirectory,
    files: Object.fromEntries(
      VOICE_QA_SHADOW_REVIEW_EXPORT_FILES.map((fileName) => [
        fileName,
        join(outputDirectory, fileName)
      ])
    ) as Record<(typeof VOICE_QA_SHADOW_REVIEW_EXPORT_FILES)[number], string>,
    reviewStatus: reports["dataset-manifest.json"].reviewStatus
  };
}

export type VoiceQaShadowReviewReports = ReturnType<
  typeof buildVoiceQaShadowReviewReports
>;

export type VoiceQaShadowReviewJsonReport =
  VoiceQaShadowReviewReports[JsonExportFileName];
