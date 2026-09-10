import OpenAI from "openai";
import { APIConnectionError, APIConnectionTimeoutError } from "openai/error";
import { describe, expect, it, vi } from "vitest";

import {
  WorkAtomicClaimSchema,
  type WorkExtractorCandidateDraft
} from "@/lib/domain/work-review";
import {
  parseStructuredJsonResponse,
  StructuredJsonResponseError
} from "@/lib/server/openai/structured-json";
import {
  buildWorkExtractorSchemaRepairInstruction,
  buildWorkMeetingVerifierProviderPayload,
  canonicalizeWorkExtractorClientKeys,
  classifyWorkAnalysisProviderError,
  createWorkStructuredJsonRequest,
  createStructuredWorkMeetingExtractor,
  createStructuredWorkMeetingVerifier,
  createConfiguredWorkMeetingAnalysisProviders,
  materializeWorkEvidence,
  materializeWorkExtractorCandidate,
  normalizeWorkExtractorWireResponse,
  normalizeWorkVerifierWireResponse,
  safeWorkAnalysisProviderDiagnostics,
  validateAggregatedWorkVerifierOutput,
  validateWorkExtractorOutput,
  validateWorkExtractorWireItems,
  validatePartialWorkVerifierOutput,
  validateWorkVerifierOutput,
  WORK_EXTRACTOR_MAX_ITEMS_PER_WINDOW,
  WORK_EXTRACTOR_MAX_WIRE_ITEMS,
  WorkExtractorWireEnvelopeSchema,
  WorkExtractorWireResponseSchema,
  WorkMeetingAnalysisProviderError,
  WorkVerifierWireEnvelopeSchema,
  WorkVerifierWireResponseSchema,
  type WorkStructuredJsonRequest
} from "./analysis-provider";
import { buildWorkMeetingTranscriptWindows } from "./windowing";
import {
  requiresWorkClaimGptVerification,
  WORK_MEETING_SEMANTIC_SAFETY_RULES
} from "./publication-policy";
import {
  WorkReviewRuntimeConfigError,
  type WorkReviewAnalysisProviderProfile
} from "./runtime-config";

function segment(id: string, startSeconds = 0, text = `canonical ${id}`) {
  return {
    id,
    uploadId: "upload_1",
    startSeconds,
    endSeconds: startSeconds + 1,
    speaker: "Speaker 1",
    text,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

const segments = [
  segment("segment_1", 0, "可以考虑下周一上线。"),
  segment("segment_2", 1, "最终就按下周一上线。")
];

const profile: WorkReviewAnalysisProviderProfile = {
  profileId: "work-meeting-extractor",
  provider: "openai-compatible-structured-json",
  model: "test-model",
  reasoningEffort: "minimal",
  timeoutMs: 2_000,
  maxOutputTokens: 2_000,
  promptVersion: "work_meeting_extractor_v1",
  schemaVersion: "work_meeting_candidates_v1"
};

function extractorCandidate(): WorkExtractorCandidateDraft {
  return {
    clientCandidateKey: "candidate_1",
    kind: "decision",
    title: "下周一上线",
    body: "会议中出现了明确决定表达。",
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
    evidenceIds: ["segment_2"],
    claims: [{
      clientClaimKey: "claim_1",
      claimType: "decision_existence",
      semanticRiskFlags: [],
      semanticValue: null,
      text: "会议作出了下周一上线的决定",
      evidenceIds: ["segment_2"]
    }, {
      clientClaimKey: "claim_2",
      claimType: "decision_finality",
      semanticRiskFlags: [],
      semanticValue: { kind: "decision_finality", value: "final" },
      text: "该决定是最终决定",
      evidenceIds: ["segment_2"]
    }]
  };
}

function extractorWireDecision() {
  return {
    kind: "decision" as const,
    coreText: "会议作出了下周一上线的决定",
    evidenceSegmentIds: ["segment_2"],
    decisionFinality: {
      value: "final" as const,
      text: "该决定是最终决定",
      evidenceSegmentIds: ["segment_2"]
    },
    actor: {
      label: "Speaker 1",
      role: "speaker" as const,
      text: "Speaker 1 作出了该决定",
      evidenceSegmentIds: ["segment_2"]
    }
  };
}

describe("Work Meeting analysis providers", () => {
  it.each(["unsupported", "contradicted", "unverifiable"] as const)(
    "omits only a %s evaluation with invalid Evidence while preserving valid siblings", (supportVerdict) => {
      const claims = ["segment_1", "segment_2"].map((id, index) => WorkAtomicClaimSchema.parse({
        id: `claim_${index}`, candidateId: `candidate_${index}`, claimType: "commitment_existence",
        text: "认领该事项", evidenceIds: [id], createdAt: null
      }));
      const sibling = { claimId: "claim_1", supportVerdict: "entailed", issueCodes: [], supportedEvidenceIds: ["segment_2"] };
      for (const invalidIds of [["segment_2"], ["other_meeting_segment"], ["segment_1", "segment_1"]]) {
        const result = validatePartialWorkVerifierOutput({ claims, allowedSegments: segments,
          response: { items: [{claimId: "claim_0", supportVerdict, issueCodes: [], supportedEvidenceIds: invalidIds}, sibling] }
        });
        expect(result.items).toEqual([sibling]);
        expect(JSON.stringify(result)).not.toContain("other_meeting_segment");
      }
      expect(() => validatePartialWorkVerifierOutput({ claims, allowedSegments: segments,
        response: {items: [{claimId: "unknown_claim", supportVerdict, issueCodes: [], supportedEvidenceIds: []}, sibling]}
      })).toThrowError(expect.objectContaining({code: "work_evidence_closure_invalid"}));
      expect(() => validatePartialWorkVerifierOutput({ claims, allowedSegments: segments,
        response: {items: [sibling, {...sibling, supportVerdict, supportedEvidenceIds: []}]}
      })).toThrowError(expect.objectContaining({code: "work_evidence_closure_invalid"}));
    }
  );

  it.each(["entailed", "partially_entailed"] as const)("still rejects affirmative %s Evidence scope violations", (supportVerdict) => {
    const claims = [WorkAtomicClaimSchema.parse({ id: "claim_1", candidateId: "candidate_1",
      claimType: "commitment_existence", text: "认领该事项", evidenceIds: ["segment_2"], createdAt: null })];
    expect(() => validatePartialWorkVerifierOutput({ claims, allowedSegments: segments,
      response: {items: [{claimId: "claim_1", supportVerdict, issueCodes: [], supportedEvidenceIds: ["segment_1"]}]}
    })).toThrowError(expect.objectContaining({code: "work_evidence_not_allowed"}));
  });

  it("preserves one accepted outcome, its deadline and exit condition through extraction and verifier payload", () => {
    const text = "认领权限接口及隔离测试，周五前完成；若发现涉及敏感内容则取消。";
    const evidence = ["segment_1", "segment_2"];
    const draft = canonicalizeWorkExtractorClientKeys({ items: [{
      kind: "commitment", coreText: text, evidenceSegmentIds: evidence
    }] }).items[0];
    expect(draft.claims).toHaveLength(1);
    expect(draft.claims[0]).toMatchObject({ claimType: "commitment_existence", text, evidenceIds: evidence });
    const { clientClaimKey: _clientClaimKey, ...claimFields } = draft.claims[0];
    const atomicClaim = WorkAtomicClaimSchema.parse({ ...claimFields, id: "claim_conditioned",
      candidateId: "candidate_conditioned", createdAt: null });
    const payload = buildWorkMeetingVerifierProviderPayload({
      accountId: "account_1", meetingId: "meeting_1", publicationId: "publication_1",
      canonicalDigest: "a".repeat(64), segments, claims: [atomicClaim]
    });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ text, evidenceIds: evidence });
    expect(Object.keys(payload.evidenceById)).toEqual(evidence);
  });

  it("keeps unconfirmed actor labels out of core copy before verification", () => {
    const result = canonicalizeWorkExtractorClientKeys({ items: [{
      kind: "commitment", coreText: "speaker_2 认领培训材料", evidenceSegmentIds: ["segment_1", "segment_2"],
      actor: { label: "speaker_2", role: "owner", text: "speaker_2 认领培训材料", evidenceSegmentIds: ["segment_1"] }
    }] }).items[0];
    expect(result.title).toBe("有人认领培训材料");
    expect(result.claims[0].text).not.toContain("speaker_2");
    expect(result.claims[0].evidenceIds).toEqual(["segment_1", "segment_2"]);
    expect(result.structuredData.candidateOwner).toBe("speaker_2");
    expect(result.claims[1].semanticValue).toEqual({ kind: "commitment_owner", value: "speaker_2" });
  });

  it("rejects generator Evidence outside the canonical window", () => {
    const candidate = extractorCandidate();
    expect(() => validateWorkExtractorOutput({
      allowedSegments: segments,
      response: {
        items: [{ ...candidate, evidenceIds: ["other_meeting_segment"] }]
      }
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_evidence_not_allowed"
    }));
  });

  it("rejects model-supplied source text instead of treating it as canonical Evidence", () => {
    const candidate = extractorCandidate();
    expect(() => validateWorkExtractorOutput({
      allowedSegments: segments,
      response: {
        items: [{ ...candidate, sourceQuote: "invented quote" }]
      }
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_extractor_output_invalid"
    }));
  });

  it("rejects a typed semantic value that differs from Candidate structuredData", () => {
    const candidate = extractorCandidate();
    expect(() => validateWorkExtractorOutput({
      allowedSegments: segments,
      response: {
        items: [{
          ...candidate,
          claims: candidate.claims.map((claim) => claim.claimType === "decision_finality"
            ? {
                ...claim,
                semanticValue: { kind: "decision_finality", value: "tentative" }
              }
            : claim)
        }]
      }
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_extractor_output_invalid"
    }));
  });

  it("materializes source text, timestamps, and speaker only from canonical Segments", () => {
    expect(materializeWorkEvidence({
      publicationId: "publication_1",
      segments,
      evidenceIds: ["segment_2"],
      timestampQualityBySegmentId: { segment_2: "provider_exact" }
    })).toEqual([{
      publicationId: "publication_1",
      segmentId: "segment_2",
      startSeconds: 1,
      endSeconds: 2,
      rawSpeakerLabel: "Speaker 1",
      timestampQuality: "provider_exact",
      text: "最终就按下周一上线。"
    }]);
    const materialized = materializeWorkExtractorCandidate({
      publicationId: "publication_1",
      segments,
      candidate: extractorCandidate()
    });
    expect(materialized.evidenceRefs[0].text).toBe(segments[1].text);
    expect(materialized).not.toHaveProperty("evidenceIds");
  });

  it("runs the extractor with a bounded canonical window and strict schema", async () => {
    const requestStructuredJson = vi.fn(async (
      _request: Parameters<WorkStructuredJsonRequest>[0]
    ) => ({ items: [extractorWireDecision()] }));
    const extractor = createStructuredWorkMeetingExtractor({
      profile,
      requestStructuredJson
    });
    const window = buildWorkMeetingTranscriptWindows(segments)[0];
    await expect(extractor.extract({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      window
    })).resolves.toEqual(
      canonicalizeWorkExtractorClientKeys({ items: [extractorWireDecision()] }).items
    );
    expect(requestStructuredJson).toHaveBeenCalledWith(expect.objectContaining({
      stage: "extractor",
      profile,
      name: "work_meeting_candidates_v1",
      schema: WorkExtractorWireEnvelopeSchema,
      normalize: normalizeWorkExtractorWireResponse,
      jsonInstruction: expect.stringContaining("只能使用输入窗口中的 segment id")
    }));
    const request = requestStructuredJson.mock.calls[0]?.[0];
    const requestText = JSON.stringify(request?.requestInput);
    expect(requestText).toContain("window=1/1");
    expect(requestText).not.toContain("meeting_1");
    expect(requestText).not.toContain("publication_1");
    expect(requestText).not.toContain("a".repeat(64));
    expect(request?.jsonInstruction).toContain("items 最多 20 项");
    expect(request?.jsonInstruction).toContain("任何 candidate/claim/stage id 或 key");
    expect(request?.jsonInstruction).toContain("不得输出 claims、claimType");
    expect(request?.jsonInstruction).toContain("coreText、evidenceSegmentIds");
    expect(request?.jsonInstruction).toContain(
      "kind 只能是 discussion_topic、proposal、decision、commitment、open_question、plan_change、action_item"
    );
    expect(request?.jsonInstruction).toContain("服务端按 kind 将 coreText 确定性展开为主 Claim");
    expect(request?.jsonInstruction).toContain("causality:true");
    expect(request?.jsonInstruction).toContain("decisionFinality={value,text,evidenceSegmentIds}");
    expect(request?.jsonInstruction).toContain("actor={label,role,text,evidenceSegmentIds}");
    expect(request?.jsonInstruction).toContain("deadline={dueAt?,originalDueExpression?,text,evidenceSegmentIds}");
    expect(request?.jsonInstruction).toContain("acceptedCommitment={text,evidenceSegmentIds}");
    expect(request?.jsonInstruction).toContain("1-based 位置");
    expect(request?.jsonInstruction).toContain("两个 stage 可以引用同一个 Evidence ID");
    expect(request?.jsonInstruction).toContain("公共字段只有 kind、coreText、evidenceSegmentIds");
    expect(request?.jsonInstruction).toContain("commitment 不得输出 actionBasis、acceptedCommitment 或 relatedCommitmentItem");
    expect(request?.jsonInstruction).toContain("缺少任一年月日、时刻或时区信息时，只输出 originalDueExpression");
    expect(request?.jsonInstruction).toContain("以 Z 结尾的 ISO 8601 UTC 字符串");
    expect(request?.jsonInstruction).toContain("没有明确时间表达时省略整个 deadline");
    expect(request?.jsonInstruction).toContain("逐字复制输入行方括号内的完整 segment id");
    expect(request?.jsonInstruction).toContain("禁止简写、截断、重编号、按位置生成 ID");
    const systemPrompt = JSON.stringify(request?.requestInput);
    expect(systemPrompt).toContain("同一事项在当前窗口内合并");
    expect(systemPrompt).toContain("后续 Decision 已吸收的普通 Proposal 不重复输出");
    expect(systemPrompt).toContain("后续已经解决的问题不输出 open_question");
    expect(systemPrompt).toContain("寒暄、背景复述、状态播报不生成 Candidate");
    expect(systemPrompt).toContain("不得填入输入没有支持的年份或时刻");
    expect(systemPrompt).toContain("9月11号");
    expect(systemPrompt).toContain("originalDueExpression 原样保留");
    expect(systemPrompt).toContain("不要猜测或纠正名称");
    expect(systemPrompt).toContain("不得删掉重要限制使承诺扩大");
    for (const rule of WORK_MEETING_SEMANTIC_SAFETY_RULES) {
      expect(requestStructuredJson).toHaveBeenCalledWith(expect.objectContaining({
        requestInput: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining(rule) })
        ])
      }));
    }
  });

  it("keeps the envelope strict while discarding invalid Extractor items locally", async () => {
    const privateSchemaMarker = "PRIVATE_INVALID_CANDIDATE_TEXT";
    const privateEvidenceMarker = "PRIVATE_OUT_OF_SCOPE_EVIDENCE";
    const requestStructuredJson = vi.fn(async () => ({
      items: [
        extractorWireDecision(),
        {
          kind: "discussion_topic",
          coreText: privateSchemaMarker
        },
        {
          kind: "proposal",
          coreText: "建议调整上线时间",
          evidenceSegmentIds: [privateEvidenceMarker]
        }
      ]
    }));
    const extractor = createStructuredWorkMeetingExtractor({
      profile,
      requestStructuredJson
    });
    const discards: Array<{
      itemIndex: number;
      reason: string;
      issues: Array<{ path: string; code: string }>;
    }> = [];

    await expect(extractor.extract({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      window: buildWorkMeetingTranscriptWindows(segments)[0],
      onItemDiscarded: (discard) => discards.push(discard)
    })).resolves.toMatchObject([{
      clientCandidateKey: "wire_candidate_1",
      kind: "decision",
      evidenceIds: ["segment_2"]
    }]);

    expect(requestStructuredJson).toHaveBeenCalledWith(expect.objectContaining({
      schema: WorkExtractorWireEnvelopeSchema
    }));
    expect(discards).toEqual([{
      itemIndex: 2,
      reason: "schema_invalid",
      issues: [{
        path: "items[1].evidenceSegmentIds",
        code: "invalid_type"
      }],
      issuesTruncated: false
    }, {
      itemIndex: 3,
      reason: "evidence_not_allowed",
      issues: [{
        path: "items[2]",
        code: "work_evidence_not_allowed"
      }],
      issuesTruncated: false
    }]);
    const serializedDiscards = JSON.stringify(discards);
    expect(serializedDiscards).not.toContain(privateSchemaMarker);
    expect(serializedDiscards).not.toContain(privateEvidenceMarker);
  });

  it("drops a relationship whose referenced Commitment item was discarded", () => {
    const discards: Array<{ itemIndex: number; reason: string }> = [];
    const response = validateWorkExtractorWireItems({
      response: {
        items: [{
          kind: "commitment",
          coreText: "明确承诺完成上线准备",
          evidenceSegmentIds: ["segment_outside_window"]
        }, {
          kind: "action_item",
          coreText: "完成上线准备",
          evidenceSegmentIds: ["segment_2"],
          actionBasis: "explicit_commitment",
          relatedCommitmentItem: 1,
          acceptedCommitment: {
            text: "明确接受了该行动",
            evidenceSegmentIds: ["segment_2"]
          }
        }]
      },
      allowedSegments: segments,
      onItemDiscarded: (discard) => discards.push(discard)
    });

    expect(response).toEqual({ items: [] });
    expect(discards).toEqual([{
      itemIndex: 1,
      reason: "evidence_not_allowed",
      issues: [{ path: "items[0]", code: "work_evidence_not_allowed" }],
      issuesTruncated: false
    }, {
      itemIndex: 2,
      reason: "relationship_invalid",
      issues: [{ path: "items[1].relatedCommitmentItem", code: "invalid_relationship" }],
      issuesTruncated: false
    }]);
  });

  it("fails closed on an invalid Extractor envelope but accepts exactly eight valid items", () => {
    const onItemDiscarded = vi.fn();
    expect(() => validateWorkExtractorWireItems({
      response: { items: [], privateExtraRootField: true },
      allowedSegments: segments,
      onItemDiscarded
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_extractor_output_invalid"
    }));
    expect(() => validateWorkExtractorWireItems({
      response: { items: "not-an-array" },
      allowedSegments: segments,
      onItemDiscarded
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_extractor_output_invalid"
    }));
    expect(onItemDiscarded).not.toHaveBeenCalled();

    const exactCapacity = validateWorkExtractorWireItems({
      response: {
        items: Array.from({ length: WORK_EXTRACTOR_MAX_ITEMS_PER_WINDOW }, (_, index) => ({
          kind: "discussion_topic",
          coreText: `讨论主题 ${index + 1}`,
          evidenceSegmentIds: ["segment_1"]
        }))
      },
      allowedSegments: segments,
      onItemDiscarded
    });
    expect(exactCapacity.items).toHaveLength(WORK_EXTRACTOR_MAX_ITEMS_PER_WINDOW);
    expect(onItemDiscarded).not.toHaveBeenCalled();
  });

  it.each([9, 20])("retains all %i valid wire items without truncation or an extra request", async (count) => {
    const wire = {
      items: Array.from({ length: count }, (_, index) => ({
        kind: "DISCUSSION_TOPIC",
        coreText: `独立事项 ${index + 1}`,
        evidenceSegmentIds: ["segment_2"]
      }))
    };
    expect(WorkExtractorWireEnvelopeSchema.parse(wire).items).toHaveLength(count);
    expect(WorkExtractorWireResponseSchema.parse(normalizeWorkExtractorWireResponse(wire)).items)
      .toHaveLength(count);
    const requestStructuredJson = vi.fn(async () => wire);
    const extractor = createStructuredWorkMeetingExtractor({ profile, requestStructuredJson });
    const onItemDiscarded = vi.fn();
    const items = await extractor.extract({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      window: buildWorkMeetingTranscriptWindows(segments)[0],
      onItemDiscarded
    });
    expect(items).toHaveLength(count);
    expect(items.map((item) => item.clientCandidateKey)).toEqual(
      Array.from({ length: count }, (_, index) => `wire_candidate_${index + 1}`)
    );
    expect(requestStructuredJson).toHaveBeenCalledTimes(1);
    expect(onItemDiscarded).not.toHaveBeenCalled();
  });

  it("rejects 21 wire items at the root but localizes a malformed item within 20", () => {
    const items = Array.from({ length: 21 }, (_, index) => ({
      kind: "discussion_topic",
      coreText: `独立事项 ${index + 1}`,
      evidenceSegmentIds: ["segment_2"]
    }));
    const onItemDiscarded = vi.fn();
    expect(WorkExtractorWireEnvelopeSchema.safeParse({ items }).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.safeParse({ items }).success).toBe(false);
    expect(() => validateWorkExtractorWireItems({
      response: { items },
      allowedSegments: segments,
      onItemDiscarded
    })).toThrowError(expect.objectContaining({ code: "work_extractor_output_invalid" }));
    expect(onItemDiscarded).not.toHaveBeenCalled();

    const boundedItems = items.slice(0, 20).map((item, index) => index === 8
      ? { kind: item.kind, evidenceSegmentIds: item.evidenceSegmentIds }
      : item);
    expect(WorkExtractorWireResponseSchema.safeParse({ items: boundedItems }).success).toBe(false);
    const valid = validateWorkExtractorWireItems({
      response: { items: boundedItems },
      allowedSegments: segments,
      onItemDiscarded
    });
    expect(valid.items).toHaveLength(19);
    expect(valid.items.map((item) => item.clientCandidateKey)).not.toContain("wire_candidate_9");
    expect(valid.items.at(-1)?.clientCandidateKey).toBe("wire_candidate_20");
    expect(onItemDiscarded).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      itemIndex: 9,
      reason: "schema_invalid"
    }));
  });

  it.each([9, 20])("preserves a valid reference to wire item %i after an unrelated item is discarded", (targetPosition) => {
    const items = [{
      kind: "action_item",
      coreText: "落实已接受的事项",
      evidenceSegmentIds: ["segment_2"],
      actionBasis: "explicit_commitment",
      relatedCommitmentItem: targetPosition,
      acceptedCommitment: { text: "明确接受该事项", evidenceSegmentIds: ["segment_2"] }
    }, ...Array.from({ length: targetPosition - 2 }, (_, index) => ({
      kind: "discussion_topic",
      coreText: `独立事项 ${index + 1}`,
      evidenceSegmentIds: ["segment_2"]
    })), {
      kind: "commitment",
      coreText: "明确承诺完成该事项",
      evidenceSegmentIds: ["segment_2"]
    }];
    expect(WorkExtractorWireResponseSchema.parse({ items }).items).toHaveLength(targetPosition);
    const canonical = canonicalizeWorkExtractorClientKeys({ items });
    expect(canonical.items[0]?.structuredData.relatedCommitmentCandidateId)
      .toBe(`wire_candidate_${targetPosition}`);
    const onItemDiscarded = vi.fn();
    const retained = validateWorkExtractorWireItems({
      response: { items: items.map((item, index) => index === 1 ? { kind: "discussion_topic" } : item) },
      allowedSegments: segments,
      onItemDiscarded
    });
    expect(retained.items).toHaveLength(targetPosition - 1);
    expect(retained.items[0]?.structuredData.relatedCommitmentCandidateId)
      .toBe(`wire_candidate_${targetPosition}`);
    expect(onItemDiscarded).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      itemIndex: 2,
      reason: "schema_invalid"
    }));
  });

  it.each([
    { targetPosition: 21, targetKind: "commitment", reason: "schema_invalid" },
    { targetPosition: 20, targetKind: "commitment", reason: "relationship_invalid" },
    { targetPosition: 9, targetKind: "proposal", reason: "relationship_invalid" }
  ])("rejects unsafe wire references: position=$targetPosition kind=$targetKind", ({ targetPosition, targetKind, reason }) => {
    const items = [{
      kind: "action_item",
      coreText: "落实已接受的事项",
      evidenceSegmentIds: ["segment_2"],
      actionBasis: "explicit_commitment",
      relatedCommitmentItem: targetPosition,
      acceptedCommitment: { text: "明确接受该事项", evidenceSegmentIds: ["segment_2"] }
    }, ...Array.from({ length: 7 }, (_, index) => ({
      kind: "discussion_topic",
      coreText: `独立事项 ${index + 1}`,
      evidenceSegmentIds: ["segment_2"]
    })), {
      kind: targetKind,
      coreText: "有关该事项的独立表述",
      evidenceSegmentIds: ["segment_2"]
    }];
    expect(() => canonicalizeWorkExtractorClientKeys({ items })).toThrow();
    const onItemDiscarded = vi.fn();
    const retained = validateWorkExtractorWireItems({
      response: { items },
      allowedSegments: segments,
      onItemDiscarded
    });
    expect(retained.items).toHaveLength(8);
    expect(retained.items.map((item) => item.kind)).not.toContain("action_item");
    expect(onItemDiscarded).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ itemIndex: 1, reason }));
  });

  it("regenerates a full Extractor response with only bounded schema repair hints", async () => {
    const requestStructuredJson = vi.fn(async (
      _request: Parameters<WorkStructuredJsonRequest>[0]
    ) => ({ items: [] }));
    const extractor = createStructuredWorkMeetingExtractor({
      profile,
      requestStructuredJson
    });
    const window = buildWorkMeetingTranscriptWindows(segments)[0];

    await expect(extractor.extract({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      window,
      schemaRepair: {
        validationIssues: [{
          path: "items[3].decisionFinality.value",
          code: "custom"
        }, {
          path: "items[4].coreText",
          code: "missing_field"
        }, {
          path: "items[4].coreText\nPRIVATE_PATH_MARKER",
          code: "private_code_marker"
        }],
        validationIssuesTruncated: true
      }
    })).resolves.toEqual([]);

    const instruction = requestStructuredJson.mock.calls[0]?.[0].jsonInstruction ?? "";
    expect(instruction).toContain("SCHEMA_REPAIR");
    expect(instruction).toContain("重新生成完整 {items:[...]} JSON");
    expect(instruction).toContain("path=items[3].decisionFinality.value code=custom");
    expect(instruction).toContain("path=items[4].coreText code=missing_field");
    expect(instruction).toContain("path=other code=schema_validation_error");
    expect(instruction).toContain("decision item 必须输出完整 decisionFinality");
    expect(instruction).toContain("每个 item 都必须输出 coreText 和非空 evidenceSegmentIds");
    expect(instruction).toContain("还有其他未展示的问题");
    expect(instruction).not.toContain("PRIVATE_PATH_MARKER");
    expect(instruction).not.toContain("private_code_marker");
    expect(buildWorkExtractorSchemaRepairInstruction({
      validationIssues: [],
      validationIssuesTruncated: false
    })).toContain("重新逐项核对所有必填字段");
    expect(buildWorkExtractorSchemaRepairInstruction({
      validationIssues: [{ path: "items[0].actor.role", code: "custom" }],
      validationIssuesTruncated: false
    })).toContain("不得从被点名或被提到推断 owner");
    expect(buildWorkExtractorSchemaRepairInstruction({
      validationIssues: [{ path: "items[0].planStages", code: "custom" }],
      validationIssuesTruncated: false
    })).toContain("同一 canonical Segment");
  });

  it("normalizes only mechanical enums and rejects legacy Claim arrays", () => {
    const normalized = WorkExtractorWireResponseSchema.parse(
      normalizeWorkExtractorWireResponse({
        items: [{
          kind: "DECISION",
          coreText: "会议决定下周一上线",
          evidenceSegmentIds: ["segment_2"],
          decisionFinality: {
            value: "FINAL",
            text: "该决定已经最终确定",
            evidenceSegmentIds: ["segment_2"]
          },
          actor: {
            label: "Speaker 1",
            role: "SPEAKER",
            text: "Speaker 1 作出了决定",
            evidenceSegmentIds: ["segment_2"]
          }
        }]
      })
    );
    expect(normalized.items[0]).toMatchObject({
      kind: "decision",
      coreText: "会议决定下周一上线",
      evidenceSegmentIds: ["segment_2"],
      decisionFinality: { value: "final" },
      actor: { role: "speaker" }
    });
    expect(WorkExtractorWireResponseSchema.safeParse(
      normalizeWorkExtractorWireResponse({
        items: [{ kind: "discussion_topic" }]
      })
    ).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [{
        kind: "discussion_topic",
        coreText: "讨论了上线日期",
        evidenceSegmentIds: ["segment_1"],
        claims: [{ claimType: "topic", text: "讨论了上线日期", evidenceIds: ["segment_1"] }]
      }]
    }).success).toBe(false);
  });

  it("preserves a commitment when one optional date value is null without inferring a date", () => {
    const response = { items: [{
      kind: "commitment", coreText: "周五前完成隔离测试，涉及敏感内容则取消。",
      evidenceSegmentIds: ["segment_2"],
      deadline: { dueAt: null, originalDueExpression: "周五前", text: "周五前完成",
        evidenceSegmentIds: ["segment_2"] }
    }] };
    const onItemDiscarded = vi.fn();
    const parsed = validateWorkExtractorWireItems({ response, allowedSegments: segments, onItemDiscarded });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].claims[0].text).toBe(response.items[0].coreText);
    expect(parsed.items[0].claims.find((claim) => claim.claimType === "deadline")?.semanticValue)
      .toEqual({ kind: "deadline", dueAt: null, originalDueExpression: "周五前" });
    expect(onItemDiscarded).not.toHaveBeenCalled();
    expect(response.items[0].deadline.dueAt).toBeNull();

    const absoluteDate = validateWorkExtractorWireItems({ allowedSegments: segments,
      response: { items: [{ ...response.items[0], deadline: {
        ...response.items[0].deadline, dueAt: "2026-09-11T09:00:00.000Z", originalDueExpression: null
      } }] }
    });
    expect(absoluteDate.items[0].claims.find((claim) => claim.claimType === "deadline")?.semanticValue)
      .toEqual({ kind: "deadline", dueAt: "2026-09-11T09:00:00.000Z", originalDueExpression: null });
  });

  it("still rejects missing dates, non-null malformed dates and invalid deadline Evidence", () => {
    const deadline = { dueAt: null, originalDueExpression: "周五前", text: "周五前完成",
      evidenceSegmentIds: ["segment_2"] };
    for (const invalidDeadline of [
      { ...deadline, originalDueExpression: null },
      { ...deadline, dueAt: "not-a-date" },
      { ...deadline, evidenceSegmentIds: ["other_meeting_segment"] }
    ]) {
      const onItemDiscarded = vi.fn();
      const parsed = validateWorkExtractorWireItems({ allowedSegments: segments, onItemDiscarded,
        response: { items: [{ kind: "commitment", coreText: "周五前完成隔离测试。",
          evidenceSegmentIds: ["segment_2"], deadline: invalidDeadline }] }
      });
      expect(parsed.items).toEqual([]);
      expect(onItemDiscarded).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the Provider wire compact and derives deterministic canonical fields server-side", () => {
    const normalized = normalizeWorkExtractorWireResponse({
      items: [{
        kind: "DECISION",
        coreText: "会议作出了下周一上线的决定",
        evidenceSegmentIds: ["segment_2"],
        decisionFinality: {
          value: "FINAL",
          text: "该决定是最终决定",
          evidenceSegmentIds: ["segment_2"]
        }
      }]
    });
    const parsed = WorkExtractorWireResponseSchema.parse(normalized);
    expect(parsed.items[0]).toEqual({
      kind: "decision",
      coreText: "会议作出了下周一上线的决定",
      evidenceSegmentIds: ["segment_2"],
      decisionFinality: {
        value: "final",
        text: "该决定是最终决定",
        evidenceSegmentIds: ["segment_2"]
      }
    });
    const canonical = canonicalizeWorkExtractorClientKeys(normalized).items[0]!;
    expect(canonical).toMatchObject({
      clientCandidateKey: "wire_candidate_1",
      title: "会议作出了下周一上线的决定",
      body: "会议作出了下周一上线的决定；该决定是最终决定",
      evidenceIds: ["segment_2"],
      structuredData: {
        decisionFinality: "final",
        rawActorLabel: null,
        candidateOwner: null,
        dueAt: null,
        originalDueExpression: null,
        actionBasis: null,
        relatedCommitmentCandidateId: null,
        planStages: []
      }
    });
    expect(canonical.claims).toMatchObject([{
      clientClaimKey: "wire_claim_1_main",
      semanticRiskFlags: [],
      semanticValue: null
    }, {
      clientClaimKey: "wire_claim_1_decision_finality",
      semanticRiskFlags: [],
      semanticValue: { kind: "decision_finality", value: "final" }
    }]);
    expect(() => validateWorkExtractorOutput({
      response: { items: [canonical] },
      allowedSegments: segments
    })).not.toThrow();

    const forbiddenDeterministicFields = [
      { clientCandidateKey: "candidate_1" },
      { title: "模型标题" },
      { body: "模型正文" },
      { evidenceIds: ["segment_2"] },
      { structuredData: {} },
      { claims: [{ claimType: "decision_existence" }] }
    ];
    for (const extra of forbiddenDeterministicFields) {
      expect(WorkExtractorWireResponseSchema.safeParse({
        items: [{ ...parsed.items[0], ...extra }]
      }).success).toBe(false);
    }
    expect(WORK_EXTRACTOR_MAX_ITEMS_PER_WINDOW).toBe(20);
    expect(WORK_EXTRACTOR_MAX_WIRE_ITEMS).toBe(20);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: Array.from({ length: WORK_EXTRACTOR_MAX_WIRE_ITEMS + 1 }, (_, index) => ({
        ...parsed.items[0],
        coreText: `${parsed.items[0]!.coreText} ${index + 1}`
      }))
    }).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.parse({ items: [] })).toEqual({ items: [] });
    expect(WorkExtractorWireResponseSchema.safeParse(
      normalizeWorkExtractorWireResponse({})
    ).success).toBe(false);

    expect(WorkVerifierWireResponseSchema.parse(normalizeWorkVerifierWireResponse({
      items: [{ claimId: "claim_1", supportVerdict: "UNVERIFIABLE" }]
    }))).toEqual({
      items: [{
        claimId: "claim_1",
        supportVerdict: "unverifiable",
        issueCodes: [],
        supportedEvidenceIds: []
      }]
    });
    expect(WorkVerifierWireResponseSchema.safeParse({
      items: Array.from({ length: 25 }, (_, index) => ({
        claimId: `claim_${index}`,
        supportVerdict: "unverifiable",
        issueCodes: [],
        supportedEvidenceIds: []
      }))
    }).success).toBe(false);
  });

  it("derives stable local keys, Candidate Evidence union, and strict commitment references", () => {
    const commitment = {
      kind: "commitment" as const,
      coreText: "Speaker 1 明确承诺完成上线准备",
      evidenceSegmentIds: ["segment_2"]
    };
    const action = {
      kind: "action_item" as const,
      coreText: "准备下周一上线",
      evidenceSegmentIds: ["segment_1"],
      actionBasis: "explicit_commitment" as const,
      relatedCommitmentItem: 1,
      acceptedCommitment: {
        text: "Speaker 1 接受了该行动",
        evidenceSegmentIds: ["segment_2"]
      }
    };
    const canonicalized = canonicalizeWorkExtractorClientKeys({
      items: [commitment, action]
    });
    expect(canonicalized.items.map((item) => item.clientCandidateKey)).toEqual([
      "wire_candidate_1", "wire_candidate_2"
    ]);
    expect(canonicalized.items.map((item) => item.claims[0]?.clientClaimKey)).toEqual([
      "wire_claim_1_main", "wire_claim_2_main"
    ]);
    expect(canonicalized.items[1]?.structuredData.relatedCommitmentCandidateId).toBe(
      "wire_candidate_1"
    );
    expect(canonicalized.items[1]?.evidenceIds).toEqual(["segment_1", "segment_2"]);
    expect(() => validateWorkExtractorOutput({
      response: canonicalized,
      allowedSegments: segments
    })).not.toThrow();

    expect(() => canonicalizeWorkExtractorClientKeys({
      items: [commitment, { ...action, relatedCommitmentItem: 2 }]
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_evidence_closure_invalid"
    }));
  });

  it("preserves optional semantics but routes only core high-risk Claims", () => {
    const canonical = canonicalizeWorkExtractorClientKeys({
      items: [{
        kind: "decision",
        coreText: "因为质量门通过，所以决定下周一上线",
        evidenceSegmentIds: ["segment_2"],
        causality: true,
        decisionFinality: {
          value: "final",
          text: "上线决定已经最终确定",
          evidenceSegmentIds: ["segment_2"]
        },
        actor: {
          label: "Speaker 1",
          role: "speaker",
          text: "Speaker 1 作出了该决定",
          evidenceSegmentIds: ["segment_2"]
        },
        deadline: {
          dueAt: "2026-09-08T09:00:00.000Z",
          originalDueExpression: "下周一",
          text: "上线日期是下周一",
          evidenceSegmentIds: ["segment_2"]
        }
      }, {
        kind: "commitment",
        coreText: "Speaker 1 明确承诺完成准备",
        evidenceSegmentIds: ["segment_2"],
        actor: {
          label: "Speaker 1",
          role: "owner",
          text: "Speaker 1 是该承诺的负责人",
          evidenceSegmentIds: ["segment_2"]
        }
      }, {
        kind: "action_item",
        coreText: "完成上线准备",
        evidenceSegmentIds: ["segment_2"],
        actionBasis: "explicit_commitment",
        relatedCommitmentItem: 2,
        acceptedCommitment: {
          text: "该行动来自明确承诺",
          evidenceSegmentIds: ["segment_2"]
        }
      }, {
        kind: "plan_change",
        coreText: "方案从本周五改为下周一",
        evidenceSegmentIds: ["segment_1", "segment_2"],
        planStages: [{
          content: "原计划本周五上线",
          status: "revised",
          evidenceSegmentIds: ["segment_1"]
        }, {
          content: "当前计划下周一上线",
          status: "current",
          evidenceSegmentIds: ["segment_2"]
        }]
      }]
    });

    const decision = canonical.items[0]!;
    expect(decision.structuredData).toMatchObject({
      decisionFinality: "final",
      rawActorLabel: "Speaker 1",
      dueAt: "2026-09-08T09:00:00.000Z",
      originalDueExpression: "下周一"
    });
    expect(decision.claims.find((claim) => claim.claimType === "deadline")?.semanticValue)
      .toEqual({
        kind: "deadline",
        dueAt: "2026-09-08T09:00:00.000Z",
        originalDueExpression: "下周一"
      });
    expect(canonical.items[1]?.structuredData).toMatchObject({
      candidateOwner: "Speaker 1",
      actionBasis: "explicit_commitment"
    });
    expect(canonical.items[2]?.structuredData.relatedCommitmentCandidateId)
      .toBe("wire_candidate_2");
    expect(canonical.items[3]?.structuredData.planStages).toHaveLength(2);

    const routedTypes = canonical.items.flatMap((candidate) =>
      candidate.claims.filter(requiresWorkClaimGptVerification).map((claim) => claim.claimType)
    );
    expect(routedTypes).toEqual([
      "decision_existence",
      "commitment_existence",
      "action_item",
      "commitment_existence",
      "plan_change"
    ]);
    expect(decision.claims[0]?.semanticRiskFlags).toEqual(["causality"]);
    expect(() => validateWorkExtractorOutput({
      response: canonical,
      allowedSegments: segments
    })).not.toThrow();
  });

  it("rejects compact over-extraction and resolved-question wire shapes", () => {
    const proposal = {
      kind: "proposal",
      coreText: "可以考虑下周一上线",
      evidenceSegmentIds: ["segment_1"]
    };
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [{
        ...proposal,
        claims: [{ claimType: "proposal", text: proposal.coreText }]
      }]
    }).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [proposal, proposal]
    }).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [{
        ...proposal,
        evidenceSegmentIds: ["segment_1", "segment_1"]
      }]
    }).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [{
        kind: "open_question",
        coreText: "是否下周一上线",
        evidenceSegmentIds: ["segment_1"],
        questionResolution: {
          text: "该问题随后已解决",
          evidenceSegmentIds: ["segment_2"]
        }
      }]
    }).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [{
        kind: "plan_change",
        coreText: "方案发生变化",
        evidenceSegmentIds: ["segment_2"],
        planStages: [{
          content: "只有当前方案",
          status: "current",
          evidenceSegmentIds: ["segment_2"]
        }]
      }]
    }).success).toBe(false);
    const sharedEvidencePlanChange = {
      kind: "plan_change" as const,
      coreText: "开放日从九月十八日改为九月二十二日",
      evidenceSegmentIds: ["segment_2"],
      planStages: [{
        content: "原开放日为九月十八日",
        status: "revised" as const,
        evidenceSegmentIds: ["segment_2"]
      }, {
        content: "当前开放日为九月二十二日",
        status: "current" as const,
        evidenceSegmentIds: ["segment_2"]
      }]
    };
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [sharedEvidencePlanChange]
    }).success).toBe(true);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [{
        ...sharedEvidencePlanChange,
        planStages: [
          sharedEvidencePlanChange.planStages[0],
          {
            ...sharedEvidencePlanChange.planStages[0],
            evidenceSegmentIds: ["segment_1"]
          }
        ]
      }]
    }).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [{
        kind: "action_item",
        coreText: "准备上线",
        evidenceSegmentIds: ["segment_2"],
        actionBasis: "explicit_commitment"
      }]
    }).success).toBe(false);
    expect(WorkExtractorWireResponseSchema.safeParse({
      items: [{
        kind: "action_item",
        coreText: "准备上线",
        evidenceSegmentIds: ["segment_2"],
        actionBasis: "suggested_action",
        acceptedCommitment: {
          text: "Speaker 1 接受该行动",
          evidenceSegmentIds: ["segment_2"]
        }
      }]
    }).success).toBe(false);
  });

  it.each(["schema", "json", "timeout", "capture_write_failure", "success"])(
    "captures evaluation %s once without changing failure classification or ordinary logs", async (scenario) => {
      const logs = vi.fn();
      const captureFailure = vi.fn(async () => {
        if (scenario === "capture_write_failure") throw new Error("PRIVATE_DISK_ERROR");
      });
      const request = createWorkStructuredJsonRequest({
        getRuntimeConfig: vi.fn(async () => ({})),
        createClient: vi.fn(() => new OpenAI({ apiKey: "fixture", dangerouslyAllowBrowser: true })),
        log: logs, captureFailure,
        parseResponse: async (input) => {
          if (scenario === "timeout") throw new APIConnectionTimeoutError();
          input.onResponseText?.({ rawResponse: "PRIVATE_MODEL_ANSWER", state: "complete" });
          if (scenario === "success") return { items: [] };
          input.onDiagnostics?.({ responseTextLength: 20,
            parseResult: scenario === "json" ? "failed" : "success",
            validationResult: scenario === "json" ? "not_started" : "failed",
            validationIssueCount: scenario === "json" ? 0 : 1,
            validationIssues: scenario === "json" ? [] : [{ path: "items", code: "too_big", message: "PRIVATE_MESSAGE" }]
          });
          throw scenario === "json" ? new StructuredJsonResponseError("invalid_json", "bad JSON")
            : new Error("PRIVATE_SCHEMA_ERROR");
        }
      });
      const result = request({ stage: "extractor", profile, name: profile.schemaVersion,
        schema: WorkExtractorWireEnvelopeSchema, requestInput: "PRIVATE_TRANSCRIPT", jsonInstruction: "Return JSON" });
      if (scenario === "success") {
        await expect(result).resolves.toEqual({ items: [] });
        expect(captureFailure).not.toHaveBeenCalled();
      } else {
        const code = scenario === "timeout" ? "work_analysis_provider_timeout"
          : scenario === "json" ? "work_analysis_provider_invalid_json" : "work_extractor_output_invalid";
        await expect(result).rejects.toMatchObject({ code });
        expect(captureFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          requestTraceId: expect.any(String), stage: "extractor", errorCode: code,
          response: scenario === "timeout" ? null : { rawResponse: "PRIVATE_MODEL_ANSWER", state: "complete" },
          requestInput: "PRIVATE_TRANSCRIPT"
        }));
        expect(logs).toHaveBeenLastCalledWith("request_finished", expect.objectContaining({
          errorCode: code, failureCaptureState: scenario === "capture_write_failure" ? "write_failed" : "saved"
        }));
      }
      expect(JSON.stringify(logs.mock.calls)).not.toContain("PRIVATE_");
    }
  );

  it.each(["cancelled", "deadline"])("retains partial answer for parent %s without logging private input", async (mode) => {
    const controller = new AbortController(), logs = vi.fn(), captureFailure = vi.fn(async () => undefined);
    const reason = mode === "deadline" ? new DOMException("PRIVATE_REASON", "TimeoutError") : new Error("PRIVATE_REASON");
    const request = createWorkStructuredJsonRequest({
      getRuntimeConfig: vi.fn(async () => ({})),
      createClient: vi.fn(() => new OpenAI({ apiKey: "fixture", dangerouslyAllowBrowser: true })),
      log: logs, captureFailure,
      parseResponse: async input => {
        input.onResponseText?.({ rawResponse: '{"groups":[', state: "partial" });
        controller.abort(reason); throw reason;
      }
    });
    await expect(request({ stage: "deduplicator", profile, name: "organization",
      schema: WorkExtractorWireEnvelopeSchema, requestInput: "PRIVATE_TRANSCRIPT", jsonInstruction: "JSON",
      signal: controller.signal })).rejects.toBe(reason);
    expect(captureFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      response: { rawResponse: '{"groups":[', state: "partial" },
      errorCode: mode === "deadline" ? "work_analysis_provider_timeout" : "work_analysis_provider_cancelled"
    }));
    expect(logs).toHaveBeenLastCalledWith("request_finished", expect.objectContaining({ state: "cancelled", failureCaptureState: "saved" }));
    expect(JSON.stringify(logs.mock.calls)).not.toContain("PRIVATE_");
  });

  it("uses one JSON Responses request with zero retries, omits default reasoning, and logs only safe diagnostics", async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const createClient = vi.fn(() => new OpenAI({ apiKey: "fixture", dangerouslyAllowBrowser: true }));
    const parseResponse = vi.fn(async (
      request: Parameters<typeof parseStructuredJsonResponse>[0]
    ) => {
      request.onDiagnostics?.({
        responseStatus: "completed",
        responseTextLength: 321,
        parseResult: "success",
        validationResult: "success",
        responseCompleteDurationMs: 25,
        firstEventMs: 3,
        firstTextDeltaMs: 10,
        reasoningTokens: 4,
        // Deliberately poison the typed callback to exercise the runtime log boundary.
        reasoningEffort: "private reasoning metadata" as never,
        providerErrorCode: "private provider error" as never,
        totalDurationMs: 27,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        validationIssues: [{
          path: "items[0].title",
          code: "invalid_type",
          message: "private raw model value"
        }]
      });
      return { items: [] };
    });
    const request = createWorkStructuredJsonRequest({
      getRuntimeConfig: vi.fn(async () => ({})),
      createClient,
      parseResponse,
      now: (() => {
        let value = 1_000;
        return () => value += 10;
      })(),
      log: (event, fields) => logs.push({ event, fields })
    });
    const providerDefaultProfile: WorkReviewAnalysisProviderProfile = {
      ...profile,
      reasoningEffort: "provider_default"
    };

    await expect(request({
      stage: "extractor",
      profile: providerDefaultProfile,
      name: "work_meeting_candidates_v1",
      schema: WorkExtractorWireResponseSchema,
      requestInput: [{ role: "user", content: "private transcript marker" }],
      jsonInstruction: "return JSON",
      normalize: normalizeWorkExtractorWireResponse
    })).resolves.toEqual({ items: [] });

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: profile.timeoutMs,
      maxRetries: 0
    }));
    const parserRequest = parseResponse.mock.calls[0]?.[0];
    expect(parserRequest).toMatchObject({
      mode: "json",
      stream: true,
      maxOutputTokens: profile.maxOutputTokens,
      requestOptions: {
        timeout: profile.timeoutMs,
        maxRetries: 0,
        signal: expect.any(AbortSignal)
      },
      normalize: normalizeWorkExtractorWireResponse
    });
    expect(parserRequest).not.toHaveProperty("reasoning");
    expect(logs.map((entry) => entry.event)).toEqual(["request_started", "request_finished"]);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain("private transcript marker");
    expect(serializedLogs).not.toContain("private raw model value");
    expect(serializedLogs).not.toContain("private reasoning metadata");
    expect(serializedLogs).not.toContain("private provider error");
    expect(logs.at(-1)?.fields.diagnostics).toMatchObject({
      firstEventMs: 3, firstTextDeltaMs: 10, reasoningTokens: 4, reasoningEffort: "other", providerErrorCode: "other"
    });
    expect(serializedLogs).toContain("items[0].title");
    expect(serializedLogs).toContain("invalid_type");
  });

  it("uses the explicit DeepSeek client without consulting saved OpenAI routing", async () => {
    const getRuntimeConfig = vi.fn(async () => { throw new Error("must not read other provider settings"); });
    const createClient = vi.fn(() => { throw new Error("must not use OpenAI credentials"); });
    const createDeepSeekClient = vi.fn(() => new OpenAI({ apiKey: "fixture", dangerouslyAllowBrowser: true }));
    const parseResponse = vi.fn(async (_input: Parameters<typeof parseStructuredJsonResponse>[0]) => ({ items: [] }));
    const deepSeekProfile: WorkReviewAnalysisProviderProfile = {
      ...profile, provider: "deepseek-structured-json", model: "deepseek-v4-flash", reasoningEffort: "none"
    };
    const request = createWorkStructuredJsonRequest({
      getRuntimeConfig, createClient, createDeepSeekClient, parseResponse, log: () => undefined
    });
    await expect(request({
      stage: "verifier", profile: deepSeekProfile, name: "work_meeting_verifier_v1",
      schema: WorkVerifierWireEnvelopeSchema, requestInput: "private evidence", jsonInstruction: "return JSON"
    })).resolves.toEqual({ items: [] });
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(createDeepSeekClient).toHaveBeenCalledExactlyOnceWith({ profile: deepSeekProfile });
    expect(parseResponse).toHaveBeenCalledOnce();
    expect(parseResponse.mock.calls[0]?.[0]).toMatchObject({
      model: "deepseek-v4-flash", stream: true, mode: "json", reasoning: { effort: "none" },
      requestOptions: { maxRetries: 0, timeout: profile.timeoutMs }
    });
  });

  it.each(["extractor", "verifier"] as const)("routes TokenHub %s through its explicit client and forwards none", async (stage) => {
    const getRuntimeConfig = vi.fn(async () => { throw new Error("must not read saved provider routing"); });
    const createClient = vi.fn(() => { throw new Error("must not use shared client"); });
    const createDeepSeekClient = vi.fn(() => { throw new Error("must not use official DeepSeek credentials"); });
    const createTokenHubClient = vi.fn(() => new OpenAI({ apiKey: "fixture", dangerouslyAllowBrowser: true }));
    const parseResponse = vi.fn(async (_input: Parameters<typeof parseStructuredJsonResponse>[0]) => ({ items: [] }));
    const tokenHubProfile: WorkReviewAnalysisProviderProfile = {
      ...profile, provider: "tokenhub-structured-json", model: "deepseek-v4-pro", reasoningEffort: "none"
    };
    const request = createWorkStructuredJsonRequest({
      getRuntimeConfig, createClient, createDeepSeekClient, createTokenHubClient, parseResponse, log: () => undefined
    });
    await request({ stage, profile: tokenHubProfile, name: "work_tokenhub_fixture",
      schema: WorkVerifierWireEnvelopeSchema, requestInput: "private evidence", jsonInstruction: "return JSON" });
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(createDeepSeekClient).not.toHaveBeenCalled();
    expect(createTokenHubClient).toHaveBeenCalledExactlyOnceWith({ profile: tokenHubProfile });
    expect(parseResponse).toHaveBeenCalledOnce();
    expect(parseResponse.mock.calls[0]?.[0]).toMatchObject({
      model: "deepseek-v4-pro", stream: true, mode: "json", reasoning: { effort: "none" },
      requestOptions: { maxRetries: 0, timeout: profile.timeoutMs }
    });
  });

  it.each([
    { ...profile, reasoningEffort: "none" },
    { ...profile, provider: "unknown-provider" }
  ])("rejects unsupported direct profiles before credentials or network access", async (invalidProfile) => {
    const getRuntimeConfig = vi.fn();
    const createClient = vi.fn();
    const createDeepSeekClient = vi.fn();
    const parseResponse = vi.fn();
    const request = createWorkStructuredJsonRequest({ getRuntimeConfig, createClient, createDeepSeekClient, parseResponse });
    await expect(request({
      stage: "extractor", profile: invalidProfile as WorkReviewAnalysisProviderProfile,
      name: "work_meeting_candidates_v1", schema: WorkExtractorWireEnvelopeSchema,
      requestInput: "private evidence", jsonInstruction: "return JSON"
    })).rejects.toBeInstanceOf(WorkReviewRuntimeConfigError);
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(createDeepSeekClient).not.toHaveBeenCalled();
    expect(parseResponse).not.toHaveBeenCalled();
  });

  it("renders nested issue paths and codes in the default log without provider-sensitive fields", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const issueMessageMarker = "PRIVATE_ISSUE_MESSAGE";
    const rawResponseMarker = "PRIVATE_RAW_RESPONSE";
    const transcriptMarker = "PRIVATE_TRANSCRIPT";
    const endpointMarker = "https://private-endpoint.example/v1";
    const secretMarker = "PRIVATE_API_SECRET";
    const providerFailure = Object.assign(new Error(rawResponseMarker), {
      response: { data: rawResponseMarker },
      request: { url: endpointMarker },
      config: { apiKey: secretMarker }
    });

    try {
      const request = createWorkStructuredJsonRequest({
        getRuntimeConfig: vi.fn(async () => ({
          openAiApiKey: secretMarker,
          openAiBaseUrl: endpointMarker
        })),
        createClient: vi.fn(() => new OpenAI({ apiKey: "fixture", dangerouslyAllowBrowser: true })),
        parseResponse: vi.fn(async (providerRequest) => {
          providerRequest.onDiagnostics?.({
            responseTextLength: rawResponseMarker.length,
            parseResult: "success",
            validationResult: "failed",
            validationIssueCount: 1,
            validationIssues: [{
              path: "items[0].claims[1].evidenceIds[2]",
              code: "invalid_type",
              message: issueMessageMarker
            }]
          });
          throw providerFailure;
        })
      });

      await expect(request({
        stage: "extractor",
        profile: { ...profile, reasoningEffort: "provider_default" },
        name: "work_meeting_candidates_v1",
        schema: WorkExtractorWireResponseSchema,
        requestInput: transcriptMarker,
        jsonInstruction: "return JSON"
      })).rejects.toMatchObject({ code: "work_extractor_output_invalid" });

      expect(info).toHaveBeenCalledTimes(2);
      expect(info.mock.calls.every((call) => call.length === 1)).toBe(true);
      const rendered = info.mock.calls.map(([line]) => String(line)).join("\n");
      const finished = rendered
        .split("\n")
        .find((line) => line.startsWith("[work-review-provider] request_finished "));
      expect(finished).toBeDefined();
      const payload = JSON.parse(
        finished!.slice("[work-review-provider] request_finished ".length)
      );
      expect(payload).toMatchObject({
        state: "failed",
        errorCode: "work_extractor_output_invalid",
        diagnostics: {
          validationIssues: [{
            path: "items[0].claims[1].evidenceIds[2]",
            code: "invalid_type"
          }]
        }
      });
      expect(payload.diagnostics.validationIssues[0]).not.toHaveProperty("message");
      for (const marker of [
        issueMessageMarker,
        rawResponseMarker,
        transcriptMarker,
        endpointMarker,
        secretMarker
      ]) {
        expect(rendered).not.toContain(marker);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("wraps parser validation failures at the production request boundary", async () => {
    const schemaFailure = WorkExtractorWireResponseSchema.safeParse({
      items: [{ kind: 123 }]
    });
    expect(schemaFailure.success).toBe(false);
    if (schemaFailure.success) throw new Error("expected schema failure");
    const logs: Array<Record<string, unknown>> = [];
    const request = createWorkStructuredJsonRequest({
      getRuntimeConfig: vi.fn(async () => ({})),
      createClient: vi.fn(() => new OpenAI({ apiKey: "fixture", dangerouslyAllowBrowser: true })),
      parseResponse: vi.fn(async (providerRequest) => {
        providerRequest.onDiagnostics?.({
          responseTextLength: 42,
          parseResult: "success",
          validationResult: "failed",
          validationIssueCount: 1,
          validationIssues: [{
            path: "items[0].kind",
            code: "invalid_type",
            message: "private model value"
          }]
        });
        throw schemaFailure.error;
      }),
      log: (_event, fields) => logs.push(fields)
    });

    await expect(request({
      stage: "extractor",
      profile: { ...profile, reasoningEffort: "provider_default" },
      name: "work_meeting_candidates_v1",
      schema: WorkExtractorWireResponseSchema,
      requestInput: "private transcript marker",
      jsonInstruction: "return JSON"
    })).rejects.toMatchObject({
      code: "work_extractor_output_invalid",
      safeDiagnostics: {
        validationIssueCount: 1,
        validationIssues: [{ path: "items[0].kind", code: "invalid_type" }]
      }
    });
    expect(JSON.stringify(logs)).not.toContain("private transcript marker");
    expect(JSON.stringify(logs)).not.toContain("private model value");
    expect(logs.at(-1)).toMatchObject({
      state: "failed",
      errorCode: "work_extractor_output_invalid"
    });
  });

  it.each([
    ["server_error", "work_analysis_provider_transient_unavailable"],
    ["rate_limit_exceeded", "work_analysis_provider_rate_limited"],
    ["invalid_prompt", "work_analysis_provider_incomplete"],
    ["other", "work_analysis_provider_incomplete"],
    [undefined, "work_analysis_provider_incomplete"]
  ] as const)("classifies explicit stream failure %s without retrying missing or unknown termination", (providerErrorCode, code) => {
    const failure = classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: new StructuredJsonResponseError("incomplete_response", "PRIVATE_UPSTREAM_MESSAGE"),
      diagnostics: { responseTextLength: 0, parseResult: "not_started", validationResult: "not_started", providerErrorCode }
    });
    expect(failure.code).toBe(code);
    expect(JSON.stringify(failure.safeDiagnostics)).not.toContain("PRIVATE_UPSTREAM_MESSAGE");
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor", error: failure, timedOut: false
    })).toBe(failure);
  });

  it("classifies provider failures into stable Work-owned codes without exposing response text", () => {
    const schemaFailure = WorkExtractorWireResponseSchema.safeParse({
      items: [{ kind: 123 }]
    });
    expect(schemaFailure.success).toBe(false);
    if (schemaFailure.success) throw new Error("expected schema failure");

    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: schemaFailure.error
    })).toMatchObject({ code: "work_extractor_output_invalid" });
    expect(classifyWorkAnalysisProviderError({
      stage: "verifier",
      error: schemaFailure.error
    })).toMatchObject({ code: "work_verifier_output_invalid" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: new StructuredJsonResponseError("incomplete_json", "private truncated body")
    })).toMatchObject({ code: "work_analysis_provider_incomplete" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: new StructuredJsonResponseError("invalid_json", "private invalid body")
    })).toMatchObject({ code: "work_analysis_provider_invalid_json" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: { name: "BadRequestError", status: 400, message: "private provider body" }
    })).toMatchObject({ code: "work_analysis_provider_request_rejected" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: { name: "AuthenticationError", status: 401, message: "private auth body" }
    })).toMatchObject({ code: "work_analysis_provider_request_rejected" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: { name: "PermissionDeniedError", status: 403, message: "private permission body" }
    })).toMatchObject({ code: "work_analysis_provider_request_rejected" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: { name: "RateLimitError", status: 429, message: "private rate body" }
    })).toMatchObject({ code: "work_analysis_provider_rate_limited" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: { name: "InternalServerError", status: 503, message: "private server body" }
    })).toMatchObject({ code: "work_analysis_provider_transient_unavailable" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: new APIConnectionError({ message: "private connection body" })
    })).toMatchObject({ code: "work_analysis_provider_transient_unavailable" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: new Error("private unknown body")
    })).toMatchObject({ code: "work_analysis_provider_unavailable" });
    expect(classifyWorkAnalysisProviderError({
      stage: "extractor",
      error: new Error("private timeout body"),
      timedOut: true
    })).toMatchObject({ code: "work_analysis_provider_timeout" });

    const safe = safeWorkAnalysisProviderDiagnostics({
      responseStatus: "private_status",
      incompleteReason: "private_reason",
      responseTextLength: 10,
      parseResult: "success",
      validationResult: "failed",
      validationIssues: [{
        path: "items[0].title/private",
        code: "invalid_type",
        message: "private raw value"
      }]
    });
    expect(safe).toMatchObject({
      responseStatus: "other",
      incompleteReason: "other",
      validationIssues: [{ path: "items[0].title_private", code: "invalid_type" }]
    });
    expect(JSON.stringify(safe)).not.toContain("private raw value");
  });

  it("requires exact verifier Claim closure and canonical supported Evidence", () => {
    const claims = [WorkAtomicClaimSchema.parse({
      id: "claim_1",
      candidateId: "candidate_1",
      claimType: "decision_existence",
      text: "会议作出了决定",
      evidenceIds: ["segment_2"],
      createdAt: null
    })];
    expect(() => validateWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: { items: [] }
    })).toThrow("exactly one evaluation");
    expect(() => validateWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: {
        items: [{
          claimId: "claim_1",
          supportVerdict: "entailed",
          issueCodes: [],
          supportedEvidenceIds: ["segment_1"]
        }]
      }
    })).toThrow("subset of the Claim allowlist");
    for (const issueCode of [
      "fixture_result_unverifiable",
      "verifier_disabled",
      "verifier_not_required_non_high_risk",
      "gpt_verifier_routed_causality",
      `gpt_verifier_input_semantic_value_sha256_${"a".repeat(64)}`
    ]) {
      expect(() => validateWorkVerifierOutput({
        claims,
        allowedSegments: segments,
        response: {
          items: [{
            claimId: "claim_1",
            supportVerdict: "unverifiable",
            issueCodes: [issueCode],
            supportedEvidenceIds: []
          }]
        }
      })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
        code: "work_verifier_output_invalid"
      }));
    }
    expect(validateWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: {
        items: [{
          claimId: "claim_1",
          supportVerdict: "unsupported",
          issueCodes: ["proposal_promoted_to_decision"],
          supportedEvidenceIds: []
        }]
      }
    }).items[0]?.issueCodes).toEqual(["proposal_promoted_to_decision"]);
  });

  it("validates more than 256 batched Verifier results as one exact canonical aggregate", () => {
    const claims = Array.from({ length: 320 }, (_, index) => WorkAtomicClaimSchema.parse({
      id: `aggregate_claim_${index}`,
      candidateId: `aggregate_candidate_${Math.floor(index / 64)}`,
      claimType: "topic",
      text: `会议原子事实 ${index}`,
      evidenceIds: ["segment_2"],
      createdAt: null
    }));
    const batches = Array.from({ length: Math.ceil(claims.length / 12) }, (_, batchIndex) =>
      claims.slice(batchIndex * 12, (batchIndex + 1) * 12)
    );
    const validatedBatchItems = batches.flatMap((batch) => {
      const response = WorkVerifierWireResponseSchema.parse({
        items: [...batch].reverse().map((claim) => ({
          claimId: claim.id,
          supportVerdict: "entailed",
          issueCodes: [],
          supportedEvidenceIds: ["segment_2"]
        }))
      });
      return validateWorkVerifierOutput({
        response,
        claims: batch,
        allowedSegments: segments
      }).items;
    });

    expect(batches).toHaveLength(27);
    expect(batches.every((batch) => batch.length <= 12)).toBe(true);
    expect(new Set(validatedBatchItems.map((item) => item.claimId)).size).toBe(claims.length);
    expect(() => validateWorkVerifierOutput({
      response: { items: validatedBatchItems },
      claims,
      allowedSegments: segments
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_verifier_output_invalid"
    }));

    const aggregated = validateAggregatedWorkVerifierOutput({
      response: { items: validatedBatchItems },
      claims,
      allowedSegments: segments
    });
    expect(aggregated.items).toHaveLength(claims.length);
    expect(aggregated.items.map((item) => item.claimId)).toEqual(claims.map((claim) => claim.id));
    expect(new Set(aggregated.items.map((item) => item.claimId)).size).toBe(claims.length);

    const duplicated = [...validatedBatchItems];
    duplicated[1] = duplicated[0];
    expect(() => validateAggregatedWorkVerifierOutput({
      response: { items: duplicated },
      claims,
      allowedSegments: segments
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_evidence_closure_invalid"
    }));
    expect(() => validateAggregatedWorkVerifierOutput({
      response: { items: validatedBatchItems.slice(0, -1) },
      claims,
      allowedSegments: segments
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_evidence_closure_invalid"
    }));

    const illegalEvidence = validatedBatchItems.map((item, index) => index === 0 ? {
      ...item,
      supportedEvidenceIds: ["segment_1"]
    } : item);
    expect(() => validateAggregatedWorkVerifierOutput({
      response: { items: illegalEvidence },
      claims,
      allowedSegments: segments
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_evidence_not_allowed"
    }));

    const invalidItemShape = validatedBatchItems.map((item, index) => index === 0 ? {
      ...item,
      providerNarrative: "must not enter canonical aggregate"
    } : item);
    expect(() => validateAggregatedWorkVerifierOutput({
      response: { items: invalidItemShape },
      claims,
      allowedSegments: segments
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_verifier_output_invalid"
    }));
  });

  it("aggregates 25 independently bounded Verifier results and keeps omitted results local", () => {
    const claims = Array.from({ length: 25 }, (_, index) => WorkAtomicClaimSchema.parse({
      id: `partial_aggregate_claim_${index}`,
      candidateId: `partial_aggregate_candidate_${index}`,
      claimType: "decision_existence",
      text: `独立决定 ${index}`,
      evidenceIds: ["segment_2"],
      createdAt: null
    }));
    const batchItems = [claims.slice(0, 8), claims.slice(8)].map((batch) =>
      validatePartialWorkVerifierOutput({
        claims: batch,
        allowedSegments: segments,
        response: {
          items: [...batch].reverse().map((claim) => ({
            claimId: claim.id,
            supportVerdict: "entailed",
            issueCodes: [],
            supportedEvidenceIds: ["segment_2"]
          }))
        }
      }).items
    );
    const items = batchItems.flat();
    expect(batchItems.map((batch) => batch.length)).toEqual([8, 17]);
    expect(() => validatePartialWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: { items }
    })).toThrowError(expect.objectContaining({ code: "work_verifier_output_invalid" }));
    expect(validateAggregatedWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: { items },
      requireComplete: false
    }).items.map((item) => item.claimId)).toEqual(claims.map((claim) => claim.id));

    const omittedClaimId = claims[0]!.id;
    const incompleteResponse = { items: items.filter((item) => item.claimId !== omittedClaimId) };
    expect(validateAggregatedWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: incompleteResponse,
      requireComplete: false
    }).items.map((item) => item.claimId)).toEqual(claims.slice(1).map((claim) => claim.id));
    expect(() => validateAggregatedWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: incompleteResponse
    })).toThrowError(expect.objectContaining({ code: "work_evidence_closure_invalid" }));
  });

  it("keeps aggregate identity, Evidence, issue-code and strict-schema checks when missing results are allowed", () => {
    const claims = Array.from({ length: 3 }, (_, index) => WorkAtomicClaimSchema.parse({
      id: `partial_aggregate_claim_${index}`,
      candidateId: `partial_aggregate_candidate_${index}`,
      claimType: "decision_existence",
      text: `独立决定 ${index}`,
      evidenceIds: ["segment_2"],
      createdAt: null
    }));
    const validItem = {
      claimId: claims[0]!.id,
      supportVerdict: "entailed",
      issueCodes: [],
      supportedEvidenceIds: ["segment_2"]
    };
    const unsafeCases = [
      { items: [{ ...validItem, claimId: "claim_outside_aggregate" }], code: "work_evidence_closure_invalid" },
      { items: [validItem, validItem], code: "work_evidence_closure_invalid" },
      { items: [{ ...validItem, supportedEvidenceIds: ["segment_1"] }], code: "work_evidence_not_allowed" },
      { items: [{ ...validItem, supportedEvidenceIds: [] }], code: "work_evidence_closure_invalid" },
      { items: [{ ...validItem, issueCodes: ["provider_arbitrary_issue"] }], code: "work_verifier_output_invalid" },
      { items: [{ ...validItem, providerNarrative: "extra field" }], code: "work_verifier_output_invalid" },
      { items: [{ claimId: claims[0]!.id }], code: "work_verifier_output_invalid" },
      { items: Array.from({ length: 4 }, () => validItem), code: "work_verifier_output_invalid" }
    ];
    for (const { items, code } of unsafeCases) {
      expect(() => validateAggregatedWorkVerifierOutput({
        claims,
        allowedSegments: segments,
        response: { items },
        requireComplete: false
      })).toThrowError(expect.objectContaining({ code }));
    }
  });

  it("localizes missing or malformed Verifier items but rejects unsafe Claim identity and Evidence", () => {
    const claims = ["claim_partial_1", "claim_partial_2"].map((id, index) =>
      WorkAtomicClaimSchema.parse({
        id,
        candidateId: `candidate_partial_${index + 1}`,
        claimType: "decision_existence",
        text: `会议决定 ${index + 1}`,
        evidenceIds: ["segment_2"],
        createdAt: null
      })
    );
    expect(WorkVerifierWireEnvelopeSchema.parse({
      items: [{ claimId: claims[0]!.id }, { providerNarrative: "invalid" }]
    }).items).toHaveLength(2);
    expect(validatePartialWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: {
        items: [{
          claimId: claims[0]!.id,
          supportVerdict: "entailed",
          issueCodes: [],
          supportedEvidenceIds: ["segment_2"]
        }, {
          claimId: claims[1]!.id,
          supportVerdict: "entailed"
        }]
      }
    }).items.map((item) => item.claimId)).toEqual([claims[0]!.id]);

    for (const unsafeItems of [[{
      claimId: "claim_outside_batch",
      supportVerdict: "unverifiable",
      issueCodes: [],
      supportedEvidenceIds: []
    }], [{
      claimId: claims[0]!.id,
      supportVerdict: "unverifiable",
      issueCodes: [],
      supportedEvidenceIds: []
    }, {
      claimId: claims[0]!.id,
      supportVerdict: "unverifiable",
      issueCodes: [],
      supportedEvidenceIds: []
    }]]) {
      expect(() => validatePartialWorkVerifierOutput({
        claims,
        allowedSegments: segments,
        response: { items: unsafeItems }
      })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
        code: "work_evidence_closure_invalid"
      }));
    }
    expect(() => validatePartialWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: {
        items: [{
          claimId: claims[0]!.id,
          supportVerdict: "entailed",
          issueCodes: [],
          supportedEvidenceIds: ["segment_1"]
        }]
      }
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_evidence_not_allowed"
    }));
  });

  it("runs explicitly enabled non-production fixture profiles through configured factories offline", async () => {
    const requestStructuredJson = vi.fn(async () => {
      throw new Error("fixture analysis must not reach a provider request");
    });
    const providers = createConfiguredWorkMeetingAnalysisProviders({
      env: {
        NODE_ENV: "test",
        WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
        WORK_REVIEW_VERIFIER_PROVIDER: "fixture",
        WORK_REVIEW_FIXTURE_ANALYSIS_ENABLED: "true"
      },
      requestStructuredJson
    });
    const window = buildWorkMeetingTranscriptWindows(segments)[0];
    const claim = WorkAtomicClaimSchema.parse({
      id: "claim_1",
      candidateId: "candidate_1",
      claimType: "decision_existence",
      text: "会议作出了下周一上线的决定",
      evidenceIds: ["segment_2"],
      createdAt: null
    });

    await expect(providers.extractor.extract({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      window
    })).resolves.toEqual([]);
    await expect(providers.verifier.verify({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      segments,
      claims: [claim]
    })).resolves.toEqual({ items: [{
      claimId: "claim_1",
      supportVerdict: "unverifiable",
      issueCodes: [],
      supportedEvidenceIds: []
    }], coverage: [] });
    expect(requestStructuredJson).not.toHaveBeenCalled();
  });

  it("keeps configured fixture factories closed in production or without explicit enablement", () => {
    expect(() => createConfiguredWorkMeetingAnalysisProviders({
      env: {
        NODE_ENV: "production",
        WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
        WORK_REVIEW_VERIFIER_PROVIDER: "fixture",
        WORK_REVIEW_FIXTURE_ANALYSIS_ENABLED: "true"
      }
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_analysis_fixture_forbidden_in_production"
    }));
    expect(() => createConfiguredWorkMeetingAnalysisProviders({
      env: {
        NODE_ENV: "test",
        WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
        WORK_REVIEW_VERIFIER_PROVIDER: "fixture"
      }
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_analysis_fixture_not_explicitly_enabled"
    }));
  });

  it("keeps structured adapters closed to fixture profiles", () => {
    const fixtureProfile: WorkReviewAnalysisProviderProfile = {
      ...profile,
      provider: "fixture",
      model: "work-review-deterministic-fixture-v1"
    };
    expect(() => createStructuredWorkMeetingExtractor({ profile: fixtureProfile }))
      .toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
        code: "work_review_analysis_fixture_not_explicitly_enabled"
      }));
    expect(() => createStructuredWorkMeetingVerifier({ profile: fixtureProfile }))
      .toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
        code: "work_review_analysis_fixture_not_explicitly_enabled"
      }));
  });

  it("deduplicates verifier Evidence text and keeps internal publication metadata off the wire", () => {
    const claims = [
      WorkAtomicClaimSchema.parse({
        id: "claim_1",
        candidateId: "candidate_1",
        claimType: "decision_existence",
        semanticValue: null,
        text: "会议作出了决定",
        evidenceIds: ["segment_2"],
        createdAt: null
      }),
      WorkAtomicClaimSchema.parse({
        id: "claim_2",
        candidateId: "candidate_1",
        claimType: "decision_finality",
        semanticValue: { kind: "decision_finality", value: "final" },
        text: "该决定是最终决定",
        evidenceIds: ["segment_2"],
        createdAt: null
      })
    ];
    const payload = buildWorkMeetingVerifierProviderPayload({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      segments,
      claims,
      timestampQualityBySegmentId: { segment_2: "provider_exact" }
    });

    expect(Object.keys(payload.evidenceById)).toEqual(["segment_2"]);
    expect(payload.evidenceById.segment_2).toMatchObject({
      text: "最终就按下周一上线。",
      timestampQuality: "provider_exact"
    });
    expect(payload.items).toEqual([
      expect.objectContaining({
        claimId: "claim_1",
        semanticValue: null,
        evidenceIds: ["segment_2"]
      }),
      expect.objectContaining({
        claimId: "claim_2",
        semanticValue: { kind: "decision_finality", value: "final" },
        evidenceIds: ["segment_2"]
      })
    ]);
    expect(JSON.stringify(payload)).not.toContain("publication_1");
    expect(JSON.stringify(payload)).not.toContain("meeting_1");
    expect(payload.items[0]).not.toHaveProperty("evidence");
  });

  it("gives the verifier only atomic claims plus server-materialized Evidence", async () => {
    const verifierProfile = { ...profile, profileId: "work-meeting-verifier" };
    const claim = WorkAtomicClaimSchema.parse({
      id: "claim_1",
      candidateId: "candidate_1",
      claimType: "decision_existence",
      semanticValue: null,
      text: "会议作出了下周一上线的决定",
      evidenceIds: ["segment_2"],
      createdAt: null
    });
    let capturedRequest: Parameters<WorkStructuredJsonRequest>[0] | undefined;
    const requestStructuredJson: WorkStructuredJsonRequest = vi.fn(async (request) => {
      capturedRequest = request;
      return {
      items: [{
        claimId: "claim_1",
        supportVerdict: "entailed",
        issueCodes: [],
        supportedEvidenceIds: ["segment_2"]
      }]
      };
    });
    const verifier = createStructuredWorkMeetingVerifier({
      profile: verifierProfile,
      requestStructuredJson
    });
    await expect(verifier.verify({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      segments,
      claims: [claim]
    })).resolves.toEqual({ items: [{
      claimId: "claim_1",
      supportVerdict: "entailed",
      issueCodes: [],
      supportedEvidenceIds: ["segment_2"]
    }], coverage: [] });
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest).toMatchObject({
      stage: "verifier",
      schema: WorkVerifierWireEnvelopeSchema,
      normalize: normalizeWorkVerifierWireResponse
    });
    const requestInput = capturedRequest!.requestInput;
    expect(Array.isArray(requestInput)).toBe(true);
    const systemMessage = (requestInput as Array<{ content?: string }>)[0]!;
    expect(systemMessage.content).toContain("仅仅觉得可以拆得更细，不能返回 unsupported");
    expect(systemMessage.content).toContain("不得删掉重要限制使承诺扩大");
    expect(systemMessage.content).toContain("原文明确保留的未认领会后事项");
    expect(systemMessage.content).toContain("先推荐、后明确决定采用同一范围，支持决定存在");
    expect(systemMessage.content).toContain("支持证据必须包含实际采纳的段落");
    expect(systemMessage.content).toContain("明确撤回、实质范围不同或遗漏关键条件仍须拒绝");
    expect(systemMessage.content).toContain("不得仅因标签字面差异否定核心决定");
    expect(systemMessage.content).toContain("只有一个含糊标签而没有范围依据");
    const userMessage = (requestInput as Array<{ content?: string }>)[1]!;
    const providerPayload = JSON.parse(userMessage.content ?? "{}") as {
      evidenceById?: Record<string, { text?: string }>;
      items?: Array<Record<string, unknown>>;
    };
    expect(providerPayload.evidenceById?.segment_2?.text).toBe("最终就按下周一上线。");
    expect(providerPayload.items?.[0]).toMatchObject({
      claimId: "claim_1",
      semanticValue: null,
      evidenceIds: ["segment_2"]
    });
    expect(userMessage.content).not.toContain("会议中出现了明确决定表达");
    expect(userMessage.content).not.toContain("meeting_1");
    expect(userMessage.content).not.toContain("publication_1");
    expect(userMessage.content).not.toContain("a".repeat(64));
  });
});
