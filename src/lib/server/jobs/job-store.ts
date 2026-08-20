import { randomUUID } from "crypto";
import type { ProcessingJob } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";

export type CreateJobOptions = Pick<ProcessingJob, "executionMode" | "queueJobId" | "queuedAt"> & {
  jobId?: string;
  resetForRetry?: boolean;
  now?: () => string;
};

function resetFailedJobForRetry(job: ProcessingJob, options: Partial<CreateJobOptions>) {
  if (!options.resetForRetry || job.status !== "failed") return job;
  return {
    ...job,
    status: "waiting" as const,
    progress: 0,
    updatedAt: options.now?.() ?? new Date().toISOString(),
    errorCode: undefined,
    errorMessage: undefined,
    finishedAt: undefined
  };
}

function withStableExecutionIdentity(
  job: ProcessingJob,
  options: Partial<CreateJobOptions>,
  fallback?: ProcessingJob
) {
  const executionMode = job.executionMode ?? fallback?.executionMode ?? options.executionMode;
  const queueJobId = job.queueJobId ?? fallback?.queueJobId ?? options.queueJobId;
  for (const candidate of [fallback?.executionMode, options.executionMode]) {
    if (executionMode && candidate && executionMode !== candidate) {
      throw new Error("job_execution_identity_conflict");
    }
  }
  for (const candidate of [fallback?.queueJobId, options.queueJobId]) {
    if (queueJobId && candidate && queueJobId !== candidate) {
      throw new Error("job_execution_identity_conflict");
    }
  }
  if (executionMode === "inline" && queueJobId) {
    throw new Error("job_execution_identity_conflict");
  }
  return {
    ...job,
    ...(executionMode ? { executionMode } : {}),
    ...(queueJobId ? { queueJobId } : {})
  };
}

export async function createJob(
  store: JsonStore,
  uploadId: string,
  options: Partial<CreateJobOptions> = {}
): Promise<ProcessingJob> {
  const existing = await store.read<ProcessingJob>("jobs-by-upload", uploadId);
  if (existing) {
    if (options.jobId && existing.id !== options.jobId) {
      throw new Error("job_identity_conflict");
    }
    // Repair a crash window where the upload projection was durable but the
    // direct job projection was not. Fixed Toy receipt identities make this
    // safe and deterministic across request retries.
    const direct = await store.read<ProcessingJob>("jobs", existing.id);
    if (!direct) {
      const retryable = resetFailedJobForRetry(
        withStableExecutionIdentity(existing, options),
        options
      );
      await store.write("jobs", retryable.id, retryable);
      if (JSON.stringify(existing) !== JSON.stringify(retryable)) {
        await store.write("jobs-by-upload", uploadId, retryable);
      }
      return retryable;
    }
    if (direct.id !== existing.id || direct.uploadId !== uploadId) {
      throw new Error("job_identity_conflict");
    }
    const directTime = Date.parse(direct.updatedAt ?? "");
    const uploadTime = Date.parse(existing.updatedAt ?? "");
    const canonicalProjection = Number.isFinite(directTime)
      && (!Number.isFinite(uploadTime) || directTime > uploadTime)
      ? direct
      : existing;
    const otherProjection = canonicalProjection === direct ? existing : direct;
    const canonical = withStableExecutionIdentity(
      canonicalProjection,
      options,
      otherProjection
    );
    const retryable = resetFailedJobForRetry(canonical, options);
    if (JSON.stringify(direct) !== JSON.stringify(retryable)) {
      await store.write("jobs", retryable.id, retryable);
    }
    if (JSON.stringify(existing) !== JSON.stringify(retryable)) {
      await store.write("jobs-by-upload", uploadId, retryable);
    }
    return retryable;
  }

  if (options.jobId) {
    const fixedJobId = options.jobId;
    if (!/^[A-Za-z0-9_-]+$/u.test(fixedJobId)) {
      throw new Error("invalid_job_id");
    }
    const direct = await store.read<ProcessingJob>("jobs", fixedJobId);
    if (direct) {
      if (direct.uploadId !== uploadId) throw new Error("job_identity_conflict");
      const retryable = resetFailedJobForRetry(
        withStableExecutionIdentity(direct, options),
        options
      );
      if (retryable !== direct) await store.write("jobs", retryable.id, retryable);
      await store.write("jobs-by-upload", uploadId, retryable);
      return retryable;
    }
  }

  const updatedAt = options.now?.() ?? new Date().toISOString();
  const job: ProcessingJob = {
    id: options.jobId ?? randomUUID(),
    uploadId,
    status: "waiting",
    progress: 0,
    updatedAt,
    ...(options.executionMode ? { executionMode: options.executionMode } : {}),
    ...(options.queueJobId ? { queueJobId: options.queueJobId } : {}),
    ...(options.queuedAt ? { queuedAt: options.queuedAt } : {})
  };
  await store.write("jobs", job.id, job);
  await store.write("jobs-by-upload", uploadId, job);
  return job;
}

export async function updateJob(
  store: JsonStore,
  job: ProcessingJob,
  patch: Partial<ProcessingJob>
): Promise<ProcessingJob> {
  const next = {
    ...job,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  };
  await store.write("jobs", next.id, next);
  await store.write("jobs-by-upload", next.uploadId, next);
  return next;
}
