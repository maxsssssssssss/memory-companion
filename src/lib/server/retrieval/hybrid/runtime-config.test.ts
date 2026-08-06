// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION,
  assertLocalQwen4BConfig,
  qwenEmbeddingProviderForPurpose,
  resolveHybridIndexRetentionPolicy,
  resolveQaHybridRetrievalMode
} from "./runtime-config";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Hybrid QA runtime config", () => {
  it("accepts only off, shadow, and phase31", () => {
    expect(resolveQaHybridRetrievalMode()).toBe("off");
    expect(resolveQaHybridRetrievalMode(" shadow ")).toBe("shadow");
    expect(resolveQaHybridRetrievalMode("phase31")).toBe("phase31");
    expect(() => resolveQaHybridRetrievalMode("on")).toThrow(
      "QA_HYBRID_RETRIEVAL_MODE must be off, shadow, or phase31"
    );
  });

  it("keeps vector retention independent from the QA retrieval mode", () => {
    expect(resolveHybridIndexRetentionPolicy()).toBe("off");
    expect(resolveHybridIndexRetentionPolicy(" browser_cache ")).toBe("browser_cache");
    expect(() => resolveHybridIndexRetentionPolicy("shadow")).toThrow(
      "HYBRID_INDEX_RETENTION_POLICY must be off or browser_cache"
    );
  });

  it("uses 5 seconds for queries and 60 seconds for indexing", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
        status: 200
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const timeout = vi.spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    const base = {
      HYBRID_EMBEDDING_BASE_URL: "http://127.0.0.1:18080/v1",
      HYBRID_EMBEDDING_MODEL: "test-model",
      HYBRID_EMBEDDING_MODEL_VERSION: "test-revision",
      HYBRID_EMBEDDING_DIMENSION: "1"
    };
    await qwenEmbeddingProviderForPurpose("query", base).embed(["query"]);
    await qwenEmbeddingProviderForPurpose("index", base).embed(["index"]);
    expect(timeout).toHaveBeenNthCalledWith(1, 5_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 60_000);
  });

  it("requires the exact 4B fingerprint for production Hybrid", () => {
    expect(assertLocalQwen4BConfig({
      config: {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: QWEN3_EMBEDDING_4B_REVISION,
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      }
    })).toEqual({
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    });
    expect(() => assertLocalQwen4BConfig({
      config: {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: "main",
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      }
    })).toThrow(/pinned Qwen3-Embedding-4B revision/u);
  });
});
