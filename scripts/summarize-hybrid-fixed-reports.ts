import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  parseFixedHybridReport,
  summarizeFixedHybridReportPair
} from "@/lib/server/retrieval/hybrid/holdout-report-summary";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadReport(path: string) {
  const text = await readFile(path, "utf8");
  return {
    report: parseFixedHybridReport(JSON.parse(text)),
    rawSha256: sha256(text)
  };
}

async function main() {
  const runAPath = resolve(
    argument("--run-a") ??
      ".data/evaluation/memory-long-regression/" +
      "hybrid-retrieval-phase31-phase5-final-fixed-run1-20260729.json"
  );
  const runBPath = resolve(
    argument("--run-b") ??
      ".data/evaluation/memory-long-regression/" +
      "hybrid-retrieval-phase31-phase5-final-fixed-run2-20260729.json"
  );
  const outputPath = resolve(
    argument("--output") ??
      ".data/evaluation/memory-long-regression/" +
      "hybrid-fixed-report-summary-20260729.json"
  );
  const seed = Number(argument("--seed") ?? 31_415_926);
  const iterations = Number(argument("--iterations") ?? 10_000);

  console.log(`[fixed-report-summary] progress=0/4 stage=load_run_a`);
  const runA = await loadReport(runAPath);
  console.log(`[fixed-report-summary] progress=1/4 stage=load_run_b`);
  const runB = await loadReport(runBPath);
  console.log(`[fixed-report-summary] progress=2/4 stage=compare_and_bootstrap`);
  const summary = summarizeFixedHybridReportPair({
    runA: runA.report,
    runB: runB.report,
    runAPath,
    runBPath,
    runARawSha256: runA.rawSha256,
    runBRawSha256: runB.rawSha256,
    bootstrapSeed: seed,
    bootstrapIterations: iterations
  });
  console.log(`[fixed-report-summary] progress=3/4 stage=write_report`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(
    `[fixed-report-summary] progress=4/4 stage=completed report=${outputPath}`
  );
  console.log(JSON.stringify({
    determinism: summary.determinism,
    bootstrap: summary.bootstrap,
    movementSummary: summary.movementSummary
  }, null, 2));
}

main().catch((error) => {
  console.error(
    `[fixed-report-summary] failed error_name=${
      error instanceof Error ? error.name : "unknown"
    } message=${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
