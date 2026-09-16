import { describe, expect, it } from "vitest";

import {
  WorkAtomicClaimSchema,
  WorkMeetingCandidateStructuredDataSchema,
  type WorkAtomicClaim,
  type WorkClaimSemanticValue,
  type WorkVerifierClaimDraft
} from "@/lib/domain/work-review";
import {
  evaluateWorkCandidatePublication,
  evaluateWorkClaimPublication,
  requiresWorkClaimGptVerification,
  riskLevelForWorkClaim,
  workClaimGptVerificationReasons,
  WORK_MEETING_CAUSALITY_ROUTING_ISSUE_CODE,
  WORK_MEETING_NON_GPT_ISSUE_CODE,
  WORK_MEETING_VERIFIER_CAPACITY_ISSUE_CODE,
  WORK_MEETING_SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PREFIX,
  WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES,
  WORK_MEETING_SEMANTIC_SAFETY_RULES
} from "./publication-policy";

function claim(
  id: string,
  claimType: WorkAtomicClaim["claimType"],
  semanticRiskFlags: NonNullable<WorkAtomicClaim["semanticRiskFlags"]> = [],
  semanticValue: WorkClaimSemanticValue | null = null
): WorkAtomicClaim {
  return WorkAtomicClaimSchema.parse({
    id,
    candidateId: "candidate_1",
    claimType,
    semanticRiskFlags,
    semanticValue,
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
  it.each(["commitment_owner", "deadline", "decision_finality", "speaker_attribution"] as const)(
    "records capacity-skipped %s as unverified and clears its value without suppressing the core", type => {
      const kind = type === "decision_finality" ? "decision" : "commitment";
      const core = claim("core", kind === "decision" ? "decision_existence" : "commitment_existence");
      const value: WorkClaimSemanticValue = type === "deadline" ? { kind: "deadline", dueAt: null, originalDueExpression: "周五" }
        : type === "decision_finality" ? { kind: "decision_finality", value: "final" } : { kind: type, value: "甲" };
      const optional = claim("optional", type, [], value);
      const field = ({ commitment_owner: "candidateOwner", deadline: "originalDueExpression", decision_finality: "decisionFinality", speaker_attribution: "rawActorLabel" } as const)[type];
      const result = evaluateWorkCandidatePublication({ kind, verifierEnabled: true, claims: [core, optional],
        structuredData: WorkMeetingCandidateStructuredDataSchema.parse({ [field]: type === "deadline" ? "周五" : type === "decision_finality" ? "final" : "甲" }),
        evaluations: [evaluation(core.id), { claimId: optional.id, supportVerdict: "unverifiable",
          issueCodes: [WORK_MEETING_VERIFIER_CAPACITY_ISSUE_CODE], supportedEvidenceIds: [] }] });
      expect(result.publicationAction).toBe("show_as_candidate");
      expect(result.displayClaimIds).toEqual([core.id]);
      expect(result.structuredData[field]).toBe(type === "decision_finality" ? "unclear" : null);
      expect(result.reasonCodes).toContain(`${type}_capacity_not_checked`);
      expect(result.reasonCodes).not.toContain(`${type}_evidence_insufficient`);
      expect(result.reasonCodes).not.toContain(`${type}_verification_failed`);
      expect(result.displayNotes.join(" ")).toContain("因核验容量不足未核验");
      expect(evaluateWorkClaimPublication({ claimType: type, supportVerdict: "entailed",
        issueCodes: [WORK_MEETING_VERIFIER_CAPACITY_ISSUE_CODE] }).publicationAction).toBe("suppress");
    });

  it.each([
    ["not_checked", [WORK_MEETING_NON_GPT_ISSUE_CODE], "负责人未核验，待确认"],
    ["evidence_insufficient", [], "负责人依据不足，待确认"],
    ["verification_failed", ["verifier_result_missing"], "负责人核验未完成，待确认"]
  ] as const)("keeps supported training stages while distinguishing optional owner %s", (reason, issues, note) => {
    const core = { ...claim("core", "commitment_existence"), text: "周四交培训材料初稿、周五修订终稿，下周一开展培训" };
    const owner = claim("owner", "commitment_owner", [], { kind: "commitment_owner", value: "陈宁" });
    const result = evaluateWorkCandidatePublication({ kind: "commitment", verifierEnabled: true,
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({ candidateOwner: "陈宁" }),
      claims: [core, owner], evaluations: [evaluation(core.id), {
        claimId: owner.id, supportVerdict: "unverifiable", issueCodes: [...issues], supportedEvidenceIds: [] }] });
    expect(result.publicationAction).toBe("show_as_candidate");
    expect(result.displayClaimIds).toEqual([core.id]);
    expect(result.reasonCodes).toContain(`commitment_owner_${reason}`);
    expect(result.displayNotes).toContain(note);
    if (reason !== "not_checked") expect(result.structuredData.candidateOwner).toBeNull();
    // A mocked verdict exercises control flow, not model interpretation of stages.
    const unsafe = evaluateWorkCandidatePublication({ kind: "commitment", verifierEnabled: true,
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}), claims: [core],
      evaluations: [{ ...evaluation(core.id), supportVerdict: "unsupported",
        supportedEvidenceIds: [], issueCodes: ["independent_items_conflated"] }] });
    expect(unsafe.publicationAction).toBe("suppress");
  });

  it("downgrades uncertain finality without hiding an established decision", () => {
    const core = claim("core", "decision_existence");
    const finality = claim("final", "decision_finality", [], { kind: "decision_finality", value: "final" });
    const result = evaluateWorkCandidatePublication({ kind: "decision", verifierEnabled: true,
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({ decisionFinality: "final" }),
      claims: [core, finality], evaluations: [evaluation(core.id), evaluation(finality.id, "unverifiable")] });
    expect(result.publicationAction).toBe("show_as_candidate");
    expect(result.structuredData.decisionFinality).toBe("unclear");
    expect(result.displayClaimIds).toEqual([core.id]);
    expect(result.displayNotes).toContain("决定是否最终依据不足，待确认");
  });

  it("routes core high-risk semantics, emitted attributes and explicit causality to the GPT Verifier", () => {
    const highRiskCases = [
      [claim("decision_exists", "decision_existence"), "decision"],
      [claim("commitment", "commitment_existence"), "commitment"],
      [claim("action", "action_item"), "action_item"],
      [claim("plan", "plan_change"), "plan_change"],
      [claim("resolution", "question_resolution"), "question_resolution"],
      [claim("causal", "proposal", ["causality"]), "causality"],
      [claim("finality", "decision_finality"), "decision_finality"],
      [claim("speaker", "speaker_attribution"), "speaker_attribution"],
      [claim("owner", "commitment_owner"), "commitment_owner"],
      [claim("date", "deadline"), "deadline"]
    ] as const;
    for (const [atomicClaim, reason] of highRiskCases) {
      expect(requiresWorkClaimGptVerification(atomicClaim)).toBe(true);
      expect(workClaimGptVerificationReasons(atomicClaim)).toContain(reason);
      expect(riskLevelForWorkClaim(atomicClaim)).toBe("high");
    }
    for (const claimType of [
      "topic",
      "proposal",
      "open_question"
    ] as const) {
      const atomicClaim = claim(`low_${claimType}`, claimType);
      expect(requiresWorkClaimGptVerification(atomicClaim)).toBe(false);
      expect(workClaimGptVerificationReasons(atomicClaim)).toEqual([]);
    }
  });

  it("keeps the explicit non-GPT path pending without fabricating support", () => {
    expect(evaluateWorkClaimPublication({
      claimType: "topic",
      supportVerdict: "unverifiable",
      issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE]
    })).toMatchObject({
      publicationAction: "show_as_question",
      confirmationRequired: true
    });
    expect(evaluateWorkClaimPublication({
      claimType: "question_resolution",
      supportVerdict: "unverifiable",
      issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE]
    }).publicationAction).toBe("suppress");
    for (const claimType of [
      "decision_finality",
      "speaker_attribution",
      "commitment_owner",
      "deadline"
    ] as const) {
      expect(evaluateWorkClaimPublication({
        claimType,
        supportVerdict: "unverifiable",
        issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE]
      }).publicationAction).toBe("suppress");
    }
    expect(evaluateWorkClaimPublication({
      claimType: "decision_existence",
      supportVerdict: "unverifiable",
      issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE]
    }).publicationAction).toBe("suppress");
    expect(evaluateWorkClaimPublication({
      claimType: "topic",
      supportVerdict: "entailed",
      issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE]
    }).publicationAction).toBe("suppress");
    expect(evaluateWorkClaimPublication({
      claimType: "proposal",
      semanticRiskFlags: ["causality"],
      supportVerdict: "unverifiable",
      issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE]
    }).publicationAction).toBe("suppress");
    expect(evaluateWorkClaimPublication({
      claimType: "proposal",
      semanticRiskFlags: ["causality"],
      supportVerdict: "entailed",
      issueCodes: [WORK_MEETING_CAUSALITY_ROUTING_ISSUE_CODE]
    }).publicationAction).toBe("show_as_candidate");
  });

  it("removes high-risk structured fields that have no verified Atomic Claim", () => {
    const topic = claim("claim_topic", "topic");
    const decision = evaluateWorkCandidatePublication({
      kind: "discussion_topic",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        decisionFinality: "final",
        rawActorLabel: "Speaker 2",
        candidateOwner: "Alex",
        dueAt: null,
        originalDueExpression: "下周五前",
        actionBasis: "explicit_commitment",
        relatedCommitmentCandidateId: "candidate_commitment",
        planStages: [{
          id: "stage_1",
          content: "改用新方案",
          status: "current",
          rawSpeakerLabel: "Speaker 2",
          evidenceRefs: [{
            publicationId: "publication_1",
            segmentId: "segment_1",
            startSeconds: 0,
            endSeconds: 1,
            rawSpeakerLabel: "Speaker 2",
            timestampQuality: "unknown"
          }]
        }]
      }),
      claims: [topic],
      evaluations: [{
        claimId: topic.id,
        supportVerdict: "unverifiable",
        issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE],
        supportedEvidenceIds: []
      }],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("show_as_question");
    expect(decision.structuredData).toMatchObject({
      decisionFinality: null,
      rawActorLabel: null,
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null,
      actionBasis: null,
      relatedCommitmentCandidateId: null,
      planStages: []
    });
  });

  it("clears exact Owner, speaker, and Due values that disagree with typed verified values", () => {
    const topic = claim("claim_topic", "topic");
    const speaker = WorkAtomicClaimSchema.parse({
      ...claim("claim_speaker", "speaker_attribution"),
      semanticValue: { kind: "speaker_attribution", value: "Speaker 10" },
      text: "该表述来自 Speaker 10"
    });
    const owner = WorkAtomicClaimSchema.parse({
      ...claim("claim_owner", "commitment_owner"),
      semanticValue: { kind: "commitment_owner", value: "李明" },
      text: "李明是该事项负责人"
    });
    const deadline = WorkAtomicClaimSchema.parse({
      ...claim("claim_deadline", "deadline"),
      semanticValue: {
        kind: "deadline",
        dueAt: "2026-09-12T00:00:00.000Z",
        originalDueExpression: "下周五"
      },
      text: "该事项截止到下周五"
    });
    const decision = evaluateWorkCandidatePublication({
      kind: "discussion_topic",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        rawActorLabel: "Speaker 1",
        candidateOwner: "李",
        dueAt: "2026-09-11T00:00:00.000Z",
        originalDueExpression: "下周五"
      }),
      claims: [topic, speaker, owner, deadline],
      evaluations: [{
        claimId: topic.id,
        supportVerdict: "unverifiable",
        issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE],
        supportedEvidenceIds: []
      }, evaluation(speaker.id), evaluation(owner.id), evaluation(deadline.id)],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("show_as_question");
    expect(decision.structuredData).toMatchObject({
      rawActorLabel: null,
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null
    });
  });

  it("downgrades finality when the typed verified value differs even if text contains finality words", () => {
    const existence = claim("claim_exists", "decision_existence");
    const finality = WorkAtomicClaimSchema.parse({
      ...claim("claim_finality", "decision_finality"),
      semanticValue: { kind: "decision_finality", value: "tentative" },
      text: "该决定尚未最终确定"
    });
    const decision = evaluateWorkCandidatePublication({
      kind: "decision",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        decisionFinality: "final"
      }),
      claims: [existence, finality],
      evaluations: [evaluation(existence.id), evaluation(finality.id)],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("show_as_candidate");
    expect(decision.structuredData.decisionFinality).toBe("unclear");
  });

  it("retains decision finality when the exact typed value is entailed", () => {
    const existence = claim("claim_exists", "decision_existence");
    const finality = claim(
      "claim_finality",
      "decision_finality",
      [],
      { kind: "decision_finality", value: "final" }
    );
    const decision = evaluateWorkCandidatePublication({
      kind: "decision",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        decisionFinality: "final"
      }),
      claims: [existence, finality],
      evaluations: [evaluation(existence.id), evaluation(finality.id)],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("show_as_candidate");
    expect(decision.structuredData.decisionFinality).toBe("final");
  });

  it("retains exact typed optional values when they are entailed", () => {
    const topic = claim("claim_topic", "topic");
    const speaker = claim(
      "claim_speaker",
      "speaker_attribution",
      [],
      { kind: "speaker_attribution", value: "Speaker 2" }
    );
    const owner = claim(
      "claim_owner",
      "commitment_owner",
      [],
      { kind: "commitment_owner", value: "Alex" }
    );
    const deadline = claim(
      "claim_deadline",
      "deadline",
      [],
      {
        kind: "deadline",
        dueAt: "2026-09-11T00:00:00.000Z",
        originalDueExpression: "下周五"
      }
    );
    const decision = evaluateWorkCandidatePublication({
      kind: "discussion_topic",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        rawActorLabel: "Speaker 2",
        candidateOwner: "Alex",
        dueAt: "2026-09-11T00:00:00.000Z",
        originalDueExpression: "下周五"
      }),
      claims: [topic, speaker, owner, deadline],
      evaluations: [{
        claimId: topic.id,
        supportVerdict: "unverifiable",
        issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE],
        supportedEvidenceIds: []
      }, evaluation(speaker.id), evaluation(owner.id), evaluation(deadline.id)],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("show_as_question");
    expect(decision.structuredData).toMatchObject({
      rawActorLabel: "Speaker 2",
      candidateOwner: "Alex",
      dueAt: "2026-09-11T00:00:00.000Z",
      originalDueExpression: "下周五"
    });
  });

  it("keeps non-GPT optional values pending without weakening the verified core", () => {
    const existence = claim("claim_exists", "decision_existence");
    const finality = claim(
      "claim_finality",
      "decision_finality",
      [],
      { kind: "decision_finality", value: "final" }
    );
    const speaker = claim(
      "claim_speaker",
      "speaker_attribution",
      [],
      { kind: "speaker_attribution", value: "Speaker 2" }
    );
    const owner = claim(
      "claim_owner",
      "commitment_owner",
      [],
      { kind: "commitment_owner", value: "Alex" }
    );
    const deadline = claim(
      "claim_deadline",
      "deadline",
      [],
      {
        kind: "deadline",
        dueAt: "2026-09-11T00:00:00.000Z",
        originalDueExpression: "下周五"
      }
    );
    const localEvaluation = (claimId: string): WorkVerifierClaimDraft => ({
      claimId,
      supportVerdict: "unverifiable",
      issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE],
      supportedEvidenceIds: []
    });

    const decision = evaluateWorkCandidatePublication({
      kind: "decision",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        decisionFinality: "final",
        rawActorLabel: "Speaker 2",
        candidateOwner: "Alex",
        dueAt: "2026-09-11T00:00:00.000Z",
        originalDueExpression: "下周五"
      }),
      claims: [existence, finality, speaker, owner, deadline],
      // A missing optional evaluation is also local: it remains pending and
      // cannot change the verified decision existence result.
      evaluations: [
        evaluation(existence.id),
        localEvaluation(finality.id),
        localEvaluation(speaker.id),
        localEvaluation(deadline.id)
      ],
      canonicalSegments: [{ id: "segment_1", text: "下周五前完成。" }],
      verifierEnabled: true
    });

    expect(decision.publicationAction).toBe("show_as_candidate");
    expect(decision.structuredData).toMatchObject({
      decisionFinality: "final",
      rawActorLabel: "Speaker 2",
      candidateOwner: "Alex",
      dueAt: null,
      originalDueExpression: "下周五前"
    });
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      "decision_finality_pending_confirmation",
      "raw_actor_pending_confirmation",
      "candidate_owner_pending_confirmation",
      "deadline_pending_confirmation",
      `claim_evaluation_missing:${owner.id}`
    ]));
    expect(decision.displayClaimIds).toEqual([existence.id]);
  });

  it.each([
    "9月11日", "9月11号", "9月11号前", "九月十一号中午前",
    "2026年9月11日下午三点前", "下周五前", "明天下午三点前", "9月8日下班前", "9月11号下午15:30前"
  ])("copies the pending source expression %s without inventing an absolute date", (expression) => {
    const core = claim("core", "commitment_existence");
    const deadline = claim("deadline", "deadline", [], {
      kind: "deadline", dueAt: "2023-09-11T00:00:00.000Z", originalDueExpression: null
    });
    deadline.text = `${expression}完成埋点`;
    const input = {
      kind: "commitment" as const,
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({ dueAt: "2023-09-11T00:00:00.000Z" }),
      claims: [core, deadline],
      evaluations: [evaluation(core.id), { claimId: deadline.id, supportVerdict: "unverifiable" as const,
        issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE], supportedEvidenceIds: [] }],
      canonicalSegments: [{ id: "segment_1", text: `我认领埋点，${expression}完成，涉及敏感内容则取消。` },
        { id: "other_claim", text: "2023年9月11日零点UTC" }],
      verifierEnabled: true
    };
    const before = JSON.stringify(input);
    const decision = evaluateWorkCandidatePublication(input);
    expect(decision).toMatchObject({ publicationAction: "show_as_candidate", confirmationRequired: true,
      structuredData: { dueAt: null, originalDueExpression: expression }, displayClaimIds: [core.id] });
    expect(decision.displayNotes).toContain("截止时间未核验，待确认");
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    { original: "9月11日", text: "9月11号前完成。", expected: "9月11号前" },
    { original: "2023年9月11日", text: "9月11号前完成。", expected: "9月11号前" },
    { original: null, text: "9月11日做测试，9月15号做回退。", expected: null },
    { original: "9月11日", text: "暂未确定时间。", expected: null },
    { original: "2026-09-11T09:00:00Z", text: "在2026-09-11T09:00:00Z完成。", expected: "2026-09-11T09:00:00Z" },
    { original: "2026-09-11T09:00:00Z", text: "9月8日先检查，在2026-09-11T09:00:00Z完成。", expected: "2026-09-11T09:00:00Z" },
    { original: "2026年9月11日15:30 UTC+8", text: "在2026年9月11日15:30 UTC+8完成。", expected: "2026年9月11日15:30 UTC+8" }
  ])("does not use ambiguous or out-of-claim dates: $text", ({ original, text, expected }) => {
    const core = claim("core", "commitment_existence");
    const deadline = claim("deadline", "deadline", [], {
      kind: "deadline", dueAt: "2023-09-11T00:00:00.000Z", originalDueExpression: original
    });
    const decision = evaluateWorkCandidatePublication({
      kind: "commitment",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        dueAt: "2023-09-11T00:00:00.000Z", originalDueExpression: original
      }),
      claims: [core, deadline],
      evaluations: [evaluation(core.id), { claimId: deadline.id, supportVerdict: "unverifiable",
        issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE], supportedEvidenceIds: [] }],
      canonicalSegments: [{ id: "segment_1", text }, { id: "unrelated", text: "9月11日完成。" }],
      verifierEnabled: true
    });
    expect(decision.structuredData).toMatchObject({ dueAt: null, originalDueExpression: expected });
    expect(decision.publicationAction).toBe("show_as_candidate");
  });

  it("fails closed within one Candidate for unknown or duplicate Claim evaluations", () => {
    const topic = claim("claim_topic", "topic");
    const structuredData = WorkMeetingCandidateStructuredDataSchema.parse({});
    expect(evaluateWorkCandidatePublication({
      kind: "discussion_topic",
      structuredData,
      claims: [topic],
      evaluations: [evaluation("claim_outside_candidate")],
      verifierEnabled: true
    })).toMatchObject({
      publicationAction: "suppress",
      reasonCodes: ["unknown_claim_evaluation"]
    });
    expect(evaluateWorkCandidatePublication({
      kind: "discussion_topic",
      structuredData,
      claims: [topic],
      evaluations: [evaluation(topic.id), evaluation(topic.id)],
      verifierEnabled: true
    })).toMatchObject({
      publicationAction: "suppress",
      reasonCodes: ["duplicate_claim_evaluation"]
    });
  });

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
    expect(WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES).toHaveLength(16);
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
    expect(evaluateWorkClaimPublication({
      claimType: "commitment_owner",
      supportVerdict: "entailed",
      issueCodes: [
        `${WORK_MEETING_SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PREFIX}${"a".repeat(64)}`
      ]
    }).publicationAction).toBe("show_as_candidate");
    expect(evaluateWorkClaimPublication({
      claimType: "commitment_owner",
      supportVerdict: "entailed",
      issueCodes: [`${WORK_MEETING_SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PREFIX}not-a-hash`]
    }).publicationAction).toBe("suppress");
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

  it("fails closed for a high-risk Candidate kind that omits its required high-risk Claim", () => {
    const topic = claim("claim_topic", "topic");
    const decision = evaluateWorkCandidatePublication({
      kind: "decision",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}),
      claims: [topic],
      evaluations: [{
        claimId: topic.id,
        supportVerdict: "unverifiable",
        issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE],
        supportedEvidenceIds: []
      }],
      verifierEnabled: false
    });
    expect(decision).toMatchObject({
      publicationAction: "suppress",
      reasonCodes: ["verifier_required_for_high_risk_candidate"]
    });
  });

  it("removes an unsupported optional owner without deleting a supported core topic", () => {
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
    expect(candidate.publicationAction).toBe("show_as_candidate");
    expect(candidate.reasonCodes).toContain("claim_not_fully_supported:commitment_owner");
    expect(candidate.displayClaimIds).toEqual(["claim_topic"]);
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
    expect(candidate.publicationAction).toBe("show_as_candidate");
    expect(candidate.structuredData.candidateOwner).toBeNull();
    expect(candidate.displayNotes).toContain("负责人待确认");
  });

  it("keeps non-GPT finality as a pending user-confirmed value", () => {
    const claims = [
      claim("claim_exists", "decision_existence"),
      claim(
        "claim_final",
        "decision_finality",
        [],
        { kind: "decision_finality", value: "final" }
      )
    ];
    const decision = evaluateWorkCandidatePublication({
      kind: "decision",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        decisionFinality: "final"
      }),
      claims,
      evaluations: [
        evaluation("claim_exists"),
        {
          claimId: "claim_final",
          supportVerdict: "unverifiable",
          issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE],
          supportedEvidenceIds: []
        }
      ],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("show_as_candidate");
    expect(decision.structuredData.decisionFinality).toBe("final");
    expect(decision.reasonCodes).toContain("decision_finality_pending_confirmation");
    expect(decision.displayClaimIds).toEqual(["claim_exists"]);
    expect(decision.displayNotes).toContain("决定是否最终未核验，待确认");
  });

  it("clears unsupported owner but retains an unverifiable due value for user confirmation", () => {
    const claims = [
      claim("claim_commitment", "commitment_existence"),
      claim(
        "claim_owner",
        "commitment_owner",
        [],
        { kind: "commitment_owner", value: "Alex" }
      ),
      claim(
        "claim_deadline",
        "deadline",
        [],
        {
          kind: "deadline",
          dueAt: "2026-09-04T00:00:00.000Z",
          originalDueExpression: "周五"
        }
      )
    ];
    const decision = evaluateWorkCandidatePublication({
      kind: "commitment",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        candidateOwner: "Alex",
        dueAt: "2026-09-04T00:00:00.000Z",
        originalDueExpression: "周五"
      }),
      claims,
      evaluations: [
        evaluation("claim_commitment"),
        evaluation("claim_owner", "unsupported"),
        {
          claimId: "claim_deadline",
          supportVerdict: "unverifiable",
          issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE],
          supportedEvidenceIds: []
        }
      ],
      canonicalSegments: [{ id: "segment_1", text: "我认领这件事，周五完成。" }],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("show_as_candidate");
    expect(decision.structuredData).toMatchObject({
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: "周五"
    });
    expect(decision.displayClaimIds).toEqual(["claim_commitment"]);
    expect(decision.displayNotes).toEqual(expect.arrayContaining([
      "负责人依据不足，待确认",
      "截止时间未核验，待确认"
    ]));
  });

  it("suppresses an open question when later canonical Evidence resolves it", () => {
    const claims = [
      claim("claim_question", "open_question"),
      { ...claim("claim_resolution", "question_resolution"), evidenceIds: ["segment_1", "segment_2"] }
    ];
    const decision = evaluateWorkCandidatePublication({
      kind: "open_question",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}),
      claims,
      evaluations: [evaluation("claim_question"), {
        ...evaluation("claim_resolution"), supportedEvidenceIds: ["segment_1", "segment_2"]
      }],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("suppress");
    expect(decision.reasonCodes).toContain("question_resolved_later");
  });

  it.each(["unsupported", "partially_entailed", "unverifiable", "missing", "one_side"])(
    "keeps the question when resolution is %s", (verdict) => {
      const resolution = { ...claim("resolution", "question_resolution"), evidenceIds: ["segment_1", "segment_2"] };
      const decision = evaluateWorkCandidatePublication({
        kind: "open_question", structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}),
        claims: [claim("question", "open_question"), resolution],
        evaluations: [evaluation("question"), ...(verdict === "missing" ? [] : [evaluation("resolution",
          verdict === "one_side" ? "entailed" : verdict as WorkVerifierClaimDraft["supportVerdict"])])],
        verifierEnabled: true
      });
      expect(decision.publicationAction).not.toBe("suppress");
      expect(decision.reasonCodes).not.toContain("question_resolved_later");
    }
  );

  it("rejects a conflated commitment even if the verifier says entailed", () => {
    expect(evaluateWorkClaimPublication({ claimType: "commitment_existence", supportVerdict: "entailed",
      issueCodes: ["independent_items_conflated"] }).publicationAction).toBe("suppress");
  });

  it("keeps an unresolved question available when its resolution verifier is disabled", () => {
    const decision = evaluateWorkCandidatePublication({
      kind: "open_question", structuredData: WorkMeetingCandidateStructuredDataSchema.parse({}),
      claims: [claim("question", "open_question"), claim("resolution", "question_resolution")],
      evaluations: [
        { ...evaluation("question", "unverifiable"), issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE] },
        { ...evaluation("resolution", "unverifiable"), issueCodes: ["verifier_disabled"] }
      ], verifierEnabled: false
    });
    expect(decision.publicationAction).toBe("show_as_question");
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
    expect(decision.publicationAction).toBe("show_as_question");
    expect(decision.structuredData).toMatchObject({
      actionBasis: "assignment_without_acceptance",
      relatedCommitmentCandidateId: null
    });
    expect(decision.displayClaimIds).toEqual(["claim_action"]);
    expect(decision.displayNotes).toContain("是否形成承诺待确认");
  });

  it("clears a related commitment link until a Claim binds that exact Candidate ID", () => {
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
      evaluations: claims.map((item) => evaluation(item.id)),
      verifierEnabled: true
    });
    expect(decision.structuredData).toMatchObject({
      actionBasis: "explicit_commitment",
      relatedCommitmentCandidateId: null
    });
    expect(decision.reasonCodes).toContain("related_commitment_not_claim_bound");
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

  it("does not count duplicate status/content semantics as two plan-change stages", () => {
    const planChangeClaim = claim("claim_plan_change", "plan_change");
    const duplicatedStage = {
      id: "stage_1",
      content: "同一条 canonical Evidence",
      status: "unclear" as const,
      rawSpeakerLabel: null,
      evidenceRefs: [{
        publicationId: "publication_1",
        segmentId: "segment_1",
        startSeconds: 0,
        endSeconds: 1,
        rawSpeakerLabel: null,
        timestampQuality: "unknown" as const
      }]
    };
    const decision = evaluateWorkCandidatePublication({
      kind: "plan_change",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        planStages: [
          duplicatedStage,
          { ...duplicatedStage, id: "stage_2" }
        ]
      }),
      claims: [planChangeClaim],
      evaluations: [evaluation(planChangeClaim.id)],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("suppress");
    expect(decision.reasonCodes).toContain("plan_change_stages_missing");
  });

  it("accepts distinct plan stages supported by one canonical Segment", () => {
    const planChangeClaim = claim("claim_plan_change", "plan_change");
    const sharedEvidence = {
      publicationId: "publication_1",
      segmentId: "segment_1",
      startSeconds: 0,
      endSeconds: 1,
      rawSpeakerLabel: null,
      timestampQuality: "unknown" as const
    };
    const decision = evaluateWorkCandidatePublication({
      kind: "plan_change",
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        planStages: [{
          id: "stage_old",
          content: "原开放日为九月十八日",
          status: "revised",
          rawSpeakerLabel: null,
          evidenceRefs: [sharedEvidence]
        }, {
          id: "stage_current",
          content: "当前开放日为九月二十二日",
          status: "current",
          rawSpeakerLabel: null,
          evidenceRefs: [sharedEvidence]
        }]
      }),
      claims: [planChangeClaim],
      evaluations: [evaluation(planChangeClaim.id)],
      verifierEnabled: true
    });
    expect(decision.publicationAction).toBe("show_as_candidate");
    expect(decision.reasonCodes).not.toContain("plan_change_stages_missing");
    expect(decision.structuredData.planStages).toHaveLength(2);
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
