import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

function errorIdentity(error: unknown) {
  const rawName = error instanceof Error ? error.name : "unknown";
  const rawCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return {
    error_name: /^[A-Za-z0-9_.-]{1,80}$/u.test(rawName) ? rawName : "unknown",
    error_code: typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(rawCode)
      ? rawCode
      : null
  };
}

async function main() {
  const [{ parseAnswerStrategyBenchmarkArgs, assertBenchmarkOutputsAbsent }, benchmark] =
    await Promise.all([
      import("@/lib/server/evaluation/answer-strategy-ab-cli"),
      import("@/lib/server/evaluation/answer-strategy-ab")
    ]);
  const options = parseAnswerStrategyBenchmarkArgs(process.argv.slice(2), process.env);
  const questions = await benchmark.loadAnswerStrategyBenchmarkDataset(options.datasetPath);
  const source = await benchmark.loadLongRecording60mBenchmarkSource({
    dataDir: options.dataDir,
    userId: options.userId,
    uploadId: options.uploadId
  });
  const plannedRuns = questions.length * options.rounds * 2;

  if (!options.remote) {
    const schedule = benchmark.createAnswerStrategyBenchmarkSchedule(
      questions,
      options.rounds,
      options.seed
    );
    console.info(JSON.stringify({
      ok: true,
      mode: "plan_only",
      questions: questions.length,
      rounds: options.rounds,
      plannedRuns,
      scheduleDigest: benchmark.stableDigest(schedule.map((pair) => ({
        pairId: pair.pairId,
        modes: pair.modes
      }))),
      contextDigest: source.contextDigest,
      remoteCalls: 0
    }, null, 2));
    return;
  }

  const progressPaths = benchmark.answerStrategyBenchmarkProgressPaths(options.reportPath);
  benchmark.assertAnswerStrategyBenchmarkOutputPaths({
    dataDir: options.dataDir,
    reportPath: options.reportPath,
    docsPath: options.docsPath,
    ...progressPaths
  });
  await assertBenchmarkOutputsAbsent({ ...options, ...progressPaths });
  const schedule = benchmark.createAnswerStrategyBenchmarkSchedule(
    questions,
    options.rounds,
    options.seed
  );
  const startedAt = new Date().toISOString();
  let latestReport = benchmark.buildAnswerStrategyBenchmarkReport({
    questions,
    source,
    rounds: options.rounds,
    seed: options.seed,
    remote: true,
    schedule,
    runs: [],
    generatedAt: startedAt
  });
  let activeRun: {
    run_id: string;
    question_id: string;
    category: typeof questions[number]["category"];
    round: number;
    answer_mode: "agent" | "direct";
    execution_order: 1 | 2;
    started_at: string;
  } | null = null;
  await benchmark.appendAnswerStrategyBenchmarkProgress(progressPaths.progressPath, {
    event: "benchmark_started",
    at: startedAt,
    completed_runs: 0,
    total_runs: plannedRuns
  });
  await benchmark.writeAnswerStrategyBenchmarkPartialReport({
    partialReportPath: progressPaths.partialReportPath,
    report: latestReport,
    completedRuns: 0,
    totalRuns: plannedRuns,
    status: "running",
    updatedAt: startedAt,
    currentRun: null
  });

  try {
    const report = await benchmark.runAnswerStrategyBenchmark({
      questions,
      source,
      rounds: options.rounds,
      seed: options.seed,
      remote: true,
      onRunStart: async ({ completedRuns, totalRuns, run, runs }) => {
        const runStartedAt = new Date().toISOString();
        activeRun = {
          run_id: run.runId,
          question_id: run.questionId,
          category: run.category,
          round: run.round,
          answer_mode: run.answerMode,
          execution_order: run.executionOrder,
          started_at: runStartedAt
        };
        await benchmark.appendAnswerStrategyBenchmarkProgress(progressPaths.progressPath, {
          event: "run_started",
          at: runStartedAt,
          completed_runs: completedRuns,
          total_runs: totalRuns,
          run_id: run.runId,
          question_id: run.questionId,
          category: run.category,
          round: run.round,
          answer_mode: run.answerMode,
          execution_order: run.executionOrder
        });
        await benchmark.writeAnswerStrategyBenchmarkPartialReport({
          partialReportPath: progressPaths.partialReportPath,
          report: latestReport,
          completedRuns,
          totalRuns,
          status: "running",
          updatedAt: runStartedAt,
          currentRun: activeRun
        });
        if (runs.length !== completedRuns) {
          throw new Error("Answer strategy benchmark progress state is inconsistent");
        }
      },
      onProgress: async ({ completedRuns, totalRuns, run, runs }) => {
        const updatedAt = new Date().toISOString();
        activeRun = null;
        await benchmark.appendAnswerStrategyBenchmarkProgress(progressPaths.progressPath, {
          event: "run_completed",
          at: updatedAt,
          completed_runs: completedRuns,
          total_runs: totalRuns,
          question_id: run.question_id,
          category: run.category,
          round: run.round,
          answer_mode: run.answer_mode,
          execution_order: run.execution_order,
          status: run.status,
          total_latency_ms: run.total_latency_ms,
          generation_latency_ms: run.generation_latency_ms,
          evidence_count: run.evidence_count,
          citation_count: run.citation_count,
          fallback_status: run.fallback_status
        });
        latestReport = benchmark.buildAnswerStrategyBenchmarkReport({
          questions,
          source,
          rounds: options.rounds,
          seed: options.seed,
          remote: true,
          schedule,
          runs: [...runs],
          generatedAt: updatedAt
        });
        await benchmark.writeAnswerStrategyBenchmarkPartialReport({
          partialReportPath: progressPaths.partialReportPath,
          report: latestReport,
          completedRuns,
          totalRuns,
          status: "running",
          updatedAt,
          currentRun: null
        });
        if (completedRuns === 1 || completedRuns % 10 === 0 || completedRuns === totalRuns) {
          console.info(`[answer-strategy-ab] progress=${completedRuns}/${totalRuns}`);
        }
      }
    });
    latestReport = report;
    const sourceAfter = await benchmark.loadLongRecording60mBenchmarkSource({
      dataDir: options.dataDir,
      userId: options.userId,
      uploadId: options.uploadId
    });
    if (sourceAfter.contextDigest !== source.contextDigest) {
      throw new Error("Retained source context changed during answer strategy benchmark");
    }
    await benchmark.writeAnswerStrategyBenchmarkReport(
      options.reportPath,
      report,
      options.dataDir
    );
    await benchmark.writeAnswerStrategyBenchmarkMarkdown(options.docsPath, report);
    const completedAt = new Date().toISOString();
    await benchmark.writeAnswerStrategyBenchmarkPartialReport({
      partialReportPath: progressPaths.partialReportPath,
      report,
      completedRuns: report.runs.length,
      totalRuns: plannedRuns,
      status: "completed",
      updatedAt: completedAt,
      currentRun: null
    });
    const failedRuns = report.runs.filter((run) => run.status === "failed").length;
    const fallbackRuns = report.runs.filter(
      (run) => run.status === "completed" && run.fallback_status !== "none"
    ).length;
    const citationViolationRuns = report.runs.filter(
      (run) => run.citation_validation_passed === false
    ).length;
    await benchmark.appendAnswerStrategyBenchmarkProgress(progressPaths.progressPath, {
      event: "benchmark_completed",
      at: completedAt,
      completed_runs: report.runs.length,
      total_runs: plannedRuns,
      failed_runs: failedRuns,
      fallback_runs: fallbackRuns,
      citation_violation_runs: citationViolationRuns
    });
    console.info(JSON.stringify({
      ok: true,
      mode: "remote",
      questions: questions.length,
      rounds: options.rounds,
      runs: report.runs.length,
      reportPath: options.reportPath,
      docsPath: options.docsPath,
      progressPath: progressPaths.progressPath,
      partialReportPath: progressPaths.partialReportPath,
      validPairs: report.pairIntegrity.validPairs,
      evidenceMismatchPairs: report.pairIntegrity.evidenceMismatchPairs,
      failedRuns,
      fallbackRuns,
      citationViolationRuns
    }, null, 2));
  } catch (error) {
    const failedAt = new Date().toISOString();
    const identity = errorIdentity(error);
    await Promise.allSettled([
      benchmark.appendAnswerStrategyBenchmarkProgress(progressPaths.progressPath, {
        event: "benchmark_failed",
        at: failedAt,
        completed_runs: latestReport.runs.length,
        total_runs: plannedRuns,
        ...identity
      }),
      benchmark.writeAnswerStrategyBenchmarkPartialReport({
        partialReportPath: progressPaths.partialReportPath,
        report: latestReport,
        completedRuns: latestReport.runs.length,
        totalRuns: plannedRuns,
        status: "failed",
        updatedAt: failedAt,
        currentRun: activeRun,
        error: identity
      })
    ]);
    throw error;
  }
}

main().catch((error) => {
  console.error(`[answer-strategy-ab] failed: ${JSON.stringify(errorIdentity(error))}`);
  process.exitCode = 1;
});
