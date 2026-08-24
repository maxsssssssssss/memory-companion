import { z } from "zod";

import {
  DailyReflectionMemoryProposalEpistemicCautionSchema,
  DailyReflectionMemoryProposalTypeSchema
} from "@/lib/domain/daily-reflection-memory-proposal";
import {
  ReflectionCardEpistemicStatusSchema
} from "@/lib/domain/daily-reflection";
import {
  DailyReflectionWorkingCardKindSchema,
  DailyReflectionWorkingCardStatusSchema
} from "@/lib/domain/daily-reflection-working-card";
import { roundedScore } from "@/lib/server/text-features";

export const DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION =
  "daily_reflection_memory_proposal_policy_v1" as const;

const StableReasonCodeSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_.:-]*$/u);

export const DailyReflectionMemoryProposalPolicyInputSchema = z.object({
  memoryType: DailyReflectionMemoryProposalTypeSchema,
  cardStatus: DailyReflectionWorkingCardStatusSchema,
  cardKind: DailyReflectionWorkingCardKindSchema,
  actionClaimed: z.boolean(),
  epistemicStatus: ReflectionCardEpistemicStatusSchema,
  epistemicCaution: DailyReflectionMemoryProposalEpistemicCautionSchema,
  sourceAvailable: z.boolean(),
  evidenceValid: z.boolean(),
  subjectPersonConfirmed: z.boolean(),
  existingPersonPathEligible: z.boolean(),
  importance: z.number().min(0).max(1),
  durability: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  sensitivity: z.number().min(0).max(1),
  existingAdmissionEligible: z.boolean(),
  existingAdmissionReasons: z.array(StableReasonCodeSchema).max(32)
}).strict();

export const DailyReflectionMemoryProposalPolicyResultSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  score: z.number().min(0).max(1),
  reasons: z.array(StableReasonCodeSchema).min(1).max(64),
  policyVersion: z.literal(DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION)
}).strict().superRefine((result, context) => {
  if (new Set(result.reasons).size !== result.reasons.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasons"],
      message: "policy reasons must be unique"
    });
  }
});

export type DailyReflectionMemoryProposalPolicyInput = z.infer<
  typeof DailyReflectionMemoryProposalPolicyInputSchema
>;
export type DailyReflectionMemoryProposalPolicyResult = z.infer<
  typeof DailyReflectionMemoryProposalPolicyResultSchema
>;

const HIGH_SENSITIVITY_THRESHOLD = 0.8;

const SCORE_THRESHOLDS: Record<
  DailyReflectionMemoryProposalPolicyInput["memoryType"],
  number
> = {
  decision: 0.62,
  commitment: 0.68,
  preference: 0.67,
  person_fact: 0.7,
  event: 0.58
};

function proposalScore(input: DailyReflectionMemoryProposalPolicyInput) {
  return roundedScore(
    input.importance * 0.35
    + input.durability * 0.4
    + input.novelty * 0.15
    + (1 - input.sensitivity) * 0.1
  );
}

function uniqueReasons(reasons: string[]) {
  return [...new Set(reasons)];
}

function addCommonRejections(
  input: DailyReflectionMemoryProposalPolicyInput,
  reasons: string[]
) {
  if (input.cardStatus !== "saved") reasons.push("card_not_saved");
  if (!input.sourceAvailable) reasons.push("source_unavailable");
  if (!input.evidenceValid) reasons.push("canonical_evidence_invalid");
  if (input.sensitivity >= HIGH_SENSITIVITY_THRESHOLD) {
    reasons.push("high_sensitivity");
  }
  if (input.cardKind !== "action" && input.actionClaimed) {
    reasons.push("action_claim_invalid");
  }
  if (
    input.epistemicStatus === "ai_inference"
    || input.epistemicStatus === "unknown"
  ) {
    reasons.push("epistemic_status_not_durable");
  }
  if (
    input.epistemicStatus === "reported_event"
    && input.memoryType !== "event"
  ) {
    reasons.push("reported_event_semantic_upgrade_forbidden");
  }
  if (!input.existingAdmissionEligible) {
    reasons.push("existing_admission_rejected");
    for (const reason of [...new Set(input.existingAdmissionReasons)].sort()) {
      reasons.push(`existing_admission:${reason}`);
    }
  }
}

function addTypeRejections(
  input: DailyReflectionMemoryProposalPolicyInput,
  reasons: string[]
) {
  switch (input.memoryType) {
    case "decision":
      if (input.cardKind !== "decision") reasons.push("decision_card_required");
      if (input.epistemicStatus !== "explicit_user_statement") {
        reasons.push("decision_explicit_statement_required");
      }
      break;
    case "commitment":
      if (input.cardKind !== "action") reasons.push("action_card_required");
      if (!input.actionClaimed) reasons.push("action_not_claimed");
      if (input.epistemicStatus !== "explicit_user_statement") {
        reasons.push("commitment_explicit_statement_required");
      }
      if (input.durability < 0.7) {
        reasons.push("commitment_durability_below_threshold");
      }
      break;
    case "preference":
      if (input.cardKind !== "insight" && input.cardKind !== "idea") {
        reasons.push("preference_card_kind_invalid");
      }
      if (input.epistemicStatus !== "explicit_user_statement") {
        reasons.push("preference_explicit_statement_required");
      }
      if (input.durability < 0.7) {
        reasons.push("preference_durability_below_threshold");
      }
      break;
    case "person_fact":
      if (input.cardKind !== "insight") {
        reasons.push("person_fact_card_kind_invalid");
      }
      if (input.epistemicStatus !== "explicit_user_statement") {
        reasons.push("person_fact_explicit_statement_required");
      }
      if (input.epistemicCaution === "reported_inference") {
        reasons.push("reported_inference_person_fact_forbidden");
      }
      if (!input.subjectPersonConfirmed) {
        reasons.push("subject_person_not_confirmed");
      }
      if (!input.existingPersonPathEligible) {
        reasons.push("existing_person_path_required");
      }
      if (input.durability < 0.75) {
        reasons.push("person_fact_durability_below_threshold");
      }
      break;
    case "event":
      if (input.cardKind !== "event") reasons.push("event_card_required");
      break;
  }
}

/**
 * Evaluates a frozen, user-created Working Card proposal. The caller remains
 * responsible for parsing the returned result and for invoking the existing
 * Memory/Person admission paths; this policy cannot bypass either path.
 */
export function evaluateDailyReflectionMemoryProposalPolicy(
  rawInput: DailyReflectionMemoryProposalPolicyInput
): DailyReflectionMemoryProposalPolicyResult {
  const input = DailyReflectionMemoryProposalPolicyInputSchema.parse(rawInput);
  const score = proposalScore(input);
  const reasons: string[] = [];

  addCommonRejections(input, reasons);
  addTypeRejections(input, reasons);
  if (score < SCORE_THRESHOLDS[input.memoryType]) {
    reasons.push(`${input.memoryType}_score_below_threshold`);
  }

  const rejectionReasons = uniqueReasons(reasons);
  return DailyReflectionMemoryProposalPolicyResultSchema.parse({
    status: rejectionReasons.length === 0 ? "approved" : "rejected",
    score,
    reasons: rejectionReasons.length === 0
      ? ["policy_threshold_met"]
      : rejectionReasons,
    policyVersion: DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
  });
}
