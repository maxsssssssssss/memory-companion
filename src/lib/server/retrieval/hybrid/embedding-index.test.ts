import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
  it("migrates a pre-ownership sidecar and assigns an owner on upsert", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "hybrid-embeddings.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE embedding_index (
        id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL CHECK (object_type IN ('evidence', 'memory')),
        object_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_version TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (object_type, object_id, model_name, model_version, dimension)
      )
    `);
    legacy.close();

    const model = {
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelVersion: "revision-4b",
      dimension: 4
    };
    const index = new SqliteEmbeddingIndex(databasePath, model);
    index.upsert({
      objectType: "evidence",
      objectId: "migrated",
      sourceUploadId: "upload-owner",
      contentHash: embeddingContentHash("migrated"),
      vector: [1, 0, 0, 0]
    });

    expect(index.get("evidence", "migrated")?.sourceUploadId)
      .toBe("upload-owner");
    index.close();
  });

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
      sourceUploadId: "upload-1",
      contentHash: embeddingContentHash("原始证据"),
      vector
    });

    expect(index.get("evidence", "evidence-1")).toMatchObject({
      objectType: "evidence",
      objectId: "evidence-1",
      sourceUploadId: "upload-1",
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
        sourceUploadId: "upload-1",
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
      sourceUploadId: "upload-1",
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
      sourceUploadId: "upload-1",
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
      sourceUploadId: "upload-1",
      contentHash: embeddingContentHash("keep"),
      vector: [1, 0, 0, 0]
    });
    writer.upsert({
      objectType: "evidence",
      objectId: "ignore",
      sourceUploadId: "upload-2",
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
      sourceUploadId: "upload-1",
      contentHash: embeddingContentHash("forbidden"),
      vector: [0, 0, 1, 0]
    })).toThrow(/read-only/u);
    reader.close();
  });

  it("deletes only exact content hashes and exposes metadata without vectors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "hybrid-embeddings.sqlite");
    const model = {
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelVersion: "revision-4b",
      dimension: 4
    };
    const index = new SqliteEmbeddingIndex(databasePath, model);
    const keepHash = embeddingContentHash("keep");
    const deleteHash = embeddingContentHash("delete");
    index.upsert({
      objectType: "evidence",
      objectId: "keep",
      sourceUploadId: "upload-keep",
      contentHash: keepHash,
      vector: [1, 0, 0, 0]
    });
    index.upsert({
      objectType: "evidence",
      objectId: "delete",
      sourceUploadId: "upload-delete",
      contentHash: deleteHash,
      vector: [0, 1, 0, 0]
    });

    expect(index.listMetadata("evidence")[0]).not.toHaveProperty("vector");
    expect(() => index.deleteExact({
      objectType: "evidence",
      expectedContentHashes: new Map([["delete", keepHash]])
    })).toThrow(/content hash mismatch/u);
    expect(index.get("evidence", "delete")).not.toBeNull();
    expect(index.deleteExact({
      objectType: "evidence",
      expectedContentHashes: new Map([["delete", deleteHash]])
    })).toEqual({ requested: 1, removed: 1, alreadyMissing: 0 });
    expect(index.listMetadata("evidence").map((entry) => entry.objectId))
      .toEqual(["keep"]);
    index.close();
  });

  it("deletes every row owned by one upload without touching another upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const index = new SqliteEmbeddingIndex(join(directory, "hybrid-embeddings.sqlite"), {
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelVersion: "revision-4b",
      dimension: 4
    });
    const targetHash = embeddingContentHash("target");
    index.upsert({
      objectType: "evidence",
      objectId: "target",
      sourceUploadId: "upload-target",
      contentHash: targetHash,
      vector: [1, 0, 0, 0]
    });
    index.upsert({
      objectType: "evidence",
      objectId: "target-stale",
      sourceUploadId: "upload-target",
      contentHash: embeddingContentHash("stale"),
      vector: [0, 1, 0, 0]
    });
    index.upsert({
      objectType: "evidence",
      objectId: "keep",
      sourceUploadId: "upload-keep",
      contentHash: embeddingContentHash("keep"),
      vector: [0, 0, 1, 0]
    });

    expect(index.deleteUpload({
      sourceUploadId: "upload-target",
      expectedContentHashes: new Map([["target", targetHash]])
    })).toEqual({ requested: 1, removed: 2, alreadyMissing: 0 });
    expect(index.listMetadata("evidence").map((entry) => entry.objectId))
      .toEqual(["keep"]);
    index.close();
  });

  it("safely claims exact retained rows from a pre-ownership sidecar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "hybrid-embeddings.sqlite");
    const model = {
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelVersion: "revision-4b",
      dimension: 4
    };
    const contentHash = embeddingContentHash("retained");
    const writer = new SqliteEmbeddingIndex(databasePath, model);
    writer.upsert({
      objectType: "evidence",
      objectId: "retained",
      sourceUploadId: "temporary-owner",
      contentHash,
      vector: [1, 0, 0, 0]
    });
    writer.close();
    const legacy = new Database(databasePath);
    legacy.prepare(
      "UPDATE embedding_index SET source_upload_id = NULL WHERE object_id = ?"
    ).run("retained");
    legacy.close();

    const index = new SqliteEmbeddingIndex(databasePath, model);
    expect(index.claimLegacyOwnership({
      objectType: "evidence",
      sourceUploadId: "upload-retained",
      expectedContentHashes: new Map([["retained", contentHash]])
    })).toEqual({ requested: 1, claimed: 1, alreadyOwned: 0 });
    expect(index.get("evidence", "retained")?.sourceUploadId)
      .toBe("upload-retained");
    expect(index.claimLegacyOwnership({
      objectType: "evidence",
      sourceUploadId: "upload-retained",
      expectedContentHashes: new Map([["retained", contentHash]])
    })).toEqual({ requested: 1, claimed: 0, alreadyOwned: 1 });
    expect(() => index.claimLegacyOwnership({
      objectType: "evidence",
      sourceUploadId: "different-upload",
      expectedContentHashes: new Map([["retained", contentHash]])
    })).toThrow(/ownership mismatch/u);
    index.close();
  });

  it("refuses upload deletion while an unrelated legacy row is unowned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "hybrid-embeddings.sqlite");
    const model = {
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelVersion: "revision-4b",
      dimension: 4
    };
    const targetHash = embeddingContentHash("target");
    const writer = new SqliteEmbeddingIndex(databasePath, model);
    writer.upsert({
      objectType: "evidence",
      objectId: "target",
      sourceUploadId: "temporary-target-owner",
      contentHash: targetHash,
      vector: [1, 0, 0, 0]
    });
    writer.upsert({
      objectType: "evidence",
      objectId: "ambiguous",
      sourceUploadId: "temporary-ambiguous-owner",
      contentHash: embeddingContentHash("ambiguous"),
      vector: [0, 1, 0, 0]
    });
    writer.close();
    const legacy = new Database(databasePath);
    legacy.prepare("UPDATE embedding_index SET source_upload_id = NULL").run();
    legacy.close();

    let index = new SqliteEmbeddingIndex(databasePath, model);
    expect(() => index.deleteUpload({
      sourceUploadId: "upload-target",
      expectedContentHashes: new Map([["target", targetHash]])
    })).toThrow(/unowned legacy rows remain/u);
    expect(index.listAllMetadata()).toHaveLength(2);
    index.close();

    const repaired = new Database(databasePath);
    repaired.prepare(`
      UPDATE embedding_index SET source_upload_id = ? WHERE object_id = ?
    `).run("upload-unrelated", "ambiguous");
    repaired.close();
    index = new SqliteEmbeddingIndex(databasePath, model);
    expect(index.deleteUpload({
      sourceUploadId: "upload-target",
      expectedContentHashes: new Map([["target", targetHash]])
    })).toEqual({ requested: 1, removed: 1, alreadyMissing: 0 });
    expect(index.listAllMetadata()).toMatchObject([{
      objectId: "ambiguous",
      sourceUploadId: "upload-unrelated"
    }]);
    index.close();
  });

  it("rejects deletion when an expected object is owned by another upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-hybrid-index-"));
    temporaryDirectories.push(directory);
    const index = new SqliteEmbeddingIndex(join(directory, "hybrid-embeddings.sqlite"), {
      modelName: "Qwen/Qwen3-Embedding-4B",
      modelVersion: "revision-4b",
      dimension: 4
    });
    const contentHash = embeddingContentHash("shared");
    index.upsert({
      objectType: "evidence",
      objectId: "shared",
      sourceUploadId: "upload-owner",
      contentHash,
      vector: [1, 0, 0, 0]
    });

    expect(() => index.deleteUpload({
      sourceUploadId: "upload-requester",
      expectedContentHashes: new Map([["shared", contentHash]])
    })).toThrow(/ownership mismatch/u);
    expect(index.get("evidence", "shared")?.sourceUploadId).toBe("upload-owner");
    index.close();
  });
});
