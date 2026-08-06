// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  HYBRID_EVIDENCE_PROJECTION_VERSION,
  HYBRID_INDEX_DELETIONS_COLLECTION,
  HYBRID_INDEX_RETENTIONS_COLLECTION,
  HybridIndexDeletionSchema,
  HybridIndexRetentionManifestSchema,
  buildHybridIndexRetentionManifest,
  canonicalizeHybridIndexRetentionEvidence,
  completeHybridIndexDeletion,
  deleteHybridIndexDeletion,
  deleteHybridIndexRetentionManifest,
  hybridIndexRetentionCorpusHash,
  listHybridIndexDeletions,
  listHybridIndexRetentionManifests,
  readHybridIndexDeletion,
  readHybridIndexRetentionManifest,
  requestHybridIndexDeletion,
  writeHybridIndexRetentionManifest
} from "./retention-manifest";
import {
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "./runtime-config";

const temporaryDirectories: string[] = [];
const preparedAt = "2026-08-06T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function testStore() {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-retention-"));
  temporaryDirectories.push(directory);
  return new JsonStore(directory);
}

const evidence = [
  { objectId: "evidence_b", contentHash: digest("b") },
  { objectId: "evidence_a", contentHash: digest("a") }
];

describe("Hybrid index retention manifest", () => {
  it("builds a fixed 4B/2560 content-free manifest with stable deduplication", () => {
    const manifest = buildHybridIndexRetentionManifest({
      uploadId: "upload_1",
      evidence: [evidence[0]!, evidence[1]!, evidence[0]!],
      preparedAt
    });

    expect(manifest).toMatchObject({
      projectionVersion: HYBRID_EVIDENCE_PROJECTION_VERSION,
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION,
      uploadId: "upload_1",
      preparedAt
    });
    expect(manifest.evidence.map((item) => item.objectId)).toEqual([
      "evidence_a",
      "evidence_b"
    ]);
    expect(manifest.corpusHash).toBe(hybridIndexRetentionCorpusHash(evidence));
    expect(JSON.stringify(manifest)).not.toMatch(/text|vector|原文/iu);
  });

  it("fails closed on conflicting ids and non-canonical or corrupted documents", () => {
    expect(() => canonicalizeHybridIndexRetentionEvidence([
      { objectId: "same", contentHash: digest("first") },
      { objectId: "same", contentHash: digest("second") }
    ])).toThrow(/conflicting content hashes/u);

    const manifest = buildHybridIndexRetentionManifest({
      uploadId: "upload_1",
      evidence,
      preparedAt
    });
    expect(HybridIndexRetentionManifestSchema.safeParse({
      ...manifest,
      evidence: [...manifest.evidence].reverse()
    }).success).toBe(false);
    expect(HybridIndexRetentionManifestSchema.safeParse({
      ...manifest,
      corpusHash: digest("wrong")
    }).success).toBe(false);
    expect(HybridIndexRetentionManifestSchema.safeParse({
      ...manifest,
      projectionVersion: 2
    }).success).toBe(false);
    expect(HybridIndexRetentionManifestSchema.safeParse({
      ...manifest,
      modelVersion: "main"
    }).success).toBe(false);
    expect(HybridIndexRetentionManifestSchema.safeParse({
      ...manifest,
      evidence: manifest.evidence.map((item) => ({ ...item, text: "forbidden" }))
    }).success).toBe(false);
  });

  it("writes, validates, lists, reads, and deletes user-scoped manifests", async () => {
    const store = await testStore();
    const second = buildHybridIndexRetentionManifest({
      uploadId: "upload_b",
      evidence: [evidence[1]!],
      preparedAt
    });
    const first = buildHybridIndexRetentionManifest({
      uploadId: "upload_a",
      evidence: [evidence[0]!],
      preparedAt
    });
    await writeHybridIndexRetentionManifest(store, second);
    await writeHybridIndexRetentionManifest(store, first);

    await expect(readHybridIndexRetentionManifest(store, "upload_a"))
      .resolves.toEqual(first);
    await expect(listHybridIndexRetentionManifests(store))
      .resolves.toEqual([first, second]);

    await store.write(HYBRID_INDEX_RETENTIONS_COLLECTION, "corrupt", {
      ...first,
      uploadId: "corrupt",
      corpusHash: digest("corrupt")
    });
    await expect(readHybridIndexRetentionManifest(store, "corrupt")).rejects.toThrow();

    await deleteHybridIndexRetentionManifest(store, "upload_a");
    await expect(readHybridIndexRetentionManifest(store, "upload_a"))
      .resolves.toBeNull();
  });
});

describe("Hybrid index deletion requests", () => {
  it("keeps pending requests idempotent and refuses a different corpus", async () => {
    const store = await testStore();
    const pending = await requestHybridIndexDeletion(store, {
      uploadId: "upload_1",
      evidence,
      requestedAt: preparedAt
    });
    expect(pending.status).toBe("pending");
    await expect(requestHybridIndexDeletion(store, {
      uploadId: "upload_1",
      evidence: [...evidence].reverse(),
      requestedAt: "2026-08-06T08:01:00.000Z"
    })).resolves.toEqual(pending);
    await expect(requestHybridIndexDeletion(store, {
      uploadId: "upload_1",
      evidence: [{ objectId: "other", contentHash: digest("other") }]
    })).rejects.toThrow(/different corpus/u);
  });

  it("lists by status and completes only the exact corpus", async () => {
    const store = await testStore();
    const first = await requestHybridIndexDeletion(store, {
      uploadId: "upload_a",
      evidence: [evidence[0]!],
      requestedAt: preparedAt
    });
    await requestHybridIndexDeletion(store, {
      uploadId: "upload_b",
      evidence: [evidence[1]!],
      requestedAt: preparedAt
    });
    await expect(completeHybridIndexDeletion(store, {
      uploadId: "upload_a",
      corpusHash: digest("wrong")
    })).rejects.toThrow(/corpus changed/u);

    const completed = await completeHybridIndexDeletion(store, {
      uploadId: "upload_a",
      corpusHash: first.corpusHash,
      completedAt: "2026-08-06T08:02:00.000Z"
    });
    expect(completed).toMatchObject({
      status: "completed",
      completedAt: "2026-08-06T08:02:00.000Z"
    });
    await expect(completeHybridIndexDeletion(store, {
      uploadId: "upload_a",
      corpusHash: first.corpusHash,
      completedAt: "2026-08-06T08:03:00.000Z"
    })).resolves.toEqual(completed);
    await expect(listHybridIndexDeletions(store, "pending"))
      .resolves.toMatchObject([{ uploadId: "upload_b", status: "pending" }]);
    await expect(listHybridIndexDeletions(store, "completed"))
      .resolves.toEqual([completed]);

    await deleteHybridIndexDeletion(store, "upload_a");
    await expect(readHybridIndexDeletion(store, "upload_a")).resolves.toBeNull();
  });

  it("rejects strict deletion documents and missing completion requests", async () => {
    const store = await testStore();
    const pending = await requestHybridIndexDeletion(store, {
      uploadId: "upload_1",
      evidence,
      requestedAt: preparedAt
    });
    expect(HybridIndexDeletionSchema.safeParse({
      ...pending,
      text: "forbidden"
    }).success).toBe(false);
    await expect(completeHybridIndexDeletion(store, {
      uploadId: "missing",
      corpusHash: pending.corpusHash
    })).rejects.toThrow(/not found/u);
    expect(await store.read(HYBRID_INDEX_DELETIONS_COLLECTION, "upload_1"))
      .not.toHaveProperty("text");
  });
});
