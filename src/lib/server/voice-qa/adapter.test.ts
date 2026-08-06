import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionAnswer } from "@/lib/domain/types";
import type { ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import { VoiceEvent } from "@/lib/server/voice/events";
import type { answerMemoryScopeQuestion } from "@/lib/server/retrieval/memory-scope-qa";
import type { answerQuestionWithAI } from "@/lib/server/retrieval/ai-qa";
import type { answerQuestionStream } from "@/lib/server/retrieval/ai-qa";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  VoiceQaAdapterError,
  createMemoryVoiceQaAnswerer,
  normalizeVoiceQaQuery,
  parseVoiceQaTranscriptUpdates,
  projectVoiceQaAnswer
} from "./adapter";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), "voice-qa-adapter-"));
  temporaryRoots.push(root);
  return new JsonStore(root);
}

function parsedEvent(input: {
  eventId?: number;
  sessionId?: string;
  payload?: unknown;
}): ParsedVoiceServerEvent {
  const eventId = input.eventId ?? VoiceEvent.ASRResponse;
  return {
    eventId,
    eventName: eventId === VoiceEvent.ASRResponse ? "ASRResponse" : "ChatResponse",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    rawPayload: Buffer.alloc(0),
    compressed: false,
    serialization: "json",
    unknown: false
  };
}

function questionAnswer(overrides: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return {
    id: "answer_1",
    uploadId: "upload_1",
    question: "今天有什么重要事情？",
    answer: "有一件重要事情。[E1]",
    citedSegmentIds: ["segment_1"],
    citations: [{
      id: "E1",
      title: "证据",
      startSeconds: 1,
      endSeconds: 2,
      excerpt: "逐字证据",
      sourceSegmentIds: ["segment_1"]
    }],
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides
  };
}

function retainedVoiceContext(contextId = "upload_1") {
  return {
    contextId,
    segments: [{
      id: "segment_1",
      uploadId: contextId,
      startSeconds: 1,
      endSeconds: 2,
      speaker: "speaker_0",
      text: "Retained browser evidence.",
      confidence: 0.9,
      sceneLabels: [] as [],
      valueLabels: [] as []
    }],
    audioInsights: [],
    semanticSegments: [],
    briefItems: [],
    relationshipSignals: []
  };
}

describe("parseVoiceQaTranscriptUpdates", () => {
  it("classifies partial, final, and unknown ASR results conservatively", () => {
    const updates = parseVoiceQaTranscriptUpdates(parsedEvent({
      sessionId: "session_1",
      payload: {
        results: [
          { text: " 我今天... ", is_interim: true },
          { text: "我今天发生了什么？", is_interim: false },
          { text: "缺少 finality" },
          { text: "invalid finality", is_interim: "false" },
          { text: "   ", is_interim: false },
          null
        ]
      }
    }), "session_1");

    expect(updates).toEqual([
      { transcript: "我今天...", finality: "partial", sessionId: "session_1" },
      { transcript: "我今天发生了什么？", finality: "final", sessionId: "session_1" },
      { transcript: "缺少 finality", finality: "unknown", sessionId: "session_1" },
      { transcript: "invalid finality", finality: "unknown", sessionId: "session_1" }
    ]);
  });

  it("ignores chat, malformed, and other-session events", () => {
    expect(parseVoiceQaTranscriptUpdates(parsedEvent({
      eventId: VoiceEvent.ChatResponse,
      sessionId: "session_1",
      payload: { results: [{ text: "not ASR", is_interim: false }] }
    }), "session_1")).toEqual([]);
    expect(parseVoiceQaTranscriptUpdates(parsedEvent({
      sessionId: "session_2",
      payload: { results: [{ text: "wrong session", is_interim: false }] }
    }), "session_1")).toEqual([]);
    expect(parseVoiceQaTranscriptUpdates(parsedEvent({
      sessionId: "session_1",
      payload: { results: "not-an-array" }
    }), "session_1")).toEqual([]);
  });
});

describe("Voice QA normalization and response projection", () => {
  it("normalizes only surrounding and repeated whitespace", () => {
    expect(normalizeVoiceQaQuery("  今天\n有什么   重要事情？  ")).toBe("今天 有什么 重要事情？");
    expect(normalizeVoiceQaQuery(" \n\t ")).toBeNull();
    expect(normalizeVoiceQaQuery(42)).toBeNull();
  });

  it("keeps TEXT unchanged and derives VOICE text without citations or list formatting", () => {
    const original = questionAnswer({
      answer: "# 今天\n- 第一件事 [E1][E2]\n2. 第二件事\n- [x] 已完成"
    });
    const originalSnapshot = structuredClone(original);

    expect(projectVoiceQaAnswer(original, "TEXT")).toBe(original.answer);
    const projected = projectVoiceQaAnswer(original, "VOICE");

    expect(projected).toBe("今天 第一件事 第二件事 已完成");
    expect(original).toEqual(originalSnapshot);
  });
});

describe("createMemoryVoiceQaAnswerer", () => {
  it("uses current-upload evidence with speaker aliases and persists the answer", async () => {
    const store = await temporaryStore();
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      status: "ready",
      recordingDate: "2026-07-20"
    });
    await store.write("audio-insights", "upload_1", [{
      id: "insight_1",
      uploadId: "upload_1",
      speaker: { id: "speaker_0", role: "unknown", confidence: 0.9 },
      summary: "speaker_0 记住了安排",
      evidence: "speaker_0 做了确认"
    }]);
    await store.write("audio-insight-corrections", "upload_1", {
      corrections: {
        insight_1: {
          labelCorrections: [{ from: "unknown", to: "warm" }],
          note: "User-confirmed correction",
          updatedAt: "2026-07-20T00:00:00.000Z"
        }
      },
      updatedAt: "2026-07-20T00:00:00.000Z"
    });
    await store.write("speaker-aliases", "upload_1", {
      aliases: { speaker_0: "小林" },
      updatedAt: "2026-07-20T00:00:00.000Z"
    });
    const expected = questionAnswer();
    const currentQa = vi.fn<typeof answerQuestionWithAI>().mockResolvedValue(expected);
    const answerer = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "current",
      uploadId: "upload_1",
      dependencies: { answerQuestionWithAI: currentQa }
    });

    await expect(answerer.answer({
      sessionId: "session_1",
      transcript: "  今天\n有什么重要事情？ ",
      userId: "user_1",
      scope: "current",
      mode: "VOICE"
    })).resolves.toEqual(expected);

    expect(currentQa).toHaveBeenCalledOnce();
    expect(answerer.answerMode).toBe("agent");
    const qaInput = currentQa.mock.calls[0][0];
    expect(qaInput.userId).toBe("user_1");
    expect(qaInput.answerMode).toBe("agent");
    expect(qaInput.question).toBe("今天 有什么重要事情？");
    expect(qaInput.settingsStore).toBe(store);
    expect(qaInput.qaPromptInstruction).toContain("一到三句");
    expect(qaInput.qaPromptInstruction).toContain("[E#]");
    expect(qaInput.audioInsights?.[0]).toMatchObject({
      speaker: { id: "speaker_0", displayName: "小林" },
      summary: "小林 记住了安排",
      evidence: "小林 做了确认"
    });
    expect(qaInput.audioInsights?.[0]?.userCorrections).toBeUndefined();
    expect(qaInput.hybridEvidenceInput?.audioInsights?.[0]).toMatchObject({
      speaker: { id: "speaker_0", displayName: "小林" },
      summary: "小林 记住了安排",
      evidence: "小林 做了确认",
      userCorrections: [{
        labelCorrections: [{ from: "unknown", to: "warm" }],
        note: "User-confirmed correction"
      }]
    });
    expect(qaInput.hybridEvidenceInput?.segments).toEqual(qaInput.segments);
    expect(qaInput.hybridEvidenceInput?.semanticSegments).toEqual(qaInput.semanticSegments);
    expect(qaInput.hybridEvidenceInput?.briefItems).toEqual(qaInput.briefItems);
    expect(qaInput.hybridEvidenceInput?.relationshipSignals).toEqual([]);
    await expect(store.read("answers", expected.id)).resolves.toEqual(expected);
    await expect(store.read("answers-by-upload", "upload_1")).resolves.toEqual([expected]);
  });

  it("answers from retained browser context after the temporary server upload was cleaned", async () => {
    const store = await temporaryStore();
    const expected = questionAnswer();
    const currentQa = vi.fn<typeof answerQuestionWithAI>().mockResolvedValue(expected);
    const context = retainedVoiceContext();
    const answerer = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "current",
      uploadId: "upload_1",
      context,
      dependencies: { answerQuestionWithAI: currentQa }
    });

    await expect(answerer.answer({
      sessionId: "session_1",
      transcript: "Summarize today.",
      userId: "user_1",
      scope: "current",
      uploadId: "upload_1",
      mode: "VOICE"
    })).resolves.toEqual(expected);

    expect(currentQa).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      uploadId: "upload_1",
      scope: "current",
      segments: context.segments,
      qaPromptInstruction: expect.stringContaining("[E#]")
    }));
    await expect(store.read("uploads", "upload_1")).resolves.toBeNull();
    await expect(store.read("answers", expected.id)).resolves.toBeNull();
  });

  it("uses the direct strategy only when configured and never mutates Memory", async () => {
    const store = await temporaryStore();
    const expected = questionAnswer();
    const currentQa = vi.fn<typeof answerQuestionWithAI>().mockResolvedValue(expected);
    const context = retainedVoiceContext();
    const existingMemory = [{ id: "memory_1", type: "preference", title: "existing" }];
    await store.write("memory-items", "snapshot", existingMemory);
    const answerer = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "current",
      uploadId: "upload_1",
      context,
      answerMode: "direct",
      dependencies: { answerQuestionWithAI: currentQa }
    });

    await expect(answerer.answer({
      sessionId: "session_direct",
      transcript: "Summarize today.",
      userId: "user_1",
      scope: "current",
      uploadId: "upload_1",
      mode: "VOICE"
    })).resolves.toEqual(expected);

    expect(answerer.answerMode).toBe("direct");
    expect(currentQa).toHaveBeenCalledWith(expect.objectContaining({
      answerMode: "direct",
      segments: context.segments
    }));
    await expect(store.read("memory-items", "snapshot")).resolves.toEqual(existingMemory);
    await expect(store.read("answers", expected.id)).resolves.toBeNull();
  });

  it("forwards an independently grounded sentence before the final answer", async () => {
    const store = await temporaryStore();
    const expected = questionAnswer();
    let releaseFinal!: () => void;
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const streamed = vi.fn(async function* () {
      yield {
        type: "sentence_completed" as const,
        sequence: 1,
        sentence: "有一件重要事情。",
        text: "有一件重要事情。",
        citationIds: ["E1"],
        supportIds: ["segment_1"],
        citedSegmentIds: ["segment_1"],
        groundingValidated: true as const,
        safeForSpeech: false as const,
        safeForPersistence: false as const,
        requiresResponseOptimization: true as const,
        validated: true as const,
        status: "committed" as const,
        reason: "grounded" as const
      };
      await finalGate;
      yield {
        type: "final" as const,
        answer: expected,
        source: "provider_stream" as const,
        trace: {
          version: 1 as const,
          streamId: "11111111-1111-4111-8111-111111111111",
          status: "completed" as const,
          timestamps: {
            stream_started: "2026-07-20T00:00:00.000Z",
            provider_request_started: "2026-07-20T00:00:00.000Z",
            first_token_received: "2026-07-20T00:00:00.010Z",
            first_sentence_completed: "2026-07-20T00:00:00.020Z",
            provider_stream_ended: "2026-07-20T00:00:00.020Z",
            stream_completed: "2026-07-20T00:00:00.020Z"
          },
          latencies: {
            firstTokenMs: 10,
            firstSentenceMs: 20,
            totalStreamMs: 20,
            totalOperationMs: 20
          },
          tokenChunkCount: 1,
          sentenceCount: 1,
          providerCallCount: 1,
          fallbackReason: null
        }
      };
    }) as unknown as typeof answerQuestionStream;
    const observer = vi.fn();
    const answerer = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "current",
      uploadId: "upload_1",
      context: retainedVoiceContext(),
      dependencies: { answerQuestionStream: streamed }
    });

    const answerPromise = answerer.answer({
      sessionId: "session_stream",
      transcript: "今天有什么重要事情？",
      userId: "user_1",
      scope: "current",
      uploadId: "upload_1",
      mode: "VOICE",
      onQaStreamEvent: observer
    });

    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
    expect(observer.mock.calls[0]?.[0]).toMatchObject({ type: "sentence_completed" });
    releaseFinal();
    await expect(answerPromise).resolves.toEqual(expected);
    expect(streamed).toHaveBeenCalledOnce();
    expect(observer.mock.calls.map(([event]) => event.type)).toEqual([
      "sentence_completed",
      "final"
    ]);
  });

  it("delegates week and all scopes to existing memory QA", async () => {
    const store = await temporaryStore();
    const weekAnswer = questionAnswer({ id: "week_answer", uploadId: "week_scope" });
    const allAnswer = questionAnswer({ id: "all_answer", uploadId: "all_memory" });
    const memoryQa = vi.fn<typeof answerMemoryScopeQuestion>()
      .mockResolvedValueOnce(weekAnswer)
      .mockResolvedValueOnce(allAnswer);
    const week = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "week",
      referenceDate: new Date(2026, 6, 20),
      dependencies: { answerMemoryScopeQuestion: memoryQa }
    });
    const all = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "all",
      dependencies: { answerMemoryScopeQuestion: memoryQa }
    });

    await expect(week.answer({
      sessionId: "session_1",
      transcript: "本周有什么安排？",
      userId: "user_1",
      scope: "week"
    })).resolves.toEqual(weekAnswer);
    await expect(all.answer({
      sessionId: "session_2",
      transcript: "我一直在关注什么？",
      userId: "user_1",
      scope: "all"
    })).resolves.toEqual(allAnswer);

    expect(memoryQa.mock.calls[0][0]).toMatchObject({
      qaScope: "week",
      userId: "user_1",
      store
    });
    expect(memoryQa.mock.calls[0][0].scopeId).toMatch(/^week_/u);
    expect(memoryQa.mock.calls[0][0].includeUpload).toEqual(expect.any(Function));
    expect(memoryQa.mock.calls[1][0]).toMatchObject({
      scopeId: "all_memory",
      qaScope: "all",
      userId: "user_1",
      store
    });
  });

  it("forwards retrieved Memory IDs through the internal session observer", async () => {
    const store = await temporaryStore();
    const expected = questionAnswer({ id: "all_answer", uploadId: "all_memory" });
    const memoryQa = vi.fn<typeof answerMemoryScopeQuestion>(async (input) => {
      input.onRetrievedMemoryIds?.(["memory_manager_topic", "memory_follow_up"]);
      return expected;
    });
    const observer = vi.fn();
    const answerer = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "all",
      dependencies: { answerMemoryScopeQuestion: memoryQa }
    });

    await answerer.answer({
      sessionId: "conversation_session",
      transcript: "明天还要再谈一次",
      userId: "user_1",
      scope: "all",
      onRetrievedMemoryIds: observer
    });

    expect(observer).toHaveBeenCalledWith(["memory_manager_topic", "memory_follow_up"]);
  });

  it("rejects untrusted user, scope, upload, and non-ready upload changes", async () => {
    const store = await temporaryStore();
    await store.write("uploads", "upload_1", { id: "upload_1", status: "processing" });
    const answerer = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "current",
      uploadId: "upload_1"
    });

    await expect(answerer.answer({
      sessionId: "session_1",
      transcript: "问题",
      userId: "other_user"
    })).rejects.toMatchObject({ code: "user_mismatch" } satisfies Partial<VoiceQaAdapterError>);
    await expect(answerer.answer({
      sessionId: "session_1",
      transcript: "问题",
      scope: "all"
    })).rejects.toMatchObject({ code: "scope_mismatch" } satisfies Partial<VoiceQaAdapterError>);
    await expect(answerer.answer({
      sessionId: "session_1",
      transcript: "问题",
      uploadId: "upload_2"
    })).rejects.toMatchObject({ code: "upload_mismatch" } satisfies Partial<VoiceQaAdapterError>);
    await expect(answerer.answer({
      sessionId: "session_1",
      transcript: "问题"
    })).rejects.toMatchObject({ code: "upload_not_ready" } satisfies Partial<VoiceQaAdapterError>);
  });

  it("rejects current-upload voice qa after upload deletion starts", async () => {
    const store = await temporaryStore();
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      status: "ready",
      recordingDate: "2026-07-20"
    });
    await store.write("deleted-uploads", "upload_1", {
      uploadId: "upload_1",
      deletedAt: "2026-07-20T00:00:00.000Z"
    });
    const currentQa = vi.fn<typeof answerQuestionWithAI>();
    const answerer = createMemoryVoiceQaAnswerer({
      userId: "user_1",
      store,
      scope: "current",
      uploadId: "upload_1",
      dependencies: { answerQuestionWithAI: currentQa }
    });

    await expect(answerer.answer({
      sessionId: "session_1",
      transcript: "Question",
      userId: "user_1",
      scope: "current",
      uploadId: "upload_1",
      mode: "VOICE"
    })).rejects.toMatchObject({
      code: "upload_deletion_in_progress"
    } satisfies Partial<VoiceQaAdapterError>);
    expect(currentQa).not.toHaveBeenCalled();
    await expect(store.read("answers-by-upload", "upload_1")).resolves.toBeNull();
  });
});
