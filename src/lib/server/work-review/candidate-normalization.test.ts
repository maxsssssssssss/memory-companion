import { describe, expect, it } from "vitest";

import {
  WorkExtractorCandidateDraftSchema,
  type WorkExtractorCandidateDraft
} from "@/lib/domain/work-review";
import {
  assembleWorkMeetingCandidates,
  buildWorkMeetingVerifierInput,
  deriveCandidateCopyFromAtomicClaims,
  partitionWorkCandidatesForVerification,
  WORK_VERIFIER_MAX_CLAIMS_PER_BATCH
} from "./candidate-normalization";

function segment(index: number, speaker = `Speaker ${index + 1}`) {
  return {
    id: `segment_${index}`,
    uploadId: "upload_1",
    startSeconds: index,
    endSeconds: index + 1,
    speaker,
    text: `canonical segment ${index}`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function candidate(input: Partial<WorkExtractorCandidateDraft> & {
  clientCandidateKey: string;
  evidenceIds: string[];
}): WorkExtractorCandidateDraft {
  return WorkExtractorCandidateDraftSchema.parse({
    clientCandidateKey: input.clientCandidateKey,
    kind: input.kind ?? "commitment",
    title: input.title ?? "整理测试录音",
    body: input.body ?? "说话者明确承诺整理测试录音。",
    structuredData: input.structuredData ?? {
      rawActorLabel: "Speaker 1"
    },
    evidenceIds: input.evidenceIds,
    claims: input.claims ?? [{
      clientClaimKey: `${input.clientCandidateKey}_claim`,
      claimType: "commitment_existence",
      text: "有人明确承诺整理测试录音",
      evidenceIds: input.evidenceIds
    }]
  });
}

function assemble(batches: Array<{ windowIndex: number; candidates: WorkExtractorCandidateDraft[] }>) {
  return assembleWorkMeetingCandidates({
    accountId: "account_1",
    meetingId: "meeting_1",
    publicationId: "publication_1",
    canonicalDigest: "a".repeat(64),
    segments: [segment(0, "Speaker 1"), segment(1, "Speaker 1"), segment(2, "Speaker 2")],
    batches
  });
}

describe("Work Meeting candidate normalization", () => {
  it("merges deterministic overlap duplicates and creates stable candidate and claim IDs", () => {
    const first = candidate({
      clientCandidateKey: "window_1_commitment",
      evidenceIds: ["segment_0", "segment_1"]
    });
    const second = candidate({
      clientCandidateKey: "window_2_commitment",
      title: "整理测试录音！",
      evidenceIds: ["segment_1"]
    });
    const forward = assemble([
      { windowIndex: 0, candidates: [first] },
      { windowIndex: 1, candidates: [second] }
    ]);
    const reversed = assemble([
      { windowIndex: 1, candidates: [second] },
      { windowIndex: 0, candidates: [first] }
    ]);
    expect(forward).toHaveLength(1);
    expect(reversed).toEqual(forward);
    expect(forward[0].id).toMatch(/^work_candidate_[a-f0-9]{64}$/u);
    expect(forward[0].claims).toHaveLength(2);
    expect(forward[0].claims.every((claim) =>
      claim.id.startsWith("work_claim_") && claim.candidateId === forward[0].id
    )).toBe(true);
    expect(forward[0].sourceWindowIndexes).toEqual([0, 1]);
  });

  it("never merges similar commitments from different raw speakers", () => {
    const speakerOne = candidate({
      clientCandidateKey: "speaker_1_commitment",
      evidenceIds: ["segment_1"],
      structuredData: {
        decisionFinality: null,
        rawActorLabel: "Speaker 1",
        candidateOwner: null,
        dueAt: null,
        originalDueExpression: null,
        actionBasis: null,
        relatedCommitmentCandidateId: null,
        planStages: []
      }
    });
    const speakerTwo = candidate({
      clientCandidateKey: "speaker_2_commitment",
      evidenceIds: ["segment_1", "segment_2"],
      structuredData: {
        decisionFinality: null,
        rawActorLabel: "Speaker 2",
        candidateOwner: null,
        dueAt: null,
        originalDueExpression: null,
        actionBasis: null,
        relatedCommitmentCandidateId: null,
        planStages: []
      }
    });
    expect(assemble([{ windowIndex: 0, candidates: [speakerOne, speakerTwo] }])).toHaveLength(2);
  });

  it("preserves a full A to B to C plan timeline ordered by canonical Evidence", () => {
    const plan = candidate({
      clientCandidateKey: "plan_change",
      kind: "plan_change",
      title: "发布时间调整",
      body: "发布时间从周四调整到周五，再调整到下周一。",
      evidenceIds: ["segment_0", "segment_1", "segment_2"],
      structuredData: {
        decisionFinality: null,
        rawActorLabel: null,
        candidateOwner: null,
        dueAt: null,
        originalDueExpression: null,
        actionBasis: null,
        relatedCommitmentCandidateId: null,
        planStages: [
          {
            clientStageKey: "stage_c",
            content: "下周一上线",
            status: "current",
            rawSpeakerLabel: "Speaker 2",
            evidenceIds: ["segment_2"]
          },
          {
            clientStageKey: "stage_a",
            content: "周四上线",
            status: "proposed",
            rawSpeakerLabel: "Speaker 1",
            evidenceIds: ["segment_0"]
          },
          {
            clientStageKey: "stage_b",
            content: "周五上线",
            status: "revised",
            rawSpeakerLabel: "Speaker 1",
            evidenceIds: ["segment_1"]
          }
        ]
      },
      claims: [{
        clientClaimKey: "plan_change_claim",
        claimType: "plan_change",
        text: "方案经历三次变化",
        evidenceIds: ["segment_0", "segment_1", "segment_2"]
      }]
    });
    const [assembled] = assemble([{ windowIndex: 0, candidates: [plan] }]);
    expect(assembled.structuredData.planStages.map((stage) => stage.content)).toEqual([
      "周四上线",
      "周五上线",
      "下周一上线"
    ]);
    expect(assembled.structuredData.planStages.every((stage) =>
      stage.clientStageKey.startsWith("work_stage_")
    )).toBe(true);
  });

  it("resolves related commitments within each source window when client keys repeat", () => {
    const batch = (windowIndex: number, speaker: string, evidenceId: string) => ({
      windowIndex,
      candidates: [
        candidate({
          clientCandidateKey: "commitment_ref",
          evidenceIds: [evidenceId],
          structuredData: {
            decisionFinality: null,
            rawActorLabel: speaker,
            candidateOwner: null,
            dueAt: null,
            originalDueExpression: null,
            actionBasis: null,
            relatedCommitmentCandidateId: null,
            planStages: []
          }
        }),
        candidate({
          clientCandidateKey: "action_ref",
          kind: "action_item",
          title: `${speaker} 的后续动作`,
          evidenceIds: [evidenceId],
          structuredData: {
            decisionFinality: null,
            rawActorLabel: speaker,
            candidateOwner: null,
            dueAt: null,
            originalDueExpression: null,
            actionBasis: "explicit_commitment",
            relatedCommitmentCandidateId: "commitment_ref",
            planStages: []
          },
          claims: [{
            clientClaimKey: `${speaker}_action_claim`,
            claimType: "action_item",
            text: `${speaker} 有一个后续动作`,
            evidenceIds: [evidenceId]
          }]
        })
      ]
    });
    const assembled = assemble([
      batch(0, "Speaker 1", "segment_0"),
      batch(1, "Speaker 2", "segment_2")
    ]);
    for (const speaker of ["Speaker 1", "Speaker 2"]) {
      const commitment = assembled.find((item) =>
        item.kind === "commitment" && item.structuredData.rawActorLabel === speaker
      );
      const action = assembled.find((item) =>
        item.kind === "action_item" && item.structuredData.rawActorLabel === speaker
      );
      expect(action?.structuredData.relatedCommitmentCandidateId).toBe(commitment?.id);
    }
  });

  it("rejects Claim Evidence that is outside its Candidate Evidence closure", () => {
    expect(() => assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "invalid_closure",
        evidenceIds: ["segment_0"],
        claims: [{
          clientClaimKey: "invalid_claim",
          claimType: "commitment_existence",
          text: "错误地引用了候选之外的 Evidence",
          evidenceIds: ["segment_1"]
        }]
      })]
    }])).toThrow("work_candidate_evidence_closure_invalid");
  });

  it("builds verifier input only from canonical claims and segments", () => {
    const candidates = assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "commitment",
        evidenceIds: ["segment_0"]
      })]
    }]);
    const verifierInput = buildWorkMeetingVerifierInput({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      segments: [segment(0), segment(1), segment(2)],
      candidates,
      timestampQualityBySegmentId: { segment_0: "provider_exact" }
    });
    expect(verifierInput.claims).toEqual(candidates[0].claims);
    expect(verifierInput.segments).toHaveLength(3);
    expect(verifierInput).not.toHaveProperty("generatorNarrative");
    expect(deriveCandidateCopyFromAtomicClaims(candidates[0].claims)).toEqual({
      title: "有人明确承诺整理测试录音",
      body: "有人明确承诺整理测试录音"
    });
  });

  it("batches long-meeting verification without splitting a candidate or exceeding schema closure", () => {
    const candidates = Array.from({ length: 5 }, (_, candidateIndex) => ({
      ...assemble([{
        windowIndex: candidateIndex,
        candidates: [candidate({
          clientCandidateKey: `candidate_${candidateIndex}`,
          title: `候选 ${candidateIndex}`,
          evidenceIds: ["segment_0"],
          claims: Array.from({ length: 64 }, (_, claimIndex) => ({
            clientClaimKey: `candidate_${candidateIndex}_claim_${claimIndex}`,
            claimType: "commitment_existence" as const,
            text: `候选 ${candidateIndex} 原子事实 ${claimIndex}`,
            evidenceIds: ["segment_0"]
          }))
        })]
      }])[0]
    }));

    const batches = partitionWorkCandidatesForVerification(candidates);
    expect(batches.map((batch) => batch.length)).toEqual([4, 1]);
    expect(batches.every((batch) =>
      batch.reduce((total, item) => total + item.claims.length, 0)
        <= WORK_VERIFIER_MAX_CLAIMS_PER_BATCH
    )).toBe(true);
    expect(batches.flat()).toEqual(candidates);
  });
});
