import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  DiarizationRegressionSuiteSchema,
  buildDiarizationBenchmarkReport
} from "@/lib/server/evaluation/diarization-regression";

const DEFAULT_INPUT = resolve(
  "test-data",
  "diarization-regression-v1",
  "fixture.json"
);
const DEFAULT_OUTPUT = resolve(
  ".data",
  "evaluation",
  "diarization-benchmark.json"
);
const EVALUATION_OUTPUT_ROOT = resolve(".data", "evaluation");

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return resolve(value);
}

async function main() {
  const inputPath = argument("--input") ?? DEFAULT_INPUT;
  const outputPath = argument("--output") ?? DEFAULT_OUTPUT;
  const relativeOutputPath = relative(EVALUATION_OUTPUT_ROOT, outputPath);
  if (
    relativeOutputPath === ".." ||
    relativeOutputPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeOutputPath)
  ) {
    throw new Error("--output must stay inside .data/evaluation");
  }
  const suite = DiarizationRegressionSuiteSchema.parse(
    JSON.parse(await readFile(inputPath, "utf8"))
  );
  const report = buildDiarizationBenchmarkReport(suite);
  for (const [index, result] of report.cases.entries()) {
    console.info(
      `[diarization-regression] progress=${index + 1}/${report.cases.length} ` +
      `case=${result.case} result=${result.result}`
    );
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  console.info(
    `[diarization-regression] report=${relative(process.cwd(), outputPath)} ` +
    `passed=${report.summary.passed}/${report.summary.total}`
  );
  if (report.summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    `[diarization-regression] failed error_name=${error instanceof Error ? error.name : "unknown"}`
  );
  process.exitCode = 1;
});
