import { describe, expect, it } from "vitest";

import {
  DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION,
  DailyReflectionMemoryProposalPolicyInputSchema,
  evaluateDailyReflectionMemoryProposalPolicy,
  type DailyReflectionMemoryProposalPolicyInput
} from "./memory-proposal-policy";

function policyInput(
  overrides: Partial<DailyReflectionMemoryProposalPolicyInput> = {}
): DailyReflectionMemoryProposalPolicyInput {
  return {
    memoryType: "decision",
    cardStatus: "saved",
    cardKind: "decision",
    actionClaimed: false,
    epistemicStatus: "explicit_user_statement",
    epistemicCaution: null,
    riskFlags: [],
    sourceAvailable: true,
    evidenceValid: true,
    subjectPersonConfirmed: false,
    existingPersonPathEligible: false,
    verifiedOwnerAvailable: true,
    importance: 0.8,
    durability: 0.8,
    novelty: 0.6,
    sensitivity: 0.1,
    existingAdmissionEligible: true,
    existingAdmissionReasons: ["specific_summary"],
    acknowledgements: [],
    ...overrides
  };
}

describe("Daily Reflection Memory proposal policy v2", () => {
  it.each([
    {
      name: "an explicit user insight",
      input: policyInput({
        memoryType: "summary",
        cardKind: "insight"
      })
    },
    {
      name: "an explicit open question",
      input: policyInput({
        memoryType: "question",
        cardKind: "question"
      })
    },
    {
      name: "an explicit decision",
      input: policyInput()
    },
    {
      name: "an explicitly claimed durable action",
      input: policyInput({
        memoryType: "commitment",
        cardKind: "action",
        actionClaimed: true,
        durability: 0.82
      })
    },
    {
      name: "an explicit stable preference accepted by existing admission",
      input: policyInput({
        memoryType: "preference",
        cardKind: "insight",
        durability: 0.78,
        existingAdmissionReasons: ["explicit_stable_preference"]
      })
    },
    {
      name: "an explicit stable fact with a confirmed existing Person path",
      input: policyInput({
        memoryType: "person_fact",
        cardKind: "insight",
        subjectPersonConfirmed: true,
        existingPersonPathEligible: true,
        durability: 0.84
      })
    },
    {
      name: "a reported episodic event without semantic upgrade",
      input: policyInput({
        memoryType: "event",
        cardKind: "event",
        epistemicStatus: "reported_event",
        importance: 0.72,
        durability: 0.55,
        novelty: 0.55
      })
    }
  ])("approves $name", ({ input }) => {
    expect(evaluateDailyReflectionMemoryProposalPolicy(input)).toMatchObject({
      status: "approved",
      reasons: expect.arrayContaining(["user_selected_working_card"]),
      confirmationRequirements: [],
      policyVersion: DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
    });
  });

  it("treats durability and one-time heuristics as recommendation signals after explicit selection", () => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "preference",
      cardKind: "insight",
      durability: 0.1,
      existingAdmissionEligible: false,
      existingAdmissionReasons: ["one_time_or_ambiguous_choice"]
    }));

    expect(result.status).toBe("approved");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "legacy_signal:one_time_or_ambiguous_choice",
      "user_selected_working_card"
    ]));
  });

  it("rejects an unclaimed action even when the existing evaluator accepts its wording", () => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "commitment",
      cardKind: "action",
      actionClaimed: false,
      durability: 0.82,
      existingAdmissionReasons: ["explicit_future_action"]
    }));

    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("action_not_claimed");
  });

  it("rejects a maybe-Alex inference instead of creating a third-party fact", () => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "person_fact",
      cardKind: "insight",
      epistemicStatus: "ai_inference",
      epistemicCaution: "reported_inference",
      subjectPersonConfirmed: true,
      existingPersonPathEligible: true,
      durability: 0.85
    }));

    expect(result.status).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "fact_epistemic_status_not_explicit",
      "person_fact_explicit_statement_required",
      "reported_inference_person_fact_forbidden"
    ]));
  });

  it.each([
    ["archived Card", { cardStatus: "archived" as const }, "card_not_saved"],
    ["unavailable source", { sourceAvailable: false }, "source_unavailable"],
    ["invalid canonical Evidence", { evidenceValid: false }, "canonical_evidence_invalid"]
  ])("rejects %s", (_name, overrides, reason) => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput(overrides));
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain(reason);
  });

  it("returns a structured confirmation requirement for sensitive content", () => {
    const pending = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      sensitivity: 0.8
    }));
    expect(pending).toMatchObject({
      status: "needs_confirmation",
      confirmationRequirements: [{
        code: "acknowledge_sensitive_content",
        resolution: "acknowledgement"
      }]
    });

    const confirmed = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      sensitivity: 0.8,
      acknowledgements: ["acknowledge_sensitive_content"]
    }));
    expect(confirmed.status).toBe("approved");
    expect(confirmed.reasons).toContain(
      "user_confirmation:acknowledge_sensitive_content"
    );
  });

  it("requires both a confirmed subject and the existing Person admission path", () => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "person_fact",
      cardKind: "insight",
      subjectPersonConfirmed: false,
      existingPersonPathEligible: false,
      durability: 0.85
    }));

    expect(result.status).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "subject_person_not_confirmed",
      "existing_person_path_required"
    ]));
  });

  it("requires acknowledgement before retaining a reported event as a derived decision", () => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "decision",
      cardKind: "decision",
      epistemicStatus: "reported_event"
    }));

    expect(result.status).toBe("needs_confirmation");
    expect(result.confirmationRequirements).toEqual([{
      code: "acknowledge_attribution_uncertainty",
      resolution: "acknowledgement"
    }]);
  });

  it("never uses durability or aggregate score as a post-selection veto", () => {
    const lowDurability = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "commitment",
      cardKind: "action",
      actionClaimed: true,
      importance: 1,
      durability: 0.69,
      novelty: 1,
      sensitivity: 0
    }));
    const lowScore = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      importance: 0.2,
      durability: 0.5,
      novelty: 0.1,
      sensitivity: 0.7
    }));

    expect(lowDurability.status).toBe("approved");
    expect(lowScore.status).toBe("approved");
    expect(lowScore.score).toBeLessThan(0.62);
  });

  it("does not let an acknowledgement replace verified ownership for facts", () => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "commitment",
      cardKind: "action",
      actionClaimed: true,
      verifiedOwnerAvailable: false,
      acknowledgements: ["acknowledge_attribution_uncertainty"]
    }));
    expect(result).toMatchObject({
      status: "needs_confirmation",
      confirmationRequirements: [{
        code: "verify_fact_owner",
        resolution: "verified_owner"
      }]
    });
  });

  it.each([
    ["resolved_or_generic_question", "question" as const, "question" as const],
    [
      "verified_identity_required_for_long_term_memory",
      "summary" as const,
      "insight" as const
    ]
  ])("does not let legacy soft reason %s veto an ordinary selected Card", (
    legacyReason,
    memoryType,
    cardKind
  ) => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType,
      cardKind,
      existingAdmissionEligible: false,
      existingAdmissionReasons: [legacyReason],
      importance: 0.3,
      durability: 0.2,
      novelty: 0.1
    }));
    expect(result.status).toBe("approved");
    expect(result.reasons).toContain(`legacy_signal:${legacyReason}`);
  });

  it("returns stable unique reasons regardless of existing reason order or duplicates", () => {
    const first = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      cardStatus: "archived",
      sourceAvailable: false,
      existingAdmissionEligible: false,
      existingAdmissionReasons: ["z_reason", "a_reason", "z_reason"]
    }));
    const second = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      cardStatus: "archived",
      sourceAvailable: false,
      existingAdmissionEligible: false,
      existingAdmissionReasons: ["a_reason", "z_reason"]
    }));

    expect(first).toEqual(second);
    expect(first.reasons).toEqual([
      "card_not_saved",
      "source_unavailable"
    ]);
    expect(new Set(first.reasons).size).toBe(first.reasons.length);
  });

  it("rejects unknown proposal types at the schema boundary", () => {
    expect(DailyReflectionMemoryProposalPolicyInputSchema.safeParse({
      ...policyInput(),
      memoryType: "topic"
    }).success).toBe(false);
  });
});
