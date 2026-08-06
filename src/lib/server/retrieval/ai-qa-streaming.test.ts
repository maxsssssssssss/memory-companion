import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCreateMock = vi.hoisted(() => vi.fn());
const responsesCreateMock = vi.hoisted(() => vi.fn());
const createOpenAIClientMock = vi.hoisted(() => vi.fn());
const resolveOpenAIClientProviderMock = vi.hoisted(() => vi.fn(() => "openai-compatible"));
const getOpenAIClientRuntimeConfigMock = vi.hoisted(() => vi.fn());
const getQaModelPreferenceMock = vi.hoisted(() => vi.fn());
const getQaPromptPreferenceMock = vi.hoisted(() => vi.fn());
const retrieveProductionHybridEvidenceMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/openai/client", () => ({
  createOpenAIClient: createOpenAIClientMock,
  resolveOpenAIClientProvider: resolveOpenAIClientProviderMock
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: getOpenAIClientRuntimeConfigMock,
  getQaModelPreference: getQaModelPreferenceMock,
  getQaPromptPreference: getQaPromptPreferenceMock
}));

vi.mock("./hybrid/production-retrieval", () => ({
  ProductionHybridRetrievalError: class ProductionHybridRetrievalError extends Error {},
  retrieveProductionHybridEvidence: retrieveProductionHybridEvidenceMock
}));

import type { AudioInsight, BriefItem, TranscriptSegment } from "@/lib/domain/types";
import { answerQuestionStream, type AnswerQuestionStreamInput } from "./ai-qa";
import type { QaAnswerStreamEvent } from "./qa-streaming";

const originalQaWireApi = process.env.OPENAI_QA_WIRE_API;
const originalHybridRetrievalMode = process.env.QA_HYBRID_RETRIEVAL_MODE;

function asyncStream<T>(items: T[], failure?: Error): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
      if (failure) throw failure;
    }
  };
}

function segment(): TranscriptSegment {
  return {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 10,
    endSeconds: 20,
    text: "今天确认了周日下午的安排。",
    confidence: 0.96,
    sceneLabels: ["unknown"],
    valueLabels: ["decision"]
  };
}

function brief(): BriefItem {
  return {
    id: "brief_1",
    uploadId: "upload_1",
    category: "decision",
    title: "确认周日下午安排",
    body: "双方确认了周日下午的安排。",
    priority: "high",
    confidence: 0.94,
    status: "confirmed",
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
    transcriptExcerpt: "今天确认了周日下午的安排。",
    people: [],
    topics: ["周日下午安排"]
  };
}

function audioInsight(): AudioInsight {
  return {
    id: "audio_1",
    uploadId: "upload_1",
    sourceSegmentIds: ["seg_audio"],
    sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
    speaker: {
      id: "speaker_1",
      displayName: "speaker_1",
      role: "unknown",
      confidence: 0.5
    },
    voice: {
      pace: "normal",
      volume: "normal",
      pause: "many",
      overlap: false,
      confidence: 0.7
    },
    toneLabels: ["serious"],
    emotionLabels: ["interested"],
    interactionLabels: ["agreement"],
    summary: "后来已经确认了周日的安排。",
    evidence: "确认通知已经收到。",
    confidence: 0.9
  };
}

function input(overrides: Partial<AnswerQuestionStreamInput> = {}): AnswerQuestionStreamInput {
  return {
    uploadId: "upload_1",
    question: "今天确认了什么？",
    segments: [segment()],
    semanticSegments: [],
    briefItems: [brief()],
    ...overrides
  };
}

async function collect(streamInput: AnswerQuestionStreamInput) {
  const events: QaAnswerStreamEvent[] = [];
  for await (const event of answerQuestionStream(streamInput)) events.push(event);
  return events;
}

function validAnswer() {
  return JSON.stringify({
    mode: "memory_answer",
    answer: "今天确认了周日下午的安排。[E1]",
    citationIds: ["E1"]
  });
}

describe("answerQuestionStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_QA_WIRE_API = "chat";
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openAiApiKey: "test-key" });
    getQaModelPreferenceMock.mockResolvedValue("test-model");
    getQaPromptPreferenceMock.mockResolvedValue(undefined);
    createOpenAIClientMock.mockReturnValue({
      chat: { completions: { create: chatCreateMock } },
      responses: { create: responsesCreateMock }
    });
  });

  afterEach(() => {
    if (originalQaWireApi === undefined) delete process.env.OPENAI_QA_WIRE_API;
    else process.env.OPENAI_QA_WIRE_API = originalQaWireApi;
    if (originalHybridRetrievalMode === undefined) {
      delete process.env.QA_HYBRID_RETRIEVAL_MODE;
    } else {
      process.env.QA_HYBRID_RETRIEVAL_MODE = originalHybridRetrievalMode;
    }
    vi.restoreAllMocks();
  });

  it("emits ordered unsafe deltas, then validated sentences, then final completion", async () => {
    const answer = validAnswer();
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: answer.slice(0, 20) } }] },
      { choices: [{ delta: { content: answer.slice(20, 44) } }] },
      { choices: [{ delta: { content: answer.slice(44) } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));
    const traceObserver = vi.fn();

    const events = await collect(input({ onStreamTrace: traceObserver }));
    const types = events.map((event) => event.type);
    const tokens = events.filter((event) => event.type === "token");
    const sentence = events.find((event) => event.type === "sentence_completed");
    const final = events.at(-1);

    expect(types[0]).toBe("stream_started");
    expect(types.lastIndexOf("token")).toBeLessThan(types.indexOf("sentence_completed"));
    expect(types.at(-1)).toBe("final");
    expect(tokens).toHaveLength(3);
    expect(tokens.every((event) => !event.safeForSpeech && !event.validated)).toBe(true);
    expect(sentence).toMatchObject({
      sentence: "今天确认了周日下午的安排。",
      text: "今天确认了周日下午的安排。",
      citationIds: ["E1"],
      supportIds: ["seg_1"],
      groundingValidated: true,
      safeForSpeech: false,
      safeForPersistence: false,
      requiresResponseOptimization: true,
      validated: true,
      status: "committed",
      reason: "grounded"
    });
    expect(final).toMatchObject({
      type: "final",
      source: "provider_stream",
      answer: { citedSegmentIds: ["seg_1"] },
      trace: {
        status: "completed",
        tokenChunkCount: 3,
        sentenceCount: 1,
        providerCallCount: 1,
        sentenceCommit: {
          sentenceUnits: 1,
          committedUnits: 1,
          missingSentenceSupport: 0,
          citationMetadataMismatch: 0,
          responseNotFullyCommittable: 0
        },
        latencies: {
          firstTokenMs: expect.any(Number),
          firstSentenceMs: expect.any(Number)
        }
      }
    });
    expect(traceObserver).toHaveBeenCalledOnce();
  });

  it("uses the shared Hybrid adapter for streaming phase31 QA", async () => {
    process.env.QA_HYBRID_RETRIEVAL_MODE = "phase31";
    retrieveProductionHybridEvidenceMock.mockImplementation(async ({ lexical }) => ({
      evidence: lexical.evidence,
      denseRetrievalMs: 9,
      indexCoverage: 1
    }));
    const answer = validAnswer();
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: answer } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const events = await collect(input({ userId: "user_1" }));

    expect(retrieveProductionHybridEvidenceMock).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({
      type: "final",
      answer: { citedSegmentIds: ["seg_1"] }
    });
  });

  it("emits a grounded first sentence before later provider deltas and final JSON", async () => {
    const firstDelta =
      '{"mode":"memory_answer","answer":"今天确认了周日下午的安排。[E1] 后面还';
    const secondDelta = '补充了同一安排。[E1]","citationIds":["E1"]}';
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: firstDelta } }] },
      { choices: [{ delta: { content: secondDelta } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const events = await collect(input());
    const firstTokenIndex = events.findIndex(
      (event) => event.type === "token" && event.sequence === 1
    );
    const secondTokenIndex = events.findIndex(
      (event) => event.type === "token" && event.sequence === 2
    );
    const firstSentenceIndex = events.findIndex(
      (event) => event.type === "sentence_completed" && event.sequence === 1
    );

    expect(firstTokenIndex).toBeGreaterThanOrEqual(0);
    expect(firstSentenceIndex).toBeGreaterThan(firstTokenIndex);
    expect(firstSentenceIndex).toBeLessThan(secondTokenIndex);
    expect(events[firstSentenceIndex]).toMatchObject({
      text: "今天确认了周日下午的安排。",
      supportIds: ["seg_1"],
      citedSegmentIds: ["seg_1"],
      groundingValidated: true
    });
    expect(events.at(-1)?.type).toBe("final");
  });

  it("keeps a premature lifecycle-completion claim quarantined", async () => {
    const firstDelta =
      '{"mode":"memory_answer","answer":"她已经完成了周二陪练。[E1] 后续';
    const secondDelta = '状态仍需核对。[E1]","citationIds":["E1"]}';
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: firstDelta } }] },
      { choices: [{ delta: { content: secondDelta } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const events = await collect(input({
      question: "她答应的事情都做完了吗？",
      segments: [{
        ...segment(),
        text: "她答应周二陪练。"
      }],
      briefItems: []
    }));
    const secondTokenIndex = events.findIndex(
      (event) => event.type === "token" && event.sequence === 2
    );
    const earlyCompletionIndex = events.findIndex(
      (event) =>
        event.type === "sentence_completed" &&
        event.text.includes("已经完成")
    );

    expect(secondTokenIndex).toBeGreaterThanOrEqual(0);
    expect(
      earlyCompletionIndex === -1 || earlyCompletionIndex > secondTokenIndex
    ).toBe(true);
  });

  it("does not early-commit a named owner when current metadata is unresolved", async () => {
    const firstDelta =
      '{"mode":"memory_answer","answer":"伴侣喜欢安静环境。[E1] 后续';
    const secondDelta = '归属仍需确认。[E1]","citationIds":["E1"]}';
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: firstDelta } }] },
      { choices: [{ delta: { content: secondDelta } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const events = await collect(input({
      question: "她喜欢什么环境？",
      segments: [{
        ...segment(),
        text: "她喜欢安静环境。"
      }],
      briefItems: [],
      memoryContext: {
        scope: "current",
        memories: [],
        ownerAttributions: [{
          version: 1,
          memoryId: "memory_1",
          memoryType: "preference",
          scope: "unknown",
          owner: {
            type: "unknown",
            confidence: 0,
            source: "unknown"
          },
          participants: [],
          evidenceSegmentIds: ["seg_1"],
          reasons: ["ambiguous_owner"]
        }],
        evidence: [],
        sourceIds: ["seg_1"],
        distinctDates: [],
        count: 0,
        retrievalTimeMs: 0
      }
    }));
    const secondTokenIndex = events.findIndex(
      (event) => event.type === "token" && event.sequence === 2
    );
    const earlyOwnerIndex = events.findIndex(
      (event) =>
        event.type === "sentence_completed" &&
        event.text.includes("伴侣喜欢")
    );

    expect(secondTokenIndex).toBeGreaterThanOrEqual(0);
    expect(earlyOwnerIndex === -1 || earlyOwnerIndex > secondTokenIndex).toBe(true);
  });

  it("keeps a semicolon compound answer as one grounded streaming sentence", async () => {
    const providerAnswer = JSON.stringify({
      mode: "memory_answer",
      answer: "先确认了时间；后来完成了安排。[E1]",
      citationIds: ["E1"]
    });
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: providerAnswer.slice(0, 35) } }] },
      { choices: [{ delta: { content: providerAnswer.slice(35) } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const events = await collect(input());
    const sentences = events.filter((event) => event.type === "sentence_completed");

    expect(sentences).toEqual([expect.objectContaining({
      sequence: 1,
      sentence: "先确认了时间；后来完成了安排。",
      citationIds: ["E1"],
      supportIds: ["seg_1"],
      groundingValidated: true,
      status: "committed"
    })]);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "provider_stream",
      trace: {
        sentenceCount: 1,
        sentenceCommit: {
          sentenceUnits: 1,
          committedUnits: 1,
          missingSentenceSupport: 0,
          citationMetadataMismatch: 0,
          responseNotFullyCommittable: 0
        }
      }
    });
  });

  it("switches only the evaluation Evidence block while keeping canonical grounding", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const providerAnswer = validAnswer();
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: providerAnswer } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const audioSegment = {
      ...segment(),
      id: "seg_audio",
      text: "后来确认安排时语气很认真。"
    };
    const benchmarkInput = {
      question: "后来确认安排时的语气和互动是什么？",
      segments: [segment(), audioSegment],
      audioInsights: [audioInsight()]
    };
    const canonicalEvents = await collect(input({
      ...benchmarkInput,
      audioInsights: [audioInsight()],
      evaluationEvidenceView: "canonical"
    }));
    const canonicalRequest = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };

    chatCreateMock.mockClear();
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: providerAnswer } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));
    const compactEvents = await collect(input({
      ...benchmarkInput,
      evaluationEvidenceView: "compact"
    }));
    const compactRequest = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(compactRequest.messages[0]?.content).toBe(
      canonicalRequest.messages[0]?.content
    );
    expect(canonicalRequest.messages[1]?.content).toContain(
      "声音估计：语速normal"
    );
    expect(compactRequest.messages[1]?.content).not.toContain("声音估计");
    expect(compactRequest.messages[1]?.content).toContain(
      "后来已经确认了周日的安排。"
    );
    expect(compactRequest.messages[1]?.content).toContain(
      "确认通知已经收到。"
    );
    expect(compactRequest.messages[1]!.content.length).toBeLessThan(
      canonicalRequest.messages[1]!.content.length
    );
    expect(canonicalEvents.at(-1)).toMatchObject({
      type: "final",
      answer: { citedSegmentIds: ["seg_audio"] }
    });
    expect(compactEvents.at(-1)).toMatchObject({
      type: "final",
      answer: { citedSegmentIds: ["seg_audio"] }
    });
    expect(
      info.mock.calls.some(([message]) =>
        String(message).startsWith("EVIDENCE_COMPRESSION_SHADOW: ")
      )
    ).toBe(false);
    info.mockRestore();
  });

  it("treats an empty stream as unavailable and uses answerQuestionWithAI fallback", async () => {
    chatCreateMock.mockImplementation(async (request: { stream?: boolean }) =>
      request.stream
        ? asyncStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
        : { choices: [{ message: { content: validAnswer() } }] }
    );

    const events = await collect(input());
    const final = events.at(-1);

    expect(events.filter((event) => event.type === "token")).toHaveLength(0);
    expect(final).toMatchObject({
      type: "final",
      source: "non_stream_fallback",
      trace: {
        status: "completed_with_fallback",
        fallbackReason: "empty_stream",
        providerCallCount: 2,
        latencies: { firstTokenMs: null, firstSentenceMs: expect.any(Number) }
      }
    });
    expect(chatCreateMock).toHaveBeenCalledTimes(2);
  });

  it("falls back after a partial provider failure without releasing its unvalidated sentence", async () => {
    chatCreateMock.mockImplementation(async (request: { stream?: boolean }) =>
      request.stream
        ? asyncStream(
          [{ choices: [{ delta: { content: '{"answer":"未经校验的内容。' } }] }],
          new TypeError("upstream stream unavailable")
        )
        : { choices: [{ message: { content: validAnswer() } }] }
    );

    const events = await collect(input());
    const final = events.at(-1);

    const tokenEvents = events.filter((event) => event.type === "token");
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]).toMatchObject({
      safeForSpeech: false,
      safeForPersistence: false,
      validated: false
    });
    expect(events.filter((event) => event.type === "sentence_completed")).toHaveLength(1);
    expect(final).toMatchObject({
      type: "final",
      source: "non_stream_fallback",
      trace: {
        status: "completed_with_fallback",
        fallbackReason: "provider_error_after_partial_stream",
        providerCallCount: 2
      }
    });
  });

  it("supports Responses API text deltas while preserving the same final validation", async () => {
    process.env.OPENAI_QA_WIRE_API = "responses";
    const answer = validAnswer();
    responsesCreateMock.mockResolvedValue(asyncStream([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: answer.slice(0, 30) },
      { type: "response.output_text.delta", delta: answer.slice(30) },
      { type: "response.completed", response: { status: "completed" } }
    ]));

    const events = await collect(input());

    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "provider_stream",
      answer: { citedSegmentIds: ["seg_1"] }
    });
    expect(responsesCreateMock).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
  });

  it("fails closed when Chat JSON reaches clean EOF without a completion marker", async () => {
    chatCreateMock.mockImplementation(async (request: { stream?: boolean }) =>
      request.stream
        ? asyncStream([{ choices: [{ delta: { content: validAnswer() } }] }])
        : { choices: [{ message: { content: validAnswer() } }] }
    );

    const events = await collect(input());

    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "non_stream_fallback",
      trace: {
        fallbackReason: "incomplete_stream",
        providerCallCount: 2
      }
    });
  });

  it("accepts a Responses done-only text event only with explicit completion", async () => {
    process.env.OPENAI_QA_WIRE_API = "responses";
    responsesCreateMock.mockResolvedValue(asyncStream([
      { type: "response.output_text.done", text: validAnswer() },
      { type: "response.completed", response: { status: "completed" } }
    ]));

    const events = await collect(input());

    expect(events.filter((event) => event.type === "token")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "provider_stream",
      answer: { citedSegmentIds: ["seg_1"] }
    });
  });

  it("falls back when Responses explicitly reports an incomplete stream", async () => {
    process.env.OPENAI_QA_WIRE_API = "responses";
    responsesCreateMock.mockImplementation(async (request: { stream?: boolean }) =>
      request.stream
        ? asyncStream([{ type: "response.incomplete", response: { status: "incomplete" } }])
        : { output_text: validAnswer() }
    );

    const events = await collect(input());

    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "non_stream_fallback",
      trace: {
        fallbackReason: "incomplete_stream",
        providerCallCount: 2
      }
    });
  });

  it("labels deterministic citation fallback separately from a validated provider answer", async () => {
    const unsupportedCitationAnswer = JSON.stringify({
      mode: "memory_answer",
      answer: "今天确认了周日下午的安排。",
      citationIds: []
    });
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: unsupportedCitationAnswer } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const events = await collect(input());

    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "provider_stream_validation_fallback",
      trace: {
        status: "completed_with_fallback",
        fallbackReason: "missing_citations",
        providerCallCount: 1
      }
    });
  });

  it("does not emit a sentence commit when response-level citations cannot align the sentence", async () => {
    const answerWithoutInlineSupport = JSON.stringify({
      mode: "memory_answer",
      answer: "今天确认了周日下午的安排。",
      citationIds: ["E1"]
    });
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: answerWithoutInlineSupport } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const events = await collect(input());

    expect(events.filter((event) => event.type === "sentence_completed")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "provider_stream",
      answer: { citedSegmentIds: ["seg_1"] },
      trace: {
        sentenceCount: 0,
        timestamps: { first_sentence_completed: null },
        latencies: { firstSentenceMs: null }
      }
    });
  });

  it("never commits a completed-looking sentence from a failed partial stream", async () => {
    const unsafePartial = JSON.stringify({
      mode: "memory_answer",
      answer: "他一定永远不会改变。[E1]",
      citationIds: ["E1"]
    });
    chatCreateMock.mockImplementation(async (request: { stream?: boolean }) =>
      request.stream
        ? asyncStream(
          [{ choices: [{ delta: { content: unsafePartial } }] }],
          new TypeError("upstream failed after content")
        )
        : { choices: [{ message: { content: validAnswer() } }] }
    );

    const events = await collect(input());
    const sentenceEvents = events.filter((event) => event.type === "sentence_completed");

    expect(sentenceEvents).toHaveLength(1);
    expect(sentenceEvents[0]).toMatchObject({
      sentence: "今天确认了周日下午的安排。",
      supportIds: ["seg_1"],
      groundingValidated: true,
      safeForSpeech: false
    });
    expect(sentenceEvents.some((event) => event.sentence.includes("永远不会改变"))).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "non_stream_fallback",
      trace: { fallbackReason: "provider_error_after_partial_stream" }
    });
  });

  it("does not commit a forbidden relationship conclusion replaced by final validation", async () => {
    const forbiddenAnswer = JSON.stringify({
      mode: "memory_answer",
      answer: "他一定爱你。[E1]",
      citationIds: ["E1"]
    });
    chatCreateMock.mockResolvedValue(asyncStream([
      { choices: [{ delta: { content: forbiddenAnswer } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]));

    const events = await collect(input({ question: "这个是不是说明他在乎我？" }));
    const sentences = events
      .filter((event) => event.type === "sentence_completed")
      .map((event) => event.sentence);

    expect(sentences.some((sentence) => sentence.includes("一定爱你"))).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      source: "provider_stream_validation_fallback",
      trace: { fallbackReason: "forbidden_relationship_output" }
    });
  });
});
