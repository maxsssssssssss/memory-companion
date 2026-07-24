import { access } from "node:fs/promises";
import { resolve } from "node:path";

export type AnswerStrategyBenchmarkCliOptions = {
  datasetPath: string;
  dataDir: string;
  userId: string;
  uploadId: string;
  rounds: number;
  seed: string;
  reportPath: string;
  docsPath: string;
  remote: boolean;
};

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value.trim();
}

export function parseAnswerStrategyBenchmarkArgs(
  argv: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env
): AnswerStrategyBenchmarkCliOptions {
  let datasetPath = "benchmark/answer-strategy/long-recording-60m.json";
  let dataDir = ".data/evaluation/long-recording-60m-v1/runtime";
  let userId: string | undefined;
  let uploadId: string | undefined;
  let rounds = 3;
  let seed = "long-recording-60m-answer-strategy-ab-v1";
  let reportPath = "reports/long-recording-60m-answer-strategy-ab.json";
  let docsPath = "docs/answer-strategy-ab-results.md";
  let remote = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--remote") {
      remote = true;
      continue;
    }
    if (![
      "--dataset",
      "--data-dir",
      "--user-id",
      "--upload-id",
      "--rounds",
      "--seed",
      "--report",
      "--docs"
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
    else if (argument === "--report") reportPath = value;
    else if (argument === "--docs") docsPath = value;
    else {
      rounds = Number(value);
    }
  }

  if (!userId || !STORE_KEY_PATTERN.test(userId)) {
    throw new Error("--user-id is required and must be a safe store key");
  }
  if (!uploadId || !STORE_KEY_PATTERN.test(uploadId)) {
    throw new Error("--upload-id is required and must be a safe store key");
  }
  if (!Number.isInteger(rounds) || rounds < 3 || rounds > 20) {
    throw new Error("--rounds must be an integer between 3 and 20");
  }
  if (!seed.trim() || seed.length > 200) {
    throw new Error("--seed must be between 1 and 200 characters");
  }
  if (remote && environment.RUN_ANSWER_STRATEGY_AB_REMOTE_VERIFY !== "1") {
    throw new Error(
      "Remote A/B requires --remote and RUN_ANSWER_STRATEGY_AB_REMOTE_VERIFY=1"
    );
  }

  return {
    datasetPath: resolve(datasetPath),
    dataDir: resolve(dataDir),
    userId,
    uploadId,
    rounds,
    seed,
    reportPath: resolve(reportPath),
    docsPath: resolve(docsPath),
    remote
  };
}

export async function assertBenchmarkOutputsAbsent(options: {
  reportPath: string;
  docsPath: string;
  progressPath?: string;
  partialReportPath?: string;
}) {
  for (const target of [
    options.reportPath,
    options.docsPath,
    options.progressPath,
    options.partialReportPath
  ].filter((value): value is string => Boolean(value))) {
    try {
      await access(target);
      throw new Error(`Refusing to overwrite existing benchmark output: ${target}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
}
