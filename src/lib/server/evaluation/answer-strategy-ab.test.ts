// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceQaContextSchema } from "@/lib/domain/voice-qa-context";
import type { AnswerQuestionWithAIInput } from "@/lib/server/retrieval/ai-qa";

import {
  AnswerStrategyBenchmarkDatasetSchema,
  assertAnswerStrategyBenchmarkOutputPaths,
  answerStrategyBenchmarkProgressPaths,
  appendAnswerStrategyBenchmarkProgress,
  createAnswerStrategyBenchmarkSchedule,
  loadAnswerStrategyBenchmarkDataset,
  renderAnswerStrategyBenchmarkMarkdown,
  runAnswerStrategyBenchmark,
  stableDigest,
  writeAnswerStrategyBenchmarkPartialReport,
  writeAnswerStrategyBenchmarkReport,
  type AnswerStrategyBenchmarkSource
} from "./answer-strategy-ab";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "answer-strategy-ab-"));
  temporaryRoots.push(root);
  return root;
}

async function dataset() {
  return loadAnswerStrategyBenchmarkDataset(
    resolve("benchmark/answer-strategy/long-recording-60m.json")
  );
}

async function source(): Promise<AnswerStrategyBenchmarkSource> {
  const dataDir = await tempRoot();
  const context = VoiceQaContextSchema.parse({
    contextId: "upload_1",
    segments: [{
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 1,
      endSeconds: 2,
      speaker: "speaker_0",
      text: "Retained synthetic evidence.",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }],
    audioInsights: [],
    semanticSegments: [],
    briefItems: [],
    relationshipSignals: []
  });
  return {
    dataDir,
    userId: "user_1",
    uploadId: "upload_1",
    context,
    contextDigest: stableDigest(context),
    memoryContextDigest: stableDigest({ scope: "current", memories: [] }),
    contextCounts: {
      transcriptSegments: 1,
      audioInsights: 0,
      semanticSegments: 0,
      briefItems: 0,
      relationshipCards: 0
    }
  };
}

function mockAnswerer(received: AnswerQuestionWithAIInput[]) {
  return vi.fn(async (input: AnswerQuestionWithAIInput) => {
    received.push(input);
    input.onRetrievedEvidence?.([{
      id: "raw_segment_1",
      kind: "raw",
      title: "Original transcript",
      text: "Retained synthetic evidence.",
      startSeconds: 1,
      endSeconds: 2,
      sourceSegmentIds: ["segment_1"],
      priority: 1
    }], 1);
    input.onDiagnostics?.({
      answerMode: input.answerMode ?? "agent",
      memoryRetrievalMs: null,
      relationshipContextBuildingMs: 1,
      rerankingMs: 1,
      promptConstructionMs: 1,
      llmGenerationMs: 5,
      responseValidationMs: 1,
      totalMs: 9,
      promptCharacters: 100,
      responseCharacters: 20,
      evidenceCount: 1,
      providerCallCount: 1,
      fallbackReason: "none"
    });
    return {
      id: `answer_${input.answerMode}_${received.length}`,
      uploadId: input.uploadId,
      question: input.question,
      answer: `Answer from ${input.answerMode}. [E1]`,
      citedSegmentIds: ["segment_1"],
      citations: [{
        id: "E1",
        title: "Original transcript",
        startSeconds: 1,
        endSeconds: 2,
        excerpt: "Retained synthetic evidence.",
        sourceSegmentIds: ["segment_1"]
      }],
      createdAt: "2026-07-22T00:00:00.000Z"
    };
  });
}

describe("answer strategy A/B dataset", () => {
  it("loads a unique, balanced long-recording-60m question set", async () => {
    const questions = await dataset();

    expect(AnswerStrategyBenchmarkDatasetSchema.parse(questions)).toHaveLength(34);
    expect(new Set(questions.map((question) => question.id))).toHaveLength(34);
    expect(questions.filter((question) => question.category === "fact")).toHaveLength(5);
    expect(questions.filter((question) => question.category === "relationship")).toHaveLength(8);
    expect(questions.filter((question) => question.category === "lifecycle")).toHaveLength(8);
    expect(questions.filter((question) => question.category === "preference")).toHaveLength(5);
    expect(questions.filter((question) => question.category === "ambiguous")).toHaveLength(4);
    expect(questions.filter((question) => question.category === "companion")).toHaveLength(4);
  });
});

describe("answer strategy A/B scheduling", () => {
  it("is seeded, randomized, and counterbalances every question", async () => {
    const questions = await dataset();
    const first = createAnswerStrategyBenchmarkSchedule(questions, 3, "seed-a");
    const repeat = createAnswerStrategyBenchmarkSchedule(questions, 3, "seed-a");
    const other = createAnswerStrategyBenchmarkSchedule(questions, 3, "seed-b");

    expect(first).toEqual(repeat);
    expect(first).not.toEqual(other);
    expect(first).toHaveLength(questions.length * 3);
    expect(new Set(first.map((pair) => pair.modes[0]))).toEqual(new Set(["agent", "direct"]));
    for (const question of questions) {
      const pairs = first.filter((pair) => pair.question.id === question.id);
      expect(pairs).toHaveLength(3);
      expect(new Set(pairs.map((pair) => pair.modes[0]))).toEqual(
        new Set(["agent", "direct"])
      );
      expect(pairs.every((pair) => new Set(pair.modes).size === 2)).toBe(true);
    }
  });

  it("rejects fewer than three rounds", async () => {
    const questions = await dataset();
    expect(() => createAnswerStrategyBenchmarkSchedule(questions, 2, "seed")).toThrow(
      "at least 3 rounds"
    );
  });
});

describe("answer strategy A/B execution", () => {
  it("fails closed when offline execution has no injected answer delegate", async () => {
    const benchmarkSource = await source();
    const questions = await dataset();
    await expect(runAnswerStrategyBenchmark({
      questions,
      source: benchmarkSource,
      rounds: 3,
      seed: "offline-guard",
      remote: false,
      logger: { info: vi.fn(), warn: vi.fn() }
    })).rejects.toThrow("requires an injected answerQuestion delegate");
  });

  it("uses identical context and evidence while changing only answerMode", async () => {
    const questions = await dataset();
    const benchmarkSource = await source();
    const received: AnswerQuestionWithAIInput[] = [];
    const answerQuestion = mockAnswerer(received);
    let clock = 0;
    const info = vi.fn();
    const warn = vi.fn();

    const report = await runAnswerStrategyBenchmark({
      questions,
      source: benchmarkSource,
      rounds: 3,
      seed: "stable-seed",
      remote: false,
      answerQuestion,
      now: () => {
        clock += 10;
        return clock;
      },
      generatedAt: () => "2026-07-22T00:00:00.000Z",
      logger: { info, warn }
    });

    expect(answerQuestion).toHaveBeenCalledTimes(questions.length * 3 * 2);
    expect(report.runs).toHaveLength(questions.length * 3 * 2);
    expect(report.pairIntegrity).toEqual({
      totalPairs: questions.length * 3,
      validPairs: questions.length * 3,
      evidenceMismatchPairs: 0,
      missingEvidenceDigestPairs: 0
    });
    expect(report.integrity).toMatchObject({
      answerStrategyOnlyVariable: true,
      sameContextForAllRuns: true,
      sameMemoryContextForAllRuns: true,
      sameEvidenceWithinPairs: true,
      originalUploadMutated: false,
      memoryMutated: false
    });
    expect(report.runs.every((run) => run.citation_validation_passed === true)).toBe(true);
    expect(report.runs.every((run) => run.manual_scores.factual_correctness === null)).toBe(true);
    expect(report.manualReview.winnerDeclared).toBe(false);
    expect(info).toHaveBeenCalledTimes(report.runs.length);
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls.map((call) => call[0]).join("\n")).not.toContain(
      questions[0]?.question
    );

    const byQuestionAndRound = new Map<string, AnswerQuestionWithAIInput[]>();
    for (const input of received) {
      const key = `${input.question}:${Math.floor(
        received.indexOf(input) / 2
      )}`;
      byQuestionAndRound.set(key, [...(byQuestionAndRound.get(key) ?? []), input]);
    }
    expect(received.every((input) => input.segments === benchmarkSource.context.segments)).toBe(true);
    expect(received.every((input) => input.briefItems === benchmarkSource.context.briefItems)).toBe(true);
    expect(new Set(received.map((input) => input.answerMode))).toEqual(
      new Set(["agent", "direct"])
    );
    expect(byQuestionAndRound.size).toBeGreaterThan(0);
  });

  it("writes a structured report outside retained runtime and renders provenance", async () => {
    const benchmarkSource = await source();
    const questions = await dataset();
    const report = await runAnswerStrategyBenchmark({
      questions,
      source: benchmarkSource,
      rounds: 3,
      seed: "writer-seed",
      remote: false,
      answerQuestion: mockAnswerer([]),
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    const outputRoot = await tempRoot();
    const reportPath = join(outputRoot, "report.json");

    await writeAnswerStrategyBenchmarkReport(reportPath, report, benchmarkSource.dataDir);
    const written = JSON.parse(await readFile(reportPath, "utf8"));

    expect(written.dataset.questionCount).toBe(34);
    expect(written.runs[0]).toMatchObject({
      question_id: expect.stringMatching(/^q\d{3}$/u),
      execution_order: expect.any(Number)
    });
    expect(written.runs[0]).not.toHaveProperty("factual_correctness");
    expect(written.runs[0].manual_scores).toMatchObject({
      factual_correctness: null,
      evidence_grounding: null,
      relationship_understanding: null,
      companion_quality: null
    });
    expect(renderAnswerStrategyBenchmarkMarkdown(report)).toContain(
      "No strategy winner is declared automatically"
    );
    expect(renderAnswerStrategyBenchmarkMarkdown(report)).toContain(
      "npm run answer-strategy:benchmark:status -- --watch"
    );

    await expect(
      writeAnswerStrategyBenchmarkReport(
        join(benchmarkSource.dataDir, "report.json"),
        report,
        benchmarkSource.dataDir
      )
    ).rejects.toThrow("outside retained runtime data");

    expect(() => assertAnswerStrategyBenchmarkOutputPaths({
      dataDir: benchmarkSource.dataDir,
      reportPath: join(benchmarkSource.dataDir, "report.json"),
      docsPath: join(outputRoot, "report.md"),
      progressPath: join(outputRoot, "report.progress.jsonl"),
      partialReportPath: join(outputRoot, "report.partial.json")
    })).toThrow("outside retained runtime data");
    expect(() => assertAnswerStrategyBenchmarkOutputPaths({
      dataDir: benchmarkSource.dataDir,
      reportPath,
      docsPath: reportPath,
      progressPath: join(outputRoot, "report.progress.jsonl"),
      partialReportPath: join(outputRoot, "report.partial.json")
    })).toThrow("must be distinct");
  });

  it("persists append-only progress and an atomic partial report", async () => {
    const benchmarkSource = await source();
    const questions = await dataset();
    const report = await runAnswerStrategyBenchmark({
      questions,
      source: benchmarkSource,
      rounds: 3,
      seed: "progress-seed",
      remote: false,
      answerQuestion: mockAnswerer([]),
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    const outputRoot = await tempRoot();
    const paths = answerStrategyBenchmarkProgressPaths(join(outputRoot, "report.json"));
    await appendAnswerStrategyBenchmarkProgress(paths.progressPath, {
      event: "benchmark_started",
      at: "2026-07-22T00:00:00.000Z",
      completed_runs: 0,
      total_runs: report.runs.length
    });
    await appendAnswerStrategyBenchmarkProgress(paths.progressPath, {
      event: "run_started",
      at: "2026-07-22T00:00:00.500Z",
      completed_runs: 0,
      total_runs: report.runs.length,
      run_id: report.runs[0]!.run_id,
      question_id: report.runs[0]!.question_id,
      category: report.runs[0]!.category,
      round: report.runs[0]!.round,
      answer_mode: report.runs[0]!.answer_mode,
      execution_order: report.runs[0]!.execution_order
    });
    await appendAnswerStrategyBenchmarkProgress(paths.progressPath, {
      event: "run_completed",
      at: "2026-07-22T00:00:01.000Z",
      completed_runs: 1,
      total_runs: report.runs.length,
      question_id: report.runs[0]!.question_id,
      category: report.runs[0]!.category,
      round: report.runs[0]!.round,
      answer_mode: report.runs[0]!.answer_mode,
      execution_order: report.runs[0]!.execution_order,
      status: report.runs[0]!.status,
      total_latency_ms: report.runs[0]!.total_latency_ms,
      generation_latency_ms: report.runs[0]!.generation_latency_ms,
      evidence_count: report.runs[0]!.evidence_count,
      citation_count: report.runs[0]!.citation_count,
      fallback_status: report.runs[0]!.fallback_status
    });
    await writeAnswerStrategyBenchmarkPartialReport({
      partialReportPath: paths.partialReportPath,
      report: { ...report, runs: [report.runs[0]!] },
      completedRuns: 1,
      totalRuns: report.runs.length,
      status: "running",
      updatedAt: "2026-07-22T00:00:01.000Z"
    });

    const progressLines = (await readFile(paths.progressPath, "utf8")).trim().split("\n");
    const partial = JSON.parse(await readFile(paths.partialReportPath, "utf8"));
    expect(progressLines).toHaveLength(3);
    expect(JSON.parse(progressLines[2]!)).toMatchObject({
      event: "run_completed",
      completed_runs: 1
    });
    expect(progressLines.join("\n")).not.toContain(questions[0]?.question);
    expect(partial).toMatchObject({
      status: "running",
      completedRuns: 1,
      totalRuns: report.runs.length
    });
    expect(partial.report.runs).toHaveLength(1);
    const serializedPartial = JSON.stringify(partial);
    expect(serializedPartial).not.toContain("answer_text");
    expect(serializedPartial).not.toContain("cited_segment_ids");
    expect(serializedPartial).not.toContain(questions[0]!.question);

    await writeAnswerStrategyBenchmarkPartialReport({
      partialReportPath: paths.partialReportPath,
      report,
      completedRuns: report.runs.length,
      totalRuns: report.runs.length,
      status: "completed",
      updatedAt: "2026-07-22T00:00:02.000Z"
    });
    expect(JSON.parse(await readFile(paths.partialReportPath, "utf8"))).toMatchObject({
      status: "completed",
      completedRuns: report.runs.length
    });
  });
});
