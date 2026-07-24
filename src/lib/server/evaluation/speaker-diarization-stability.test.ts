import { describe, expect, it } from "vitest";

import {
  buildSpeakerDiarizationBenchmarkMatrix,
  classifySpeakerDiarizationFailure,
  summarizeSpeakerDiarizationBenchmark,
  type SpeakerDiarizationTrialResult
} from "@/lib/server/evaluation/speaker-diarization-stability";

function result(
  overrides: Partial<SpeakerDiarizationTrialResult> = {}
): SpeakerDiarizationTrialResult {
  return {
    caseId: "d30-s2-r1",
    executionIndex: 1,
    durationSeconds: 30,
    speakerParameter: 2,
    repetition: 1,
    audioFormat: "pcm_s16le/16000Hz/mono",
    asrSuccess: true,
    combined: {
      attempted: true,
      success: true,
      queryCount: 2,
      totalLatencyMs: 1_000,
      providerCodes: [0, 2, 0],
      terminalReason: "speaker_result",
      speakerResultExists: true,
      speakerCount: 2,
      labels: ["speaker_1", "speaker_2"]
    },
    standalone: {
      attempted: false,
      success: false,
      queryCount: 0,
      totalLatencyMs: 0,
      providerCodes: [],
      terminalReason: "not_needed",
      speakerResultExists: false,
      speakerCount: 0,
      labels: []
    },
    finalSuccess: true,
    finalSource: "combined_asr",
    totalLatencyMs: 1_000,
    ...overrides
  };
}

describe("speaker diarization stability benchmark", () => {
  it("builds five durations, two parameters, and three repetitions", () => {
    const matrix = buildSpeakerDiarizationBenchmarkMatrix();

    expect(matrix).toHaveLength(30);
    expect(new Set(matrix.map((item) => item.durationSeconds))).toEqual(
      new Set([30, 45, 60, 70, 90])
    );
    expect(new Set(matrix.map((item) => item.speakerParameter))).toEqual(
      new Set([0, 2])
    );
    for (const durationSeconds of [30, 45, 60, 70, 90]) {
      for (const speakerParameter of [0, 2]) {
        expect(
          matrix.filter(
            (item) =>
              item.durationSeconds === durationSeconds &&
              item.speakerParameter === speakerParameter
          )
        ).toHaveLength(3);
      }
    }
  });

  it("alternates which parameter runs first to reduce order bias", () => {
    const matrix = buildSpeakerDiarizationBenchmarkMatrix();
    const firstFor30 = matrix
      .filter((item) => item.durationSeconds === 30)
      .filter((item) => item.executionIndex % 2 === 1)
      .map((item) => item.speakerParameter);

    expect(firstFor30).toEqual([0, 2, 0]);
  });

  it("rejects unsafe repetition counts", () => {
    expect(() => buildSpeakerDiarizationBenchmarkMatrix(0)).toThrow();
    expect(() => buildSpeakerDiarizationBenchmarkMatrix(11)).toThrow();
  });

  it("classifies only bounded failure categories", () => {
    expect(classifySpeakerDiarizationFailure("asr_missing_speaker_labels"))
      .toBe("empty_speaker_result");
    expect(classifySpeakerDiarizationFailure("asr_provider_code_1"))
      .toBe("provider_code_failure");
    expect(classifySpeakerDiarizationFailure("asr_poll_timeout"))
      .toBe("timeout");
    expect(classifySpeakerDiarizationFailure("fetch failed"))
      .toBe("network_error");
    expect(classifySpeakerDiarizationFailure("asr_http_500"))
      .toBe("http_error");
    expect(classifySpeakerDiarizationFailure("asr_invalid_json"))
      .toBe("invalid_response");
  });

  it("aggregates combined success, standalone recovery, and failures", () => {
    const recovered = result({
      caseId: "d30-s0-r1",
      executionIndex: 2,
      speakerParameter: 0,
      combined: {
        attempted: true,
        success: false,
        queryCount: 4,
        totalLatencyMs: 2_000,
        providerCodes: [0, 2, 0],
        terminalReason: "speaker_grace_timeout",
        speakerResultExists: false,
        speakerCount: 0,
        labels: [],
        failureCategory: "empty_speaker_result"
      },
      standalone: {
        attempted: true,
        success: true,
        queryCount: 1,
        totalLatencyMs: 500,
        providerCodes: [0],
        terminalReason: "speaker_result",
        speakerResultExists: true,
        speakerCount: 2,
        labels: ["speaker_1", "speaker_2"]
      },
      finalSource: "standalone_diarization",
      totalLatencyMs: 2_500
    });
    const failed = result({
      caseId: "d45-s2-r1",
      executionIndex: 3,
      durationSeconds: 45,
      combined: {
        attempted: true,
        success: false,
        queryCount: 0,
        totalLatencyMs: 100,
        providerCodes: [1],
        terminalReason: "provider_code_failure",
        speakerResultExists: false,
        speakerCount: 0,
        labels: [],
        failureCategory: "provider_code_failure"
      },
      standalone: {
        attempted: false,
        success: false,
        queryCount: 0,
        totalLatencyMs: 0,
        providerCodes: [],
        terminalReason: "asr_not_ready",
        speakerResultExists: false,
        speakerCount: 0,
        labels: []
      },
      asrSuccess: false,
      finalSuccess: false,
      finalSource: "none",
      totalLatencyMs: 100,
      failureCategory: "provider_code_failure"
    });

    const summary = summarizeSpeakerDiarizationBenchmark(
      [result(), recovered, failed],
      30
    );

    expect(summary.completedTrials).toBe(3);
    expect(summary.overall).toMatchObject({
      trials: 3,
      asrSuccesses: 2,
      speakerResultAvailable: 1,
      combinedSuccesses: 1,
      standaloneRecoveries: 1,
      finalSuccesses: 2,
      successRate: 0.6667,
      medianLatencyMs: 1_000,
      p95LatencyMs: 2_500,
      failureCounts: { provider_code_failure: 1 }
    });
    expect(summary.bySpeakerParameter["speaker=0"].standaloneRecoveries).toBe(1);
    expect(summary.byDuration["45s"].finalSuccesses).toBe(0);
    expect(summary.candidateMinimumStableDurationSeconds).toBeNull();
  });
});
