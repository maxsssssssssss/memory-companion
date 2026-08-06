import { getUserScopedStore } from "@/lib/server/auth/session";
import {
  deletePendingHybridIndexEvidence,
  refreshHybridEvidenceIndex
} from "@/lib/server/retrieval/hybrid/index-refresh";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  EmbeddingIndexQueuePayloadSchema,
  type EmbeddingIndexQueuePayload
} from "./types";

export type EmbeddingIndexQueueJobLike = {
  data: unknown;
  updateProgress?: (progress: number) => Promise<unknown>;
};

export type EmbeddingIndexWorkerResult = {
  status: "indexed";
  userRef: string;
  uploadCount: number;
  retainedUploadCount: number;
  completedDeletionCount: number;
  total: number;
  embedded: number;
  unchanged: number;
  removed: number;
};

export type EmbeddingIndexWorkerDependencies = {
  getStore: (userRef: string) => JsonStore;
  refresh: typeof refreshHybridEvidenceIndex;
  deletePending: typeof deletePendingHybridIndexEvidence;
};

const defaultDependencies: EmbeddingIndexWorkerDependencies = {
  getStore: getUserScopedStore,
  refresh: refreshHybridEvidenceIndex,
  deletePending: deletePendingHybridIndexEvidence
};

function progressPercentage(completed: number, total: number) {
  return total === 0
    ? 100
    : Math.min(100, Math.max(0, Math.floor((completed / total) * 100)));
}

export function createEmbeddingIndexJobProcessor(
  dependencies: Partial<EmbeddingIndexWorkerDependencies> = {}
) {
  const resolved = { ...defaultDependencies, ...dependencies };
  return async function processEmbeddingIndexJob(
    queueJob: EmbeddingIndexQueueJobLike
  ): Promise<EmbeddingIndexWorkerResult> {
    const payload: EmbeddingIndexQueuePayload =
      EmbeddingIndexQueuePayloadSchema.parse(queueJob.data);
    const store = resolved.getStore(payload.userRef);
    if (payload.reason === "permanent_delete") {
      const deleted = await resolved.deletePending({
        userId: payload.userRef,
        store
      });
      console.info(
        `[hybrid-index-worker] stage=privacy_delete progress=${deleted.completed}/${deleted.completed}`
      );
      await queueJob.updateProgress?.(100);
      return {
        status: "indexed",
        userRef: payload.userRef,
        uploadCount: 0,
        retainedUploadCount: 0,
        completedDeletionCount: deleted.completed,
        total: deleted.requested,
        embedded: 0,
        unchanged: deleted.alreadyMissing,
        removed: deleted.removed
      };
    }
    const result = await resolved.refresh({
      userId: payload.userRef,
      store,
      onProgress: async (progress) => {
        console.info(
          `[hybrid-index-worker] stage=${progress.stage} ` +
          `progress=${progress.completed}/${progress.total}`
        );
        await queueJob.updateProgress?.(
          progressPercentage(progress.completed, progress.total)
        );
      }
    });
    return {
      status: "indexed",
      userRef: payload.userRef,
      uploadCount: result.uploadCount,
      retainedUploadCount: result.retainedUploadCount,
      completedDeletionCount: result.completedDeletionCount,
      total: result.total,
      embedded: result.embedded,
      unchanged: result.unchanged,
      removed: result.removed
    };
  };
}

export const processEmbeddingIndexJob = createEmbeddingIndexJobProcessor();
