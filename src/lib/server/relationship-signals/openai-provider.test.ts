import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { AudioInsightSchema, type AudioInsight, type SemanticSegment, type TranscriptSegment } from "@/lib/domain/types";
import { resolveAnalysisTranscriptChunks } from "@/lib/server/analysis-chunks/transcript-chunks";

const { captureProviderValidationFailureMock, createMock, getOpenAIClientRuntimeConfigMock, openAIMock, parseMock } = vi.hoisted(() => ({
  captureProviderValidationFailureMock: vi.fn(),
  createMock: vi.fn(),
  getOpenAIClientRuntimeConfigMock: vi.fn(),
  openAIMock: vi.fn(),
  parseMock: vi.fn()
}));

vi.mock("@/lib/server/evaluation/provider-response-capture", () => ({
  captureProviderValidationFailure: captureProviderValidationFailureMock
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
import { createRelationshipSignalCandidates } from "./candidates";

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

function validCompactModelItem(overrides: Record<string, unknown> = {}) {
  return {
    signalType: "boundary_respect",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.83,
    summary: "对方放慢节奏并回应了不舒服的表达。",
    evidenceSegmentIds: ["seg_1", "seg_2"],
    ...overrides
  };
}

describe("openai relationship signal provider", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalTextModel = process.env.OPENAI_TEXT_MODEL;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test_key";
    process.env.OPENAI_TEXT_MODEL = "gpt-test";
    createMock.mockReset();
    captureProviderValidationFailureMock.mockReset();
    captureProviderValidationFailureMock.mockResolvedValue({ captured: true });
    parseMock.mockReset();
    openAIMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("uses trusted global speaker labels without changing transcript source ids", () => {
    const identified = relationshipSegments.map((segment, index) => ({
      ...segment,
      identity: {
        globalSpeakerId: `person_${index + 1}`,
        displayName: index === 0 ? "Contact A" : "Contact B",
        identityType: "known_contact" as const,
        confidence: 0.93,
        source: "voiceprint" as const
      }
    }));

    const identifiedInsight = AudioInsightSchema.parse({
      id: "insight_identified",
      uploadId: "upload_1",
      sourceSegmentIds: ["seg_1"],
      sourceTimeRange: { startSeconds: 12, endSeconds: 26 },
      speaker: { id: "speaker_1", role: "unknown", confidence: 0.7 },
      voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.5 },
      toneLabels: ["comforting"],
      emotionLabels: ["neutral"],
      interactionLabels: ["rapport"],
      summary: "确认了对方的具体担忧。",
      evidence: "仅用于测试的 evidence。",
      confidence: 0.8
    });

    const prompt = buildRelationshipSignalPrompt({
      uploadId: "upload_1",
      recordingDate: "2026-07-16",
      segments: identified,
      semanticSegments: [],
      audioInsights: [identifiedInsight]
    });

    expect(prompt.content).toContain("Contact A");
    expect(prompt.content).toContain("Contact B");
    expect(prompt.content).toContain("speaker=Contact A");
    expect(prompt.content).not.toContain("speaker=speaker_1");
    expect(prompt.content).toContain(identified[0].id);
    expect(identified[0].speaker).toBe("speaker_1");
  });

  it("uses one JSON request and returns normalized relationship signal cards", async () => {
    const onRequestMetrics = vi.fn();
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [validCompactModelItem()]
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
      signalCategory: "positive",
      severity: "low",
      confidence: 0.83,
      timeRange: { startSeconds: 12, endSeconds: 40 },
      involvedSpeakers: ["speaker_1", "speaker_2"]
    });
    expect(cards[0].evidenceSegments).toEqual(relationshipSegments.map((segment) => ({
      segmentId: segment.id,
      speaker: segment.speaker,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: segment.text
    })));
    expect(cards[0].textEvidence).toEqual(relationshipSegments.map((segment) => segment.text));
    expect(cards[0].explanation).toEqual(expect.any(String));
    expect(cards[0].suggestedReflection).toEqual(expect.any(String));
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
      maxOutputTokens: 2800,
      recoveryMode: "standard",
      candidateLimit: 5,
      promptCharacterCount: requestContentChars
    }));
    expect(request.max_output_tokens).toBe(2800);
    expect(parseMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("preserves provider severity through compact conversion and final card normalization", async () => {
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [validCompactModelItem({ severity: "medium" })]
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
    expect(cards[0].severity).toBe("medium");
  });

  it("ignores redundant model evidence fields and deterministically backfills transcript evidence", async () => {
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [
          {
            ...validCompactModelItem(),
            evidenceSegments: [{ segmentId: "invented", text: "invented quote" }],
            counterEvidence: "也有一次没有及时回应",
            acousticEvidence: "语气比较平稳",
            interactionEvidence: "主动询问情况",
            textEvidence: ["invented quote"]
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
    expect(cards[0].evidenceSegments.map((item) => item.segmentId)).toEqual(["seg_1", "seg_2"]);
    expect(cards[0].evidenceSegments.map((item) => item.text)).toEqual(relationshipSegments.map((item) => item.text));
    expect(cards[0].textEvidence).toEqual(relationshipSegments.map((item) => item.text));
    expect(cards[0].counterEvidence).toBeUndefined();
    expect(cards[0].acousticEvidence).toBeUndefined();
    expect(cards[0].interactionEvidence).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
    const jsonRequest = createMock.mock.calls[0][0];
    expect(jsonRequest.input[0].content).toContain("必须是 JSON 数组");
  });

  it("returns an empty compact candidate array when the model finds no high-value signal", async () => {
    const onCandidateAudit = vi.fn();
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items: [] }) });

    await expect(openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      recoveryMode: "standard",
      onCandidateAudit
    })).resolves.toEqual([]);

    expect(onCandidateAudit).toHaveBeenCalledWith({
      contract: "compact",
      recoveryMode: "standard",
      candidateLimit: 5,
      rawCandidateCount: 0,
      compactCandidateCount: 0,
      overLimitCount: 0
    });
  });

  it("quality-ranks an over-limit standard response instead of silently taking its first five items", async () => {
    const onCandidateAudit = vi.fn();
    const items = [
      validCompactModelItem({ confidence: 0.36, summary: "lowest-confidence-first-item" }),
      ...Array.from({ length: 5 }, (_, index) => validCompactModelItem({
        confidence: 0.9 - index * 0.02,
        summary: `specific-independent-candidate-${index + 1}`
      }))
    ];
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items }) });

    const candidates = await openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      recoveryMode: "standard",
      onCandidateAudit
    });

    expect(candidates).toHaveLength(5);
    expect(candidates.map((candidate) => candidate.summary)).not.toContain("lowest-confidence-first-item");
    expect(onCandidateAudit).toHaveBeenCalledWith({
      contract: "compact",
      recoveryMode: "standard",
      candidateLimit: 5,
      rawCandidateCount: 6,
      compactCandidateCount: 5,
      overLimitCount: 1
    });
  });

  it("does not hide a compact schema error by ranking an over-limit response first", async () => {
    const onDiagnostics = vi.fn();
    const items = [
      validCompactModelItem({ signalType: "not_a_signal_type", confidence: 0.1 }),
      ...Array.from({ length: 5 }, (_, index) => validCompactModelItem({
        confidence: 0.9 - index * 0.02,
        summary: `valid-over-limit-candidate-${index + 1}`
      }))
    ];
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items }) });

    await expect(openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      onDiagnostics
    })).rejects.toBeInstanceOf(ZodError);

    expect(onDiagnostics.mock.calls.at(-1)?.[0].validationIssues).toContainEqual({
      path: "items[0].signalType",
      code: "invalid_enum_value",
      message: "Invalid enum value"
    });
  });

  it("limits compact recovery to the three highest-value candidates while keeping the 2800-token budget", async () => {
    const onCandidateAudit = vi.fn();
    const onRequestMetrics = vi.fn();
    const items = Array.from({ length: 5 }, (_, index) => validCompactModelItem({
      confidence: 0.6 + index * 0.05,
      summary: `recovery-candidate-${index + 1}`
    }));
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items }) });

    const candidates = await openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      recoveryMode: "compact",
      onCandidateAudit,
      onRequestMetrics
    });

    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.summary)).toEqual([
      "recovery-candidate-5",
      "recovery-candidate-4",
      "recovery-candidate-3"
    ]);
    expect(createMock.mock.calls[0][0].max_output_tokens).toBe(2800);
    expect(onRequestMetrics).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 2800,
      recoveryMode: "compact",
      candidateLimit: 3
    }));
    expect(onCandidateAudit).toHaveBeenCalledWith({
      contract: "compact",
      recoveryMode: "compact",
      candidateLimit: 3,
      rawCandidateCount: 5,
      compactCandidateCount: 3,
      overLimitCount: 2
    });
  });

  it("converts compact candidates to the existing Raw contract and rejects invalid source ids", async () => {
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [validCompactModelItem({ evidenceSegmentIds: ["invented_segment"] })]
      })
    });

    const rawItems = await openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights
    });
    expect(rawItems[0]).toMatchObject({
      signalType: "boundary_respect",
      evidenceSegmentIds: ["invented_segment"],
      evidenceSegments: [],
      involvedSpeakers: [],
      textEvidence: [],
      explanation: expect.any(String),
      suggestedReflection: expect.any(String)
    });

    const [transcriptChunk] = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments: relationshipSegments,
      now: () => "2026-07-09T00:00:00.000Z"
    });
    const validated = createRelationshipSignalCandidates({
      uploadId: "upload_1",
      transcriptChunk,
      rawItems,
      semanticSegments,
      audioInsights
    });

    expect(validated.candidates).toEqual([]);
    expect(validated.validationRejections).toEqual([
      expect.objectContaining({ rejectionReason: "evidence_missing_or_invalid" })
    ]);
  });

  it("rejects an entire direct-analyze candidate when evidence mixes valid and invented ids", async () => {
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [validCompactModelItem({
          summary: "mixed-invalid-provider-candidate",
          evidenceSegmentIds: ["seg_1", "invented_segment"]
        })]
      })
    });

    const cards = await openaiRelationshipSignalProvider.analyze({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights
    });

    expect(cards.map((card) => card.summary)).not.toContain("mixed-invalid-provider-candidate");
    expect(cards.flatMap((card) => card.evidenceSegments).every(
      (evidence) => relationshipSegments.some((segment) => segment.id === evidence.segmentId)
    )).toBe(true);
  });

  it("reports validation success without validation issues for valid JSON", async () => {
    const onDiagnostics = vi.fn();
    createMock.mockResolvedValue({
      output_text: JSON.stringify({ items: [validCompactModelItem()] })
    });

    await expect(openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      onDiagnostics
    })).resolves.toHaveLength(1);

    const diagnostics = onDiagnostics.mock.calls.at(-1)?.[0];
    expect(diagnostics).toMatchObject({
      parseResult: "success",
      validationResult: "success"
    });
    expect(diagnostics.validationIssues).toBeUndefined();
    expect(diagnostics.validationIssueSummary).toBeUndefined();
  });

  it("reports missing Relationship candidate fields with indexed paths", async () => {
    const onDiagnostics = vi.fn();
    createMock.mockResolvedValue({
      output_text: JSON.stringify({ items: [{}] })
    });

    await expect(openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      onDiagnostics
    })).rejects.toBeInstanceOf(ZodError);

    const diagnostics = onDiagnostics.mock.calls.at(-1)?.[0];
    expect(diagnostics).toMatchObject({
      parseResult: "success",
      validationResult: "failed",
      validationIssuesTruncated: false
    });
    expect(diagnostics.validationIssues).toEqual(expect.arrayContaining([
      {
        path: "items[0].signalType",
        code: "missing_field",
        message: "Required field is missing"
      }
    ]));
    expect(diagnostics.validationIssueSummary).toContainEqual({
      code: "missing_field",
      count: expect.any(Number)
    });
  });

  it("reports invalid Relationship signal enums without retaining the invalid value", async () => {
    const onDiagnostics = vi.fn();
    const sensitiveInvalidValue = "PRIVATE_TRANSCRIPT_QUOTE_WITH_TOKEN";
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [validCompactModelItem({ signalType: sensitiveInvalidValue })]
      })
    });

    await expect(openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      onDiagnostics
    })).rejects.toBeInstanceOf(ZodError);

    const diagnostics = onDiagnostics.mock.calls.at(-1)?.[0];
    expect(diagnostics.validationIssues).toContainEqual({
      path: "items[0].signalType",
      code: "invalid_enum_value",
      message: "Invalid enum value"
    });
    expect(JSON.stringify(diagnostics)).not.toContain(sensitiveInvalidValue);
  });

  it("reports evidenceSegmentIds type failures", async () => {
    const onDiagnostics = vi.fn();
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [validCompactModelItem({ evidenceSegmentIds: "seg_1" })]
      })
    });

    await expect(openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      onDiagnostics
    })).rejects.toBeInstanceOf(ZodError);

    const diagnostics = onDiagnostics.mock.calls.at(-1)?.[0];
    expect(diagnostics.validationIssues).toContainEqual({
      path: "items[0].evidenceSegmentIds",
      code: "invalid_type",
      message: "Invalid value type"
    });
  });

  it("normalizes the supported confidence labels before strict validation", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [
          validCompactModelItem({ confidence: "high" }),
          validCompactModelItem({ confidence: "MEDIUM" }),
          validCompactModelItem({ confidence: "Low" })
        ]
      })
    });

    const candidates = await openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights
    });

    expect(candidates.map((candidate) => candidate.confidence)).toEqual([0.85, 0.65, 0.35]);
    expect(info).toHaveBeenCalledWith(
      "[relationship-confidence-normalization] field=confidence original_type=string normalized=true count=3"
    );
  });

  it("does not normalize unsupported or null confidence values", async () => {
    for (const confidence of ["very high", "probably", "sure", "maybe", null]) {
      createMock.mockResolvedValue({
        output_text: JSON.stringify({
          items: [validCompactModelItem({ confidence })]
        })
      });

      await expect(openaiRelationshipSignalProvider.extractCandidates!({
        uploadId: "upload_1",
        recordingDate: "2026-07-09",
        segments: relationshipSegments,
        semanticSegments,
        audioInsights
      })).rejects.toBeInstanceOf(ZodError);
    }
  });

  it("forwards an exact validation-failure response to the evaluation capture side channel", async () => {
    const rawResponse = JSON.stringify({
      items: [validCompactModelItem({ confidence: "unrecognized", summary: "raw-private-marker" })]
    });
    createMock.mockResolvedValue({ output_text: rawResponse });

    await expect(openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      evaluationRawResponseCapture: {
        evaluationRetention: true,
        chunkIndex: 6,
        attempt: 1
      }
    })).rejects.toBeInstanceOf(ZodError);

    expect(captureProviderValidationFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "relationship_signal",
      uploadId: "upload_1",
      chunkIndex: 6,
      attempt: 1,
      model: "gpt-test",
      rawResponse,
      validationIssues: [expect.objectContaining({
        path: "items[0].confidence",
        code: "invalid_type"
      })],
      evaluationRetention: true
    }));
  });

  it("preserves numeric confidence without emitting normalization logs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [validCompactModelItem({ confidence: 0.8 })]
      })
    });

    const candidates = await openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights
    });

    expect(candidates[0]?.confidence).toBe(0.8);
    expect(info).not.toHaveBeenCalled();
  });

  it("keeps confidence normalization logs free of provider content", async () => {
    const sensitiveContent = "PRIVATE_TRANSCRIPT_QUOTE_WITH_TOKEN";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [validCompactModelItem({ confidence: "HIGH", summary: sensitiveContent })]
      })
    });

    await openaiRelationshipSignalProvider.extractCandidates!({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights
    });

    expect(info.mock.calls.flat().join(" ")).not.toContain(sensitiveContent);
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
