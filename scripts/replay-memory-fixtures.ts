import { resolve } from "node:path";

import { assertFixtureReplayEnvironment, replayMemoryFixtures } from "@/lib/server/fixture-replay/replay";

type CliOptions = {
  datasetPath: string;
  userId: string;
  fromDay?: number;
  toDay?: number;
  resetUser: boolean;
  reportPath?: string;
  dataRoot?: string;
  memoryDatabasePath?: string;
  failFast: boolean;
};

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseReplayFixtureArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = { resetUser: false, failFast: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reset-user") {
      options.resetUser = true;
      continue;
    }
    if (arg === "--fail-fast") {
      options.failFast = true;
      continue;
    }
    const value = requiredValue(argv, index, arg);
    index += 1;
    if (arg === "--dataset") options.datasetPath = value;
    else if (arg === "--user") options.userId = value;
    else if (arg === "--from-day") options.fromDay = Number.parseInt(value, 10);
    else if (arg === "--to-day") options.toDay = Number.parseInt(value, 10);
    else if (arg === "--report") options.reportPath = value;
    else if (arg === "--data-root") options.dataRoot = value;
    else if (arg === "--memory-db") options.memoryDatabasePath = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.datasetPath) throw new Error("--dataset is required");
  if (!options.userId) throw new Error("--user is required");
  return options as CliOptions;
}

async function main() {
  assertFixtureReplayEnvironment(process.env.NODE_ENV);
  const options = parseReplayFixtureArgs(process.argv.slice(2));
  const result = await replayMemoryFixtures({
    datasetPath: resolve(options.datasetPath),
    userId: options.userId,
    fromDay: options.fromDay,
    toDay: options.toDay,
    resetUser: options.resetUser,
    reportPath: options.reportPath ? resolve(options.reportPath) : undefined,
    dataRoot: options.dataRoot ? resolve(options.dataRoot) : undefined,
    memoryDatabasePath: options.memoryDatabasePath ? resolve(options.memoryDatabasePath) : undefined,
    failFast: options.failFast
  });
  console.log(JSON.stringify({
    pass: result.report.pass,
    reportPath: result.reportPath,
    deterministicDigest: result.report.deterministicDigest,
    memoryItems: result.report.finalMemoryItems.length,
    evidence: result.report.memoryEvidence.length,
    relations: result.report.relations.length,
    warnings: result.report.warnings
  }, null, 2));
  if (!result.report.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[fixture-replay] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
