import {
  summarizeRealtimeVoiceTransportBenchmark,
  type RealtimeVoiceTransportBenchmarkCase
} from "@/lib/server/evaluation/realtime-voice-transport-benchmark";
import { RealtimeVoiceLatencyTracker } from "@/lib/voice-realtime-latency";

function completedTrace(turnSequence: number, scale = 1) {
  const tracker = new RealtimeVoiceLatencyTracker(turnSequence);
  const marks = [
    ["speech_start", 0],
    ["first_partial_asr", 90],
    ["speech_end", 600],
    ["asr_final", 680],
    ["retrieval_start", 690],
    ["retrieval_complete", 890],
    ["qa_start", 900],
    ["llm_first_token", 1_120],
    ["qa_complete", 1_340],
    ["answer_ready", 1_360],
    ["tts_start", 1_370],
    ["first_audio", 1_620],
    ["browser_playback_start", 1_650],
    ["complete", 2_100]
  ] as const;
  for (const [marker, at] of marks) tracker.mark(marker, Math.round(at * scale));
  return tracker.snapshot();
}

function interruptedTrace(turnSequence: number) {
  const tracker = new RealtimeVoiceLatencyTracker(turnSequence);
  tracker.mark("speech_start", 0);
  tracker.mark("first_partial_asr", 80);
  tracker.mark("speech_end", 600);
  tracker.mark("asr_final", 680);
  tracker.mark("retrieval_start", 690);
  tracker.mark("retrieval_complete", 890);
  tracker.mark("qa_start", 900);
  tracker.mark("llm_first_token", 1_120);
  tracker.mark("qa_complete", 1_340);
  tracker.mark("answer_ready", 1_360);
  tracker.mark("tts_start", 1_370);
  tracker.mark("first_audio", 1_620);
  tracker.mark("browser_playback_start", 1_650);
  tracker.mark("complete", 1_700);
  return tracker.snapshot();
}

function failedTrace(turnSequence: number) {
  const tracker = new RealtimeVoiceLatencyTracker(turnSequence);
  tracker.mark("speech_start", 0);
  tracker.mark("speech_end", 300);
  tracker.mark("complete", 320);
  return tracker.snapshot();
}

const COMPLETED_REQUIRED_MARKERS = [
  "first_partial_asr",
  "llm_first_token"
] as const;

const cases: RealtimeVoiceTransportBenchmarkCase[] = [
  {
    id: "continuous_turn_1",
    expectedStatus: "completed",
    status: "completed",
    requiredMarkers: COMPLETED_REQUIRED_MARKERS,
    trace: completedTrace(1),
    terminalEventCount: 1,
    audioSequences: [1, 2, 3],
    resourceLeakCount: 0
  },
  {
    id: "continuous_turn_2",
    expectedStatus: "completed",
    status: "completed",
    requiredMarkers: COMPLETED_REQUIRED_MARKERS,
    trace: completedTrace(2, 1.05),
    terminalEventCount: 1,
    audioSequences: [1, 2],
    resourceLeakCount: 0
  },
  {
    id: "server_vad_auto_commit",
    expectedStatus: "completed",
    status: "completed",
    requiredMarkers: COMPLETED_REQUIRED_MARKERS,
    trace: completedTrace(3, 0.95),
    terminalEventCount: 1,
    audioSequences: [1],
    resourceLeakCount: 0
  },
  {
    id: "playback_barge_in",
    expectedStatus: "interrupted",
    status: "interrupted",
    requiredMarkers: [
      "first_partial_asr",
      "first_audio",
      "browser_playback_start"
    ],
    trace: interruptedTrace(4),
    terminalEventCount: 1,
    audioSequences: [1, 2],
    resourceLeakCount: 0,
    truncate: {
      expectedItemId: "mock-reply-4",
      actualItemId: "mock-reply-4",
      expectedAudioEndMs: 240,
      actualAudioEndMs: 240
    }
  },
  {
    id: "single_reconnect",
    expectedStatus: "completed",
    status: "completed",
    requiredMarkers: COMPLETED_REQUIRED_MARKERS,
    trace: completedTrace(5, 1.1),
    terminalEventCount: 1,
    audioSequences: [1, 2, 3],
    resourceLeakCount: 0,
    reconnectCount: 1
  },
  {
    id: "empty_asr_terminal",
    expectedStatus: "failed",
    status: "failed",
    requiredMarkers: ["speech_end"],
    trace: failedTrace(6),
    terminalEventCount: 1,
    audioSequences: [],
    resourceLeakCount: 0
  }
];

for (const [index, item] of cases.entries()) {
  console.error(
    `[realtime-voice-mock] ${index + 1}/${cases.length} ${item.id} ${item.status}`
  );
}

const report = summarizeRealtimeVoiceTransportBenchmark(cases);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  providerCalls: 0,
  syntheticLatency: true,
  warning: "Contract-only mock. Latency values are not real Doubao measurements.",
  report
}, null, 2));
if (report.contractPassedCount !== report.caseCount) process.exitCode = 1;
