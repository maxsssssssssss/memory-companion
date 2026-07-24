import { describe, expect, it } from "vitest";

import type { QuestionAnswer } from "@/lib/domain/types";
import type { QaRetrievedEvidence } from "@/lib/server/retrieval/ai-qa";
import { projectCompactEvidence } from "@/lib/server/retrieval/evidence-compression/projection";
import { analyzeQaQueryIntent } from "@/lib/server/retrieval/lifecycle-retrieval";

import {
  buildCompactEvidenceAbReport,
  compactEvidenceAbScheduleDigest,
  createCompactEvidenceAbSchedule,
  evaluateCompactEvidenceAbQuality,
  loadCompactEvidenceAbDataset,
  rescoreCompactEvidenceAbStoredRuns,
  runCompactEvidenceAb,
  type CompactEvidenceAbExecution
} from "./compact-evidence-ab";
import type { AnswerStrategyBenchmarkSource } from "./answer-strategy-ab";

function evidence(): QaRetrievedEvidence {
  return {
    id: "evidence_1",
    kind: "raw",
    title: "偏好证据",
    text: "当事人明确说不放香菜、不太能吃辣、喜欢清淡食物和安静不拥挤的位置。",
    startSeconds: 10,
    endSeconds: 20,
    sourceSegmentIds: ["seg_1"],
    priority: 1
  };
}

function answer(text: string, sourceIds = ["seg_1"]): QuestionAnswer {
  return {
    id: "answer_1",
    uploadId: "upload_1",
    question: "question",
    answer: `${text}[E1]`,
    citedSegmentIds: [...sourceIds],
    citations: [
      {
        id: "E1",
        title: "偏好证据",
        startSeconds: 10,
        endSeconds: 20,
        excerpt: "Synthetic retained evidence",
        sourceSegmentIds: [...sourceIds]
      }
    ],
    createdAt: "2026-07-23T00:00:00.000Z"
  };
}

describe("Compact Evidence A/B benchmark", () => {
  it("loads the focused seven-question long-recording-60m dataset", async () => {
    const dataset = await loadCompactEvidenceAbDataset(
      "benchmark/evidence-compression/long-recording-60m.json"
    );

    expect(dataset.questions).toHaveLength(7);
    expect(dataset.questions.map((question) => question.id)).toEqual([
      "q017",
      "q018",
      "q034",
      "q025",
      "q026",
      "q022",
      "q012"
    ]);
  });

  it("counterbalances Original and Compact execution order", async () => {
    const dataset = await loadCompactEvidenceAbDataset(
      "benchmark/evidence-compression/long-recording-60m.json"
    );
    const schedule = createCompactEvidenceAbSchedule(
      dataset.questions,
      3,
      "compact-evidence-test"
    );

    expect(schedule).toHaveLength(21);
    for (const question of dataset.questions) {
      const pairs = schedule.filter((pair) => pair.question.id === question.id);
      expect(pairs).toHaveLength(3);
      expect(new Set(pairs.flatMap((pair) => pair.views))).toEqual(
        new Set(["original", "compact"])
      );
      expect(new Set(pairs.map((pair) => pair.views[0])).size).toBe(2);
    }
  });

  it("passes preference coverage with exact canonical citation mapping", async () => {
    const dataset = await loadCompactEvidenceAbDataset(
      "benchmark/evidence-compression/long-recording-60m.json"
    );
    const question = dataset.questions.find((item) => item.id === "q025")!;
    const canonical = [evidence()];
    const projection = projectCompactEvidence({
      evidence: canonical,
      queryIntent: analyzeQaQueryIntent(question.question)
    });
    const quality = evaluateCompactEvidenceAbQuality({
      question,
      answer: answer(
        "四项稳定偏好是不放香菜、不太能吃辣、喜欢清淡食物，以及安静不拥挤的位置。"
      ),
      evidence: canonical,
      fallbackStatus: "none",
      projection
    });

    expect(quality.citation).toMatchObject({
      valid: true,
      exactSourceMapping: true,
      inlineMetadataAligned: true
    });
    expect(quality.sourceIds.valid).toBe(true);
    expect(quality.concepts.matched).toHaveLength(4);
    expect(quality.concepts.pass).toBe(true);
    expect(quality.finalQualityPass).toBe(true);
  });

  it("detects low-value preference substitution and invented owner mapping", async () => {
    const dataset = await loadCompactEvidenceAbDataset(
      "benchmark/evidence-compression/long-recording-60m.json"
    );
    const question = dataset.questions.find((item) => item.id === "q025")!;
    const canonical = [evidence()];
    const projection = projectCompactEvidence({
      evidence: canonical,
      queryIntent: analyzeQaQueryIntent(question.question)
    });
    const quality = evaluateCompactEvidenceAbQuality({
      question,
      answer: answer(
        "speaker_1 就是伴侣，她偏好汤不要太烫、窗边有一点风。"
      ),
      evidence: canonical,
      fallbackStatus: "none",
      projection
    });

    expect(quality.concepts.pass).toBe(false);
    expect(quality.ownerBoundary).toMatchObject({
      applicable: true,
      inventedLocalToGlobalMapping: true,
      pass: false
    });
    expect(quality.finalQualityPass).toBe(false);
  });

  it("fails source validation when citation metadata no longer matches E1", async () => {
    const dataset = await loadCompactEvidenceAbDataset(
      "benchmark/evidence-compression/long-recording-60m.json"
    );
    const question = dataset.questions.find((item) => item.id === "q025")!;
    const canonical = [evidence()];
    const projection = projectCompactEvidence({
      evidence: canonical,
      queryIntent: analyzeQaQueryIntent(question.question)
    });
    const quality = evaluateCompactEvidenceAbQuality({
      question,
      answer: answer(
        "四项稳定偏好是不放香菜、不太能吃辣、喜欢清淡食物，以及安静不拥挤的位置。",
        ["seg_outside"]
      ),
      evidence: canonical,
      fallbackStatus: "none",
      projection
    });

    expect(quality.citation.valid).toBe(false);
    expect(quality.sourceIds.valid).toBe(false);
    expect(quality.finalQualityPass).toBe(false);
  });

  it("builds paired aggregates without changing canonical Evidence", async () => {
    const dataset = await loadCompactEvidenceAbDataset(
      "benchmark/evidence-compression/long-recording-60m.json"
    );
    const question = dataset.questions.find((item) => item.id === "q025")!;
    const canonical = [evidence()];
    const projection = projectCompactEvidence({
      evidence: canonical,
      queryIntent: analyzeQaQueryIntent(question.question)
    });
    const source: AnswerStrategyBenchmarkSource = {
      dataDir: "C:/tmp/compact-evidence-test",
      userId: "user_1",
      uploadId: "upload_1",
      context: {
        contextId: "upload_1",
        segments: [],
        audioInsights: [],
        semanticSegments: [],
        briefItems: [],
        relationshipSignals: []
      },
      contextDigest: "context-digest",
      memoryContextDigest: "memory-digest",
      contextCounts: {
        transcriptSegments: 0,
        audioInsights: 0,
        semanticSegments: 0,
        briefItems: 0,
        relationshipCards: 0
      }
    };
    const execution = (view: "original" | "compact"): CompactEvidenceAbExecution => ({
      answer: answer(
        "四项稳定偏好是不放香菜、不太能吃辣、喜欢清淡食物，以及安静不拥挤的位置。"
      ),
      diagnostics: {
        answerMode: "agent",
        memoryRetrievalMs: null,
        relationshipContextBuildingMs: 1,
        rerankingMs: 1,
        promptConstructionMs: 1,
        llmGenerationMs: view === "compact" ? 80 : 100,
        responseValidationMs: 1,
        totalMs: view === "compact" ? 90 : 110,
        promptCharacters: view === "compact" ? 700 : 1_000,
        responseCharacters: 50,
        evidenceCount: 1,
        providerCallCount: 1,
        fallbackReason: "none"
      },
      streamTrace: {
        version: 1,
        streamId: "00000000-0000-4000-8000-000000000001",
        status: "completed",
        timestamps: {
          stream_started: "2026-07-23T00:00:00.000Z",
          provider_request_started: "2026-07-23T00:00:00.001Z",
          first_token_received: "2026-07-23T00:00:00.010Z",
          first_sentence_candidate: "2026-07-23T00:00:00.070Z",
          first_sentence_validated: "2026-07-23T00:00:00.075Z",
          first_sentence_completed: "2026-07-23T00:00:00.080Z",
          provider_stream_ended: "2026-07-23T00:00:00.090Z",
          stream_completed: "2026-07-23T00:00:00.100Z"
        },
        latencies: {
          firstTokenMs: view === "compact" ? 8 : 10,
          firstSentenceCandidateMs: 70,
          firstSentenceValidatedMs: 75,
          firstSentenceMs: 80,
          totalStreamMs: view === "compact" ? 80 : 100,
          totalOperationMs: view === "compact" ? 90 : 110
        },
        tokenChunkCount: 2,
        sentenceCount: 1,
        providerCallCount: 1,
        fallbackReason: null,
        sentenceCommit: {
          sentenceUnits: 1,
          committedUnits: 1,
          missingSentenceSupport: 0,
          citationMetadataMismatch: 0,
          responseNotFullyCommittable: 0
        }
      },
      finalSource: "provider_stream",
      evidence: canonical,
      projection,
      totalLatencyMs: view === "compact" ? 90 : 110
    });

    const report = await runCompactEvidenceAb({
      questions: [question],
      source,
      runtime: {
        provider: "openai-compatible",
        modelId: "gpt-5.5",
        wireApi: "chat",
        answerStrategy: "agent"
      },
      rounds: 2,
      seed: "paired-report-test",
      remote: false,
      executeQuestion: async ({ view }) => execution(view)
    });

    expect(report.runs).toHaveLength(4);
    expect(report.pairIntegrity).toMatchObject({
      totalPairs: 2,
      validPairs: 2,
      evidenceMismatchPairs: 0,
      sourceMappingMismatchPairs: 0
    });
    expect(report.comparison.inputCharsReductionRatio).toBe(0.3);
    expect(report.comparison.qualityRegressionPairs).toBe(0);
    expect(report.productionGray.recommendation).toBe("eligible");

    const schedule = createCompactEvidenceAbSchedule(
      [question],
      2,
      "paired-report-test"
    );
    expect(report.execution.scheduleDigest).toBe(
      compactEvidenceAbScheduleDigest(schedule)
    );

    const staleAggregateRun = {
      ...report.runs[0]!,
      question_id: "q034",
      answer_text:
        "没有证据表明她答应的事都做完了。陶艺已完成，但排练只是明确约定，不能算已完成。[E1]",
      quality: {
        ...report.runs[0]!.quality!,
        lifecycle: {
          applicable: true,
          intentRecognized: true,
          expectedState: "partial_or_unknown" as const,
          citedStates: ["pending" as const, "resolved" as const],
          semanticChecksPassed: null,
          pass: false
        },
        finalQualityPass: false
      }
    };
    const rescored = rescoreCompactEvidenceAbStoredRuns({
      questions: dataset.questions,
      runs: [staleAggregateRun]
    });
    expect(rescored[0]?.quality?.lifecycle.pass).toBe(true);
    expect(rescored[0]?.quality?.finalQualityPass).toBe(true);

    const duplicatedPairReport = buildCompactEvidenceAbReport({
      questions: [question],
      source,
      runtime: {
        provider: "openai-compatible",
        modelId: "gpt-5.5",
        wireApi: "chat",
        answerStrategy: "agent"
      },
      schedule,
      rounds: 2,
      seed: "paired-report-test",
      runs: [
        ...report.runs,
        {
          ...report.runs[0]!,
          run_id: `${report.runs[0]!.run_id}-duplicate`
        }
      ],
      remote: false
    });
    expect(duplicatedPairReport.pairIntegrity).toMatchObject({
      totalPairs: 2,
      validPairs: 1,
      invalidShapePairs: 1
    });

    const sharedFailureReport = buildCompactEvidenceAbReport({
      questions: [question],
      source,
      runtime: {
        provider: "openai-compatible",
        modelId: "gpt-5.5",
        wireApi: "chat",
        answerStrategy: "agent"
      },
      schedule,
      rounds: 2,
      seed: "paired-report-test",
      runs: report.runs.map((run) => ({
        ...run,
        quality: {
          ...run.quality!,
          concepts: {
            ...run.quality!.concepts,
            pass: false
          },
          finalQualityPass: false
        }
      })),
      remote: false
    });
    expect(
      sharedFailureReport.comparison.sharedQualityFailureQuestions
    ).toEqual(["q025"]);
    expect(sharedFailureReport.productionGray.recommendation).toBe(
      "not_eligible"
    );

    const fallbackReport = await runCompactEvidenceAb({
      questions: [question],
      source,
      runtime: {
        provider: "openai-compatible",
        modelId: "gpt-5.5",
        wireApi: "chat",
        answerStrategy: "agent"
      },
      rounds: 2,
      seed: "fallback-report-test",
      remote: false,
      executeQuestion: async ({ view }) => {
        const value = execution(view);
        return {
          ...value,
          finalSource: "non_stream_fallback" as const,
          streamTrace: {
            ...value.streamTrace!,
            status: "completed_with_fallback" as const,
            fallbackReason: "provider_stream_error" as const
          }
        };
      }
    });
    expect(
      fallbackReport.runs.every(
        (run) => run.fallback_status === "provider_stream_error"
      )
    ).toBe(true);
  });
});
