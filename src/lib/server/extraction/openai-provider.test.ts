import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonAnalysisChunkCheckpointStore } from "@/lib/server/analysis-chunks/checkpoint";
import { JsonStore } from "@/lib/server/storage/json-store";

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
  zodTextFormat: vi.fn(() => ({ name: "founder_daily_brief" }))
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: getOpenAIClientRuntimeConfigMock
}));

import {
  openaiExtractionProvider,
  resolveDailyBriefCheckpointLeaseMs
} from "./openai-provider";

let tempDir: string | undefined;

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
  const originalMaxOutputTokens = process.env.EXTRACTION_MAX_OUTPUT_TOKENS;
  const originalRetryDelay = process.env.DAILY_BRIEF_CHUNK_RETRY_DELAY_MS;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test_key";
    createMock.mockReset();
    captureProviderValidationFailureMock.mockReset();
    captureProviderValidationFailureMock.mockResolvedValue({ captured: true });
    parseMock.mockReset();
    openAIMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockReset();
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({});
    process.env.EXTRACTION_RESPONSE_MODE = "auto";
    process.env.DAILY_BRIEF_CHUNK_RETRY_DELAY_MS = "0";
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
    if (originalMaxOutputTokens === undefined) {
      delete process.env.EXTRACTION_MAX_OUTPUT_TOKENS;
    } else {
      process.env.EXTRACTION_MAX_OUTPUT_TOKENS = originalMaxOutputTokens;
    }
    if (originalRetryDelay === undefined) {
      delete process.env.DAILY_BRIEF_CHUNK_RETRY_DELAY_MS;
    } else {
      process.env.DAILY_BRIEF_CHUNK_RETRY_DELAY_MS = originalRetryDelay;
    }
    if (tempDir) {
      const directory = tempDir;
      tempDir = undefined;
      return rm(directory, { recursive: true, force: true });
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

  it("keeps the default checkpoint lease bounded below the effective stage budget", () => {
    expect(resolveDailyBriefCheckpointLeaseMs(600_000)).toBe(60_000);
    expect(resolveDailyBriefCheckpointLeaseMs(30_000)).toBe(15_000);
    expect(resolveDailyBriefCheckpointLeaseMs(1)).toBe(1);
    expect(resolveDailyBriefCheckpointLeaseMs(0)).toBe(1);
    expect(() => resolveDailyBriefCheckpointLeaseMs(-1)).toThrow(/non-negative/u);
  });

  it("disables SDK retries so the stage recovery queue owns retry accounting", async () => {
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
        maxRetries: 0,
        signal: expect.any(AbortSignal)
      })
    );
  });

  it.each([
    {
      label: "network failure",
      firstAttempt: () => Promise.reject(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))
    },
    {
      label: "request timeout",
      firstAttempt: () => Promise.reject(Object.assign(new Error("request timed out"), { name: "APIConnectionTimeoutError" }))
    },
    {
      label: "HTTP 503",
      firstAttempt: () => Promise.reject(Object.assign(new Error("service unavailable"), { status: 503 }))
    },
    {
      label: "empty response",
      firstAttempt: () => Promise.resolve({ output_text: "" })
    },
    {
      label: "incomplete JSON",
      firstAttempt: () => Promise.resolve({ output_text: "{\"items\":[" })
    },
    {
      label: "max output tokens",
      firstAttempt: () => Promise.resolve({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "{\"items\":["
      })
    },
    {
      label: "invalid JSON",
      firstAttempt: () => Promise.resolve({ output_text: "{invalid}" })
    }
  ])("retries one $label in the explicit recovery phase", async ({ firstAttempt }) => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    process.env.EXTRACTION_MAX_RETRIES = "1";
    createMock
      .mockImplementationOnce(firstAttempt)
      .mockResolvedValue({ output_text: JSON.stringify({ items: [extractedItem(["seg_2"])] }) });
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "chunk_completed",
        chunkIndex: 1,
        resultSource: "provider_retry_success"
      })
    );
  });

  it("uses compact recovery mode after a max-output incomplete response", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    createMock
      .mockResolvedValueOnce({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "{\"items\":["
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({ items: [extractedItem(["seg_2"])] })
      });

    const result = await openaiExtractionProvider.extract("upload_test", segments);

    expect(result).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(createMock.mock.calls[1][0].input)).toContain("截断响应的恢复请求");
  });

  it("uses compact recovery mode after a generic incomplete provider response", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    createMock
      .mockResolvedValueOnce({
        status: "incomplete",
        incomplete_details: { reason: "server_error" },
        output_text: "{\"items\":["
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({ items: [extractedItem(["seg_2"])] })
      });

    const result = await openaiExtractionProvider.extract("upload_test", segments);

    expect(result).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(createMock.mock.calls[1][0].input)).toContain("截断响应的恢复请求");
  });

  it("aborts a provider promise that ignores the signal and recovers the timed-out chunk", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    process.env.EXTRACTION_CHUNK_TIMEOUT_MS = "10";
    createMock
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        output_text: JSON.stringify({ items: [extractedItem(["seg_2"])] })
      });
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(result).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      phase: "chunk_completed",
      resultSource: "provider_retry_success"
    }));
  });

  it("checkpoints retry success provenance and reuses it without another provider call", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-retry-checkpoint-"));
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    createMock
      .mockRejectedValueOnce(Object.assign(new Error("temporary upstream failure"), { status: 503 }))
      .mockResolvedValueOnce({
        output_text: JSON.stringify({ items: [extractedItem(["seg_2"])] })
      });
    const checkpointOptions = {
      store: checkpointStore,
      userId: "user_1",
      recordingDate: "2026-07-15",
      staleAfterMs: 60_000
    };

    await openaiExtractionProvider.extract("upload_test", segments, {
      analysisCheckpoint: checkpointOptions
    });
    await openaiExtractionProvider.extract("upload_test", segments, {
      analysisCheckpoint: checkpointOptions
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    const checkpoints = await checkpointStore.list({
      userId: "user_1",
      uploadId: "upload_test",
      kind: "daily_brief"
    });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].resultSource).toBe("provider_retry_success");
    expect(checkpoints[0].metadata).toMatchObject({
      providerAttemptCount: 2,
      retryCount: 1
    });
    expect(checkpoints[0].metadata.validationIssueSummary).toBeUndefined();
  });

  it.each([
    {
      label: "schema validation failure",
      response: { output_text: JSON.stringify({ items: [{}] }) },
      expectedReason: "validation_failure"
    },
    {
      label: "content filter response",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output_text: ""
      },
      expectedReason: "content_filter"
    },
    {
      label: "invalid evidence source ID",
      response: {
        output_text: JSON.stringify({ items: [extractedItem(["seg_1", "missing_seg"])] })
      },
      expectedReason: "evidence_validation_failure"
    }
  ])("does not retry a $label", async ({ response, expectedReason }) => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    process.env.EXTRACTION_MAX_RETRIES = "1";
    createMock.mockResolvedValue(response);
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "chunk_fallback",
        chunkIndex: 1,
        reason: expectedReason,
        resultSource: "rule_fallback"
      })
    );
  });

  it("captures Daily Brief schema failures only when the evaluation upload enables the side channel", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    const rawResponse = JSON.stringify({ items: [{ title: "raw-private-marker" }] });
    createMock.mockResolvedValue({ output_text: rawResponse });

    await openaiExtractionProvider.extract("upload_test", segments, {
      evaluationRawResponseCapture: true
    });

    expect(captureProviderValidationFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "daily_brief",
      uploadId: "upload_test",
      chunkIndex: 0,
      attempt: 1,
      model: expect.any(String),
      rawResponse,
      validationIssues: expect.arrayContaining([
        expect.objectContaining({ code: "missing_field" })
      ]),
      evaluationRetention: true
    }));
  });

  it("falls back only after the explicit recovery attempt also fails", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    process.env.EXTRACTION_MAX_RETRIES = "1";
    createMock.mockRejectedValue(Object.assign(new Error("upstream unavailable"), { status: 503 }));
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "chunk_fallback",
        chunkIndex: 1,
        reason: "provider_5xx",
        resultSource: "rule_fallback"
      })
    );
  });

  it("redacts provider failure details from fallback logs and checkpoint attempt diagnostics", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-provider-redaction-"));
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    const sensitiveTranscript = "PRIVATE_TRANSCRIPT_SHOULD_NOT_APPEAR";
    const sensitiveResponse = "PRIVATE_RESPONSE_SHOULD_NOT_APPEAR";
    const sensitiveToken = "token=PRIVATE_TOKEN_SHOULD_NOT_APPEAR";
    const diagnosticSegments = segments.map((segment, index) => ({
      ...segment,
      text: index === 0 ? sensitiveTranscript : segment.text
    }));
    createMock.mockRejectedValue(Object.assign(
      new Error(`${sensitiveResponse} ${sensitiveToken}`),
      { status: 503, headers: { authorization: "PRIVATE_AUTH_HEADER" } }
    ));
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await openaiExtractionProvider.extract("upload_test", diagnosticSegments, {
        analysisCheckpoint: {
          store: checkpointStore,
          userId: "user_1",
          recordingDate: "2026-07-15",
          staleAfterMs: 60_000
        }
      });

      const checkpoints = await checkpointStore.list({
        userId: "user_1",
        uploadId: "upload_test",
        kind: "daily_brief"
      });
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].resultSource).toBe("rule_fallback");
      expect(checkpoints[0].metadata).toMatchObject({
        providerAttemptCount: 2,
        retryCount: 1,
        fallbackReason: "provider_5xx"
      });
      const serialized = JSON.stringify({
        metadata: checkpoints[0].metadata,
        logs: [...consoleInfo.mock.calls, ...consoleError.mock.calls]
      });
      for (const sensitive of [
        sensitiveTranscript,
        sensitiveResponse,
        sensitiveToken,
        "PRIVATE_AUTH_HEADER"
      ]) {
        expect(serialized).not.toContain(sensitive);
      }
    } finally {
      consoleInfo.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("does not hide a second full JSON request behind auto response mode", async () => {
    process.env.EXTRACTION_RESPONSE_MODE = "auto";
    process.env.EXTRACTION_MAX_RETRIES = "1";
    parseMock.mockRejectedValue(Object.assign(new Error("structured endpoint unavailable"), { status: 503 }));
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items: [extractedItem(["seg_2"])] }) });
    const onProgress = vi.fn();

    const result = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(parseMock).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
    expect(result).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "chunk_fallback", reason: "provider_5xx" })
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
        return Promise.resolve({
          output_text: JSON.stringify({ items: [extractedItem(["missing_segment"])] })
        });
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
      expect.objectContaining({
        phase: "chunk_fallback",
        chunkIndex: 2,
        reason: "evidence_validation_failure"
      })
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
    ["invalid schema", JSON.stringify({}), "validation_failure"]
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
      expect.objectContaining({ phase: "chunk_fallback", reason: "validation_failure" })
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

  it("deterministically backfills a verbatim transcript excerpt from valid evidence", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [{
          ...extractedItem(["seg_2"]),
          transcriptExcerpt: "MODEL_GENERATED_NON_VERBATIM_TEXT"
        }]
      }
    });

    const [item] = await openaiExtractionProvider.extract("upload_test", segments);

    expect(item.transcriptExcerpt).toBe(segments[1].text);
  });

  it("rejects mixed valid and invalid source IDs instead of weakening evidence", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [extractedItem(["seg_1", "missing_seg", "seg_2"])]
      }
    });

    const onProgress = vi.fn();
    const items = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(items).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "chunk_fallback", reason: "evidence_validation_failure" })
    );
  });

  it("rejects items without resolved source IDs instead of silently dropping them", async () => {
    parseMock.mockResolvedValue({
      output_parsed: {
        items: [extractedItem([]), extractedItem(["missing_seg"])]
      }
    });

    const onProgress = vi.fn();
    const items = await openaiExtractionProvider.extract("upload_test", segments, { onProgress });

    expect(items).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "chunk_fallback", reason: "evidence_validation_failure" })
    );
  });

  it("keeps auto mode on one request contract when structured parsing fails", async () => {
    parseMock.mockRejectedValue(new SyntaxError("Unexpected token '`'"));
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

    const result = await openaiExtractionProvider.extract("upload_test", segments);

    expect(result).toHaveLength(3);
    expect(parseMock).toHaveBeenCalledTimes(2);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("logs bounded validation structure and checkpoints only a redacted issue summary", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-validation-diagnostics-"));
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    const sensitiveTranscript = "PRIVATE_TRANSCRIPT_SHOULD_NOT_APPEAR";
    const sensitiveQuote = "PRIVATE_QUOTE_SHOULD_NOT_APPEAR";
    const sensitiveToken = "token=PRIVATE_TOKEN_SHOULD_NOT_APPEAR";
    const diagnosticSegments = segments.map((segment, index) => ({
      ...segment,
      text: index === 0 ? sensitiveTranscript : segment.text
    }));
    createMock.mockResolvedValue({
      output_text: JSON.stringify({
        items: [{ title: sensitiveQuote, body: sensitiveToken }]
      })
    });
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const checkpointOptions = {
      store: checkpointStore,
      userId: "user_1",
      recordingDate: "2026-07-15",
      staleAfterMs: 60_000
    };

    try {
      await openaiExtractionProvider.extract("upload_test", diagnosticSegments, {
        analysisCheckpoint: checkpointOptions,
        evaluationRawResponseCapture: true
      });
      await openaiExtractionProvider.extract("upload_test", diagnosticSegments, {
        analysisCheckpoint: checkpointOptions,
        evaluationRawResponseCapture: true
      });

      expect(createMock).toHaveBeenCalledTimes(1);
      const checkpoints = await checkpointStore.list({
        userId: "user_1",
        uploadId: "upload_test",
        kind: "daily_brief"
      });
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].resultSource).toBe("rule_fallback");
      expect(checkpoints[0].metadata).toMatchObject({
        providerAttemptCount: 1,
        retryCount: 0,
        fallbackReason: "validation_failure"
      });
      expect(checkpoints[0].metadata.validationIssueSummary).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "missing_field" })])
      );
      const responseDiagnostics = checkpoints[0].metadata.responseDiagnostics as Record<string, unknown>;
      expect(responseDiagnostics).toMatchObject({
        parseResult: "success",
        validationResult: "failed"
      });
      expect(responseDiagnostics.validationIssues).toBeUndefined();
      expect(responseDiagnostics.validationIssueSummary).toBeUndefined();
      expect(JSON.stringify(checkpoints[0].metadata)).not.toContain(sensitiveTranscript);
      expect(JSON.stringify(checkpoints[0].metadata)).not.toContain(sensitiveQuote);
      expect(JSON.stringify(checkpoints[0].metadata)).not.toContain(sensitiveToken);
      expect(captureProviderValidationFailureMock).toHaveBeenCalledTimes(1);
      expect(captureProviderValidationFailureMock).toHaveBeenCalledWith(expect.objectContaining({
        rawResponse: expect.stringContaining(sensitiveQuote),
        validationIssues: expect.arrayContaining([expect.objectContaining({ code: "missing_field" })])
      }));

      const logs = [consoleInfo, consoleWarn, consoleError]
        .flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")))
        .join("\n");
      expect(logs).toContain("[daily-brief-provider] validation_failed");
      expect(logs).toContain("validation_issue_count=");
      expect(logs).toContain("validation_issue_codes=missing_field");
      expect(logs).toContain("validation_issue_paths=items[0].category");
      expect(logs).not.toContain(sensitiveTranscript);
      expect(logs).not.toContain(sensitiveQuote);
      expect(logs).not.toContain(sensitiveToken);
    } finally {
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("invalidates checkpoints when the provider output budget changes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-output-budget-fingerprint-"));
    process.env.EXTRACTION_RESPONSE_MODE = "json";
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    createMock.mockResolvedValue({ output_text: JSON.stringify({ items: [extractedItem(["seg_2"])] }) });
    const checkpointOptions = {
      store: checkpointStore,
      userId: "user_1",
      recordingDate: "2026-07-15",
      staleAfterMs: 60_000
    };

    process.env.EXTRACTION_MAX_OUTPUT_TOKENS = "3000";
    await openaiExtractionProvider.extract("upload_test", segments, {
      analysisCheckpoint: checkpointOptions
    });
    process.env.EXTRACTION_MAX_OUTPUT_TOKENS = "3200";
    await openaiExtractionProvider.extract("upload_test", segments, {
      analysisCheckpoint: checkpointOptions
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0]).toEqual(expect.objectContaining({ max_output_tokens: 3_000 }));
    expect(createMock.mock.calls[1][0]).toEqual(expect.objectContaining({ max_output_tokens: 3_200 }));
    const checkpoints = await checkpointStore.list({
      userId: "user_1",
      uploadId: "upload_test",
      kind: "daily_brief"
    });
    expect(checkpoints[0].attemptCount).toBe(2);
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
