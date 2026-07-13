import { describe, expect, it } from "vitest";
import { zodTextFormat } from "openai/helpers/zod";

import type { TranscriptSegment } from "@/lib/domain/types";

import { AiAudioInsightItemsSchema, normalizeAiAudioInsightItems } from "./ai-audio-insights";

const segments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_ai",
    startSeconds: 10,
    endSeconds: 25,
    speaker: "speaker_1",
    text: "我觉得这个预算是不是还有点风险？",
    confidence: 0.92,
    sceneLabels: ["customer_call"],
    valueLabels: ["open_question", "risk"]
  },
  {
    id: "seg_2",
    uploadId: "upload_ai",
    startSeconds: 26,
    endSeconds: 40,
    speaker: "speaker_2",
    text: "没关系，我们可以先把条件说清楚。",
    confidence: 0.9,
    sceneLabels: ["customer_call"],
    valueLabels: ["idea"]
  }
];

describe("normalizeAiAudioInsightItems", () => {
  it("can be converted to an OpenAI strict structured output schema", () => {
    expect(() => zodTextFormat(AiAudioInsightItemsSchema, "audio_interaction_insights")).not.toThrow();
  });

  it("turns model insight items into validated audio insights with source ranges", () => {
    const insights = normalizeAiAudioInsightItems({
      uploadId: "upload_ai",
      segments,
      items: [
        {
          sourceSegmentIds: ["seg_1", "seg_2"],
          speaker: {
            id: "speaker_1",
            displayName: "客户",
            role: "customer",
            confidence: 0.7
          },
          voice: {
            pace: "normal",
            volume: "unknown",
            pause: "normal",
            overlap: false,
            confidence: 0.45
          },
          toneLabels: ["hesitant", "questioning"],
          emotionLabels: ["anxious"],
          interactionLabels: ["follow_up_question", "rapport"],
          summary: "客户先试探预算风险，随后被安抚。",
          evidence: "客户问预算是不是还有风险，随后对方说可以先说清楚条件。",
          confidence: 0.76
        }
      ]
    });

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      id: "insight_upload_ai_ai_1",
      uploadId: "upload_ai",
      sourceSegmentIds: ["seg_1", "seg_2"],
      sourceTimeRange: {
        startSeconds: 10,
        endSeconds: 40
      },
      speaker: {
        id: "speaker_1",
        displayName: "客户",
        role: "customer"
      },
      toneLabels: ["hesitant", "questioning"],
      emotionLabels: ["anxious"],
      interactionLabels: ["follow_up_question", "rapport"],
      summary: "客户先试探预算风险，随后被安抚。"
    });
  });

  it("drops model items without valid source segments", () => {
    const insights = normalizeAiAudioInsightItems({
      uploadId: "upload_ai",
      segments,
      items: [
        {
          sourceSegmentIds: ["missing_seg"],
          speaker: {
            id: "speaker_1",
            role: "customer",
            confidence: 0.7
          },
          voice: {
            pace: "normal",
            volume: "unknown",
            pause: "normal",
            overlap: false,
            confidence: 0.45
          },
          toneLabels: ["hesitant"],
          emotionLabels: ["anxious"],
          interactionLabels: ["follow_up_question"],
          summary: "无效来源。",
          evidence: "来源不存在。",
          confidence: 0.76
        }
      ]
    });

    expect(insights).toEqual([]);
  });

  it("keeps model-provided atmosphere labels and valid llm emotion evidence", () => {
    const insights = normalizeAiAudioInsightItems({
      uploadId: "upload_ai",
      segments,
      items: [
        {
          sourceSegmentIds: ["seg_1"],
          speaker: {
            id: "speaker_1",
            role: "customer",
            confidence: 0.7
          },
          voice: {
            pace: "normal",
            volume: "unknown",
            pause: "normal",
            overlap: false,
            confidence: 0.45
          },
          toneLabels: ["serious"],
          emotionLabels: ["tense"],
          interactionLabels: ["tension"],
          atmosphereLabels: ["tense", "serious"],
          emotionEvidence: [
            {
              id: "evidence_1",
              kind: "atmosphere",
              label: "tense",
              normalizedLabel: "tense",
              source: "llm",
              confidence: 0.68,
              detail: "客户在追问预算风险，气氛偏紧张。",
              sourceSegmentIds: ["seg_1"],
              sourceTimeRange: {
                startSeconds: 10,
                endSeconds: 25
              },
              features: []
            }
          ],
          summary: "客户在追问预算风险。",
          evidence: "原文问“这个预算是不是还有点风险”。",
          confidence: 0.76
        }
      ]
    });

    expect(insights).toHaveLength(1);
    expect(insights[0].atmosphereLabels).toEqual(["tense", "serious"]);
    expect(insights[0].emotionEvidence?.[0]).toMatchObject({
      source: "llm",
      normalizedLabel: "tense"
    });
  });

  it("drops llm emotion evidence that references missing source segments", () => {
    const insights = normalizeAiAudioInsightItems({
      uploadId: "upload_ai",
      segments,
      items: [
        {
          sourceSegmentIds: ["seg_1"],
          speaker: {
            id: "speaker_1",
            role: "customer",
            confidence: 0.7
          },
          voice: {
            pace: "normal",
            volume: "unknown",
            pause: "normal",
            overlap: false,
            confidence: 0.45
          },
          toneLabels: ["serious"],
          emotionLabels: ["tense"],
          interactionLabels: ["tension"],
          emotionEvidence: [
            {
              id: "evidence_valid",
              kind: "atmosphere",
              label: "tense",
              normalizedLabel: "tense",
              source: "llm",
              confidence: 0.68,
              detail: "客户在追问预算风险，气氛偏紧张。",
              sourceSegmentIds: ["seg_1"],
              sourceTimeRange: {
                startSeconds: 10,
                endSeconds: 25
              },
              features: []
            },
            {
              id: "evidence_missing",
              kind: "atmosphere",
              label: "awkward",
              normalizedLabel: "awkward",
              source: "llm",
              confidence: 0.62,
              detail: "这条证据引用了不存在的片段。",
              sourceSegmentIds: ["missing_seg"],
              sourceTimeRange: {
                startSeconds: 41,
                endSeconds: 45
              },
              features: []
            }
          ],
          summary: "客户在追问预算风险。",
          evidence: "原文问“这个预算是不是还有点风险”。",
          confidence: 0.76
        }
      ]
    });

    expect(insights).toHaveLength(1);
    expect(insights[0].emotionEvidence).toEqual([
      expect.objectContaining({
        id: "evidence_valid",
        sourceSegmentIds: ["seg_1"]
      })
    ]);
  });

  it("drops malformed model atmosphere and emotion evidence without dropping the insight", () => {
    const insights = normalizeAiAudioInsightItems({
      uploadId: "upload_ai",
      segments,
      items: [
        {
          sourceSegmentIds: ["seg_1"],
          speaker: {
            id: "speaker_1",
            role: "customer",
            confidence: 0.7
          },
          voice: {
            pace: "normal",
            volume: "unknown",
            pause: "normal",
            overlap: false,
            confidence: 0.45
          },
          toneLabels: ["serious"],
          emotionLabels: ["tense"],
          interactionLabels: ["tension"],
          atmosphereLabels: ["tense", "not_a_label"],
          emotionEvidence: [
            {
              id: "evidence_valid",
              kind: "atmosphere",
              label: "tense",
              normalizedLabel: "tense",
              source: "llm",
              confidence: 0.68,
              detail: "客户在追问预算风险，气氛偏紧张。",
              sourceSegmentIds: ["seg_1"],
              sourceTimeRange: {
                startSeconds: 10,
                endSeconds: 25
              },
              features: []
            },
            {
              id: "evidence_bad",
              kind: "atmosphere",
              label: "bad evidence",
              normalizedLabel: "tense",
              source: "invalid_source",
              confidence: 0.68,
              detail: "这条证据字段不合法。",
              sourceSegmentIds: ["seg_1"],
              features: []
            }
          ],
          summary: "客户在追问预算风险。",
          evidence: "原文问“这个预算是不是还有点风险”。",
          confidence: 0.76
        }
      ]
    });

    expect(insights).toHaveLength(1);
    expect(insights[0].atmosphereLabels).toEqual(["tense"]);
    expect(insights[0].emotionEvidence).toEqual([
      expect.objectContaining({
        id: "evidence_valid",
        source: "llm"
      })
    ]);
  });

  it("falls back to the source segment speaker when the model omits speaker id", () => {
    const insights = normalizeAiAudioInsightItems({
      uploadId: "upload_ai",
      segments,
      items: [
        {
          sourceSegmentIds: ["seg_2"],
          speaker: {
            role: "other",
            confidence: 0.62
          },
          voice: {
            pace: "normal",
            volume: "unknown",
            pause: "normal",
            overlap: false,
            confidence: 0.45
          },
          toneLabels: ["comforting"],
          emotionLabels: ["relaxed"],
          interactionLabels: ["rapport"],
          summary: "对方在安抚并推进条件确认。",
          evidence: "原文提到“没关系，我们可以先把条件说清楚”。",
          confidence: 0.72
        }
      ]
    });

    expect(insights).toHaveLength(1);
    expect(insights[0].speaker.id).toBe("speaker_2");
  });
});
