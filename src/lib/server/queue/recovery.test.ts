import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioUpload, ProcessingJob } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  recoverPipelineJobs,
  type PipelineRecoveryEnqueue
} from "./recovery";

const now = "2026-07-17T12:00:00.000Z";
const stale = "2026-07-17T11:50:00.000Z";
const fresh = "2026-07-17T11:59:30.000Z";
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function addPipelineState(input: {
  store: JsonStore;
  uploadId: string;
  jobStatus: ProcessingJob["status"];
  uploadStatus?: AudioUpload["status"];
  updatedAt?: string;
  withAudio?: boolean;
}) {
  const filePath = join(tempDirs[0], `${input.uploadId}.m4a`);
  if (input.withAudio ?? true) {
    await writeFile(filePath, "audio");
  }
  const upload: AudioUpload & { filePath?: string } = {
    id: input.uploadId,
    originalName: `${input.uploadId}.m4a`,
    mimeType: "audio/mp4",
    sizeBytes: 5,
    recordingDate: "2026-07-17",
    status: input.uploadStatus ?? "uploaded",
    ...((input.withAudio ?? true) ? { filePath } : {})
  };
  const job: ProcessingJob = {
    id: `job_${input.uploadId}`,
    uploadId: input.uploadId,
    status: input.jobStatus,
    progress: input.jobStatus === "ready" ? 100 : 25,
    updatedAt: input.updatedAt ?? now
  };
  await input.store.write("uploads", input.uploadId, upload);
  await input.store.write("jobs", job.id, job);
  await input.store.write("jobs-by-upload", input.uploadId, job);
}

describe("pipeline startup recovery", () => {
  it("re-enqueues waiting and stale active jobs, skips fresh work and reconciles ready uploads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipeline-recovery-"));
    tempDirs.push(root);
    const rootStore = new JsonStore(join(root, "root"));
    const userStore = new JsonStore(join(root, "users", "user_1"));
    await rootStore.write("users", "user_1", { id: "user_1" });

    await addPipelineState({ store: userStore, uploadId: "waiting", jobStatus: "waiting" });
    await addPipelineState({
      store: userStore,
      uploadId: "stale_processing",
      jobStatus: "processing",
      updatedAt: stale
    });
    await addPipelineState({
      store: userStore,
      uploadId: "stale_transcribing",
      jobStatus: "transcribing",
      updatedAt: stale
    });
    await addPipelineState({
      store: userStore,
      uploadId: "stale_extracting",
      jobStatus: "extracting",
      updatedAt: stale
    });
    await addPipelineState({
      store: userStore,
      uploadId: "fresh_processing",
      jobStatus: "processing",
      updatedAt: fresh
    });
    await addPipelineState({
      store: userStore,
      uploadId: "ready_upload",
      jobStatus: "extracting",
      uploadStatus: "ready"
    });
    const enqueue = vi.fn<PipelineRecoveryEnqueue>(async (payload) => ({
      jobId: `queue_${payload.uploadId}`,
      enqueued: payload.uploadId !== "waiting"
    }));

    const report = await recoverPipelineJobs(
      { enqueue, staleAfterMs: 60_000 },
      {
        rootStore,
        getStore: () => userStore,
        now: () => now
      }
    );

    expect(enqueue.mock.calls.map(([payload]) => payload.uploadId).sort()).toEqual([
      "stale_extracting",
      "stale_processing",
      "stale_transcribing",
      "waiting"
    ]);
    expect(enqueue.mock.calls.every(([payload]) =>
      payload.version === 1 && payload.userRef === "user_1"
    )).toBe(true);
    expect(report).toMatchObject({
      usersScanned: 1,
      jobsScanned: 6,
      enqueued: 3,
      existing: 1,
      readyReconciled: 1,
      freshActiveSkipped: 1,
      missingAudioFailed: 0
    });
    expect(await userStore.read<ProcessingJob>("jobs-by-upload", "ready_upload")).toMatchObject({
      status: "ready",
      progress: 100,
      finishedAt: now
    });
    expect(await userStore.read("uploads", "ready_upload")).not.toHaveProperty("filePath");
    expect(await userStore.read<ProcessingJob>("jobs-by-upload", "stale_processing")).toMatchObject({
      status: "waiting",
      executionMode: "queue",
      queueJobId: expect.stringMatching(/^pipeline-[a-f0-9]{64}$/),
      queuedAt: now
    });
    expect(enqueue.mock.calls.every(([, options]) => options.reviveTerminal)).toBe(true);
  });

  it("marks recoverable jobs failed instead of re-enqueueing when audio is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipeline-recovery-"));
    tempDirs.push(root);
    const rootStore = new JsonStore(join(root, "root"));
    const userStore = new JsonStore(join(root, "users", "user_1"));
    await rootStore.write("users", "user_1", { id: "user_1" });
    await addPipelineState({
      store: userStore,
      uploadId: "missing_audio",
      jobStatus: "waiting",
      withAudio: false
    });
    const enqueue = vi.fn<PipelineRecoveryEnqueue>(async (payload) => ({
      jobId: `queue_${payload.uploadId}`,
      enqueued: true
    }));

    const report = await recoverPipelineJobs(
      { enqueue, staleAfterMs: 60_000 },
      { rootStore, getStore: () => userStore, now: () => now }
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(report.missingAudioFailed).toBe(1);
    expect(await userStore.read<ProcessingJob>("jobs-by-upload", "missing_audio")).toMatchObject({
      status: "failed",
      errorCode: "audio_missing",
      finishedAt: now
    });
    expect(await userStore.read("uploads", "missing_audio")).toMatchObject({
      status: "failed",
      errorCode: "audio_missing"
    });
  });
});
