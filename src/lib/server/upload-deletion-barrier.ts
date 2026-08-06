import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  readHybridIndexDeletion,
  readHybridIndexRetentionManifest
} from "@/lib/server/retrieval/hybrid/retention-manifest";

export type UploadCanonicalProjectionBlockReason =
  | "deletion"
  | "retention";

export async function uploadCanonicalProjectionBlockReason(
  store: JsonStore,
  uploadId: string
): Promise<UploadCanonicalProjectionBlockReason | null> {
  const [hybridDeletion, deletedUploadMarker, retentionManifest] =
    await Promise.all([
      readHybridIndexDeletion(store, uploadId),
      store.read<unknown>("deleted-uploads", uploadId),
      readHybridIndexRetentionManifest(store, uploadId)
    ]);
  if (hybridDeletion !== null || deletedUploadMarker !== null) {
    return "deletion";
  }
  return retentionManifest === null ? null : "retention";
}

/**
 * A permanent Hybrid deletion request is written before source cleanup, while
 * the deleted-upload marker is written immediately before JsonStore cleanup.
 * Treat either record as a write barrier so a slow request cannot resurrect
 * upload-scoped derived data after cleanup.
 */
export async function isUploadDeletionInProgress(
  store: JsonStore,
  uploadId: string
) {
  const [hybridDeletion, deletedUploadMarker] = await Promise.all([
    readHybridIndexDeletion(store, uploadId),
    store.read<unknown>("deleted-uploads", uploadId)
  ]);
  return hybridDeletion !== null || deletedUploadMarker !== null;
}
