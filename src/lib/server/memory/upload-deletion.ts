import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";
import { resolveQaHybridRetrievalMode } from "@/lib/server/retrieval/hybrid/runtime-config";
import { getMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";
import type { MemoryRepository } from "./types";

export type MemoryUploadDeletionErrorCode =
  | "memory_upload_delete_failed"
  | "memory_index_refresh_failed";

export class MemoryUploadDeletionError extends Error {
  constructor(readonly code: MemoryUploadDeletionErrorCode) {
    super(code);
  }
}

type MemoryUploadDeletionDependencies = {
  getRepository: () => Pick<MemoryRepository, "deleteByUpload">;
  resolveExecutionMode: typeof resolvePipelineExecutionMode;
  resolveHybridMode: typeof resolveQaHybridRetrievalMode;
  enqueueIndexJob: typeof enqueueEmbeddingIndexJob;
};

const defaultDependencies: MemoryUploadDeletionDependencies = {
  getRepository: () => createMemoryRepository(getMemoryDatabase()),
  resolveExecutionMode: resolvePipelineExecutionMode,
  resolveHybridMode: resolveQaHybridRetrievalMode,
  enqueueIndexJob: enqueueEmbeddingIndexJob
};

export async function deleteMemoryUploadAndRefreshIndex(input: {
  userId: string;
  uploadId: string;
  indexRefreshFailure: "throw" | "best_effort";
}, dependencies: Partial<MemoryUploadDeletionDependencies> = {}) {
  const resolved = { ...defaultDependencies, ...dependencies };
  try {
    resolved.getRepository().deleteByUpload(input.userId, input.uploadId);
  } catch {
    throw new MemoryUploadDeletionError("memory_upload_delete_failed");
  }

  let indexRefreshRequired = false;
  try {
    indexRefreshRequired = resolved.resolveExecutionMode() === "queue"
      && resolved.resolveHybridMode() !== "off";
    if (indexRefreshRequired) {
      await resolved.enqueueIndexJob({
        version: 1,
        userRef: input.userId,
        reason: "upload_deleted"
      });
    }
  } catch (error) {
    if (input.indexRefreshFailure === "throw") {
      throw new MemoryUploadDeletionError("memory_index_refresh_failed");
    }
    console.warn(
      `[memory-upload-delete] index_refresh_failed `
      + `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return { memoryDeleted: true, indexRefresh: "failed_best_effort" as const };
  }

  return {
    memoryDeleted: true,
    indexRefresh: indexRefreshRequired ? "enqueued" as const : "not_required" as const
  };
}
