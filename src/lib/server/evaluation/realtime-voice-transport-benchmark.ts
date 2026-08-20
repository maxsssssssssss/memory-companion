import type {
  RealtimeVoiceLatencyMarker,
  RealtimeVoiceLatencyMetrics,
  RealtimeVoiceLatencySnapshot
} from "@/lib/voice-realtime-latency";

export type RealtimeVoiceBenchmarkStatus =
  | "completed"
  | "failed"
  | "interrupted";

export type RealtimeVoiceTransportBenchmarkCase = {
  id: string;
  expectedStatus: RealtimeVoiceBenchmarkStatus;
  status: RealtimeVoiceBenchmarkStatus;
  requiredMarkers: readonly RealtimeVoiceLatencyMarker[];
  trace: RealtimeVoiceLatencySnapshot;
  terminalEventCount: number;
  audioSequences: number[];
  resourceLeakCount: number;
  reconnectCount?: number;
  truncate?: {
    expectedItemId: string;
    actualItemId?: string;
    expectedAudioEndMs: number;
    actualAudioEndMs?: number;
  };
};

const REQUIRED_MARKERS_BY_STATUS = {
  completed: [
    "speech_start",
    "speech_end",
    "asr_final",
    "retrieval_start",
    "retrieval_complete",
    "qa_start",
    "qa_complete",
    "answer_ready",
    "tts_start",
    "first_audio",
    "browser_playback_start",
    "complete"
  ],
  interrupted: ["speech_start", "complete"],
  failed: ["speech_start", "complete"]
} as const satisfies Record<
  RealtimeVoiceBenchmarkStatus,
  readonly RealtimeVoiceLatencyMarker[]
>;

export type RealtimeVoiceMetricSummary = {
  count: number;
  p50: number | null;
  p95: number | null;
};

const BENCHMARK_METRICS = [
  "speech_start_to_first_partial_ms",
  "speech_start_to_first_feedback_ms",
  "speech_end_to_asr_final_ms",
  "speech_end_to_first_audio_ms",
  "speech_end_to_browser_playback_ms",
  "retrieval_ms",
  "qa_ms",
  "llm_ttft_ms",
  "tts_to_first_audio_ms",
  "first_audio_to_browser_playback_ms",
  "total_turn_ms"
] as const satisfies readonly (keyof RealtimeVoiceLatencyMetrics)[];

function percentile(values: readonly number[], percentage: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentage) - 1)
  );
  return sorted[index] ?? null;
}

function contiguousSequences(sequences: readonly number[]) {
  if (sequences.length === 0) return true;
  const start = sequences[0];
  if (start === undefined || !Number.isSafeInteger(start) || start < 0) {
    return false;
  }
  return sequences.every((sequence, index) => sequence === start + index);
}

function truncateMatches(
  truncate: RealtimeVoiceTransportBenchmarkCase["truncate"]
) {
  if (!truncate) return true;
  return truncate.actualItemId === truncate.expectedItemId &&
    truncate.actualAudioEndMs === truncate.expectedAudioEndMs;
}

function hasRequiredMarkers(item: RealtimeVoiceTransportBenchmarkCase) {
  const required = new Set<RealtimeVoiceLatencyMarker>([
    ...REQUIRED_MARKERS_BY_STATUS[item.expectedStatus],
    ...item.requiredMarkers
  ]);
  for (const marker of required) {
    if (item.trace.timestamps[marker] === undefined) return false;
  }

  const ordered = REALTIME_MARKER_ORDER.filter((marker) => required.has(marker));
  return ordered.every((marker, index) => {
    if (index === 0) return true;
    const previous = ordered[index - 1]!;
    return item.trace.timestamps[previous]! <= item.trace.timestamps[marker]!;
  });
}

const REALTIME_MARKER_ORDER = [
  "speech_start",
  "first_partial_asr",
  "speech_end",
  "asr_final",
  "retrieval_start",
  "retrieval_complete",
  "qa_start",
  "llm_first_token",
  "qa_complete",
  "answer_ready",
  "tts_start",
  "first_audio",
  "browser_playback_start",
  "complete"
] as const satisfies readonly RealtimeVoiceLatencyMarker[];

export function realtimeVoiceBenchmarkCasePassed(
  item: RealtimeVoiceTransportBenchmarkCase
) {
  return item.status === item.expectedStatus &&
    hasRequiredMarkers(item) &&
    item.terminalEventCount === 1 &&
    item.resourceLeakCount === 0 &&
    contiguousSequences(item.audioSequences) &&
    truncateMatches(item.truncate);
}

export function summarizeRealtimeVoiceTransportBenchmark(
  cases: readonly RealtimeVoiceTransportBenchmarkCase[]
) {
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id.trim() || ids.has(item.id)) {
      throw new Error("Realtime Voice benchmark case IDs must be unique");
    }
    ids.add(item.id);
  }
  const metricSummaries = Object.fromEntries(
    BENCHMARK_METRICS.map((metric) => {
      const values = cases.flatMap((item) => {
        const value = item.trace.metrics[metric];
        return value === null ? [] : [value];
      });
      return [metric, {
        count: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95)
      } satisfies RealtimeVoiceMetricSummary];
    })
  ) as Record<(typeof BENCHMARK_METRICS)[number], RealtimeVoiceMetricSummary>;
  const passed = cases.filter(realtimeVoiceBenchmarkCasePassed).length;
  return {
    version: 1 as const,
    benchmarkMode: "transport_contract" as const,
    latencyInterpretation: "caller_supplied_timestamps" as const,
    caseCount: cases.length,
    completedCount: cases.filter((item) => item.status === "completed").length,
    interruptedCount: cases.filter((item) => item.status === "interrupted").length,
    failedCount: cases.filter((item) => item.status === "failed").length,
    contractPassedCount: passed,
    contractPassRate: cases.length === 0 ? null : passed / cases.length,
    reconnectCount: cases.reduce(
      (total, item) => total + (item.reconnectCount ?? 0),
      0
    ),
    metrics: metricSummaries,
    failedCaseIds: cases
      .filter((item) => !realtimeVoiceBenchmarkCasePassed(item))
      .map((item) => item.id)
  };
}
