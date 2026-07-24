import { access, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import {
  appendCompactEvidenceAbProgress,
  buildCompactEvidenceAbReport,
  compactEvidenceAbScheduleDigest,
  createCompactEvidenceAbSchedule,
  loadCompactEvidenceAbDataset,
  loadLongRecording60mBenchmarkSource,
  resolveCompactEvidenceAbRuntime,
  runCompactEvidenceAb,
  writeCompactEvidenceAbMarkdown,
  writeCompactEvidenceAbPartial,
  writeCompactEvidenceAbReport,
  type CompactEvidenceAbReport
} from "@/lib/server/evaluation/compact-evidence-ab";

loadRuntimeEnv();

type CliOptions = {
  datasetPath: string;
  dataDir: string;
  userId: string;
  uploadId: string;
  rounds: number;
  seed: string;
  outputDir: string;
  docsPath: string;
  remote: boolean;
  rescoreExisting: boolean;
};

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value.trim();
}

export function parseCompactEvidenceBenchmarkArgs(argv: string[]): CliOptions {
  let datasetPath = "benchmark/evidence-compression/long-recording-60m.json";
  let dataDir = ".data/evaluation/long-recording-60m-v1/runtime";
  let userId = "";
  let uploadId = "";
  let rounds = 3;
  let seed = "long-recording-60m-compact-evidence-ab-v1";
  let outputDir = ".data/evaluation/compact-evidence-ab-v1";
  let docsPath = "docs/compact-evidence-ab-results.md";
  let remote = false;
  let rescoreExisting = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--remote") {
      remote = true;
      continue;
    }
    if (argument === "--rescore-existing") {
      rescoreExisting = true;
      continue;
    }
    if (
      ![
        "--dataset",
        "--data-dir",
        "--user-id",
        "--upload-id",
        "--rounds",
        "--seed",
        "--output-dir",
        "--docs"
      ].includes(argument)
    ) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--dataset") datasetPath = value;
    else if (argument === "--data-dir") dataDir = value;
    else if (argument === "--user-id") userId = value;
    else if (argument === "--upload-id") uploadId = value;
    else if (argument === "--rounds") rounds = Number(value);
    else if (argument === "--seed") seed = value;
    else if (argument === "--output-dir") outputDir = value;
    else docsPath = value;
  }

  if (!STORE_KEY_PATTERN.test(userId)) {
    throw new Error("--user-id is required and must be a safe store key");
  }
  if (!STORE_KEY_PATTERN.test(uploadId)) {
    throw new Error("--upload-id is required and must be a safe store key");
  }
  if (!Number.isInteger(rounds) || rounds < 2 || rounds > 20) {
    throw new Error("--rounds must be an integer between 2 and 20");
  }
  if (!seed.trim() || seed.length > 200) {
    throw new Error("--seed must be between 1 and 200 characters");
  }
  if (remote && rescoreExisting) {
    throw new Error("--remote and --rescore-existing cannot be combined");
  }

  return {
    datasetPath: resolve(datasetPath),
    dataDir: resolve(dataDir),
    userId,
    uploadId,
    rounds,
    seed,
    outputDir: resolve(outputDir),
    docsPath: resolve(docsPath),
    remote,
    rescoreExisting
  };
}

async function assertAbsent(paths: string[]) {
  for (const path of paths) {
    try {
      await access(path);
      throw new Error(`Refusing to overwrite existing benchmark output: ${path}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(value)
    ? value
    : null;
}

async function main() {
  const options = parseCompactEvidenceBenchmarkArgs(process.argv.slice(2));
  const dataset = await loadCompactEvidenceAbDataset(options.datasetPath);
  const source = await loadLongRecording60mBenchmarkSource({
    dataDir: options.dataDir,
    userId: options.userId,
    uploadId: options.uploadId
  });
  const runtime = await resolveCompactEvidenceAbRuntime({ source });
  const schedule = createCompactEvidenceAbSchedule(
    dataset.questions,
    options.rounds,
    options.seed
  );
  const totalRuns = schedule.length * 2;
  const reportPath = resolve(options.outputDir, "report.json");
  const markdownPath = resolve(options.outputDir, "report.md");
  const progressPath = resolve(options.outputDir, "progress.jsonl");
  const partialPath = resolve(options.outputDir, "partial.json");

  if (options.rescoreExisting) {
    const existing = JSON.parse(
      await readFile(reportPath, "utf8")
    ) as CompactEvidenceAbReport;
    const expectedScheduleDigest = compactEvidenceAbScheduleDigest(schedule);
    if (
      existing.version !== 1 ||
      existing.execution.rounds !== options.rounds ||
      existing.execution.seed !== options.seed ||
      existing.execution.scheduleDigest !== expectedScheduleDigest ||
      existing.source.contextDigest !== source.contextDigest ||
      existing.runtime.provider !== runtime.provider ||
      existing.runtime.modelId !== runtime.modelId ||
      existing.runtime.wireApi !== runtime.wireApi ||
      existing.runs.length !== totalRuns
    ) {
      throw new Error(
        "Existing Compact Evidence report does not match the requested dataset, source, runtime, or schedule"
      );
    }
    const report = buildCompactEvidenceAbReport({
      questions: dataset.questions,
      source,
      runtime,
      schedule,
      rounds: options.rounds,
      seed: options.seed,
      runs: existing.runs,
      remote: existing.execution.remote
    });
    await writeCompactEvidenceAbReport(reportPath, report);
    await writeCompactEvidenceAbMarkdown(markdownPath, report);
    await writeCompactEvidenceAbMarkdown(options.docsPath, report);
    await writeCompactEvidenceAbPartial({
      path: partialPath,
      status: "completed",
      report,
      completedRuns: report.runs.length,
      totalRuns
    });
    await appendCompactEvidenceAbProgress(progressPath, {
      event: "benchmark_rescored",
      at: new Date().toISOString(),
      completed_runs: report.runs.length,
      total_runs: totalRuns,
      quality_regression_pairs: report.comparison.qualityRegressionPairs,
      recommendation: report.productionGray.recommendation
    });
    console.info(
      JSON.stringify(
        {
          mode: "rescore_existing",
          remote_calls: 0,
          report_path: reportPath,
          markdown_path: markdownPath,
          docs_path: options.docsPath,
          completed_runs: report.runs.length,
          recommendation: report.productionGray.recommendation
        },
        null,
        2
      )
    );
    return;
  }

  if (!options.remote) {
    console.info(
      JSON.stringify(
        {
          mode: "plan_only",
          dataset: dataset.datasetVersion,
          questions: dataset.questions.map((question) => question.id),
          rounds: options.rounds,
          total_runs: totalRuns,
          model: runtime.modelId,
          provider: runtime.provider,
          schedule_digest: compactEvidenceAbScheduleDigest(schedule)
        },
        null,
        2
      )
    );
    return;
  }
  if (process.env.RUN_COMPACT_EVIDENCE_AB_REMOTE_VERIFY !== "1") {
    throw new Error(
      "Remote Compact Evidence A/B requires --remote and RUN_COMPACT_EVIDENCE_AB_REMOTE_VERIFY=1"
    );
  }

  await assertAbsent([
    reportPath,
    markdownPath,
    progressPath,
    partialPath,
    options.docsPath
  ]);
  await mkdir(options.outputDir, { recursive: true });

  const emptyReport = buildCompactEvidenceAbReport({
    questions: dataset.questions,
    source,
    runtime,
    schedule,
    rounds: options.rounds,
    seed: options.seed,
    runs: [],
    remote: true
  });
  await appendCompactEvidenceAbProgress(progressPath, {
    event: "benchmark_started",
    at: new Date().toISOString(),
    completed_runs: 0,
    total_runs: totalRuns,
    question_count: dataset.questions.length,
    rounds: options.rounds,
    model: runtime.modelId,
    provider: runtime.provider
  });
  await writeCompactEvidenceAbPartial({
    path: partialPath,
    status: "running",
    report: emptyReport,
    completedRuns: 0,
    totalRuns
  });

  let latestRuns = emptyReport.runs;
  let currentRun: Record<string, unknown> | null = null;
  try {
    const report = await runCompactEvidenceAb({
      questions: dataset.questions,
      source,
      runtime,
      rounds: options.rounds,
      seed: options.seed,
      remote: true,
      onRunStart: async ({
        completedRuns,
        pair,
        view,
        order,
        runs
      }) => {
        latestRuns = [...runs];
        currentRun = {
          run_id: `${pair.pairId}-${view}`,
          pair_id: pair.pairId,
          question_id: pair.question.id,
          category: pair.question.category,
          round: pair.round,
          evidence_view: view,
          execution_order: order,
          started_at: new Date().toISOString()
        };
        await appendCompactEvidenceAbProgress(progressPath, {
          event: "run_started",
          at: new Date().toISOString(),
          completed_runs: completedRuns,
          total_runs: totalRuns,
          ...currentRun
        });
        const partialReport = buildCompactEvidenceAbReport({
          questions: dataset.questions,
          source,
          runtime,
          schedule,
          rounds: options.rounds,
          seed: options.seed,
          runs: [...runs],
          remote: true
        });
        await writeCompactEvidenceAbPartial({
          path: partialPath,
          status: "running",
          report: partialReport,
          completedRuns,
          totalRuns,
          currentRun
        });
      },
      onProgress: async ({ completedRuns, run, runs }) => {
        latestRuns = [...runs];
        currentRun = null;
        await appendCompactEvidenceAbProgress(progressPath, {
          event: "run_completed",
          at: new Date().toISOString(),
          completed_runs: completedRuns,
          total_runs: totalRuns,
          run_id: run.run_id,
          question_id: run.question_id,
          category: run.category,
          round: run.round,
          evidence_view: run.evidence_view,
          execution_order: run.execution_order,
          status: run.status,
          input_chars: run.input_chars,
          ttft_ms: run.ttft_ms,
          generation_latency_ms: run.generation_latency_ms,
          total_latency_ms: run.total_latency_ms,
          fallback_status: run.fallback_status,
          streaming_outcome: run.streaming_outcome,
          quality_pass: run.quality?.finalQualityPass ?? null
        });
        const partialReport = buildCompactEvidenceAbReport({
          questions: dataset.questions,
          source,
          runtime,
          schedule,
          rounds: options.rounds,
          seed: options.seed,
          runs: [...runs],
          remote: true
        });
        await writeCompactEvidenceAbPartial({
          path: partialPath,
          status: "running",
          report: partialReport,
          completedRuns,
          totalRuns
        });
        console.info(
          `[compact-evidence-ab] progress=${completedRuns}/${totalRuns} ` +
            `question=${run.question_id} view=${run.evidence_view} ` +
            `status=${run.status} ttft_ms=${run.ttft_ms ?? "N/A"} ` +
            `generation_ms=${run.generation_latency_ms ?? "N/A"} ` +
            `quality=${run.quality?.finalQualityPass ?? false} ` +
            `streaming=${run.streaming_outcome}`
        );
      }
    });
    const sourceAfter = await loadLongRecording60mBenchmarkSource({
      dataDir: options.dataDir,
      userId: options.userId,
      uploadId: options.uploadId
    });
    if (sourceAfter.contextDigest !== source.contextDigest) {
      throw new Error(
        "Retained source context changed during Compact Evidence A/B benchmark"
      );
    }

    await writeCompactEvidenceAbReport(reportPath, report);
    await writeCompactEvidenceAbMarkdown(markdownPath, report);
    await writeCompactEvidenceAbMarkdown(options.docsPath, report);
    await writeCompactEvidenceAbPartial({
      path: partialPath,
      status: "completed",
      report,
      completedRuns: report.runs.length,
      totalRuns
    });
    await appendCompactEvidenceAbProgress(progressPath, {
      event: "benchmark_completed",
      at: new Date().toISOString(),
      completed_runs: report.runs.length,
      total_runs: totalRuns,
      failed_runs: report.runs.filter((run) => run.status === "failed").length,
      quality_regression_pairs: report.comparison.qualityRegressionPairs,
      recommendation: report.productionGray.recommendation
    });
    console.info(
      JSON.stringify(
        {
          report_path: reportPath,
          markdown_path: markdownPath,
          docs_path: options.docsPath,
          progress_path: progressPath,
          partial_path: partialPath,
          completed_runs: report.runs.length,
          recommendation: report.productionGray.recommendation
        },
        null,
        2
      )
    );
  } catch (error) {
    const partialReport = buildCompactEvidenceAbReport({
      questions: dataset.questions,
      source,
      runtime,
      schedule,
      rounds: options.rounds,
      seed: options.seed,
      runs: latestRuns,
      remote: true
    });
    await appendCompactEvidenceAbProgress(progressPath, {
      event: "benchmark_failed",
      at: new Date().toISOString(),
      completed_runs: latestRuns.length,
      total_runs: totalRuns,
      error_name: error instanceof Error ? error.name : "unknown",
      error_code: safeErrorCode(error)
    });
    await writeCompactEvidenceAbPartial({
      path: partialPath,
      status: "failed",
      report: partialReport,
      completedRuns: latestRuns.length,
      totalRuns,
      currentRun,
      error: {
        name: error instanceof Error ? error.name : "unknown",
        code: safeErrorCode(error)
      }
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(
    `[compact-evidence-ab] failed error_name=${
      error instanceof Error ? error.name : "unknown"
    } error_code=${safeErrorCode(error) ?? "unknown"}`
  );
  process.exitCode = 1;
});
