import { describe, expect, it } from "vitest";

import type { ProactiveEvidence, ProactiveInsight } from "@/lib/domain/proactive-insights";

import {
  ProactiveObservationSchema,
  SuggestedQuestionSchema,
  buildProactiveQaPresentation,
  normalizeSuggestedQuestionText
} from "./proactive-qa-presentation";
import type { ProactiveQaSuggestion } from "./proactive-qa-suggestions";

function evidence(): ProactiveEvidence {
  return {
    evidenceId: "relationship_signal:signal_1",
    kind: "relationship_signal",
    sourceType: "relationship_signal",
    sourceId: "signal_1",
    uploadId: "upload_1",
    recordingDate: "2026-07-10",
    sourceSegmentIds: ["seg_1"],
    timeRange: { startSeconds: 10, endSeconds: 20 },
    title: "线上争执后的处理方式",
    summary: "对话提到担心线上争执无法及时解决。",
    excerpt: "我有点担心线上吵起来的时候没办法及时说清楚。",
    confidence: 0.78,
    caution: "当前录音没有提供后续处理方式。",
    signalCategory: "uncertain"
  };
}

function insight(overrides: Partial<ProactiveInsight> = {}): ProactiveInsight {
  const evidenceRef = evidence();
  return {
    id: "pi_1",
    scope: "current",
    type: "follow_up_question",
    insightType: "follow_up",
    category: "follow_up",
    observation: "你们提到了线上争执无法及时解决的担忧，但当前录音中没有发现明确的后续处理方式。",
    question: "关于这个担忧，你们后来有没有讨论过具体的应对方式？",
    reason: "录音里提出了担忧，但没有记录后续处理方式。",
    confidence: 0.76,
    evidenceRefs: [evidenceRef],
    sourceUploadIds: ["upload_1"],
    caution: "这只是当前录音中的线索。",
    createdAt: "2026-07-10T12:00:00.000Z",
    ...overrides
  };
}

function ruleSuggestion(): ProactiveQaSuggestion {
  return {
    id: "rule_1",
    scope: "current",
    category: "summary",
    question: "这段录音中，我们提到过哪些解决线上争执的方法？",
    reason: "可以从当前录音的原文证据开始回看。",
    sourceType: "brief",
    sourceIds: ["brief_1"],
    sourceUploadIds: ["upload_1"],
    priority: 80
  };
}

describe("proactive QA presentation", () => {
  it("rejects question-shaped observation content", () => {
    const parsed = ProactiveObservationSchema.safeParse({
      id: "observation_1",
      type: "follow_up",
      title: "可以确认",
      content: "后来你们有没有讨论？",
      evidenceRefs: [evidence()],
      scope: "current",
      relatedQuestions: []
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a user-voice question that can be sent directly", () => {
    const parsed = SuggestedQuestionSchema.safeParse({
      id: "question_1",
      question: "后来我们有没有讨论过具体的应对方式？",
      scope: "current",
      sourceType: "relationship_signal",
      sourceIds: ["signal_1"],
      sourceUploadIds: ["upload_1"]
    });

    expect(parsed.success).toBe(true);
  });

  it("normalizes an Agent question from second-person into user voice", () => {
    expect(normalizeSuggestedQuestionText("关于这个担忧，你们后来有没有讨论过具体的应对方式吗？")).toBe(
      "关于这个担忧，我们后来有没有讨论过具体的应对方式吗？"
    );
  });

  it("maps one Agent insight into independent observation and question records", () => {
    const result = buildProactiveQaPresentation({
      agentInsights: [insight()],
      ruleSuggestions: [ruleSuggestion()]
    });

    expect(result.observations).toEqual([
      expect.objectContaining({
        id: "pi_1",
        content: "你们提到了线上争执无法及时解决的担忧，但当前录音中没有发现明确的后续处理方式。",
        relatedQuestions: ["关于这个担忧，我们后来有没有讨论过具体的应对方式？"]
      })
    ]);
    expect(result.suggestedQuestions[0]).toEqual(
      expect.objectContaining({
        id: "pi_1_question",
        question: "关于这个担忧，我们后来有没有讨论过具体的应对方式？",
        relatedObservationId: "pi_1"
      })
    );
    expect(result.suggestedQuestions[0]).not.toHaveProperty("content");
  });

  it("drops an invalid observation without losing a valid suggested question", () => {
    const result = buildProactiveQaPresentation({
      agentInsights: [insight({ observation: "后来你们有没有讨论？" })],
      ruleSuggestions: []
    });

    expect(result.observations).toEqual([]);
    expect(result.suggestedQuestions).toHaveLength(1);
    expect(result.suggestedQuestions[0]?.relatedObservationId).toBeUndefined();
  });

  it("keeps a valid observation when the related question is invalid", () => {
    const result = buildProactiveQaPresentation({
      agentInsights: [insight({ question: "请问后续安排" })],
      ruleSuggestions: []
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.relatedQuestions).toEqual([]);
    expect(result.suggestedQuestions).toEqual([]);
  });

  it("caps observations and suggested questions independently at three", () => {
    const result = buildProactiveQaPresentation({
      agentInsights: Array.from({ length: 5 }, (_, index) =>
        insight({
          id: `pi_${index + 1}`,
          observation: `录音里留下了第 ${index + 1} 个需要确认的小事项。`,
          question: `第 ${index + 1} 个事项后来我们有没有继续确认？`,
          evidenceRefs: [
            {
              ...evidence(),
              evidenceId: `brief:brief_${index + 1}`,
              sourceId: `brief_${index + 1}`
            }
          ]
        })
      ),
      ruleSuggestions: []
    });

    expect(result.observations).toHaveLength(3);
    expect(result.suggestedQuestions).toHaveLength(3);
  });

  it("filters abstract Agent copy and falls back to concrete rule questions", () => {
    const result = buildProactiveQaPresentation({
      agentInsights: [
        insight({
          observation: "这段对话体现了需要持续评估的关系质量。",
          question: "我们是否保持了良好的沟通一致性？",
          reason: "这可能影响双方关系发展。"
        })
      ],
      ruleSuggestions: [ruleSuggestion()]
    });

    expect(result.observations).toEqual([]);
    expect(result.suggestedQuestions.map((item) => item.id)).toEqual(["rule_1"]);
  });
});
