import * as fs from "node:fs/promises";
import type { AudioUpload, ProcessingJob } from "@/lib/domain/types";
import { getUserScopedStore } from "@/lib/server/auth/session";
import { updateJob } from "@/lib/server/jobs/job-store";
import { appStore, type JsonStore } from "@/lib/server/storage/json-store";
import {
  PipelineQueuePayloadSchema,
  buildPipelineJobId,
  type PipelineQueuePayload
} from "./types";
import type { EnqueuePipelineJobResult } from "./producer";

type StoredUpload = AudioUpload & {
  filePath?: string;
  evaluationRetention?: boolean;
  errorCode?: string;
  errorMessage?: string;
};

type StoredUser = {
  id?: string;
};

export type PipelineRecoveryEnqueue = (
  payload: PipelineQueuePayload,
  options: { reviveTerminal: true }
) => Promise<EnqueuePipelineJobResult>;

export type PipelineRecoveryOptions = {
  enqueue: PipelineRecoveryEnqueue;
  staleAfterMs?: number;
};

export type PipelineRecoveryDependencies = {
  rootStore: JsonStore;
  getStore: (userRef: string) => JsonStore;
  access: typeof fs.access;
  remove: typeof fs.rm;
  now: () => string;
};

export type PipelineRecoveryReport = {
  usersScanned: number;
  jobsScanned: number;
  enqueued: number;
  existing: number;
  readyReconciled: number;
  missingAudioFailed: number;
  queueUnavailableRecovered: number;
  freshActiveSkipped: number;
  terminalSkipped: number;
  missingUploadsSkipped: number;
};

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const ACTIVE_STATUSES = new Set<ProcessingJob["status"]>([
  "processing",
  "transcribing",
  "extracting"
]);
const AUDIO_MISSING_MESSAGE = "Uploaded audio file is missing";

const defaultDependencies: PipelineRecoveryDependencies = {
  rootStore: appStore,
  getStore: getUserScopedStore,
  access: fs.access,
  remove: fs.rm,
  now: () => new Date().toISOString()
};

function timestampMs(job: ProcessingJob) {
  const value =
    job.updatedAt ?? job.workerStartedAt ?? job.startedAt ?? job.queuedAt;
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isStale(job: ProcessingJob, nowMs: number, staleAfterMs: number) {
  return nowMs - timestampMs(job) >= staleAfterMs;
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

async function reconcileReady(
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

function userRef(record: { id: string; value: StoredUser }) {
  return typeof record.value.id === "string" && record.value.id.length > 0
    ? record.value.id
    : record.id;
}

export async function recoverPipelineJobs(
  options: PipelineRecoveryOptions,
  dependencies: Partial<PipelineRecoveryDependencies> = {}
): Promise<PipelineRecoveryReport> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error("staleAfterMs must be a non-negative finite number");
  }

  const now = resolved.now();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Recovery now() must return an ISO timestamp");
  }

  const report: PipelineRecoveryReport = {
    usersScanned: 0,
    jobsScanned: 0,
    enqueued: 0,
    existing: 0,
    readyReconciled: 0,
    missingAudioFailed: 0,
    queueUnavailableRecovered: 0,
    freshActiveSkipped: 0,
    terminalSkipped: 0,
    missingUploadsSkipped: 0
  };

  const users = await resolved.rootStore.list<StoredUser>("users");
  for (const user of users) {
    const currentUserRef = userRef(user);
    const store = resolved.getStore(currentUserRef);
    report.usersScanned += 1;
    const jobRecords = await store.list<ProcessingJob>("jobs-by-upload");

    for (const record of jobRecords) {
      const job = record.value;
      report.jobsScanned += 1;
      const [deleted, upload] = await Promise.all([
        store.read("deleted-uploads", job.uploadId),
        store.read<StoredUpload>("uploads", job.uploadId)
      ]);

      if (deleted || !upload) {
        report.missingUploadsSkipped += 1;
        continue;
      }

      if (upload.status === "ready") {
        await finalizeReadyUpload(store, upload, resolved.remove);
        if (await reconcileReady(store, job, now)) {
          report.readyReconciled += 1;
        } else {
          report.terminalSkipped += 1;
        }
        continue;
      }

      const recoverableQueueFailure =
        job.status === "failed" && job.errorCode === "queue_unavailable";
      if (job.status === "ready" || (job.status === "failed" && !recoverableQueueFailure)) {
        report.terminalSkipped += 1;
        continue;
      }

      if (!(await audioFileExists(upload, resolved.access))) {
        await markAudioMissing({ store, upload, job, now });
        report.missingAudioFailed += 1;
        continue;
      }

      const shouldEnqueue =
        job.status === "waiting" ||
        recoverableQueueFailure ||
        (ACTIVE_STATUSES.has(job.status) && isStale(job, nowMs, staleAfterMs));
      if (!shouldEnqueue) {
        if (ACTIVE_STATUSES.has(job.status)) {
          report.freshActiveSkipped += 1;
        } else {
          report.terminalSkipped += 1;
        }
        continue;
      }

      const payload = PipelineQueuePayloadSchema.parse({
        version: 1,
        uploadId: job.uploadId,
        userRef: currentUserRef
      });
      await updateJob(store, job, {
        status: "waiting",
        executionMode: "queue",
        queueJobId: buildPipelineJobId(payload),
        queuedAt: now,
        errorCode: undefined,
        errorMessage: undefined,
        finishedAt: undefined
      });
      if (
        recoverableQueueFailure
        && upload.status === "failed"
        && upload.errorCode === "queue_unavailable"
      ) {
        const {
          errorCode: _errorCode,
          errorMessage: _errorMessage,
          ...uploadWithoutQueueFailure
        } = upload;
        await store.write("uploads", upload.id, {
          ...uploadWithoutQueueFailure,
          status: "uploaded"
        });
        report.queueUnavailableRecovered += 1;
      }
      const enqueueResult = await options.enqueue(payload, {
        reviveTerminal: true
      });
      if (enqueueResult.enqueued) {
        report.enqueued += 1;
      } else {
        report.existing += 1;
      }
    }
  }

  return report;
}
