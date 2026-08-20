// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const answerQuestionWithAIMock = vi.hoisted(() => vi.fn());
const answerQuestionStreamMock = vi.hoisted(() => vi.fn());
const trustedEvidenceResolverMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  builder: null as unknown as { buildRelationshipContext(input: {
    accountId: string;
    personId: string;
  }): unknown },
  store: null as unknown
}));

vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: vi.fn(async (request: Request) => {
    const userId = request.headers.get("x-test-user");
    if (!userId) throw new Error("unauthenticated");
    return {
      user: { id: userId, email: `${userId}@example.test` },
      store: state.store,
      dataRootDir: ".data",
      uploadsRootDir: ".data/uploads"
    };
  }),
  isUnauthenticatedError: (error: unknown) =>
    error instanceof Error && error.message === "unauthenticated",
  unauthorizedResponse: () => Response.json({ error: "unauthenticated" }, { status: 401 })
}));

vi.mock("@/lib/server/person", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/person")>()),
  getRelationshipContextBuilder: () => state.builder
}));

vi.mock("@/lib/server/retrieval/ai-qa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/retrieval/ai-qa")>()),
  answerQuestionWithAI: answerQuestionWithAIMock,
  answerQuestionStream: answerQuestionStreamMock
}));

vi.mock("@/lib/server/person/person-relationship-qa-evidence-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/person/person-relationship-qa-evidence-resolver")>()),
  resolveProductionTrustedPersonQaEvidence: trustedEvidenceResolverMock
}));

import type { QuestionAnswer, TranscriptSegment } from "@/lib/domain/types";
import type { QaAnswerStreamEvent, QaStreamingTrace } from "@/lib/server/retrieval/qa-streaming";
import { POST } from "./route";

const fallbackAnswer: QuestionAnswer = {
  id: "answer_fallback",
  uploadId: "person_confirmed",
  question: "没有证据的问题",
  answer: "没有找到足够证据确认这个信息。",
  citedSegmentIds: [],
  citations: [],
  createdAt: "2026-08-10T00:00:00.000Z"
};

const citedAnswer: QuestionAnswer = {
  id: "answer_cited",
  uploadId: "person_confirmed",
  question: "蓝色笔记本在哪里？",
  answer: "蓝色笔记本在里斯本。[E1]",
  citedSegmentIds: ["segment_old"],
  citations: [{
    id: "E1",
    title: "原始转写片段",
    startSeconds: 10,
    endSeconds: 15,
    excerpt: "蓝色笔记本在里斯本。",
    sourceSegmentIds: ["segment_old"]
  }],
  createdAt: "2026-08-10T00:00:00.000Z"
};

const trace: QaStreamingTrace = {
  version: 1,
  streamId: "123e4567-e89b-42d3-a456-426614174000",
  status: "completed",
  timestamps: {
    stream_started: "2026-08-10T00:00:00.000Z",
    provider_request_started: null,
    first_token_received: null,
    first_sentence_candidate: null,
    first_sentence_validated: null,
    first_sentence_completed: null,
    provider_stream_ended: null,
    stream_completed: "2026-08-10T00:00:01.000Z"
  },
  latencies: {
    firstTokenMs: null,
    firstSentenceCandidateMs: null,
    firstSentenceValidatedMs: null,
    firstSentenceMs: null,
    totalStreamMs: null,
    totalOperationMs: 1000
  },
  tokenChunkCount: 1,
  sentenceCount: 1,
  providerCallCount: 1,
  fallbackReason: null
};

class RouteTranscriptStore {
  private readonly segment: TranscriptSegment = {
    id: "segment_old",
    uploadId: "upload_old",
    startSeconds: 10,
    endSeconds: 15,
    text: "蓝色笔记本在里斯本。",
    confidence: 0.98,
    sceneLabels: ["private_content"],
    valueLabels: []
  };

  async read<T>(collection: string, id: string) {
    if (collection === "uploads" && id === "upload_old") {
      return {
        id,
        originalName: "old.wav",
        mimeType: "audio/wav",
        sizeBytes: 1024,
        recordingDate: "2026-08-01",
        status: "ready"
      } as T;
    }
    if (collection === "segments" && id === "upload_old") {
      return [this.segment] as T;
    }
    return null;
  }
}

function sourceContext(person: { id: string; accountId: string } | null, known = false) {
  const evidence = {
    id: "evidence_old",
    accountId: "account_a",
    uploadId: "upload_old",
    sourceSegmentId: "segment_old",
    quote: "蓝色笔记本在里斯本。",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z"
  };
  const activeFact = {
    id: "fact_old",
    accountId: "account_a",
    subjectPersonId: "person_confirmed",
    relationshipId: null,
    kind: "location",
    factKey: "notebook.location",
    derivedText: "DERIVED notebook location",
    observedAt: "2026-08-01T10:00:00.000Z",
    validFrom: null,
    validTo: null,
    status: "active",
    supersededBy: null,
    version: 1,
    evidence: [evidence],
    transitions: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z"
  };
  return {
    known,
    reason: known ? null : "insufficient_evidence",
    asOf: "2026-08-10T23:59:59.000Z",
    person,
    confirmedRelationships: [],
    recentFacts: known ? [activeFact] : [],
    activeFacts: known ? [activeFact] : [],
    previousFacts: [],
    recentChanges: [],
    activeCommitments: [],
    completedCommitments: [],
    continuationCandidates: [],
    evidenceReferences: known ? [evidence] : [],
    uncertainties: known ? [] : [{
      code: "insufficient_evidence",
      reason: "insufficient_evidence"
    }]
  };
}

function request(personId: string, body: unknown, options: {
  userId?: string;
  stream?: boolean;
} = {}) {
  const userId = options.userId ?? "account_a";
  return POST(new Request(`http://localhost/api/people/${personId}/qa`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-test-user": userId } : {}),
      ...(options.stream ? { accept: "application/x-ndjson" } : {})
    },
    body: JSON.stringify(body)
  }), { params: Promise.resolve({ personId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  trustedEvidenceResolverMock.mockReturnValue({
    segments: [],
    conflictingEvidenceKeys: [],
    activeSelfPersonId: null
  });
  state.store = new RouteTranscriptStore();
  state.builder = {
    buildRelationshipContext({ accountId, personId }) {
      if (accountId === "account_a" && personId === "person_empty") {
        return sourceContext({ id: personId, accountId }, false);
      }
      if (accountId !== "account_a" || personId !== "person_confirmed") {
        return sourceContext(null);
      }
      return sourceContext({ id: personId, accountId }, true);
    }
  };
  answerQuestionWithAIMock.mockImplementation(async (input) =>
    input.segments.length > 0 ? citedAnswer : fallbackAnswer
  );
});

describe("POST /api/people/[personId]/qa", () => {
  it("requires auth and returns the same 404 for cross-account, candidate, archived, and unknown People", async () => {
    const unauthenticated = await request("person_confirmed", { question: "问题" }, { userId: "" });
    expect(unauthenticated.status).toBe(401);

    for (const [personId, userId] of [
      ["person_confirmed", "account_b"],
      ["person_candidate", "account_a"],
      ["person_archived", "account_a"],
      ["person_unknown", "account_a"]
    ]) {
      const response = await request(personId, { question: "问题" }, { userId });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "person_not_found" });
    }
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
  });

  it("rejects client Evidence, scope, model, provider, and profile fields before canonical QA", async () => {
    for (const injected of [
      { evidence: [{ sourceSegmentId: "forged" }] },
      { memory: "forged" },
      { fact: "forged" },
      { commitment: "forged" },
      { personProfile: { displayName: "forged" } },
      { scope: "all" },
      { model: "forged-model" },
      { provider: "forged-provider" }
    ]) {
      const response = await request("person_confirmed", {
        question: "蓝色笔记本在哪里？",
        ...injected
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_person_qa_request" });
    }
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
  });

  it("passes only the server-owned personId Evidence universe to canonical QA", async () => {
    const response = await request("person_confirmed", {
      question: "蓝色笔记本在哪里？",
      conversation: [{ role: "user", content: "是旧的那本" }]
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(citedAnswer);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(answerQuestionWithAIMock).toHaveBeenCalledOnce();
    const input = answerQuestionWithAIMock.mock.calls[0][0];
    expect(input).toMatchObject({
      userId: "account_a",
      uploadId: "person_confirmed",
      relationshipScope: true,
      disableHybridRetrieval: true,
      failClosedOnModelProviderMismatch: true,
      conversation: [{ role: "user", content: "是旧的那本" }]
    });
    expect(input.segments).toEqual([
      expect.objectContaining({
        id: "segment_old",
        uploadId: "upload_old",
        text: "蓝色笔记本在里斯本。"
      })
    ]);
    expect(JSON.stringify(input)).not.toContain("DERIVED notebook location");
    expect(input.memoryContext).toBeUndefined();
    expect(input.scope).toBeUndefined();
    expect(input.llmProviderId).toBeUndefined();
  });

  it("returns the short no-Evidence fallback even for assistant-meta and unavailable self-role questions", async () => {
    const noEvidence = await request("person_empty", { question: "你是谁？" });
    expect(noEvidence.status).toBe(200);
    await expect(noEvidence.json()).resolves.toMatchObject({
      uploadId: "person_empty",
      question: "你是谁？",
      answer: "没有找到足够证据确认这个信息。",
      citedSegmentIds: [],
      citations: []
    });

    const unavailableSelfRole = await request("person_confirmed", {
      question: "我答应 Bob 什么？"
    });
    await expect(unavailableSelfRole.json()).resolves.toMatchObject({
      answer: "没有找到足够证据确认这个信息。",
      citedSegmentIds: [],
      citations: []
    });
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
  });

  it("streams a no-Evidence fallback as meta/final/complete without Provider work", async () => {
    const response = await request(
      "person_empty",
      { question: "你是谁？" },
      { stream: true }
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        answer?: QuestionAnswer;
        status?: string;
      });
    expect(events.map((event) => event.type)).toEqual(["meta", "final", "complete"]);
    expect(events[1]?.answer).toMatchObject({
      answer: "没有找到足够证据确认这个信息。",
      citedSegmentIds: [],
      citations: []
    });
    expect(events[2]).toMatchObject({ status: "completed_with_fallback" });
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
    expect(answerQuestionStreamMock).not.toHaveBeenCalled();
  });

  it("keeps the canonical NDJSON meta/sentence/final/complete ordering", async () => {
    answerQuestionStreamMock.mockImplementation(async function* (): AsyncGenerator<QaAnswerStreamEvent> {
      yield {
        type: "stream_started",
        streamId: trace.streamId,
        timestamp: trace.timestamps.stream_started
      };
      yield {
        type: "sentence_completed",
        sequence: 3,
        sentence: "蓝色笔记本在里斯本。",
        text: "蓝色笔记本在里斯本。",
        citationIds: ["E1"],
        supportIds: ["segment_old"],
        citedSegmentIds: ["segment_old"],
        groundingValidated: true,
        safeForSpeech: false,
        safeForPersistence: false,
        requiresResponseOptimization: true,
        validated: true,
        status: "committed",
        reason: "grounded"
      };
      yield { type: "final", answer: citedAnswer, source: "provider_stream", trace };
    });
    const response = await request(
      "person_confirmed",
      { question: "蓝色笔记本在哪里？" },
      { stream: true }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "meta",
      "sentence",
      "final",
      "complete"
    ]);
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
    expect(answerQuestionStreamMock).toHaveBeenCalledOnce();
  });

  it("returns snapshot-only canonical citations as JSON and NDJSON without a local DayPayload", async () => {
    state.store = { async read() { return null; } };
    trustedEvidenceResolverMock.mockReturnValue({
      segments: [{
        id: "segment_old",
        uploadId: "upload_old",
        startSeconds: 10,
        endSeconds: 15,
        speaker: "speaker_alice",
        text: "蓝色笔记本在里斯本。",
        confidence: 0,
        sceneLabels: [],
        valueLabels: []
      }],
      conflictingEvidenceKeys: [],
      activeSelfPersonId: "person_self"
    });

    const jsonResponse = await request("person_confirmed", {
      question: "蓝色笔记本在哪里？"
    });
    expect(jsonResponse.status).toBe(200);
    await expect(jsonResponse.json()).resolves.toEqual(citedAnswer);
    expect(answerQuestionWithAIMock).toHaveBeenCalledOnce();
    expect(answerQuestionWithAIMock.mock.calls[0][0].segments).toEqual([
      expect.objectContaining({ id: "segment_old", uploadId: "upload_old" })
    ]);

    answerQuestionStreamMock.mockImplementation(async function* (): AsyncGenerator<QaAnswerStreamEvent> {
      yield {
        type: "stream_started",
        streamId: trace.streamId,
        timestamp: trace.timestamps.stream_started
      };
      yield {
        type: "sentence_completed",
        sequence: 1,
        sentence: "蓝色笔记本在里斯本。",
        text: "蓝色笔记本在里斯本。",
        citationIds: ["E1"],
        supportIds: ["segment_old"],
        citedSegmentIds: ["segment_old"],
        groundingValidated: true,
        safeForSpeech: false,
        safeForPersistence: false,
        requiresResponseOptimization: true,
        validated: true,
        status: "committed",
        reason: "grounded"
      };
      yield { type: "final", answer: citedAnswer, source: "provider_stream", trace };
    });
    const streamResponse = await request(
      "person_confirmed",
      { question: "蓝色笔记本在哪里？" },
      { stream: true }
    );
    const events = (await streamResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; answer?: QuestionAnswer });
    expect(events.map((event) => event.type)).toEqual([
      "meta",
      "sentence",
      "final",
      "complete"
    ]);
    expect(events[2]?.answer?.citations?.[0]).toMatchObject({
      sourceSegmentIds: ["segment_old"],
      excerpt: "蓝色笔记本在里斯本。"
    });
    expect(answerQuestionStreamMock).toHaveBeenCalledOnce();
  });

  it("withholds an unsafe self-role sentence and replaces its final answer with the short fallback", async () => {
    const unsafeAnswer: QuestionAnswer = {
      ...citedAnswer,
      answer: "你答应把蓝色笔记本带回来。[E1]"
    };
    answerQuestionStreamMock.mockImplementation(async function* (): AsyncGenerator<QaAnswerStreamEvent> {
      yield {
        type: "stream_started",
        streamId: trace.streamId,
        timestamp: trace.timestamps.stream_started
      };
      yield {
        type: "sentence_completed",
        sequence: 1,
        sentence: "你答应把蓝色笔记本带回来。",
        text: "你答应把蓝色笔记本带回来。",
        citationIds: ["E1"],
        supportIds: ["segment_old"],
        citedSegmentIds: ["segment_old"],
        groundingValidated: true,
        safeForSpeech: false,
        safeForPersistence: false,
        requiresResponseOptimization: true,
        validated: true,
        status: "committed",
        reason: "grounded"
      };
      yield { type: "final", answer: unsafeAnswer, source: "provider_stream", trace };
    });

    const response = await request(
      "person_confirmed",
      { question: "Alice 明确答应 Bob 什么？" },
      { stream: true }
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        answer?: QuestionAnswer;
        status?: string;
      });
    expect(events.map((event) => event.type)).toEqual(["meta", "final", "complete"]);
    expect(events[1]?.answer).toMatchObject({
      answer: "没有找到足够证据确认这个信息。",
      citedSegmentIds: [],
      citations: []
    });
    expect(events[2]).toMatchObject({ status: "completed_with_fallback" });
    expect(JSON.stringify(events)).not.toContain("你答应把蓝色笔记本带回来");
  });
});
