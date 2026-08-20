// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "@/lib/server/storage/json-store";
import { createJob, updateJob } from "./job-store";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("job store queue metadata", () => {
  it("persists execution metadata in both product job projections", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-job-store-"));
    const store = new JsonStore(tempDir);
    const now = "2026-07-16T08:00:00.000Z";

    const job = await createJob(store, "upload_queue", {
      executionMode: "queue",
      queueJobId: "pipeline_123",
      queuedAt: now,
      now: () => now
    });

    expect(job).toMatchObject({
      uploadId: "upload_queue",
      status: "waiting",
      executionMode: "queue",
      queueJobId: "pipeline_123",
      queuedAt: now,
      updatedAt: now
    });
    await expect(store.read("jobs", job.id)).resolves.toEqual(job);
    await expect(store.read("jobs-by-upload", job.uploadId)).resolves.toEqual(job);
  });

  it("refreshes updatedAt while preserving the stable product job id", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-job-store-"));
    const store = new JsonStore(tempDir);
    const job = await createJob(store, "upload_progress", {
      now: () => "2026-07-16T08:00:00.000Z"
    });

    const next = await updateJob(store, job, {
      status: "processing",
      progress: 12,
      updatedAt: "2026-07-16T08:01:00.000Z"
    });

    expect(next.id).toBe(job.id);
    expect(next).toMatchObject({
      status: "processing",
      progress: 12,
      updatedAt: "2026-07-16T08:01:00.000Z"
    });
  });

  it("uses a receipt-owned fixed id and repairs either missing projection", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-job-store-"));
    const store = new JsonStore(tempDir);
    const fixed = await createJob(store, "upload_fixed", {
      jobId: "job_fixed",
      executionMode: "inline",
      now: () => "2026-08-19T08:00:00.000Z"
    });
    expect(fixed.id).toBe("job_fixed");

    await store.delete("jobs", fixed.id);
    await expect(createJob(store, fixed.uploadId, {
      jobId: fixed.id
    })).resolves.toEqual(fixed);
    await expect(store.read("jobs", fixed.id)).resolves.toEqual(fixed);

    await store.delete("jobs-by-upload", fixed.uploadId);
    await expect(createJob(store, fixed.uploadId, {
      jobId: fixed.id
    })).resolves.toEqual(fixed);
    await expect(store.read("jobs-by-upload", fixed.uploadId)).resolves.toEqual(fixed);
  });

  it("fails closed when a fixed id conflicts with either projection", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-job-store-"));
    const store = new JsonStore(tempDir);
    await createJob(store, "upload_fixed", { jobId: "job_fixed" });

    await expect(createJob(store, "upload_fixed", {
      jobId: "job_other"
    })).rejects.toThrow("job_identity_conflict");
    await expect(createJob(store, "upload_other", {
      jobId: "job_fixed"
    })).rejects.toThrow("job_identity_conflict");

    await store.write("jobs", "job_fixed", {
      id: "job_fixed",
      uploadId: "upload_corrupt",
      status: "waiting",
      progress: 0,
      updatedAt: "2026-08-19T09:00:00.000Z"
    });
    await expect(createJob(store, "upload_fixed", {
      jobId: "job_fixed"
    })).rejects.toThrow("job_identity_conflict");
  });

  it("fails closed when a retry tries to change the canonical execution identity", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-job-store-"));
    const store = new JsonStore(tempDir);
    await createJob(store, "upload_queue_fixed", {
      jobId: "job_queue_fixed",
      executionMode: "queue",
      queueJobId: "pipeline_stable"
    });

    await expect(createJob(store, "upload_queue_fixed", {
      jobId: "job_queue_fixed",
      executionMode: "inline"
    })).rejects.toThrow("job_execution_identity_conflict");
    await expect(createJob(store, "upload_queue_fixed", {
      jobId: "job_queue_fixed",
      executionMode: "queue",
      queueJobId: "pipeline_changed"
    })).rejects.toThrow("job_execution_identity_conflict");
  });

  it("resets only a failed fixed job for an explicit canonical retry", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-job-store-"));
    const store = new JsonStore(tempDir);
    const job = await createJob(store, "upload_retry", {
      jobId: "job_retry",
      executionMode: "inline",
      now: () => "2026-08-19T08:00:00.000Z"
    });
    const failed = await updateJob(store, job, {
      status: "failed",
      progress: 47,
      errorCode: "provider_failed",
      errorMessage: "redacted",
      finishedAt: "2026-08-19T08:01:00.000Z"
    });
    expect(failed.status).toBe("failed");

    const retried = await createJob(store, job.uploadId, {
      jobId: job.id,
      resetForRetry: true,
      now: () => "2026-08-19T08:02:00.000Z"
    });
    expect(retried).toMatchObject({
      id: job.id,
      uploadId: job.uploadId,
      status: "waiting",
      progress: 0,
      updatedAt: "2026-08-19T08:02:00.000Z"
    });
    expect(retried.errorCode).toBeUndefined();
    expect(retried.errorMessage).toBeUndefined();
    expect(retried.finishedAt).toBeUndefined();
    await expect(store.read("jobs", job.id)).resolves.toEqual(retried);
    await expect(store.read("jobs-by-upload", job.uploadId)).resolves.toEqual(retried);
  });
});
