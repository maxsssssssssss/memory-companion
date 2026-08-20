import { describe, expect, it } from "vitest";

import {
  buildDiarizationBenchmarkReport,
  evaluateDiarizationRegressionCase
} from "./diarization-regression";

describe("diarization regression evaluation", () => {
  it("measures speaker count, boundaries, fragmentation, and verified identity", () => {
    const result = evaluateDiarizationRegressionCase({
      case: "two_speakers",
      expectedSpeakerCount: 2,
      boundaryToleranceSeconds: 0.25,
      maximumFragmentationRate: 0.25,
      minimumBoundaryRecall: 0.8,
      minimumIdentityMatchRate: 0.9,
      expected: [
        { startSeconds: 0, endSeconds: 2, speaker: "A", identity: "user_A" },
        { startSeconds: 2, endSeconds: 4, speaker: "B", identity: "contact_B" }
      ],
      observed: [
        {
          startSeconds: 0,
          endSeconds: 2.1,
          speaker: "speaker_1",
          resolvedIdentity: "user_A",
          providerVerified: true
        },
        {
          startSeconds: 2.1,
          endSeconds: 4,
          speaker: "speaker_2",
          resolvedIdentity: "contact_B",
          providerVerified: true
        }
      ]
    });

    expect(result).toMatchObject({
      speakerCount: { expected: 2, actual: 2, passed: true },
      segmentBoundary: { recall: 1, passed: true },
      fragmentation: { extraFragments: 0, rate: 0, passed: true },
      identityMatchRate: { rate: 1, passed: true },
      result: "PASS"
    });
  });

  it("does not count an unverified identity label as a match", () => {
    const result = evaluateDiarizationRegressionCase({
      case: "single_speaker",
      expectedSpeakerCount: 1,
      expected: [
        { startSeconds: 0, endSeconds: 4, speaker: "A", identity: "user_A" }
      ],
      observed: [{
        startSeconds: 0,
        endSeconds: 4,
        speaker: "speaker_0",
        resolvedIdentity: "user_A",
        providerVerified: false
      }]
    });

    expect(result.identityMatchRate).toMatchObject({
      eligibleSegments: 1,
      matchedSegments: 0,
      rate: 0,
      passed: false
    });
    expect(result.result).toBe("FAIL");
  });

  it("does not reuse one observed boundary for multiple expected boundaries", () => {
    const result = evaluateDiarizationRegressionCase({
      case: "single_speaker",
      expectedSpeakerCount: 1,
      boundaryToleranceSeconds: 0.25,
      minimumBoundaryRecall: 1,
      expected: [
        { startSeconds: 0, endSeconds: 2, speaker: "A" },
        { startSeconds: 2, endSeconds: 2.2, speaker: "A" },
        { startSeconds: 2.2, endSeconds: 4, speaker: "A" }
      ],
      observed: [
        { startSeconds: 0, endSeconds: 2.1, speaker: "speaker_1" },
        { startSeconds: 2.1, endSeconds: 4, speaker: "speaker_1" }
      ]
    });

    expect(result.segmentBoundary).toMatchObject({
      expected: 2,
      observed: 1,
      matched: 1,
      recall: 0.5,
      passed: false
    });
    expect(result.result).toBe("FAIL");
  });

  it("does not reuse one verified observed segment for multiple expected segments", () => {
    const result = evaluateDiarizationRegressionCase({
      case: "single_speaker",
      expectedSpeakerCount: 1,
      expected: [
        { startSeconds: 0, endSeconds: 2, speaker: "A", identity: "user_A" },
        { startSeconds: 2, endSeconds: 4, speaker: "A", identity: "user_A" }
      ],
      observed: [{
        startSeconds: 0,
        endSeconds: 4,
        speaker: "speaker_1",
        resolvedIdentity: "user_A",
        providerVerified: true
      }]
    });

    expect(result.identityMatchRate).toMatchObject({
      eligibleSegments: 2,
      matchedSegments: 1,
      rate: 0.5,
      passed: false
    });
    expect(result.result).toBe("FAIL");
  });

  it("requires all five named regression cases exactly once", () => {
    expect(() => buildDiarizationBenchmarkReport({
      version: 1,
      provider: "fixture",
      cases: Array.from({ length: 5 }, () => ({
        case: "noise" as const,
        expectedSpeakerCount: 1,
        expected: [{ startSeconds: 0, endSeconds: 1, speaker: "A" }],
        observed: []
      }))
    })).toThrow("regression suite must contain each fixed case exactly once");
  });
});
