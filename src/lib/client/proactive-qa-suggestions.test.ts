import { describe, expect, it } from "vitest";

import type { AudioInsight, BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { LocalDayPayload } from "./local-analysis";
import { buildProactiveQaSuggestions } from "./proactive-qa-suggestions";

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 20,
    speaker: "speaker_1",
    text: "我听到你说最近有点累，所以先不急着定下一次见面。",
    confidence: 0.92,
    sceneLabels: ["self_reflection"],
    valueLabels: ["idea"],
    ...overrides
  };
}

function briefItem(overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    id: "brief_1",
    uploadId: "upload_1",
    category: "open_question",
    title: "下次见面安排还没有完全说清",
    body: "对话里提到下次见面的可能时间，但还没有明确确认。",
    priority: "high",
    confidence: 0.84,
    status: "confirmed",
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 20 },
    transcriptExcerpt: "那我们下周再看看时间。",
    people: [],
    topics: ["见面安排"],
    ...overrides
  };
}

function audioInsight(overrides: Partial<AudioInsight> = {}): AudioInsight {
  return {
    id: "insight_1",
    uploadId: "upload_1",
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 20 },
    speaker: { id: "speaker_1", role: "other", confidence: 0.72 },
    voice: { pace: "normal", volume: "unknown", pause: "normal", overlap: false, confidence: 0.4 },
    toneLabels: ["comforting"],
    emotionLabels: ["interested"],
    interactionLabels: ["rapport"],
    atmosphereLabels: ["warm"],
    summary: "这段回应更像是在接住对方的情绪，而不是推进结论。",
    evidence: "对方先回应了疲惫感，再讨论安排。",
    confidence: 0.72,
    ...overrides
  };
}

function semanticSegment(overrides: Partial<SemanticSegment> = {}): SemanticSegment {
  return {
    id: "semantic_1",
    uploadId: "upload_1",
    title: "下次见面与节奏确认",
    summary: "双方围绕下次见面和当下节奏进行了温和确认。",
    startSeconds: 0,
    endSeconds: 30,
    tags: ["约会", "节奏"],
    sceneLabels: ["self_reflection"],
    valueLabels: ["open_question"],
    confidence: 0.8,
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
    transcriptExcerpt: "可以下周再看看时间。",
    ...overrides
  };
}

function relationshipSignal(overrides: Partial<RelationshipSignalCard> = {}): RelationshipSignalCard {
  return {
    id: "signal_1",
    uploadId: "upload_1",
    date: "2026-07-09",
    signalType: "emotional_support",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.74,
    summary: "对方先回应了疲惫感，再讨论下一步安排。",
    explanation: "这更像是在确认感受后再推进话题。",
    involvedSpeakers: ["speaker_1"],
    timeRange: { startSeconds: 0, endSeconds: 20 },
    evidenceSegments: [
      {
        segmentId: "seg_1",
        speaker: "speaker_1",
        startSeconds: 0,
        endSeconds: 20,
        text: "我听到你说最近有点累，所以先不急着定下一次见面。"
      }
    ],
    textEvidence: ["先回应疲惫感，再讨论安排。"],
    suggestedReflection: "你可以回看这个回应是否让你感到被理解。",
    createdAt: "2026-07-09T10:00:00.000Z",
    ...overrides
  };
}

function payload(overrides: Partial<LocalDayPayload> = {}): LocalDayPayload {
  return {
    upload: {
      id: "upload_1",
      originalName: "date.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 1024,
      recordingDate: "2026-07-09",
      createdAt: "2026-07-09T10:00:00.000Z",
      status: "ready"
    },
    job: {
      id: "job_1",
      uploadId: "upload_1",
      status: "ready",
      progress: 100
    },
    segments: [segment()],
    audioInsights: [audioInsight()],
    semanticSegments: [semanticSegment()],
    semanticSegmentsAvailable: true,
    briefItems: [briefItem()],
    relationshipSignals: [],
    relationshipSignalsAvailable: true,
    ...overrides
  };
}

describe("buildProactiveQaSuggestions", () => {
  it("prioritizes relationship signal follow-up questions for the current recording", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "current",
      referenceDate: "2026-07-09",
      payload: payload({ relationshipSignals: [relationshipSignal()] })
    });

    expect(suggestions[0]).toEqual(
      expect.objectContaining({
        scope: "current",
        category: "relationship",
        sourceType: "relationship_signal",
        sourceIds: ["signal_1"],
        sourceUploadIds: ["upload_1"]
      })
    );
    expect(suggestions[0]?.question).toContain("关系信号");
    expect(suggestions[0]?.reason).toContain("对方先回应了疲惫感");
  });

  it("uses brief, tone, and timeline evidence when no relationship signals exist", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "current",
      referenceDate: "2026-07-09",
      payload: payload()
    });

    expect(suggestions.map((suggestion) => suggestion.sourceType)).toEqual(
      expect.arrayContaining(["brief", "audio_insight", "timeline"])
    );
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]?.question).toContain("这次录音");
  });

  it("uses task-specific wording without mentioning commitments", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "current",
      referenceDate: "2026-07-09",
      payload: payload({
        briefItems: [
          briefItem({
            id: "brief_task",
            category: "task",
            title: "下次见面时间需要继续跟进",
            body: "双方提到下次见面的时间还需要再确认。",
            transcriptExcerpt: "那我们下周再看一下具体哪天方便。"
          })
        ]
      })
    });

    expect(suggestions[0]).toEqual(
      expect.objectContaining({
        sourceType: "brief",
        sourceIds: ["brief_task"]
      })
    );
    expect(suggestions[0]?.question).toBe("这次录音里有哪些下一步需要跟进？");
    expect(suggestions[0]?.question).not.toContain("承诺");
  });

  it("uses commitment-specific wording for commitment brief items", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "current",
      referenceDate: "2026-07-09",
      payload: payload({
        briefItems: [
          briefItem({
            id: "brief_commitment",
            category: "commitment",
            title: "对方明确说这周会确认时间",
            body: "对方承诺这周会给出下次见面的具体时间。",
            transcriptExcerpt: "我这周会把时间确认好。"
          })
        ]
      })
    });

    expect(suggestions[0]).toEqual(
      expect.objectContaining({
        sourceType: "brief",
        sourceIds: ["brief_commitment"]
      })
    );
    expect(suggestions[0]?.question).toBe("这次录音里有哪些明确承诺需要回看？");
  });

  it("uses open-question wording for unresolved questions", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "current",
      referenceDate: "2026-07-09",
      payload: payload({
        briefItems: [
          briefItem({
            id: "brief_open_question",
            category: "open_question",
            title: "下次见面的节奏还没说清",
            body: "双方没有把下次见面的时间和边界完全确认。",
            transcriptExcerpt: "要不我们先不急着定，之后再看。"
          })
        ]
      })
    });

    expect(suggestions[0]).toEqual(
      expect.objectContaining({
        sourceType: "brief",
        sourceIds: ["brief_open_question"]
      })
    );
    expect(suggestions[0]?.question).toBe("这次录音里有哪些还没说清、需要继续确认的问题？");
  });

  it("builds week suggestions from only the selected week", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "week",
      referenceDate: "2026-07-09",
      memoryPayloads: [
        payload({ upload: { ...payload().upload, id: "last_week", recordingDate: "2026-07-01" } }),
        payload({ upload: { ...payload().upload, id: "this_week", recordingDate: "2026-07-09" } })
      ]
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((suggestion) => suggestion.sourceUploadIds.includes("last_week"))).toBe(false);
    expect(suggestions.some((suggestion) => suggestion.sourceUploadIds.includes("this_week"))).toBe(true);
    expect(suggestions[0]?.question).toContain("本周");
  });

  it("keeps week suggestions conservative when the selected week has only one date", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "week",
      referenceDate: "2026-07-09",
      memoryPayloads: [payload({ upload: { ...payload().upload, id: "this_week", recordingDate: "2026-07-09" } })]
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.question).toBe("本周目前可回看的重点是什么？");
    expect(suggestions.map((suggestion) => suggestion.question).join(" ")).not.toContain("反复出现");
  });

  it("uses cautious all-memory wording without making long-term conclusions", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "all",
      referenceDate: "2026-07-09",
      memoryPayloads: [
        payload({ upload: { ...payload().upload, id: "day_one", recordingDate: "2026-07-01" } }),
        payload({ upload: { ...payload().upload, id: "day_two", recordingDate: "2026-07-09" } })
      ]
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.question).toContain("过去记录里是否有证据");
    expect(`${suggestions[0]?.question} ${suggestions[0]?.reason}`).not.toContain("你一直");
  });

  it("does not ask long-term all-memory questions from a single recording date", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "all",
      referenceDate: "2026-07-09",
      memoryPayloads: [payload({ upload: { ...payload().upload, id: "day_one", recordingDate: "2026-07-09" } })]
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.question).toBe("当前已有记录里有哪些证据值得先回看？");
    expect(suggestions.map((suggestion) => suggestion.question).join(" ")).not.toMatch(/长期|反复出现/);
  });

  it("filters forbidden relationship-judgment wording from generated suggestions", () => {
    const suggestions = buildProactiveQaSuggestions({
      scope: "current",
      referenceDate: "2026-07-09",
      payload: payload({
        relationshipSignals: [
          relationshipSignal({
            summary: "这不是渣男判断，只是需要回看原文证据。"
          })
        ]
      })
    });

    expect(suggestions.some((suggestion) => /渣男|渣女|操控|有病|应该分手|人格|诊断/.test(`${suggestion.question} ${suggestion.reason}`))).toBe(false);
  });
});
