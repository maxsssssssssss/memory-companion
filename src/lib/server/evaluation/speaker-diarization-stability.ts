export const SPEAKER_DIARIZATION_BENCHMARK_DURATIONS = [
  30,
  45,
  60,
  70,
  90
] as const;

export const SPEAKER_DIARIZATION_BENCHMARK_PARAMETERS = [2, 0] as const;

export type SpeakerDiarizationBenchmarkDuration =
  (typeof SPEAKER_DIARIZATION_BENCHMARK_DURATIONS)[number];

export type SpeakerDiarizationParameter =
  (typeof SPEAKER_DIARIZATION_BENCHMARK_PARAMETERS)[number];

export type SpeakerDiarizationFailureCategory =
  | "empty_speaker_result"
  | "unexpected_speaker_count"
  | "asr_result_missing"
  | "provider_code_failure"
  | "timeout"
  | "network_error"
  | "http_error"
  | "invalid_response"
  | "standalone_failure"
  | "unknown_failure";

export type SpeakerDiarizationBenchmarkCase = {
  caseId: string;
  executionIndex: number;
  durationSeconds: SpeakerDiarizationBenchmarkDuration;
  speakerParameter: SpeakerDiarizationParameter;
  repetition: number;
};

export type SpeakerDiarizationStageResult = {
  attempted: boolean;
  success: boolean;
  queryCount: number;
  totalLatencyMs: number;
  providerCodes: Array<number | "missing">;
  terminalReason: string;
  speakerResultExists: boolean;
  speakerCount: number;
  labels: string[];
  failureCategory?: SpeakerDiarizationFailureCategory;
};

export type SpeakerDiarizationTrialResult = {
  caseId: string;
  executionIndex: number;
  durationSeconds: SpeakerDiarizationBenchmarkDuration;
  speakerParameter: SpeakerDiarizationParameter;
  repetition: number;
  audioFormat: "pcm_s16le/16000Hz/mono";
  asrSuccess: boolean;
  combined: SpeakerDiarizationStageResult;
  standalone: SpeakerDiarizationStageResult;
  finalSuccess: boolean;
  finalSource: "combined_asr" | "standalone_diarization" | "none";
  totalLatencyMs: number;
  failureCategory?: SpeakerDiarizationFailureCategory;
};

export type SpeakerDiarizationAggregate = {
  trials: number;
  asrSuccesses: number;
  speakerResultAvailable: number;
  combinedSuccesses: number;
  standaloneRecoveries: number;
  finalSuccesses: number;
  successRate: number;
  meanLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  failureCounts: Partial<Record<SpeakerDiarizationFailureCategory, number>>;
};

export type SpeakerDiarizationBenchmarkSummary = {
  totalTrials: number;
  completedTrials: number;
  overall: SpeakerDiarizationAggregate;
  byDuration: Record<string, SpeakerDiarizationAggregate>;
  bySpeakerParameter: Record<string, SpeakerDiarizationAggregate>;
  byDurationAndParameter: Record<string, SpeakerDiarizationAggregate>;
  candidateMinimumStableDurationSeconds: number | null;
};

export function buildSpeakerDiarizationBenchmarkMatrix(
  repetitions = 3
): SpeakerDiarizationBenchmarkCase[] {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("repetitions must be an integer between 1 and 10");
  }

  const cases: SpeakerDiarizationBenchmarkCase[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (
      let durationIndex = 0;
      durationIndex < SPEAKER_DIARIZATION_BENCHMARK_DURATIONS.length;
      durationIndex += 1
    ) {
      const durationSeconds =
        SPEAKER_DIARIZATION_BENCHMARK_DURATIONS[durationIndex];
      const parameterOrder =
        (repetition + durationIndex) % 2 === 0
          ? SPEAKER_DIARIZATION_BENCHMARK_PARAMETERS
          : [...SPEAKER_DIARIZATION_BENCHMARK_PARAMETERS].reverse();

      for (const speakerParameter of parameterOrder) {
        const executionIndex = cases.length + 1;
        cases.push({
          caseId: [
            `d${durationSeconds}`,
            `s${speakerParameter}`,
            `r${repetition}`
          ].join("-"),
          executionIndex,
          durationSeconds,
          speakerParameter,
          repetition
        });
      }
    }
  }
  return cases;
}

export function classifySpeakerDiarizationFailure(
  reason: string | undefined
): SpeakerDiarizationFailureCategory {
  const normalized = reason?.toLowerCase() ?? "";
  if (
    normalized.includes("empty_speaker") ||
    normalized.includes("missing_speaker")
  ) {
    return "empty_speaker_result";
  }
  if (
    normalized.includes("speaker_count") ||
    normalized.includes("unexpected_speaker")
  ) {
    return "unexpected_speaker_count";
  }
  if (
    normalized.includes("asr_result_missing") ||
    normalized.includes("asr_sentences_missing")
  ) {
    return "asr_result_missing";
  }
  if (normalized.includes("provider_code")) return "provider_code_failure";
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("network") || normalized.includes("fetch")) {
    return "network_error";
  }
  if (normalized.includes("http_")) return "http_error";
  if (
    normalized.includes("invalid_json") ||
    normalized.includes("invalid_response") ||
    normalized.includes("response_too_large")
  ) {
    return "invalid_response";
  }
  if (normalized.includes("standalone")) return "standalone_failure";
  return "unknown_failure";
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  );
  return sorted[index];
}

function aggregate(
  results: SpeakerDiarizationTrialResult[]
): SpeakerDiarizationAggregate {
  const latencies = results
    .map((result) => result.totalLatencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const failureCounts: SpeakerDiarizationAggregate["failureCounts"] = {};
  for (const result of results) {
    if (!result.failureCategory) continue;
    failureCounts[result.failureCategory] =
      (failureCounts[result.failureCategory] ?? 0) + 1;
  }
  const finalSuccesses = results.filter((result) => result.finalSuccess).length;
  return {
    trials: results.length,
    asrSuccesses: results.filter((result) => result.asrSuccess).length,
    speakerResultAvailable: results.filter(
      (result) => result.combined.speakerResultExists
    ).length,
    combinedSuccesses: results.filter((result) => result.combined.success)
      .length,
    standaloneRecoveries: results.filter(
      (result) =>
        !result.combined.success &&
        result.standalone.attempted &&
        result.standalone.success
    ).length,
    finalSuccesses,
    successRate:
      results.length === 0 ? 0 : Number((finalSuccesses / results.length).toFixed(4)),
    meanLatencyMs:
      latencies.length === 0
        ? null
        : Math.round(
            latencies.reduce((sum, value) => sum + value, 0) / latencies.length
          ),
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    failureCounts
  };
}

function groupedSummary(
  results: SpeakerDiarizationTrialResult[],
  keyFor: (result: SpeakerDiarizationTrialResult) => string
) {
  const groups = new Map<string, SpeakerDiarizationTrialResult[]>();
  for (const result of results) {
    const key = keyFor(result);
    const values = groups.get(key) ?? [];
    values.push(result);
    groups.set(key, values);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, values]) => [key, aggregate(values)])
  );
}

export function summarizeSpeakerDiarizationBenchmark(
  results: SpeakerDiarizationTrialResult[],
  totalTrials = buildSpeakerDiarizationBenchmarkMatrix().length
): SpeakerDiarizationBenchmarkSummary {
  const byDurationAndParameter = groupedSummary(
    results,
    (result) =>
      `${result.durationSeconds}s/speaker=${result.speakerParameter}`
  );
  const candidateMinimumStableDurationSeconds =
    SPEAKER_DIARIZATION_BENCHMARK_DURATIONS.find((durationSeconds) => {
      const durationIndex =
        SPEAKER_DIARIZATION_BENCHMARK_DURATIONS.indexOf(durationSeconds);
      return SPEAKER_DIARIZATION_BENCHMARK_DURATIONS
        .slice(durationIndex)
        .every((candidateDuration) => {
          const group =
            byDurationAndParameter[`${candidateDuration}s/speaker=2`];
          return group?.trials === 3 && group.combinedSuccesses === 3;
        });
    }) ?? null;

  return {
    totalTrials,
    completedTrials: results.length,
    overall: aggregate(results),
    byDuration: groupedSummary(
      results,
      (result) => `${result.durationSeconds}s`
    ),
    bySpeakerParameter: groupedSummary(
      results,
      (result) => `speaker=${result.speakerParameter}`
    ),
    byDurationAndParameter,
    candidateMinimumStableDurationSeconds
  };
}
