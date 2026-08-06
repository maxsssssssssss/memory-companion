import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HYBRID_EMBEDDING_MODEL,
  DEFAULT_HYBRID_EMBEDDING_MODEL_VERSION,
  HYBRID_EMBEDDING_DIMENSION,
  cosineSimilarity,
  normalizeEmbeddingVector
} from "./embedding-provider";
import {
  QwenEmbeddingProvider,
  qwenEmbeddingProviderFromEnvironment
} from "./qwen-embedding-provider";

describe("QwenEmbeddingProvider", () => {
  it("pins the default model, dimension, and revision while allowing explicit overrides", () => {
    expect(qwenEmbeddingProviderFromEnvironment({}).config).toEqual({
      modelName: DEFAULT_HYBRID_EMBEDDING_MODEL,
      modelVersion: DEFAULT_HYBRID_EMBEDDING_MODEL_VERSION,
      dimension: HYBRID_EMBEDDING_DIMENSION
    });

    expect(qwenEmbeddingProviderFromEnvironment({
      HYBRID_EMBEDDING_MODEL: "local/custom-embedding",
      HYBRID_EMBEDDING_MODEL_VERSION: "explicit-revision",
      HYBRID_EMBEDDING_DIMENSION: "2560",
      HYBRID_EMBEDDING_QUERY_TIMEOUT_MS: "3000"
    }).config).toEqual({
      modelName: "local/custom-embedding",
      modelVersion: "explicit-revision",
      dimension: 2560
    });
  });

  it("calls only a local OpenAI-compatible embedding endpoint and validates 1024 dimensions", async () => {
    const vector = Array.from({ length: HYBRID_EMBEDDING_DIMENSION }, (_, index) => index / 100);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: vector }]
    }), { status: 200 }));
    const provider = new QwenEmbeddingProvider({
      baseUrl: "http://127.0.0.1:8080/v1/",
      modelVersion: "revision-1",
      fetcher
    });

    await expect(provider.embed(["测试文本"])).resolves.toEqual([vector]);
    expect(provider.config).toEqual({
      modelName: "Qwen/Qwen3-Embedding-0.6B",
      modelVersion: "revision-1",
      dimension: 1024
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Connection: "close"
        }),
        body: JSON.stringify({
          model: "Qwen/Qwen3-Embedding-0.6B",
          input: ["测试文本"],
          encoding_format: "float"
        })
      })
    );
  });

  it("rejects non-loopback endpoints and malformed dimensions", async () => {
    expect(() => new QwenEmbeddingProvider({
      baseUrl: "https://embedding.example.test/v1",
      modelVersion: "revision-1"
    })).toThrow(/local HTTP loopback/u);

    const provider = qwenEmbeddingProviderFromEnvironment({
      HYBRID_EMBEDDING_BASE_URL: "http://localhost:8080/v1",
      HYBRID_EMBEDDING_MODEL_VERSION: "revision-2"
    }, async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 2, 3] }]
    }), { status: 200 }));
    await expect(provider.embed(["测试"])).rejects.toThrow(/dimension mismatch/u);
  });
  it("rejects a non-positive configured dimension", () => {
    expect(() => qwenEmbeddingProviderFromEnvironment({
      HYBRID_EMBEDDING_DIMENSION: "0"
    })).toThrow(/positive integer/u);
  });

  it("checks the configured model through the loopback models endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "Qwen/Qwen3-Embedding-4B" }]
    }), { status: 200 }));
    const provider = new QwenEmbeddingProvider({
      baseUrl: "http://127.0.0.1:18080/v1",
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelVersion: "revision-4b",
      dimension: 2560,
      timeoutMs: 3000,
      fetcher
    });
    await expect(provider.healthCheck()).resolves.toEqual({
      modelIds: ["Qwen/Qwen3-Embedding-4B"]
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:18080/v1/models",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal)
      })
    );
  });
});
describe("embedding vector math", () => {
  it("normalizes vectors and computes cosine similarity", () => {
    expect(normalizeEmbeddingVector([3, 4])).toEqual([0.6, 0.8]);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1);
  });
});
