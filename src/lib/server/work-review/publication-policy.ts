import type {
  WorkAtomicClaim,
  WorkAtomicClaimType,
  WorkClaimPublicationAction,
  WorkClaimRiskLevel,
  WorkClaimSupportVerdict,
  WorkMeetingCandidateKind,
  WorkMeetingCandidateStructuredData,
  WorkVerifierClaimDraft
} from "@/lib/domain/work-review";
import { WORK_MEETING_PUBLICATION_POLICY_VERSION } from "./runtime-config";

export const WORK_MEETING_SEMANTIC_SAFETY_RULES = [
  "uploader != speaker",
  "speaker != real person identity",
  "speaker != owner",
  "mentioned person != responsible person",
  "proposal != decision",
  "tentative direction != final decision",
  "assignment != accepted commitment",
  "task mention != action item",
  "date mention != deadline",
  "silence != consensus",
  "no objection != agreement",
  "earlier plan != final plan",
  "meeting discussion != approval",
  "temporal order != causality"
] as const;

export const WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES = [
  "uploader_inferred_as_speaker",
  "speaker_identity_inferred",
  "speaker_inferred_as_owner",
  "mentioned_person_inferred_responsible",
  "proposal_promoted_to_decision",
  "tentative_promoted_to_final",
  "assignment_promoted_to_commitment",
  "task_mention_promoted_to_action",
  "date_mention_promoted_to_deadline",
  "silence_inferred_consensus",
  "no_objection_inferred_agreement",
  "earlier_plan_promoted_to_final",
  "discussion_promoted_to_approval",
  "temporal_order_inferred_causality"
] as const;

const SEMANTIC_SAFETY_ISSUE_CODES = new Set<string>(
  WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES
);

const ALLOWED_INTERNAL_ISSUE_CODES = new Set(["verifier_disabled"]);

const HIGH_RISK_CLAIMS = new Set<WorkAtomicClaimType>([
  "decision_finality",
  "speaker_attribution",
  "commitment_existence",
  "commitment_owner",
  "deadline",
  "action_item"
]);

const MEDIUM_RISK_CLAIMS = new Set<WorkAtomicClaimType>([
  "decision_existence",
  "question_resolution",
  "plan_change"
]);

const REQUIRED_CLAIMS: Record<WorkMeetingCandidateKind, WorkAtomicClaimType[]> = {
  discussion_topic: ["topic"],
  proposal: ["proposal"],
  decision: ["decision_existence"],
  commitment: ["commitment_existence"],
  open_question: ["open_question"],
  plan_change: ["plan_change"],
  action_item: ["action_item"]
};

export type WorkClaimPolicyDecision = {
  policyVersion: typeof WORK_MEETING_PUBLICATION_POLICY_VERSION;
  riskLevel: WorkClaimRiskLevel;
  publicationAction: WorkClaimPublicationAction;
  confirmationRequired: boolean;
  issueCodes: string[];
};

export type WorkCandidatePolicyDecision = {
  policyVersion: typeof WORK_MEETING_PUBLICATION_POLICY_VERSION;
  publicationAction: WorkClaimPublicationAction;
  confirmationRequired: boolean;
  reasonCodes: string[];
  structuredData: WorkMeetingCandidateStructuredData;
};

export function riskLevelForWorkClaimType(claimType: WorkAtomicClaimType): WorkClaimRiskLevel {
  if (HIGH_RISK_CLAIMS.has(claimType)) return "high";
  if (MEDIUM_RISK_CLAIMS.has(claimType)) return "medium";
  return "low";
}

function actionForVerdict(
  verdict: WorkClaimSupportVerdict,
  riskLevel: WorkClaimRiskLevel
): WorkClaimPublicationAction {
  if (verdict === "entailed") return "show_as_candidate";
  if (verdict === "contradicted" || verdict === "unsupported") return "suppress";
  if (verdict === "partially_entailed") {
    return riskLevel === "high" || riskLevel === "critical"
      ? "suppress"
      : "show_as_question";
  }
  return riskLevel === "low" ? "show_as_question" : "suppress";
}

export function evaluateWorkClaimPublication(input: {
  claimType: WorkAtomicClaimType;
  supportVerdict: WorkClaimSupportVerdict;
  issueCodes?: string[];
}): WorkClaimPolicyDecision {
  const riskLevel = riskLevelForWorkClaimType(input.claimType);
  const issueCodes = [...new Set(input.issueCodes ?? [])].sort();
  const violatesSemanticSafety = issueCodes.some((code) =>
    SEMANTIC_SAFETY_ISSUE_CODES.has(code)
  );
  const hasUnknownOrMissingVerifierResult = issueCodes.some((code) =>
    !SEMANTIC_SAFETY_ISSUE_CODES.has(code)
      && !ALLOWED_INTERNAL_ISSUE_CODES.has(code)
  );
  return {
    policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
    riskLevel,
    publicationAction: violatesSemanticSafety || hasUnknownOrMissingVerifierResult
      ? "suppress"
      : actionForVerdict(input.supportVerdict, riskLevel),
    // Every persisted meeting fact remains user-confirmed, even when entailed.
    confirmationRequired: true,
    issueCodes
  };
}

function combineActions(actions: WorkClaimPublicationAction[]) {
  if (actions.includes("suppress")) return "suppress" as const;
  if (actions.includes("show_as_question")) return "show_as_question" as const;
  return "show_as_candidate" as const;
}

function cloneStructuredData(
  input: WorkMeetingCandidateStructuredData
): WorkMeetingCandidateStructuredData {
  return {
    ...input,
    planStages: input.planStages.map((stage) => ({
      ...stage,
      evidenceRefs: stage.evidenceRefs.map((evidence) => ({ ...evidence }))
    }))
  };
}

export function evaluateWorkCandidatePublication(input: {
  kind: WorkMeetingCandidateKind;
  structuredData: WorkMeetingCandidateStructuredData;
  claims: WorkAtomicClaim[];
  evaluations: WorkVerifierClaimDraft[];
  verifierEnabled: boolean;
}): WorkCandidatePolicyDecision {
  const reasonCodes = new Set<string>();
  const evaluationByClaimId = new Map(input.evaluations.map((evaluation) => [
    evaluation.claimId,
    evaluation
  ]));
  if (evaluationByClaimId.size !== input.evaluations.length) {
    return {
      policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
      publicationAction: "suppress",
      confirmationRequired: true,
      reasonCodes: ["duplicate_claim_evaluation"],
      structuredData: cloneStructuredData(input.structuredData)
    };
  }
  const claimsByType = new Map<WorkAtomicClaimType, WorkAtomicClaim[]>();
  for (const claim of input.claims) {
    const group = claimsByType.get(claim.claimType) ?? [];
    group.push(claim);
    claimsByType.set(claim.claimType, group);
  }
  const actionByClaimId = new Map<string, WorkClaimPublicationAction>();
  for (const claim of input.claims) {
    const evaluation = evaluationByClaimId.get(claim.id);
    if (!evaluation) {
      reasonCodes.add(`claim_evaluation_missing:${claim.id}`);
      actionByClaimId.set(claim.id, "suppress");
      continue;
    }
    const decision = evaluateWorkClaimPublication({
      claimType: claim.claimType,
      supportVerdict: evaluation.supportVerdict,
      issueCodes: evaluation.issueCodes
    });
    actionByClaimId.set(claim.id, decision.publicationAction);
    if (decision.publicationAction !== "show_as_candidate") {
      reasonCodes.add(`claim_not_fully_supported:${claim.claimType}`);
    }
  }
  const highRiskCandidate = input.kind === "decision"
    || input.kind === "commitment"
    || input.kind === "action_item";
  if (!input.verifierEnabled && highRiskCandidate) {
    return {
      policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
      publicationAction: "suppress",
      confirmationRequired: true,
      reasonCodes: ["verifier_required_for_high_risk_candidate"],
      structuredData: cloneStructuredData(input.structuredData)
    };
  }

  const requiredActions: WorkClaimPublicationAction[] = [];
  for (const claimType of REQUIRED_CLAIMS[input.kind]) {
    const matchingClaims = claimsByType.get(claimType) ?? [];
    if (matchingClaims.length === 0) {
      requiredActions.push(input.verifierEnabled ? "suppress" : "show_as_question");
      reasonCodes.add(`required_claim_missing:${claimType}`);
      continue;
    }
    const actions = matchingClaims.map((claim) =>
      actionByClaimId.get(claim.id) ?? "suppress"
    );
    requiredActions.push(combineActions(actions));
  }

  const structuredData = cloneStructuredData(input.structuredData);
  const optionalClaimIsEntailed = (claimType: WorkAtomicClaimType) => {
    const claims = claimsByType.get(claimType) ?? [];
    return claims.length > 0 && claims.every((claim) =>
      evaluationByClaimId.get(claim.id)?.supportVerdict === "entailed"
      && actionByClaimId.get(claim.id) === "show_as_candidate"
    );
  };

  if (input.kind === "decision" && structuredData.decisionFinality === "final"
    && !optionalClaimIsEntailed("decision_finality")) {
    structuredData.decisionFinality = "unclear";
    reasonCodes.add("decision_finality_not_verified");
    requiredActions.push("show_as_question");
  }
  if (input.kind === "plan_change" && structuredData.planStages.length < 2) {
    reasonCodes.add("plan_change_stages_missing");
    requiredActions.push("suppress");
  } else if (input.kind === "plan_change") {
    const verifiedPlanEvidenceIds = new Set(
      (claimsByType.get("plan_change") ?? []).flatMap((claim) => {
        if (actionByClaimId.get(claim.id) !== "show_as_candidate") return [];
        return evaluationByClaimId.get(claim.id)?.supportedEvidenceIds ?? [];
      })
    );
    const stageEvidenceIds = structuredData.planStages.flatMap((stage) =>
      stage.evidenceRefs.map((evidence) => evidence.segmentId)
    );
    if (stageEvidenceIds.some((segmentId) => !verifiedPlanEvidenceIds.has(segmentId))) {
      reasonCodes.add("plan_change_stage_evidence_not_verified");
      requiredActions.push("suppress");
    }
  }
  if ((input.kind === "commitment" || input.kind === "action_item")
    && structuredData.candidateOwner !== null
    && !optionalClaimIsEntailed("commitment_owner")) {
    structuredData.candidateOwner = null;
    reasonCodes.add("candidate_owner_not_verified");
  }
  if (structuredData.dueAt !== null && !optionalClaimIsEntailed("deadline")) {
    structuredData.dueAt = null;
    structuredData.originalDueExpression = null;
    reasonCodes.add("deadline_not_verified");
  }
  if (input.kind === "action_item"
    && structuredData.actionBasis === "explicit_commitment"
    && !optionalClaimIsEntailed("commitment_existence")) {
    structuredData.actionBasis = "assignment_without_acceptance";
    structuredData.relatedCommitmentCandidateId = null;
    reasonCodes.add("explicit_commitment_basis_not_verified");
    requiredActions.push("show_as_question");
  }
  if (input.kind === "open_question" && optionalClaimIsEntailed("question_resolution")) {
    reasonCodes.add("question_resolved_later");
    requiredActions.push("suppress");
  }

  return {
    policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
    publicationAction: combineActions([
      ...requiredActions,
      ...input.claims.map((claim) => actionByClaimId.get(claim.id) ?? "suppress")
    ]),
    confirmationRequired: true,
    reasonCodes: [...reasonCodes].sort(),
    structuredData
  };
}
