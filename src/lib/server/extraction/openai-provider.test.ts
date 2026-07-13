import type { SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
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
  zodTextFormat: vi.fn(() => ({ name: "founder_daily_brief" }))
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: getOpenAIClientRuntimeConfigMock
}));

import { openaiExtractionProvider } from "./openai-provider";

const segments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_test",
    startSeconds: 10,
    endSeconds: 20,
    speaker: "speaker_1",
    text: "我们决定先做每日复盘。",
    confidence: 0.9,
    sceneLabels: ["product_discussion"],
    valueLabels: ["decision"]
  },
  {
    id: "seg_2",
    uploadId: "upload_test",
    startSeconds: 30,
    endSeconds: 45,
    speaker: "speaker_1",
    text: "下周把报价方案发给客户。",
    confidence: 0.88,
    sceneLabels: ["customer_call"],
    valueLabels: ["task"]
  },
  {
    id: "seg_3",
    uploadId: "upload_test",
    startSeconds: 5,
    endSeconds: 8,
    speaker: "speaker_2",
    text: "风险是没有证据链用户不会信。",
    confidence: 0.86,
    sceneLabels: ["product_discussion"],
    valueLabels: ["risk"]
  }
];

function extractedItem(sourceSegmentIds: string[]) {
  return {
    category: "task",
    title: "跟进客户报价",
    body: "下周把报价方案发给客户。",
    priority: "high",
    confidence: 0.82,
    sourceSegmentIds,
    transcriptExcerpt: "下周把报价方案发给客户。",
    people: ["客户"],
    topics: ["报价"]
  };
}

describe("openai extraction provider", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalTimeout = process.env.OPENAI_REQUEST_TIMEOUT_MS;
  const originalMaxRetries = process.env.OPENAI_MAX_RETRIES;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const originalOrg = process.env.OPENAI_ORG_ID;
  const originalProject = process.env.OPENAI_PROJECT_ID;
  const originalResponseMode = process.env.EXTRACTION_RESPONSE_MODE;
  const originalChunkTimeout = process.env.EXTRACTION_CHUNK_TIMEOUT_MS;
  const originalExtractionRetries = process.env.EXTRACTION_MAX_RETRIES;
  const originalTotalTimeout = process.env.EXTRACTION_TOTAL_TIMEOUT_MS;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test_key";
    createMock.mockReset();
    parseMock.mockReset();
    openAIMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({});
    process.env.EXTRACTION_RESPONSE_MODE = "auto";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    if (originalTimeout === undefined) {
      delete process.env.OPENAI_REQUEST_TIMEOUT_MS;
    } else {
      process.env.OPENAI_REQUEST_TIMEOUT_MS = originalTimeout;
    }
    if (originalMaxRetries === undefined) {
      delete process.env.OPENAI_MAX_RETRIES;
    } else {
      process.env.OPENAI_MAX_RETRIES = originalMaxRetries;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    }
    if (originalOrg === undefined) {
      delete process.env.OPENAI_ORG_ID;
    } else {
      process.env.OPENAI_ORG_ID = originalOrg;
    }
    if (originalProject === undefined) {
      delete process.env.OPENAI_PROJECT_ID;
    } else {
      process.env.OPENAI_PROJECT_ID = originalProject;
    }
    if (originalResponseMode === undefined) {
      delete process.env.EXTRACTION_RESPONSE_MODE;
    } else {
      process.env.EXTRACTION_RESPONSE_MODE = originalResponseMode;
    }
    if (originalChunkTimeout === undefined) {
      delete process.env.EXTRACTION_CHUNK_TIMEOUT_MS;
    } else {
      process.env.EXTRACTION_CHUNK_TIMEOUT_MS = originalChunkTimeout;
    }
    if (originalExtractionRetries === undefined) {
      delete process.env.EXTRACTION_MAX_RETRIES;
    } else {
      process.env.EXTRACTION_MAX_RETRIES = originalExtractionRetries;
    }
    if (originalTotalTimeout === undefined) {
      delete process.env.EXTRACTION_TOTAL_TIMEOUT_MS;
    } else {
      process.env.EXTRACTION_TOTAL_TIMEOUT_MS = originalTotalTimeout;
    }
  });

  function longSegments(count = 64) {
    return Array.from({ length: count }, (_, index): TranscriptSegment => ({
      id: `long_seg_${index + 1}`,
      uploadId: "upload_long",
      startSeconds: index * 15,
      endSeconds: index * 15 + 12,
      speaker: index % 2 === 0 ? "speaker_1" : "speaker_2",
      text: `第 ${index + 1} 段长录音内容，需要提取有证据的安排。`,
      confidence: 0.9,
      sceneLabels: ["product_discussion"],
      valueLabels: index % 16 === 0 ? ["task"] : []
    }));
  }

  function semanticGroup(index: number, sourceSegments: TranscriptSegment[]): SemanticSegment {
    const first = sourceSegments[0];
    const last = sourceSegments[sourceSegments.length - 1];
    return {
      id: `semantic_${index}`,
      uploadId: "upload_long",
      title: `主题 ${index}`,
      summary: `主题 ${index} 摘要`,
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
      tags: ["产品"],
      sceneLabels: ["product_discussion"],
      valueLabels: [],
      confidence: 0.9,
      sourceSegmentIds: sourceSegments.map((segment) => segment.id),
      sourceTimeRange: { startSeconds: first.startSeconds, endSeconds: last.endSeconds },
      transcriptExcerpt: first.text
    };
  }

  function jsonResponseForRequest(request: { input?: unknown }) {
    const sourceId = JSON.stringify(request.input).match(/\[(long_seg_\d+)\]/)?.[1] ?? "seg_1";
    return {
      output_text: JSON.stringify({ items: [extractedItem([sourceId])] })
    };
  }

  it("uses one JSON Responses request with extraction-specific limits", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    process.env.EXTRACTION_CHUNK_TIMEOUT_MS = "45000";
    process.env.EXTRACTION_MAX_RETRIES = "1";
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items: [extractedItem(["seg_2"])] }) });

    const result = await openaiExtractionProvider.extract("upload_test", segments);

    expect(result).toHaveLength(1);
    expect(parseMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toEqual(expect.objectContaining({ max_output_tokens: 3_000 }));
    expect(createMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        timeout: 45_000,
        maxRetries: 1,
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("extracts long recordings sequentially by semantic chunk and assigns globally unique IDs", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    const sourceSegments = longSegments();
    const semanticSegments = Array.from({ length: 4 }, (_, index) =>
      semanticGroup(index + 1, sourceSegments.slice(index * 16, (index + 1) * 16))
    );
    createMock.mockImplementation(jsonResponseForRequest);

    const result = await openaiExtractionProvider.extract("upload_long", sourceSegments, { semanticSegments });

    expect(createMock).toHaveBeenCalledTimes(4);
    expect(result.map((item) => item.id)).toEqual([
      "upload_long_brief_1",
      "upload_long_brief_2",
      "upload_long_brief_3",
      "upload_long_brief_4"
    ]);
    expect(result.map((item) => item.sourceSegmentIds[0])).toEqual([
      "long_seg_1",
      "long_seg_17",
      "long_seg_33",
      "long_seg_49"
    ]);
  });

  it("falls back only the failed chunk and continues the remaining LLM chunks", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    const sourceSegments = longSegments();
    const semanticSegments = Array.from({ length: 4 }, (_, index) =>
      semanticGroup(index + 1, sourceSegments.slice(index * 16, (index + 1) * 16))
    );
    let requestNumber = 0;
    createMock.mockImplementation((request) => {
      requestNumber += 1;
      if (requestNumber === 2) {
        return Promise.reject(new Error("request timed out"));
      }
      return Promise.resolve(jsonResponseForRequest(request));
    });
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_long", sourceSegments, {
      semanticSegments,
      onProgress
    });

    expect(createMock).toHaveBeenCalledTimes(4);
    expect(result).toHaveLength(4);
    expect(result.map((item) => item.sourceSegmentIds[0])).toEqual([
      "long_seg_1",
      "long_seg_17",
      "long_seg_33",
      "long_seg_49"
    ]);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "chunk_fallback", chunkIndex: 2, reason: "timeout" })
    );
  });

  it("uses rule fallback for all remaining chunks when the total deadline is exhausted", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    process.env.EXTRACTION_TOTAL_TIMEOUT_MS = "0";
    const sourceSegments = longSegments();
    const semanticSegments = Array.from({ length: 4 }, (_, index) =>
      semanticGroup(index + 1, sourceSegments.slice(index * 16, (index + 1) * 16))
    );
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_long", sourceSegments, {
      semanticSegments,
      onProgress
    });

    expect(createMock).not.toHaveBeenCalled();
    expect(result).toHaveLength(4);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "chunk_fallback", chunkIndex: 1, reason: "deadline" })
    );
  });

  it("keeps a valid empty LLM result empty instead of inventing rule items", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items: [] }) });

    const result = await openaiExtractionProvider.extract("upload_test", segments);

    expect(result).toEqual([]);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid JSON", "not-json", "invalid_json"],
    ["invalid schema", JSON.stringify({}), "invalid_schema"]
  ])("uses rule fallback for %s output", async (_label, outputText, expectedReason) => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    createMock.mockResolvedValue({ output_text: outputText });
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(result).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "chunk_fallback", chunkIndex: 1, reason: expectedReason })
    );
  });

  it("rejects more than six LLM items for a chunk and uses rule fallback", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    createMock.mockResolvedValue({
      output_text: JSON.stringify({ items: Array.from({ length: 7 }, () => extractedItem(["seg_2"])) })
    });
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(result).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "chunk_fallback", reason: "invalid_schema" })
    );
  });

  it(
    "aborts an in-flight request when the total extraction deadline expires",
    async () => {
      process.env.EXTRACTION_RESPONSE_MODE = "json";
      process.env.EXTRACTION_TOTAL_TIMEOUT_MS = "25";
      createMock.mockImplementation((_request, requestOptions) =>
        new Promise((_resolve, reject) => {
          requestOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
      );
      const onProgress = vi.fn();

      const result = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

      expect(result).toHaveLength(3);
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "chunk_fallback", reason: "deadline" })
      );
    },
    1_000
  );

  it("computes a covering time range for multi-source items", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [extractedItem(["seg_2", "seg_3"])]
      }
    });

    const [item] = await openaiExtractionProvider.extract("upload_test", segments);

    expect(item.sourceSegmentIds).toEqual(["seg_2", "seg_3"]);
    expect(item.sourceTimeRange).toEqual({
      startSeconds: 5,
      endSeconds: 45
    });
  });

  it("filters invalid source IDs from mixed evidence", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [extractedItem(["seg_1", "missing_seg", "seg_2"])]
      }
    });

    const [item] = await openaiExtractionProvider.extract("upload_test", segments);

    expect(item.sourceSegmentIds).toEqual(["seg_1", "seg_2"]);
    expect(item.sourceTimeRange).toEqual({
      startSeconds: 10,
      endSeconds: 45
    });
  });

  it("drops items without resolved source IDs", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [extractedItem([]), extractedItem(["missing_seg"])]
      }
    });

    const items = await openaiExtractionProvider.extract("upload_test", segments);

    expect(items).toEqual([]);
  });

  it("falls back to parsing JSON text when structured Responses parsing is not enforced", async () => {
    parseMock.mockRejectedValue(new Error("Unexpected token '`'"));
    createMock.mockResolvedValue({
      output_text: `\`\`\`json
{
  "items": [
    {
      "category": "task",
      "title": "跟进客户报价",
      "body": "下周把报价方案发给客户。",
      "priority": "high",
      "confidence": 0.82,
      "sourceSegmentIds": ["seg_2"],
      "transcriptExcerpt": "下周把报价方案发给客户。",
      "people": ["客户"],
      "topics": ["报价"]
    }
  ]
}
\`\`\``
    });

    const [item] = await openaiExtractionProvider.extract("upload_test", segments);

    expect(item).toMatchObject({
      category: "task",
      title: "跟进客户报价",
      sourceSegmentIds: ["seg_2"]
    });
    expect(createMock).toHaveBeenCalled();
  });

  it("passes OpenAI client env config into SDK options", async () => {
    process.env.OPENAI_REQUEST_TIMEOUT_MS = "45000";
    process.env.OPENAI_MAX_RETRIES = "5";
    process.env.OPENAI_BASE_URL = "https://openai-proxy.test/v1";
    process.env.OPENAI_ORG_ID = "org_test";
    process.env.OPENAI_PROJECT_ID = "project_test";
    parseMock.mockResolvedValue({ output_parsed: { items: [] } });

    await openaiExtractionProvider.extract("upload_test", segments);

    expect(openAIMock).toHaveBeenCalledWith({
      apiKey: "test_key",
      organization: "org_test",
      project: "project_test",
      baseURL: "https://openai-proxy.test/v1",
      timeout: 45000,
      maxRetries: 5
    });
  });
});
