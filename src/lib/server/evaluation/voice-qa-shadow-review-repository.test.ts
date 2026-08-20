// @vitest-environment node

import Database from "better-sqlite3";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VoiceQaShadowReviewRepository,
  getVoiceQaShadowReviewDatabasePath,
  hashVoiceQaShadowReviewText,
  type VoiceQaShadowReviewCaseBundleInput
} from "./voice-qa-shadow-review-repository";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function caseBundle(): VoiceQaShadowReviewCaseBundleInput {
  const answerText = "今天确认把导师汇报提交了。";
  const citations = [{ evidenceId: "E1", quote: "我今天提交了导师汇报。" }];
  return {
    questionInput: {
      expectedText: "我今天完成了什么？",
      audioSha256: "d".repeat(64),
      audioDurationMs: 4_188,
      sourceKind: "recorded_holdout",
      metadata: { fixtureName: "question-001.wav" }
    },
    replayInput: {
      version: "voice_qa_shadow_replay_input_v1",
      input: {
        uploadId: "upload_1",
        question: "鎴戜粖澶╁畬鎴愪簡浠€涔堬紵",
        scope: "current",
        segments: [],
        semanticSegments: [],
        briefItems: []
      }
    },
    canonicalSnapshot: {
      snapshotId: "canonical_snapshot_1",
      universeHash: HASH_A,
      contentHash: HASH_B,
      evidence: [
        {
          evidenceId: "E1",
          ordinal: 0,
          content: "我今天提交了导师汇报。",
          metadata: { uploadId: "upload_1", startSeconds: 15 }
        },
        {
          evidenceId: "E2",
          ordinal: 1,
          content: "Alice 说检查清单已经交付。",
          metadata: { uploadId: "upload_1", startSeconds: 30 }
        }
      ]
    },
    case: {
      caseId: "case_1",
      scope: "current",
      voiceSessionId: "voice_session_1",
      traceId: "trace_1",
      asrText: "我今天完成了什么？",
      asrLatencyMs: 321,
      conversationContext: {
        messages: [{ role: "user", text: "接着刚才的问题" }]
      },
      canonicalSnapshotId: "canonical_snapshot_1",
      flatSnapshotId: "flat_snapshot_1",
      modelFingerprint: "gpt-5.5:model-fingerprint",
      promptFingerprint: "prompt-fingerprint",
      codeFingerprint: "code-fingerprint",
      modelMetadata: {
        embeddingModel: "Qwen/Qwen3-Embedding-4B",
        revision: "5cf2132",
        dimension: 2560,
        fusion: "uniform_rrf",
        ranking: "phase31"
      },
      status: "valid"
    },
    queryVector: {
      vector: new Float32Array([0.125, -0.25, 0.5, 1]),
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelRevision: "5cf2132",
      dimension: 4
    },
    retrievalRuns: [
      {
        system: "A",
        status: "completed",
        flatSnapshotId: null,
        totalLatencyMs: 12,
        candidateValidity: true,
        inputHash: HASH_C,
        rankingMetadata: { retriever: "lexical_top16" },
        candidates: [
          {
            evidenceId: "E1",
            rank: 1,
            selectedRank: 1,
            reason: { lexical: true }
          },
          {
            evidenceId: "E2",
            rank: 2,
            selectedRank: 2,
            reason: { lexical: true }
          }
        ]
      },
      {
        system: "B",
        status: "completed",
        flatSnapshotId: "flat_snapshot_1",
        denseLatencyMs: 28,
        totalLatencyMs: 40,
        candidateValidity: true,
        inputHash: HASH_C,
        rankingMetadata: { fusion: "uniform_rrf", ranking: "phase31" },
        memorySourceIds: ["memory_1"],
        candidates: [
          {
            evidenceId: "E2",
            rank: 1,
            selectedRank: 1,
            score: 0.8,
            reason: { denseRank: 1 }
          },
          {
            evidenceId: "E1",
            rank: 2,
            selectedRank: 2,
            score: 0.7,
            reason: { lexicalRank: 1 }
          }
        ]
      }
    ],
    qaAttempts: [
      {
        attemptIndex: 0,
        kind: "stream_primary",
        status: "failed",
        fallbackReason: "provider_stream_error",
        provider: "openai-compatible",
        model: "gpt-5.5",
        promptFingerprint: "prompt-fingerprint",
        codeFingerprint: "code-fingerprint",
        latencyMs: 250
      },
      {
        attemptIndex: 1,
        kind: "sync_fallback",
        status: "completed",
        provider: "openai-compatible",
        model: "gpt-5.5",
        promptFingerprint: "prompt-fingerprint",
        codeFingerprint: "code-fingerprint",
        answerText,
        citations,
        latencyMs: 600
      },
      {
        attemptIndex: 2,
        kind: "final_projection",
        status: "completed",
        provider: "local-projection",
        model: "gpt-5.5",
        promptFingerprint: "prompt-fingerprint",
        codeFingerprint: "code-fingerprint",
        answerText,
        citations,
        latencyMs: 40
      }
    ],
    officialAnswer: {
      answerText,
      citations,
      model: "gpt-5.5",
      promptFingerprint: "prompt-fingerprint",
      codeFingerprint: "code-fingerprint",
      llmFirstTokenLatencyMs: 180,
      firstPlayableSentenceLatencyMs: 350,
      completeLatencyMs: 860,
      streamingComplete: true
    },
    blindPromptSnapshot: {
      status: "provider_prompt",
      attemptKind: "final_projection",
      systemPrompt: "system prompt",
      userPromptPrefix: "question and context",
      evidenceSectionHash: HASH_A,
      answerMode: "agent",
      memoryCount: 2,
      evidenceCount: 2,
      lifecycleMetadata: {
        queryIntent: { lifecycle: true },
        replayInputHash: HASH_B
      }
    },
    gold: {
      status: "evaluable",
      evidenceGroups: [["E1"]],
      requiredFacts: ["导师汇报已经提交"],
      shouldRefuse: false,
      categories: ["lifecycle", "project", "lifecycle"],
      reviewerId: "reviewer_1"
    },
    blindAnswers: [
      {
        round: 1,
        label: "X",
        system: "B",
        answerText,
        citations,
        model: "gpt-5.5",
        generationLatencyMs: 400
      }
    ],
    blindReviews: [
      {
        round: 1,
        label: "X",
        scores: {
          factualCorrectness: 4,
          completeness: 4,
          citationSupport: 4,
          uncertainty: 4,
          directness: 4
        },
        hardViolations: [],
        outcome: "win",
        reviewerId: "reviewer_1"
      }
    ],
    faultRuns: [
      {
        faultRunId: "fault_1",
        scenario: "embedding_timeout",
        status: "completed",
        voiceUninterrupted: true,
        lexicalFailOpen: true,
        citationsValid: true,
        shadowLatencyMs: 500,
        metadata: { shadowStatus: "timeout" }
      }
    ]
  };
}

describe("VoiceQaShadowReviewRepository", () => {
  let rootDir: string;
  let repository: VoiceQaShadowReviewRepository | undefined;
  const userId = "user_123";
  const timestamp = "2026-07-30T10:00:00.000Z";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "voice-qa-shadow-review-"));
  });

  afterEach(async () => {
    repository?.close();
    repository = undefined;
    await rm(rootDir, { recursive: true, force: true });
  });

  it("uses an isolated per-user evaluation SQLite path and rejects path traversal", () => {
    expect(getVoiceQaShadowReviewDatabasePath(userId, rootDir)).toBe(
      resolve(
        rootDir,
        "users",
        userId,
        "evaluation",
        "voice-qa-shadow-review-v1.sqlite"
      )
    );
    expect(getVoiceQaShadowReviewDatabasePath("other_user", rootDir)).not.toBe(
      getVoiceQaShadowReviewDatabasePath(userId, rootDir)
    );
    expect(() =>
      getVoiceQaShadowReviewDatabasePath("../other-user", rootDir)
    ).toThrow("Invalid voice QA shadow review user id");
    expect(() =>
      getVoiceQaShadowReviewDatabasePath("user/other", rootDir)
    ).toThrow("Invalid voice QA shadow review user id");
  });

  it("configures WAL, foreign keys, busy timeout, and stores private bodies only in SQLite", async () => {
    repository = new VoiceQaShadowReviewRepository({
      userId,
      dataRoot: rootDir,
      now: () => timestamp
    });
    expect(repository.databaseSettings()).toEqual({
      foreignKeys: 1,
      busyTimeout: 5000,
      journalMode: "wal"
    });
    repository.upsertCaseBundle(caseBundle());

    const evaluationDir = join(rootDir, "users", userId, "evaluation");
    const names = await readdir(evaluationDir);
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.every((name) =>
        name === "voice-qa-shadow-review-v1.sqlite" ||
        name === "voice-qa-shadow-review-v1.sqlite-wal" ||
        name === "voice-qa-shadow-review-v1.sqlite-shm"
      )
    ).toBe(true);
    expect(names.some((name) => name.endsWith(".json"))).toBe(false);
  });

  it("atomically and idempotently persists a complete single-case review bundle", () => {
    const filePath = join(rootDir, "review.sqlite");
    repository = new VoiceQaShadowReviewRepository({
      userId,
      filePath,
      now: () => timestamp
    });
    const input = caseBundle();

    const first = repository.upsertCaseBundle(input);
    const second = repository.upsertCaseBundle(input);

    expect(second).toEqual(first);
    expect(second.case.asrTextHash).toBe(
      hashVoiceQaShadowReviewText("我今天完成了什么？")
    );
    expect(second.questionInput).toMatchObject({
      expectedText: "我今天完成了什么？",
      expectedTextHash: hashVoiceQaShadowReviewText("我今天完成了什么？"),
      audioSha256: "d".repeat(64),
      audioDurationMs: 4_188,
      sourceKind: "recorded_holdout"
    });
    expect(second.replayInput).toMatchObject({
      version: "voice_qa_shadow_replay_input_v1",
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      input: {
        uploadId: "upload_1",
        scope: "current"
      }
    });
    expect(second.canonicalSnapshot?.evidence.map((item) => item.evidenceId))
      .toEqual(["E1", "E2"]);
    expect(second.queryVector?.vector).toEqual(
      new Float32Array([0.125, -0.25, 0.5, 1])
    );
    expect(second.queryVector?.vectorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.retrievalRuns).toHaveLength(2);
    expect(
      second.retrievalRuns.map((run) => [
        run.system,
        run.flatSnapshotId,
        run.candidates.length
      ])
    ).toEqual([
      ["A", null, 2],
      ["B", "flat_snapshot_1", 2]
    ]);
    expect(second.retrievalRuns[1]).toMatchObject({
      denseLatencyMs: 28,
      totalLatencyMs: 40,
      candidateValidity: true,
      inputHash: HASH_C,
      rankingMetadata: { fusion: "uniform_rrf", ranking: "phase31" },
      memorySourceIds: ["memory_1"]
    });
    expect(second.retrievalRuns[1]?.orderHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.qaAttempts).toMatchObject([
      {
        attemptIndex: 0,
        kind: "stream_primary",
        status: "failed",
        fallbackReason: "provider_stream_error",
        answerText: null
      },
      {
        attemptIndex: 1,
        kind: "sync_fallback",
        status: "completed",
        answerText: "今天确认把导师汇报提交了。"
      },
      {
        attemptIndex: 2,
        kind: "final_projection",
        status: "completed"
      }
    ]);
    expect(second.officialAnswer).toMatchObject({
      answerText: "今天确认把导师汇报提交了。",
      streamingComplete: true
    });
    expect(second.blindPromptSnapshot).toMatchObject({
      status: "provider_prompt",
      attemptKind: "final_projection",
      systemPrompt: "system prompt",
      systemPromptHash: hashVoiceQaShadowReviewText("system prompt"),
      userPromptPrefix: "question and context",
      userPromptPrefixHash:
        hashVoiceQaShadowReviewText("question and context"),
      evidenceSectionHash: HASH_A,
      answerMode: "agent",
      memoryCount: 2,
      evidenceCount: 2
    });
    expect(second.gold).toMatchObject({
      evidenceGroups: [["E1"]],
      categories: ["lifecycle", "project"]
    });
    expect(second.blindAnswers).toHaveLength(1);
    expect(second.blindReviews).toHaveLength(1);
    expect(second.faultRuns).toHaveLength(1);

    const database = new Database(filePath, { readonly: true });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM review_cases").get()
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM question_inputs").get()
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM case_replay_inputs").get()
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canonical_evidence").get()
    ).toEqual({ count: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM retrieval_runs").get()
    ).toEqual({ count: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM retrieval_candidates").get()
    ).toEqual({ count: 4 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM qa_attempts").get()
    ).toEqual({ count: 3 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM blind_prompt_snapshots").get()
    ).toEqual({ count: 1 });
    database.close();
  });

  it("reopens persisted data and prevents a file from being reused by another user", () => {
    const filePath = join(rootDir, "review.sqlite");
    repository = new VoiceQaShadowReviewRepository({
      userId,
      filePath,
      now: () => timestamp
    });
    const beforeRestart = repository.upsertCaseBundle(caseBundle());
    repository.close();
    repository = undefined;

    const reopened = new VoiceQaShadowReviewRepository({
      userId,
      filePath,
      now: () => timestamp
    });
    repository = reopened;
    expect(reopened.getCaseBundle("case_1")).toEqual(beforeRestart);
    expect(() =>
      new VoiceQaShadowReviewRepository({
        userId: "other_user",
        filePath
      })
    ).toThrow("database belongs to another user");
  });

  it("lets the final Voice projection replace a sync blind prompt snapshot", () => {
    repository = new VoiceQaShadowReviewRepository({
      userId,
      filePath: join(rootDir, "review.sqlite"),
      now: () => timestamp
    });
    const input = caseBundle();
    repository.upsertCaseBundle({
      ...input,
      blindPromptSnapshot: undefined
    });
    repository.upsertBlindPromptSnapshot("case_1", {
      status: "no_provider_prompt",
      attemptKind: "sync_fallback",
      answerMode: "agent",
      memoryCount: 0,
      evidenceCount: 2,
      lifecycleMetadata: { source: "sync" }
    });
    repository.upsertBlindPromptSnapshot("case_1", {
      status: "provider_prompt",
      attemptKind: "final_projection",
      systemPrompt: "final system",
      userPromptPrefix: "final user prefix",
      evidenceSectionHash: HASH_C,
      answerMode: "direct",
      memoryCount: 2,
      evidenceCount: 2,
      lifecycleMetadata: { source: "final" }
    });
    const finalSnapshot = repository.getBlindPromptSnapshot("case_1");
    expect(finalSnapshot).toMatchObject({
      status: "provider_prompt",
      attemptKind: "final_projection",
      systemPrompt: "final system",
      userPromptPrefix: "final user prefix",
      evidenceSectionHash: HASH_C
    });
    expect(
      repository.upsertBlindPromptSnapshot("case_1", {
        status: "no_provider_prompt",
        attemptKind: "sync_fallback",
        answerMode: "agent",
        memoryCount: 0,
        evidenceCount: 0,
        lifecycleMetadata: { source: "late-sync" }
      })
    ).toEqual(finalSnapshot);
  });

  it("fails closed on reused case, snapshot, vector, and replay identities", () => {
    repository = new VoiceQaShadowReviewRepository({
      userId,
      filePath: join(rootDir, "review.sqlite"),
      now: () => timestamp
    });
    const input = caseBundle();
    repository.upsertCaseBundle(input);

    expect(() =>
      repository!.upsertCase({
        ...input.case,
        asrText: "不同的问题"
      })
    ).toThrow("different ASR input");
    expect(() =>
      repository!.upsertCanonicalSnapshot({
        ...input.canonicalSnapshot!,
        contentHash: HASH_C
      })
    ).toThrow("different content");
    expect(() =>
      repository!.upsertQueryVector("case_1", {
        ...input.queryVector!,
        vector: new Float32Array([0, 0, 0, 0])
      })
    ).toThrow("different query vector");
    expect(() =>
      repository!.upsertRetrievalRun("case_1", {
        ...input.retrievalRuns![0]!,
        candidates: [
          {
            evidenceId: "E2",
            rank: 1,
            selectedRank: 1
          }
        ]
      })
    ).toThrow("different input or ordering");
    expect(() =>
      repository!.upsertRetrievalRun("case_1", {
        ...input.retrievalRuns![0]!,
        system: "C"
      } as never)
    ).toThrow("Unsupported retrieval review system");
    expect(() =>
      repository!.upsertQaAttempt("case_1", {
        ...input.qaAttempts![0]!,
        status: "completed"
      })
    ).toThrow("different terminal result");
    expect(() =>
      repository!.upsertQaAttempt("case_1", {
        ...input.qaAttempts![0]!,
        attemptIndex: 2
      })
    ).toThrow("fixed kind slot");
    expect(() =>
      repository!.upsertQuestionInput("case_1", {
        ...input.questionInput!,
        audioSha256: "e".repeat(64)
      })
    ).toThrow("different question input");
  });

  it("validates Gold category identifiers and returns an empty list for omitted categories", () => {
    repository = new VoiceQaShadowReviewRepository({
      userId,
      filePath: join(rootDir, "review.sqlite"),
      now: () => timestamp
    });
    const input = caseBundle();
    repository.upsertCaseBundle({ ...input, gold: undefined });

    expect(repository.upsertGold("case_1", {
      status: "evaluable",
      evidenceGroups: [["E1"]],
      requiredFacts: ["事实"],
      shouldRefuse: false
    }).categories).toEqual([]);
    expect(() => repository!.upsertGold("case_1", {
      status: "evaluable",
      evidenceGroups: [["E1"]],
      requiredFacts: ["事实"],
      shouldRefuse: false,
      categories: ["relationship", "../private"]
    })).toThrow("Invalid Gold category identifier");
  });

  it("migrates an existing v1 evaluation Gold table with an empty categories default", () => {
    const filePath = join(rootDir, "review-v1.sqlite");
    const legacy = new Database(filePath);
    legacy.exec(`
      CREATE TABLE gold_annotations (
        case_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        evidence_groups_json TEXT NOT NULL,
        required_facts_json TEXT NOT NULL,
        should_refuse INTEGER NOT NULL,
        reviewer_id TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    repository = new VoiceQaShadowReviewRepository({
      userId,
      filePath,
      now: () => timestamp
    });
    const inspector = new Database(filePath, { readonly: true });
    const columns = inspector.prepare(
      "PRAGMA table_info(gold_annotations)"
    ).all() as Array<{ name: string; dflt_value: string | null }>;
    inspector.close();

    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "categories_json",
        dflt_value: "'[]'"
      })
    ]));
  });

  it("rolls back every table when a single-case bundle contains an invalid child", () => {
    const filePath = join(rootDir, "review.sqlite");
    repository = new VoiceQaShadowReviewRepository({
      userId,
      filePath,
      now: () => timestamp
    });
    const input = caseBundle();

    expect(() =>
      repository!.upsertCaseBundle({
        ...input,
        case: { ...input.case, caseId: "case_atomic" },
        retrievalRuns: [
          {
            ...input.retrievalRuns![0]!,
            candidates: [
              { evidenceId: "E1", rank: 1, selectedRank: 1 },
              { evidenceId: "E2", rank: 1, selectedRank: 2 }
            ]
          }
        ]
      })
    ).toThrow("Candidate ranks");

    expect(repository.getCase("case_atomic")).toBeNull();
    expect(repository.getCanonicalSnapshot("canonical_snapshot_1")).toBeNull();
    const database = new Database(filePath, { readonly: true });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM retrieval_runs").get()
    ).toEqual({ count: 0 });
    database.close();
  });
});
