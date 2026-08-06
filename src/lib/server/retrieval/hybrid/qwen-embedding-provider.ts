import {
  DEFAULT_HYBRID_EMBEDDING_MODEL,
  DEFAULT_HYBRID_EMBEDDING_MODEL_VERSION,
  HYBRID_EMBEDDING_DIMENSION,
  assertEmbeddingDimension,
  assertEmbeddingVector,
  type EmbeddingModelConfig,
  type EmbeddingProvider
} from "./embedding-provider";

type Fetcher = typeof fetch;

export type QwenEmbeddingProviderOptions = {
  baseUrl: string;
  apiKey?: string;
  modelName?: string;
  modelVersion?: string;
  dimension?: number;
  timeoutMs?: number;
  fetcher?: Fetcher;
};

type EmbeddingResponse = {
  data?: Array<{
    index?: unknown;
    embedding?: unknown;
  }>;
};

function nonEmpty(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
function positiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
  maximum = 10 * 60 * 1_000
) {
  const normalized = nonEmpty(value);
  if (!normalized) return fallback;
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function localEmbeddingBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("HYBRID_EMBEDDING_BASE_URL must be a valid URL");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname)) {
    throw new Error("Hybrid embedding provider must use a local HTTP loopback URL");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/u, "");
}

function responseVectors(payload: EmbeddingResponse, expectedCount: number, dimension: number) {
  if (!Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw new Error(
      `embedding provider returned ${payload.data?.length ?? 0} vectors for ${expectedCount} texts`
    );
  }
  const sorted = [...payload.data].sort((left, right) =>
    Number(left.index ?? 0) - Number(right.index ?? 0)
  );
  return sorted.map((item, index) => {
    if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === "number")) {
      throw new Error(`embedding provider returned an invalid vector at index ${index}`);
    }
    const vector = item.embedding as number[];
    assertEmbeddingVector(vector, dimension, `embedding[${index}]`);
    return vector;
  });
}

export class QwenEmbeddingProvider implements EmbeddingProvider {
  readonly config: EmbeddingModelConfig;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(options: QwenEmbeddingProviderOptions) {
    this.baseUrl = localEmbeddingBaseUrl(options.baseUrl);
    this.apiKey = nonEmpty(options.apiKey);
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = positiveInteger(
      options.timeoutMs === undefined ? undefined : String(options.timeoutMs),
      3_000,
      "HYBRID_EMBEDDING_TIMEOUT_MS"
    );
    this.config = {
      modelName: nonEmpty(options.modelName) ?? DEFAULT_HYBRID_EMBEDDING_MODEL,
      modelVersion: nonEmpty(options.modelVersion) ?? DEFAULT_HYBRID_EMBEDDING_MODEL_VERSION,
      dimension: assertEmbeddingDimension(
        options.dimension ?? HYBRID_EMBEDDING_DIMENSION,
        "HYBRID_EMBEDDING_DIMENSION"
      )
    };
  }

  private requestHeaders() {
    return {
      "Content-Type": "application/json",
      "Connection": "close",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
    };
  }

  async healthCheck() {
    const response = await this.fetcher(`${this.baseUrl}/models`, {
      method: "GET",
      headers: this.requestHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`embedding provider model discovery failed (${response.status})`);
    }
    const payload = await response.json() as {
      data?: Array<{ id?: unknown }>;
    };
    const modelIds = (payload.data ?? []).flatMap((item) =>
      typeof item.id === "string" ? [item.id] : []
    );
    if (!modelIds.includes(this.config.modelName)) {
      throw new Error(`embedding provider does not expose configured model ${this.config.modelName}`);
    }
    return { modelIds };
  }

  async embed(texts: string[]) {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim().length === 0)) {
      throw new Error("embedding input texts must be non-empty");
    }
    const response = await this.fetcher(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.requestHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.config.modelName,
        input: texts,
        encoding_format: "float"
      })
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`embedding provider request failed (${response.status}): ${detail}`);
    }
    return responseVectors(
      await response.json() as EmbeddingResponse,
      texts.length,
      this.config.dimension
    );
  }
}

export function qwenEmbeddingProviderFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher?: Fetcher
) {
  return new QwenEmbeddingProvider({
    baseUrl: nonEmpty(environment.HYBRID_EMBEDDING_BASE_URL) ?? "http://127.0.0.1:8080/v1",
    apiKey: nonEmpty(environment.HYBRID_EMBEDDING_API_KEY),
    modelName: nonEmpty(environment.HYBRID_EMBEDDING_MODEL) ?? DEFAULT_HYBRID_EMBEDDING_MODEL,
    modelVersion:
      nonEmpty(environment.HYBRID_EMBEDDING_MODEL_VERSION) ??
      DEFAULT_HYBRID_EMBEDDING_MODEL_VERSION,
    dimension: assertEmbeddingDimension(
      positiveInteger(
        environment.HYBRID_EMBEDDING_DIMENSION,
        HYBRID_EMBEDDING_DIMENSION,
        "HYBRID_EMBEDDING_DIMENSION",
        65_536
      ),
      "HYBRID_EMBEDDING_DIMENSION"
    ),
    timeoutMs: positiveInteger(
      environment.HYBRID_EMBEDDING_TIMEOUT_MS ??
        environment.HYBRID_EMBEDDING_QUERY_TIMEOUT_MS,
      3_000,
      "HYBRID_EMBEDDING_TIMEOUT_MS"
    ),
    fetcher
  });
}
