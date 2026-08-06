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
        sourceUploadId: input.uploadId,
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
        sourceUploadId: input.uploadId,
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

  it("rejects a sidecar row whose source upload owner is missing", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-production-"));
    temporaryDirectories.push(dataRoot);
    configureEnvironment(dataRoot);
    const input = { ...qaInput(), segments: [segment(0)] };
    const [canonical] = buildCanonicalQaEvidence(input);
    const writer = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath(input.userId!),
      {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: QWEN3_EMBEDDING_4B_REVISION,
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      }
    );
    writer.upsert({
      objectType: "evidence",
      objectId: canonical!.id,
      sourceUploadId: null as unknown as string,
      contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(canonical!)),
      vector: vector(1)
    });
    writer.close();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(retrieveProductionHybridEvidence({
      qaInput: input,
      lexical: retrieveQaEvidenceWithDiagnostics(input)
    })).rejects.toMatchObject({
      reason: "index_incomplete",
      indexCoverage: 0
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("derives each canonical owner from its source item and rejects owner drift", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-production-"));
    temporaryDirectories.push(dataRoot);
    configureEnvironment(dataRoot);
    const input: AnswerQuestionWithAIInput = {
      ...qaInput(),
      uploadId: "all-scope",
      scope: "all",
      segments: [
        segment(0),
        { ...segment(1), uploadId: "upload-2" }
      ]
    };
    const canonical = buildCanonicalQaEvidence(input);
    const writer = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath(input.userId!),
      {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: QWEN3_EMBEDDING_4B_REVISION,
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      }
    );
    canonical.forEach((evidence) => {
      writer.upsert({
        objectType: "evidence",
        objectId: evidence.id,
        sourceUploadId: evidence.id === "segment-0" ? "upload-1" : "all-scope",
        contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(evidence)),
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
      indexCoverage: 0.5
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
