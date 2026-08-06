import { createHash } from "node:crypto";
import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

const {
  assertLocalQwen4BConfig,
  qwenEmbeddingProviderForPurpose
} = await import("@/lib/server/retrieval/hybrid/runtime-config");

const provider = qwenEmbeddingProviderForPurpose("query");
assertLocalQwen4BConfig(provider);
const health = await provider.healthCheck();
console.info("[hybrid-embedding-smoke] progress=1/2 stage=models status=ok");
const inputs = [
  "Daily Brief Hybrid embedding contract check.",
  "请检索与最终安排直接相关的规范证据。"
];
const vectors = await provider.embed(inputs);
const norms = vectors.map((vector) =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
);
if (vectors.length !== inputs.length) {
  throw new Error("Embedding contract returned an unexpected vector count");
}
if (vectors.some((vector) =>
  vector.length !== provider.config.dimension ||
  vector.some((value) => !Number.isFinite(value))
)) {
  throw new Error("Embedding contract returned an invalid vector");
}
if (norms.some((norm) => Math.abs(norm - 1) > 0.05)) {
  throw new Error("Embedding vectors are not L2-normalized within tolerance");
}
console.info("[hybrid-embedding-smoke] progress=2/2 stage=embeddings status=ok");
console.info(JSON.stringify({
  status: "passed",
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
  )
}, null, 2));
