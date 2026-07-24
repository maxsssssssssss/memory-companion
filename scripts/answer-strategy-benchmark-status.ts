import { setTimeout as delay } from "node:timers/promises";

import {
  parseAnswerStrategyBenchmarkStatusArgs,
  readAnswerStrategyBenchmarkStatus
} from "@/lib/server/evaluation/answer-strategy-ab-status";

async function main() {
  const options = parseAnswerStrategyBenchmarkStatusArgs(process.argv.slice(2));
  do {
    const status = await readAnswerStrategyBenchmarkStatus(options.partialReportPath);
    console.info(`ANSWER_STRATEGY_AB_STATUS: ${JSON.stringify(status ?? {
      status: "waiting_for_first_run",
      completed_runs: 0,
      partial_report: options.partialReportPath
    })}`);
    if (!options.watch || (status && status.status !== "running")) return;
    await delay(options.intervalMs);
  } while (true);
}

main().catch((error) => {
  console.error(`ANSWER_STRATEGY_AB_STATUS: ${JSON.stringify({
    status: "failed",
    error_name: error instanceof Error ? error.name : "unknown"
  })}`);
  process.exitCode = 1;
});
