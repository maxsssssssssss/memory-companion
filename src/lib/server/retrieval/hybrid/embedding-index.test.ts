import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { HYBRID_EMBEDDING_DIMENSION } from "./embedding-provider";
import {
  SqliteEmbeddingIndex,
  embeddingContentHash
} from "./embedding-index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("SqliteEmbeddingIndex", () => {
  it("stores evidence vectors in a sidecar without touching Memory schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const index = new SqliteEmbeddingIndex(join(directory, "hybrid-embeddings.sqlite"), {
      modelName: "Qwen/Qwen3-Embedding-0.6B",
      modelVersion: "revision-1",
      dimension: HYBRID_EMBEDDING_DIMENSION
    });
    const vector = Array.from({ length: HYBRID_EMBEDDING_DIMENSION }, (_, offset) =>
      offset === 0 ? 1 : 0
    );

    index.upsert({
      objectType: "evidence",
      objectId: "evidence-1",
      contentHash: embeddingContentHash("原始证据"),
      vector
    });

    expect(index.get("evidence", "evidence-1")).toMatchObject({
      objectType: "evidence",
      objectId: "evidence-1",
      modelName: "Qwen/Qwen3-Embedding-0.6B",
      modelVersion: "revision-1",
      dimension: 1024,
      contentHash: embeddingContentHash("原始证据")
    });
    expect(index.list("memory")).toEqual([]);
    expect(index.list("evidence")[0]?.vector).toEqual(vector);
    index.close();
  });

  it("updates changed content and removes stale evidence only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const index = new SqliteEmbeddingIndex(join(directory, "hybrid-embeddings.sqlite"), {
      modelName: "Qwen/Qwen3-Embedding-0.6B",
      modelVersion: "revision-1",
      dimension: HYBRID_EMBEDDING_DIMENSION
    });
    const vector = Array.from({ length: HYBRID_EMBEDDING_DIMENSION }, () => 0.5);
    for (const objectId of ["keep", "remove"]) {
      index.upsert({
        objectType: "evidence",
        objectId,
        contentHash: embeddingContentHash(objectId),
        vector
      });
    }

    expect(index.removeMissing("evidence", new Set(["keep"]))).toBe(1);
    expect(index.list("evidence").map((entry) => entry.objectId)).toEqual(["keep"]);
    index.close();
  });

  it("isolates identical evidence IDs by exact model revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "hybrid-embeddings.sqlite");
    const vector = Array.from({ length: HYBRID_EMBEDDING_DIMENSION }, (_, index) =>
      index === 0 ? 1 : 0
    );
    const revisionOne = new SqliteEmbeddingIndex(databasePath, {
      modelName: "Qwen/Qwen3-Embedding-0.6B",
      modelVersion: "revision-1",
      dimension: HYBRID_EMBEDDING_DIMENSION
    });
    revisionOne.upsert({
      objectType: "evidence",
      objectId: "same-id",
      contentHash: embeddingContentHash("相同内容"),
      vector
    });
    revisionOne.close();

    const revisionTwo = new SqliteEmbeddingIndex(databasePath, {
      modelName: "Qwen/Qwen3-Embedding-0.6B",
      modelVersion: "revision-2",
      dimension: HYBRID_EMBEDDING_DIMENSION
    });
    expect(revisionTwo.get("evidence", "same-id")).toBeNull();
    revisionTwo.upsert({
      objectType: "evidence",
      objectId: "same-id",
      contentHash: embeddingContentHash("相同内容"),
      vector
    });
    expect(revisionTwo.get("evidence", "same-id")?.modelVersion).toBe("revision-2");
    revisionTwo.close();

    const reopenedRevisionOne = new SqliteEmbeddingIndex(databasePath, {
      modelName: "Qwen/Qwen3-Embedding-0.6B",
      modelVersion: "revision-1",
      dimension: HYBRID_EMBEDDING_DIMENSION
    });
    expect(reopenedRevisionOne.get("evidence", "same-id")?.modelVersion).toBe("revision-1");
    reopenedRevisionOne.close();
  });

  it("supports read-only ID-filtered access and rejects writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "hybrid-embeddings.sqlite");
    const model = {
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelVersion: "revision-4b",
      dimension: 4
    };
    const writer = new SqliteEmbeddingIndex(databasePath, model);
    writer.upsert({
      objectType: "evidence",
      objectId: "keep",
      contentHash: embeddingContentHash("keep"),
      vector: [1, 0, 0, 0]
    });
    writer.upsert({
      objectType: "evidence",
      objectId: "ignore",
      contentHash: embeddingContentHash("ignore"),
      vector: [0, 1, 0, 0]
    });
    writer.close();

    const reader = new SqliteEmbeddingIndex(databasePath, model, {
      readonly: true
    });
    expect(reader.getMany("evidence", ["keep"]).map((item) => item.objectId))
      .toEqual(["keep"]);
    expect(() => reader.upsert({
      objectType: "evidence",
      objectId: "forbidden",
      contentHash: embeddingContentHash("forbidden"),
      vector: [0, 0, 1, 0]
    })).toThrow(/read-only/u);
    reader.close();
  });
});
