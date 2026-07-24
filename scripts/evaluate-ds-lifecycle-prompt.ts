import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import type {
  QaProviderModelExecution,
  QaProviderModelRuntime
} from "@/lib/server/evaluation/qa-provider-model-benchmark";

loadRuntimeEnv();

type CliOptions = {
  datasetPath: string;
  dataDir: string;
  userId: string;
  uploadId: string;
  outputDir: string;
  referenceReport?: string;
  remote: boolean;
  worker: boolean;
  workerVariant?: "current" | "lifecycle_enhanced";
  workerResultPath?: string;
};

type DsRuntimeWithCredentials = QaProviderModelRuntime & {
  alias: "ds-v4";
  apiKey: string;
  baseUrl?: string;
};

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

function nonEmpty(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value.trim();
}

function parseArgs(argv: string[]): CliOptions {
  let datasetPath = "benchmark/qa-provider-model/long-recording-60m.json";
  let dataDir = ".data/evaluation/long-recording-60m-v1/runtime";
  let userId = "";
  let uploadId = "";
  let outputDir = ".data/evaluation/ds-v4-q034-prompt-adaptation-v1";
  let referenceReport: string | undefined;
  let remote = false;
  let worker = false;
  let workerVariant: CliOptions["workerVariant"];
  let workerResultPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--remote") {
      remote = true;
      continue;
    }
    if (argument === "--worker") {
      worker = true;
      continue;
    }
    if (![
      "--dataset",
      "--data-dir",
      "--user-id",
      "--upload-id",
      "--output-dir",
      "--reference-report",
      "--worker-variant",
      "--worker-result"
    ].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--dataset") datasetPath = value;
    else if (argument === "--data-dir") dataDir = value;
    else if (argument === "--user-id") userId = value;
    else if (argument === "--upload-id") uploadId = value;
    else if (argument === "--output-dir") outputDir = value;
    else if (argument === "--reference-report") referenceReport = value;
    else if (argument === "--worker-variant") {
      if (value !== "current" && value !== "lifecycle_enhanced") {
        throw new Error("--worker-variant must be current or lifecycle_enhanced");
      }
      workerVariant = value;
    } else if (argument === "--worker-result") workerResultPath = value;
  }

  if (!STORE_KEY_PATTERN.test(userId)) {
    throw new Error("--user-id is required and must be a safe store key");
  }
  if (!STORE_KEY_PATTERN.test(uploadId)) {
    throw new Error("--upload-id is required and must be a safe store key");
  }
  if (worker && (!workerVariant || !workerResultPath)) {
    throw new Error("Worker mode requires --worker-variant and --worker-result");
  }
  return {
    datasetPath: resolve(datasetPath),
    dataDir: resolve(dataDir),
    userId,
    uploadId,
    outputDir: resolve(outputDir),
    ...(referenceReport ? { referenceReport: resolve(referenceReport) } : {}),
    remote,
    worker,
    ...(workerVariant ? { workerVariant } : {}),
    ...(workerResultPath ? { workerResultPath: resolve(workerResultPath) } : {})
  };
}

function sdkRetries(environment: NodeJS.ProcessEnv) {
  const value = Number.parseInt(environment.OPENAI_MAX_RETRIES ?? "2", 10);
  return Number.isInteger(value) && value >= 0 ? value : 2;
}

function resolveDsRuntime(environment: NodeJS.ProcessEnv): DsRuntimeWithCredentials {
  const apiKey = nonEmpty(environment.DEEPSEEK_API_KEY);
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required for the real DS prompt experiment");
  }
  return {
    alias: "ds-v4",
    modelId:
      nonEmpty(environment.QA_PROVIDER_BENCHMARK_DS_MODEL) ??
      nonEmpty(environment.DEEPSEEK_MODEL) ??
      "deepseek-v4-flash",
    wireApi: "chat",
    route: "configured_deepseek",
    sdkMaxRetries: sdkRetries(environment),
    apiKey,
    ...(nonEmpty(environment.DEEPSEEK_BASE_URL)
      ? { baseUrl: nonEmpty(environment.DEEPSEEK_BASE_URL) }
      : {})
  };
}

function safeRuntime(runtime: DsRuntimeWithCredentials): QaProviderModelRuntime {
  const { apiKey: _apiKey, baseUrl: _baseUrl, ...safe } = runtime;
  return safe;
}

function workerEnvironment(
  runtime: DsRuntimeWithCredentials,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...base,
    DS_LIFECYCLE_PROMPT_EXPERIMENT_WORKER: "1",
    OPENAI_API_KEY: runtime.apiKey,
    OPENAI_BASE_URL: runtime.baseUrl ?? "",
    OPENAI_QA_MODEL: runtime.modelId,
    OPENAI_QA_WIRE_API: runtime.wireApi,
    OPENAI_WIRE_API: runtime.wireApi,
    OPENROUTER_API_KEY: "",
    OPENROUTER_BASE_URL: ""
  };
}

async function assertOutputsAbsent(paths: string[]) {
  for (const path of paths) {
    try {
      await access(path);
      throw new Error(`Refusing to overwrite existing experiment output: ${path}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

async function appendProgress(path: string, event: Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

async function referenceEvidenceDigest(path: string | undefined) {
  if (!path) return undefined;
  const report = JSON.parse(await readFile(path, "utf8")) as {
    runs?: Array<{
      question_id?: unknown;
      model_alias?: unknown;
      status?: unknown;
      evidence_digest?: unknown;
    }>;
  };
  const digests = new Set(
    (report.runs ?? []).flatMap((run) =>
      run.question_id === "q034" &&
      run.model_alias === "ds-v4" &&
      run.status === "completed" &&
      typeof run.evidence_digest === "string"
        ? [run.evidence_digest]
        : []
    )
  );
  if (digests.size !== 1) {
    throw new Error("Reference report does not contain one stable q034 DS Evidence digest");
  }
  return [...digests][0];
}

async function runWorkerProcess(input: {
  options: CliOptions;
  runtime: DsRuntimeWithCredentials;
  variant: "current" | "lifecycle_enhanced";
}) {
  const workDir = resolve(input.options.outputDir, ".work");
  await mkdir(workDir, { recursive: true });
  const resultPath = resolve(workDir, `${randomUUID()}.json`);
  const scriptPath = fileURLToPath(import.meta.url);
  const args = [
    "--import",
    "tsx",
    scriptPath,
    "--worker",
    "--dataset",
    input.options.datasetPath,
    "--data-dir",
    input.options.dataDir,
    "--user-id",
    input.options.userId,
    "--upload-id",
    input.options.uploadId,
    "--output-dir",
    input.options.outputDir,
    "--worker-variant",
    input.variant,
    "--worker-result",
    resultPath
  ];
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: workerEnvironment(input.runtime, process.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => process.stdout.write(chunk));
      child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolvePromise();
        else reject(
          new Error(`DS lifecycle prompt worker exited with code ${code ?? "unknown"}`)
        );
      });
    });
    return JSON.parse(
      await readFile(resultPath, "utf8")
    ) as QaProviderModelExecution;
  } finally {
    await rm(resultPath, { force: true });
  }
}

async function workerMain(options: CliOptions) {
  if (process.env.DS_LIFECYCLE_PROMPT_EXPERIMENT_WORKER !== "1") {
    throw new Error("Worker mode is restricted to the experiment parent");
  }
  const benchmark = await import(
    "@/lib/server/evaluation/qa-provider-model-benchmark"
  );
  const experiment = await import(
    "@/lib/server/evaluation/ds-lifecycle-prompt-experiment"
  );
  const dataset = await benchmark.loadQaProviderModelDataset(options.datasetPath);
  const question = dataset.questions.find((item) => item.id === "q034");
  if (!question) throw new Error("q034 was not found in the benchmark dataset");
  const source = await benchmark.loadLongRecording60mBenchmarkSource({
    dataDir: options.dataDir,
    userId: options.userId,
    uploadId: options.uploadId
  });
  const runtime: QaProviderModelRuntime = {
    alias: "ds-v4",
    modelId: process.env.OPENAI_QA_MODEL!,
    wireApi: "chat",
    route: "configured_deepseek",
    sdkMaxRetries: sdkRetries(process.env)
  };
  const execution = await benchmark.executeQaProviderModelQuestion({
    source,
    question,
    runtime,
    ...(options.workerVariant === "lifecycle_enhanced"
      ? { systemPromptAppend: experiment.DS_LIFECYCLE_PROMPT_RULES }
      : {})
  });
  await mkdir(dirname(options.workerResultPath!), { recursive: true });
  await writeFile(
    options.workerResultPath!,
    `${JSON.stringify(execution)}\n`,
    "utf8"
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.worker) {
    await workerMain(options);
    return;
  }

  const benchmark = await import(
    "@/lib/server/evaluation/qa-provider-model-benchmark"
  );
  const experiment = await import(
    "@/lib/server/evaluation/ds-lifecycle-prompt-experiment"
  );
  const dataset = await benchmark.loadQaProviderModelDataset(options.datasetPath);
  const question = dataset.questions.find((item) => item.id === "q034");
  if (!question) throw new Error("q034 was not found in the benchmark dataset");
  const source = await benchmark.loadLongRecording60mBenchmarkSource({
    dataDir: options.dataDir,
    userId: options.userId,
    uploadId: options.uploadId
  });
  const basePromptInstruction =
    await benchmark.resolveQaProviderModelBasePromptInstruction(source);
  const schedule = experiment.createDsLifecyclePromptSchedule();

  if (!options.remote) {
    console.info(JSON.stringify({
      ok: true,
      mode: "plan_only",
      question_id: question.id,
      planned_requests: schedule.length,
      order: schedule,
      context_digest: source.contextDigest,
      base_prompt_instruction_digest:
        experiment.stableExperimentDigest(basePromptInstruction),
      remote_calls: 0
    }, null, 2));
    return;
  }
  if (process.env.RUN_DS_LIFECYCLE_PROMPT_REMOTE_VERIFY !== "1") {
    throw new Error(
      "Remote execution requires --remote and RUN_DS_LIFECYCLE_PROMPT_REMOTE_VERIFY=1"
    );
  }

  const configuredRuntime = resolveDsRuntime(process.env);
  const runtime = safeRuntime(configuredRuntime);
  const referenceDigest = await referenceEvidenceDigest(options.referenceReport);
  const reportPath = resolve(options.outputDir, "report.json");
  const markdownPath = resolve(options.outputDir, "report.md");
  const progressPath = resolve(options.outputDir, "progress.jsonl");
  const partialPath = resolve(options.outputDir, "partial.json");
  await assertOutputsAbsent([reportPath, markdownPath, progressPath, partialPath]);
  await mkdir(options.outputDir, { recursive: true });
  await appendProgress(progressPath, {
    event: "experiment_started",
    at: new Date().toISOString(),
    completed_runs: 0,
    total_runs: schedule.length,
    question_id: "q034",
    context_digest: source.contextDigest,
    reference_evidence_digest: referenceDigest ?? null
  });

  const runs: import(
    "@/lib/server/evaluation/ds-lifecycle-prompt-experiment"
  ).DsLifecyclePromptRun[] = [];
  for (const entry of schedule) {
    let run: import(
      "@/lib/server/evaluation/ds-lifecycle-prompt-experiment"
    ).DsLifecyclePromptRun;
    try {
      const execution = await runWorkerProcess({
        options,
        runtime: configuredRuntime,
        variant: entry.variant
      });
      run = experiment.completedDsLifecyclePromptRun({
        schedule: entry,
        question,
        execution
      });
    } catch (error) {
      run = experiment.failedDsLifecyclePromptRun({
        schedule: entry,
        runtime,
        error
      });
    }
    runs.push(run);
    await appendProgress(progressPath, {
      event: "run_completed",
      at: new Date().toISOString(),
      completed_runs: runs.length,
      total_runs: schedule.length,
      round: run.round,
      execution_order: run.execution_order,
      prompt_variant: run.prompt_variant,
      status: run.status,
      evidence_digest: run.evidence_digest,
      citation_valid: run.citation_valid,
      lifecycle_correct: run.lifecycle_correct,
      fallback_status: run.fallback_status,
      ttft_ms: run.ttft_ms,
      generation_latency_ms: run.generation_latency_ms,
      total_latency_ms: run.total_latency_ms
    });
    const partial = experiment.buildDsLifecyclePromptExperimentReport({
      question,
      contextDigest: source.contextDigest,
      memoryContextDigest: source.memoryContextDigest,
      contextUnchanged: true,
      runtime,
      basePromptInstruction,
      ...(referenceDigest ? { referenceEvidenceDigest: referenceDigest } : {}),
      schedule,
      runs: [...runs]
    });
    await experiment.writeDsLifecyclePromptExperimentJson(partialPath, partial);
    console.info(
      `[ds-lifecycle-prompt] progress=${runs.length}/${schedule.length} ` +
      `round=${run.round} variant=${run.prompt_variant} status=${run.status}`
    );
  }

  const sourceAfter = await benchmark.loadLongRecording60mBenchmarkSource({
    dataDir: options.dataDir,
    userId: options.userId,
    uploadId: options.uploadId
  });
  const contextUnchanged =
    sourceAfter.contextDigest === source.contextDigest &&
    sourceAfter.memoryContextDigest === source.memoryContextDigest;
  const report = experiment.buildDsLifecyclePromptExperimentReport({
    question,
    contextDigest: source.contextDigest,
    memoryContextDigest: source.memoryContextDigest,
    contextUnchanged,
    runtime,
    basePromptInstruction,
    ...(referenceDigest ? { referenceEvidenceDigest: referenceDigest } : {}),
    schedule,
    runs
  });
  await experiment.writeDsLifecyclePromptExperimentJson(reportPath, report);
  await experiment.writeDsLifecyclePromptExperimentMarkdown(markdownPath, report);
  await experiment.writeDsLifecyclePromptExperimentJson(partialPath, report);
  await appendProgress(progressPath, {
    event: "experiment_completed",
    at: new Date().toISOString(),
    completed_runs: report.integrity.completed_runs,
    total_runs: schedule.length,
    integrity_valid: report.integrity.valid,
    interpretation_signal: report.interpretation_signal
  });
  await rm(resolve(options.outputDir, ".work"), {
    recursive: true,
    force: true
  });
  console.info(JSON.stringify({
    ok: report.integrity.valid,
    report_path: reportPath,
    markdown_path: markdownPath,
    progress_path: progressPath,
    integrity: report.integrity,
    interpretation_signal: report.interpretation_signal
  }, null, 2));
  if (!report.integrity.valid) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    `[ds-lifecycle-prompt] failed error_name=${
      error instanceof Error ? error.name : "unknown"
    } error_message=${JSON.stringify(error instanceof Error ? error.message : "unknown")}`
  );
  process.exitCode = 1;
});
