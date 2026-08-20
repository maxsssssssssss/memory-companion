import { z } from "zod";
import {
  assertValidRerankerScores,
  type RerankerDocument,
  type RerankerBatchTelemetry,
  type RerankerHealth,
  type RerankerProvider
} from "./reranker-provider";

const RerankResponseSchema = z.object({
  model: z.string(),
  revision: z.string(),
  scores: z.array(z.number()),
  latency_ms: z.number().optional(),
  gpu_peak_memory_mb: z.number().optional()
});

const ModelsResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    revision: z.string(),
    device: z.string().optional(),
    gpu_memory_allocated_mb: z.number().optional(),
    gpu_memory_reserved_mb: z.number().optional(),
    model_load_time_ms: z.number().optional()
  }))
});

function assertLoopbackUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  ) {
    throw new Error("Reranker endpoint must use local loopback HTTP");
  }
  return url;
}

async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export class LocalHttpRerankerProvider implements RerankerProvider {
  readonly endpoint: URL;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly batchSize: number;
  readonly timeoutMs: number;
  private lastBatchTelemetry: RerankerBatchTelemetry[] = [];

  constructor(input: {
    endpoint: string;
    modelName: string;
    modelVersion: string;
    batchSize?: number;
    timeoutMs?: number;
  }) {
    this.endpoint = assertLoopbackUrl(input.endpoint);
    this.modelName = input.modelName;
    this.modelVersion = input.modelVersion;
    this.batchSize = Math.max(1, Math.floor(input.batchSize ?? 8));
    this.timeoutMs = Math.max(100, Math.floor(input.timeoutMs ?? 30_000));
  }

  async healthCheck(): Promise<RerankerHealth> {
    const url = new URL("/v1/models", this.endpoint);
    try {
      const response = await fetchWithTimeout(url, { method: "GET" }, this.timeoutMs);
      if (!response.ok) return {
        ok: false,
        modelName: this.modelName,
        modelVersion: this.modelVersion
      };
      const parsed = ModelsResponseSchema.safeParse(await response.json());
      const model = parsed.success
        ? parsed.data.data.find((item) =>
            item.id === this.modelName && item.revision === this.modelVersion
          )
        : undefined;
      return {
        ok: Boolean(model),
        modelName: this.modelName,
        modelVersion: this.modelVersion,
        ...(model?.device ? { device: model.device } : {}),
        ...(model?.gpu_memory_allocated_mb !== undefined
          ? { gpuMemoryAllocatedMb: model.gpu_memory_allocated_mb }
          : {}),
        ...(model?.gpu_memory_reserved_mb !== undefined
          ? { gpuMemoryReservedMb: model.gpu_memory_reserved_mb }
          : {}),
        ...(model?.model_load_time_ms !== undefined
          ? { modelLoadTimeMs: model.model_load_time_ms }
          : {})
      };
    } catch {
      return {
        ok: false,
        modelName: this.modelName,
        modelVersion: this.modelVersion
      };
    }
  }

  async score(
    query: string,
    documents: readonly RerankerDocument[]
  ): Promise<number[]> {
    if (documents.length === 0) return [];
    this.lastBatchTelemetry = [];
    const scores: number[] = [];
    for (let offset = 0; offset < documents.length; offset += this.batchSize) {
      const batch = documents.slice(offset, offset + this.batchSize);
      const response = await fetchWithTimeout(
        new URL("/v1/rerank", this.endpoint),
        {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            model: this.modelName,
            revision: this.modelVersion,
            query,
            documents: batch
          })
        },
        this.timeoutMs
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Reranker HTTP ${response.status}: ${body.slice(0, 240)}`);
      }
      const parsed = RerankResponseSchema.safeParse(await response.json());
      if (
        !parsed.success ||
        parsed.data.model !== this.modelName ||
        parsed.data.revision !== this.modelVersion
      ) {
        throw new Error("Malformed reranker response metadata");
      }
      assertValidRerankerScores(parsed.data.scores, batch.length);
      this.lastBatchTelemetry.push({
        candidateCount: batch.length,
        latencyMs: parsed.data.latency_ms ?? 0,
        ...(parsed.data.gpu_peak_memory_mb !== undefined
          ? { gpuPeakMemoryMb: parsed.data.gpu_peak_memory_mb }
          : {})
      });
      scores.push(...parsed.data.scores);
    }
    assertValidRerankerScores(scores, documents.length);
    return scores;
  }

  getLastBatchTelemetry() {
    return [...this.lastBatchTelemetry];
  }
}

export function qwenRerankerProviderFromEnvironment() {
  return new LocalHttpRerankerProvider({
    endpoint: process.env.HYBRID_RERANKER_ENDPOINT ?? "http://127.0.0.1:8081",
    modelName: process.env.HYBRID_RERANKER_MODEL ?? "Qwen/Qwen3-Reranker-0.6B",
    modelVersion: process.env.HYBRID_RERANKER_MODEL_VERSION ?? "main",
    batchSize: Number(process.env.HYBRID_RERANKER_BATCH_SIZE ?? 8),
    timeoutMs: Number(process.env.HYBRID_RERANKER_TIMEOUT_MS ?? 30_000)
  });
}
