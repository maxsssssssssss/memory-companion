import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { runHybridRetrievalBenchmarkV2 } from "@/lib/server/retrieval/hybrid/benchmark-v2";
import { SqliteEmbeddingIndex } from "@/lib/server/retrieval/hybrid/embedding-index";
import { qwenEmbeddingProviderForPurpose } from "@/lib/server/retrieval/hybrid/runtime-config";
import { qwenRerankerProviderFromEnvironment } from "@/lib/server/retrieval/hybrid/local-reranker-provider";
import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

async function workspaceBaseline(root: string) {
  const hybridRoot = resolve(root, "src/lib/server/retrieval/hybrid");
  const hybridFiles = (await readdir(hybridRoot, {
    recursive: true,
    withFileTypes: true
  }))
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
  const files = [
    ...hybridFiles,
    resolve(root, "src/lib/server/retrieval/ai-qa.ts"),
    resolve(root, "scripts/benchmark-hybrid-retrieval-v2.ts"),
    resolve(root, "scripts/serve_qwen_embedding.py"),
    resolve(root, "scripts/serve_qwen_reranker.py")
  ].sort();
  const algorithmFiles = [
    "query-parser.ts",
    "rrf.ts",
    "hybrid-candidates.ts",
    "evidence-ranking.ts"
  ].map((name) => resolve(hybridRoot, name)).sort();
  const hashFiles = async (selected: readonly string[]) => {
    const hash = createHash("sha256");
    for (const file of selected) {
      hash.update(relative(root, file).replaceAll("\\", "/"));
      hash.update(await readFile(file));
    }
    return hash.digest("hex");
  };
  const algorithmFileSet = new Set(algorithmFiles);
  const harnessFiles = files.filter((file) => !algorithmFileSet.has(file));
  const [
    scopedSourceHash,
    algorithmSourceHash,
    harnessSourceHash
  ] = await Promise.all([
    hashFiles(files),
    hashFiles(algorithmFiles),
    hashFiles(harnessFiles)
  ]);
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  return {
    headCommit,
    scopedSourceHash,
    algorithmSourceHash,
    harnessSourceHash,
    label:
      `${headCommit.slice(0, 12)}+algorithm-${algorithmSourceHash.slice(0, 12)}` +
      `+harness-${harnessSourceHash.slice(0, 12)}`
  };
}

function assertHoldoutUsesIsolatedSidecar(input: {
  root: string;
  reportPath: string;
  indexPath: string;
}) {
  const developmentSidecars = new Set([
    resolve(
      input.root,
      ".data/evaluation/memory-long-regression/hybrid-embedding-sidecar-qwen3-0.6b.sqlite"
    ),
    resolve(
      input.root,
      ".data/evaluation/memory-long-regression/hybrid-embedding-sidecar-qwen3-4b-2560.sqlite"
    )
  ]);
  const isHoldout = input.reportPath
    .replaceAll("\\", "/")
    .includes("/retrieval-holdout-");
  if (isHoldout && developmentSidecars.has(input.indexPath)) {
    throw new Error(
      "holdout benchmark must use an isolated embedding sidecar; refusing the development sidecar"
    );
  }
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function metricRow(system: string, systemReport: {
  metrics: {
    recallAt5: number;
    recallAt10: number;
    recallAt16: number;
    recallAt30: number;
    mrr: number;
    ndcgAt10: number;
    canonicalCandidateValidity: number;
    recoveredCompleteMisses: number;
  };
}) {
  const metrics = systemReport.metrics;
  return {
    System: system,
    "Recall@5": percent(metrics.recallAt5),
    "Recall@10": percent(metrics.recallAt10),
    "Recall@16": percent(metrics.recallAt16),
    "Recall@30": percent(metrics.recallAt30),
    MRR: metrics.mrr.toFixed(3),
    "nDCG@10": metrics.ndcgAt10.toFixed(3),
    Validity: percent(metrics.canonicalCandidateValidity),
    "Misses recovered": metrics.recoveredCompleteMisses
  };
}

async function main() {
  const root = resolve(".");
  const reportPath = resolve(
    argument("--report") ??
      ".data/evaluation/memory-long-regression/retrieval-60-report-20260728.json"
  );
  const outputPath = resolve(
    argument("--output") ??
      `.data/evaluation/memory-long-regression/hybrid-retrieval-phase2-phase4-${timestamp()}.json`
  );
  const indexPath = resolve(
    argument("--index") ??
      ".data/evaluation/memory-long-regression/hybrid-embedding-sidecar-qwen3-4b-2560.sqlite"
  );
  assertHoldoutUsesIsolatedSidecar({ root, reportPath, indexPath });
  const provider = qwenEmbeddingProviderForPurpose("index");
  const rerankerEnabled = hasFlag("--reranker");
  const reranker = rerankerEnabled ? qwenRerankerProviderFromEnvironment() : undefined;
  const index = new SqliteEmbeddingIndex(indexPath, provider.config);
  try {
    const baseline = await workspaceBaseline(root);
    const report = await runHybridRetrievalBenchmarkV2({
      reportPath,
      runtimePath: argument("--runtime"),
      provider,
      index,
      reranker,
      rerankerEnabled,
      batchSize: Number(argument("--batch-size") ?? 16),
      workspaceBaseline: baseline,
      onProgress: (message) => console.info(`[hybrid-benchmark-v2] ${message}`)
    });
    console.table([
      metricRow("Current", report.systems.current),
      metricRow("Dense", report.systems.dense),
      metricRow("Hybrid", report.systems.hybrid),
      metricRow("Hybrid + Optimized Ranking", report.systems.hybridOptimizedRanking),
      metricRow("Hybrid + Phase 3.1 Ranking", report.systems.hybridPhase31Ranking),
      metricRow(
        "Phase 3.1 + Memory Structured",
        report.systems.hybridPhase31MemoryStructured
      ),
      metricRow(
        "Phase 3.1 + Memory Dense",
        report.systems.hybridPhase31MemoryDense
      ),
      metricRow(
        "Phase 3.1 + Memory Structured+Dense",
        report.systems.hybridPhase31MemoryStructuredDense
      ),
      metricRow("Hybrid + Reranker", report.systems.hybridReranker),
      metricRow("Hybrid + Ranking + Reranker", report.systems.hybridRankingReranker),
    ]);
    console.log(JSON.stringify({
      reproducibility: report.reproducibility,
      baseline: report.baseline,
      indexing: report.indexing,
      memoryIndexing: report.memoryIndexing,
      reranker: {
        enabled: report.reranker.enabled,
        health: report.reranker.health,
        fallbackCount: report.reranker.fallbackCount,
        timeoutCount: report.reranker.timeoutCount,
        batchLatency: report.reranker.batchLatency,
        maxGpuPeakMemoryMb: report.reranker.maxGpuPeakMemoryMb
      }
    }, null, 2));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[hybrid-benchmark-v2] report=${outputPath}`);
  } finally {
    index.close();
  }
}

main().catch((error) => {
  console.error(
    `[hybrid-benchmark-v2] failed error_name=${error instanceof Error ? error.name : "unknown"} ` +
    `message=${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
