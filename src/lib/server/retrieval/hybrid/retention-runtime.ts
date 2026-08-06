import { access } from "node:fs/promises";
import type { AudioUpload } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  canonicalEvidenceEmbeddingText
} from "./dense-retrieval";
import {
  embeddingContentHash,
  SqliteEmbeddingIndex
} from "./embedding-index";
import { canonicalEvidenceForUpload } from "./index-refresh";
import {
  buildHybridIndexRetentionManifest,
  deleteHybridIndexRetentionManifest,
  readHybridIndexDeletion,
  readHybridIndexRetentionManifest,
  requestHybridIndexDeletion,
  writeHybridIndexRetentionManifest,
  type HybridIndexRetentionEvidence
} from "./retention-manifest";
import {
  assertLocalQwen4BConfig,
  hybridEmbeddingIndexPath,
  qwenEmbeddingProviderForPurpose,
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "./runtime-config";

type ReadyUpload = AudioUpload & { status: "ready" };

async function retentionEvidenceForUpload(
  store: JsonStore,
  upload: ReadyUpload
): Promise<HybridIndexRetentionEvidence[]> {
  return (await canonicalEvidenceForUpload(store, upload)).map((evidence) => ({
    objectId: evidence.id,
    contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(evidence))
  }));
}

export type HybridRetentionPreparationResult =
  | {
      status: "prepared";
      matched: number;
      total: number;
    }
  | {
      status: "pending";
      matched: number;
      total: number;
    };

/**
 * Web-side retention preparation is deliberately read-only with respect to
 * SQLite. It persists only a content-free JsonStore manifest after exact
 * sidecar coverage has already been proven.
 */
export async function prepareHybridIndexRetention(input: {
  userId: string;
  store: JsonStore;
  upload: ReadyUpload;
}): Promise<HybridRetentionPreparationResult> {
  const assertDeletionAbsent = async () => {
    const deletion = await readHybridIndexDeletion(input.store, input.upload.id);
    if (deletion) {
      throw new Error("Hybrid index deletion already exists for this upload");
    }
  };
  const persistManifestWithDeletionBarrier = async (
    manifest: ReturnType<typeof buildHybridIndexRetentionManifest>
  ) => {
    await assertDeletionAbsent();
    await writeHybridIndexRetentionManifest(input.store, manifest);
    try {
      // The post-write check closes the async gap between the last read and
      // JsonStore's atomic rename. If explicit deletion won that race, remove
      // the stale manifest before acknowledging browser cleanup.
      await assertDeletionAbsent();
      const latestEvidence = await retentionEvidenceForUpload(
        input.store,
        input.upload
      );
      const latestManifest = buildHybridIndexRetentionManifest({
        uploadId: input.upload.id,
        evidence: latestEvidence
      });
      await assertDeletionAbsent();
      if (latestManifest.corpusHash !== manifest.corpusHash) {
        await deleteHybridIndexRetentionManifest(input.store, input.upload.id);
        return latestEvidence.length;
      }
      return null;
    } catch (error) {
      await deleteHybridIndexRetentionManifest(input.store, input.upload.id);
      throw error;
    }
  };
  await assertDeletionAbsent();
  const evidence = await retentionEvidenceForUpload(input.store, input.upload);
  const manifest = buildHybridIndexRetentionManifest({
    uploadId: input.upload.id,
    evidence
  });
  if (evidence.length === 0) {
    const changedTotal = await persistManifestWithDeletionBarrier(manifest);
    if (changedTotal !== null) {
      return { status: "pending", matched: 0, total: changedTotal };
    }
    return { status: "prepared", matched: 0, total: 0 };
  }
  const provider = qwenEmbeddingProviderForPurpose("query");
  assertLocalQwen4BConfig(provider);
  let matched = 0;
  try {
    const index = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath(input.userId),
      provider.config,
      { readonly: true }
    );
    try {
      const expected = new Map(
        manifest.evidence.map((entry) => [entry.objectId, entry.contentHash])
      );
      matched = index
        .getMany("evidence", [...expected.keys()])
        .filter((entry) =>
          expected.get(entry.objectId) === entry.contentHash &&
          entry.sourceUploadId === input.upload.id
        )
        .length;
    } finally {
      index.close();
    }
  } catch {
    return { status: "pending", matched: 0, total: evidence.length };
  }
  if (matched !== evidence.length) {
    return { status: "pending", matched, total: evidence.length };
  }
  const changedTotal = await persistManifestWithDeletionBarrier(manifest);
  if (changedTotal !== null) {
    return { status: "pending", matched: 0, total: changedTotal };
  }
  return { status: "prepared", matched, total: evidence.length };
}

export async function requiresHybridPermanentIndexDeletion(input: {
  userId: string;
  store: JsonStore;
  uploadId: string;
  hasLiveUpload: boolean;
  retentionPolicyEnabled?: boolean;
  retrievalEnabled?: boolean;
}) {
  const [deletion, retained] = await Promise.all([
    readHybridIndexDeletion(input.store, input.uploadId),
    readHybridIndexRetentionManifest(input.store, input.uploadId)
  ]);
  if (deletion || retained) return true;
  if (!input.hasLiveUpload) {
    const indexPath = hybridEmbeddingIndexPath(input.userId);
    try {
      await access(indexPath);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
    const index = new SqliteEmbeddingIndex(indexPath, {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    }, { readonly: true });
    try {
      return index.listAllMetadata().some((entry) =>
        entry.sourceUploadId === input.uploadId ||
        entry.sourceUploadId === null
      );
    } finally {
      index.close();
    }
  }
  if (input.retentionPolicyEnabled || input.retrievalEnabled) return true;
  try {
    await access(hybridEmbeddingIndexPath(input.userId));
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function requestHybridPermanentIndexDeletion(input: {
  store: JsonStore;
  uploadId: string;
  upload?: ReadyUpload | null;
}) {
  const existing = await readHybridIndexDeletion(input.store, input.uploadId);
  if (existing) return existing;
  const retained = await readHybridIndexRetentionManifest(
    input.store,
    input.uploadId
  );
  const evidence = retained?.evidence ?? (
    input.upload
      ? await retentionEvidenceForUpload(input.store, input.upload)
      : []
  );
  return requestHybridIndexDeletion(input.store, {
    uploadId: input.uploadId,
    evidence
  });
}
