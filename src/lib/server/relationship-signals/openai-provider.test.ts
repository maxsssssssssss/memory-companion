import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioInsightSchema, type AudioInsight, type SemanticSegment, type TranscriptSegment } from "@/lib/domain/types";

const { createMock, getOpenAIClientRuntimeConfigMock, openAIMock, parseMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getOpenAIClientRuntimeConfigMock: vi.fn(),
  openAIMock: vi.fn(),
  parseMock: vi.fn()
}));

vi.mock("openai", () => ({
  default: function MockOpenAI(...args: unknown[]) {
    openAIMock(...args);
    return {
      responses: {
        create: createMock,
        parse: parseMock
      }
    } as never;
  }
}));

vi.mock("openai/helpers/zod", () => ({
  zodTextFormat: vi.fn(() => ({ name: "relationship_signal_cards" }))
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: getOpenAIClientRuntimeConfigMock
}));

import { buildRelationshipSignalPrompt, openaiRelationshipSignalProvider } from "./openai-provider";

const relationshipSegments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 12,
    endSeconds: 26,
    speaker: "speaker_1",
    text: "刚才你问得太快了，我有点不舒服。",
    confidence: 0.92,
    sceneLabels: ["unknown"],
    valueLabels: ["open_question"]
  },
  {
    id: "seg_2",
    uploadId: "upload_1",
    startSeconds: 26,
    endSeconds: 40,
    speaker: "speaker_2",
    text: "好，我先慢一点。你想从哪里开始说？",
    confidence: 0.94,
    sceneLabels: ["unknown"],
    valueLabels: []
  }
];

const technicalSegments: TranscriptSegment[] = [
  {
    id: "seg_tech",
    uploadId: "upload_tech",
    startSeconds: 0,
    endSeconds: 15,
    speaker: "speaker_1",
    text: "这个智能音箱的 ASR 服务需要先拿到公网 audio_url。",
    confidence: 0.9,
    sceneLabels: ["product_discussion"],
    valueLabels: ["task"]
  }
];

const fallbackRelationshipSegments: TranscriptSegment[] = [
  {
    id: "seg_boundary_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 10,
    speaker: "speaker_1",
    text: "我想表达一个边界，如果今晚需要休息，希望你不要一直追问。",
    confidence: 0.92,
    sceneLabels: ["unknown"],
    valueLabels: []
  },
  {
    id: "seg_boundary_2",
    uploadId: "upload_1",
    startSeconds: 10,
    endSeconds: 20,
    speaker: "speaker_2",
    text: "可以，我尊重你需要休息。下次如果临时有事，我会提前发消息。",
    confidence: 0.94,
    sceneLabels: ["unknown"],
    valueLabels: []
  }
];

const semanticSegments: SemanticSegment[] = [];
const audioInsights: AudioInsight[] = [];

describe("openai relationship signal provider", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalTextModel = process.env.OPENAI_TEXT_MODEL;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test_key";
    process.env.OPENAI_TEXT_MODEL = "gpt-test";
    createMock.mockReset();
    parseMock.mockReset();
    openAIMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    if (originalTextModel === undefined) {
      delete process.env.OPENAI_TEXT_MODEL;
    } else {
      process.env.OPENAI_TEXT_MODEL = originalTextModel;
    }
  });

  it("skips LLM extraction and returns no cards for non-relationship context", async () => {
    const cards = await openaiRelationshipSignalProvider.analyze({
      uploadId: "upload_tech",
      recordingDate: "2026-07-09",
      segments: technicalSegments,
      semanticSegments,
      audioInsights
    });

    expect(cards).toEqual([]);
    expect(parseMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("builds a compact chunk-only prompt without semantic duplication or insight evidence text", () => {
    const semantic: SemanticSegment = {
      id: "semantic_verbose",
      uploadId: "upload_1",
      title: "重复语义摘要",
      summary: "这段很长的语义摘要重复了 transcript 中已经存在的关系互动内容。".repeat(8),
      startSeconds: 12,
      endSeconds: 40,
      tags: ["relationship"],
      sceneLabels: ["unknown"],
      valueLabels: [],
      confidence: 0.8,
      sourceSegmentIds: ["seg_1", "seg_2"],
      sourceTimeRange: { startSeconds: 12, endSeconds: 40 },
      transcriptExcerpt: relationshipSegments.map((segment) => segment.text).join(" ")
    };
    const insight = AudioInsightSchema.parse({
      id: "insight_1",
      uploadId: "upload_1",
      sourceSegmentIds: ["seg_1", "seg_2"],
      sourceTimeRange: { startSeconds: 12, endSeconds: 40 },
      speaker: { id: "speaker_2", role: "unknown", confidence: 0.7 },
      voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.5 },
      toneLabels: ["comforting"],
      emotionLabels: ["neutral"],
      interactionLabels: ["rapport"],
      summary: "放慢节奏并确认了具体的不舒服。",
      evidence: "不应再次发送的重复逐字 evidence。".repeat(12),
      confidence: 0.8
    });

    const prompt = buildRelationshipSignalPrompt({
      uploadId: "upload_1",
      recordingDate: "2026-07-16",
      segments: relationshipSegments,
      semanticSegments: [semantic],
      audioInsights: [insight]
    });

    expect(prompt.content).toContain("insight_1");
    expect(prompt.content).toContain("sourceSegmentIds=seg_1,seg_2");
    expect(prompt.content).not.toContain("semantic_verbose");
    expect(prompt.content).not.toContain("不应再次发送的重复逐字 evidence");
    expect(prompt.semanticCharacterCount).toBe(0);
    expect(prompt.unoptimizedContextCharacterCount).toBeGreaterThan(prompt.content.length);
  });

  it("uses one JSON request and returns normalized relationship signal cards", async () => {
    const onRequestMetrics = vi.fn();
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [
          {
            signalType: "boundary_respect",
            signalCategory: "positive",
            severity: "low",
            confidence: 0.83,
            summary: "对方放慢节奏并回应了不舒服的表达。",
            explanation: "这是当前片段里的积极互动线索，不代表长期关系结论。",
            involvedSpeakers: ["speaker_1", "speaker_2"],
            evidenceSegmentIds: ["seg_1", "seg_2"],
            textEvidence: ["我有点不舒服", "我先慢一点"],
            suggestedReflection: "可以观察这种尊重边界的回应是否稳定出现。"
          }
        ]
      })
    });

    const cards = await openaiRelationshipSignalProvider.analyze({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      onRequestMetrics
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      signalType: "boundary_respect",
      timeRange: { startSeconds: 12, endSeconds: 40 }
    });
    const request = createMock.mock.calls[0][0];
    const promptText = request.input.map((item: { content?: string }) => item.content ?? "").join("\n");
    const requestContentChars = request.input.reduce(
      (total: number, item: { content?: string }) => total + (item.content?.length ?? 0),
      0
    );
    expect(request.model).toBe("gpt-test");
    expect(promptText).toContain("不做人格判断");
    expect(promptText).toContain("非关系语境");
    expect(promptText).toContain("evidenceSegmentIds");
    expect(onRequestMetrics).toHaveBeenCalledWith(expect.objectContaining({
      responseMode: "json",
      model: "gpt-test",
      semanticCharacterCount: 0,
      semanticSegmentCount: 0,
      maxOutputTokens: 2000,
      promptCharacterCount: requestContentChars
    }));
    expect(parseMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes string evidence from the JSON fallback before validation", async () => {
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [
          {
            signalType: "boundary_respect",
            signalCategory: "positive",
            severity: "low",
            confidence: 0.83,
            summary: "对方放慢节奏并回应了不舒服的表达。",
            explanation: "这是当前片段里的积极互动线索，不代表长期关系结论。",
            involvedSpeakers: ["speaker_1", "speaker_2"],
            evidenceSegmentIds: ["seg_1", "seg_2"],
            counterEvidence: "也有一次没有及时回应",
            acousticEvidence: "语气比较平稳",
            interactionEvidence: "主动询问情况",
            textEvidence: ["我有点不舒服", "我先慢一点"],
            suggestedReflection: "可以观察这种尊重边界的回应是否稳定出现。"
          }
        ]
      })
    });

    const cards = await openaiRelationshipSignalProvider.analyze({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights
    });

    expect(cards).toHaveLength(1);
    expect(cards[0].counterEvidence).toEqual(["也有一次没有及时回应"]);
    expect(cards[0].acousticEvidence).toBeUndefined();
    expect(cards[0].interactionEvidence).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
    const jsonRequest = createMock.mock.calls[0][0];
    expect(jsonRequest.input[0].content).toContain("必须是 JSON 数组");
  });

  it("uses conservative fallback cards when the model returns no items despite explicit evidence", async () => {
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items: [] }) });

    const cards = await openaiRelationshipSignalProvider.analyze({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: fallbackRelationshipSegments,
      semanticSegments,
      audioInsights
    });

    expect(cards.map((card) => card.signalType)).toContain("boundary_respect");
    expect(cards[0].evidenceSegments[0]).toMatchObject({
      segmentId: "seg_boundary_1",
      text: fallbackRelationshipSegments[0].text
    });
  });
});
