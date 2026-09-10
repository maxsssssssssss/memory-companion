import type {
  WorkAtomicClaim,
  WorkAtomicClaimType,
  WorkClaimPublicationAction,
  WorkClaimRiskLevel,
  WorkClaimSemanticValue,
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
  "temporal_order_inferred_causality",
  "independent_items_conflated",
  "core_meaning_changed"
] as const;

const SEMANTIC_SAFETY_ISSUE_CODES = new Set<string>(
  WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES
);

export const WORK_MEETING_NON_GPT_ISSUE_CODE = "verifier_not_required_non_high_risk";
// A positively verified, explicitly uncertain quotation remains reviewable;
// this never rescues unsupported or contradicted core meaning.
export const WORK_MEETING_CANONICAL_WORDING_UNCLEAR = "canonical_wording_unclear";
export const WORK_MEETING_NON_GPT_PROFILE = "not_invoked_non_high_risk";
export const WORK_MEETING_CAUSALITY_ROUTING_ISSUE_CODE = "gpt_verifier_routed_causality";
export const WORK_MEETING_SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PREFIX =
  "gpt_verifier_input_semantic_value_sha256_";

const ALLOWED_INTERNAL_ISSUE_CODES = new Set([
  "verifier_disabled",
  WORK_MEETING_NON_GPT_ISSUE_CODE,
  WORK_MEETING_CAUSALITY_ROUTING_ISSUE_CODE
]);
const SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PATTERN = new RegExp(
  `^${WORK_MEETING_SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PREFIX}[0-9a-f]{64}$`,
  "u"
);

function isAllowedInternalIssueCode(code: string) {
  return ALLOWED_INTERNAL_ISSUE_CODES.has(code)
    || SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PATTERN.test(code);
}

const HIGH_RISK_CLAIMS = new Set<WorkAtomicClaimType>([
  "decision_existence",
  "decision_finality",
  "speaker_attribution",
  "commitment_existence",
  "commitment_owner",
  "deadline",
  "plan_change",
  "action_item"
]);

const MEDIUM_RISK_CLAIMS = new Set<WorkAtomicClaimType>([
  "question_resolution"
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
  displayClaimIds: string[];
  displayNotes: string[];
};

export type WorkClaimGptVerificationReason =
  | "decision"
  | "commitment"
  | "action_item"
  | "plan_change"
  | "question_resolution"
  | "causality";

export function workClaimGptVerificationReasons(
  claim: Pick<WorkAtomicClaim, "claimType" | "semanticRiskFlags">
): WorkClaimGptVerificationReason[] {
  const reasons: WorkClaimGptVerificationReason[] = [];
  if (claim.claimType === "decision_existence") {
    reasons.push("decision");
  } else if (claim.claimType === "commitment_existence") {
    reasons.push("commitment");
  } else if (claim.claimType === "action_item") {
    reasons.push("action_item");
  } else if (claim.claimType === "plan_change") {
    reasons.push("plan_change");
  } else if (claim.claimType === "question_resolution") {
    reasons.push("question_resolution");
  }
  if (claim.semanticRiskFlags?.includes("causality")) reasons.push("causality");
  return reasons;
}

export function requiresWorkClaimGptVerification(
  claim: Pick<WorkAtomicClaim, "claimType" | "semanticRiskFlags">
) {
  return workClaimGptVerificationReasons(claim).length > 0;
}

export function riskLevelForWorkClaimType(claimType: WorkAtomicClaimType): WorkClaimRiskLevel {
  if (HIGH_RISK_CLAIMS.has(claimType)) return "high";
  if (MEDIUM_RISK_CLAIMS.has(claimType)) return "medium";
  return "low";
}

export function riskLevelForWorkClaim(
  claim: Pick<WorkAtomicClaim, "claimType" | "semanticRiskFlags">
): WorkClaimRiskLevel {
  return requiresWorkClaimGptVerification(claim)
    ? "high"
    : riskLevelForWorkClaimType(claim.claimType);
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
  semanticRiskFlags?: WorkAtomicClaim["semanticRiskFlags"];
  supportVerdict: WorkClaimSupportVerdict;
  issueCodes?: string[];
}): WorkClaimPolicyDecision {
  const claim = {
    claimType: input.claimType,
    semanticRiskFlags: input.semanticRiskFlags
  };
  const riskLevel = riskLevelForWorkClaim(claim);
  const issueCodes = [...new Set(input.issueCodes ?? [])].sort();
  const nonGptPath = issueCodes.includes(WORK_MEETING_NON_GPT_ISSUE_CODE);
  const violatesSemanticSafety = issueCodes.some((code) =>
    SEMANTIC_SAFETY_ISSUE_CODES.has(code)
  );
  const hasUnknownOrMissingVerifierResult = issueCodes.some((code) =>
    !SEMANTIC_SAFETY_ISSUE_CODES.has(code)
      && code !== WORK_MEETING_CANONICAL_WORDING_UNCLEAR
      && !isAllowedInternalIssueCode(code)
  );
  const invalidNonGptPath = nonGptPath
    && (requiresWorkClaimGptVerification(claim) || input.supportVerdict !== "unverifiable");
  return {
    policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
    riskLevel,
    publicationAction: violatesSemanticSafety
      || hasUnknownOrMissingVerifierResult
      || invalidNonGptPath
      ? "suppress"
      : issueCodes.includes(WORK_MEETING_CANONICAL_WORDING_UNCLEAR)
        ? input.supportVerdict === "entailed" && !nonGptPath ? "show_as_question" : "suppress"
      : nonGptPath
        ? "show_as_question"
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

// Copy a temporal expression from this deadline's own Canonical Evidence.
// This does not resolve a calendar date or establish that it is a deadline.
// In particular, 日 and 号 are equivalent for matching, but we return the
// original source spelling. Ambiguous expressions remain empty for review.
export function pendingDeadlineExpression(input: {
  claims: WorkAtomicClaim[];
  segments: readonly { id: string; text: string }[];
  original: string | null;
}): string | null {
  const number = "[0-9〇零一二三四五六七八九十两]";
  const date = `(?:${number}{2,4}年\\s*)?${number}{1,3}月\\s*${number}{1,3}[日号]`;
  const relative = "(?:(?:本|这|下|上)(?:个)?)?(?:周|星期|礼拜)[一二三四五六日天]|今天|明天|后天|月底|月末";
  const time = `(?:\\s*(?:上午|下午|晚上|中午|凌晨|早上|下班)?\\s*(?:${number}{1,3}(?:点|时)(?:半|${number}{1,3}分?)?|[0-9]{1,2}[:：][0-9]{2})?)?`;
  const pattern = new RegExp(`(?:${date}|${relative})${time}(?:之前|以前|前|之后|以后|后|当天)?`, "gu");
  const equivalent = (text: string) => text.replace(/\s+/gu, "").replace(/号/gu, "日");
  const sourceById = new Map(input.segments.map((segment) => [segment.id, segment.text]));
  const expressions: string[] = [];
  for (const claim of input.claims) {
    const sources = claim.evidenceIds.flatMap((id) => {
      const text = sourceById.get(id);
      return text === undefined ? [] : [text];
    });
    const found = [...new Set(sources.flatMap((text) =>
      [...text.matchAll(pattern)].map((match) => match[0].trim())
    ))];
    const requested = input.original ?? claim.text;
    const matching = found.filter((expression) =>
      equivalent(requested).includes(equivalent(expression))
      || (input.original !== null && equivalent(expression).includes(equivalent(input.original)))
    );
    // Preserve other explicit formats (e.g. ISO or English) only by literal
    // source copy; never turn model prose or another Claim's Evidence into it.
    if (input.original && sources.some((text) => text.includes(input.original!))
      && (matching.length === 0 || matching.every((expression) =>
        equivalent(input.original!).includes(equivalent(expression))))) {
      expressions.push(input.original);
      continue;
    }
    const selected = matching.length > 0 ? matching : found;
    if (new Set(selected.map(equivalent)).size === 1) {
      expressions.push(selected[0]);
    } else {
      return null;
    }
  }
  return new Set(expressions.map(equivalent)).size === 1 ? expressions[0] : null;
}

export function evaluateWorkCandidatePublication(input: {
  kind: WorkMeetingCandidateKind;
  structuredData: WorkMeetingCandidateStructuredData;
  claims: WorkAtomicClaim[];
  evaluations: WorkVerifierClaimDraft[];
  verifierEnabled: boolean;
  canonicalSegments?: readonly { id: string; text: string }[];
}): WorkCandidatePolicyDecision {
  const reasonCodes = new Set<string>();
  const claimIds = new Set(input.claims.map((claim) => claim.id));
  if (input.evaluations.some((evaluation) => !claimIds.has(evaluation.claimId))) {
    return {
      policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
      publicationAction: "suppress",
      confirmationRequired: true,
      reasonCodes: ["unknown_claim_evaluation"],
      structuredData: cloneStructuredData(input.structuredData),
      displayClaimIds: [],
      displayNotes: []
    };
  }
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
      structuredData: cloneStructuredData(input.structuredData),
      displayClaimIds: [],
      displayNotes: []
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
      semanticRiskFlags: claim.semanticRiskFlags,
      supportVerdict: evaluation.supportVerdict,
      issueCodes: evaluation.issueCodes
    });
    actionByClaimId.set(claim.id, decision.publicationAction);
    if (decision.publicationAction !== "show_as_candidate") {
      reasonCodes.add(`claim_not_fully_supported:${claim.claimType}`);
    }
  }
  // Failure to establish an optional resolution must leave the question open,
  // including when the Verifier is disabled.
  const hasGptRequiredClaim = input.claims.some((claim) =>
    claim.claimType !== "question_resolution" && requiresWorkClaimGptVerification(claim)
  );
  const highRiskCandidateKind = input.kind === "decision"
    || input.kind === "commitment"
    || input.kind === "action_item"
    || input.kind === "plan_change";
  if (!input.verifierEnabled && (hasGptRequiredClaim || highRiskCandidateKind)) {
    return {
      policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
      publicationAction: "suppress",
      confirmationRequired: true,
      reasonCodes: ["verifier_required_for_high_risk_candidate"],
      structuredData: cloneStructuredData(input.structuredData),
      displayClaimIds: [],
      displayNotes: []
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
  const displayNotes = new Set<string>();
  if (input.claims.some(claim => evaluationByClaimId.get(claim.id)?.issueCodes.includes(WORK_MEETING_CANONICAL_WORDING_UNCLEAR)
    && actionByClaimId.get(claim.id) === "show_as_question")) {
    displayNotes.add("原文关键表述含糊，条件或状态待确认");
    reasonCodes.add(WORK_MEETING_CANONICAL_WORDING_UNCLEAR);
  }
  const optionalClaimIsEntailed = (claimType: WorkAtomicClaimType) => {
    const claims = claimsByType.get(claimType) ?? [];
    return claims.length > 0 && claims.every((claim) =>
      evaluationByClaimId.get(claim.id)?.supportVerdict === "entailed"
      && actionByClaimId.get(claim.id) === "show_as_candidate"
    );
  };
  const semanticValuesEqual = (
    left: WorkClaimSemanticValue,
    right: WorkClaimSemanticValue
  ) => {
    if (left.kind !== right.kind) return false;
    if (left.kind === "deadline" && right.kind === "deadline") {
      return left.dueAt === right.dueAt
        && left.originalDueExpression === right.originalDueExpression;
    }
    if (left.kind === "decision_finality" && right.kind === "decision_finality") {
      return left.value === right.value;
    }
    if (left.kind === "speaker_attribution" && right.kind === "speaker_attribution") {
      return left.value === right.value;
    }
    return left.kind === "commitment_owner"
      && right.kind === "commitment_owner"
      && left.value === right.value;
  };
  const optionalSemanticValueStatus = (
    claimType: WorkAtomicClaimType,
    expected: WorkClaimSemanticValue
  ) => {
    const typedClaims = (claimsByType.get(claimType) ?? []).filter((claim) =>
      claim.semanticValue !== undefined && claim.semanticValue !== null
    );
    const matchingClaims = typedClaims.filter((claim) =>
      semanticValuesEqual(claim.semanticValue!, expected)
    );
    if (matchingClaims.length === 0 || typedClaims.length !== matchingClaims.length) {
      return "rejected" as const;
    }
    let pending = false;
    for (const claim of matchingClaims) {
      const evaluation = evaluationByClaimId.get(claim.id);
      if (!evaluation) {
        pending = true;
        continue;
      }
      const hasUnsafeIssue = evaluation.issueCodes.some((code) =>
        SEMANTIC_SAFETY_ISSUE_CODES.has(code) || !isAllowedInternalIssueCode(code)
      );
      if (
        hasUnsafeIssue
        || evaluation.supportVerdict === "unsupported"
        || evaluation.supportVerdict === "contradicted"
      ) {
        return "rejected" as const;
      }
      if (
        evaluation.supportVerdict !== "entailed"
        || actionByClaimId.get(claim.id) !== "show_as_candidate"
      ) {
        pending = true;
      }
    }
    return pending ? "pending" as const : "confirmed" as const;
  };

  if (input.kind !== "decision" && structuredData.decisionFinality !== null) {
    structuredData.decisionFinality = null;
    reasonCodes.add("decision_finality_not_applicable");
  } else if (input.kind === "decision"
    && structuredData.decisionFinality !== null) {
    const status = optionalSemanticValueStatus(
      "decision_finality",
      { kind: "decision_finality", value: structuredData.decisionFinality }
    );
    if (status === "rejected") {
      structuredData.decisionFinality = "unclear";
      reasonCodes.add("decision_finality_not_supported");
      displayNotes.add("决定是否最终待确认");
    } else if (status === "pending") {
      reasonCodes.add("decision_finality_pending_confirmation");
      displayNotes.add("决定是否最终待确认");
    }
  }
  if (input.kind !== "plan_change" && structuredData.planStages.length > 0) {
    structuredData.planStages = [];
    reasonCodes.add("plan_change_stages_not_applicable");
  } else if (input.kind === "plan_change" && (
    structuredData.planStages.length < 2
    || new Set(structuredData.planStages.map((stage) =>
      [
        stage.status,
        stage.content.trim().replace(/\s+/gu, " ").toLocaleLowerCase()
      ].join("\u0000")
    )).size < 2
  )) {
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
  if (structuredData.rawActorLabel !== null) {
    const status = optionalSemanticValueStatus(
      "speaker_attribution",
      { kind: "speaker_attribution", value: structuredData.rawActorLabel }
    );
    if (status === "rejected") {
      structuredData.rawActorLabel = null;
      reasonCodes.add("raw_actor_not_supported");
      displayNotes.add("发言归属待确认");
    } else if (status === "pending") {
      reasonCodes.add("raw_actor_pending_confirmation");
      displayNotes.add("发言归属待确认");
    }
  }
  if (structuredData.candidateOwner !== null) {
    const status = optionalSemanticValueStatus(
      "commitment_owner",
      { kind: "commitment_owner", value: structuredData.candidateOwner }
    );
    if (status === "rejected") {
      structuredData.candidateOwner = null;
      reasonCodes.add("candidate_owner_not_supported");
      displayNotes.add("负责人待确认");
    } else if (status === "pending") {
      reasonCodes.add("candidate_owner_pending_confirmation");
      displayNotes.add("负责人待确认");
    }
  }
  if (structuredData.dueAt !== null || structuredData.originalDueExpression !== null) {
    const status = optionalSemanticValueStatus("deadline", {
      kind: "deadline",
      dueAt: structuredData.dueAt,
      originalDueExpression: structuredData.originalDueExpression
    });
    if (status === "rejected") {
      structuredData.dueAt = null;
      structuredData.originalDueExpression = null;
      reasonCodes.add("deadline_not_supported");
      displayNotes.add("截止时间待确认");
    } else if (status === "pending") {
      // Non-GPT metadata has no verified absolute instant. A syntactically
      // valid ISO string is not evidence for a year, midnight, or timezone.
      structuredData.dueAt = null;
      structuredData.originalDueExpression = pendingDeadlineExpression({
        claims: claimsByType.get("deadline") ?? [],
        segments: input.canonicalSegments ?? [],
        original: structuredData.originalDueExpression
      });
      reasonCodes.add("deadline_pending_confirmation");
      displayNotes.add("截止时间待确认");
    }
  }
  if (input.kind !== "commitment" && input.kind !== "action_item"
    && structuredData.actionBasis !== null) {
    structuredData.actionBasis = null;
    structuredData.relatedCommitmentCandidateId = null;
    reasonCodes.add("action_basis_not_applicable");
  } else if (structuredData.actionBasis === "explicit_commitment"
    && !optionalClaimIsEntailed("commitment_existence")) {
    structuredData.actionBasis = input.kind === "action_item"
      ? "assignment_without_acceptance"
      : null;
    structuredData.relatedCommitmentCandidateId = null;
    reasonCodes.add("explicit_commitment_basis_not_verified");
    displayNotes.add("是否形成承诺待确认");
    requiredActions.push("show_as_question");
  }
  if (structuredData.relatedCommitmentCandidateId !== null) {
    structuredData.relatedCommitmentCandidateId = null;
    reasonCodes.add(input.kind === "action_item"
      ? "related_commitment_not_claim_bound"
      : "related_commitment_not_applicable");
  }
  const questionEvidence = new Set((claimsByType.get("open_question") ?? [])
    .flatMap((claim) => claim.evidenceIds));
  const resolutionHasBothEvidenceSides = (claimsByType.get("question_resolution") ?? [])
    .some((claim) => {
      const supported = evaluationByClaimId.get(claim.id)?.supportedEvidenceIds ?? [];
      return supported.some((id) => questionEvidence.has(id))
        && supported.some((id) => !questionEvidence.has(id));
    });
  if (input.kind === "open_question" && optionalClaimIsEntailed("question_resolution")
    && resolutionHasBothEvidenceSides) {
    reasonCodes.add("question_resolved_later");
    requiredActions.push("suppress");
  }

  const requiredClaimTypes = new Set(REQUIRED_CLAIMS[input.kind]);
  const displayClaimIds = input.claims.flatMap((claim) => {
    const action = actionByClaimId.get(claim.id) ?? "suppress";
    if (action === "suppress") return [];
    return requiredClaimTypes.has(claim.claimType) || action === "show_as_candidate"
      ? [claim.id]
      : [];
  });

  return {
    policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
    // Optional attribute Claims are fail-closed independently. Only the core
    // Claim(s) and explicit structural safety gates control Candidate
    // visibility; an unsupported owner/date/finality is removed above and
    // represented as a deterministic confirmation note instead of deleting a
    // separately supported meeting outcome.
    publicationAction: combineActions(requiredActions),
    confirmationRequired: true,
    reasonCodes: [...reasonCodes].sort(),
    structuredData,
    displayClaimIds,
    displayNotes: [...displayNotes]
  };
}
