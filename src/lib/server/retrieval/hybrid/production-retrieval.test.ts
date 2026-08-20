// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import {
  buildCanonicalQaEvidence,
  retrieveQaEvidenceWithDiagnostics,
  type AnswerQuestionWithAIInput
} from "@/lib/server/retrieval/ai-qa";
import { canonicalEvidenceEmbeddingText } from "./dense-retrieval";
import {
  embeddingContentHash,
  SqliteEmbeddingIndex
} from "./embedding-index";
import {
  retrieveProductionHybridEvidence
} from "./production-retrieval";
import {
  hybridEmbeddingIndexPath,
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "./runtime-config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function segment(index: number): TranscriptSegment {
  return {
    id: `segment-${index}`,
    uploadId: "upload-1",
    speaker: "speaker_1",
    startSeconds: index * 10,
    endSeconds: index * 10 + 5,
    text: index === 19
      ? "最终确认周日下午两点入场。"
      : `普通记录 ${index}`,
    confidence: 1,
    sceneLabels: ["unknown"],
    valueLabels: []
  };
}

function qaInput(): AnswerQuestionWithAIInput {
  return {
    userId: "user_1",
    uploadId: "upload-1",
    question: "最终确认的入场时间是什么？",
    scope: "current",
    segments: Array.from({ length: 20 }, (_, index) => segment(index)),
    audioInsights: [],
    semanticSegments: [],
    briefItems: []
  };
}

function configureEnvironment(dataRoot: string) {
  vi.stubEnv("APP_DATA_DIR", dataRoot);
  vi.stubEnv("HYBRID_EMBEDDING_BASE_URL", "http://127.0.0.1:18080/v1");
  vi.stubEnv("HYBRID_EMBEDDING_MODEL", QWEN3_EMBEDDING_4B_MODEL);
  vi.stubEnv("HYBRID_EMBEDDING_MODEL_VERSION", QWEN3_EMBEDDING_4B_REVISION);
  vi.stubEnv(
    "HYBRID_EMBEDDING_DIMENSION",
    String(QWEN3_EMBEDDING_4B_DIMENSION)
  );
}

function vector(axis: number) {
  const result = Array.from(
    { length: QWEN3_EMBEDDING_4B_DIMENSION },
    () => 0
  );
  result[axis] = 1;
  return result;
}

describe("production Phase 3.1 Hybrid retrieval", () => {
  it("uses only a complete exact-model sidecar and preserves canonical citations", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-production-"));
    temporaryDirectories.push(dataRoot);
    configureEnvironment(dataRoot);
    const input = qaInput();
    const canonical = buildCanonicalQaEvidence(input);
    const model = {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    };
    const writer = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath(input.userId!),
      model
    );
    canonical.forEach((evidence, index) => {
      writer.upsert({
        objectType: "evidence",
        objectId: evidence.id,
        contentHash: embeddingContentHash(
          canonicalEvidenceEmbeddingText(evidence)
        ),
        vector: vector(index === canonical.length - 1 ? 0 : 1)
      });
    });
    writer.close();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: vector(0) }]
    }), { status: 200 })));

    const result = await retrieveProductionHybridEvidence({
      qaInput: input,
      lexical: retrieveQaEvidenceWithDiagnostics(input)
    });
    const canonicalIds = new Set(canonical.map((item) => item.id));
    expect(result.indexCoverage).toBe(1);
    expect(result.evidence).toHaveLength(16);
    expect(result.evidence.every((item) => canonicalIds.has(item.id))).toBe(true);
    expect(result.evidence.some((item) => item.id === "segment-19")).toBe(true);
  });

  it("returns a deterministic canonical Top-16 across repeated queries", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-production-"));
    temporaryDirectories.push(dataRoot);
    configureEnvironment(dataRoot);
    const input = qaInput();
    const canonical = buildCanonicalQaEvidence(input);
    const model = {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    };
    const embeddingWriter = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath(input.userId!),
      model
    );
    canonical.forEach((evidence, index) => {
      embeddingWriter.upsert({
        objectType: "evidence",
        objectId: evidence.id,
        contentHash: embeddingContentHash(
          canonicalEvidenceEmbeddingText(evidence)
        ),
        vector: vector(index === canonical.length - 1 ? 0 : 1)
      });
    });
    embeddingWriter.close();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: vector(0) }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const lexical = retrieveQaEvidenceWithDiagnostics(input);
    const first = await retrieveProductionHybridEvidence({
      qaInput: input,
      lexical
    });
    const second = await retrieveProductionHybridEvidence({
      qaInput: input,
      lexical
    });

    expect(second.evidence.map((item) => item.id)).toEqual(
      first.evidence.map((item) => item.id)
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails before the query call when any canonical vector is missing", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-production-"));
    temporaryDirectories.push(dataRoot);
    configureEnvironment(dataRoot);
    const input = qaInput();
    const canonical = buildCanonicalQaEvidence(input);
    const writer = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath(input.userId!),
      {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: QWEN3_EMBEDDING_4B_REVISION,
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      }
    );
    canonical.slice(0, -1).forEach((evidence) => {
      writer.upsert({
        objectType: "evidence",
        objectId: evidence.id,
        contentHash: embeddingContentHash(
          canonicalEvidenceEmbeddingText(evidence)
        ),
        vector: vector(1)
      });
    });
    writer.close();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(retrieveProductionHybridEvidence({
      qaInput: input,
      lexical: retrieveQaEvidenceWithDiagnostics(input)
    })).rejects.toMatchObject({
      reason: "index_incomplete",
      indexCoverage: (canonical.length - 1) / canonical.length
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
