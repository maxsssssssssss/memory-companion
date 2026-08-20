// @vitest-environment node

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VoiceQaShadowReviewRepository,
  type CanonicalEvidenceSnapshotInput,
  type VoiceQaShadowRetrievalCandidateInput,
  type VoiceQaShadowReviewSystem
} from "./voice-qa-shadow-review-repository";
import {
  VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_ITERATIONS,
  VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_SEED,
  VOICE_QA_SHADOW_REVIEW_EXPORT_FILES,
  buildVoiceQaShadowReviewReports,
  exportVoiceQaShadowReviewReports,
  getVoiceQaShadowReviewExportDirectory
} from "./voice-qa-shadow-review-export";

const HASH = "a".repeat(64);
const PRIVATE_USER_ID = "private_user_123";
const PRIVATE_ASR_TEXT = "隐私问题正文：我今天完成了什么？";
const PRIVATE_EXPECTED_TEXT = "隐私预期提问正文：今天完成了什么？";
const PRIVATE_EVIDENCE_TEXT = "隐私证据正文：我今天完成了导师汇报。";
const PRIVATE_ANSWER_TEXT = "隐私答案正文：你今天完成了导师汇报。";
const TIMESTAMP = "2026-07-30T12:00:00.000Z";

function snapshot(): CanonicalEvidenceSnapshotInput {
  return {
    snapshotId: "canonical_1",
    universeHash: HASH,
    contentHash: "b".repeat(64),
    evidence: [
      {
        evidenceId: "E1",
        ordinal: 0,
        content: PRIVATE_EVIDENCE_TEXT
      },
      {
        evidenceId: "E2",
        ordinal: 1,
        content: "Alice 已经交付检查清单。"
      },
      {
        evidenceId: "E3",
        ordinal: 2,
        content: "本周取消了博物馆计划。"
      },
      {
        evidenceId: "E4",
        ordinal: 3,
        content: "无关的陶艺活动证据。"
      }
    ]
  };
}

function addCase(
  repository: VoiceQaShadowReviewRepository,
  input: {
    caseId: string;
    scope?: "current" | "week" | "all";
    candidates: Record<
      VoiceQaShadowReviewSystem,
      readonly VoiceQaShadowRetrievalCandidateInput[]
    >;
    latencies?: Partial<Record<VoiceQaShadowReviewSystem, number>>;
    withReplay?: boolean;
  }
) {
  const runs = (["A", "B"] as const).flatMap((system) => {
    const base = {
      system,
      status: "completed" as const,
      flatSnapshotId: system === "A" ? null : "flat_1",
      denseLatencyMs: system === "A" ? null : 20,
      totalLatencyMs: input.latencies?.[system] ?? (
        system === "A" ? 10 : 40
      ),
      candidateValidity: true,
      inputHash: HASH,
      rankingMetadata: { system },
      candidates: input.candidates[system]
    };
    return input.withReplay
      ? [base, { ...base, replayIndex: 1 }]
      : [base];
  });
  repository.upsertCaseBundle({
    questionInput: {
      expectedText: `${PRIVATE_EXPECTED_TEXT}:${input.caseId}`,
      audioSha256: "d".repeat(64),
      audioDurationMs: 3_500,
      sourceKind: "recorded_holdout",
      metadata: { privateAudioPath: "不能导出的音频路径" }
    },
    canonicalSnapshot: snapshot(),
    case: {
      caseId: input.caseId,
      scope: input.scope ?? "current",
      voiceSessionId: `session_${input.caseId}`,
      traceId: `trace_${input.caseId}`,
      asrText: `${PRIVATE_ASR_TEXT}:${input.caseId}`,
      asrLatencyMs: 300,
      conversationContext: {
        privateContext: "不能导出的上下文正文"
      },
      canonicalSnapshotId: "canonical_1",
      flatSnapshotId: "flat_1",
      modelFingerprint: "model_fp",
      promptFingerprint: "prompt_fp",
      codeFingerprint: "code_fp",
      status: "valid"
    },
    retrievalRuns: runs,
    qaAttempts: [
      {
        attemptIndex: 0,
        kind: "stream_primary",
        status: "failed",
        fallbackReason: `private fallback: ${PRIVATE_ASR_TEXT}`,
        provider: "openai-compatible",
        model: "gpt-5.5",
        promptFingerprint: "prompt_fp",
        codeFingerprint: "code_fp",
        latencyMs: 200
      },
      {
        attemptIndex: 1,
        kind: "sync_fallback",
        status: "completed",
        provider: "openai-compatible",
        model: "gpt-5.5",
        promptFingerprint: "prompt_fp",
        codeFingerprint: "code_fp",
        answerText: `${PRIVATE_ANSWER_TEXT}:attempt:${input.caseId}`,
        citations: [{
          evidenceId: "E1",
          quote: PRIVATE_EVIDENCE_TEXT
        }],
        latencyMs: 500
      },
      {
        attemptIndex: 2,
        kind: "final_projection",
        status: "completed",
        provider: "local-projection",
        model: "gpt-5.5",
        promptFingerprint: "prompt_fp",
        codeFingerprint: "code_fp",
        answerText: `${PRIVATE_ANSWER_TEXT}:projection:${input.caseId}`,
        citations: [{
          evidenceId: "E1",
          quote: PRIVATE_EVIDENCE_TEXT
        }],
        latencyMs: 50
      }
    ],
    officialAnswer: {
      answerText: `${PRIVATE_ANSWER_TEXT}:${input.caseId}`,
      citations: [{
        evidenceId: "E1",
        quote: PRIVATE_EVIDENCE_TEXT
      }],
      model: "gpt-5.5",
      promptFingerprint: "prompt_fp",
      codeFingerprint: "code_fp",
      llmFirstTokenLatencyMs: 100,
      firstPlayableSentenceLatencyMs: 250,
      firstAudioLatencyMs: 300,
      completeLatencyMs: 800,
      streamingComplete: true
    }
  });
}

describe("Voice QA shadow review export", () => {
  let rootDir: string;
  let repository: VoiceQaShadowReviewRepository | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "voice-qa-shadow-export-"));
    repository = new VoiceQaShadowReviewRepository({
      userId: PRIVATE_USER_ID,
      dataRoot: rootDir,
      now: () => TIMESTAMP
    });
  });

  afterEach(async () => {
    repository?.close();
    repository = undefined;
    await rm(rootDir, { recursive: true, force: true });
  });

  it("writes exactly the six review files and never exports private bodies or the user id", async () => {
    addCase(repository!, {
      caseId: "case_private",
      candidates: {
        A: [{ evidenceId: "E1", rank: 1, selectedRank: 1 }],
        B: [{ evidenceId: "E1", rank: 1, selectedRank: 1 }]
      }
    });
    repository!.upsertFaultRun({
      faultRunId: "fault_private",
      caseId: "case_private",
      scenario: "embedding_timeout",
      status: "completed",
      shadowError: `private error: ${PRIVATE_ASR_TEXT}`,
      voiceUninterrupted: true,
      lexicalFailOpen: true,
      citationsValid: true,
      shadowLatencyMs: 500
    });
    const before = repository!.getCaseBundle("case_private");
    const outputDirectory = join(rootDir, "public-evaluation-output");

    const result = await exportVoiceQaShadowReviewReports(repository!, {
      outputDirectory,
      generatedAt: TIMESTAMP
    });

    expect(result.reviewStatus).toBe("NOT_READY");
    expect((await readdir(outputDirectory)).sort()).toEqual(
      [...VOICE_QA_SHADOW_REVIEW_EXPORT_FILES].sort()
    );
    const exportedText = (
      await Promise.all(
        VOICE_QA_SHADOW_REVIEW_EXPORT_FILES.map((fileName) =>
          readFile(join(outputDirectory, fileName), "utf8")
        )
      )
    ).join("\n");
    expect(exportedText).not.toContain(PRIVATE_USER_ID);
    expect(exportedText).not.toContain(PRIVATE_ASR_TEXT);
    expect(exportedText).not.toContain(PRIVATE_EXPECTED_TEXT);
    expect(exportedText).not.toContain(PRIVATE_EVIDENCE_TEXT);
    expect(exportedText).not.toContain(PRIVATE_ANSWER_TEXT);
    expect(exportedText).not.toContain("不能导出的上下文正文");
    expect(exportedText).toContain("Review status: NOT_READY");
    expect(exportedText).toContain("Automatic promotion: DISABLED");
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, "dataset-manifest.json"), "utf8")
    ) as {
      questionInputs: {
        count: number;
        bySourceKind: Record<string, number>;
        records: Array<Record<string, unknown>>;
      };
    };
    expect(manifest.questionInputs).toMatchObject({
      count: 1,
      bySourceKind: { recorded_holdout: 1 }
    });
    expect(manifest.questionInputs.records[0]).toMatchObject({
      audioSha256: "d".repeat(64),
      sourceKind: "recorded_holdout"
    });
    expect(manifest.questionInputs.records[0]).not.toHaveProperty("expectedText");
    expect(manifest.questionInputs.records[0]).not.toHaveProperty("audioDurationMs");
    expect(manifest.questionInputs.records[0]).not.toHaveProperty("metadata");
    const latencyReport = JSON.parse(
      await readFile(
        join(outputDirectory, "latency-and-fallback.json"),
        "utf8"
      )
    ) as {
      faultRuns: {
        totalCount: number;
        scenarios: Record<string, number>;
        lexicalFailOpen: { ratio: number | null };
      };
      voice: {
        qaAttempts: {
          primary: { count: number; status: { failed: number } };
          automaticRetry: { count: number; status: { completed: number } };
          finalProjection: { count: number; status: { completed: number } };
        };
      };
    };
    expect(latencyReport.faultRuns).toMatchObject({
      totalCount: 1,
      scenarios: { embedding_timeout: 1 },
      lexicalFailOpen: { ratio: 1 }
    });
    expect(latencyReport.voice.qaAttempts).toMatchObject({
      primary: { count: 1, status: { failed: 1 } },
      automaticRetry: { count: 1, status: { completed: 1 } },
      finalProjection: { count: 1, status: { completed: 1 } }
    });
    expect(repository!.getCaseBundle("case_private")).toEqual(before);
  });

  it("marks missing Gold and a holdout below 60 as NOT_READY without an automatic promotion", () => {
    addCase(repository!, {
      caseId: "case_no_gold",
      candidates: {
        A: [{ evidenceId: "E1", rank: 1, selectedRank: 1 }],
        B: [{ evidenceId: "E1", rank: 1, selectedRank: 1 }]
      }
    });

    const reports = buildVoiceQaShadowReviewReports(repository!, {
      generatedAt: TIMESTAMP
    });

    expect(reports["dataset-manifest.json"]).toMatchObject({
      reviewStatus: "NOT_READY",
      automaticPromotionAllowed: false,
      counts: {
        totalCases: 1,
        goldStatus: {
          missing: 1,
          evaluable: 0,
          ambiguous: 0,
          excluded: 0
        }
      },
      readiness: {
        collectionReady: false,
        frozenCollectionReady: false,
        questionInputsReady: false,
        goldReady: false,
        retrievalAndReplayReady: false,
        canonicalAndCitationReady: false,
        officialTerminalMetricsReady: false,
        requiredFaultCoverageReady: false,
        humanDecisionReady: false
      }
    });
    expect(
      reports["dataset-manifest.json"].readiness.reasons
    ).toEqual(expect.arrayContaining([
      expect.stringContaining("valid_holdout_below_requirement"),
      expect.stringContaining("frozen_collection_inconsistent"),
      expect.stringContaining("independent_gold_below_requirement"),
      expect.stringContaining("question_inputs_below_requirement"),
      expect.stringContaining("canonical_or_citation_validity_incomplete"),
      expect.stringContaining("official_voice_terminal_metrics_incomplete"),
      expect.stringContaining("required_fault_coverage_incomplete")
    ]));
    expect(
      reports["dataset-manifest.json"].knownMeasurementRisks
    ).toEqual(expect.arrayContaining([
      expect.stringContaining("snapshot synchronization"),
      expect.stringContaining("no durable task queue")
    ]));
    expect(reports["retrieval-comparison.json"].systems[0]?.quality).toMatchObject({
      evaluatedCaseCount: 0,
      recallAt16: null,
      mrr: null,
      ndcgAt10: null
    });
    expect(reports["decision-report.md"]).not.toContain("PROMOTE_HYBRID");
  });

  it("calculates paired retrieval metrics, gains/losses, complete-miss recovery and fixed-seed bootstrap", () => {
    addCase(repository!, {
      caseId: "case_1",
      candidates: {
        A: [{ evidenceId: "E1", rank: 1, selectedRank: 1 }],
        B: [
          { evidenceId: "E1", rank: 1, selectedRank: 1 },
          { evidenceId: "E2", rank: 2, selectedRank: 2 }
        ]
      },
      latencies: { A: 10, B: 40 },
      withReplay: true
    });
    repository!.upsertGold("case_1", {
      status: "evaluable",
      evidenceGroups: [["E1"], ["E2"]],
      requiredFacts: ["事实一", "事实二"],
      shouldRefuse: false,
      categories: ["project", "lifecycle"]
    });
    addCase(repository!, {
      caseId: "case_2",
      scope: "week",
      candidates: {
        A: [{ evidenceId: "E4", rank: 1, selectedRank: 1 }],
        B: [{ evidenceId: "E3", rank: 1, selectedRank: 1 }]
      },
      latencies: { A: 20, B: 60 },
      withReplay: true
    });
    repository!.upsertGold("case_2", {
      status: "evaluable",
      evidenceGroups: [["E3"]],
      requiredFacts: ["事实三"],
      shouldRefuse: false,
      categories: ["decision"]
    });

    const first = buildVoiceQaShadowReviewReports(repository!, {
      generatedAt: TIMESTAMP
    });
    const second = buildVoiceQaShadowReviewReports(repository!, {
      generatedAt: TIMESTAMP
    });
    const comparison = first["retrieval-comparison.json"];
    const [systemA, systemB] = comparison.systems;

    expect(systemA?.quality).toMatchObject({
      evaluatedCaseCount: 2,
      goldGroupCount: 3,
      recallAt5: 0.333333,
      recallAt10: 0.333333,
      recallAt16: 0.333333,
      recallAt30: 0.333333,
      mrr: 0.5,
      completeMissCount: 1
    });
    expect(systemA?.quality.byCategory).toMatchObject({
      project: { recallAt16: 0.5 },
      lifecycle: { recallAt16: 0.5 },
      decision: { recallAt16: 0 }
    });
    expect(systemA?.quality.worstCategoryByRecallAt16).toEqual({
      categories: ["decision"],
      recallAt16: 0
    });
    expect(systemB?.quality).toMatchObject({
      recallAt16: 1,
      recallAt30: 1,
      mrr: 1,
      ndcgAt10: 1,
      completeMissCount: 0
    });
    expect(systemB?.latency.total).toEqual({
      count: 2,
      p50Ms: 40,
      p95Ms: 60,
      maxMs: 60
    });
    expect(systemB?.replayConsistency).toMatchObject({
      assessedCaseCount: 2,
      identicalCaseCount: 2,
      ratio: 1,
      allAssessedIdentical: true
    });
    expect(comparison.comparisons.bVsA).toMatchObject({
      pairedCaseCount: 2,
      top16GoldGains: 2,
      top16GoldLosses: 0,
      netTop16GoldGroups: 2,
      recoveredCompleteMisses: 1,
      recallAt16Difference: 0.75,
      pairedBootstrap95: {
        seed: VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_SEED,
        iterations: VOICE_QA_SHADOW_REVIEW_BOOTSTRAP_ITERATIONS,
        pairedCaseCount: 2
      }
    });
    expect(second["retrieval-comparison.json"].comparisons).toEqual(
      comparison.comparisons
    );
    expect(first["dataset-manifest.json"].reviewStatus).toBe("NOT_READY");
  });

  it("uses the required default evaluation output directory", () => {
    expect(getVoiceQaShadowReviewExportDirectory(rootDir)).toBe(
      join(rootDir, "evaluation", "voice-qa-shadow-review-v1")
    );
  });
});
