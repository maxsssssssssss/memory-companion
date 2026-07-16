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
});
