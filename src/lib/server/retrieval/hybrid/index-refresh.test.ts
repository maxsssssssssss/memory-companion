// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import type { EmbeddingProvider } from "./embedding-provider";
import { embeddingContentHash, SqliteEmbeddingIndex } from "./embedding-index";
import {
  canonicalEvidenceEmbeddingText
} from "./dense-retrieval";
import {
  canonicalEvidenceForUpload,
  deletePendingHybridIndexEvidence,
  refreshHybridEvidenceIndex
} from "./index-refresh";
import {
  buildHybridIndexRetentionManifest,
  HYBRID_INDEX_RETENTIONS_COLLECTION,
  readHybridIndexDeletion,
  requestHybridIndexDeletion,
  writeHybridIndexRetentionManifest
} from "./retention-manifest";
import {
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "./runtime-config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("user-scoped Hybrid evidence index refresh", () => {
  it("indexes all ready evidence and removes stale entries on the next snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-index-refresh-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(join(directory, "store"));
    const indexPath = join(directory, "index.sqlite");
    const upload: AudioUpload = {
      id: "upload-1",
      originalName: "recording.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-30",
      status: "ready"
    };
    const segment: TranscriptSegment = {
      id: "segment-1",
      uploadId: upload.id,
      speaker: "speaker_1",
      startSeconds: 0,
      endSeconds: 5,
      text: "最终安排是周日下午两点。",
      confidence: 1,
      sceneLabels: ["unknown"],
      valueLabels: []
    };
    await store.write("uploads", upload.id, upload);
    await store.write("segments", upload.id, [segment]);
    const provider: EmbeddingProvider = {
      config: {
        modelName: "test-embedding",
        modelVersion: "revision-1",
        dimension: 4
      },
      embed: vi.fn(async (texts) =>
        texts.map(() => [1, 0, 0, 0])
      )
    };
    const progress: string[] = [];
    const first = await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath,
      batchSize: 1,
      onProgress: (item) => {
        progress.push(`${item.stage}:${item.completed}/${item.total}`);
      }
    });
    expect(first).toMatchObject({
      uploadCount: 1,
      total: 1,
      embedded: 1,
      removed: 0
    });
    expect(progress).toContain("completed:1/1");
    const ownershipReader = new SqliteEmbeddingIndex(indexPath, provider.config, {
      readonly: true
    });
    expect(ownershipReader.listMetadata("evidence")[0]?.sourceUploadId)
      .toBe(upload.id);
    ownershipReader.close();

    await store.delete("uploads", upload.id);
    const second = await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath
    });
    expect(second).toMatchObject({
      uploadCount: 0,
      total: 0,
      embedded: 0,
      removed: 1
    });
    const reader = new SqliteEmbeddingIndex(indexPath, provider.config, {
      readonly: true
    });
    expect(reader.list("evidence")).toEqual([]);
    reader.close();
  });

  it("preserves browser-cached manifests across restart refresh and removes them after deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-index-retained-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(join(directory, "store"));
    const indexPath = join(directory, "index.sqlite");
    const upload: AudioUpload & { status: "ready" } = {
      id: "upload_retained",
      originalName: "retained.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-08-06",
      status: "ready"
    };
    await store.write("uploads", upload.id, upload);
    await store.write("segments", upload.id, [{
      id: "segment_retained",
      uploadId: upload.id,
      speaker: "speaker_1",
      startSeconds: 0,
      endSeconds: 5,
      text: "周日两点见面。",
      confidence: 1,
      sceneLabels: ["unknown"],
      valueLabels: []
    } satisfies TranscriptSegment]);
    const provider: EmbeddingProvider = {
      config: { modelName: "test", modelVersion: "v1", dimension: 4 },
      embed: vi.fn(async (texts) => texts.map(() => [1, 0, 0, 0]))
    };
    await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath
    });
    const evidence = await canonicalEvidenceForUpload(store, upload);
    const manifest = buildHybridIndexRetentionManifest({
      uploadId: upload.id,
      evidence: evidence.map((item) => ({
        objectId: item.id,
        contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(item))
      })),
      preparedAt: "2026-08-06T08:00:00.000Z"
    });
    await writeHybridIndexRetentionManifest(store, manifest);
    await store.delete("uploads", upload.id);
    await store.delete("segments", upload.id);

    const wrongOwner = new Database(indexPath);
    wrongOwner.prepare(
      "UPDATE embedding_index SET source_upload_id = ? WHERE object_id = ?"
    ).run("upload_wrong_owner", evidence[0]!.id);
    wrongOwner.close();
    await expect(refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath
    })).rejects.toThrow(/ownership mismatch/u);

    const legacyOwner = new Database(indexPath);
    legacyOwner.prepare(
      "UPDATE embedding_index SET source_upload_id = NULL WHERE object_id = ?"
    ).run(evidence[0]!.id);
    legacyOwner.close();

    const afterRestart = await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath
    });
    expect(afterRestart).toMatchObject({
      uploadCount: 0,
      retainedUploadCount: 1,
      removed: 0
    });
    const retainedReader = new SqliteEmbeddingIndex(indexPath, provider.config, {
      readonly: true
    });
    expect(retainedReader.list("evidence")).toHaveLength(1);
    expect(retainedReader.list("evidence")[0]?.sourceUploadId).toBe(upload.id);
    retainedReader.close();

    await requestHybridIndexDeletion(store, {
      uploadId: upload.id,
      evidence: manifest.evidence,
      requestedAt: "2026-08-06T08:01:00.000Z"
    });
    const deleted = await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath
    });
    expect(deleted).toMatchObject({
      retainedUploadCount: 0,
      completedDeletionCount: 1,
      removed: 1
    });
    await expect(readHybridIndexDeletion(store, upload.id)).resolves.toMatchObject({
      status: "completed"
    });
    const deletedReader = new SqliteEmbeddingIndex(indexPath, provider.config, {
      readonly: true
    });
    expect(deletedReader.list("evidence")).toEqual([]);
    deletedReader.close();
  });

  it("deletes pending vectors locally without calling the provider or validating unrelated snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-index-delete-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(join(directory, "store"));
    const indexPath = join(directory, "index.sqlite");
    const upload: AudioUpload & { status: "ready" } = {
      id: "upload_delete_local",
      originalName: "delete.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-08-06",
      status: "ready"
    };
    await store.write("uploads", upload.id, upload);
    await store.write("segments", upload.id, [{
      id: "segment_delete_local",
      uploadId: upload.id,
      speaker: "speaker_1",
      startSeconds: 0,
      endSeconds: 5,
      text: "Delete this retained record.",
      confidence: 1,
      sceneLabels: ["unknown"],
      valueLabels: []
    } satisfies TranscriptSegment]);
    const vector = Array.from(
      { length: QWEN3_EMBEDDING_4B_DIMENSION },
      (_, index) => index === 0 ? 1 : 0
    );
    const embed = vi.fn(async (texts: string[]) => texts.map(() => vector));
    const provider: EmbeddingProvider = {
      config: {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: QWEN3_EMBEDDING_4B_REVISION,
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      },
      embed
    };
    await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath
    });
    const embedCallsBeforeDelete = embed.mock.calls.length;
    const evidence = await canonicalEvidenceForUpload(store, upload);
    await requestHybridIndexDeletion(store, {
      uploadId: upload.id,
      evidence: evidence.map((item) => ({
        objectId: item.id,
        contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(item))
      }))
    });
    const deletionWriter = new SqliteEmbeddingIndex(indexPath, provider.config);
    deletionWriter.upsert({
      objectType: "evidence",
      objectId: "stale_owned_by_deleted_upload",
      sourceUploadId: upload.id,
      contentHash: embeddingContentHash("stale owned row"),
      vector
    });
    deletionWriter.close();
    await store.write("uploads", "unrelated_corrupt", {
      id: "unrelated_corrupt",
      originalName: "corrupt.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-08-06",
      status: "ready"
    } satisfies AudioUpload);
    await store.write("segments", "unrelated_corrupt", {
      invalid: "not-an-array"
    });
    await store.write(HYBRID_INDEX_RETENTIONS_COLLECTION, "unrelated_corrupt", {
      invalid: "not-a-retention-manifest"
    });

    const deleted = await deletePendingHybridIndexEvidence({
      userId: "user_1",
      store,
      indexPath
    });

    expect(deleted).toMatchObject({ completed: 1, requested: 1, removed: 2 });
    expect(embed).toHaveBeenCalledTimes(embedCallsBeforeDelete);
    await expect(readHybridIndexDeletion(store, upload.id)).resolves.toMatchObject({
      status: "completed"
    });
    const reader = new SqliteEmbeddingIndex(indexPath, provider.config, {
      readonly: true
    });
    expect(reader.list("evidence")).toEqual([]);
    reader.close();
  });

  it("keeps deletion pending while any legacy sidecar row is unowned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-index-delete-legacy-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(join(directory, "store"));
    const indexPath = join(directory, "index.sqlite");
    const model = {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    };
    const vector = Array.from(
      { length: QWEN3_EMBEDDING_4B_DIMENSION },
      (_, index) => index === 0 ? 1 : 0
    );
    const targetHash = embeddingContentHash("target evidence");
    const writer = new SqliteEmbeddingIndex(indexPath, model);
    writer.upsert({
      objectType: "evidence",
      objectId: "target_evidence",
      sourceUploadId: "upload_target",
      contentHash: targetHash,
      vector
    });
    writer.upsert({
      objectType: "evidence",
      objectId: "ambiguous_legacy_evidence",
      sourceUploadId: "temporary_owner",
      contentHash: embeddingContentHash("ambiguous evidence"),
      vector
    });
    writer.close();
    const legacy = new Database(indexPath);
    legacy.prepare(`
      UPDATE embedding_index SET source_upload_id = NULL WHERE object_id = ?
    `).run("ambiguous_legacy_evidence");
    legacy.close();
    await requestHybridIndexDeletion(store, {
      uploadId: "upload_target",
      evidence: [{ objectId: "target_evidence", contentHash: targetHash }]
    });

    await expect(deletePendingHybridIndexEvidence({
      userId: "user_1",
      store,
      indexPath
    })).rejects.toThrow(/unowned legacy rows remain/u);
    await expect(readHybridIndexDeletion(store, "upload_target"))
      .resolves.toMatchObject({ status: "pending" });
    const reader = new SqliteEmbeddingIndex(indexPath, model, { readonly: true });
    expect(reader.listAllMetadata()).toHaveLength(2);
    reader.close();
  });
});
