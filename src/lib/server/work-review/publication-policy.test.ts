import { describe, expect, it } from "vitest";

import {
  WorkAtomicClaimSchema,
  WorkMeetingCandidateStructuredDataSchema,
  type WorkAtomicClaim,
  type WorkVerifierClaimDraft
} from "@/lib/domain/work-review";
import {
  evaluateWorkCandidatePublication,
  evaluateWorkClaimPublication,
  WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES,
  WORK_MEETING_SEMANTIC_SAFETY_RULES
} from "./publication-policy";

function claim(
  id: string,
  claimType: WorkAtomicClaim["claimType"]
): WorkAtomicClaim {
  return WorkAtomicClaimSchema.parse({
    id,
    candidateId: "candidate_1",
    claimType,
    text: `${claimType} claim`,
    evidenceIds: ["segment_1"],
    createdAt: null
  });
}

function evaluation(
  claimId: string,
  supportVerdict: WorkVerifierClaimDraft["supportVerdict"] = "entailed"
): WorkVerifierClaimDraft {
  return {
    claimId,
    supportVerdict,
    issueCodes: [],
    supportedEvidenceIds: supportVerdict === "entailed" || supportVerdict === "partially_entailed"
      ? ["segment_1"]
      : []
  };
}

describe("Work Meeting publication policy", () => {
  it("keeps verdict and user confirmation separate", () => {
    expect(evaluateWorkClaimPublication({
      claimType: "decision_finality",
      supportVerdict: "entailed"
    })).toMatchObject({
      riskLevel: "high",
      publicationAction: "show_as_candidate",
      confirmationRequired: true
    });
  });

  it("suppresses unsupported, contradicted, and unverifiable high-risk claims", () => {
    for (const verdict of ["unsupported", "contradicted", "unverifiable"] as const) {
      expect(evaluateWorkClaimPublication({
        claimType: "commitment_owner",
        supportVerdict: verdict
      }).publicationAction).toBe("suppress");
    }
    expect(evaluateWorkClaimPublication({
      claimType: "proposal",
      supportVerdict: "unverifiable"
    }).publicationAction).toBe("show_as_question");
  });

  it("deterministically suppresses every frozen semantic-safety violation", () => {
    expect(WORK_MEETING_SEMANTIC_SAFETY_RULES).toHaveLength(14);
    expect(WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES).toHaveLength(14);
    for (const issueCode of WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES) {
      expect(evaluateWorkClaimPublication({
        claimType: "topic",
        supportVerdict: "entailed",
        issueCodes: [issueCode]
      }).publicationAction).toBe("suppress");
    }
  });

  it("fails closed for an unknown or missing verifier issue code", () => {
    for (const issueCode of ["provider_invented_code", "verifier_result_missing"]) {
      expect(evaluateWorkClaimPublication({
        claimType: "topic",
        supportVerdict: "entailed",
        issueCodes: [issueCode]
      }).publicationAction).toBe("suppress");
    }
    expect(evaluateWorkClaimPublication({
      claimType: "topic",
      supportVerdict: "unverifiable",
      issueCodes: ["verifier_disabled"]
    }).publicationAction).toBe("show_as_question");
  });

  it("does not expose high-risk candidates when verifier is disabled", () => {
    const decision = evaluateWorkCandidatePublication({
      kind: "decision",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        decisionFinality: "final"
      }),
      claims: [claim("claim_decision", "decision_existence")],
      evaluations: [],
      verifierEnabled: false
    });
    expect(decision).toMatchObject({
      publicationAction: "suppress",
      reasonCodes: ["verifier_required_for_high_risk_candidate"]
    });
  });

  it("cannot hide an unsupported high-risk claim inside a low-risk candidate", () => {
    const claims = [
      claim("claim_topic", "topic"),
      claim("claim_owner", "commitment_owner")
    ];
    const candidate = evaluateWorkCandidatePublication({
      kind: "discussion_topic",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}),
      claims,
      evaluations: [
        evaluation("claim_topic"),
        evaluation("claim_owner", "unsupported")
      ],
      verifierEnabled: true
    });
    expect(candidate.publicationAction).toBe("suppress");
    expect(candidate.reasonCodes).toContain("claim_not_fully_supported:commitment_owner");
  });

  it("treats semantic-safety issue codes as unsafe even when the verdict says entailed", () => {
    const claims = [
      claim("claim_commitment", "commitment_existence"),
      claim("claim_owner", "commitment_owner")
    ];
    const candidate = evaluateWorkCandidatePublication({
      kind: "commitment",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        rawActorLabel: "Speaker 2",
        candidateOwner: "Alex"
      }),
      claims,
      evaluations: [
        evaluation("claim_commitment"),
        {
          ...evaluation("claim_owner"),
          issueCodes: ["mentioned_person_inferred_responsible"]
        }
      ],
      verifierEnabled: true
    });
    expect(candidate.publicationAction).toBe("suppress");
    expect(candidate.structuredData.candidateOwner).toBeNull();
  });

  it("downgrades unverified finality and suppresses the high-risk candidate", () => {
    const claims = [
      claim("claim_exists", "decision_existence"),
      claim("claim_final", "decision_finality")
    ];
    const decision = evaluateWorkCandidatePublication({
      kind: "decision",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        decisionFinality: "final"
      }),
      claims,
      evaluations: [
        evaluation("claim_exists"),
        evaluation("claim_final", "partially_entailed")
      ],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("suppress");
    expect(decision.structuredData.decisionFinality).toBe("unclear");
    expect(decision.reasonCodes).toContain("decision_finality_not_verified");
  });

  it("clears unverified owner and deadline fields and suppresses the candidate", () => {
    const claims = [
      claim("claim_commitment", "commitment_existence"),
      claim("claim_owner", "commitment_owner"),
      claim("claim_deadline", "deadline")
    ];
    const decision = evaluateWorkCandidatePublication({
      kind: "commitment",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        rawActorLabel: "Speaker 2",
        candidateOwner: "Alex",
        dueAt: "2026-09-04T00:00:00.000Z",
        originalDueExpression: "周五"
      }),
      claims,
      evaluations: [
        evaluation("claim_commitment"),
        evaluation("claim_owner", "unsupported"),
        evaluation("claim_deadline", "unverifiable")
      ],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("suppress");
    expect(decision.structuredData).toMatchObject({
      rawActorLabel: "Speaker 2",
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null
    });
  });

  it("suppresses an open question when later canonical Evidence resolves it", () => {
    const claims = [
      claim("claim_question", "open_question"),
      claim("claim_resolution", "question_resolution")
    ];
    const decision = evaluateWorkCandidatePublication({
      kind: "open_question",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}),
      claims,
      evaluations: [evaluation("claim_question"), evaluation("claim_resolution")],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("suppress");
    expect(decision.reasonCodes).toContain("question_resolved_later");
  });

  it("does not preserve explicit-commitment action basis without a verified commitment", () => {
    const claims = [
      claim("claim_action", "action_item"),
      claim("claim_commitment", "commitment_existence")
    ];
    const decision = evaluateWorkCandidatePublication({
      kind: "action_item",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        actionBasis: "explicit_commitment",
        relatedCommitmentCandidateId: "candidate_commitment"
      }),
      claims,
      evaluations: [
        evaluation("claim_action"),
        evaluation("claim_commitment", "unsupported")
      ],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("suppress");
    expect(decision.structuredData).toMatchObject({
      actionBasis: "assignment_without_acceptance",
      relatedCommitmentCandidateId: null
    });
  });

  it("suppresses a plan change that does not preserve at least two canonical stages", () => {
    const planChangeClaim = claim("claim_plan_change", "plan_change");
    const decision = evaluateWorkCandidatePublication({
      kind: "plan_change",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({ planStages: [] }),
      claims: [planChangeClaim],
      evaluations: [evaluation(planChangeClaim.id)],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("suppress");
    expect(decision.reasonCodes).toContain("plan_change_stages_missing");
  });

  it("suppresses plan stages that are not all covered by verified plan-change Evidence", () => {
    const planChangeClaim = WorkAtomicClaimSchema.parse({
      ...claim("claim_plan_change", "plan_change"),
      evidenceIds: ["segment_1", "segment_2"]
    });
    const structuredData = WorkMeetingCandidateStructuredDataSchema.parse({
      planStages: [
        {
          id: "stage_1",
          content: "第一阶段",
          status: "unclear",
          rawSpeakerLabel: null,
          evidenceRefs: [{
            publicationId: "publication_1",
            segmentId: "segment_1",
            startSeconds: 0,
            endSeconds: 1,
            rawSpeakerLabel: null,
            timestampQuality: "unknown"
          }]
        },
        {
          id: "stage_2",
          content: "第二阶段",
          status: "unclear",
          rawSpeakerLabel: null,
          evidenceRefs: [{
            publicationId: "publication_1",
            segmentId: "segment_2",
            startSeconds: 1,
            endSeconds: 2,
            rawSpeakerLabel: null,
            timestampQuality: "unknown"
          }]
        }
      ]
    });
    const decision = evaluateWorkCandidatePublication({
      kind: "plan_change",
      structuredData,
      claims: [planChangeClaim],
      evaluations: [{
        ...evaluation(planChangeClaim.id),
        supportedEvidenceIds: ["segment_1"]
      }],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("suppress");
    expect(decision.reasonCodes).toContain("plan_change_stage_evidence_not_verified");
  });
});
