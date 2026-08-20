// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QuestionAnswer, TranscriptSegment } from "@/lib/domain/types";
import {
  buildCanonicalQaEvidence,
  retrieveQaEvidenceWithDiagnostics,
  type AnswerQuestionWithAIInput
} from "@/lib/server/retrieval/ai-qa";
import { canonicalEvidenceEmbeddingText } from "@/lib/server/retrieval/hybrid/dense-retrieval";
import {
  embeddingContentHash,
  SqliteEmbeddingIndex
} from "@/lib/server/retrieval/hybrid/embedding-index";
import type { EmbeddingProvider } from "@/lib/server/retrieval/hybrid/embedding-provider";
import {
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "@/lib/server/retrieval/hybrid/runtime-config";
import {
  createVoiceSessionTraceModel,
  updateVoiceSessionTrace,
  type VoiceSessionTrace,
  type VoiceSessionTraceEvent
} from "@/lib/server/voice-qa/trace";

import {
  recordVoiceQaShadowReviewOfficialAnswer,
  recordVoiceQaShadowReviewVoiceOutcome,
  runVoiceQaShadowReviewRetrieval,
  voiceQaShadowReviewMetricsFromTrace
} from "./voice-qa-shadow-review";
import {
  VoiceQaShadowReviewRepository
} from "./voice-qa-shadow-review-repository";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

function vector(axis: number) {
  const value = Array.from(
    { length: QWEN3_EMBEDDING_4B_DIMENSION },
    () => 0
  );
  value[axis] = 1;
  return value;
}

function segment(index: number): TranscriptSegment {
  return {
    id: `segment-${index.toString().padStart(2, "0")}`,
    uploadId: "upload-review",
    speaker: "speaker_1",
    startSeconds: index * 10,
    endSeconds: index * 10 + 5,
    text:
      index === 29
        ? "最后决定周日下午去陶艺活动。"
        : `第${index}条普通生活记录，包含不同地点和计划。`,
    confidence: 1,
    sceneLabels: ["unknown"],
    valueLabels: []
  };
}

function qaInput(): AnswerQuestionWithAIInput {
  return {
    userId: "user_review",
    uploadId: "upload-review",
    question: "最后决定参加什么活动？",
    scope: "all",
    conversation: [{ role: "user", content: "我问的是最终决定。" }],
    segments: Array.from({ length: 30 }, (_, index) => segment(index)),
    audioInsights: [],
    semanticSegments: [],
    briefItems: [],
    shadowReviewContext: {
      voiceSessionId: "voice-session-1",
      traceId: "trace-1"
    }
  };
}

function terminalVoiceTrace() {
  const traceId = "11111111-1111-4111-8111-111111111111";
  let trace: VoiceSessionTrace = createVoiceSessionTraceModel({
    sessionId: traceId,
    applicationSessionId: "voice-session-1",
    scope: "all",
    now: () => new Date("2026-07-30T00:00:00.000Z")
  });
  const events: Array<[VoiceSessionTraceEvent, number]> = [
    ["speech_started", 10],
    ["speech_ended", 100],
    ["asr_final_received", 180],
    ["voice_question_received", 180],
    ["retrieval_complete", 220],
    ["llm_first_token", 280],
    ["first_safe_sentence", 350],
    ["tts_started", 360],
    ["tts_stream_started", 360],
    ["first_audio_chunk_received", 430],
    ["tts_stream_complete", 700],
    ["voice_response_complete", 720]
  ];
  for (const [event, milliseconds] of events) {
    trace = updateVoiceSessionTrace(trace, {
      event,
      now: () => new Date(
        Date.parse("2026-07-30T00:00:00.000Z") + milliseconds
      )
    });
  }
  return trace;
}

function seedReviewCase(input: {
  rootDir: string;
  userId: string;
  caseId: string;
  traceId: string;
}) {
  const repository = new VoiceQaShadowReviewRepository({
    userId: input.userId,
    dataRoot: input.rootDir
  });
  repository.upsertCase({
    caseId: input.caseId,
    scope: "all",
    voiceSessionId: "voice-session-1",
    traceId: input.traceId,
    asrText: "What changed?",
    conversationContext: [],
    modelFingerprint: "model-fingerprint",
    promptFingerprint: "pending",
    codeFingerprint: "code-fingerprint",
    modelMetadata: null
  });
  repository.close();
}

async function indexes(input: AnswerQuestionWithAIInput) {
  const directory = await mkdtemp(
    join(tmpdir(), "daily-brief-voice-shadow-review-")
  );
  temporaryDirectories.push(directory);
  const flatPath = join(directory, "flat.sqlite");
  const model = {
    modelName: QWEN3_EMBEDDING_4B_MODEL,
    modelVersion: QWEN3_EMBEDDING_4B_REVISION,
    dimension: QWEN3_EMBEDDING_4B_DIMENSION
  };
  const canonical = buildCanonicalQaEvidence(input);
  const flatWriter = new SqliteEmbeddingIndex(flatPath, model);
  canonical.forEach((evidence, index) => {
    flatWriter.upsert({
      objectType: "evidence",
      objectId: evidence.id,
      contentHash: embeddingContentHash(
        canonicalEvidenceEmbeddingText(evidence)
      ),
      vector: vector(index === canonical.length - 1 ? 0 : 1)
    });
  });
  flatWriter.close();
  return new SqliteEmbeddingIndex(flatPath, model, { readonly: true });
}

describe("Voice QA shadow review retrieval", () => {
  it("uses one query embedding for B while preserving the real lexical A", async () => {
    const input = qaInput();
    const flat = await indexes(input);
    const embed = vi.fn(async () => [vector(0)]);
    const provider: EmbeddingProvider = {
      config: {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: QWEN3_EMBEDDING_4B_REVISION,
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      },
      embed
    };
    const lexical = retrieveQaEvidenceWithDiagnostics(input);

    const result = await runVoiceQaShadowReviewRetrieval({
      caseId: "case-1",
      qaInput: input,
      lexical,
      dependencies: {
        provider,
        flatIndex: flat
      }
    });
    flat.close();

    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.systems.A.top16EvidenceIds).toEqual(
      lexical.evidence.map((item) => item.id)
    );
    expect(result.systems.A.top30).toHaveLength(30);
    expect(result.systems.B.top30).toHaveLength(30);
    expect(
      new Set(Object.values(result.systems).map((system) => system.inputHash))
    ).toEqual(new Set([result.inputHash]));
    expect(
      Object.values(result.systems).every(
        (system) => system.canonicalCandidateValidity
      )
    ).toBe(true);
    expect(result.flatSnapshotFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.queryVectorHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.systems.B.top16EvidenceIds).toEqual(
      result.systems.B.top30.slice(0, 16).map((item) => item.evidenceId)
    );
    const repository = new VoiceQaShadowReviewRepository({
      userId: "user_review",
      filePath: ":memory:"
    });
    repository.upsertCase({
      caseId: result.caseId,
      scope: result.scope,
      voiceSessionId: result.voiceSessionId,
      traceId: result.traceId,
      asrText: result.asrText,
      conversationContext: result.conversation ?? [],
      modelFingerprint: result.algorithmFingerprint,
      promptFingerprint: "pending",
      codeFingerprint: result.codeFingerprint
    });
    expect(() => repository.upsertRetrievalRun(result.caseId, {
      system: "A",
      status: "completed",
      flatSnapshotId: null,
      totalLatencyMs: result.systems.A.retrievalMs,
      candidateValidity: result.systems.A.canonicalCandidateValidity,
      inputHash: result.systems.A.inputHash,
      orderHash: result.systems.A.orderHash,
      candidates: result.systems.A.top30.map((candidate) => ({
        evidenceId: candidate.evidenceId,
        rank: candidate.rank,
        selectedRank: candidate.selectedTop16 ? candidate.rank : null,
        score: candidate.score,
        reason: candidate.details
      }))
    })).not.toThrow();
    repository.close();
  });

  it("uses one Flat sidecar fingerprint across different canonical universes", async () => {
    const fullInput = qaInput();
    const flat = await indexes(fullInput);
    const provider: EmbeddingProvider = {
      config: {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: QWEN3_EMBEDDING_4B_REVISION,
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      },
      embed: async () => [vector(0)]
    };
    const full = await runVoiceQaShadowReviewRetrieval({
      caseId: "flat-full",
      qaInput: fullInput,
      lexical: retrieveQaEvidenceWithDiagnostics(fullInput),
      dependencies: { provider, flatIndex: flat }
    });
    const scopedInput: AnswerQuestionWithAIInput = {
      ...fullInput,
      segments: fullInput.segments.slice(0, 10)
    };
    const scoped = await runVoiceQaShadowReviewRetrieval({
      caseId: "flat-scoped",
      qaInput: scopedInput,
      lexical: retrieveQaEvidenceWithDiagnostics(scopedInput),
      dependencies: { provider, flatIndex: flat }
    });
    flat.close();

    expect(scoped.canonicalUniverseHash).not.toBe(full.canonicalUniverseHash);
    expect(scoped.flatSnapshotFingerprint).toBe(full.flatSnapshotFingerprint);
  });

  it("derives Voice terminal metrics only from explicit trace milestones", () => {
    expect(voiceQaShadowReviewMetricsFromTrace(terminalVoiceTrace())).toEqual({
      asrLatencyMs: 80,
      llmFirstTokenLatencyMs: 60,
      firstPlayableSentenceLatencyMs: 250,
      firstAudioLatencyMs: 330,
      completeLatencyMs: 620,
      streamingComplete: true,
      ttsFailure: null
    });
  });

  it("keeps QA attempts deterministic and fills terminal Voice metrics later", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "daily-brief-shadow-terminal-")
    );
    temporaryDirectories.push(rootDir);
    vi.stubEnv("APP_DATA_DIR", rootDir);
    const userId = "user_terminal";
    const caseId = "case_terminal";
    const trace = terminalVoiceTrace();
    seedReviewCase({
      rootDir,
      userId,
      caseId,
      traceId: trace.sessionId
    });
    const streamAnswer: QuestionAnswer = {
      id: "answer_stream",
      uploadId: "all_memory",
      question: "What changed?",
      answer: "There is not enough evidence.",
      citedSegmentIds: [],
      citations: [],
      createdAt: "2026-07-30T00:00:01.000Z"
    };
    const syncAnswer: QuestionAnswer = {
      ...streamAnswer,
      id: "answer_sync",
      answer: "Sync fallback must not replace the stream final."
    };

    await recordVoiceQaShadowReviewOfficialAnswer({
      caseId,
      userId,
      answer: streamAnswer,
      attemptKind: "final_projection",
      provider: "openai-compatible",
      selectedModel: "gpt-5.5",
      fallbackReason: "insufficient_evidence",
      qaLatencyMs: 400
    });
    await recordVoiceQaShadowReviewOfficialAnswer({
      caseId,
      userId,
      answer: syncAnswer,
      attemptKind: "sync_fallback",
      provider: "openai-compatible",
      selectedModel: "gpt-5.5",
      fallbackReason: "provider_error",
      qaLatencyMs: 300
    });

    let repository = new VoiceQaShadowReviewRepository({
      userId,
      dataRoot: rootDir
    });
    expect(repository.getOfficialAnswer(caseId)).toMatchObject({
      answerText: streamAnswer.answer,
      llmFirstTokenLatencyMs: null,
      firstPlayableSentenceLatencyMs: null,
      firstAudioLatencyMs: null,
      completeLatencyMs: null,
      streamingComplete: null,
      ttsFailure: null
    });
    expect(repository.getBlindPromptSnapshot(caseId)).toMatchObject({
      status: "no_provider_prompt",
      attemptKind: "final_projection",
      answerMode: "agent",
      memoryCount: 0,
      evidenceCount: 0
    });
    expect(repository.listQaAttempts(caseId).map((attempt) => [
      attempt.attemptIndex,
      attempt.kind
    ])).toEqual([
      [1, "sync_fallback"],
      [2, "final_projection"]
    ]);
    repository.close();

    await recordVoiceQaShadowReviewVoiceOutcome({
      caseId,
      userId,
      traceId: trace.sessionId,
      metrics: voiceQaShadowReviewMetricsFromTrace(trace)
    });

    repository = new VoiceQaShadowReviewRepository({
      userId,
      dataRoot: rootDir
    });
    expect(repository.getCase(caseId)?.asrLatencyMs).toBe(80);
    expect(repository.getOfficialAnswer(caseId)).toMatchObject({
      answerText: streamAnswer.answer,
      llmFirstTokenLatencyMs: 60,
      firstPlayableSentenceLatencyMs: 250,
      firstAudioLatencyMs: 330,
      completeLatencyMs: 620,
      streamingComplete: true,
      ttsFailure: null
    });
    repository.close();
  });
});
