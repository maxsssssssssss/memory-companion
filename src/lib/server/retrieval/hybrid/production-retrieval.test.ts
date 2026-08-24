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

  it("keeps dense-only Person recall inside the explicit multi-upload canonical allowlist", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-person-"));
    temporaryDirectories.push(dataRoot);
    configureEnvironment(dataRoot);
    const base = qaInput();
    const allowedSegments = base.segments.map((item, index) => ({
      ...item,
      uploadId: index < 10 ? "person-upload-old" : "person-upload-new"
    }));
    const foreignSegment: TranscriptSegment = {
      ...segment(99),
      id: "segment-foreign-person",
      uploadId: "other-person-upload",
      text: "另一个 Person 的高相似度私密证据。"
    };
    const input: AnswerQuestionWithAIInput = {
      ...base,
      uploadId: "person-confirmed",
      segments: [...allowedSegments, foreignSegment],
      retrievalSourceSegmentIds: allowedSegments.map((item) => item.id)
    };
    const canonical = buildCanonicalQaEvidence(input);
    const lexicalResult = retrieveQaEvidenceWithDiagnostics(input);
    const denseOnlyTarget = canonical.find((item) => item.id === "segment-19");
    if (!denseOnlyTarget) throw new Error("fixture requires a dense-only Person candidate");
    const lexical = {
      ...lexicalResult,
      evidence: lexicalResult.evidence.filter((item) => item.id !== denseOnlyTarget.id)
    };
    const unbounded = buildCanonicalQaEvidence({
      ...input,
      retrievalSourceSegmentIds: undefined
    });
    const foreignEvidence = unbounded.find((item) => item.id === foreignSegment.id);
    if (!foreignEvidence) throw new Error("fixture requires foreign canonical evidence");

    const model = {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    };
    const writer = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath(input.userId!),
      model
    );
    for (const evidence of canonical) {
      writer.upsert({
        objectType: "evidence",
        objectId: evidence.id,
        contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(evidence)),
        vector: vector(evidence.id === denseOnlyTarget.id ? 0 : 1)
      });
    }
    writer.upsert({
      objectType: "evidence",
      objectId: foreignEvidence.id,
      contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(foreignEvidence)),
      vector: vector(0)
    });
    writer.close();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: vector(0) }]
    }), { status: 200 })));

    const result = await retrieveProductionHybridEvidence({ qaInput: input, lexical });
    const allowedSourceIds = new Set(input.retrievalSourceSegmentIds);
    expect(result.evidence.some((item) => item.id === denseOnlyTarget.id)).toBe(true);
    expect(result.evidence.some((item) => item.id === foreignEvidence.id)).toBe(false);
    expect(result.evidence.every((item) =>
      item.sourceSegmentIds.every((sourceId) => allowedSourceIds.has(sourceId))
    )).toBe(true);
  });

  it("fails before Provider or index access when lexical candidates cross the exact boundary", async () => {
    const input: AnswerQuestionWithAIInput = {
      ...qaInput(),
      retrievalSourceSegmentIds: ["segment-0"]
    };
    const unboundedLexical = retrieveQaEvidenceWithDiagnostics({
      ...input,
      retrievalSourceSegmentIds: undefined
    });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(retrieveProductionHybridEvidence({
      qaInput: input,
      lexical: unboundedLexical
    })).rejects.toMatchObject({ reason: "candidate_boundary" });
    expect(fetcher).not.toHaveBeenCalled();
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
