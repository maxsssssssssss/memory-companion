// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonStore } from "@/lib/server/storage/json-store";

const answerQuestionWithAIMock = vi.hoisted(() => vi.fn());
const retrieveQaEvidenceMock = vi.hoisted(() => vi.fn());
const observeMemoryShadowRetrievalMock = vi.hoisted(() => vi.fn());
const retrieveMemoryIndexEvidenceMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/retrieval/ai-qa", () => ({
  answerQuestionWithAI: answerQuestionWithAIMock,
  retrieveQaEvidence: retrieveQaEvidenceMock
}));

vi.mock("@/lib/server/memory/shadow-retrieval", () => ({
  observeMemoryShadowRetrieval: observeMemoryShadowRetrievalMock
}));

vi.mock("@/lib/server/retrieval/memory-index-evidence", () => ({
  retrieveMemoryIndexEvidence: retrieveMemoryIndexEvidenceMock
}));

import { answerMemoryScopeQuestion } from "./memory-scope-qa";

let tempDir: string | undefined;

afterEach(async () => {
  vi.clearAllMocks();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("memory scope QA shadow isolation", () => {
  it("keeps unpublished Reflection uploads out and uses only published canonical allowlisted segments", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-scope-reflection-"));
    const store = new JsonStore(tempDir);
    const reflectionUpload = {
      id: "daily-reflection-reflection_1",
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 100,
      recordingDate: "2026-08-13",
      status: "ready" as const,
      ingestionContext: "daily_reflection" as const,
      reflectionId: "reflection_1"
    };
    await store.write("uploads", reflectionUpload.id, reflectionUpload);
    await store.write("segments", reflectionUpload.id, [{
      id: "segment_store_bypass",
      uploadId: reflectionUpload.id,
      text: "This pending or excluded store projection must not be retrieved."
    }]);
    retrieveMemoryIndexEvidenceMock.mockReturnValue({
      scope: "all",
      memories: [],
      evidence: [],
      sourceIds: [],
      distinctDates: [],
      count: 0,
      retrievalTimeMs: 0
    });

    await expect(answerMemoryScopeQuestion({
      scopeId: "all_memory",
      question: "What did I reflect on?",
      qaScope: "all",
      userId: "user_1",
      store,
      resolveUploadSource: () => ({
        visible: false,
        attribution: {
          origin: "unknown",
          statement: "来源尚未完全确认",
          date: "2026-08-13",
          contentKind: "memory_navigation",
          sourceSegmentIds: []
        }
      })
    })).resolves.toBeNull();
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();

    const canonical = {
      id: "segment_kept",
      uploadId: reflectionUpload.id,
      speaker: "self",
      startSeconds: 0,
      endSeconds: 4,
      text: "I prefer quiet cafes.",
      confidence: 1,
      sceneLabels: ["self_reflection" as const],
      valueLabels: ["notable_quote" as const]
    };
    answerQuestionWithAIMock.mockImplementationOnce(async (input) => ({
      id: "answer_reflection",
      uploadId: input.uploadId,
      question: input.question,
      answer: "You mentioned quiet cafes. [E1]",
      citedSegmentIds: [canonical.id],
      createdAt: "2026-08-13T10:00:00.000Z"
    }));
    await answerMemoryScopeQuestion({
      scopeId: "all_memory",
      question: "What did I reflect on?",
      qaScope: "all",
      userId: "user_1",
      store,
      resolveUploadSource: () => ({
        visible: true,
        canonicalSegments: [canonical],
        attribution: {
          origin: "user_reflection",
          statement: "你在 2026-08-13 的复盘中提到……",
          date: "2026-08-13",
          contentKind: "user_confirmed_derived_content",
          reflectionId: "reflection_1",
          sourceSegmentIds: [canonical.id]
        }
      })
    });
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith(expect.objectContaining({
      segments: [expect.objectContaining({
        id: canonical.id,
        text: expect.stringContaining(canonical.text)
      })],
      audioInsights: [],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: []
    }));
    expect(JSON.stringify(answerQuestionWithAIMock.mock.calls.at(-1)?.[0]))
      .not.toContain("segment_store_bypass");
  });

  it("passes SQLite memory context into all-scope QA", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-scope-context-"));
    const store = new JsonStore(tempDir);
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      originalName: "demo.wav",
      mimeType: "audio/wav",
      sizeBytes: 100,
      recordingDate: "2026-07-08",
      status: "ready"
    });
    await store.write("segments", "upload_1", [
      { id: "segment_1", uploadId: "upload_1", text: "There is an unresolved question." }
    ]);
    const memoryContext = {
      scope: "all",
      memories: [],
      evidence: [],
      sourceIds: ["segment_1"],
      distinctDates: ["2026-07-08"],
      count: 1,
      retrievalTimeMs: 1
    };
    const expectedAnswer = {
      id: "answer_1",
      uploadId: "all_memory",
      question: "过去有哪些未解决的问题？",
      answer: "目前找到一条原始证据。[E1]",
      citedSegmentIds: ["segment_1"],
      createdAt: "2026-07-10T10:00:00.000Z"
    };
    retrieveMemoryIndexEvidenceMock.mockReturnValue(memoryContext);
    retrieveQaEvidenceMock.mockReturnValue([]);
    answerQuestionWithAIMock.mockResolvedValue(expectedAnswer);
    const shadowReviewContext = {
      voiceSessionId: "voice_session_1",
      traceId: "11111111-1111-4111-8111-111111111111"
    };

    const answer = await answerMemoryScopeQuestion({
      scopeId: "all_memory",
      question: "过去有哪些未解决的问题？",
      qaScope: "all",
      userId: "user_1",
      shadowReviewContext,
      store
    });

    expect(answer).toEqual(expectedAnswer);
    expect(retrieveMemoryIndexEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", scope: "all", query: "过去有哪些未解决的问题？" })
    );
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ memoryContext, shadowReviewContext })
    );
    expect(answerQuestionWithAIMock.mock.calls[0][0].shadowReviewContext)
      .toBe(shadowReviewContext);
    expect(answerQuestionWithAIMock.mock.calls[0][0]).not.toHaveProperty("memoryIndexFallback");
  });

  it("keeps QA available when SQLite memory retrieval fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-scope-failure-"));
    const store = new JsonStore(tempDir);
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      originalName: "demo.wav",
      mimeType: "audio/wav",
      sizeBytes: 100,
      recordingDate: "2026-07-08",
      status: "ready"
    });
    await store.write("segments", "upload_1", [
      { id: "segment_1", uploadId: "upload_1", text: "There is an unresolved question." }
    ]);
    const expectedAnswer = {
      id: "answer_2",
      uploadId: "all_memory",
      question: "过去有哪些未解决的问题？",
      answer: "仍然使用 JSON evidence 回答。[E1]",
      citedSegmentIds: ["segment_1"],
      createdAt: "2026-07-10T10:00:00.000Z"
    };
    retrieveMemoryIndexEvidenceMock.mockImplementation(() => {
      throw new Error("memory database unavailable");
    });
    retrieveQaEvidenceMock.mockReturnValue([]);
    answerQuestionWithAIMock.mockResolvedValue(expectedAnswer);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const answer = await answerMemoryScopeQuestion({
        scopeId: "all_memory",
        question: "过去有哪些未解决的问题？",
        qaScope: "all",
        userId: "user_1",
        store
      });

      expect(answer).toEqual(expectedAnswer);
      expect(answerQuestionWithAIMock).toHaveBeenCalledWith(
        expect.objectContaining({ memoryIndexFallback: true })
      );
      expect(answerQuestionWithAIMock.mock.calls[0][0]).not.toHaveProperty("memoryContext");
      expect(warning).toHaveBeenCalledWith(
        "[memory-qa] scope=all memory_retrieval_failure=memory database unavailable"
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("reuses the ranked evidence from the actual QA call for shadow observation", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-scope-shadow-"));
    const store = new JsonStore(tempDir);
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      originalName: "demo.wav",
      mimeType: "audio/wav",
      sizeBytes: 100,
      recordingDate: "2026-07-08",
      status: "ready"
    });
    await store.write("segments", "upload_1", [
      { id: "segment_1", uploadId: "upload_1", text: "有一项待确认的问题。" }
    ]);
    const expectedAnswer = {
      id: "answer_1",
      uploadId: "all_memory",
      question: "过去有哪些问题？",
      answer: "目前只找到一条证据。[E1]",
      citedSegmentIds: ["segment_1"],
      createdAt: "2026-07-10T10:00:00.000Z"
    };
    const rankedEvidence = [{
      id: "segment_1",
      kind: "raw",
      title: "evidence",
      text: "bounded evidence",
      startSeconds: 0,
      endSeconds: 1,
      sourceSegmentIds: ["segment_1"],
      priority: 1
    }];
    answerQuestionWithAIMock.mockImplementation(async (input) => {
      input.onRetrievedEvidence?.(rankedEvidence, 7);
      return expectedAnswer;
    });

    const answer = await answerMemoryScopeQuestion({
      scopeId: "all_memory",
      question: "过去有哪些问题？",
      qaScope: "all",
      userId: "user_1",
      store
    });

    expect(answer).toEqual(expectedAnswer);
    expect(answerQuestionWithAIMock).toHaveBeenCalledOnce();
    expect(retrieveQaEvidenceMock).not.toHaveBeenCalled();
    expect(observeMemoryShadowRetrievalMock).toHaveBeenCalledWith(expect.objectContaining({
      jsonEvidence: rankedEvidence,
      jsonRetrievalTimeMs: 7
    }));
  });
});
