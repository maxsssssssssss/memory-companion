import { describe, expect, it } from "vitest";

import type { ProactiveInsightContext } from "@/lib/domain/proactive-insights";

import { validateProactiveInsights } from "./validator";
import type { ProactiveInsightMemoryContext } from "./memory-context";

function buildContext(): ProactiveInsightContext {
  return {
    schemaVersion: 1,
    scope: "current",
    referenceDate: "2026-07-10",
    dateRange: {
      startDate: "2026-07-10",
      endDate: "2026-07-10"
    },
    sourceUploadIds: ["upload_1"],
    distinctDates: ["2026-07-10"],
    truncated: false,
    evidence: [
      {
        evidenceId: "relationship_signal:card_risk",
        kind: "relationship_signal",
        sourceType: "relationship_signal",
        sourceId: "card_risk",
        uploadId: "upload_1",
        recordingDate: "2026-07-10",
        sourceSegmentIds: ["seg_1"],
        timeRange: {
          startSeconds: 10,
          endSeconds: 20
        },
        title: "Risk clue",
        summary: "A fragile moment",
        excerpt: "Are you even listening right now?",
        confidence: 0.8,
        caution: "Only a local clue from this excerpt.",
        signalCategory: "risk"
      },
      {
        evidenceId: "brief:item_1",
        kind: "brief",
        sourceType: "brief",
        sourceId: "item_1",
        uploadId: "upload_1",
        recordingDate: "2026-07-10",
        sourceSegmentIds: ["seg_2"],
        timeRange: {
          startSeconds: 21,
          endSeconds: 30
        },
        title: "Follow-up item",
        summary: "A concrete follow-up",
        excerpt: "Let's check that tomorrow."
      },
      {
        evidenceId: "audio_insight:audio_1",
        kind: "audio_insight",
        sourceType: "audio_insight",
        sourceId: "audio_1",
        uploadId: "upload_2",
        recordingDate: "2026-07-10",
        sourceSegmentIds: ["seg_9"],
        timeRange: {
          startSeconds: 1,
          endSeconds: 5
        },
        title: "Foreign upload",
        summary: "Wrong upload",
        excerpt: "Wrong upload evidence."
      }
    ]
  };
}

function buildMemoryContext(dates: string[]): ProactiveInsightMemoryContext {
  return {
    scope: "current",
    currentUploadId: "upload_1",
    truncated: false,
    relations: [],
    memories: [
      {
        evidenceId: "memory:commitment_1",
        memoryId: "commitment_1",
        type: "commitment",
        title: "A future arrangement needs confirmation",
        summary: "A previous conversation left a future arrangement open.",
        importanceScore: 0.86,
        confidence: "high",
        status: "active",
        lifecycleKind: "active_commitment",
        occurrenceCount: dates.length,
        dates,
        sourceUploadIds: dates.map((_, index) => `history_upload_${index + 1}`),
        evidence: dates.map((date, index) => ({
          sourceType: "transcript" as const,
          sourceId: `history_segment_${index + 1}`,
          uploadId: `history_upload_${index + 1}`,
          recordingDate: date,
          excerpt: `Historical confirmation evidence ${index + 1}`
        }))
      }
    ]
  };
}

describe("validateProactiveInsights", () => {
  it("reports a field-level reason for invalid schema without logging candidate content", () => {
    const rejectionDetails: Array<{ reason: string; detail?: string }> = [];

    const results = validateProactiveInsights({
      context: buildContext(),
      rawItems: [
        {
          type: "reflection",
          category: "summary",
          observation: "A grounded observation.",
          question: "What should be revisited?",
          reason: "The supplied evidence supports a follow-up.",
          confidence: 0.7
        }
      ],
      onReject: (reason, detail) => rejectionDetails.push({ reason, detail })
    });

    expect(results).toEqual([]);
    expect(rejectionDetails).toEqual([
      { reason: "invalid_schema", detail: "evidenceIds:invalid_type" }
    ]);
    expect(JSON.stringify(rejectionDetails)).not.toContain("A grounded observation");
  });

  it("accepts a known evidence id up to the context schema limit", () => {
    const context = buildContext();
    const longEvidenceId = `semantic_segment:${"x".repeat(180)}`;
    context.evidence.push({
      ...context.evidence[1],
      evidenceId: longEvidenceId,
      kind: "semantic_segment",
      sourceType: "semantic_segment",
      sourceId: "semantic_long",
      title: "Timeline clue",
      summary: "A timeline segment is worth revisiting.",
      excerpt: "This timeline part deserves another look."
    });

    const results = validateProactiveInsights({
      context,
      rawItems: [
        {
          type: "reflection",
          category: "summary",
          observation: "A timeline clue is worth revisiting.",
          question: "Which part of this timeline deserves another look?",
          reason: "The cited semantic segment contains a traceable interaction.",
          evidenceIds: [longEvidenceId],
          confidence: 0.7
        }
      ]
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.evidenceRefs[0]?.evidenceId).toBe(longEvidenceId);
  });


  it("drops unknown evidence ids, cross-upload refs, low confidence, forbidden text, memory patterns, and long-range language", () => {
    const rejectionReasons: string[] = [];
    const results = validateProactiveInsights({
      context: buildContext(),
      onReject: (reason) => rejectionReasons.push(reason),
      rawItems: [
        {
          type: "follow_up_question",
          category: "follow_up",
          observation: "Concrete interaction clue.",
          question: "What do you want to ask next?",
          reason: "Grounded in evidence.",
          evidenceIds: ["missing"],
          confidence: 0.8
        },
        {
          type: "follow_up_question",
          category: "follow_up",
          observation: "Uses the wrong upload.",
          question: "Should we trust this?",
          reason: "Grounded in evidence.",
          evidenceIds: ["audio_insight:audio_1"],
          confidence: 0.8
        },
        {
          type: "follow_up_question",
          category: "follow_up",
          observation: "Low confidence item.",
          question: "Is this still worth asking?",
          reason: "Maybe not.",
          evidenceIds: ["brief:item_1"],
          confidence: 0.44
        },
        {
          type: "reflection",
          category: "summary",
          observation: "他就是渣男。",
          question: "Should you break up with him?",
          reason: "diagnosis and personality disorder vibes",
          evidenceIds: ["brief:item_1"],
          confidence: 0.8
        },
        {
          type: "memory_pattern",
          category: "memory",
          observation: "Pattern language in current scope.",
          question: "What repeats here?",
          reason: "Grounded in evidence.",
          evidenceIds: ["brief:item_1"],
          confidence: 0.8
        },
        {
          type: "reflection",
          category: "summary",
          observation: "他一直这样。",
          question: "Why is this always happening?",
          reason: "Looks like a long-term trend.",
          evidenceIds: ["brief:item_1"],
          confidence: 0.8
        }
      ],
      createdAt: "2026-07-10T12:00:00.000Z"
    });

    expect(results).toEqual([]);
    expect(rejectionReasons).toEqual(
      expect.arrayContaining([
        "unknown_evidence",
        "cross_scope_evidence",
        "low_confidence",
        "forbidden_text",
        "scope_guard"
      ])
    );
  });

  it("backfills caution from risk evidence and deduplicates repeated questions", () => {
    const results = validateProactiveInsights({
      context: buildContext(),
      rawItems: [
        {
          type: "relationship_question",
          category: "relationship",
          observation: "A concrete tension moment showed up.",
          question: "What felt most tense in that exchange?",
          reason: "It points to a specific risky interaction clue.",
          evidenceIds: ["relationship_signal:card_risk", "brief:item_1"],
          confidence: 0.74
        },
        {
          type: "follow_up_question",
          category: "follow_up",
          observation: "Same question with different type should dedupe.",
          question: " What felt most tense in that exchange? ",
          reason: "Still grounded.",
          evidenceIds: ["brief:item_1"],
          confidence: 0.78
        }
      ],
      createdAt: "2026-07-10T12:00:00.000Z"
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.caution).toBe("Only a local clue from this excerpt.");
    expect(results[0]?.evidenceRefs.map((item) => item.evidenceId)).toEqual([
      "relationship_signal:card_risk",
      "brief:item_1"
    ]);
    expect(results[0]?.sourceUploadIds).toEqual(["upload_1"]);
    expect(results[0]?.createdAt).toBe("2026-07-10T12:00:00.000Z");
  });

  it.each([
    "你们是否保持了良好的沟通一致性？",
    "这是否有助于减少认知偏差？",
    "你觉得这反映了怎样的关系模式？"
  ])("rejects abstract counselor-style wording: %s", (question) => {
    const rejectionReasons: string[] = [];
    const results = validateProactiveInsights({
      context: buildContext(),
      onReject: (reason) => rejectionReasons.push(reason),
      rawItems: [
        {
          type: "reflection",
          insightType: "reflection",
          category: "summary",
          observation: "当前记录里有一项可以回看的内容。",
          question,
          reason: "这项内容值得继续复盘。",
          evidenceIds: ["brief:item_1"],
          memoryRefs: [],
          confidence: 0.72,
          caution: "这里只基于当前记录。"
        }
      ]
    });

    expect(results).toEqual([]);
    expect(rejectionReasons).toContain("abstract_language");
  });

  it("rejects a question whose wording has no content anchor in its cited evidence", () => {
    const rejectionReasons: string[] = [];
    const results = validateProactiveInsights({
      context: buildContext(),
      onReject: (reason) => rejectionReasons.push(reason),
      rawItems: [
        {
          type: "reflection",
          insightType: "reflection",
          category: "summary",
          observation: "The weather forecast may need another look.",
          question: "Will it rain during the weekend trip?",
          reason: "Outdoor conditions could affect the travel route.",
          evidenceIds: ["brief:item_1"],
          memoryRefs: [],
          confidence: 0.72,
          caution: "Check the forecast before deciding."
        }
      ]
    });

    expect(results).toEqual([]);
    expect(rejectionReasons).toContain("ungrounded_text");
  });

  it("accepts a concrete friend-like follow-up grounded in the current event and memory", () => {
    const context = buildContext();
    context.evidence[1] = {
      ...context.evidence[1],
      title: "见面时间待确认",
      summary: "对话提到了下一次见面，但具体时间还没定。",
      excerpt: "我们之后再确认见面时间。"
    };
    const results = validateProactiveInsights({
      context,
      memoryContext: buildMemoryContext(["2026-07-09"]),
      rawItems: [
        {
          type: "follow_up_question",
          insightType: "follow_up",
          category: "follow_up",
          observation: "这次提到的见面时间还没定下来。",
          question: "你们之前提到的见面时间，后来有继续确认吗？",
          reason: "当前记录里仍然出现了见面时间待确认这件事。",
          evidenceIds: ["brief:item_1"],
          memoryRefs: ["memory:commitment_1"],
          confidence: 0.74,
          caution: "这只是提醒核对后续状态，不对任何一方作判断。"
        }
      ]
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.question).toBe("你们之前提到的见面时间，后来有继续确认吗？");
  });

  it("drops an item when any referenced risk or uncertain relationship evidence is missing caution", () => {
    const context = buildContext();
    context.evidence.push({
      evidenceId: "relationship_signal:card_uncertain",
      kind: "relationship_signal",
      sourceType: "relationship_signal",
      sourceId: "card_uncertain",
      uploadId: "upload_1",
      recordingDate: "2026-07-10",
      sourceSegmentIds: ["seg_3"],
      timeRange: {
        startSeconds: 31,
        endSeconds: 38
      },
      title: "Uncertain clue",
      summary: "Mixed signal",
      excerpt: "Maybe, I guess.",
      signalCategory: "uncertain"
    });

    const results = validateProactiveInsights({
      context,
      rawItems: [
        {
          type: "relationship_question",
          category: "relationship",
          observation: "Two relationship clues appeared.",
          question: "What feels unresolved in those two moments?",
          reason: "It compares two concrete pieces of evidence.",
          evidenceIds: ["relationship_signal:card_risk", "relationship_signal:card_uncertain"],
          confidence: 0.8
        }
      ],
      createdAt: "2026-07-10T12:00:00.000Z"
    });

    expect(results).toEqual([]);
  });

  it("rejects a long-term conclusion backed by only one dated memory", () => {
    const results = validateProactiveInsights({
      context: buildContext(),
      memoryContext: buildMemoryContext(["2026-07-09"]),
      rawItems: [
        {
          type: "follow_up_question",
          category: "memory",
          observation: "他一直回避确认未来安排。",
          question: "为什么这种长期模式总是出现？",
          reason: "长期来看一定说明对方不愿意承诺。",
          evidenceIds: ["brief:item_1", "memory:commitment_1"],
          confidence: 0.78
        }
      ],
      createdAt: "2026-07-10T12:00:00.000Z"
    });

    expect(results).toEqual([]);
  });

  it("accepts a cautious multi-date memory observation while retaining current evidence refs", () => {
    const results = validateProactiveInsights({
      context: buildContext(),
      memoryContext: buildMemoryContext(["2026-07-08", "2026-07-09"]),
      rawItems: [
        {
          type: "follow_up_question",
          category: "memory",
          observation: "当前录音中的安排确认，与两个过去日期的待确认事项有相似之处。",
          question: "这次有哪些安排值得进一步确认？",
          reason: "结合已有记忆，可以回看当前证据里仍未明确的下一步。",
          evidenceIds: ["brief:item_1", "memory:commitment_1"],
          confidence: 0.78
        }
      ],
      createdAt: "2026-07-10T12:00:00.000Z"
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.evidenceRefs.map((item) => item.evidenceId)).toEqual(["brief:item_1"]);
    expect(results[0]?.sourceUploadIds).toEqual([
      "upload_1",
      "history_upload_1",
      "history_upload_2"
    ]);
    expect(results[0]?.caution).toContain("多个日期");
    expect(results[0]?.caution).toContain("不能据此推断长期模式");
  });

  it("adds a conservative caution for safe single-date memory use and rejects personality framing", () => {
    const memoryContext = buildMemoryContext(["2026-07-09"]);
    const results = validateProactiveInsights({
      context: buildContext(),
      memoryContext,
      rawItems: [
        {
          type: "reflection",
          category: "memory",
          observation: "当前录音也出现了需要确认安排的线索。",
          question: "这次还有什么值得继续确认？",
          reason: "过去曾出现类似情况，可以进一步关注。",
          evidenceIds: ["brief:item_1", "memory:commitment_1"],
          confidence: 0.72
        },
        {
          type: "reflection",
          category: "relationship",
          observation: "她就是不负责任的人。",
          question: "她为什么总是这样？",
          reason: "结合历史就能确定她的人格。",
          evidenceIds: ["brief:item_1", "memory:commitment_1"],
          confidence: 0.9
        }
      ],
      createdAt: "2026-07-10T12:00:00.000Z"
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.question).toBe("这次还有什么值得继续确认？");
    expect(results[0]?.caution).toContain("过去曾出现类似情况，可以进一步关注");
    expect(results[0]?.caution).toContain("不足以支持长期结论");
  });

  it("rejects historical wording when the model does not cite memory evidence", () => {
    const rejectionReasons: string[] = [];
    const results = validateProactiveInsights({
      context: buildContext(),
      memoryContext: buildMemoryContext(["2026-07-09"]),
      onReject: (reason) => rejectionReasons.push(reason),
      rawItems: [
        {
          type: "follow_up_question",
          category: "memory",
          observation: "当前录音里又提到了这个功能。",
          question: "关于之前承诺的功能，现在进展如何？",
          reason: "结合历史记录继续追问。",
          evidenceIds: ["brief:item_1"],
          confidence: 0.72
        }
      ]
    });

    expect(results).toEqual([]);
    expect(rejectionReasons).toContain("missing_memory_evidence");
  });

  it("requires explicit memoryRefs when an insight says a situation happened again", () => {
    const rejectionReasons: string[] = [];
    const results = validateProactiveInsights({
      context: buildContext(),
      memoryContext: buildMemoryContext(["2026-07-09"]),
      onReject: (reason) => rejectionReasons.push(reason),
      rawItems: [
        {
          type: "follow_up_question",
          insightType: "follow_up",
          category: "memory",
          observation: "这次再次出现了待确认的安排。",
          question: "这次具体还需要确认什么？",
          reason: "当前证据值得继续回看。",
          evidenceIds: ["brief:item_1"],
          memoryRefs: [],
          confidence: 0.72,
          caution: "这里只能确认当前线索，不能推断长期模式。"
        }
      ]
    });

    expect(results).toEqual([]);
    expect(rejectionReasons).toContain("missing_memory_evidence");
  });

  it("requires multiple dated evidence for pattern observations", () => {
    const singleDate = validateProactiveInsights({
      context: buildContext(),
      memoryContext: buildMemoryContext(["2026-07-10"]),
      rawItems: [
        {
          type: "reflection",
          insightType: "pattern_observation",
          category: "memory",
          observation: "类似的确认事项可能再次出现。",
          question: "这个主题是否值得继续观察？",
          reason: "当前和记忆都提到了安排确认。",
          evidenceIds: ["brief:item_1"],
          memoryRefs: ["memory:commitment_1"],
          confidence: 0.72,
          caution: "目前只有一个日期的证据，不能形成长期判断。"
        }
      ]
    });
    const multipleDates = validateProactiveInsights({
      context: buildContext(),
      memoryContext: buildMemoryContext(["2026-07-09"]),
      rawItems: [
        {
          type: "reflection",
          insightType: "pattern_observation",
          category: "memory",
          observation: "两个日期都出现了安排确认线索。",
          question: "这个主题是否值得继续观察？",
          reason: "当前与过去两个日期的证据可以支持谨慎回看。",
          evidenceIds: ["brief:item_1"],
          memoryRefs: ["memory:commitment_1"],
          confidence: 0.72,
          caution: "跨日期线索仍然不是人格或长期关系结论。"
        }
      ]
    });

    expect(singleDate).toEqual([]);
    expect(multipleDates).toHaveLength(1);
    expect(multipleDates[0]).toMatchObject({
      insightType: "pattern_observation",
      memoryRefs: ["memory:commitment_1"]
    });
  });

  it.each(["经常", "通常"])("rejects current-only %s wording without cross-date evidence", (word) => {
    const results = validateProactiveInsights({
      context: buildContext(),
      rawItems: [
        {
          type: "reflection",
          insightType: "reflection",
          category: "relationship",
          observation: "当前录音里出现了一次轻松互动。",
          question: `这种互动${word}会带来什么感受？`,
          reason: "当前片段提供了一次可回看的线索。",
          evidenceIds: ["brief:item_1"],
          memoryRefs: [],
          confidence: 0.7,
          caution: "目前只有当前日期的证据。"
        }
      ]
    });

    expect(results).toEqual([]);
  });

  it("rejects unsupported commitment breach judgments", () => {
    const rejectionReasons: string[] = [];
    const results = validateProactiveInsights({
      context: buildContext(),
      memoryContext: buildMemoryContext(["2026-07-09"]),
      onReject: (reason) => rejectionReasons.push(reason),
      rawItems: [
        {
          type: "unresolved_issue",
          insightType: "reminder",
          category: "memory",
          observation: "对方没有履行承诺。",
          question: "为什么对方违约？",
          reason: "过去提到过这项安排。",
          evidenceIds: ["brief:item_1"],
          memoryRefs: ["memory:commitment_1"],
          confidence: 0.8,
          caution: "仍需核对后续记录。"
        }
      ]
    });

    expect(results).toEqual([]);
    expect(rejectionReasons).toContain("commitment_judgment");
  });
});
