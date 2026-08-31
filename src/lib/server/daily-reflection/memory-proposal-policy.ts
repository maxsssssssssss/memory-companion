import { z } from "zod";

import {
  DailyReflectionMemoryProposalAcknowledgementSchema,
  DailyReflectionMemoryProposalConfirmationRequirementSchema,
  DailyReflectionMemoryProposalEpistemicCautionSchema,
  DailyReflectionMemoryProposalTypeSchema
} from "@/lib/domain/daily-reflection-memory-proposal";
import {
  ReflectionCardEpistemicStatusSchema,
  ReflectionCardRiskFlagSchema
} from "@/lib/domain/daily-reflection";
import {
  DailyReflectionWorkingCardKindSchema,
  DailyReflectionWorkingCardStatusSchema
} from "@/lib/domain/daily-reflection-working-card";
import { roundedScore } from "@/lib/server/text-features";

export const DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION =
  "daily_reflection_memory_proposal_policy_v2" as const;

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
  riskFlags: z.array(ReflectionCardRiskFlagSchema).max(8),
  sourceAvailable: z.boolean(),
  evidenceValid: z.boolean(),
  subjectPersonConfirmed: z.boolean(),
  existingPersonPathEligible: z.boolean(),
  verifiedOwnerAvailable: z.boolean(),
  importance: z.number().min(0).max(1),
  durability: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  sensitivity: z.number().min(0).max(1),
  existingAdmissionEligible: z.boolean(),
  existingAdmissionReasons: z.array(StableReasonCodeSchema).max(32),
  acknowledgements: z.array(
    DailyReflectionMemoryProposalAcknowledgementSchema
  ).max(3)
}).strict().superRefine((input, context) => {
  if (new Set(input.riskFlags).size !== input.riskFlags.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["riskFlags"],
      message: "riskFlags must be unique"
    });
  }
  if (new Set(input.acknowledgements).size !== input.acknowledgements.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acknowledgements"],
      message: "acknowledgements must be unique"
    });
  }
});

export const DailyReflectionMemoryProposalPolicyResultSchema = z.object({
  status: z.enum(["approved", "needs_confirmation", "rejected"]),
  score: z.number().min(0).max(1),
  reasons: z.array(StableReasonCodeSchema).min(1).max(64),
  confirmationRequirements: z.array(
    DailyReflectionMemoryProposalConfirmationRequirementSchema
  ).max(4),
  policyVersion: z.literal(DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION)
}).strict().superRefine((result, context) => {
  if (new Set(result.reasons).size !== result.reasons.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasons"],
      message: "policy reasons must be unique"
    });
  }
  if ((result.status === "needs_confirmation") !== (result.confirmationRequirements.length > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confirmationRequirements"],
      message: "only needs_confirmation decisions may expose requirements"
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

const ORDINARY_USER_OWNED_TYPES = new Set<
  DailyReflectionMemoryProposalPolicyInput["memoryType"]
>(["summary", "question", "decision", "event"]);

export function dailyReflectionMemoryProposalScore(
  input: Pick<
    DailyReflectionMemoryProposalPolicyInput,
    "importance" | "durability" | "novelty" | "sensitivity"
  >
) {
  return roundedScore(
    input.importance * 0.35
    + input.durability * 0.4
    + input.novelty * 0.15
    + (1 - input.sensitivity) * 0.1
  );
}

function uniqueReasons(reasons: string[]) {
  return [...new Set(reasons)].sort();
}

type ConfirmationRequirement = z.infer<
  typeof DailyReflectionMemoryProposalConfirmationRequirementSchema
>;

function addRequirement(
  requirements: Map<ConfirmationRequirement["code"], ConfirmationRequirement>,
  requirement: ConfirmationRequirement
) {
  requirements.set(requirement.code, requirement);
}

function addCommonBoundaries(
  input: DailyReflectionMemoryProposalPolicyInput,
  hardRejections: string[],
  requirements: Map<ConfirmationRequirement["code"], ConfirmationRequirement>
) {
  if (input.cardStatus !== "saved") hardRejections.push("card_not_saved");
  if (!input.sourceAvailable) hardRejections.push("source_unavailable");
  if (!input.evidenceValid) hardRejections.push("canonical_evidence_invalid");
  if (input.sensitivity >= HIGH_SENSITIVITY_THRESHOLD) {
    addRequirement(requirements, {
      code: "acknowledge_sensitive_content",
      resolution: "acknowledgement"
    });
  }
  if (input.cardKind !== "action" && input.actionClaimed) {
    hardRejections.push("action_claim_invalid");
  }
  if (
    input.epistemicStatus === "ai_inference"
    || input.epistemicStatus === "unknown"
  ) {
    if (ORDINARY_USER_OWNED_TYPES.has(input.memoryType)) {
      addRequirement(requirements, {
        code: "acknowledge_inference",
        resolution: "acknowledgement"
      });
    } else {
      hardRejections.push("fact_epistemic_status_not_explicit");
    }
  }
  if (
    input.epistemicStatus === "reported_event"
    && input.memoryType !== "event"
  ) {
    if (ORDINARY_USER_OWNED_TYPES.has(input.memoryType)) {
      addRequirement(requirements, {
        code: "acknowledge_attribution_uncertainty",
        resolution: "acknowledgement"
      });
    } else {
      hardRejections.push("reported_event_semantic_upgrade_forbidden");
    }
  }
  if (input.epistemicCaution === "reported_inference") {
    if (ORDINARY_USER_OWNED_TYPES.has(input.memoryType)) {
      addRequirement(requirements, {
        code: "acknowledge_inference",
        resolution: "acknowledgement"
      });
    } else {
      hardRejections.push("reported_inference_fact_forbidden");
    }
  }
  if (input.riskFlags.includes("attribution_uncertain")) {
    addRequirement(requirements, {
      code: "acknowledge_attribution_uncertainty",
      resolution: "acknowledgement"
    });
  }
}

function addTypeBoundaries(
  input: DailyReflectionMemoryProposalPolicyInput,
  hardRejections: string[],
  requirements: Map<ConfirmationRequirement["code"], ConfirmationRequirement>
) {
  switch (input.memoryType) {
    case "summary":
      if (input.cardKind !== "insight" && input.cardKind !== "idea") {
        hardRejections.push("summary_card_kind_invalid");
      }
      break;
    case "question":
      if (input.cardKind !== "question") hardRejections.push("question_card_required");
      break;
    case "decision":
      if (input.cardKind !== "decision") hardRejections.push("decision_card_required");
      break;
    case "commitment":
      if (input.cardKind !== "action") hardRejections.push("action_card_required");
      if (!input.actionClaimed) hardRejections.push("action_not_claimed");
      if (input.epistemicStatus !== "explicit_user_statement") {
        hardRejections.push("commitment_explicit_statement_required");
      }
      if (!input.verifiedOwnerAvailable) {
        addRequirement(requirements, {
          code: "verify_fact_owner",
          resolution: "verified_owner"
        });
      }
      break;
    case "preference":
      if (input.cardKind !== "insight" && input.cardKind !== "idea") {
        hardRejections.push("preference_card_kind_invalid");
      }
      if (input.epistemicStatus !== "explicit_user_statement") {
        hardRejections.push("preference_explicit_statement_required");
      }
      if (!input.verifiedOwnerAvailable) {
        addRequirement(requirements, {
          code: "verify_fact_owner",
          resolution: "verified_owner"
        });
      }
      break;
    case "person_fact":
      if (input.cardKind !== "insight") {
        hardRejections.push("person_fact_card_kind_invalid");
      }
      if (input.epistemicStatus !== "explicit_user_statement") {
        hardRejections.push("person_fact_explicit_statement_required");
      }
      if (input.epistemicCaution === "reported_inference") {
        hardRejections.push("reported_inference_person_fact_forbidden");
      }
      if (!input.subjectPersonConfirmed) {
        hardRejections.push("subject_person_not_confirmed");
      }
      if (!input.existingPersonPathEligible) {
        hardRejections.push("existing_person_path_required");
      }
      break;
    case "event":
      if (input.cardKind !== "event") hardRejections.push("event_card_required");
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
  const score = dailyReflectionMemoryProposalScore(input);
  const hardRejections: string[] = [];
  const requirements = new Map<
    ConfirmationRequirement["code"],
    ConfirmationRequirement
  >();

  addCommonBoundaries(input, hardRejections, requirements);
  addTypeBoundaries(input, hardRejections, requirements);
  const rejectionReasons = uniqueReasons(hardRejections);
  if (rejectionReasons.length > 0) {
    return DailyReflectionMemoryProposalPolicyResultSchema.parse({
      status: "rejected",
      score,
      reasons: rejectionReasons,
      confirmationRequirements: [],
      policyVersion: DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
    });
  }

  const acknowledgementSet = new Set(input.acknowledgements);
  const unresolvedRequirements = [...requirements.values()]
    .filter((requirement) => {
      if (requirement.resolution !== "acknowledgement") return true;
      const acknowledgement = DailyReflectionMemoryProposalAcknowledgementSchema
        .safeParse(requirement.code);
      return !acknowledgement.success || !acknowledgementSet.has(acknowledgement.data);
    })
    .sort((left, right) => left.code.localeCompare(right.code));
  const softSignals = uniqueReasons(input.existingAdmissionReasons)
    .slice(0, 8)
    .map((reason) => `legacy_signal:${reason}`);
  if (unresolvedRequirements.length > 0) {
    return DailyReflectionMemoryProposalPolicyResultSchema.parse({
      status: "needs_confirmation",
      score,
      reasons: [
        ...unresolvedRequirements.map(
          (requirement) => `confirmation_required:${requirement.code}`
        ),
        ...softSignals
      ],
      confirmationRequirements: unresolvedRequirements,
      policyVersion: DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
    });
  }

  const usedAcknowledgements = [...requirements.values()]
    .filter((requirement) => requirement.resolution === "acknowledgement")
    .map((requirement) => `user_confirmation:${requirement.code}`);
  return DailyReflectionMemoryProposalPolicyResultSchema.parse({
    status: "approved",
    score,
    reasons: uniqueReasons([
      "user_selected_working_card",
      ...usedAcknowledgements,
      ...softSignals
    ]),
    confirmationRequirements: [],
    policyVersion: DAILY_REFLECTION_MEMORY_PROPOSAL_POLICY_VERSION
  });
}
