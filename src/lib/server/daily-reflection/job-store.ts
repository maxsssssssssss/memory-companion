import { createHash } from "node:crypto";
import { z } from "zod";

import { PipelineExecutionModeSchema } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";

export const DAILY_REFLECTION_JOBS_COLLECTION = "daily-reflection-jobs";

export const DailyReflectionJobSchema = z.object({
  id: z.string().min(1),
  reflectionId: z.string().min(1),
  uploadId: z.string().min(1),
  status: z.enum(["waiting", "processing", "completed", "failed", "cancelled"]),
  progress: z.number().min(0).max(100),
  executionMode: PipelineExecutionModeSchema,
  queueJobId: z.string().min(1).optional(),
  queuedAt: z.string().datetime().optional(),
  workerStartedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  errorCode: z.string().min(1).max(256).optional(),
  errorMessage: z.string().min(1).max(4_000).optional()
}).strict();

export type DailyReflectionJob = z.infer<typeof DailyReflectionJobSchema>;

export class DailyReflectionJobNotFoundError extends Error {
  readonly code = "daily_reflection_job_not_found";

  constructor() {
    super("Daily Reflection job not found");
  }
}

export class DailyReflectionJobConflictError extends Error {
  readonly code = "daily_reflection_job_conflict";

  constructor() {
    super("Daily Reflection job does not match the persisted job");
  }
}

export function buildDailyReflectionProductJobId(input: {
  accountId: string;
  reflectionId: string;
}) {
  const digest = createHash("sha256")
    .update(`${input.accountId}\u0000${input.reflectionId}`)
    .digest("hex");
  return `daily-reflection-job-${digest}`;
}

export async function readDailyReflectionJob(
  store: JsonStore,
  reflectionId: string
) {
  const raw = await store.read<unknown>(DAILY_REFLECTION_JOBS_COLLECTION, reflectionId);
  return raw === null ? null : DailyReflectionJobSchema.parse(raw);
}

export async function createDailyReflectionJob(input: {
  store: JsonStore;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  executionMode: "inline" | "queue";
  queueJobId?: string;
  queuedAt?: string;
  now?: () => string;
}) {
  const existing = await readDailyReflectionJob(input.store, input.reflectionId);
  if (existing) {
    if (existing.uploadId !== input.uploadId) {
      throw new Error("daily_reflection_job_upload_conflict");
    }
    return existing;
  }
  const now = input.now?.() ?? new Date().toISOString();
  const job = DailyReflectionJobSchema.parse({
    id: buildDailyReflectionProductJobId(input),
    reflectionId: input.reflectionId,
    uploadId: input.uploadId,
    status: "waiting",
    progress: 0,
    executionMode: input.executionMode,
    ...(input.queueJobId ? { queueJobId: input.queueJobId } : {}),
    ...(input.queuedAt ? { queuedAt: input.queuedAt } : {}),
    updatedAt: now
  });
  await input.store.write(DAILY_REFLECTION_JOBS_COLLECTION, input.reflectionId, job);
  return job;
}

export async function updateDailyReflectionJob(
  store: JsonStore,
  job: DailyReflectionJob,
  patch: Partial<DailyReflectionJob>
) {
  const current = await readDailyReflectionJob(store, job.reflectionId);
  if (!current) throw new DailyReflectionJobNotFoundError();
  if (
    current.id !== job.id
    || current.reflectionId !== job.reflectionId
    || current.uploadId !== job.uploadId
  ) {
    throw new DailyReflectionJobConflictError();
  }
  const next = DailyReflectionJobSchema.parse({
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  });
  await store.write(DAILY_REFLECTION_JOBS_COLLECTION, job.reflectionId, next);
  return next;
}
