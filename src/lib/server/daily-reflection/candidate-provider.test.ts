import { describe, expect, it } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";

import {
  DAILY_REFLECTION_CANDIDATE_JSON_INSTRUCTION,
  DAILY_REFLECTION_CARD_ORGANIZER_JSON_INSTRUCTION,
  DailyReflectionCandidateProviderFailedError,
  DailyReflectionCandidateValidationError,
  safeDailyReflectionProviderDiagnostics,
  validateDailyReflectionOrganizedCards,
  validateDailyReflectionProviderCandidates
} from "./candidate-provider";
import { DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY } from "./card-pipeline-policy";

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

describe("Daily Reflection Provider JSON contracts", () => {
  it("pins the exact Candidate and Card enums without accepting observed aliases", () => {
    expect(DAILY_REFLECTION_CANDIDATE_JSON_INSTRUCTION).toContain(
      "insight、open_question、decision、user_action"
    );
    expect(DAILY_REFLECTION_CARD_ORGANIZER_JSON_INSTRUCTION).toContain(
      "explicit_user_statement、reported_event、ai_inference、unknown"
    );
    expect(DAILY_REFLECTION_CARD_ORGANIZER_JSON_INSTRUCTION).toContain(
      "ai_inference、attribution_uncertain、low_evidence、sensitive"
    );
    expect(DAILY_REFLECTION_CARD_ORGANIZER_JSON_INSTRUCTION)
      .not.toContain("explicit_user_reflection");
  });

  it("exposes only bounded schema diagnostics without provider text, URLs or secrets", () => {
    const diagnostics = safeDailyReflectionProviderDiagnostics({
      responseStatus: "sk-0123456789abcdef0123456789abcdef",
      incompleteReason: "https://internal.example/path?key=secret-value",
      responseTextLength: 2_048,
      parseResult: "success",
      validationResult: "failed",
      totalDurationMs: 1_234.4,
      validationIssueCount: 1,
      validationIssues: [{
        path: "items[0].epistemicStatus",
        code: "invalid_enum_value",
        message: "secret-value explicit_user_reflection"
      }],
      validationIssueSummary: [{ code: "invalid_enum_value", count: 1 }],
      validationIssuesTruncated: false,
      inputTokens: 321,
      outputTokens: 87,
      totalTokens: 408
    });
    const failure = new DailyReflectionCandidateProviderFailedError({
      cause: new Error("secret-value transcript body"),
      diagnostics
    });
    const serialized = JSON.stringify(failure);

    expect(diagnostics).toEqual(expect.objectContaining({
      responseStatus: "other",
      incompleteReason: "other",
      responseTextLength: 2_048,
      parseResult: "success",
      validationResult: "failed",
      totalDurationMs: 1_234,
      validationIssues: [{
        path: "items[0].epistemicStatus",
        code: "invalid_enum_value"
      }],
      inputTokens: 321,
      outputTokens: 87,
      totalTokens: 408
    }));
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("internal.example");
    expect(serialized).not.toContain("explicit_user_reflection");
    expect(failure.message).toBe("Daily Reflection Candidate Provider failed");
    expect(failure.code).toBe("daily_reflection_candidate_provider_failed");
  });
});

describe("validateDailyReflectionProviderCandidates", () => {
  it("allows an individual extraction window to contain no review-worthy item", () => {
    expect(validateDailyReflectionProviderCandidates({
      accountId: "account_1",
      reflectionId: "reflection_empty_window",
      segments: segments(1),
      candidateLimit: 3,
      response: { items: [] }
    })).toEqual([]);
  });

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

  it("normalizes provider true, false and missing action claims to false", () => {
    const candidates = validateDailyReflectionProviderCandidates({
      accountId: "account_1",
      reflectionId: "reflection_1",
      segments: segments(3),
      candidateLimit: 8,
      response: {
        items: [
          { candidateKind: "user_action", proposedText: "Provider true", evidenceIds: ["segment_1"], confidence: 0.9, caution: "Review.", actionClaimed: true },
          { candidateKind: "user_action", proposedText: "Provider false", evidenceIds: ["segment_2"], confidence: 0.8, caution: "Review.", actionClaimed: false },
          { candidateKind: "user_action", proposedText: "Provider missing", evidenceIds: ["segment_3"], confidence: 0.7, caution: "Review." }
        ]
      }
    });
    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => candidate.actionClaimed === false)).toBe(true);
  });

  it("keeps Hidden Candidate IDs stable when only Provider scoring metadata changes", () => {
    const validate = (confidence: number, caution: string) =>
      validateDailyReflectionProviderCandidates({
        accountId: "account_1",
        reflectionId: "reflection_stable",
        segments: segments(1),
        candidateLimit: 8,
        response: {
          items: [{
            candidateKind: "insight",
            proposedText: "  Same semantic candidate  ",
            evidenceIds: ["segment_1"],
            confidence,
            caution
          }]
        }
      });

    expect(validate(0.9, "First audit caution.")[0].id).toBe(
      validate(0.7, "Updated audit caution.")[0].id
    );
  });
});

describe("validateDailyReflectionOrganizedCards", () => {
  it("derives canonical Evidence, normalizes actions and produces stable tiers", () => {
    const hidden = validateDailyReflectionProviderCandidates({
      accountId: "account_1",
      reflectionId: "reflection_cards",
      segments: segments(3),
      candidateLimit: 8,
      response: { items: [
        { candidateKind: "insight", proposedText: "Insight A", evidenceIds: ["segment_1"], confidence: 0.9, caution: "Review", topicHint: "工作" },
        { candidateKind: "decision", proposedText: "Decision B", evidenceIds: ["segment_2"], confidence: 0.8, caution: "Review", topicHint: "健康" },
        { candidateKind: "user_action", proposedText: "Action C", evidenceIds: ["segment_3"], confidence: 0.7, caution: "Review", topicHint: "工作" }
      ] }
    });
    const response = { items: [
      {
        cardKind: "insight" as const,
        proposedTitle: "工作发现",
        proposedText: "Insight A",
        sourceCandidateIds: [hidden[0].id!],
        clusterTitle: "工作",
        confidence: 0.9,
        importance: 0.9,
        durability: 0.7,
        novelty: 0.8,
        epistemicStatus: "explicit_user_statement" as const,
        riskFlags: []
      },
      {
        cardKind: "decision" as const,
        proposedTitle: "健康决定",
        proposedText: "Decision B",
        sourceCandidateIds: [hidden[1].id!],
        clusterTitle: "健康",
        confidence: 0.8,
        importance: 0.8,
        durability: 0.8,
        novelty: 0.6,
        epistemicStatus: "reported_event" as const,
        riskFlags: []
      },
      {
        cardKind: "user_action" as const,
        proposedTitle: "后续行动",
        proposedText: "Action C",
        sourceCandidateIds: [hidden[2].id!],
        clusterTitle: "工作",
        confidence: 0.7,
        importance: 0.7,
        durability: 0.6,
        novelty: 0.5,
        epistemicStatus: "ai_inference" as const,
        riskFlags: [],
        actionClaimed: true
      }
    ] };
    const validationInput = {
      accountId: "account_1",
      reflectionId: "reflection_cards",
      effectiveDurationMs: 120_000,
      policy: DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY,
      candidates: hidden,
      response
    };
    const first = validateDailyReflectionOrganizedCards(validationInput);
    expect(validateDailyReflectionOrganizedCards(validationInput)).toEqual(first);
    expect(first).toHaveLength(3);
    expect(first.every((card) => card.displayTier === "primary")).toBe(true);
    expect(first.every((card) => card.actionClaimed === false)).toBe(true);
    expect(first.find((card) => card.cardKind === "user_action")?.riskFlags)
      .toContain("ai_inference");
    for (const card of first) {
      const expectedEvidence = [...new Set(card.sourceCandidateIds.flatMap(
        (candidateId) => hidden.find((candidate) => candidate.id === candidateId)!.evidenceIds
      ))];
      expect(card.evidenceIds).toEqual(expectedEvidence);
    }
  });

  it("caps a 10-30 minute digest at four topics and two Cards per topic", () => {
    const canonical = segments(15);
    const hidden = validateDailyReflectionProviderCandidates({
      accountId: "account_1",
      reflectionId: "reflection_topics",
      segments: canonical,
      candidateLimit: 32,
      response: {
        items: canonical.map((segment, index) => ({
          candidateKind: "insight" as const,
          proposedText: `Insight ${index + 1}`,
          evidenceIds: [segment.id],
          confidence: 1 - index / 100,
          caution: "Review",
          topicHint: `Topic ${index % 5}`
        }))
      }
    });
    const cards = validateDailyReflectionOrganizedCards({
      accountId: "account_1",
      reflectionId: "reflection_topics",
      effectiveDurationMs: 20 * 60 * 1_000,
      policy: DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY,
      candidates: hidden,
      response: {
        items: hidden.map((candidate, index) => ({
          cardKind: "insight" as const,
          proposedTitle: `Insight ${index + 1}`,
          proposedText: candidate.proposedText,
          sourceCandidateIds: [candidate.id!],
          clusterTitle: `Topic ${index % 5}`,
          confidence: candidate.confidence,
          importance: 1 - index / 100,
          durability: 0.8,
          novelty: 0.7,
          epistemicStatus: "explicit_user_statement" as const,
          riskFlags: []
        }))
      }
    });

    expect(cards).toHaveLength(8);
    const perCluster = new Map<string, number>();
    for (const card of cards) {
      perCluster.set(card.clusterId, (perCluster.get(card.clusterId) ?? 0) + 1);
    }
    expect(perCluster.size).toBe(4);
    expect([...perCluster.values()].every((count) => count <= 2)).toBe(true);
  });

  it("rejects organizer sources outside the Hidden Candidate allowlist", () => {
    const hidden = validateDailyReflectionProviderCandidates({
      accountId: "account_1",
      reflectionId: "reflection_cards",
      segments: segments(1),
      candidateLimit: 2,
      response: { items: [{
        candidateKind: "insight",
        proposedText: "Insight",
        evidenceIds: ["segment_1"],
        confidence: 0.9,
        caution: "Review"
      }] }
    });
    expect(() => validateDailyReflectionOrganizedCards({
      accountId: "account_1",
      reflectionId: "reflection_cards",
      effectiveDurationMs: 60_000,
      policy: DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY,
      candidates: hidden,
      response: { items: [{
        cardKind: "insight",
        proposedTitle: "Unsupported",
        proposedText: "Unsupported",
        sourceCandidateIds: ["invented_candidate"],
        clusterTitle: "Other",
        confidence: 0.9,
        importance: 0.9,
        durability: 0.9,
        novelty: 0.9,
        epistemicStatus: "unknown",
        riskFlags: []
      }] }
    })).toThrowError(expect.objectContaining<Partial<DailyReflectionCandidateValidationError>>({
      reason: "organizer_candidate_missing"
    }));
  });
});
