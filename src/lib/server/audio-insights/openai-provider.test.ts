import type { TranscriptSegment } from "@/lib/domain/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  zodTextFormat: vi.fn(() => ({ name: "audio_interaction_insights" }))
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: getOpenAIClientRuntimeConfigMock
}));

import { openaiAudioInsightProvider } from "./openai-provider";

const segments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_ai",
    startSeconds: 10,
    endSeconds: 25,
    speaker: "speaker_1",
    text: "这个预算是不是还有点风险？",
    confidence: 0.92,
    sceneLabels: ["customer_call"],
    valueLabels: ["open_question", "risk"]
  }
];

describe("openai audio insight provider", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_AUDIO_INSIGHT_MODEL;
  const originalTextModel = process.env.OPENAI_TEXT_MODEL;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test_key";
    delete process.env.OPENAI_AUDIO_INSIGHT_MODEL;
    delete process.env.OPENAI_TEXT_MODEL;
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
    if (originalModel === undefined) {
      delete process.env.OPENAI_AUDIO_INSIGHT_MODEL;
    } else {
      process.env.OPENAI_AUDIO_INSIGHT_MODEL = originalModel;
    }
    if (originalTextModel === undefined) {
      delete process.env.OPENAI_TEXT_MODEL;
    } else {
      process.env.OPENAI_TEXT_MODEL = originalTextModel;
    }
  });

  it("returns validated interaction insights from the model response", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [
          {
            sourceSegmentIds: ["seg_1"],
            speaker: {
              id: "speaker_1",
              role: "customer",
              confidence: 0.72
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
            interactionLabels: ["follow_up_question", "tension"],
            summary: "客户在试探预算风险。",
            evidence: "原文问“预算是不是还有点风险”。",
            confidence: 0.78
          }
        ]
      }
    });

    const insights = await openaiAudioInsightProvider.analyze("upload_ai", segments);

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      uploadId: "upload_ai",
      sourceSegmentIds: ["seg_1"],
      toneLabels: ["hesitant", "questioning"],
      emotionLabels: ["anxious"],
      interactionLabels: ["follow_up_question", "tension"],
      summary: "客户在试探预算风险。"
    });
    expect(parseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4.1-mini"
      })
    );
    const request = parseMock.mock.calls[0][0];
    expect(request.input[0].content).toContain("气氛线索");
    expect(request.input[0].content).toContain("emotionEvidence");
    expect(request.input[0].content).toContain("每个判断必须有 sourceSegmentIds");
    expect(request.input[0].content).toContain("不要做心理诊断");
  });

  it("uses the audio insight model env before the generic text model", async () => {
    process.env.OPENAI_AUDIO_INSIGHT_MODEL = "openai/gpt-5.5";
    process.env.OPENAI_TEXT_MODEL = "openai/gpt-5-mini";
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [
          {
            sourceSegmentIds: ["seg_1"],
            speaker: {
              id: "speaker_1",
              role: "customer",
              confidence: 0.72
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
            summary: "客户在试探预算风险。",
            evidence: "原文问“预算是不是还有点风险”。",
            confidence: 0.78
          }
        ]
      }
    });

    await openaiAudioInsightProvider.analyze("upload_ai", segments);

    expect(parseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-5.5"
      })
    );
  });

  it("falls back to the text model when the audio insight model env is blank", async () => {
    process.env.OPENAI_AUDIO_INSIGHT_MODEL = "   ";
    process.env.OPENAI_TEXT_MODEL = "openai/gpt-5-mini";
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [
          {
            sourceSegmentIds: ["seg_1"],
            speaker: {
              id: "speaker_1",
              role: "customer",
              confidence: 0.72
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
            summary: "客户在试探预算风险。",
            evidence: "原文问“预算是不是还有点风险”。",
            confidence: 0.78
          }
        ]
      }
    });

    await openaiAudioInsightProvider.analyze("upload_ai", segments);

    expect(parseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-5-mini"
      })
    );
  });

  it("rejects empty model results for non-empty transcripts so provider fallback can run", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: []
      }
    });

    await expect(openaiAudioInsightProvider.analyze("upload_ai", segments)).rejects.toThrow("no valid audio insights");
  });

  it("falls back to parsing JSON text when structured Responses parsing is not enforced", async () => {
    parseMock.mockRejectedValue(new Error("422 status code"));
    createMock.mockResolvedValue({
      output_text: `\`\`\`json
{
  "items": [
    {
      "sourceSegmentIds": ["seg_1"],
      "speaker": {
        "id": "speaker_1",
        "role": "customer",
        "confidence": 0.72
      },
      "voice": {
        "pace": "normal",
        "volume": "unknown",
        "pause": "normal",
        "overlap": false,
        "confidence": 0.45
      },
      "toneLabels": ["questioning"],
      "emotionLabels": ["anxious"],
      "interactionLabels": ["follow_up_question"],
      "summary": "客户在试探预算风险。",
      "evidence": "原文问“预算是不是还有点风险”。",
      "confidence": 0.78
    }
  ]
}
\`\`\``
    });

    const insights = await openaiAudioInsightProvider.analyze("upload_ai", segments);

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      sourceSegmentIds: ["seg_1"],
      toneLabels: ["questioning"],
      summary: "客户在试探预算风险。"
    });
    expect(createMock).toHaveBeenCalled();
  });

  it("normalizes object evidence from Tokenhub JSON text responses", async () => {
    parseMock.mockRejectedValue(new Error("Expected string, received object"));
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [
          {
            sourceSegmentIds: ["seg_1"],
            speaker: {
              id: "speaker_1",
              role: "customer",
              confidence: 0.72
            },
            voice: {
              pace: "normal",
              volume: "unknown",
              pause: "normal",
              overlap: false,
              confidence: 0.45
            },
            toneLabels: ["questioning"],
            emotionLabels: ["anxious"],
            interactionLabels: ["follow_up_question"],
            summary: "客户在试探预算风险。",
            evidence: {
              textEvidence: [
                {
                  quote: "预算是不是还有点风险",
                  detail: "出现风险试探式提问。"
                }
              ],
              reason: "出现风险试探式提问。"
            },
            confidence: 0.78
          }
        ]
      })
    });

    const insights = await openaiAudioInsightProvider.analyze("upload_ai", segments);

    expect(insights[0].evidence).toContain("预算是不是还有点风险");
  });
});
