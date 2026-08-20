import {
  getUserScopedStore,
  getUserUploadsRootDir
} from "@/lib/server/auth/session";
import { processDailyReflectionUpload } from "@/lib/server/daily-reflection/process-upload";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  DailyReflectionQueuePayloadSchema,
  type DailyReflectionQueuePayload
} from "./types";

export type DailyReflectionQueueJobLike = {
  data: unknown;
};

export type DailyReflectionQueueWorkerResult = {
  status: "review_pending" | "failed" | "cancelled" | "reused";
  reflectionId: string;
  uploadId: string;
  candidateCount: number;
};

export type DailyReflectionQueueWorkerDependencies = {
  getStore: (userRef: string) => JsonStore;
  getUploadsRootDir: (userRef: string) => string;
  runProcess: typeof processDailyReflectionUpload;
};

const defaultDependencies: DailyReflectionQueueWorkerDependencies = {
  getStore: getUserScopedStore,
  getUploadsRootDir: getUserUploadsRootDir,
  runProcess: processDailyReflectionUpload
};

export function createDailyReflectionJobProcessor(
  dependencies: Partial<DailyReflectionQueueWorkerDependencies> = {}
) {
  const resolved = { ...defaultDependencies, ...dependencies };
  return async function processDailyReflectionJob(
    queueJob: DailyReflectionQueueJobLike
  ): Promise<DailyReflectionQueueWorkerResult> {
    const payload: DailyReflectionQueuePayload =
      DailyReflectionQueuePayloadSchema.parse(queueJob.data);
    const result = await resolved.runProcess({
      accountId: payload.userRef,
      reflectionId: payload.reflectionId,
      store: resolved.getStore(payload.userRef),
      uploadsRootDir: resolved.getUploadsRootDir(payload.userRef),
      executionMode: "queue"
    });
    return {
      status: result.outcome === "failed"
        ? "failed"
        : result.outcome === "tombstoned"
          ? "cancelled"
          : result.outcome === "reused" || result.outcome === "busy"
            ? "reused"
            : "review_pending",
      reflectionId: result.reflectionId,
      uploadId: result.uploadId,
      candidateCount: result.candidateCount
    };
  };
}

export const processDailyReflectionJob = createDailyReflectionJobProcessor();
