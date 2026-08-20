export const HYBRID_EMBEDDING_DIMENSION = 1024 as const;
export const DEFAULT_HYBRID_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-0.6B";
export const DEFAULT_HYBRID_EMBEDDING_MODEL_VERSION =
  "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3";

export type EmbeddingModelConfig = {
  modelName: string;
  modelVersion: string;
  dimension: number;
};

export interface EmbeddingProvider {
  readonly config: EmbeddingModelConfig;
  embed(texts: string[]): Promise<number[][]>;
}

export function assertEmbeddingDimension(value: number, label = "embedding dimension") {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_536) {
    throw new Error(`${label} must be a positive integer no greater than 65536`);
  }
  return value;
}

export function assertEmbeddingVector(
  vector: readonly number[],
  dimension: number,
  label = "embedding"
) {
  assertEmbeddingDimension(dimension);
  if (vector.length !== dimension) {
    throw new Error(`${label} dimension mismatch: expected ${dimension}, received ${vector.length}`);
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} contains a non-finite value`);
  }
}

export function normalizeEmbeddingVector(vector: readonly number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("embedding vector must have a finite non-zero magnitude");
  }
  return vector.map((value) => value / magnitude);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("cosine similarity requires non-empty vectors with equal dimensions");
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}
