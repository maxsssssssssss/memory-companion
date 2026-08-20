import { describe, expect, it } from "vitest";

import { RealtimeVoiceLatencyTracker } from "@/lib/voice-realtime-latency";

import {
  realtimeVoiceBenchmarkCasePassed,
  summarizeRealtimeVoiceTransportBenchmark,
  type RealtimeVoiceTransportBenchmarkCase
} from "./realtime-voice-transport-benchmark";

function trace(turnSequence: number, offset = 0) {
  const tracker = new RealtimeVoiceLatencyTracker(turnSequence);
  tracker.mark("speech_start", offset + 0);
  tracker.mark("first_partial_asr", offset + 100);
  tracker.mark("speech_end", offset + 500);
  tracker.mark("asr_final", offset + 550);
  tracker.mark("retrieval_start", offset + 560);
  tracker.mark("retrieval_complete", offset + 760);
  tracker.mark("qa_start", offset + 770);
  tracker.mark("llm_first_token", offset + 1_000);
  tracker.mark("qa_complete", offset + 1_180);
  tracker.mark("answer_ready", offset + 1_200);
  tracker.mark("tts_start", offset + 1_210);
  tracker.mark("first_audio", offset + 1_450);
  tracker.mark("browser_playback_start", offset + 1_480);
  tracker.mark("complete", offset + 1_900);
  return tracker.snapshot();
}

function benchmarkCase(
  overrides: Partial<RealtimeVoiceTransportBenchmarkCase> = {}
): RealtimeVoiceTransportBenchmarkCase {
  return {
    id: "case-1",
    expectedStatus: "completed",
    status: "completed",
    requiredMarkers: ["first_partial_asr", "llm_first_token"],
    trace: trace(1),
    terminalEventCount: 1,
    audioSequences: [1, 2, 3],
    resourceLeakCount: 0,
    ...overrides
  };
}

describe("Realtime Voice transport benchmark", () => {
  it("summarizes latency and contract outcomes without calling a Provider", () => {
    const report = summarizeRealtimeVoiceTransportBenchmark([
      benchmarkCase(),
      benchmarkCase({
        id: "barge-in",
        expectedStatus: "interrupted",
        status: "interrupted",
        trace: trace(2, 100),
        truncate: {
          expectedItemId: "reply-2",
          actualItemId: "reply-2",
          expectedAudioEndMs: 240,
          actualAudioEndMs: 240
        }
      })
    ]);

    expect(report).toMatchObject({
      benchmarkMode: "transport_contract",
      caseCount: 2,
      completedCount: 1,
      interruptedCount: 1,
      contractPassedCount: 2,
      contractPassRate: 1,
      failedCaseIds: [],
      metrics: {
        speech_start_to_first_partial_ms: { count: 2, p50: 100, p95: 100 },
        speech_end_to_first_audio_ms: { count: 2, p50: 950, p95: 950 }
      }
    });
  });

  it("fails status mismatch, missing markers, duplicate terminal, sequence gap, leak, or wrong truncate item", () => {
    expect(realtimeVoiceBenchmarkCasePassed(benchmarkCase({
      expectedStatus: "interrupted"
    }))).toBe(false);
    const incompleteTrace = new RealtimeVoiceLatencyTracker(1);
    incompleteTrace.mark("speech_start", 0);
    incompleteTrace.mark("complete", 10);
    expect(realtimeVoiceBenchmarkCasePassed(benchmarkCase({
      trace: incompleteTrace.snapshot()
    }))).toBe(false);
    const missingCaseMarker = trace(1);
    delete missingCaseMarker.timestamps.llm_first_token;
    expect(realtimeVoiceBenchmarkCasePassed(benchmarkCase({
      trace: missingCaseMarker
    }))).toBe(false);
    const reversedTrace = trace(1);
    reversedTrace.timestamps.complete = 1;
    expect(realtimeVoiceBenchmarkCasePassed(benchmarkCase({
      trace: reversedTrace
    }))).toBe(false);
    expect(realtimeVoiceBenchmarkCasePassed(benchmarkCase({
      terminalEventCount: 2
    }))).toBe(false);
    expect(realtimeVoiceBenchmarkCasePassed(benchmarkCase({
      audioSequences: [1, 3]
    }))).toBe(false);
    expect(realtimeVoiceBenchmarkCasePassed(benchmarkCase({
      resourceLeakCount: 1
    }))).toBe(false);
    expect(realtimeVoiceBenchmarkCasePassed(benchmarkCase({
      truncate: {
        expectedItemId: "reply-1",
        actualItemId: "reply-2",
        expectedAudioEndMs: 100,
        actualAudioEndMs: 100
      }
    }))).toBe(false);
  });
});
