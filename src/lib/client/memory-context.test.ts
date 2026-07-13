import { describe, expect, it } from "vitest";

import type { LocalDayPayload } from "./local-analysis";
import { buildMemoryContextPayload } from "./memory-context";

function payloadForDate(input: {
  uploadId: string;
  recordingDate: string;
  text: string;
  createdAt?: string;
  audioInsightSummary?: string;
}): LocalDayPayload {
  return {
    upload: {
      id: input.uploadId,
      originalName: `${input.uploadId}.mp3`,
      mimeType: "audio/mpeg",
      sizeBytes: 1024,
      recordingDate: input.recordingDate,
      createdAt: input.createdAt ?? `${input.recordingDate}T09:00:00.000Z`,
      status: "ready"
    },
    job: {
      id: `job_${input.uploadId}`,
      uploadId: input.uploadId,
      status: "ready",
      progress: 100
    },
    segments: [
      {
        id: `${input.uploadId}_seg_1`,
        uploadId: input.uploadId,
        startSeconds: 0,
        endSeconds: 30,
        text: input.text,
        confidence: 0.9,
        sceneLabels: ["self_reflection"],
        valueLabels: ["idea"]
      }
    ],
    audioInsights: [
      {
        id: `${input.uploadId}_insight_1`,
        uploadId: input.uploadId,
        sourceSegmentIds: [`${input.uploadId}_seg_1`],
        sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
        speaker: { id: "speaker_unknown", role: "unknown", confidence: 0.4 },
        voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
        toneLabels: ["explaining"],
        emotionLabels: ["interested"],
        interactionLabels: ["rapport"],
        summary: input.audioInsightSummary ?? "对话氛围比较自然",
        evidence: input.text,
        confidence: 0.5
      }
    ],
    semanticSegments: [
      {
        id: `${input.uploadId}_semantic_1`,
        uploadId: input.uploadId,
        title: "关系推进讨论",
        summary: "聊到了下一次见面的安排。",
        startSeconds: 0,
        endSeconds: 30,
        tags: ["约会"],
        sceneLabels: ["self_reflection"],
        valueLabels: ["idea"],
        confidence: 0.82,
        sourceSegmentIds: [`${input.uploadId}_seg_1`],
        sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
        transcriptExcerpt: input.text
      }
    ],
    semanticSegmentsAvailable: true,
    briefItems: [
      {
        id: `${input.uploadId}_brief_1`,
        uploadId: input.uploadId,
        category: "idea",
        title: "下次见面安排",
        body: "对方提到下周可以再见面。",
        priority: "medium",
        confidence: 0.8,
        status: "confirmed",
        sourceSegmentIds: [`${input.uploadId}_seg_1`],
        sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
        transcriptExcerpt: input.text,
        people: [],
        topics: ["约会"]
      }
    ],
    relationshipSignals: [
      {
        id: `${input.uploadId}_relationship_1`,
        uploadId: input.uploadId,
        date: input.recordingDate,
        signalType: "active_listening",
        signalCategory: "positive",
        severity: "low",
        confidence: 0.78,
        summary: "回应中出现了确认对方表达的线索。",
        explanation: "这只描述当前片段中的互动，不代表长期关系结论。",
        involvedSpeakers: ["speaker_unknown"],
        timeRange: { startSeconds: 0, endSeconds: 30 },
        evidenceSegments: [
          {
            segmentId: `${input.uploadId}_seg_1`,
            speaker: "speaker_unknown",
            startSeconds: 0,
            endSeconds: 30,
            text: input.text
          }
        ],
        textEvidence: [input.text],
        suggestedReflection: "可以继续观察类似回应是否稳定出现。",
        createdAt: `${input.recordingDate}T10:00:00.000Z`
      }
    ],
    relationshipSignalsAvailable: true
  };
}

describe("buildMemoryContextPayload", () => {
  it("keeps only recordings from the selected week and decorates local evidence with dates", () => {
    const context = buildMemoryContextPayload({
      scope: "week",
      referenceDate: "2026-06-10",
      payloads: [
        payloadForDate({ uploadId: "last_week", recordingDate: "2026-06-03", text: "上周的内容不应该进入这周。" }),
        payloadForDate({ uploadId: "this_week", recordingDate: "2026-06-10", text: "她说下周还可以再约。" })
      ]
    });

    expect(context).not.toBeNull();
    expect(context?.scope).toBe("week");
    expect(context?.uploadId).toBe("week_2026-06-08_2026-06-14");
    expect(context?.segments.map((segment) => segment.uploadId)).toEqual(["this_week"]);
    expect(context?.segments[0]?.text).toContain("[2026-06-10]");
    expect(context?.audioInsights[0]?.summary).toContain("[2026-06-10]");
    expect(context?.semanticSegments[0]?.title).toBe("2026-06-10 · 关系推进讨论");
    expect(context?.briefItems[0]?.title).toBe("2026-06-10 · 下次见面安排");
    expect(context?.relationshipSignals).toHaveLength(1);
    expect(context?.relationshipSignals[0]?.date).toBe("2026-06-10");
  });

  it("builds an all-memory context from every ready local payload", () => {
    const context = buildMemoryContextPayload({
      scope: "all",
      referenceDate: "2026-06-10",
      payloads: [
        payloadForDate({ uploadId: "day_one", recordingDate: "2026-06-01", text: "第一天的谈话。" }),
        payloadForDate({ uploadId: "day_two", recordingDate: "2026-06-10", text: "第二天的谈话。" })
      ]
    });

    expect(context).not.toBeNull();
    expect(context?.scope).toBe("all");
    expect(context?.uploadId).toBe("all_memory");
    expect(context?.segments.map((segment) => segment.uploadId)).toEqual(["day_one", "day_two"]);
    expect(context?.audioInsights).toHaveLength(2);
    expect(context?.relationshipSignals).toHaveLength(2);
  });

  it("preserves atmosphere labels and emotion evidence when building memory context", () => {
    const payload = payloadForDate({
      uploadId: "emotion_day",
      recordingDate: "2026-06-10",
      text: "预算是不是还有风险？"
    });
    payload.audioInsights[0].atmosphereLabels = ["serious", "tense"];
    payload.audioInsights[0].emotionEvidence = [
      {
        id: "emotion_evidence_1",
        kind: "atmosphere",
        label: "认真偏紧",
        normalizedLabel: "tense",
        source: "acoustic",
        confidence: 0.72,
        detail: "音量升高、停顿变多，并且多人重叠。",
        sourceSegmentIds: ["emotion_day_seg_1"],
        sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
        features: [
          { name: "volume", label: "音量更高", value: "-16", unit: "dBFS" },
          { name: "pause", label: "停顿变多", value: "42", unit: "%" }
        ]
      }
    ];

    const context = buildMemoryContextPayload({
      scope: "week",
      referenceDate: "2026-06-10",
      payloads: [payload]
    });

    expect(context?.audioInsights[0]?.emotionEvidence?.[0]?.label).toBe("认真偏紧");
    expect(context?.audioInsights[0]?.atmosphereLabels).toContain("tense");
  });

  it("caps cross-day context size before it is sent to QA endpoints", () => {
    const payload = payloadForDate({
      uploadId: "dense_day",
      recordingDate: "2026-06-10",
      text: "这是一段很长的内容。".repeat(120)
    });
    payload.segments = Array.from({ length: 120 }, (_, index) => ({
      ...payload.segments[0],
      id: `dense_seg_${index}`,
      startSeconds: index * 30,
      endSeconds: index * 30 + 20,
      text: `第 ${index} 段 ${"很长的原始转写 ".repeat(80)}`
    }));
    payload.audioInsights = Array.from({ length: 80 }, (_, index) => ({
      ...payload.audioInsights[0],
      id: `dense_audio_${index}`,
      sourceSegmentIds: [`dense_seg_${index}`],
      summary: `第 ${index} 条语气线索 ${"摘要 ".repeat(80)}`,
      evidence: `第 ${index} 条依据 ${"原文 ".repeat(80)}`
    }));
    payload.semanticSegments = Array.from({ length: 80 }, (_, index) => ({
      ...payload.semanticSegments[0],
      id: `dense_semantic_${index}`,
      sourceSegmentIds: [`dense_seg_${index}`],
      summary: `第 ${index} 个语义段 ${"摘要 ".repeat(80)}`,
      transcriptExcerpt: `第 ${index} 个摘录 ${"原文 ".repeat(80)}`
    }));
    payload.briefItems = Array.from({ length: 80 }, (_, index) => ({
      ...payload.briefItems[0],
      id: `dense_brief_${index}`,
      sourceSegmentIds: [`dense_seg_${index}`],
      body: `第 ${index} 条简报 ${"正文 ".repeat(80)}`,
      transcriptExcerpt: `第 ${index} 条摘录 ${"原文 ".repeat(80)}`
    }));
    payload.relationshipSignals = Array.from({ length: 20 }, (_, index) => ({
      ...payload.relationshipSignals![0],
      id: `dense_relationship_${index}`,
      evidenceSegments: [
        {
          ...payload.relationshipSignals![0].evidenceSegments[0],
          segmentId: `dense_seg_${index + 100}`,
          text: `第 ${index + 100} 段关系证据`
        }
      ]
    }));

    const context = buildMemoryContextPayload({
      scope: "all",
      referenceDate: "2026-06-10",
      payloads: [payload]
    });

    expect(context).not.toBeNull();
    expect(context?.segments.length).toBeLessThanOrEqual(48);
    expect(context?.audioInsights.length).toBeLessThanOrEqual(32);
    expect(context?.semanticSegments.length).toBeLessThanOrEqual(40);
    expect(context?.briefItems.length).toBeLessThanOrEqual(40);
    expect(context?.relationshipSignals).toHaveLength(12);
    expect(context?.segments[0]?.text.length).toBeLessThanOrEqual(700);
    expect(context?.audioInsights[0]?.summary.length).toBeLessThanOrEqual(700);
    expect(context?.briefItems[0]?.body.length).toBeLessThanOrEqual(700);
    const retainedSegmentIds = new Set(context?.segments.map((segment) => segment.id));
    expect(
      context?.relationshipSignals.every((card) =>
        card.evidenceSegments.every((evidence) => retainedSegmentIds.has(evidence.segmentId))
      )
    ).toBe(true);
  });
});
