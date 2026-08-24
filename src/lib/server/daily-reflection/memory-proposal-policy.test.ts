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
    sourceAvailable: true,
    evidenceValid: true,
    subjectPersonConfirmed: false,
    existingPersonPathEligible: false,
    importance: 0.8,
    durability: 0.8,
    novelty: 0.6,
    sensitivity: 0.1,
    existingAdmissionEligible: true,
    existingAdmissionReasons: ["specific_summary"],
    ...overrides
  };
}

describe("Daily Reflection Memory proposal policy v1", () => {
  it.each([
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
      reasons: ["policy_threshold_met"],
      policyVersion: DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
    });
  });

  it("rejects an occasional coffee choice when existing admission identifies it as one-time", () => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "preference",
      cardKind: "insight",
      existingAdmissionEligible: false,
      existingAdmissionReasons: ["one_time_or_ambiguous_choice"]
    }));

    expect(result.status).toBe("rejected");
    expect(result.reasons).toEqual([
      "existing_admission_rejected",
      "existing_admission:one_time_or_ambiguous_choice"
    ]);
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
      "epistemic_status_not_durable",
      "person_fact_explicit_statement_required",
      "reported_inference_person_fact_forbidden"
    ]));
  });

  it.each([
    ["archived Card", { cardStatus: "archived" as const }, "card_not_saved"],
    ["unavailable source", { sourceAvailable: false }, "source_unavailable"],
    ["invalid canonical Evidence", { evidenceValid: false }, "canonical_evidence_invalid"],
    ["high sensitivity", { sensitivity: 0.8 }, "high_sensitivity"]
  ])("rejects %s", (_name, overrides, reason) => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput(overrides));
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain(reason);
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

  it("does not upgrade a reported event into a decision", () => {
    const result = evaluateDailyReflectionMemoryProposalPolicy(policyInput({
      memoryType: "decision",
      cardKind: "decision",
      epistemicStatus: "reported_event"
    }));

    expect(result.status).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "reported_event_semantic_upgrade_forbidden",
      "decision_explicit_statement_required"
    ]));
  });

  it("uses durability and the metric score as independent type gates", () => {
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

    expect(lowDurability.reasons).toContain("commitment_durability_below_threshold");
    expect(lowScore.reasons).toContain("decision_score_below_threshold");
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
      "source_unavailable",
      "existing_admission_rejected",
      "existing_admission:a_reason",
      "existing_admission:z_reason"
    ]);
    expect(new Set(first.reasons).size).toBe(first.reasons.length);
  });

  it("rejects unknown proposal types at the schema boundary", () => {
    expect(DailyReflectionMemoryProposalPolicyInputSchema.safeParse({
      ...policyInput(),
      memoryType: "summary"
    }).success).toBe(false);
  });
});
