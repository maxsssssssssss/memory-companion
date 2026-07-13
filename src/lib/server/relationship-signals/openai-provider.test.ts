import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioInsight, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";

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

import { openaiRelationshipSignalProvider } from "./openai-provider";

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

  it("returns normalized relationship signal cards from structured model output", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
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
      }
    });

    const cards = await openaiRelationshipSignalProvider.analyze({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      signalType: "boundary_respect",
      timeRange: { startSeconds: 12, endSeconds: 40 }
    });
    const request = parseMock.mock.calls[0][0];
    expect(request.model).toBe("gpt-test");
    expect(request.input[0].content).toContain("不做人格判断");
    expect(request.input[0].content).toContain("非关系语境");
    expect(request.input[0].content).toContain("evidenceSegmentIds");
  });

  it("uses conservative fallback cards when the model returns no items despite explicit evidence", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: []
      }
    });

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
