import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import type { QaProviderModelExecution } from "@/lib/server/evaluation/qa-provider-model-benchmark";

loadRuntimeEnv();

type CliOptions = {
  datasetPath: string;
  dataDir: string;
  userId: string;
  uploadId: string;
  rounds: number;
  seed: string;
  outputDir: string;
  remote: boolean;
  worker: boolean;
  workerModel?: "gpt-5.5" | "ds-v4";
  workerQuestionId?: string;
  workerResultPath?: string;
};

type SafeRuntime = {
  alias: "gpt-5.5" | "ds-v4";
  modelId: string;
  wireApi: "chat" | "responses";
  route: "configured_openai_compatible" | "configured_deepseek";
  sdkMaxRetries: number;
};

type RuntimeWithCredentials = SafeRuntime & {
  apiKey: string;
  baseUrl?: string;
};

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

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
  let rounds = 3;
  let seed = "long-recording-60m-qa-provider-model-v1";
  let outputDir = ".data/evaluation/qa-provider-model-benchmark-v1";
  let remote = false;
  let worker = false;
  let workerModel: CliOptions["workerModel"];
  let workerQuestionId: string | undefined;
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
      "--rounds",
      "--seed",
      "--output-dir",
      "--worker-model",
      "--worker-question-id",
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
    else if (argument === "--seed") seed = value;
    else if (argument === "--output-dir") outputDir = value;
    else if (argument === "--worker-model") {
      if (value !== "gpt-5.5" && value !== "ds-v4") {
        throw new Error("--worker-model must be gpt-5.5 or ds-v4");
      }
      workerModel = value;
    } else if (argument === "--worker-question-id") workerQuestionId = value;
    else if (argument === "--worker-result") workerResultPath = value;
    else rounds = Number(value);
  }

  if (!STORE_KEY_PATTERN.test(userId)) {
    throw new Error("--user-id is required and must be a safe store key");
  }
  if (!STORE_KEY_PATTERN.test(uploadId)) {
    throw new Error("--upload-id is required and must be a safe store key");
  }
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) {
    throw new Error("--rounds must be an integer between 1 and 20");
  }
  if (!seed.trim() || seed.length > 200) {
    throw new Error("--seed must be between 1 and 200 characters");
  }
  if (worker && (!workerModel || !workerQuestionId || !workerResultPath)) {
    throw new Error("Worker mode requires model, question id, and result path");
  }

  return {
    datasetPath: resolve(datasetPath),
    dataDir: resolve(dataDir),
    userId,
    uploadId,
    rounds,
    seed,
    outputDir: resolve(outputDir),
    remote,
    worker,
    ...(workerModel ? { workerModel } : {}),
    ...(workerQuestionId ? { workerQuestionId } : {}),
    ...(workerResultPath ? { workerResultPath: resolve(workerResultPath) } : {})
  };
}

function nonEmpty(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function wireApi(value: string | undefined, fallback: "chat" | "responses") {
  return value?.trim().toLowerCase() === "responses" ? "responses" : fallback;
}

function sdkRetries(environment: NodeJS.ProcessEnv) {
  const value = Number.parseInt(environment.OPENAI_MAX_RETRIES ?? "2", 10);
  return Number.isInteger(value) && value >= 0 ? value : 2;
}

export function resolveBenchmarkModelRuntimes(
  environment: NodeJS.ProcessEnv
): Record<SafeRuntime["alias"], RuntimeWithCredentials> {
  const gptApiKey = nonEmpty(environment.OPENAI_API_KEY);
  const deepseekApiKey = nonEmpty(environment.DEEPSEEK_API_KEY);
  if (!gptApiKey) throw new Error("OPENAI_API_KEY is required for the GPT benchmark");
  if (!deepseekApiKey) throw new Error("DEEPSEEK_API_KEY is required for the DS v4 benchmark");
  const retries = sdkRetries(environment);
  return {
    "gpt-5.5": {
      alias: "gpt-5.5",
      modelId:
        nonEmpty(environment.QA_PROVIDER_BENCHMARK_GPT_MODEL) ??
        nonEmpty(environment.OPENAI_QA_MODEL) ??
        "gpt-5.5",
      wireApi: wireApi(
        environment.OPENAI_QA_WIRE_API ?? environment.OPENAI_WIRE_API,
        "chat"
      ),
      route: "configured_openai_compatible",
      sdkMaxRetries: retries,
      apiKey: gptApiKey,
      ...(nonEmpty(environment.OPENAI_BASE_URL)
        ? { baseUrl: nonEmpty(environment.OPENAI_BASE_URL) }
        : {})
    },
    "ds-v4": {
      alias: "ds-v4",
      modelId:
        nonEmpty(environment.QA_PROVIDER_BENCHMARK_DS_MODEL) ??
        nonEmpty(environment.DEEPSEEK_MODEL) ??
        "deepseek-v4-flash",
      wireApi: "chat",
      route: "configured_deepseek",
      sdkMaxRetries: retries,
      apiKey: deepseekApiKey,
      ...(nonEmpty(environment.DEEPSEEK_BASE_URL)
        ? { baseUrl: nonEmpty(environment.DEEPSEEK_BASE_URL) }
        : {})
    }
  };
}

function safeRuntime(runtime: RuntimeWithCredentials): SafeRuntime {
  const { apiKey: _apiKey, baseUrl: _baseUrl, ...safe } = runtime;
  return safe;
}

async function assertOutputsAbsent(paths: string[]) {
  for (const path of paths) {
    try {
      await access(path);
      throw new Error(`Refusing to overwrite existing benchmark output: ${path}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
}

function workerEnvironment(
  runtime: RuntimeWithCredentials,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...base,
    QA_PROVIDER_MODEL_BENCHMARK_WORKER: "1",
    OPENAI_API_KEY: runtime.apiKey,
    OPENAI_BASE_URL: runtime.baseUrl ?? "",
    OPENAI_QA_MODEL: runtime.modelId,
    OPENAI_QA_WIRE_API: runtime.wireApi,
    OPENAI_WIRE_API: runtime.wireApi,
    OPENROUTER_API_KEY: "",
    OPENROUTER_BASE_URL: ""
  };
}

async function runWorkerProcess(input: {
  options: CliOptions;
  runtime: RuntimeWithCredentials;
  questionId: string;
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
    "--worker-model",
    input.runtime.alias,
    "--worker-question-id",
    input.questionId,
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
        else reject(new Error(`QA Provider model worker exited with code ${code ?? "unknown"}`));
      });
    });
    return JSON.parse(await readFile(resultPath, "utf8")) as QaProviderModelExecution;
  } finally {
    await rm(resultPath, { force: true });
  }
}

async function workerMain(options: CliOptions) {
  if (process.env.QA_PROVIDER_MODEL_BENCHMARK_WORKER !== "1") {
    throw new Error("QA Provider model worker mode is restricted to the benchmark parent");
  }
  const benchmark = await import("@/lib/server/evaluation/qa-provider-model-benchmark");
  const dataset = await benchmark.loadQaProviderModelDataset(options.datasetPath);
  const question = dataset.questions.find((item) => item.id === options.workerQuestionId);
  if (!question) throw new Error("Worker benchmark question was not found");
  const source = await benchmark.loadLongRecording60mBenchmarkSource({
    dataDir: options.dataDir,
    userId: options.userId,
    uploadId: options.uploadId
  });
  const runtime: SafeRuntime = {
    alias: options.workerModel!,
    modelId: process.env.OPENAI_QA_MODEL!,
    wireApi: process.env.OPENAI_QA_WIRE_API === "responses" ? "responses" : "chat",
    route: options.workerModel === "gpt-5.5"
      ? "configured_openai_compatible"
      : "configured_deepseek",
    sdkMaxRetries: sdkRetries(process.env)
  };
  const result = await benchmark.executeQaProviderModelQuestion({
    source,
    question,
    runtime
  });
  await mkdir(dirname(options.workerResultPath!), { recursive: true });
  await writeFile(options.workerResultPath!, `${JSON.stringify(result)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.worker) {
    await workerMain(options);
    return;
  }

  const benchmark = await import("@/lib/server/evaluation/qa-provider-model-benchmark");
  const dataset = await benchmark.loadQaProviderModelDataset(options.datasetPath);
  const source = await benchmark.loadLongRecording60mBenchmarkSource({
    dataDir: options.dataDir,
    userId: options.userId,
    uploadId: options.uploadId
  });
  const configured = resolveBenchmarkModelRuntimes(process.env);
  const models = {
    "gpt-5.5": safeRuntime(configured["gpt-5.5"]),
    "ds-v4": safeRuntime(configured["ds-v4"])
  };
  const schedule = benchmark.createQaProviderModelSchedule(
    dataset.questions,
    options.rounds,
    options.seed
  );
  if (!options.remote) {
    console.info(JSON.stringify({
      ok: true,
      mode: "plan_only",
      questions: dataset.questions.length,
      rounds: options.rounds,
      plannedRuns: schedule.length * 2,
      models,
      contextDigest: source.contextDigest,
      scheduleDigest: benchmark.stableDigest?.(schedule) ?? null,
      remoteCalls: 0
    }, null, 2));
    return;
  }
  if (process.env.RUN_QA_PROVIDER_MODEL_REMOTE_VERIFY !== "1") {
    throw new Error(
      "Remote model benchmark requires --remote and RUN_QA_PROVIDER_MODEL_REMOTE_VERIFY=1"
    );
  }

  const reportPath = resolve(options.outputDir, "report.json");
  const markdownPath = resolve(options.outputDir, "report.md");
  const progressPath = resolve(options.outputDir, "progress.jsonl");
  const partialPath = resolve(options.outputDir, "partial.json");
  await assertOutputsAbsent([reportPath, markdownPath, progressPath, partialPath]);
  await mkdir(options.outputDir, { recursive: true });
  const startedAt = new Date().toISOString();
  await benchmark.appendQaProviderModelProgress(progressPath, {
    event: "benchmark_started",
    at: startedAt,
    completed_runs: 0,
    total_runs: schedule.length * 2
  });

  const report = await benchmark.runQaProviderModelBenchmark({
    dataset,
    source,
    models,
    rounds: options.rounds,
    seed: options.seed,
    remote: true,
    execute: ({ question, runtime }) =>
      runWorkerProcess({
        options,
        runtime: configured[runtime.alias],
        questionId: question.id
      }),
    onProgress: async ({ completedRuns, totalRuns, run, runs }) => {
      const updatedAt = new Date().toISOString();
      await benchmark.appendQaProviderModelProgress(progressPath, {
        event: "run_completed",
        at: updatedAt,
        completed_runs: completedRuns,
        total_runs: totalRuns,
        question_id: run.question_id,
        model_alias: run.model_alias,
        execution_order: run.execution_order,
        status: run.status,
        ttft_ms: run.ttft_ms,
        generation_latency_ms: run.generation_latency_ms,
        total_latency_ms: run.total_latency_ms,
        citation_valid: run.quality?.citation.finalValid ?? null,
        lifecycle_correct: run.quality?.lifecycle.pass ?? null,
        unsupported_correct: run.quality?.unsupported.pass ?? null,
        fallback_status: run.fallback_status
      });
      const partial = benchmark.buildQaProviderModelBenchmarkReport({
        dataset,
        source,
        models,
        schedule,
        rounds: options.rounds,
        seed: options.seed,
        runs: [...runs],
        remote: true,
        generatedAt: updatedAt
      });
      await benchmark.writeQaProviderModelReport(partialPath, partial);
      console.info(
        `[qa-provider-model-benchmark] progress=${completedRuns}/${totalRuns} ` +
        `question_id=${run.question_id} model=${run.model_alias} status=${run.status}`
      );
    }
  });
  const sourceAfter = await benchmark.loadLongRecording60mBenchmarkSource({
    dataDir: options.dataDir,
    userId: options.userId,
    uploadId: options.uploadId
  });
  if (sourceAfter.contextDigest !== source.contextDigest) {
    throw new Error("Retained source context changed during QA Provider model benchmark");
  }
  await benchmark.writeQaProviderModelReport(reportPath, report);
  await benchmark.writeQaProviderModelMarkdown(markdownPath, report);
  await benchmark.appendQaProviderModelProgress(progressPath, {
    event: "benchmark_completed",
    at: new Date().toISOString(),
    completed_runs: report.runs.length,
    total_runs: report.execution.totalRuns,
    evidence_mismatch_pairs: report.pairIntegrity.evidenceMismatchPairs,
    prompt_mismatch_pairs: report.pairIntegrity.promptSizeMismatchPairs
  });
  await rm(resolve(options.outputDir, ".work"), { recursive: true, force: true });
  console.info(JSON.stringify({
    ok: true,
    questions: report.dataset.questionCount,
    rounds: report.execution.rounds,
    runs: report.runs.length,
    reportPath,
    markdownPath,
    progressPath,
    pairIntegrity: report.pairIntegrity
  }, null, 2));
}

main().catch((error) => {
  console.error(
    `[qa-provider-model-benchmark] failed error_name=${
      error instanceof Error ? error.name : "unknown"
    } error_message=${JSON.stringify(error instanceof Error ? error.message : "unknown")}`
  );
  process.exitCode = 1;
});
