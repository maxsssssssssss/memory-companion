import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  runHybridRetrievalBenchmark,
  type HybridBenchmarkSystemMetrics
} from "@/lib/server/retrieval/hybrid/benchmark";
import { SqliteEmbeddingIndex } from "@/lib/server/retrieval/hybrid/embedding-index";
import { qwenEmbeddingProviderFromEnvironment } from "@/lib/server/retrieval/hybrid/qwen-embedding-provider";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function metricRow(system: string, metrics: HybridBenchmarkSystemMetrics) {
  return {
    System: system,
    "Recall@10": percent(metrics.recallAt10),
    "Recall@30": percent(metrics.recallAt30),
    MRR: metrics.mrr.toFixed(3),
    "Citation validity": percent(metrics.citationValidity),
    "Recovered misses": metrics.recoveredRetrievalMisses
  };
}

async function main() {
  const reportPath = resolve(
    argument("--report") ??
      ".data/evaluation/memory-long-regression/retrieval-60-report-20260728.json"
  );
  const outputPath = argument("--output")
    ? resolve(argument("--output")!)
    : undefined;
  const indexPath = resolve(
    argument("--index") ??
      ".data/evaluation/memory-long-regression/hybrid-embedding-sidecar.sqlite"
  );
  const provider = qwenEmbeddingProviderFromEnvironment();
  const index = new SqliteEmbeddingIndex(indexPath, provider.config);
  try {
    const report = await runHybridRetrievalBenchmark({
      reportPath,
      runtimePath: argument("--runtime"),
      provider,
      index,
      batchSize: Number(argument("--batch-size") ?? 16)
    });
    console.table([
      metricRow("Current Retrieval", report.systems.baseline),
      metricRow("Dense", report.systems.dense),
      metricRow("Hybrid", report.systems.hybrid),
      metricRow("Hybrid + Ranking", report.systems.hybridRanking)
    ]);
    console.log(JSON.stringify({
      model: report.model,
      indexing: report.indexing,
      baselineSource: report.baselineSource,
      categories: report.categories
    }, null, 2));
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
      console.log(`[hybrid-benchmark] report=${outputPath}`);
    }
  } finally {
    index.close();
  }
}

main().catch((error) => {
  console.error(
    `[hybrid-benchmark] failed error_name=${error instanceof Error ? error.name : "unknown"} ` +
    `message=${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
