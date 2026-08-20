export type RerankerDocument = {
  id: string;
  text: string;
};

export type RerankerHealth = {
  ok: boolean;
  modelName: string;
  modelVersion: string;
  device?: string;
  gpuMemoryAllocatedMb?: number;
  gpuMemoryReservedMb?: number;
  modelLoadTimeMs?: number;
};

export type RerankerBatchTelemetry = {
  candidateCount: number;
  latencyMs: number;
  gpuPeakMemoryMb?: number;
};

export interface RerankerProvider {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly batchSize: number;
  readonly timeoutMs: number;
  score(query: string, documents: readonly RerankerDocument[]): Promise<number[]>;
  healthCheck(): Promise<RerankerHealth>;
  getLastBatchTelemetry?(): readonly RerankerBatchTelemetry[];
}

export function assertValidRerankerScores(
  scores: unknown,
  expectedCount: number
): asserts scores is number[] {
  if (
    !Array.isArray(scores) ||
    scores.length !== expectedCount ||
    scores.some((score) => typeof score !== "number" || !Number.isFinite(score))
  ) {
    throw new Error(
      `Malformed reranker response: expected ${expectedCount} finite scores`
    );
  }
}
