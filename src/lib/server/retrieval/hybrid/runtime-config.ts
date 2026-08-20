import { join } from "node:path";
import { getUserDataRootDir } from "@/lib/server/auth/session";
import {
  qwenEmbeddingProviderFromEnvironment,
  type QwenEmbeddingProvider
} from "./qwen-embedding-provider";

export const QWEN3_EMBEDDING_4B_MODEL = "Qwen/Qwen3-Embedding-4B";
export const QWEN3_EMBEDDING_4B_REVISION =
  "5cf2132abc99cad020ac570b19d031efec650f2b";
export const QWEN3_EMBEDDING_4B_DIMENSION = 2_560;

export type QaHybridRetrievalMode = "off" | "shadow" | "phase31";
export type HybridEmbeddingPurpose = "query" | "index";

export function resolveQaHybridRetrievalMode(
  value = process.env.QA_HYBRID_RETRIEVAL_MODE
): QaHybridRetrievalMode {
  const normalized = value?.trim().toLowerCase() || "off";
  if (normalized === "off" || normalized === "shadow" || normalized === "phase31") {
    return normalized;
  }
  throw new Error("QA_HYBRID_RETRIEVAL_MODE must be off, shadow, or phase31");
}

function timeoutForPurpose(
  purpose: HybridEmbeddingPurpose,
  environment: Readonly<Record<string, string | undefined>>
) {
  return purpose === "index"
    ? environment.HYBRID_EMBEDDING_INDEX_TIMEOUT_MS ?? "60000"
    : environment.HYBRID_EMBEDDING_QUERY_TIMEOUT_MS ?? "3000";
}

export function qwenEmbeddingProviderForPurpose(
  purpose: HybridEmbeddingPurpose,
  environment: Readonly<Record<string, string | undefined>> = process.env
): QwenEmbeddingProvider {
  return qwenEmbeddingProviderFromEnvironment({
    ...environment,
    HYBRID_EMBEDDING_TIMEOUT_MS: timeoutForPurpose(purpose, environment)
  });
}

export function hybridEmbeddingIndexPath(
  userId: string,
  dataRoot?: string
) {
  return join(
    getUserDataRootDir(userId, dataRoot),
    "indexes",
    "hybrid-evidence-qwen3-4b-2560.sqlite"
  );
}

export function assertLocalQwen4BConfig(provider: Pick<QwenEmbeddingProvider, "config">) {
  const config = provider.config;
  if (
    config.modelName !== QWEN3_EMBEDDING_4B_MODEL ||
    config.modelVersion !== QWEN3_EMBEDDING_4B_REVISION ||
    config.dimension !== QWEN3_EMBEDDING_4B_DIMENSION
  ) {
    throw new Error(
      "local Hybrid QA requires the pinned Qwen3-Embedding-4B revision at 2560 dimensions"
    );
  }
  return config;
}
