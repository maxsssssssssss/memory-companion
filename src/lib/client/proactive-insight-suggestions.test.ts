import { describe, expect, it } from "vitest";

import type { ProactiveEvidence, ProactiveInsight } from "@/lib/domain/proactive-insights";
import type { ProactiveQaSuggestion } from "./proactive-qa-suggestions";

import { mergeProactiveInsightSuggestions } from "./proactive-insight-suggestions";

function evidence(overrides: Partial<ProactiveEvidence> = {}): ProactiveEvidence {
  return {
    evidenceId: "relationship_signal:signal_1",
    kind: "relationship_signal",
    sourceType: "relationship_signal",
    sourceId: "signal_1",
    uploadId: "upload_1",
    recordingDate: "2026-07-10",
    sourceSegmentIds: ["seg_1"],
    timeRange: { startSeconds: 10, endSeconds: 20 },
    title: "需要澄清的互动",
    summary: "这段互动里留下了一项未确认内容。",
    excerpt: "我们之后再确认具体时间。",
    confidence: 0.78,
    caution: "这只是当前录音里的互动线索。",
    signalCategory: "uncertain",
    ...overrides
  };
}

function insight(overrides: Partial<ProactiveInsight> = {}): ProactiveInsight {
  const evidenceRef = evidence();
  return {
    id: "pi_1",
    scope: "current",
    type: "relationship_question",
    insightType: "reminder",
    category: "relationship",
    observation: "下一次见面的意向已经出现，但时间还没有落定。",
    question: "这次互动里还有什么需要继续确认？",
    reason: "具体安排仍需要双方继续确认。",
    confidence: 0.76,
    evidenceRefs: [evidenceRef],
    memoryRefs: ["memory:commitment_1"],
    sourceUploadIds: ["upload_1", "upload_history_1"],
    caution: "这只是当前录音里的互动线索。",
    createdAt: "2026-07-10T12:00:00.000Z",
    ...overrides
  };
}

function rule(index: number, overrides: Partial<ProactiveQaSuggestion> = {}): ProactiveQaSuggestion {
  return {
    id: `rule_${index}`,
    scope: "current",
    category: "summary",
    question: `规则问题 ${index}？`,
    reason: `规则原因 ${index}`,
    sourceType: "brief",
    sourceIds: [`brief_${index}`],
    sourceUploadIds: ["upload_1"],
    priority: 80 - index,
    ...overrides
  };
}

describe("mergeProactiveInsightSuggestions", () => {
  it("places agent insights first and fills the remaining slots with rules", () => {
    const merged = mergeProactiveInsightSuggestions({
      agentInsights: [insight()],
      ruleSuggestions: [rule(1), rule(2), rule(3), rule(4), rule(5)]
    });

    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({
      id: "pi_1",
      origin: "agent",
      observation: "下一次见面的意向已经出现，但时间还没有落定。",
      confidence: 0.76,
      evidenceCount: 1,
      memoryAware: true,
      caution: "这只是当前录音里的互动线索。",
      insightType: "reminder",
      sourceType: "relationship_signal",
      sourceIds: ["signal_1"]
    });
    expect(merged.slice(1).map((item) => item.id)).toEqual(["rule_1", "rule_2"]);
  });

  it("never displays more than three suggestions even when five or more are available", () => {
    const merged = mergeProactiveInsightSuggestions({
      agentInsights: [],
      ruleSuggestions: [rule(1), rule(2), rule(3), rule(4), rule(5)]
    });

    expect(merged.map((item) => item.id)).toEqual(["rule_1", "rule_2", "rule_3"]);
  });

  it("drops cached agent language that reads like abstract counseling and falls back to rules", () => {
    const merged = mergeProactiveInsightSuggestions({
      agentInsights: [
        insight({
          question: "你们是否保持了良好的沟通一致性？",
          reason: "这可能影响关系质量。"
        })
      ],
      ruleSuggestions: [rule(1), rule(2), rule(3)]
    });

    expect(merged.map((item) => item.id)).toEqual(["rule_1", "rule_2", "rule_3"]);
  });

  it("deduplicates rules with the same normalized question or overlapping source", () => {
    const merged = mergeProactiveInsightSuggestions({
      agentInsights: [insight()],
      ruleSuggestions: [
        rule(1, {
          category: "relationship",
          question: " 这次互动里还有什么需要继续确认? ",
          sourceIds: ["different_source"]
        }),
        rule(2, {
          category: "relationship",
          question: "这条关系证据是什么？",
          sourceType: "relationship_signal",
          sourceIds: ["signal_1"]
        }),
        rule(3)
      ]
    });

    expect(merged.map((item) => item.id)).toEqual(["pi_1", "rule_3"]);
  });

  it("preserves rule-only behavior when no agent insights are available", () => {
    const rules = [rule(1), rule(2)];
    expect(
      mergeProactiveInsightSuggestions({
        agentInsights: [],
        ruleSuggestions: rules
      })
    ).toEqual(rules);
  });
});
