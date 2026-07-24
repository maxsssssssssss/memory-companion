import { describe, expect, it } from "vitest";

import type { RelationshipSignalCard, TranscriptSegment } from "@/lib/domain/types";
import {
  buildRelationshipSignalEvidence,
  isForbiddenRelationshipQaOutput,
  isRelationshipEvidenceQuestion
} from "./relationship-signal-evidence";

const segments: TranscriptSegment[] = [
  {
    id: "seg_boundary_1",
    uploadId: "upload_1",
    startSeconds: 12,
    endSeconds: 20,
    speaker: "speaker_1",
    text: "我今晚有点累，想先停一下，明天再继续聊。",
    confidence: 0.94,
    sceneLabels: ["unknown"],
    valueLabels: ["open_question"]
  },
  {
    id: "seg_boundary_2",
    uploadId: "upload_1",
    startSeconds: 20,
    endSeconds: 31,
    speaker: "speaker_2",
    text: "好，我听到了，我们先停一下，明天你愿意的时候再说。",
    confidence: 0.95,
    sceneLabels: ["unknown"],
    valueLabels: []
  }
];

function relationshipCard(overrides: Partial<RelationshipSignalCard> = {}): RelationshipSignalCard {
  return {
    id: "relationship_signal_upload_1_1",
    uploadId: "upload_1",
    date: "2026-07-09",
    signalType: "boundary_respect",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.82,
    summary: "边界表达后，对方接受了先暂停对话。",
    explanation: "这只说明当前片段里出现了尊重暂停需求的回应，不能推出长期结论。",
    involvedSpeakers: ["speaker_1", "speaker_2"],
    timeRange: { startSeconds: 999, endSeconds: 1000 },
    evidenceSegments: [
      {
        segmentId: "seg_boundary_1",
        speaker: "made_up_speaker",
        startSeconds: 999,
        endSeconds: 1000,
        text: "模型生成的错误证据"
      },
      {
        segmentId: "seg_boundary_2",
        startSeconds: 1000,
        endSeconds: 1001,
        text: "模型生成的另一条错误证据"
      }
    ],
    textEvidence: ["我想先停一下", "我们先停一下"],
    suggestedReflection: "可以继续观察类似边界表达是否也会被尊重。",
    createdAt: "2026-07-09T10:00:00.000Z",
    ...overrides
  };
}

describe("relationship signal QA evidence", () => {
  it("recognizes relationship questions but not ordinary summary or task questions", () => {
    expect(isRelationshipEvidenceQuestion({ question: "对方有没有认真听我说话？" })).toBe(true);
    expect(isRelationshipEvidenceQuestion({ question: "这次互动有哪些积极信号？" })).toBe(true);
    expect(isRelationshipEvidenceQuestion({ question: "有没有让我不舒服、需要澄清的地方？" })).toBe(true);
    expect(isRelationshipEvidenceQuestion({ question: "今天讨论了什么？" })).toBe(false);
    expect(isRelationshipEvidenceQuestion({ question: "这次有哪些下一步任务？" })).toBe(false);
    expect(isRelationshipEvidenceQuestion({ question: "产品经理否定了哪个方案？" })).toBe(false);
    expect(isRelationshipEvidenceQuestion({ question: "他有没有回应我的邮件？" })).toBe(false);
    expect(isRelationshipEvidenceQuestion({ question: "这个 boundary condition 怎么处理？" })).toBe(false);
    expect(isRelationshipEvidenceQuestion({ question: "接口是否尊重系统边界？" })).toBe(false);
  });

  it("inherits relationship intent only for a short follow-up", () => {
    const conversation = [
      { role: "user" as const, content: "这条需要澄清的关系信号，原文证据是什么？" },
      { role: "assistant" as const, content: "我可以只按录音证据回看。" }
    ];

    expect(isRelationshipEvidenceQuestion({ question: "为什么？", conversation })).toBe(true);
    expect(isRelationshipEvidenceQuestion({ question: "今天还有哪些任务需要跟进？", conversation })).toBe(false);
  });

  it("builds composite evidence from the card and real transcript segments", () => {
    const evidence = buildRelationshipSignalEvidence({
      question: "这次边界有没有被尊重？",
      cards: [relationshipCard()],
      segments
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      id: "relationship_signal_upload_1_1",
      kind: "relationship_signal",
      startSeconds: 12,
      endSeconds: 31,
      sourceSegmentIds: ["seg_boundary_1", "seg_boundary_2"]
    });
    expect(evidence[0].text).toContain("置信度：82%");
    expect(evidence[0].text).toContain("仅代表当前片段");
    expect(evidence[0].text).toContain(segments[0].text);
    expect(evidence[0].text).toContain(segments[1].text);
    expect(evidence[0].text).not.toContain("模型生成的错误证据");
  });

  it("formats trusted identities and keeps low-confidence identities local", () => {
    const trustedSegments: TranscriptSegment[] = [
      {
        ...segments[0],
        identity: {
          globalSpeakerId: "person_1",
          displayName: "Trusted contact",
          identityType: "known_contact",
          confidence: 0.95,
          source: "voiceprint"
        }
      },
      {
        ...segments[1],
        identity: {
          globalSpeakerId: "person_2",
          identityType: "unknown_person",
          confidence: 0.9,
          source: "cross_chunk_matching"
        }
      }
    ];
    const trustedEvidence = buildRelationshipSignalEvidence({
      question: "这次边界有没有被尊重？",
      cards: [relationshipCard()],
      segments: trustedSegments
    });

    expect(trustedEvidence[0].text).toContain("Trusted contact:");
    expect(trustedEvidence[0].text).toContain("person_2:");
    expect(trustedEvidence[0].text).not.toContain("speaker_1:");
    expect(trustedEvidence[0].text).not.toContain("speaker_2:");

    const lowConfidenceEvidence = buildRelationshipSignalEvidence({
      question: "这次边界有没有被尊重？",
      cards: [relationshipCard()],
      segments: trustedSegments.map((segment) => ({
        ...segment,
        identity: segment.identity ? { ...segment.identity, confidence: 0.79 } : undefined
      }))
    });
    expect(lowConfidenceEvidence[0].text).toContain("speaker_1:");
    expect(lowConfidenceEvidence[0].text).toContain("speaker_2:");
    expect(lowConfidenceEvidence[0].text).not.toContain("Trusted contact:");
    expect(lowConfidenceEvidence[0].text).not.toContain("person_2:");
  });

  it("does not load relationship cards for ordinary questions", () => {
    expect(
      buildRelationshipSignalEvidence({
        question: "这次有哪些下一步任务？",
        cards: [relationshipCard()],
        segments
      })
    ).toEqual([]);
  });

  it("drops cards when any referenced transcript segment is missing", () => {
    const evidence = buildRelationshipSignalEvidence({
      question: "这次边界有没有被尊重？",
      cards: [relationshipCard()],
      segments: [segments[0]]
    });

    expect(evidence).toEqual([]);
  });

  it("filters forbidden relationship judgments from cards and model answers", () => {
    const evidence = buildRelationshipSignalEvidence({
      question: "这次互动有哪些关系信号？",
      cards: [relationshipCard({ summary: "对方一定在操控你。" })],
      segments
    });

    expect(evidence).toEqual([]);
    expect(isForbiddenRelationshipQaOutput("你应该分手。")).toBe(true);
    expect(isForbiddenRelationshipQaOutput("对方在情感操纵你，建议离开这段关系。")).toBe(true);
    expect(isForbiddenRelationshipQaOutput("这段互动可能需要继续澄清，不能据此判断长期关系。")).toBe(false);
  });
});
