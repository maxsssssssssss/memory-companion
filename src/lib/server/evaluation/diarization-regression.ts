import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(256);

const ExpectedSegmentSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  speaker: IdSchema,
  identity: IdSchema.optional()
}).strict().refine((segment) => segment.endSeconds > segment.startSeconds, {
  message: "expected segment end must be after start"
});

const ObservedSegmentSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  speaker: IdSchema,
  resolvedIdentity: IdSchema.optional(),
  providerVerified: z.boolean().default(false)
}).strict().refine((segment) => segment.endSeconds > segment.startSeconds, {
  message: "observed segment end must be after start"
});

export const DiarizationRegressionCaseSchema = z.object({
  case: z.enum([
    "single_speaker",
    "two_speakers",
    "multi_speaker",
    "noise",
    "overlap_speech"
  ]),
  expectedSpeakerCount: z.number().int().positive(),
  boundaryToleranceSeconds: z.number().positive().max(5).default(0.25),
  maximumFragmentationRate: z.number().min(0).max(1).default(0.25),
  minimumBoundaryRecall: z.number().min(0).max(1).default(0.8),
  minimumIdentityMatchRate: z.number().min(0).max(1).default(0.9),
  expected: z.array(ExpectedSegmentSchema).min(1),
  observed: z.array(ObservedSegmentSchema)
}).strict();

export const DiarizationRegressionSuiteSchema = z.object({
  version: z.literal(1),
  provider: z.string().trim().min(1),
  cases: z.array(DiarizationRegressionCaseSchema).length(5)
}).strict().superRefine((suite, context) => {
  const names = new Set(suite.cases.map((item) => item.case));
  if (names.size !== 5) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cases"],
      message: "regression suite must contain each fixed case exactly once"
    });
  }
});

export type DiarizationRegressionCase = z.infer<
  typeof DiarizationRegressionCaseSchema
>;
export type DiarizationRegressionCaseInput = z.input<
  typeof DiarizationRegressionCaseSchema
>;
export type DiarizationRegressionSuite = z.infer<
  typeof DiarizationRegressionSuiteSchema
>;
export type DiarizationRegressionSuiteInput = z.input<
  typeof DiarizationRegressionSuiteSchema
>;

type BoundaryMetrics = {
  expected: number;
  observed: number;
  matched: number;
  recall: number;
  meanAbsoluteErrorSeconds: number | null;
};

function rounded(value: number) {
  return Number(value.toFixed(4));
}

function uniqueBoundaries(
  segments: Array<{ startSeconds: number; endSeconds: number }>
) {
  if (segments.length === 0) return [];
  const minimum = Math.min(...segments.map((segment) => segment.startSeconds));
  const maximum = Math.max(...segments.map((segment) => segment.endSeconds));
  return [...new Set(
    segments.flatMap((segment) => [segment.startSeconds, segment.endSeconds])
  )]
    .filter((boundary) => boundary > minimum && boundary < maximum)
    .sort((left, right) => left - right);
}

function boundaryMetrics(
  expectedSegments: DiarizationRegressionCase["expected"],
  observedSegments: DiarizationRegressionCase["observed"],
  toleranceSeconds: number
): BoundaryMetrics {
  const expected = uniqueBoundaries(expectedSegments);
  const observed = uniqueBoundaries(observedSegments);
  if (expected.length === 0) {
    return {
      expected: 0,
      observed: observed.length,
      matched: 0,
      recall: 1,
      meanAbsoluteErrorSeconds: null
    };
  }
  const matchedErrors: number[] = [];
  let expectedIndex = 0;
  let observedIndex = 0;
  while (expectedIndex < expected.length && observedIndex < observed.length) {
    const expectedBoundary = expected[expectedIndex];
    const observedBoundary = observed[observedIndex];
    const error = observedBoundary - expectedBoundary;
    if (Math.abs(error) <= toleranceSeconds) {
      matchedErrors.push(Math.abs(error));
      expectedIndex += 1;
      observedIndex += 1;
    } else if (observedBoundary < expectedBoundary) {
      observedIndex += 1;
    } else {
      expectedIndex += 1;
    }
  }
  return {
    expected: expected.length,
    observed: observed.length,
    matched: matchedErrors.length,
    recall: rounded(matchedErrors.length / expected.length),
    meanAbsoluteErrorSeconds:
      matchedErrors.length === 0
        ? null
        : rounded(
            matchedErrors.reduce((total, error) => total + error, 0) /
              matchedErrors.length
          )
  };
}

function temporalOverlap(
  left: { startSeconds: number; endSeconds: number },
  right: { startSeconds: number; endSeconds: number }
) {
  return Math.max(
    0,
    Math.min(left.endSeconds, right.endSeconds) -
      Math.max(left.startSeconds, right.startSeconds)
  );
}

function identityMatchRate(
  expected: DiarizationRegressionCase["expected"],
  observed: DiarizationRegressionCase["observed"]
) {
  const identitySegments = expected.filter((segment) => segment.identity);
  if (identitySegments.length === 0) {
    return { eligible: 0, matched: 0, rate: null as number | null };
  }
  const candidates = identitySegments.map((expectedSegment) => observed
    .map((segment, observedIndex) => ({
      observedIndex,
      speaker: segment.speaker,
      overlap: temporalOverlap(expectedSegment, segment),
      matches:
        segment.providerVerified === true &&
        segment.resolvedIdentity === expectedSegment.identity
    }))
    .filter((candidate) => candidate.matches && candidate.overlap > 0)
    .sort(
      (left, right) =>
        right.overlap - left.overlap ||
        left.speaker.localeCompare(right.speaker, "en") ||
        left.observedIndex - right.observedIndex
    ));
  const expectedByObserved = new Map<number, number>();
  const assign = (expectedIndex: number, visitedObserved: Set<number>): boolean => {
    for (const candidate of candidates[expectedIndex]) {
      if (visitedObserved.has(candidate.observedIndex)) continue;
      visitedObserved.add(candidate.observedIndex);
      const currentExpected = expectedByObserved.get(candidate.observedIndex);
      if (
        currentExpected === undefined ||
        assign(currentExpected, visitedObserved)
      ) {
        expectedByObserved.set(candidate.observedIndex, expectedIndex);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (const expectedIndex of identitySegments.keys()) {
    if (assign(expectedIndex, new Set())) matched += 1;
  }
  return {
    eligible: identitySegments.length,
    matched,
    rate: rounded(matched / identitySegments.length)
  };
}

export function evaluateDiarizationRegressionCase(
  input: DiarizationRegressionCaseInput
) {
  const parsed = DiarizationRegressionCaseSchema.parse(input);
  const speakerCount = new Set(
    parsed.observed.map((segment) => segment.speaker)
  ).size;
  const boundaries = boundaryMetrics(
    parsed.expected,
    parsed.observed,
    parsed.boundaryToleranceSeconds
  );
  const extraFragments = Math.max(
    0,
    parsed.observed.length - parsed.expected.length
  );
  const fragmentationRate = rounded(
    extraFragments / Math.max(1, parsed.expected.length)
  );
  const identity = identityMatchRate(parsed.expected, parsed.observed);
  const speakerCountPassed = speakerCount === parsed.expectedSpeakerCount;
  const boundariesPassed =
    boundaries.recall >= parsed.minimumBoundaryRecall;
  const fragmentationPassed =
    fragmentationRate <= parsed.maximumFragmentationRate;
  const identityPassed =
    identity.rate === null ||
    identity.rate >= parsed.minimumIdentityMatchRate;
  return {
    case: parsed.case,
    speakerCount: {
      expected: parsed.expectedSpeakerCount,
      actual: speakerCount,
      passed: speakerCountPassed
    },
    segmentBoundary: {
      toleranceSeconds: parsed.boundaryToleranceSeconds,
      ...boundaries,
      passed: boundariesPassed
    },
    fragmentation: {
      expectedSegments: parsed.expected.length,
      observedSegments: parsed.observed.length,
      extraFragments,
      rate: fragmentationRate,
      passed: fragmentationPassed
    },
    identityMatchRate: {
      eligibleSegments: identity.eligible,
      matchedSegments: identity.matched,
      rate: identity.rate,
      providerVerificationRequired: true,
      passed: identityPassed
    },
    result:
      speakerCountPassed &&
      boundariesPassed &&
      fragmentationPassed &&
      identityPassed
        ? "PASS" as const
        : "FAIL" as const
  };
}

export function buildDiarizationBenchmarkReport(
  input: DiarizationRegressionSuiteInput,
  now: () => string = () => new Date().toISOString()
) {
  const parsed = DiarizationRegressionSuiteSchema.parse(input);
  const cases = parsed.cases.map(evaluateDiarizationRegressionCase);
  return {
    version: 1,
    generatedAt: now(),
    provider: parsed.provider,
    safety: {
      speakerIndexIdentityInference: false,
      genderIdentityInference: false,
      llmIdentityInference: false,
      providerVerificationRequiredForIdentityMetric: true
    },
    cases,
    summary: {
      total: cases.length,
      passed: cases.filter((item) => item.result === "PASS").length,
      failed: cases.filter((item) => item.result === "FAIL").length
    }
  };
}
