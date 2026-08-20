import { afterEach, describe, expect, it, vi } from "vitest";
import type { QaRetrievedEvidence } from "../ai-qa";
import { LocalHttpRerankerProvider } from "./local-reranker-provider";
import {
  orderHybridCandidatesByRerankerScores,
  rerankHybridCandidates
} from "./rerank";
import type { RerankerProvider } from "./reranker-provider";
import type { HybridEvidenceCandidate } from "./types";

function candidate(id: string): HybridEvidenceCandidate {
  const evidence: QaRetrievedEvidence = {
    id,
    kind: "raw",
    title: id,
    text: `文本 ${id}`,
    startSeconds: 0,
    endSeconds: 1,
    sourceSegmentIds: [`segment-${id}`],
    priority: 1
  };
  return {
    evidence,
    rrfScore: 0.02,
    channelRanks: { dense: 1 }
  };
}

function provider(score: RerankerProvider["score"]): RerankerProvider {
  return {
    modelName: "Qwen/Qwen3-Reranker-0.6B",
    modelVersion: "revision-test",
    batchSize: 8,
    timeoutMs: 100,
    score,
    async healthCheck() {
      return {
        ok: true,
        modelName: "Qwen/Qwen3-Reranker-0.6B",
        modelVersion: "revision-test"
      };
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rerankHybridCandidates", () => {
  it("reorders only the supplied Top-K and preserves id/sourceSegmentIds", async () => {
    const original = [candidate("one"), candidate("two")];
    const result = await rerankHybridCandidates({
      question: "问题",
      candidates: original,
      provider: provider(async () => [0.1, 0.9]),
      enabled: true
    });

    expect(result.fallback).toBe(false);
    expect(result.candidates.map((item) => item.evidence.id)).toEqual(["two", "one"]);
    expect(result.candidates.map((item) => item.evidence.sourceSegmentIds)).toEqual([
      ["segment-two"],
      ["segment-one"]
    ]);
    expect(new Set(result.candidates.map((item) => item.evidence))).toEqual(
      new Set(original.map((item) => item.evidence))
    );
  });

  it.each([
    ["timeout", new DOMException("timed out", "AbortError")],
    ["oom", new Error("CUDA out of memory")],
    ["service unavailable", new Error("connect ECONNREFUSED")]
  ])("falls back to the exact Hybrid order on %s", async (_name, error) => {
    const original = [candidate("one"), candidate("two")];
    const result = await rerankHybridCandidates({
      question: "问题",
      candidates: original,
      provider: provider(async () => {
        throw error;
      }),
      enabled: true
    });

    expect(result.fallback).toBe(true);
    expect(result.candidates.map((item) => item.evidence.id)).toEqual(["one", "two"]);
  });

  it("falls back on malformed score count or non-finite scores", async () => {
    const original = [candidate("one"), candidate("two")];
    const malformedCount = await rerankHybridCandidates({
      question: "问题",
      candidates: original,
      provider: provider(async () => [0.5]),
      enabled: true
    });
    const malformedValue = await rerankHybridCandidates({
      question: "问题",
      candidates: original,
      provider: provider(async () => [0.5, Number.NaN]),
      enabled: true
    });

    expect(malformedCount).toMatchObject({ fallback: true });
    expect(malformedValue).toMatchObject({ fallback: true });
  });

  it("defaults to disabled fallback without calling the provider", async () => {
    const score = vi.fn(async () => [1]);
    const result = await rerankHybridCandidates({
      question: "问题",
      candidates: [candidate("one")],
      provider: provider(score)
    });

    expect(result).toMatchObject({ fallback: true, fallbackReason: "disabled" });
    expect(score).not.toHaveBeenCalled();
  });

  it("reuses scores for a different order of the same Top-30 candidates", () => {
    const reordered = orderHybridCandidatesByRerankerScores({
      candidates: [candidate("two"), candidate("one")],
      scoresByEvidenceId: new Map([
        ["one", 0.1],
        ["two", 0.9]
      ])
    });

    expect(reordered.map((item) => item.evidence.id)).toEqual(["two", "one"]);
    expect(reordered.map((item) => item.evidence.sourceSegmentIds)).toEqual([
      ["segment-two"],
      ["segment-one"]
    ]);
  });
});

describe("LocalHttpRerankerProvider", () => {
  it("rejects non-loopback endpoints", () => {
    expect(() => new LocalHttpRerankerProvider({
      endpoint: "https://api.example.test",
      modelName: "model",
      modelVersion: "revision"
    })).toThrow(/loopback/iu);
  });

  it("rejects a malformed local HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "Qwen/Qwen3-Reranker-0.6B",
      revision: "revision-test",
      scores: ["bad"]
    }), { status: 200 })));
    const local = new LocalHttpRerankerProvider({
      endpoint: "http://127.0.0.1:8081",
      modelName: "Qwen/Qwen3-Reranker-0.6B",
      modelVersion: "revision-test"
    });

    await expect(local.score("问题", [{ id: "one", text: "证据" }]))
      .rejects.toThrow(/Malformed reranker response/iu);
  });
});
