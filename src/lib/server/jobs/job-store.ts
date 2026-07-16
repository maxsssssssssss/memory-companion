import { randomUUID } from "crypto";
import type { ProcessingJob } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";

export type CreateJobOptions = Pick<ProcessingJob, "executionMode" | "queueJobId" | "queuedAt"> & {
  now?: () => string;
};

export async function createJob(
  store: JsonStore,
  uploadId: string,
  options: Partial<CreateJobOptions> = {}
): Promise<ProcessingJob> {
  const existing = await store.read<ProcessingJob>("jobs-by-upload", uploadId);
  if (existing) {
    return existing;
  }

  const updatedAt = options.now?.() ?? new Date().toISOString();
  const job: ProcessingJob = {
    id: randomUUID(),
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
