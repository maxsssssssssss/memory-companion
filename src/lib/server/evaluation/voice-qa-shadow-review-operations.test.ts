// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareQaSelectedEvidenceForEvaluation,
  retrieveQaEvidenceWithDiagnostics,
  type QaSelectedEvidenceEvaluationInput
} from "@/lib/server/retrieval/ai-qa";

import {
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "@/lib/server/retrieval/hybrid/runtime-config";
import {
  attachVoiceQaShadowQuestionInputs,
  assessVoiceQaShadowBlindGeneration,
  buildVoiceQaShadowGoldTemplate,
  generateVoiceQaShadowBlindReview,
  importVoiceQaShadowBlindReview,
  importVoiceQaShadowFaultRuns,
  importVoiceQaShadowGold,
  replayVoiceQaShadowReviewCases,
  VOICE_QA_SHADOW_NO_PROVIDER_MODEL,
  voiceQaShadowReviewStatus
} from "./voice-qa-shadow-review-operations";
import {
  VoiceQaShadowReviewRepository
} from "./voice-qa-shadow-review-repository";
import type {
  VoiceQaShadowReviewRetrievalSnapshot
} from "./voice-qa-shadow-review";
import {
  VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION
} from "./voice-qa-shadow-review";

const HASH = "a".repeat(64);
const AUDIO_HASH = "b".repeat(64);
const USER_ID = "review_user";

function primaryRun(system: "A" | "B") {
  return {
    system,
    status: "completed" as const,
    flatSnapshotId: null,
    totalLatencyMs: 10,
    candidateValidity: true,
    inputHash: HASH,
    candidates: [{
      evidenceId: "canonical_evidence_1",
      rank: 1,
      selectedRank: 1
    }]
  };
}

function seedCase(repository: VoiceQaShadowReviewRepository) {
  repository.upsertCaseBundle({
    canonicalSnapshot: {
      snapshotId: "canonical_1",
      universeHash: "c".repeat(64),
      contentHash: "d".repeat(64),
      evidence: [{
        evidenceId: "canonical_evidence_1",
        ordinal: 0,
        content: "private canonical evidence",
        metadata: {
          kind: "raw",
          title: "private",
          startSeconds: 1,
          endSeconds: 2,
          sourceSegmentIds: ["segment_1"],
          priority: 0
        }
      }]
    },
    case: {
      caseId: "case_1",
      scope: "current",
      voiceSessionId: "voice_1",
      traceId: "trace_1",
      asrText: "private question",
      asrLatencyMs: 100,
      conversationContext: [],
      canonicalSnapshotId: "canonical_1",
      flatSnapshotId: null,
      modelFingerprint: "model_fp",
      promptFingerprint: "prompt_fp",
      codeFingerprint: "code_fp",
      status: "pending"
    },
    replayInput: {
      version: "voice_qa_shadow_replay_input_v1",
      input: {
        uploadId: "upload_1",
        question: "private question",
        conversation: [],
        scope: "current",
        segments: [],
        semanticSegments: [],
        briefItems: []
      }
    },
    queryVector: {
      vector: new Float32Array(QWEN3_EMBEDDING_4B_DIMENSION).fill(0.01),
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelRevision: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    },
    retrievalRuns: [
      primaryRun("A"),
      primaryRun("B")
    ]
  });
}

function seedBlindGenerationCase(
  repository: VoiceQaShadowReviewRepository
) {
  const qaInput = {
    uploadId: "upload_blind",
    question: "What was decided?",
    conversation: [],
    scope: "current" as const,
    segments: [{
      id: "segment_blind",
      uploadId: "upload_blind",
      startSeconds: 1,
      endSeconds: 2,
      text: "The team decided to launch on Friday.",
      confidence: 0.99,
      sceneLabels: ["unknown" as const],
      valueLabels: ["decision" as const]
    }],
    semanticSegments: [],
    briefItems: []
  };
  const evidence = retrieveQaEvidenceWithDiagnostics(qaInput).evidence;
  const systemPrompt = "Frozen GPT-5.5 system prompt";
  const userPromptPrefix = "Frozen question and context";
  const prompt = prepareQaSelectedEvidenceForEvaluation({
    qaInput,
    selectedEvidence: evidence,
    systemPrompt,
    userPromptPrefix
  });
  const retrievalRuns = [0, 1].flatMap((replayIndex) =>
    (["A", "B"] as const).map((system) => ({
      system,
      replayIndex,
      status: "completed" as const,
      flatSnapshotId: system === "A" ? null : "flat_snapshot_frozen",
      totalLatencyMs: 10,
      candidateValidity: true,
      inputHash: HASH,
      candidates: evidence.map((item, index) => ({
        evidenceId: item.id,
        rank: index + 1,
        selectedRank: index + 1
      }))
    }))
  );
  repository.upsertCaseBundle({
    canonicalSnapshot: {
      snapshotId: "canonical_blind",
      universeHash: "e".repeat(64),
      contentHash: "f".repeat(64),
      evidence: evidence.map((item, ordinal) => ({
        evidenceId: item.id,
        ordinal,
        content: item.text,
        metadata: {
          kind: item.kind,
          title: item.title,
          startSeconds: item.startSeconds,
          endSeconds: item.endSeconds,
          sourceSegmentIds: item.sourceSegmentIds,
          priority: item.priority,
          relationshipSignal: item.relationshipSignal ?? null
        }
      }))
    },
    case: {
      caseId: "case_blind",
      scope: "current",
      voiceSessionId: "voice_blind",
      traceId: "trace_blind",
      asrText: qaInput.question,
      asrLatencyMs: 100,
      conversationContext: [],
      canonicalSnapshotId: "canonical_blind",
      flatSnapshotId: "flat_snapshot_frozen",
      modelFingerprint: "algorithm_frozen",
      promptFingerprint: prompt.fullPromptFingerprint,
      codeFingerprint: "code_frozen",
      modelMetadata: {
        canonicalEvidenceVersion:
          VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION,
        officialQa: {
          provider: "openai-compatible",
          model: "gpt-5.5",
          providerId: "gpt-5.5",
          wireApi: "chat",
          reasoningEnabled: null,
          endpointFingerprint: HASH
        }
      },
      status: "valid"
    },
    replayInput: {
      version: "voice_qa_shadow_replay_input_v1",
      input: qaInput
    },
    retrievalRuns,
    officialAnswer: {
      answerText: "The team decided to launch on Friday. [E1]",
      citations: {
        citedSegmentIds: ["segment_blind"],
        citations: [],
        citationValidity: true,
        provider: "openai-compatible",
        attemptKind: "final_projection"
      },
      model: "openai-compatible:gpt-5.5",
      promptFingerprint: prompt.fullPromptFingerprint,
      codeFingerprint: "code_frozen",
      streamingComplete: true
    },
    blindPromptSnapshot: {
      status: "provider_prompt",
      attemptKind: "final_projection",
      systemPrompt,
      userPromptPrefix,
      evidenceSectionHash: prompt.evidenceSectionHash,
      answerMode: "agent",
      memoryCount: prompt.memoryCount,
      evidenceCount: prompt.memoryEvidenceCount,
      lifecycleMetadata: {
        lexicalEvidenceIds: prompt.lexicalEvidenceIds
      }
    }
  });
  return { qaInput, evidence, prompt };
}

function seedNoProviderBlindGenerationCase(
  repository: VoiceQaShadowReviewRepository
) {
  const qaInput = {
    uploadId: "upload_no_provider",
    question: "What cannot be established?",
    conversation: [],
    scope: "current" as const,
    segments: [],
    semanticSegments: [],
    briefItems: []
  };
  const retrievalRuns = [0, 1].flatMap((replayIndex) =>
    (["A", "B"] as const).map((system) => ({
      system,
      replayIndex,
      status: "completed" as const,
      flatSnapshotId: system === "A" ? null : "flat_snapshot_frozen",
      totalLatencyMs: 10,
      candidateValidity: true,
      inputHash: HASH,
      candidates: []
    }))
  );
  repository.upsertCaseBundle({
    canonicalSnapshot: {
      snapshotId: "canonical_no_provider",
      universeHash: "1".repeat(64),
      contentHash: "2".repeat(64),
      evidence: []
    },
    case: {
      caseId: "case_no_provider",
      scope: "current",
      voiceSessionId: "voice_no_provider",
      traceId: "trace_no_provider",
      asrText: qaInput.question,
      asrLatencyMs: 100,
      conversationContext: [],
      canonicalSnapshotId: "canonical_no_provider",
      flatSnapshotId: "flat_snapshot_frozen",
      modelFingerprint: "algorithm_frozen",
      promptFingerprint: HASH,
      codeFingerprint: "code_frozen",
      modelMetadata: {
        canonicalEvidenceVersion:
          VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION
      },
      status: "valid"
    },
    replayInput: {
      version: "voice_qa_shadow_replay_input_v1",
      input: qaInput
    },
    retrievalRuns,
    officialAnswer: {
      answerText: "没有找到足够证据确认这个信息。",
      citations: {
        citedSegmentIds: [],
        citations: [],
        citationValidity: true,
        provider: "none",
        attemptKind: "final_projection"
      },
      model: "none",
      promptFingerprint: HASH,
      codeFingerprint: "code_frozen",
      fallbackReason: "insufficient_evidence",
      streamingComplete: true
    },
    blindPromptSnapshot: {
      status: "no_provider_prompt",
      attemptKind: "final_projection",
      answerMode: "agent",
      memoryCount: 0,
      evidenceCount: 0,
      lifecycleMetadata: {
        lexicalEvidenceIds: []
      }
    }
  });
}

describe("Voice QA shadow review operational helpers", () => {
  let rootDir: string;
  let repository: VoiceQaShadowReviewRepository;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "voice-shadow-ops-"));
    repository = new VoiceQaShadowReviewRepository({
      userId: USER_ID,
      dataRoot: rootDir
    });
    seedCase(repository);
  });

  afterEach(async () => {
    repository.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("attaches private question provenance by trace and changes only evaluation status", () => {
    const result = attachVoiceQaShadowQuestionInputs(repository, {
      version: 1,
      cases: [{
        traceId: "trace_1",
        expectedText: "private expected question",
        audioSha256: AUDIO_HASH,
        audioDurationMs: 2_500,
        sourceKind: "recorded_holdout",
        status: "valid"
      }]
    });

    expect(result).toMatchObject({
      attachedCount: 1,
      caseIds: ["case_1"]
    });
    expect(repository.getCase("case_1")?.status).toBe("valid");
    expect(repository.getQuestionInput("case_1")).toMatchObject({
      audioSha256: AUDIO_HASH,
      sourceKind: "recorded_holdout"
    });
  });

  it("imports only canonical Gold and validates blind/fault private imports", () => {
    attachVoiceQaShadowQuestionInputs(repository, {
      version: 1,
      cases: [{
        caseId: "case_1",
        expectedText: "private expected question",
        audioSha256: AUDIO_HASH,
        audioDurationMs: 2_500,
        sourceKind: "recorded_holdout",
        status: "valid"
      }]
    });
    expect(() => importVoiceQaShadowGold(repository, {
      version: 1,
      cases: [{
        caseId: "case_1",
        status: "evaluable",
        evidenceGroups: [["not_canonical"]],
        requiredFacts: ["private fact"],
        shouldRefuse: false
      }]
    })).toThrow("non-canonical");
    expect(importVoiceQaShadowGold(repository, {
      version: 1,
      cases: [{
        caseId: "case_1",
        status: "evaluable",
        evidenceGroups: [["canonical_evidence_1"]],
        requiredFacts: ["private fact"],
        shouldRefuse: false,
        categories: ["fact"]
      }]
    })).toMatchObject({ importedCount: 1 });

    const mapping = {
      1: { A: "X", B: "Y" },
      2: { A: "Y", B: "X" }
    } as const;
    const answers = ([1, 2] as const).flatMap((round) =>
      (["A", "B"] as const).map((system) => ({
        caseId: "case_1",
        round,
        label: mapping[round][system],
        system,
        answerText: `private answer ${round} ${system}`,
        citations: [],
        citationValidity: true,
        model: "gpt-5.5",
        promptTemplateFingerprint: "prompt_template_fp",
        codeFingerprint: "code_fp",
        inputHash: HASH,
        evidenceIds: ["canonical_evidence_1"]
      }))
    );
    expect(importVoiceQaShadowBlindReview(repository, {
      version: 1,
      answers,
      reviews: [{
        caseId: "case_1",
        round: 1,
        label: "X",
        scores: {
          factualCorrectness: 4,
          completeness: 3,
          citationSupport: 4,
          uncertainty: 4,
          directness: 3
        },
        hardViolations: [],
        outcome: "tie"
      }]
    })).toMatchObject({ answerCount: 4, reviewCount: 1 });
    expect(
      repository.listBlindAnswers("case_1").every(
        (answer) => answer.citationValidity === true
      )
    ).toBe(true);

    expect(importVoiceQaShadowFaultRuns(repository, {
      version: 1,
      runs: [{
        faultRunId: "fault_1",
        caseId: "case_1",
        scenario: "embedding_timeout",
        status: "completed",
        expectedOfficialAnswerHash: HASH,
        actualOfficialAnswerHash: HASH,
        expectedCitationHash: HASH,
        actualCitationHash: HASH,
        voiceUninterrupted: true,
        lexicalFailOpen: true,
        citationsValid: true
      }]
    })).toMatchObject({ importedCount: 1 });
  });

  it("replays index 1 with the stored vector and persists only verified A/B output", async () => {
    const bundle = repository.getCaseBundle("case_1")!;
    const vectorHash = bundle.queryVector!.vectorHash;
    const fakeRun = async (input: Parameters<
      typeof import("./voice-qa-shadow-review").runVoiceQaShadowReviewRetrieval
    >[0]) => {
      const vector = (await input.dependencies!.provider!.embed(["query"]))[0]!;
      expect(vector).toHaveLength(QWEN3_EMBEDDING_4B_DIMENSION);
      const system = (code: "A" | "B") => ({
        system: code,
        inputHash: HASH,
        top30: [{
          evidenceId: "canonical_evidence_1",
          rank: 1,
          selectedTop16: true,
          score: 1,
          reasons: ["deterministic"],
          details: {}
        }],
        top16EvidenceIds: ["canonical_evidence_1"],
        orderHash: repository.getRetrievalRun("case_1", code, 0)!.orderHash,
        canonicalCandidateValidity: true,
        retrievalMs: 10,
        denseMs: code === "A" ? null : 5,
        fallbackReason: null
      });
      return {
        version: "voice_qa_shadow_review_v1",
        caseId: "case_1",
        userId: USER_ID,
        scope: "current",
        voiceSessionId: "voice_1",
        traceId: "trace_1",
        asrText: "private question",
        asrHash: bundle.case.asrTextHash,
        conversation: [],
        conversationHash: HASH,
        replayInput: bundle.replayInput!.input as never,
        canonicalEvidence: [{
          id: "canonical_evidence_1",
          kind: "raw",
          title: "private",
          text: "private canonical evidence",
          startSeconds: 1,
          endSeconds: 2,
          sourceSegmentIds: ["segment_1"],
          priority: 0
        }],
        canonicalUniverseHash: bundle.canonicalSnapshot!.universeHash,
        canonicalContentHash: bundle.canonicalSnapshot!.contentHash,
        canonicalSnapshotId: bundle.canonicalSnapshot!.snapshotId,
        inputHash: HASH,
        flatSnapshotFingerprint: null,
        embedding: {
          modelName: QWEN3_EMBEDDING_4B_MODEL,
          modelVersion: QWEN3_EMBEDDING_4B_REVISION,
          dimension: QWEN3_EMBEDDING_4B_DIMENSION
        },
        fusion: "uniform_rrf",
        rankingVersion: "hybrid_optimized_ranking_phase3_1_v1",
        algorithmFingerprint: "algorithm_fp",
        codeFingerprint: "code_fp",
        queryVector: vector,
        queryVectorHash: vectorHash,
        rankingMetadata: [],
        memorySourceIds: [],
        systems: {
          A: system("A"),
          B: system("B")
        },
        backgroundRetrievalMs: 10
      } satisfies VoiceQaShadowReviewRetrievalSnapshot;
    };

    const result = await replayVoiceQaShadowReviewCases(repository, {
      userId: USER_ID,
      caseIds: ["case_1"],
      runRetrieval: fakeRun
    });

    expect(result).toMatchObject({
      totalCount: 1,
      completedCount: 1,
      failedCount: 0
    });
    expect(repository.listRetrievalRuns("case_1")).toHaveLength(4);
  });

  it("fails closed and lists missing replay fields without synthesizing runs", async () => {
    repository.close();
    repository = new VoiceQaShadowReviewRepository({
      userId: USER_ID,
      filePath: join(rootDir, "missing.sqlite")
    });
    repository.upsertCase({
      caseId: "case_missing",
      scope: "all",
      voiceSessionId: "voice_missing",
      traceId: "trace_missing",
      asrText: "private missing",
      conversationContext: [],
      modelFingerprint: "model_fp",
      promptFingerprint: "prompt_fp",
      codeFingerprint: "code_fp",
      status: "valid"
    });

    const result = await replayVoiceQaShadowReviewCases(repository, {
      userId: USER_ID,
      caseIds: ["case_missing"]
    });

    expect(result).toMatchObject({
      completedCount: 0,
      failedCount: 1
    });
    expect(result.failures[0]?.missing).toEqual(expect.arrayContaining([
      "replay_input_snapshot",
      "canonical_snapshot",
      "query_vector",
      "primary_run_A",
      "primary_run_B"
    ]));
    expect(repository.listRetrievalRuns("case_missing")).toEqual([]);
    expect(voiceQaShadowReviewStatus(repository).reviewStatus).toBe("NOT_READY");
  });

  it("generates A/B once and reuses identical answers across two blinded rounds", async () => {
    repository.close();
    repository = new VoiceQaShadowReviewRepository({
      userId: USER_ID,
      filePath: join(rootDir, "blind.sqlite")
    });
    const { evidence } = seedBlindGenerationCase(repository);
    const answer = vi.fn(async (
      input: QaSelectedEvidenceEvaluationInput
    ) => ({
      answer: {
        id: "blind-answer",
        uploadId: input.qaInput.uploadId,
        question: input.qaInput.question,
        answer: "The team decided to launch on Friday. [E1]",
        citedSegmentIds: ["segment_blind"],
        citations: [{
          id: "E1",
          title: evidence[0]!.title,
          startSeconds: evidence[0]!.startSeconds,
          endSeconds: evidence[0]!.endSeconds,
          excerpt: evidence[0]!.text,
          sourceSegmentIds: ["segment_blind"]
        }],
        createdAt: "2026-07-30T00:00:00.000Z"
      },
      fallbackReason: "none" as const,
      providerId: "gpt-5.5" as const,
      logProvider: "openai-compatible" as const,
      model: "gpt-5.5",
      wireApi: "chat" as const,
      reasoningEnabled: null,
      endpointFingerprint: HASH,
      generationLatencyMs: 10,
      evidenceSectionHash: HASH,
      fullPromptFingerprint: HASH,
      memoryCount: 0,
      memoryEvidenceCount: 0
    }));
    const createSession = vi.fn(async () => ({
      providerId: "gpt-5.5" as const,
      logProvider: "openai-compatible" as const,
      model: "gpt-5.5",
      wireApi: "chat" as const,
      reasoningEnabled: null,
      endpointFingerprint: HASH,
      answer
    }));
    const progress = vi.fn();

    const result = await generateVoiceQaShadowBlindReview(repository, {
      userId: USER_ID,
      caseIds: ["case_blind"],
      createSession,
      onProgress: progress
    });

    expect(result).toMatchObject({
      totalCount: 1,
      completedCount: 1,
      failedCount: 0,
      providerCallCount: 2,
      generatedSystemCount: 2,
      generationPerformed: true
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(answer).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith({
      completed: 1,
      total: 1,
      caseId: "case_blind",
      status: "completed"
    });
    const stored = repository.listBlindAnswers("case_blind");
    expect(stored).toHaveLength(4);
    for (const system of ["A", "B"] as const) {
      const systemAnswers = stored.filter(
        (candidate) => candidate.system === system
      );
      expect(systemAnswers).toHaveLength(2);
      expect(systemAnswers[0]!.label).not.toBe(systemAnswers[1]!.label);
      expect(systemAnswers[0]!.answerHash).toBe(
        systemAnswers[1]!.answerHash
      );
      expect(systemAnswers[0]!.citationsHash).toBe(
        systemAnswers[1]!.citationsHash
      );
    }
    expect(JSON.stringify(result.template)).not.toContain(
      '"system":"'
    );

    const replayed = await generateVoiceQaShadowBlindReview(repository, {
      userId: USER_ID,
      caseIds: ["case_blind"],
      createSession
    });
    expect(replayed.providerCallCount).toBe(0);
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it("uses deterministic uncertainty without a Provider for no-provider cases", async () => {
    repository.close();
    repository = new VoiceQaShadowReviewRepository({
      userId: USER_ID,
      filePath: join(rootDir, "blind-no-provider.sqlite")
    });
    seedNoProviderBlindGenerationCase(repository);
    const createSession = vi.fn();

    const result = await generateVoiceQaShadowBlindReview(repository, {
      userId: USER_ID,
      caseIds: ["case_no_provider"],
      createSession
    });

    expect(result).toMatchObject({
      totalCount: 1,
      completedCount: 1,
      failedCount: 0,
      providerCallCount: 0,
      generatedSystemCount: 2
    });
    expect(createSession).not.toHaveBeenCalled();
    const answers = repository.listBlindAnswers("case_no_provider");
    expect(answers).toHaveLength(4);
    expect(new Set(answers.map((answer) => answer.model))).toEqual(
      new Set([VOICE_QA_SHADOW_NO_PROVIDER_MODEL])
    );
    expect(new Set(answers.map((answer) => answer.answerHash))).toHaveLength(
      1
    );
    expect(answers.every((answer) => answer.citationValidity)).toBe(true);
  });

  it("builds a private Gold template without provenance and reports incomplete blind inputs", () => {
    attachVoiceQaShadowQuestionInputs(repository, {
      version: 1,
      cases: [{
        caseId: "case_1",
        expectedText: "private expected question",
        audioSha256: AUDIO_HASH,
        audioDurationMs: 2_500,
        sourceKind: "recorded_holdout",
        status: "valid"
      }]
    });
    const template = buildVoiceQaShadowGoldTemplate(repository);
    expect(template).toMatchObject({
      caseCount: 1,
      candidateSystemOriginsIncluded: false
    });
    expect(template.cases[0]?.canonicalSnapshot.evidence).toHaveLength(1);
    expect(template.cases[0]).not.toHaveProperty("retrievalRuns");
    expect(template.cases[0]).not.toHaveProperty("systems");
    expect(importVoiceQaShadowGold(repository, {
      ...template,
      cases: template.cases.map((item) => ({
        ...item,
        evidenceGroups: [["canonical_evidence_1"]],
        requiredFacts: ["private fact"]
      }))
    })).toMatchObject({ importedCount: 1 });

    expect(assessVoiceQaShadowBlindGeneration(repository)).toMatchObject({
      totalCount: 1,
      readyCount: 0,
      failedCount: 1,
      generationPerformed: false,
      failures: [{
        caseId: "case_1",
        missing: expect.arrayContaining([
          "official_answer",
          "blind_generation_prompt_snapshot"
        ])
      }]
    });
    expect(repository.listBlindAnswers("case_1")).toEqual([]);
  });
});
