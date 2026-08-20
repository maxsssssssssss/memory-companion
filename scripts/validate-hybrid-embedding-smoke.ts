import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

const {
  assertLocalQwen4BConfig,
  qwenEmbeddingProviderForPurpose
} = await import("@/lib/server/retrieval/hybrid/runtime-config");

const provider = qwenEmbeddingProviderForPurpose("query");
assertLocalQwen4BConfig(provider);
const health = await provider.healthCheck();
const inputs = [
  "这是一条本地 embedding 合约检查。",
  "请检索与最终安排直接相关的规范证据。"
];
const vectors = await provider.embed(inputs);
const norms = vectors.map((vector) =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
);
if (vectors.length !== inputs.length) {
  throw new Error("embedding contract returned an unexpected vector count");
}
if (vectors.some((vector) =>
  vector.length !== provider.config.dimension ||
  vector.some((value) => !Number.isFinite(value))
)) {
  throw new Error("embedding contract returned an invalid vector");
}
if (norms.some((norm) => Math.abs(norm - 1) > 0.05)) {
  throw new Error("embedding vectors are not L2-normalized within tolerance");
}

const report = {
  kind: "daily_brief_hybrid_embedding_contract_smoke",
  generatedAt: new Date().toISOString(),
  model: provider.config,
  exposedModelCount: health.modelIds.length,
  inputCount: inputs.length,
  vectorCount: vectors.length,
  dimensions: vectors.map((vector) => vector.length),
  l2Norms: norms,
  vectorDigests: vectors.map((vector) =>
    createHash("sha256")
      .update(Buffer.from(new Float32Array(vector).buffer))
      .digest("hex")
  ),
  assertions: {
    modelExposed: true,
    vectorCountMatches: true,
    finiteValues: true,
    exactDimension: true,
    l2Normalized: true
  }
};
const outputPath = resolve(
  ".data/evaluation/hybrid-embedding-contract/qwen3-embedding-4b-2560.json"
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.info(
  `[hybrid-embedding-smoke] completed=2/2 dimension=${provider.config.dimension} ` +
  `report=${outputPath}`
);
