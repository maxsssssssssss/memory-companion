import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QaRetrievedEvidence } from "../ai-qa";
import type { HybridBenchmarkCase } from "./benchmark";
import type { EmbeddingProvider } from "./embedding-provider";
import { SqliteEmbeddingIndex } from "./embedding-index";

const { loadHybridBenchmarkCasesMock } = vi.hoisted(() => ({
  loadHybridBenchmarkCasesMock: vi.fn()
}));

vi.mock("./benchmark", () => ({
  loadHybridBenchmarkCases: loadHybridBenchmarkCasesMock
}));

import {
  benchmarkGoldGroupRankRegressions,
  runHybridRetrievalBenchmarkV2
} from "./benchmark-v2";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  loadHybridBenchmarkCasesMock.mockReset();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

function evidence(
  id = "canonical-one",
  sourceId = "segment-one"
): QaRetrievedEvidence {
  return {
    id,
    kind: "raw",
    title: "换工作",
    text: "我最终决定换工作。",
    startSeconds: 0,
    endSeconds: 1,
    sourceSegmentIds: [sourceId],
    priority: 1
  };
}

describe("Hybrid benchmark gold-group regression diagnostics", () => {
  it("reports a Top-16 regression even when another gold group improves", () => {
    const goldA = evidence("gold-a", "segment-a");
    const goldB = evidence("gold-b", "segment-b");
    const decoys = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) =>
        evidence(`${prefix}-${index + 1}`, `${prefix}-segment-${index + 1}`)
      );
    const before = [...decoys("before", 4), goldA, goldB];
    const after = [
      evidence("after-leading", "after-leading-segment"),
      goldA,
      ...decoys("after", 16),
      goldB
    ];
    const item = {
      id: "multi-gold",
      scope: "week",
      category: "lifecycle",
      question: "multi gold",
      retrievalFailures: [],
      retrievalEvaluable: true,
      expectedGroups: [["segment-a"], ["segment-b"]],
      qaInput: {} as HybridBenchmarkCase["qaInput"],
      canonicalEvidence: [...before, ...after],
      currentCandidates: before,
      historicalCandidates: before,
      currentLatencyMs: 0,
      missingExpectedGroups: [],
      metadata: new Map()
    } satisfies HybridBenchmarkCase;

    expect(benchmarkGoldGroupRankRegressions({
      item,
      beforeCandidates: before,
      afterCandidates: after
    })).toEqual([{
      groupIndex: 1,
      sourceSegmentIds: ["segment-b"],
      goldEvidenceId: "gold-b",
      beforeRank: 6,
      afterRank: 19
    }]);
  });
});

describe("Hybrid benchmark embedding fallback", () => {
  it("continues through non-Dense channels when the local embedding service is unavailable", async () => {
    const canonical = evidence();
    const item: HybridBenchmarkCase = {
      id: "holdout-one",
      scope: "current",
      category: "decision",
      question: "我最后决定做什么？",
      retrievalFailures: [],
      retrievalEvaluable: true,
      expectedGroups: [["segment-one"]],
      qaInput: {
        question: "我最后决定做什么？",
        conversation: []
      } as unknown as HybridBenchmarkCase["qaInput"],
      canonicalEvidence: [canonical],
      currentCandidates: [canonical],
      historicalCandidates: [canonical],
      currentLatencyMs: 0,
      missingExpectedGroups: [],
      metadata: new Map()
    };
    loadHybridBenchmarkCasesMock.mockResolvedValue({
      reportPath: "holdout-report.json",
      runtimePath: "holdout-runtime",
      source: {},
      cases: [item],
      fixtureHash: "fixture-hash",
      memories: [],
      ownersByMemoryId: new Map()
    });
    const provider: EmbeddingProvider = {
      config: {
        modelName: "Qwen/Qwen3-Embedding-0.6B",
        modelVersion: "test-revision",
        dimension: 1024
      },
      embed: vi.fn().mockRejectedValue(new Error("local embedding unavailable"))
    };
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-benchmark-fallback-"));
    temporaryDirectories.push(directory);
    const index = new SqliteEmbeddingIndex(
      join(directory, "embedding.sqlite"),
      provider.config
    );

    try {
      const report = await runHybridRetrievalBenchmarkV2({
        reportPath: "ignored-by-mock",
        provider,
        index,
        rerankerEnabled: false,
        workspaceBaseline: {
          headCommit: "test-head",
          scopedSourceHash: "test-source",
          label: "test"
        }
      });

      expect(report.embeddingFallback.evidenceAvailableAtCompletion).toBe(false);
      expect(report.embeddingFallback.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "evidence_indexing",
            reason: "local embedding unavailable"
          })
        ])
      );
      expect(report.systems.dense.metrics.recallAt10).toBe(0);
      expect(report.systems.hybridPhase31Ranking.metrics.recallAt10).toBe(1);
      const firstCase = report.cases[0] as {
        candidateIds: Record<string, string[]>;
      };
      expect(firstCase.candidateIds.hybridPhase31Ranking).toContain(
        canonical.id
      );
      expect(report.systems.hybridPhase31Ranking.metrics.canonicalCandidateValidity)
        .toBe(1);
    } finally {
      index.close();
    }
  });

  it("keeps benchmark candidates within the canonical evidence boundary", async () => {
    const raw = evidence(
      "upload-a_chunk_00000_seg_00001",
      "upload-a_chunk_00000_seg_00001"
    );
    raw.title = "原始转写";
    raw.text = "每天给自己留一个小时安静看资料。";
    const semantic: QaRetrievedEvidence = {
      ...evidence("upload-a_semantic_1", raw.id),
      kind: "semantic",
      title: "第二周的独处习惯",
      text: "这一周保留了独处安排。",
      sourceSegmentIds: [raw.id],
      priority: 7
    };
    const item: HybridBenchmarkCase = {
      id: "canonical-boundary-one",
      scope: "week",
      category: "preference",
      question: "第二周有什么安静学习习惯？",
      retrievalFailures: [],
      retrievalEvaluable: true,
      expectedGroups: [[raw.id]],
      qaInput: {
        question: "第二周有什么安静学习习惯？",
        conversation: []
      } as unknown as HybridBenchmarkCase["qaInput"],
      canonicalEvidence: [semantic, raw],
      currentCandidates: [semantic],
      historicalCandidates: [semantic],
      currentLatencyMs: 0,
      missingExpectedGroups: [],
      metadata: new Map()
    };
    loadHybridBenchmarkCasesMock.mockResolvedValue({
      reportPath: "canonical-boundary-report.json",
      runtimePath: "canonical-boundary-runtime",
      source: {},
      cases: [item],
      fixtureHash: "canonical-boundary-fixture-hash",
      memories: [],
      ownersByMemoryId: new Map()
    });
    const provider: EmbeddingProvider = {
      config: {
        modelName: "Qwen/Qwen3-Embedding-4B",
        modelVersion: "test-revision",
        dimension: 4
      },
      embed: vi.fn(async (texts: string[]) =>
        texts.map((text) => [
          /安静|独处/u.test(text) ? 1 : 0.1,
          /决定/u.test(text) ? 1 : 0.1,
          0.25,
          0.5
        ])
      )
    };
    const directory = await mkdtemp(
      join(tmpdir(), "daily-brief-benchmark-canonical-")
    );
    temporaryDirectories.push(directory);
    const index = new SqliteEmbeddingIndex(
      join(directory, "embedding.sqlite"),
      provider.config
    );
    try {
      const report = await runHybridRetrievalBenchmarkV2({
        reportPath: "ignored-by-mock",
        provider,
        index,
        rerankerEnabled: false,
        workspaceBaseline: {
          headCommit: "test-head",
          scopedSourceHash: "test-source",
          label: "test"
        }
      });

      expect(
        report.systems.hybridPhase31Ranking.metrics
          .canonicalCandidateValidity
      ).toBe(1);
      const firstCase = report.cases[0] as {
        candidateIds: Record<string, string[]>;
      };
      expect(
        firstCase.candidateIds.hybridPhase31Ranking.every(
          (id) => [semantic.id, raw.id].includes(id)
        )
      ).toBe(true);
    } finally {
      index.close();
    }
  });
});
