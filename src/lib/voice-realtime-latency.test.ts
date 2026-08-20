import { describe, expect, it } from "vitest";

import {
  RealtimeVoiceLatencyTracker,
  calculateRealtimeVoiceLatencyMetrics
} from "./voice-realtime-latency";

describe("Realtime Voice latency", () => {
  it("records each content-free marker once and calculates Phase 1 segments", () => {
    let now = 1_000;
    const tracker = new RealtimeVoiceLatencyTracker(3, () => now);
    const mark = (name: Parameters<typeof tracker.mark>[0], at: number) => {
      now = at;
      expect(tracker.mark(name)).toBe(true);
    };

    mark("speech_start", 1_000);
    mark("first_partial_asr", 1_120);
    mark("speech_end", 2_000);
    mark("asr_final", 2_090);
    mark("retrieval_start", 2_100);
    mark("retrieval_complete", 2_300);
    mark("qa_start", 2_310);
    mark("llm_first_token", 2_650);
    mark("qa_complete", 2_880);
    mark("answer_ready", 2_900);
    mark("tts_start", 2_920);
    mark("first_audio", 3_200);
    mark("browser_playback_start", 3_245);
    mark("complete", 3_900);

    expect(tracker.mark("speech_start", 9_999)).toBe(false);
    expect(tracker.snapshot()).toMatchObject({
      version: 1,
      turnSequence: 3,
      timestamps: { speech_start: 1_000, complete: 3_900 },
      metrics: {
        speech_start_to_first_partial_ms: 120,
        speech_start_to_first_feedback_ms: 120,
        speech_end_to_asr_final_ms: 90,
        retrieval_ms: 200,
        qa_ms: 570,
        llm_ttft_ms: 350,
        tts_to_first_audio_ms: 280,
        first_audio_to_browser_playback_ms: 45,
        speech_end_to_first_audio_ms: 1_200,
        speech_end_to_browser_playback_ms: 1_245,
        total_turn_ms: 2_900
      }
    });
  });

  it("keeps missing or reversed stages null instead of inventing latency", () => {
    expect(calculateRealtimeVoiceLatencyMetrics({
      speech_end: 200,
      first_audio: 100
    })).toMatchObject({
      speech_end_to_first_audio_ms: null,
      speech_start_to_first_partial_ms: null,
      total_turn_ms: null
    });
  });

  it("uses first audio as feedback only when no partial ASR was observed", () => {
    expect(calculateRealtimeVoiceLatencyMetrics({
      speech_start: 100,
      first_audio: 420
    }).speech_start_to_first_feedback_ms).toBe(320);
  });
});
