import * as fs from "node:fs/promises";
import type { AudioUpload, ProcessingJob } from "@/lib/domain/types";
import { getUserScopedStore } from "@/lib/server/auth/session";
import { updateJob } from "@/lib/server/jobs/job-store";
import {
  isUploadProcessingCancelled,
  processUpload,
  type ProcessUploadResult
} from "@/lib/server/pipeline/process-upload";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  PipelineQueuePayloadSchema,
  type PipelineQueuePayload
} from "./types";

type StoredUpload = AudioUpload & {
  filePath?: string;
  evaluationRetention?: boolean;
  errorCode?: string;
  errorMessage?: string;
};

type DeletedUploadMarker = {
  uploadId: string;
  deletedAt: string;
};

export type PipelineQueueJobLike = {
  data: unknown;
  attemptsMade?: number;
  opts?: { attempts?: number };
  updateProgress?: (progress: number) => Promise<unknown>;
};

export type PipelineWorkerResult =
  | { status: "ready"; uploadId: string; reconciled: boolean }
  | {
      status: "cancelled";
      uploadId: string;
      reason: "deleted" | "upload_missing" | "job_missing";
    }
  | { status: "failed"; uploadId: string; reason: "audio_missing" };

export class PipelineJobRetryError extends Error {
  readonly code = "pipeline_job_failed";

  constructor(
    readonly payload: PipelineQueuePayload,
    readonly result: ProcessUploadResult
  ) {
    super(
      result.job.errorMessage?.trim() ||
        `Pipeline processing failed for upload ${payload.uploadId}`
    );
    this.name = "PipelineJobRetryError";
  }
}

export type PipelineWorkerDependencies = {
  getStore: (userRef: string) => JsonStore;
  runProcessUpload: typeof processUpload;
  access: typeof fs.access;
  remove: typeof fs.rm;
  now: () => string;
};

const defaultDependencies: PipelineWorkerDependencies = {
  getStore: getUserScopedStore,
  runProcessUpload: processUpload,
  access: fs.access,
  remove: fs.rm,
  now: () => new Date().toISOString()
};

const AUDIO_MISSING_MESSAGE = "Uploaded audio file is missing";
const QUEUE_ATTEMPTS_EXHAUSTED_MESSAGE = "Pipeline worker exhausted its queue attempts";

async function readProductJob(store: JsonStore, uploadId: string) {
  const job = await store.read<ProcessingJob>("jobs-by-upload", uploadId);
  if (!job) {
    return null;
  }
  const direct = await store.read<ProcessingJob>("jobs", job.id);
  if (!direct) {
    await store.write("jobs", job.id, job);
  }
  return job;
}

async function audioFileExists(
  upload: StoredUpload,
  access: typeof fs.access
) {
  if (!upload.filePath) {
    return false;
  }
  try {
    await access(upload.filePath);
    return true;
  } catch {
    return false;
  }
}

async function reconcileReadyJob(
  store: JsonStore,
  job: ProcessingJob,
  now: string
) {
  if (job.status === "ready" && job.progress === 100) {
    return false;
  }
  await updateJob(store, job, {
    status: "ready",
    progress: 100,
    updatedAt: now,
    errorCode: undefined,
    errorMessage: undefined,
    finishedAt: job.finishedAt ?? now
  });
  return true;
}

async function finalizeReadyUpload(
  store: JsonStore,
  upload: StoredUpload,
  remove: typeof fs.rm
) {
  if (!upload.filePath || upload.evaluationRetention === true) {
    return;
  }
  await remove(upload.filePath, { force: true });
  const { filePath: _filePath, ...withoutFilePath } = upload;
  await store.write("uploads", upload.id, withoutFilePath);
}

async function markAudioMissing(input: {
  store: JsonStore;
  upload: StoredUpload;
  job: ProcessingJob;
  now: string;
}) {
  await updateJob(input.store, input.job, {
    status: "failed",
    updatedAt: input.now,
    errorCode: "audio_missing",
    errorMessage: AUDIO_MISSING_MESSAGE,
    finishedAt: input.now
  });
  await input.store.write("uploads", input.upload.id, {
    ...input.upload,
    status: "failed",
    errorCode: "audio_missing",
    errorMessage: AUDIO_MISSING_MESSAGE
  });
}

async function markUploadProcessing(store: JsonStore, upload: StoredUpload) {
  if (upload.status !== "failed" && !upload.errorCode && !upload.errorMessage) {
    return;
  }
  await store.write("uploads", upload.id, {
    ...upload,
    status: "uploaded",
    errorCode: undefined,
    errorMessage: undefined
  });
}

async function markRetryScheduled(input: {
  store: JsonStore;
  uploadId: string;
  fallbackJob: ProcessingJob;
  errorMessage?: string;
}) {
  const [upload, productJob] = await Promise.all([
    input.store.read<StoredUpload>("uploads", input.uploadId),
    input.store.read<ProcessingJob>("jobs-by-upload", input.uploadId)
  ]);
  if (upload) {
    await markUploadProcessing(input.store, upload);
  }
  await updateJob(input.store, productJob ?? input.fallbackJob, {
    status: "waiting",
    errorCode: "retry_scheduled",
    errorMessage: input.errorMessage,
    finishedAt: undefined
  });
}

function queueAttempt(queueJob: PipelineQueueJobLike) {
  const current = Math.max(1, Math.floor(queueJob.attemptsMade ?? 0) + 1);
  const maximum = Math.max(1, Math.floor(queueJob.opts?.attempts ?? 1));
  return { current, maximum, hasMore: current < maximum };
}

async function publishProgress(queueJob: PipelineQueueJobLike, progress: number) {
  if (!queueJob.updateProgress) {
    return;
  }
  try {
    await queueJob.updateProgress(progress);
  } catch (error) {
    // Redis progress is an observability projection. A transient failure must
    // not turn a successfully persisted pipeline stage into a provider retry.
    console.warn(
      `[pipeline-worker] progress update failed progress=${progress} error_name=${error instanceof Error ? error.name : "unknown"}`
    );
  }
}

async function markTerminalQueueFailure(input: {
  store: JsonStore;
  uploadId: string;
  fallbackJob?: ProcessingJob;
  now: string;
  errorMessage?: string;
}) {
  const [deleted, upload, indexedJob] = await Promise.all([
    input.store.read<DeletedUploadMarker>("deleted-uploads", input.uploadId),
    input.store.read<StoredUpload>("uploads", input.uploadId),
    input.store.read<ProcessingJob>("jobs-by-upload", input.uploadId)
  ]);
  if (deleted || !upload) {
    return;
  }

  const productJob = indexedJob ?? input.fallbackJob;
  if (!productJob) {
    return;
  }
  if (upload.status === "ready") {
    await reconcileReadyJob(input.store, productJob, input.now);
    return;
  }

  const errorMessage = input.errorMessage?.trim() || QUEUE_ATTEMPTS_EXHAUSTED_MESSAGE;
  if (productJob.status !== "failed") {
    await updateJob(input.store, productJob, {
      status: "failed",
      errorCode: "queue_attempts_exhausted",
      errorMessage,
      finishedAt: input.now
    });
  }
  if (upload.status !== "failed") {
    await input.store.write("uploads", input.uploadId, {
      ...upload,
      status: "failed",
      errorCode: "queue_attempts_exhausted",
      errorMessage
    });
  }
}

export async function finalizePipelineQueueFailure(
  data: unknown,
  dependencies: Pick<Partial<PipelineWorkerDependencies>, "getStore" | "now"> = {}
) {
  const payload = PipelineQueuePayloadSchema.parse(data);
  const getStore = dependencies.getStore ?? defaultDependencies.getStore;
  const now = dependencies.now?.() ?? defaultDependencies.now();
  await markTerminalQueueFailure({
    store: getStore(payload.userRef),
    uploadId: payload.uploadId,
    now
  });
}

export function createPipelineJobProcessor(
  dependencies: Partial<PipelineWorkerDependencies> = {}
) {
  const resolved = { ...defaultDependencies, ...dependencies };

  return async function processPipelineJob(
    queueJob: PipelineQueueJobLike
  ): Promise<PipelineWorkerResult> {
    const payload = PipelineQueuePayloadSchema.parse(queueJob.data);
    const store = resolved.getStore(payload.userRef);
    const [deleted, upload] = await Promise.all([
      store.read<DeletedUploadMarker>("deleted-uploads", payload.uploadId),
      store.read<StoredUpload>("uploads", payload.uploadId)
    ]);

    if (deleted) {
      return { status: "cancelled", uploadId: payload.uploadId, reason: "deleted" };
    }
    if (!upload) {
      return {
        status: "cancelled",
        uploadId: payload.uploadId,
        reason: "upload_missing"
      };
    }

    const productJob = await readProductJob(store, payload.uploadId);
    if (!productJob) {
      return {
        status: "cancelled",
        uploadId: payload.uploadId,
        reason: "job_missing"
      };
    }

    const startedAt = resolved.now();
    if (upload.status === "ready") {
      await finalizeReadyUpload(store, upload, resolved.remove);
      const reconciled = await reconcileReadyJob(
        store,
        productJob,
        startedAt
      );
      return { status: "ready", uploadId: payload.uploadId, reconciled };
    }

    if (!(await audioFileExists(upload, resolved.access))) {
      await markAudioMissing({
        store,
        upload,
        job: productJob,
        now: startedAt
      });
      return {
        status: "failed",
        uploadId: payload.uploadId,
        reason: "audio_missing"
      };
    }

    let processingJob = productJob;
    try {
      await markUploadProcessing(store, upload);
      processingJob = await updateJob(store, productJob, {
        status: "processing",
        executionMode: "queue",
        updatedAt: startedAt,
        workerStartedAt: startedAt,
        queueAttempt: queueAttempt(queueJob).current,
        errorCode: undefined,
        errorMessage: undefined,
        finishedAt: undefined
      });
      await publishProgress(queueJob, processingJob.progress);
      const onJobUpdate = queueJob.updateProgress
        ? async (updatedJob: ProcessingJob) => {
            await publishProgress(queueJob, updatedJob.progress);
          }
        : undefined;
      const result = await resolved.runProcessUpload({
        uploadId: payload.uploadId,
        store,
        userId: payload.userRef,
        ...(onJobUpdate ? { onJobUpdate } : {})
      });
      if (result.job.status === "failed") {
        throw new PipelineJobRetryError(payload, result);
      }
      if (result.job.status !== "ready") {
        throw new Error(
          `Pipeline returned non-terminal status ${result.job.status} for upload ${payload.uploadId}`
        );
      }
      return { status: "ready", uploadId: payload.uploadId, reconciled: false };
    } catch (error) {
      if (isUploadProcessingCancelled(error)) {
        return {
          status: "cancelled",
          uploadId: payload.uploadId,
          reason: "deleted"
        };
      }
      const attempt = queueAttempt(queueJob);
      if (attempt.hasMore) {
        await markRetryScheduled({
          store,
          uploadId: payload.uploadId,
          fallbackJob: processingJob,
          errorMessage: error instanceof PipelineJobRetryError
            ? error.result.job.errorMessage
            : undefined
        });
      } else {
        await markTerminalQueueFailure({
          store,
          uploadId: payload.uploadId,
          fallbackJob: processingJob,
          now: resolved.now(),
          errorMessage: error instanceof PipelineJobRetryError
            ? error.result.job.errorMessage
            : undefined
        });
      }
      throw error;
    }
  };
}

export const processPipelineJob = createPipelineJobProcessor();
