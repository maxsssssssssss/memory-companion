import { describe, expect, it } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";

import {
  DailyReflectionCandidateValidationError,
  validateDailyReflectionProviderCandidates
} from "./candidate-provider";

function segments(count = 8): TranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `segment_${index + 1}`,
    uploadId: "upload_1",
    startSeconds: index * 10,
    endSeconds: index * 10 + 8,
    text: `Canonical segment ${index + 1}`,
    confidence: 0.95,
    sceneLabels: [],
    valueLabels: []
  }));
}

describe("validateDailyReflectionProviderCandidates", () => {
  it("enforces the Canonical Evidence allowlist before persistence", () => {
    expect(() => validateDailyReflectionProviderCandidates({
      accountId: "account_1",
      reflectionId: "reflection_1",
      segments: segments(1),
      candidateLimit: 3,
      response: {
        items: [{
          candidateKind: "insight",
          proposedText: "Unsupported candidate",
          evidenceIds: ["invented_segment"],
          confidence: 0.9,
          caution: "Needs review.",
          actionClaimed: false
        }]
      }
    })).toThrowError(expect.objectContaining<Partial<DailyReflectionCandidateValidationError>>({
      reason: "canonical_evidence_missing"
    }));
  });

  it("deduplicates, orders and caps quick candidates deterministically", () => {
    const input = {
      accountId: "account_1",
      reflectionId: "reflection_1",
      segments: segments(4),
      candidateLimit: 3,
      response: {
        items: [
          {
            candidateKind: "insight",
            proposedText: "  Same   insight ",
            evidenceIds: ["segment_2", "segment_1", "segment_2"],
            confidence: 0.99,
            caution: " Review this. ",
            actionClaimed: false
          },
          {
            candidateKind: "insight",
            proposedText: "same insight",
            evidenceIds: ["segment_3"],
            confidence: 0.6,
            caution: "Duplicate.",
            actionClaimed: false
          },
          ...Array.from({ length: 4 }, (_, index) => ({
            candidateKind: "decision" as const,
            proposedText: `Decision ${index + 1}`,
            evidenceIds: [`segment_${index + 1}`],
            confidence: 0.95 - index * 0.05,
            caution: "Confirm the decision.",
            actionClaimed: false
          }))
        ]
      }
    };
    const first = validateDailyReflectionProviderCandidates(input);
    const second = validateDailyReflectionProviderCandidates(input);
    expect(second).toEqual(first);
    expect(first).toHaveLength(3);
    expect(first.map((candidate) => candidate.ordinal)).toEqual([0, 1, 2]);
    expect(first.find((candidate) => candidate.proposedText === "Same insight"))
      .toMatchObject({ evidenceIds: ["segment_1", "segment_2"] });
    expect(new Set(first.map((candidate) => candidate.id)).size).toBe(3);
  });

  it("allows a full plan up to seven but never beyond the hard cap", () => {
    const candidates = validateDailyReflectionProviderCandidates({
      accountId: "account_1",
      reflectionId: "reflection_full",
      segments: segments(8),
      candidateLimit: 7,
      response: {
        items: Array.from({ length: 8 }, (_, index) => ({
          candidateKind: "insight" as const,
          proposedText: `Insight ${index + 1}`,
          evidenceIds: [`segment_${index + 1}`],
          confidence: 1 - index / 20,
          caution: "Review.",
          actionClaimed: false
        }))
      }
    });
    expect(candidates).toHaveLength(7);
  });

  it("rejects an action claim on a non-user_action item", () => {
    expect(() => validateDailyReflectionProviderCandidates({
      accountId: "account_1",
      reflectionId: "reflection_1",
      segments: segments(1),
      candidateLimit: 3,
      response: {
        items: [{
          candidateKind: "decision",
          proposedText: "Decision",
          evidenceIds: ["segment_1"],
          confidence: 0.9,
          caution: "Review.",
          actionClaimed: true
        }]
      }
    })).toThrow(DailyReflectionCandidateValidationError);
  });
});
