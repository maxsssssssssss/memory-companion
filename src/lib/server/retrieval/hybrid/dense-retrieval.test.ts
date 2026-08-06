import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import {
  buildCanonicalQaEvidence,
  type AnswerQuestionWithAIInput
} from "../ai-qa";
import {
  HYBRID_EMBEDDING_DIMENSION,
  type EmbeddingProvider
} from "./embedding-provider";
import { SqliteEmbeddingIndex } from "./embedding-index";
import { indexCanonicalEvidence, retrieveDenseEvidence } from "./dense-retrieval";

const temporaryDirectories: string[] = [];
const openIndexes: SqliteEmbeddingIndex[] = [];

afterEach(async () => {
  openIndexes.splice(0).forEach((index) => index.close());
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function segment(index: number, text: string): TranscriptSegment {
  return {
    id: `segment-${String(index).padStart(2, "0")}`,
    uploadId: "upload-1",
    speaker: "speaker_1",
    startSeconds: index * 10,
    endSeconds: index * 10 + 8,
    text,
    confidence: 0.95,
    sceneLabels: ["unknown"],
    valueLabels: []
  };
}

function semanticVector(text: string) {
  const vector = Array.from({ length: HYBRID_EMBEDDING_DIMENSION }, () => 0);
  if (/职业方向|换工作/u.test(text)) {
    vector[0] = 1;
  } else {
    vector[1] = 1;
  }
  return vector;
}

function fakeProvider(): EmbeddingProvider {
  return {
    config: {
      modelName: "Qwen/Qwen3-Embedding-0.6B",
      modelVersion: "test-revision",
      dimension: HYBRID_EMBEDDING_DIMENSION
    },
    async embed(texts) {
      return texts.map(semanticVector);
    }
  };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "daily-brief-dense-shadow-"));
  temporaryDirectories.push(directory);
  const provider = fakeProvider();
  const index = new SqliteEmbeddingIndex(join(directory, "embeddings.sqlite"), provider.config);
  openIndexes.push(index);
  return { provider, index };
}

function qaInput(): AnswerQuestionWithAIInput {
  return {
    uploadId: "upload-1",
    question: "我对新的职业方向有什么想法？",
    scope: "current",
    segments: [
      ...Array.from({ length: 20 }, (_, index) =>
        segment(index, `普通日程记录 ${index}`)
      ),
      segment(20, "我已经决定换工作，接下来会更新简历。")
    ],
    audioInsights: [],
    semanticSegments: [],
    briefItems: []
  };
}

function sourceUploadOwners(
  evidence: ReturnType<typeof buildCanonicalQaEvidence>,
  uploadId = "upload-1"
) {
  return new Map(evidence.map((item) => [item.id, uploadId]));
}

describe("Evidence dense recall shadow", () => {
  it("retrieves a semantic miss from the canonical sidecar", async () => {
    const { provider, index } = await setup();
    const input = qaInput();
    const canonical = buildCanonicalQaEvidence(input);
    expect(canonical).toHaveLength(21);
    await indexCanonicalEvidence({
      evidence: canonical,
      sourceUploadIdByObjectId: sourceUploadOwners(canonical),
      provider,
      index
    });
    const dense = await retrieveDenseEvidence({
      question: input.question,
      evidence: canonical,
      provider,
      index,
      limit: 5
    });
    expect(dense[0]).toMatchObject({
      rank: 1,
      evidence: { id: "segment-20" }
    });
  });

  it("does not re-embed unchanged Canonical Evidence", async () => {
    const { provider, index } = await setup();
    const evidence = buildCanonicalQaEvidence(qaInput());
    const sourceUploadIdByObjectId = sourceUploadOwners(evidence);
    const first = await indexCanonicalEvidence({
      evidence,
      sourceUploadIdByObjectId,
      provider,
      index
    });
    const second = await indexCanonicalEvidence({
      evidence,
      sourceUploadIdByObjectId,
      provider,
      index
    });

    expect(first).toMatchObject({ total: 21, embedded: 21, unchanged: 0 });
    expect(second).toMatchObject({ total: 21, embedded: 0, unchanged: 21 });
    expect(index.get("evidence", evidence[0]!.id)?.sourceUploadId)
      .toBe("upload-1");
  });

  it("leaves the previous snapshot unchanged when a later embedding batch fails", async () => {
    const { index } = await setup();
    const evidence = buildCanonicalQaEvidence(qaInput()).slice(0, 2);
    const original = evidence[0]!;
    index.upsert({
      objectType: "evidence",
      objectId: original.id,
      sourceUploadId: "upload-1",
      contentHash: "previous-snapshot",
      vector: semanticVector("previous")
    });
    const embed = vi.fn()
      .mockResolvedValueOnce([semanticVector("first")])
      .mockRejectedValueOnce(new Error("remote batch failed"));
    const provider: EmbeddingProvider = {
      config: index.model,
      embed
    };

    await expect(indexCanonicalEvidence({
      evidence,
      sourceUploadIdByObjectId: sourceUploadOwners(evidence),
      provider,
      index,
      batchSize: 1
    })).rejects.toThrow("remote batch failed");
    expect(index.get("evidence", original.id)?.contentHash)
      .toBe("previous-snapshot");
    expect(index.get("evidence", evidence[1]!.id)).toBeNull();
  });

  it("rejects missing or conflicting source upload ownership", async () => {
    const { provider, index } = await setup();
    const evidence = buildCanonicalQaEvidence(qaInput()).slice(0, 1);

    await expect(indexCanonicalEvidence({
      evidence,
      sourceUploadIdByObjectId: new Map(),
      provider,
      index
    })).rejects.toThrow(/missing a source upload owner/u);

    index.upsert({
      objectType: "evidence",
      objectId: evidence[0]!.id,
      sourceUploadId: "upload-other",
      contentHash: "previous-snapshot",
      vector: semanticVector("previous")
    });
    await expect(indexCanonicalEvidence({
      evidence,
      sourceUploadIdByObjectId: sourceUploadOwners(evidence),
      provider,
      index
    })).rejects.toThrow(/ownership changed/u);
  });
});
