// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import { canonicalEvidenceEmbeddingText } from "./dense-retrieval";
import { embeddingContentHash, SqliteEmbeddingIndex } from "./embedding-index";
import { canonicalEvidenceForUpload } from "./index-refresh";
import {
  completeHybridIndexDeletion,
  HYBRID_INDEX_RETENTIONS_COLLECTION,
  readHybridIndexDeletion,
  readHybridIndexRetentionManifest,
  requestHybridIndexDeletion
} from "./retention-manifest";
import {
  prepareHybridIndexRetention,
  requiresHybridPermanentIndexDeletion
} from "./retention-runtime";
import {
  hybridEmbeddingIndexPath,
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "./runtime-config";

const roots: string[] = [];
const originalDataRoot = process.env.APP_DATA_DIR;
const originalModel = process.env.HYBRID_EMBEDDING_MODEL;
const originalVersion = process.env.HYBRID_EMBEDDING_MODEL_VERSION;
const originalDimension = process.env.HYBRID_EMBEDDING_DIMENSION;
const originalBaseUrl = process.env.HYBRID_EMBEDDING_BASE_URL;

afterEach(async () => {
  if (originalDataRoot === undefined) delete process.env.APP_DATA_DIR;
  else process.env.APP_DATA_DIR = originalDataRoot;
  if (originalModel === undefined) delete process.env.HYBRID_EMBEDDING_MODEL;
  else process.env.HYBRID_EMBEDDING_MODEL = originalModel;
  if (originalVersion === undefined) delete process.env.HYBRID_EMBEDDING_MODEL_VERSION;
  else process.env.HYBRID_EMBEDDING_MODEL_VERSION = originalVersion;
  if (originalDimension === undefined) delete process.env.HYBRID_EMBEDDING_DIMENSION;
  else process.env.HYBRID_EMBEDDING_DIMENSION = originalDimension;
  if (originalBaseUrl === undefined) delete process.env.HYBRID_EMBEDDING_BASE_URL;
  else process.env.HYBRID_EMBEDDING_BASE_URL = originalBaseUrl;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Hybrid browser-cache retention preparation", () => {
  it("removes a manifest when permanent deletion starts during its write", async () => {
    const root = await mkdtemp(join(tmpdir(), "hybrid-retention-race-"));
    roots.push(root);
    class DeletionRaceStore extends JsonStore {
      injected = false;

      override async write(collection: string, id: string, value: unknown) {
        await super.write(collection, id, value);
        if (
          collection === HYBRID_INDEX_RETENTIONS_COLLECTION &&
          !this.injected
        ) {
          this.injected = true;
          await requestHybridIndexDeletion(this, {
            uploadId: id,
            evidence: []
          });
        }
      }
    }
    const store = new DeletionRaceStore(join(root, "users", "user_1"));
    const upload: AudioUpload & { status: "ready" } = {
      id: "upload_race",
      originalName: "empty.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 1,
      recordingDate: "2026-08-06",
      status: "ready"
    };
    await store.write("uploads", upload.id, upload);

    await expect(prepareHybridIndexRetention({
      userId: "user_1",
      store,
      upload
    })).rejects.toThrow(/deletion already exists/u);
    await expect(readHybridIndexRetentionManifest(store, upload.id))
      .resolves.toBeNull();
    await expect(readHybridIndexDeletion(store, upload.id))
      .resolves.toMatchObject({ status: "pending" });
  });

  it("withdraws a manifest when the canonical projection changes during preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hybrid-retention-projection-race-"));
    roots.push(root);
    process.env.APP_DATA_DIR = root;
    process.env.HYBRID_EMBEDDING_BASE_URL = "http://127.0.0.1:18080/v1";
    process.env.HYBRID_EMBEDDING_MODEL = QWEN3_EMBEDDING_4B_MODEL;
    process.env.HYBRID_EMBEDDING_MODEL_VERSION = QWEN3_EMBEDDING_4B_REVISION;
    process.env.HYBRID_EMBEDDING_DIMENSION = String(QWEN3_EMBEDDING_4B_DIMENSION);
    class ProjectionRaceStore extends JsonStore {
      replacement: TranscriptSegment[] = [];
      injected = false;

      override async write(collection: string, id: string, value: unknown) {
        await super.write(collection, id, value);
        if (
          collection === HYBRID_INDEX_RETENTIONS_COLLECTION &&
          !this.injected
        ) {
          this.injected = true;
          await super.write("segments", id, this.replacement);
        }
      }
    }
    const store = new ProjectionRaceStore(join(root, "users", "user_1"));
    const upload: AudioUpload & { status: "ready" } = {
      id: "upload_projection_race",
      originalName: "sample.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 1,
      recordingDate: "2026-08-06",
      status: "ready"
    };
    const segment = (text: string): TranscriptSegment => ({
      id: "segment_projection_race",
      uploadId: upload.id,
      speaker: "speaker_1",
      startSeconds: 0,
      endSeconds: 4,
      text,
      confidence: 1,
      sceneLabels: ["unknown"],
      valueLabels: []
    });
    await store.write("uploads", upload.id, upload);
    await store.write("segments", upload.id, [segment("version one")]);
    store.replacement = [segment("version two")];
    const evidence = await canonicalEvidenceForUpload(store, upload);
    const index = new SqliteEmbeddingIndex(hybridEmbeddingIndexPath("user_1"), {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    });
    index.upsert({
      objectType: "evidence",
      objectId: evidence[0]!.id,
      sourceUploadId: upload.id,
      contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(evidence[0]!)),
      vector: Array.from(
        { length: QWEN3_EMBEDDING_4B_DIMENSION },
        (_, vectorIndex) => vectorIndex === 0 ? 1 : 0
      )
    });
    index.close();

    await expect(prepareHybridIndexRetention({
      userId: "user_1",
      store,
      upload
    })).resolves.toEqual({ status: "pending", matched: 0, total: 1 });
    await expect(readHybridIndexRetentionManifest(store, upload.id))
      .resolves.toBeNull();
  });

  it("refuses cleanup until exact vectors exist, then persists only a manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "hybrid-retention-runtime-"));
    roots.push(root);
    process.env.APP_DATA_DIR = root;
    process.env.HYBRID_EMBEDDING_BASE_URL = "http://127.0.0.1:18080/v1";
    process.env.HYBRID_EMBEDDING_MODEL = QWEN3_EMBEDDING_4B_MODEL;
    process.env.HYBRID_EMBEDDING_MODEL_VERSION = QWEN3_EMBEDDING_4B_REVISION;
    process.env.HYBRID_EMBEDDING_DIMENSION = String(QWEN3_EMBEDDING_4B_DIMENSION);
    const store = new JsonStore(join(root, "users", "user_1"));
    const upload: AudioUpload & { status: "ready" } = {
      id: "upload_1",
      originalName: "sample.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 1,
      recordingDate: "2026-08-06",
      status: "ready"
    };
    const segment: TranscriptSegment = {
      id: "segment_1",
      uploadId: upload.id,
      speaker: "speaker_1",
      startSeconds: 0,
      endSeconds: 4,
      text: "最终安排在周日。",
      confidence: 1,
      sceneLabels: ["unknown"],
      valueLabels: []
    };
    await store.write("uploads", upload.id, upload);
    await store.write("segments", upload.id, [segment]);

    await expect(prepareHybridIndexRetention({
      userId: "user_1",
      store,
      upload
    })).resolves.toMatchObject({ status: "pending", matched: 0, total: 1 });
    await expect(readHybridIndexRetentionManifest(store, upload.id)).resolves.toBeNull();

    const evidence = await canonicalEvidenceForUpload(store, upload);
    const index = new SqliteEmbeddingIndex(hybridEmbeddingIndexPath("user_1"), {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    });
    const vector = Array.from(
      { length: QWEN3_EMBEDDING_4B_DIMENSION },
      (_, index) => index === 0 ? 1 : 0
    );
    index.upsert({
      objectType: "evidence",
      objectId: evidence[0]!.id,
      sourceUploadId: "upload_wrong_owner",
      contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(evidence[0]!)),
      vector
    });
    index.close();

    await expect(prepareHybridIndexRetention({
      userId: "user_1",
      store,
      upload
    })).resolves.toMatchObject({ status: "pending", matched: 0, total: 1 });
    await expect(readHybridIndexRetentionManifest(store, upload.id)).resolves.toBeNull();

    const ownershipWriter = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath("user_1"),
      {
        modelName: QWEN3_EMBEDDING_4B_MODEL,
        modelVersion: QWEN3_EMBEDDING_4B_REVISION,
        dimension: QWEN3_EMBEDDING_4B_DIMENSION
      }
    );
    ownershipWriter.upsert({
      objectType: "evidence",
      objectId: evidence[0]!.id,
      sourceUploadId: upload.id,
      contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(evidence[0]!)),
      vector
    });
    ownershipWriter.close();

    await expect(prepareHybridIndexRetention({
      userId: "user_1",
      store,
      upload
    })).resolves.toMatchObject({ status: "prepared", matched: 1, total: 1 });
    const manifest = await readHybridIndexRetentionManifest(store, upload.id);
    expect(manifest).toMatchObject({ uploadId: upload.id, evidence: [{ objectId: evidence[0]!.id }] });
    expect(JSON.stringify(manifest)).not.toContain(segment.text);
    await expect(requiresHybridPermanentIndexDeletion({
      userId: "user_1",
      store,
      uploadId: upload.id,
      hasLiveUpload: false,
      retentionPolicyEnabled: false,
      retrievalEnabled: false
    })).resolves.toBe(true);
    const deletion = await requestHybridIndexDeletion(store, {
      uploadId: upload.id,
      evidence: manifest!.evidence
    });
    await expect(prepareHybridIndexRetention({
      userId: "user_1",
      store,
      upload
    })).rejects.toThrow(/deletion already exists/u);
    await completeHybridIndexDeletion(store, {
      uploadId: upload.id,
      corpusHash: deletion.corpusHash
    });
    await expect(prepareHybridIndexRetention({
      userId: "user_1",
      store,
      upload
    })).rejects.toThrow(/deletion already exists/u);
  });

  it("scans every sidecar partition before deleting a source-less interaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hybrid-retention-source-less-"));
    roots.push(root);
    process.env.APP_DATA_DIR = root;
    const userId = "user_source_less";
    const uploadId = "upload_source_less";
    const store = new JsonStore(join(root, "users", userId));
    const indexPath = hybridEmbeddingIndexPath(userId);
    const legacyModel = {
      modelName: "legacy/model",
      modelVersion: "legacy-revision",
      dimension: 4
    };
    const writer = new SqliteEmbeddingIndex(indexPath, legacyModel);
    writer.upsert({
      objectType: "evidence",
      objectId: "legacy_evidence",
      sourceUploadId: uploadId,
      contentHash: embeddingContentHash("legacy evidence"),
      vector: [1, 0, 0, 0]
    });
    writer.close();

    const requiresDeletion = () => requiresHybridPermanentIndexDeletion({
      userId,
      store,
      uploadId,
      hasLiveUpload: false,
      retentionPolicyEnabled: false,
      retrievalEnabled: false
    });
    await expect(requiresDeletion()).resolves.toBe(true);

    const unrelated = new Database(indexPath);
    unrelated.prepare(
      "UPDATE embedding_index SET source_upload_id = ? WHERE object_id = ?"
    ).run("upload_unrelated", "legacy_evidence");
    unrelated.close();
    await expect(requiresDeletion()).resolves.toBe(false);

    const unowned = new Database(indexPath);
    unowned.prepare(
      "UPDATE embedding_index SET source_upload_id = NULL WHERE object_id = ?"
    ).run("legacy_evidence");
    unowned.close();
    await expect(requiresDeletion()).resolves.toBe(true);

    await writeFile(indexPath, "not a sqlite database", "utf8");
    await expect(requiresDeletion()).rejects.toThrow();
  });
});
