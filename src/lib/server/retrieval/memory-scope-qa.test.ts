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

    const answer = await answerMemoryScopeQuestion({
      scopeId: "all_memory",
      question: "过去有哪些未解决的问题？",
      qaScope: "all",
      userId: "user_1",
      store
    });

    expect(answer).toEqual(expectedAnswer);
    expect(retrieveMemoryIndexEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", scope: "all", query: "过去有哪些未解决的问题？" })
    );
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ memoryContext })
    );
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
