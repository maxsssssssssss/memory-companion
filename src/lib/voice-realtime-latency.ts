export const REALTIME_VOICE_LATENCY_MARKERS = [
  "speech_start",
  "first_partial_asr",
  "speech_end",
  "asr_final",
  "retrieval_start",
  "retrieval_complete",
  "qa_start",
  "llm_first_token",
  "qa_complete",
  "sentence_commit",
  "answer_ready",
  "tts_start",
  "first_audio",
  "browser_playback_start",
  "browser_playback_complete",
  "complete"
] as const;

export type RealtimeVoiceLatencyMarker =
  (typeof REALTIME_VOICE_LATENCY_MARKERS)[number];

export type RealtimeVoiceLatencyMetrics = {
  user_audio_duration_ms: number | null;
  speech_start_to_first_partial_ms: number | null;
  speech_start_to_first_feedback_ms: number | null;
  speech_end_to_asr_final_ms: number | null;
  asr_final_to_retrieval_start_ms: number | null;
  retrieval_ms: number | null;
  qa_ms: number | null;
  llm_ttft_ms: number | null;
  sentence_commit_wait_ms: number | null;
  asr_final_to_answer_ready_ms: number | null;
  answer_ready_to_tts_start_ms: number | null;
  tts_to_first_audio_ms: number | null;
  first_audio_to_browser_playback_ms: number | null;
  browser_playback_duration_ms: number | null;
  speech_end_to_first_audio_ms: number | null;
  speech_end_to_browser_playback_ms: number | null;
  total_turn_ms: number | null;
};

export type RealtimeVoiceLatencySnapshot = {
  version: 1;
  turnSequence: number;
  timestamps: Partial<Record<RealtimeVoiceLatencyMarker, number>>;
  metrics: RealtimeVoiceLatencyMetrics;
};

type RealtimeClock = () => number;

function duration(
  timestamps: RealtimeVoiceLatencySnapshot["timestamps"],
  start: RealtimeVoiceLatencyMarker,
  end: RealtimeVoiceLatencyMarker
) {
  const startAt = timestamps[start];
  const endAt = timestamps[end];
  if (startAt === undefined || endAt === undefined) return null;
  const elapsed = endAt - startAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null;
}

function earliestDuration(
  timestamps: RealtimeVoiceLatencySnapshot["timestamps"],
  start: RealtimeVoiceLatencyMarker,
  ends: readonly RealtimeVoiceLatencyMarker[]
) {
  const candidates = ends
    .map((end) => duration(timestamps, start, end))
    .filter((value): value is number => value !== null);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function calculateRealtimeVoiceLatencyMetrics(
  timestamps: RealtimeVoiceLatencySnapshot["timestamps"]
): RealtimeVoiceLatencyMetrics {
  return {
    user_audio_duration_ms: duration(timestamps, "speech_start", "speech_end"),
    speech_start_to_first_partial_ms: duration(
      timestamps,
      "speech_start",
      "first_partial_asr"
    ),
    speech_start_to_first_feedback_ms: earliestDuration(
      timestamps,
      "speech_start",
      ["first_partial_asr", "first_audio"]
    ),
    speech_end_to_asr_final_ms: duration(
      timestamps,
      "speech_end",
      "asr_final"
    ),
    asr_final_to_retrieval_start_ms: duration(
      timestamps,
      "asr_final",
      "retrieval_start"
    ),
    retrieval_ms: duration(
      timestamps,
      "retrieval_start",
      "retrieval_complete"
    ),
    qa_ms: duration(timestamps, "qa_start", "qa_complete"),
    llm_ttft_ms: duration(
      timestamps,
      "retrieval_complete",
      "llm_first_token"
    ),
    sentence_commit_wait_ms: duration(
      timestamps,
      "llm_first_token",
      "sentence_commit"
    ),
    asr_final_to_answer_ready_ms: duration(
      timestamps,
      "asr_final",
      "answer_ready"
    ),
    answer_ready_to_tts_start_ms: duration(
      timestamps,
      "answer_ready",
      "tts_start"
    ),
    tts_to_first_audio_ms: duration(
      timestamps,
      "tts_start",
      "first_audio"
    ),
    first_audio_to_browser_playback_ms: duration(
      timestamps,
      "first_audio",
      "browser_playback_start"
    ),
    browser_playback_duration_ms: duration(
      timestamps,
      "browser_playback_start",
      "browser_playback_complete"
    ),
    speech_end_to_first_audio_ms: duration(
      timestamps,
      "speech_end",
      "first_audio"
    ),
    speech_end_to_browser_playback_ms: duration(
      timestamps,
      "speech_end",
      "browser_playback_start"
    ),
    total_turn_ms: duration(timestamps, "speech_start", "complete")
  };
}

/**
 * Content-free, per-turn timing collector shared by the realtime controller,
 * browser event protocol, and offline benchmark harness. It deliberately owns
 * no transcript, answer, evidence, citation, or Provider conversation data.
 */
export class RealtimeVoiceLatencyTracker {
  private readonly timestamps: RealtimeVoiceLatencySnapshot["timestamps"] = {};

  constructor(
    readonly turnSequence: number,
    private readonly now: RealtimeClock = Date.now
  ) {
    if (!Number.isSafeInteger(turnSequence) || turnSequence < 1) {
      throw new Error("Realtime Voice turn sequence must be a positive integer");
    }
  }

  mark(marker: RealtimeVoiceLatencyMarker, at = this.now()) {
    if (this.timestamps[marker] !== undefined) return false;
    if (!Number.isFinite(at) || at < 0) {
      throw new Error("Realtime Voice latency timestamp must be non-negative");
    }
    this.timestamps[marker] = Math.round(at);
    return true;
  }

  snapshot(): RealtimeVoiceLatencySnapshot {
    const timestamps = { ...this.timestamps };
    return {
      version: 1,
      turnSequence: this.turnSequence,
      timestamps,
      metrics: calculateRealtimeVoiceLatencyMetrics(timestamps)
    };
  }
}
