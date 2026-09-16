import { describe, expect, it } from "vitest";

import {
  WorkExtractorCandidateDraftSchema,
  type WorkExtractorCandidateDraft
} from "@/lib/domain/work-review";
import { buildWorkMeetingVerifierProviderPayload } from "./analysis-provider";
import {
  assembleWorkMeetingCandidates,
  attachWorkQuestionResolutionClaims,
  assertWorkMeetingCandidateReviewBudget,
  buildWorkMeetingVerifierInput,
  deriveCandidateCopyFromAtomicClaims,
  deriveCandidateCopyFromPublication,
  estimateWorkVerifierBatchPayloadCharacters,
  estimateWorkVerifierClaimPayloadCharacters,
  partitionWorkMeetingCandidateReviewCapacity,
  partitionWorkCandidatesForVerification,
  planWorkCandidatesForVerification,
  selectWorkCandidatesForGptVerification,
  WORK_VERIFIER_MAX_CLAIMS_PER_BATCH,
  WORK_VERIFIER_MAX_BATCHES,
  WORK_VERIFIER_MAX_PAYLOAD_CHARACTERS_PER_BATCH
} from "./candidate-normalization";
import { requiresWorkClaimGptVerification } from "./publication-policy";

function segment(
  index: number,
  speaker = `Speaker ${index + 1}`,
  text = `canonical segment ${index}`
) {
  return {
    id: `segment_${index}`,
    uploadId: "upload_1",
    startSeconds: index,
    endSeconds: index + 1,
    speaker,
    text,
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

function assemble(
  batches: Array<{ windowIndex: number; candidates: WorkExtractorCandidateDraft[] }>,
  segments = [segment(0, "Speaker 1"), segment(1, "Speaker 1"), segment(2, "Speaker 2")]
) {
  return assembleWorkMeetingCandidates({
    accountId: "account_1",
    meetingId: "meeting_1",
    publicationId: "publication_1",
    canonicalDigest: "a".repeat(64),
    segments,
    batches
  });
}

describe("Work Meeting candidate normalization", () => {
  it("defers optional attributes rather than required cores at either capacity limit", () => {
    const canonical = [segment(0), segment(1, "unknown", "长属性依据".repeat(3000))];
    const draft = candidate({ clientCandidateKey: "payload", evidenceIds: canonical.map(s => s.id), claims: [
      { clientClaimKey: "core", claimType: "commitment_existence", text: "认领独立交付", evidenceIds: ["segment_0"] },
      { clientClaimKey: "owner", claimType: "commitment_owner", text: "甲认领", evidenceIds: ["segment_1"],
        semanticValue: { kind: "commitment_owner", value: "甲" } }
    ] });
    const candidates = assemble([{ windowIndex: 0, candidates: [draft] }], canonical);
    const core = candidates[0].claims.find(c => c.claimType === "commitment_existence")!;
    const owner = candidates[0].claims.find(c => c.claimType === "commitment_owner")!;
    const plan = planWorkCandidatesForVerification({ candidates, segments: canonical });
    expect(plan.batches.flatMap(b => b.flatMap(c => c.claims.map(claim => claim.id)))).toEqual([core.id]);
    expect(plan.deferredClaimIds).toEqual([owner.id]);
    const oversizedCore = { ...core, evidenceIds: ["segment_1"] };
    expect(planWorkCandidatesForVerification({ candidates: [{ ...candidates[0], claims: [oversizedCore, owner] }],
      segments: canonical })).toMatchObject({ batches: [[{ claims: [oversizedCore] }]], deferredClaimIds: [owner.id] });
    expect(() => planWorkCandidatesForVerification({ candidates: [{ ...candidates[0], claims: [core, { ...owner, evidenceIds: ["foreign"] }] }],
      segments: canonical })).toThrow("work_verifier_input_evidence_outside_canonical_publication");

    const compact = [segment(0)];
    const drafts = Array.from({ length: 18 }, (_, i) => candidate({ clientCandidateKey: `item_${i}`, evidenceIds: ["segment_0"],
      claims: [...Array.from({ length: 4 }, (_, j) => ({ clientClaimKey: `core_${i}_${j}`,
        claimType: "commitment_existence" as const, text: `独立事项${i}阶段${j}`, evidenceIds: ["segment_0"] })),
      { clientClaimKey: `owner_${i}`, claimType: "commitment_owner", text: `参与者${i}`,
        semanticValue: { kind: "commitment_owner", value: `参与者${i}` }, evidenceIds: ["segment_0"] }] }));
    const dense = assemble([{ windowIndex: 0, candidates: drafts }], compact).map(c => ({ ...c,
      claims: c.claims.flatMap(claim => claim.claimType === "commitment_existence"
        ? Array.from({ length: 4 }, (_, i) => ({ ...claim, id: `${claim.id}_${i}` })) : [claim]) }));
    const required = dense.map(c => ({ ...c, claims: c.claims.filter(claim => claim.claimType !== "commitment_owner") }));
    expect(partitionWorkCandidatesForVerification({ candidates: required, segments: compact })).toHaveLength(3);
    expect(() => partitionWorkCandidatesForVerification({ candidates: dense, segments: compact })).toThrow("work_verifier_batch_budget_exceeded");
    const densePlan = planWorkCandidatesForVerification({ candidates: dense, segments: compact });
    expect(densePlan.batches).toHaveLength(3);
    expect(densePlan.deferredClaimIds).toHaveLength(18);
    expect(densePlan.batches.flatMap(b => b.flatMap(c => c.claims))).toHaveLength(72);
    const extraCore = { ...required[0].claims[0], id: "extra_core" };
    expect(() => planWorkCandidatesForVerification({ candidates: [{ ...required[0], claims: [...required[0].claims, extraCore] }, ...required.slice(1)],
      segments: compact })).toThrow("work_verifier_batch_budget_exceeded");
  });

  it("does not collapse separate owners of identically worded tasks before verification", () => {
    const drafts = ["甲", "乙"].map((owner, i) => {
      const draft = candidate({ clientCandidateKey: `owner_${i}`, evidenceIds: ["segment_0"] });
      draft.structuredData.candidateOwner = owner;
      return draft;
    });
    expect(assemble([{ windowIndex: 0, candidates: drafts }])).toHaveLength(2);
  });

  it("keeps fourteen cores and all emitted attributes in bounded same-candidate batches", () => {
    const canonical = Array.from({ length: 14 }, (_, i) => segment(i, "unknown", `事项 ${i} 已明确接受，周五完成。`));
    const drafts = canonical.map((s, i) => candidate({ clientCandidateKey: `item_${i}`, evidenceIds: [s.id],
      claims: [
        { clientClaimKey: `core_${i}`, claimType: "commitment_existence", text: `完成独立交付 ${i}`, evidenceIds: [s.id] },
        ...(i < 9 ? [{ clientClaimKey: `owner_${i}`, claimType: "commitment_owner" as const,
          semanticValue: { kind: "commitment_owner" as const, value: `参与者 ${i}` }, text: `参与者 ${i} 认领`, evidenceIds: [s.id] }] : []),
        ...(i < 8 ? [{ clientClaimKey: `due_${i}`, claimType: "deadline" as const,
          semanticValue: { kind: "deadline" as const, dueAt: null, originalDueExpression: "周五" }, text: "周五完成", evidenceIds: [s.id] }] : []),
        ...(i < 2 ? [{ clientClaimKey: `final_${i}`, claimType: "decision_finality" as const,
          semanticValue: { kind: "decision_finality" as const, value: "final" as const }, text: "最终决定", evidenceIds: [s.id] }] : []),
        { clientClaimKey: `speaker_${i}`, claimType: "speaker_attribution", text: `发言者 ${i}`,
          semanticValue: { kind: "speaker_attribution", value: `发言者 ${i}` }, evidenceIds: [s.id] }
      ] }));
    const candidates = selectWorkCandidatesForGptVerification({ candidates: assemble([{ windowIndex: 0, candidates: drafts }], canonical), segments: canonical });
    const batches = partitionWorkCandidatesForVerification({ candidates, segments: canonical });
    expect(batches.length).toBeLessThanOrEqual(3);
    const claims = candidates.flatMap(c => c.claims);
    expect(claims).toHaveLength(47);
    expect(batches.flatMap(batch => batch.flatMap(c => c.claims.map(claim => claim.id))).sort()).toEqual(claims.map(c => c.id).sort());
    for (const batch of batches) {
      const input = buildWorkMeetingVerifierInput({ accountId: "account_1", meetingId: "meeting_1",
        publicationId: "publication_1", canonicalDigest: "a".repeat(64), candidates: batch, segments: canonical });
      expect(input.claims.length).toBeLessThanOrEqual(24);
      expect(JSON.stringify(buildWorkMeetingVerifierProviderPayload(input)).length).toBeLessThanOrEqual(12_000);
      for (const c of batch) expect(c.claims).toEqual(candidates.find(original => original.id === c.id)!.claims);
    }
    expect(() => partitionWorkCandidatesForVerification({ candidates, segments: canonical, maxBatches: 1 }))
      .toThrow();
  });

  it("keeps independent commitments separate despite sharing a speaker and Segment", () => {
    const drafts = ["完成培训材料", "完成培训材料，并确认参与名单与范围"].map((text, index) =>
      candidate({ clientCandidateKey: `scope_${index}`, evidenceIds: ["segment_0"],
        claims: [{ clientClaimKey: `scope_claim_${index}`, claimType: "commitment_existence",
          text, evidenceIds: ["segment_0"] }] }));
    expect(assemble([{ windowIndex: 0, candidates: drafts }])).toHaveLength(2);
  });

  it("routes a possible later resolution with both evidence sides, without locally resolving it", () => {
    const texts = ["首轮提醒方式尚未确定", "首轮提醒方式决定只使用每日摘要", "提醒方式是否增加开关仍未解决", "值班人选需另行询问"];
    const kinds = ["open_question", "decision", "open_question", "open_question"] as const;
    const source = texts.map((text, index) => segment(index, "speaker_1", text));
    const drafts = texts.map((text, index) => candidate({
      clientCandidateKey: `result_${index}`, kind: kinds[index], evidenceIds: [`segment_${index}`],
      claims: [{ clientClaimKey: `result_claim_${index}`,
        claimType: kinds[index] === "decision" ? "decision_existence" : "open_question",
        text, evidenceIds: [`segment_${index}`] }]
    }));
    const assembled = assemble([{ windowIndex: 0, candidates: drafts }], source);
    const routed = attachWorkQuestionResolutionClaims({ candidates: assembled, segments: source });
    const question = routed.find((item) => item.claims.some((claim) => claim.text === texts[0]))!;
    const resolution = question.claims.find((claim) => claim.claimType === "question_resolution")!;
    expect(resolution.evidenceIds).toEqual(["segment_0", "segment_1", "segment_2"]);
    expect(question.kind).toBe("open_question");
    expect(selectWorkCandidatesForGptVerification({ candidates: routed, segments: source })
      .flatMap((item) => item.claims).map((claim) => claim.id)).toContain(resolution.id);
    expect(routed.find((item) => item.claims.some((claim) => claim.text === texts[3]))?.claims)
      .toHaveLength(1);
    expect(attachWorkQuestionResolutionClaims({ candidates: routed, segments: source })).toEqual(routed);
    expect(() => attachWorkQuestionResolutionClaims({ candidates: assembled, segments: source.slice(1) }))
      .toThrow("work_verifier_input_evidence_outside_canonical_publication");
  });

  it("does not treat an earlier decision or a later proposal as a resolution", () => {
    const drafts = (["decision", "open_question", "proposal"] as const).map((kind, index) =>
      candidate({ clientCandidateKey: `reminder_${index}`, kind, evidenceIds: [`segment_${index}`],
        claims: [{ clientClaimKey: `reminder_claim_${index}`,
          claimType: kind === "decision" ? "decision_existence" : kind,
          text: "首轮提醒方式只使用每日摘要", evidenceIds: [`segment_${index}`] }] }));
    const source = [segment(0), segment(1), segment(2)];
    const assembled = assemble([{ windowIndex: 0, candidates: drafts }], source);
    expect(attachWorkQuestionResolutionClaims({ candidates: assembled, segments: source })).toEqual(assembled);
  });

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
    expect(forward[0].claims).toHaveLength(1);
    expect(forward[0].claims[0].evidenceIds).toEqual(["segment_0", "segment_1"]);
    expect(forward[0].claims.every((claim) =>
      claim.id.startsWith("work_claim_") && claim.candidateId === forward[0].id
    )).toBe(true);
    expect(forward[0].sourceWindowIndexes).toEqual([0, 1]);
  });

  it("does not merge otherwise identical Claims with different typed semantic values", () => {
    const [assembled] = assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "decision_with_conflicting_finality_values",
        kind: "decision",
        evidenceIds: ["segment_0"],
        structuredData: {
          decisionFinality: "unclear",
          rawActorLabel: null,
          candidateOwner: null,
          dueAt: null,
          originalDueExpression: null,
          actionBasis: null,
          relatedCommitmentCandidateId: null,
          planStages: []
        },
        claims: ["final", "tentative"].map((value) => ({
          clientClaimKey: `claim_${value}`,
          claimType: "decision_finality" as const,
          semanticRiskFlags: [],
          semanticValue: {
            kind: "decision_finality" as const,
            value: value as "final" | "tentative"
          },
          text: "该决定的最终性",
          evidenceIds: ["segment_0"]
        }))
      })]
    }]);
    expect(assembled.claims).toHaveLength(2);
    expect(new Set(assembled.claims.map((claim) => claim.id)).size).toBe(2);
    expect(assembled.claims.map((claim) => claim.semanticValue)).toEqual(expect.arrayContaining([
      { kind: "decision_finality", value: "final" },
      { kind: "decision_finality", value: "tentative" }
    ]));
  });

  it("keeps the Candidate main Claim first after deterministic cross-window assembly", () => {
    const [assembled] = assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "decision_with_optional_claims",
        kind: "decision",
        title: "首轮不提供周报导出",
        body: "首轮不提供周报导出，由 Speaker 1 宣布。",
        evidenceIds: ["segment_0"],
        structuredData: {
          decisionFinality: "final",
          rawActorLabel: "Speaker 1",
          candidateOwner: null,
          dueAt: null,
          originalDueExpression: null,
          actionBasis: null,
          relatedCommitmentCandidateId: null,
          planStages: []
        },
        claims: [{
          clientClaimKey: "speaker",
          claimType: "speaker_attribution",
          semanticRiskFlags: [],
          semanticValue: { kind: "speaker_attribution", value: "Speaker 1" },
          text: "决定由 Speaker 1 宣布",
          evidenceIds: ["segment_0"]
        }, {
          clientClaimKey: "finality",
          claimType: "decision_finality",
          semanticRiskFlags: [],
          semanticValue: { kind: "decision_finality", value: "final" },
          text: "该决定已经最终确定",
          evidenceIds: ["segment_0"]
        }, {
          clientClaimKey: "main",
          claimType: "decision_existence",
          semanticRiskFlags: [],
          semanticValue: null,
          text: "首轮不提供周报导出",
          evidenceIds: ["segment_0"]
        }]
      })]
    }]);

    expect(assembled.claims.map((claim) => claim.claimType)).toEqual([
      "decision_existence",
      "decision_finality",
      "speaker_attribution"
    ]);
    expect(deriveCandidateCopyFromAtomicClaims(assembled.claims)).toEqual({
      title: "首轮不提供周报导出",
      body: "首轮不提供周报导出；该决定已经最终确定；决定由 Speaker 1 宣布"
    });
  });

  it("rebuilds visible copy without unsupported optional Claims", () => {
    const [assembled] = assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "commitment_with_optional_owner",
        evidenceIds: ["segment_0"],
        claims: [{
          clientClaimKey: "main",
          claimType: "commitment_existence",
          text: "周五前提交接口测试",
          evidenceIds: ["segment_0"]
        }, {
          clientClaimKey: "owner",
          claimType: "commitment_owner",
          semanticValue: { kind: "commitment_owner", value: "Speaker 2" },
          text: "Speaker 2 是负责人",
          evidenceIds: ["segment_0"]
        }]
      })]
    }]);
    const main = assembled.claims.find((claim) => claim.claimType === "commitment_existence")!;

    expect(deriveCandidateCopyFromPublication({
      claims: assembled.claims,
      displayClaimIds: [main.id],
      displayNotes: ["负责人待确认"]
    })).toEqual({
      title: "周五前提交接口测试",
      body: "周五前提交接口测试；负责人待确认"
    });
  });

  it("merges the same core commitment while clearing conflicting optional speakers", () => {
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
    const assembled = assemble([{ windowIndex: 0, candidates: [speakerOne, speakerTwo] }]);
    expect(assembled).toHaveLength(1);
    expect(assembled[0].structuredData.rawActorLabel).toBeNull();
    expect(assembled[0].evidenceIds).toEqual(["segment_1", "segment_2"]);
  });

  it("retains distinct conditions separately until the AI organizer verifies their common delivery", () => {
    const core = "完成隔离检查和测试说明并提交本次交付结果，覆盖正常路径和错误路径，保留状态及排查日志";
    const first = candidate({ clientCandidateKey: "long_core", evidenceIds: ["segment_1"], claims: [{
      clientClaimKey: "long", claimType: "commitment_existence", text: `${core}，增加三组测试和运行文档`, evidenceIds: ["segment_1"] }] });
    const second = candidate({ clientCandidateKey: "short_core", evidenceIds: ["segment_1"], claims: [{
      clientClaimKey: "short", claimType: "commitment_existence", text: `${core}，异常则取消`, evidenceIds: ["segment_1"] }] });
    const result = assemble([{ windowIndex: 0, candidates: [first] }, { windowIndex: 1, candidates: [second] }]);
    expect(result).toHaveLength(2);
    expect(result.flatMap(c => c.claims.map(claim => claim.text))).toEqual([
      first.claims[0].text, second.claims[0].text
    ]);
  });

  it("consolidates discussion fragments by core Claim despite optional field conflicts", () => {
    const first = candidate({
      clientCandidateKey: "discussion_first",
      kind: "discussion_topic",
      title: "发布节奏讨论",
      body: "讨论发布节奏，Speaker 1 建议周五。",
      evidenceIds: ["segment_0"],
      structuredData: {
        decisionFinality: null,
        rawActorLabel: "Speaker 1",
        candidateOwner: "Alex",
        dueAt: "2026-09-11T00:00:00.000Z",
        originalDueExpression: "周五",
        actionBasis: null,
        relatedCommitmentCandidateId: null,
        planStages: []
      },
      claims: [{
        clientClaimKey: "discussion_first_core",
        claimType: "topic",
        text: "讨论发布节奏",
        evidenceIds: ["segment_0"]
      }]
    });
    const second = candidate({
      clientCandidateKey: "discussion_second",
      kind: "discussion_topic",
      title: "发布节奏",
      body: "Speaker 2 认为下周一更合适。",
      evidenceIds: ["segment_1"],
      structuredData: {
        decisionFinality: null,
        rawActorLabel: "Speaker 2",
        candidateOwner: "Blair",
        dueAt: "2026-09-14T00:00:00.000Z",
        originalDueExpression: "下周一",
        actionBasis: null,
        relatedCommitmentCandidateId: null,
        planStages: []
      },
      claims: [{
        clientClaimKey: "discussion_second_core",
        claimType: "topic",
        text: "发布节奏讨论",
        evidenceIds: ["segment_1"]
      }]
    });

    const assembled = assemble([
      { windowIndex: 0, candidates: [first] },
      { windowIndex: 1, candidates: [second] }
    ]);
    expect(assembled).toHaveLength(1);
    expect(assembled[0].claims).toHaveLength(1);
    expect(assembled[0].claims[0]).toMatchObject({
      claimType: "topic",
      evidenceIds: ["segment_0", "segment_1"]
    });
    expect(assembled[0].structuredData).toMatchObject({
      rawActorLabel: null,
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null
    });
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
    const commitments = assembled.filter((item) => item.kind === "commitment");
    const actions = assembled.filter((item) => item.kind === "action_item");
    expect(commitments).toHaveLength(1);
    expect(commitments[0].structuredData.rawActorLabel).toBeNull();
    expect(actions).toHaveLength(2);
    expect(actions.every((action) =>
      action.structuredData.relatedCommitmentCandidateId === commitments[0].id
    )).toBe(true);
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
    expect((verifierInput.segments as Array<{ id: string }>).map((item) => item.id))
      .toEqual(["segment_0"]);
    expect(verifierInput).not.toHaveProperty("generatorNarrative");
    expect(deriveCandidateCopyFromAtomicClaims(candidates[0].claims)).toEqual({
      title: "有人明确承诺整理测试录音",
      body: "有人明确承诺整理测试录音"
    });
  });

  it("projects only high-risk Claims and their canonical Evidence from a mixed low-risk Candidate", () => {
    const canonicalSegments = Array.from({ length: 5 }, (_, index) => segment(index));
    const [assembled] = assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "mixed_risk_candidate",
        kind: "discussion_topic",
        title: "混合风险讨论",
        body: "普通讨论中包含责任、日期和因果表述。",
        evidenceIds: canonicalSegments.map((item) => item.id),
        claims: [{
          clientClaimKey: "claim_topic",
          claimType: "topic",
          semanticRiskFlags: [],
          text: "会议讨论了同步节奏",
          evidenceIds: ["segment_0"]
        }, {
          clientClaimKey: "claim_owner",
          claimType: "commitment_owner",
          semanticRiskFlags: [],
          semanticValue: { kind: "commitment_owner", value: "Speaker 2" },
          text: "Speaker 2 是该事项负责人",
          evidenceIds: ["segment_1"]
        }, {
          clientClaimKey: "claim_deadline",
          claimType: "deadline",
          semanticRiskFlags: [],
          semanticValue: {
            kind: "deadline",
            dueAt: "2026-09-08T00:00:00.000Z",
            originalDueExpression: "下周二"
          },
          text: "该事项截止到下周二",
          evidenceIds: ["segment_2"]
        }, {
          clientClaimKey: "claim_causality",
          claimType: "proposal",
          semanticRiskFlags: ["causality"],
          text: "延迟由依赖变更导致",
          evidenceIds: ["segment_3"]
        }, {
          clientClaimKey: "claim_question",
          claimType: "open_question",
          semanticRiskFlags: [],
          text: "同步频率仍待确认",
          evidenceIds: ["segment_4"]
        }]
      })]
    }], canonicalSegments);
    const selected = selectWorkCandidatesForGptVerification({
      candidates: [assembled],
      segments: canonicalSegments
    });
    const expectedClaimIds = assembled.claims
      .filter(requiresWorkClaimGptVerification)
      .map((claim) => claim.id);
    expect(selected).toHaveLength(1);
    expect(selected[0].kind).toBe("discussion_topic");
    expect(selected[0].claims.map((claim) => claim.id)).toEqual(expectedClaimIds);
    expect(selected[0].claims).toEqual([
      expect.objectContaining({ claimType: "commitment_owner" }),
      expect.objectContaining({ claimType: "deadline" }),
      expect.objectContaining({ claimType: "proposal", semanticRiskFlags: ["causality"] })
    ]);

    const verifierInput = buildWorkMeetingVerifierInput({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      segments: canonicalSegments,
      candidates: selected
    });
    const payload = buildWorkMeetingVerifierProviderPayload(verifierInput);
    expect((verifierInput.segments as Array<{ id: string }>).map((item) => item.id)).toEqual([
      "segment_1", "segment_2", "segment_3"
    ]);
    expect(Object.keys(payload.evidenceById)).toEqual(["segment_1", "segment_2", "segment_3"]);
    expect(payload.items).toHaveLength(3);
    expect(payload.items.find((item) => item.claimType === "proposal"))
      .toMatchObject({ semanticRiskFlags: ["causality"] });
    expect(JSON.stringify(payload)).not.toContain("segment_0");
    expect(JSON.stringify(payload)).not.toContain("segment_4");
  });

  it("splits atomic Claims into stable batches without losing or duplicating any Claim", () => {
    const canonicalSegments = [segment(0), segment(1), segment(2)];
    const candidates = Array.from({ length: 5 }, (_, candidateIndex) => ({
      ...assemble([{
        windowIndex: candidateIndex,
        candidates: [candidate({
          clientCandidateKey: `candidate_${candidateIndex}`,
          title: `候选 ${candidateIndex}`,
          evidenceIds: ["segment_0"],
          claims: Array.from({ length: 64 }, (_, claimIndex) => ({
            clientClaimKey: `candidate_${candidateIndex}_claim_${claimIndex}`,
            claimType: "decision_finality" as const,
            text: `候选 ${candidateIndex} 原子事实 ${claimIndex}`,
            evidenceIds: ["segment_0"]
          }))
        })]
      }], canonicalSegments)[0]
    }));

    const batches = partitionWorkCandidatesForVerification({
      candidates,
      segments: canonicalSegments,
      maxBatches: 256
    });
    expect(batches.every((batch) =>
      batch.reduce((total, item) => total + item.claims.length, 0)
        <= WORK_VERIFIER_MAX_CLAIMS_PER_BATCH
    )).toBe(true);
    expect(batches.every((batch) => {
      const claims = batch.flatMap((item) => item.claims);
      return claims.length === 1 || estimateWorkVerifierBatchPayloadCharacters({
        claims,
        segments: canonicalSegments
      }) <= WORK_VERIFIER_MAX_PAYLOAD_CHARACTERS_PER_BATCH;
    })).toBe(true);
    const sourceClaimIds = candidates.flatMap((item) => item.claims.map((claim) => claim.id));
    const partitionedClaimIds = batches.flatMap((batch) =>
      batch.flatMap((item) => item.claims.map((claim) => claim.id))
    );
    expect(partitionedClaimIds).toEqual(sourceClaimIds);
    expect(new Set(partitionedClaimIds).size).toBe(sourceClaimIds.length);
    expect(batches.length).toBe(Math.ceil(sourceClaimIds.length / WORK_VERIFIER_MAX_CLAIMS_PER_BATCH));
    expect(batches.filter((batch) => batch.some((item) => item.id === candidates[0].id)).length)
      .toBeGreaterThan(1);
  });

  it("counts shared canonical Evidence once while charging every serialized Claim", () => {
    const canonicalSegments = [
      segment(0, "Speaker 1", "a".repeat(300)),
      segment(1, "Speaker 1", "b".repeat(300)),
      segment(2, "Speaker 2", "c".repeat(300))
    ];
    const [assembled] = assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "evidence_budget",
        evidenceIds: ["segment_0", "segment_1", "segment_2"],
        claims: [{
          clientClaimKey: "claim_0",
          claimType: "deadline",
          text: "first segment claim",
          evidenceIds: ["segment_0"]
        }, {
          clientClaimKey: "claim_0_repeat",
          claimType: "commitment_owner",
          text: "same first segment claim",
          evidenceIds: ["segment_0"]
        }, {
          clientClaimKey: "claim_1",
          claimType: "decision_finality",
          text: "second segment claim",
          evidenceIds: ["segment_1"]
        }, {
          clientClaimKey: "claim_2",
          claimType: "proposal",
          text: "third segment claim",
          evidenceIds: ["segment_2"]
        }]
      })]
    }], canonicalSegments);
    const claimByText = new Map(assembled.claims.map((claim) => [claim.text, claim]));
    const orderedCandidate = {
      ...assembled,
      claims: [
        claimByText.get("first segment claim")!,
        claimByText.get("same first segment claim")!,
        claimByText.get("second segment claim")!,
        claimByText.get("third segment claim")!
      ]
    };
    const firstThreeClaims = orderedCandidate.claims.slice(0, 3);
    const firstClaimCharacters = estimateWorkVerifierBatchPayloadCharacters({
      claims: firstThreeClaims.slice(0, 1),
      segments: canonicalSegments
    });
    const repeatedEvidenceCharacters = estimateWorkVerifierBatchPayloadCharacters({
      claims: firstThreeClaims.slice(0, 2),
      segments: canonicalSegments
    });
    expect(repeatedEvidenceCharacters - firstClaimCharacters).toBe(
      estimateWorkVerifierClaimPayloadCharacters(firstThreeClaims[1])
    );
    const budget = estimateWorkVerifierBatchPayloadCharacters({
      claims: firstThreeClaims,
      segments: canonicalSegments
    });
    const providerPayload = buildWorkMeetingVerifierProviderPayload(buildWorkMeetingVerifierInput({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "digest_1",
      segments: canonicalSegments,
      candidates: [{ ...orderedCandidate, claims: firstThreeClaims }]
    }));
    expect(budget).toBe(JSON.stringify(providerPayload).length);
    const batches = partitionWorkCandidatesForVerification({
      candidates: [orderedCandidate],
      segments: canonicalSegments,
      maxClaimsPerBatch: 10,
      maxPayloadCharactersPerBatch: budget
    });

    expect(batches.map((batch) => batch.flatMap((item) => item.claims).length)).toEqual([3, 1]);
    expect(batches[0][0].claims.map((claim) => claim.text)).toEqual([
      "first segment claim",
      "same first segment claim",
      "second segment claim"
    ]);
    expect(batches.flatMap((batch) => batch.flatMap((item) => item.claims.map((claim) => claim.id))))
      .toEqual(orderedCandidate.claims.map((claim) => claim.id));
  });

  it("gives one oversized Claim its own batch without slicing its text", () => {
    const canonicalSegments = [segment(0, "Speaker 1", "shared evidence")];
    const longText = "很长的原子事实".repeat(400);
    const [assembled] = assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "long_claim",
        evidenceIds: ["segment_0"],
        claims: [{
          clientClaimKey: "short_before",
          claimType: "proposal",
          text: "short before",
          evidenceIds: ["segment_0"]
        }, {
          clientClaimKey: "oversized",
          claimType: "commitment_existence",
          text: longText,
          evidenceIds: ["segment_0"]
        }, {
          clientClaimKey: "short_after",
          claimType: "proposal",
          text: "short after",
          evidenceIds: ["segment_0"]
        }]
      })]
    }], canonicalSegments);
    const claimByText = new Map(assembled.claims.map((claim) => [claim.text, claim]));
    const orderedCandidate = {
      ...assembled,
      claims: [
        claimByText.get("short before")!,
        claimByText.get(longText)!,
        claimByText.get("short after")!
      ]
    };
    const budget = estimateWorkVerifierBatchPayloadCharacters({
      claims: orderedCandidate.claims.slice(0, 1),
      segments: canonicalSegments
    });
    const batches = partitionWorkCandidatesForVerification({
      candidates: [orderedCandidate],
      segments: canonicalSegments,
      maxClaimsPerBatch: 10,
      maxPayloadCharactersPerBatch: budget
    });

    expect(batches.map((batch) => batch.flatMap((item) => item.claims).length)).toEqual([1, 1, 1]);
    expect(batches[1][0].claims[0].text).toBe(longText);
    expect(estimateWorkVerifierBatchPayloadCharacters({
      claims: batches[1][0].claims,
      segments: canonicalSegments
    })).toBeGreaterThan(budget);
  });

  it("rejects missing canonical Evidence and invalid verifier batch limits", () => {
    const canonicalSegments = [segment(0), segment(1), segment(2)];
    const [assembled] = assemble([{
      windowIndex: 0,
      candidates: [candidate({
        clientCandidateKey: "invalid_verifier_evidence",
        evidenceIds: ["segment_0"]
      })]
    }], canonicalSegments);
    const invalidEvidence = {
      ...assembled,
      claims: assembled.claims.map((claim) => ({ ...claim, evidenceIds: ["missing_segment"] }))
    };
    expect(() => partitionWorkCandidatesForVerification({
      candidates: [invalidEvidence],
      segments: canonicalSegments
    })).toThrow("work_verifier_input_evidence_outside_canonical_publication");
    expect(() => partitionWorkCandidatesForVerification({
      candidates: [assembled],
      segments: canonicalSegments,
      maxClaimsPerBatch: 0
    })).toThrow("maxClaimsPerBatch");
    expect(WORK_VERIFIER_MAX_BATCHES).toBe(3);
    expect(WORK_VERIFIER_MAX_CLAIMS_PER_BATCH).toBe(24);
    expect(WORK_VERIFIER_MAX_PAYLOAD_CHARACTERS_PER_BATCH).toBe(12_000);
  });

  it("partitions a prioritized primary review set without treating overflow as fatal", () => {
    const kinds = [
      "discussion_topic",
      "proposal",
      "open_question",
      "plan_change",
      "action_item",
      "commitment",
      "decision"
    ] as const;
    const canonicalSegments = Array.from({ length: 21 }, (_, index) => segment(index));
    const candidates = canonicalSegments.flatMap((item, index) => assemble([{
      windowIndex: index,
      candidates: [candidate({
        clientCandidateKey: `candidate_${index}`,
        kind: kinds[index % kinds.length],
        title: `独立事项 ${index}`,
        body: `完全不同的独立事项 ${index}`,
        evidenceIds: [item.id],
        claims: [{
          clientClaimKey: `claim_${index}`,
          claimType: ({
            discussion_topic: "topic",
            proposal: "proposal",
            open_question: "open_question",
            plan_change: "plan_change",
            action_item: "action_item",
            commitment: "commitment_existence",
            decision: "decision_existence"
          } as const)[kinds[index % kinds.length]],
          text: `完全不同的独立事项 ${index}`,
          evidenceIds: [item.id]
        }]
      })]
    }], canonicalSegments));

    const capacity = partitionWorkMeetingCandidateReviewCapacity(candidates);
    expect(capacity.primaryCandidates).toHaveLength(20);
    expect(capacity.overflowCandidates).toHaveLength(1);
    expect(capacity.primaryCandidates.slice(0, 3).map(item => item.kind))
      .toEqual(["commitment", "plan_change", "open_question"]);
    expect(assertWorkMeetingCandidateReviewBudget(candidates)).toEqual(capacity.primaryCandidates);
    expect(new Set([
      ...capacity.primaryCandidates,
      ...capacity.overflowCandidates
    ].map((item) => item.id)).size).toBe(21);
  });

  it("uses full fallback for incomplete AI priority, including restored deletion sources", () => {
    const candidates = [
      ...Array.from({ length: 23 }, (_, index) => ({ id: `decision_${index}`, kind: "decision" as const })),
      { id: "delivery", kind: "commitment" as const }, { id: "blocker", kind: "open_question" as const }
    ];
    const fallback = partitionWorkMeetingCandidateReviewCapacity(candidates);
    expect(fallback.primaryCandidates.slice(0, 3).map(c => c.id)).toEqual(["delivery", "decision_0", "blocker"]);
    const ranked = partitionWorkMeetingCandidateReviewCapacity(candidates, 20, ["decision_22", "blocker", "blocker", "unknown"]);
    expect(ranked.primaryCandidates).toEqual(fallback.primaryCandidates);
    expect(ranked.ranking).toMatchObject({ strategy: "full_fallback" });
    expect(ranked.ranking.missingPriorityIds).toContain("delivery");
    const fullPriority = ["decision_22", "blocker", ...candidates.filter(c => !["decision_22", "blocker"].includes(c.id)).map(c => c.id)];
    const complete = partitionWorkMeetingCandidateReviewCapacity(candidates, 20, fullPriority);
    expect(complete.ranking.strategy).toBe("ai_complete");
    expect(complete.priorityIds).toEqual(fullPriority);
    expect(new Set([...ranked.primaryCandidates, ...ranked.overflowCandidates].map(c => c.id)).size).toBe(25);
    expect(partitionWorkMeetingCandidateReviewCapacity(candidates.slice(0, 23)).primaryCandidates).toHaveLength(20);
  });
});
