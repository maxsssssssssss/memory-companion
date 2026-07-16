import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioUpload, ProcessingJob } from "@/lib/domain/types";
import { UploadProcessingCancelledError, type ProcessUploadResult } from "@/lib/server/pipeline/process-upload";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  PipelineJobRetryError,
  createPipelineJobProcessor,
  finalizePipelineQueueFailure
} from "./worker";

const now = "2026-07-17T12:00:00.000Z";
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function setup(input: {
  uploadStatus?: AudioUpload["status"];
  jobStatus?: ProcessingJob["status"];
  withAudio?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "pipeline-worker-"));
  tempDirs.push(root);
  const store = new JsonStore(root);
  const uploadId = `upload_${tempDirs.length}`;
  const filePath = join(root, `${uploadId}.m4a`);
  if (input.withAudio ?? true) {
    await writeFile(filePath, "audio");
  }
  const upload: AudioUpload & { filePath?: string } = {
    id: uploadId,
    originalName: "recording.m4a",
    mimeType: "audio/mp4",
    sizeBytes: 5,
    recordingDate: "2026-07-17",
    status: input.uploadStatus ?? "uploaded",
    ...((input.withAudio ?? true) ? { filePath } : {})
  };
  const job: ProcessingJob = {
    id: `job_${tempDirs.length}`,
    uploadId,
    status: input.jobStatus ?? "waiting",
    progress: 0,
    updatedAt: now
  };
  await store.write("uploads", uploadId, upload);
  await store.write("jobs", job.id, job);
  await store.write("jobs-by-upload", uploadId, job);
  return { store, upload, job };
}

function pipelineResult(job: ProcessingJob): ProcessUploadResult {
  return {
    job,
    segments: [],
    audioInsights: [],
    semanticSegments: [],
    briefItems: [],
    relationshipSignals: [],
    proactiveInsights: []
  };
}

describe("pipeline queue worker processor", () => {
  it("consumes one payload, records processing metadata and invokes processUpload once", async () => {
    const { store, upload, job } = await setup({});
    let processingJob: ProcessingJob | null = null;
    const updateProgress = vi.fn(async (_progress: number) => undefined);
    const runProcessUpload = vi.fn(async (input) => {
      processingJob = await store.read<ProcessingJob>("jobs-by-upload", upload.id);
      const readyJob = {
        ...(processingJob ?? job),
        status: "ready",
        progress: 100,
        finishedAt: now
      } satisfies ProcessingJob;
      await input.onJobUpdate?.(readyJob);
      return pipelineResult(readyJob);
    });
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload,
      now: () => now
    });

    const result = await processor({
      data: { version: 1, uploadId: upload.id, userRef: "user_1" },
      attemptsMade: 1,
      updateProgress
    });

    expect(result).toEqual({ status: "ready", uploadId: upload.id, reconciled: false });
    expect(runProcessUpload).toHaveBeenCalledOnce();
    expect(runProcessUpload).toHaveBeenCalledWith(expect.objectContaining({
      uploadId: upload.id,
      store,
      userId: "user_1",
      onJobUpdate: expect.any(Function)
    }));
    expect(processingJob).toMatchObject({
      status: "processing",
      executionMode: "queue",
      workerStartedAt: now,
      queueAttempt: 2
    });
    expect(updateProgress.mock.calls.map(([progress]) => progress)).toEqual([0, 100]);
  });

  it("reconciles an already-ready upload without invoking processUpload", async () => {
    const { store, upload } = await setup({
      uploadStatus: "ready",
      jobStatus: "extracting",
      withAudio: false
    });
    const runProcessUpload = vi.fn();
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload: runProcessUpload as never,
      now: () => now
    });

    await expect(
      processor({ data: { version: 1, uploadId: upload.id, userRef: "user_1" } })
    ).resolves.toEqual({ status: "ready", uploadId: upload.id, reconciled: true });
    expect(runProcessUpload).not.toHaveBeenCalled();
    expect(await store.read<ProcessingJob>("jobs-by-upload", upload.id)).toMatchObject({
      status: "ready",
      progress: 100,
      finishedAt: now
    });
  });

  it("throws when processUpload resolves with a failed job so BullMQ can retry", async () => {
    const { store, upload, job } = await setup({});
    const failedJob: ProcessingJob = {
      ...job,
      status: "failed",
      errorCode: "processing_failed",
      errorMessage: "transient provider failure"
    };
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload: vi.fn(async () => pipelineResult(failedJob)),
      now: () => now
    });

    await expect(
      processor({ data: { version: 1, uploadId: upload.id, userRef: "user_1" } })
    ).rejects.toBeInstanceOf(PipelineJobRetryError);
  });

  it("projects a retryable attempt back to waiting and keeps the audio available", async () => {
    const { store, upload, job } = await setup({});
    const runProcessUpload = vi.fn(async () => {
      const failedJob: ProcessingJob = {
        ...(await store.read<ProcessingJob>("jobs-by-upload", upload.id) ?? job),
        status: "failed",
        errorCode: "processing_failed",
        errorMessage: "temporary failure"
      };
      await store.write("jobs", failedJob.id, failedJob);
      await store.write("jobs-by-upload", upload.id, failedJob);
      await store.write("uploads", upload.id, {
        ...upload,
        status: "failed",
        errorCode: "processing_failed",
        errorMessage: "temporary failure"
      });
      return pipelineResult(failedJob);
    });
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload,
      now: () => now
    });

    await expect(
      processor({
        data: { version: 1, uploadId: upload.id, userRef: "user_1" },
        attemptsMade: 0,
        opts: { attempts: 3 }
      })
    ).rejects.toBeInstanceOf(PipelineJobRetryError);

    expect(await store.read<ProcessingJob>("jobs-by-upload", upload.id)).toMatchObject({
      status: "waiting",
      errorCode: "retry_scheduled"
    });
    expect(await store.read("uploads", upload.id)).toMatchObject({
      status: "uploaded",
      filePath: upload.filePath
    });
  });

  it("projects unexpected intermediate worker errors back to waiting", async () => {
    const { store, upload } = await setup({});
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload: vi.fn(async () => {
        throw new Error("standalone worker lost a local dependency");
      }),
      now: () => now
    });

    await expect(
      processor({
        data: { version: 1, uploadId: upload.id, userRef: "user_1" },
        attemptsMade: 0,
        opts: { attempts: 3 }
      })
    ).rejects.toThrow("standalone worker lost a local dependency");

    expect(await store.read<ProcessingJob>("jobs-by-upload", upload.id)).toMatchObject({
      status: "waiting",
      errorCode: "retry_scheduled"
    });
    expect(await store.read("uploads", upload.id)).toMatchObject({
      status: "uploaded",
      filePath: upload.filePath
    });
  });

  it("converges unexpected final worker errors to failed without deleting audio", async () => {
    const { store, upload } = await setup({});
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload: vi.fn(async () => {
        throw new Error("standalone worker exhausted retries");
      }),
      now: () => now
    });

    await expect(
      processor({
        data: { version: 1, uploadId: upload.id, userRef: "user_1" },
        attemptsMade: 2,
        opts: { attempts: 3 }
      })
    ).rejects.toThrow("standalone worker exhausted retries");

    expect(await store.read<ProcessingJob>("jobs-by-upload", upload.id)).toMatchObject({
      status: "failed",
      errorCode: "queue_attempts_exhausted",
      finishedAt: now
    });
    expect(await store.read("uploads", upload.id)).toMatchObject({
      status: "failed",
      errorCode: "queue_attempts_exhausted",
      filePath: upload.filePath
    });
  });

  it("reconciles a terminal Bull failure into the product job store", async () => {
    const { store, upload } = await setup({ jobStatus: "processing" });

    await finalizePipelineQueueFailure(
      { version: 1, uploadId: upload.id, userRef: "user_1" },
      { getStore: () => store, now: () => now }
    );

    expect(await store.read<ProcessingJob>("jobs-by-upload", upload.id)).toMatchObject({
      status: "failed",
      errorCode: "queue_attempts_exhausted",
      finishedAt: now
    });
    expect(await store.read("uploads", upload.id)).toMatchObject({
      status: "failed",
      filePath: upload.filePath
    });
  });

  it("treats Bull progress updates as best-effort observability", async () => {
    const { store, upload, job } = await setup({});
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload: vi.fn(async () => pipelineResult({
        ...job,
        status: "ready",
        progress: 100
      })),
      now: () => now
    });

    await expect(
      processor({
        data: { version: 1, uploadId: upload.id, userRef: "user_1" },
        updateProgress: vi.fn(async () => {
          throw new Error("redis progress unavailable");
        })
      })
    ).resolves.toEqual({ status: "ready", uploadId: upload.id, reconciled: false });
  });

  it("marks a non-terminal upload and job failed when audio is missing", async () => {
    const { store, upload } = await setup({ withAudio: false });
    const runProcessUpload = vi.fn();
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload: runProcessUpload as never,
      now: () => now
    });

    await expect(
      processor({ data: { version: 1, uploadId: upload.id, userRef: "user_1" } })
    ).resolves.toEqual({
      status: "failed",
      uploadId: upload.id,
      reason: "audio_missing"
    });
    expect(runProcessUpload).not.toHaveBeenCalled();
    expect(await store.read<ProcessingJob>("jobs-by-upload", upload.id)).toMatchObject({
      status: "failed",
      errorCode: "audio_missing",
      finishedAt: now
    });
    expect(await store.read("uploads", upload.id)).toMatchObject({
      status: "failed",
      errorCode: "audio_missing"
    });
  });

  it("acknowledges deleted uploads, including cancellation raised during processing", async () => {
    const { store, upload } = await setup({});
    const runProcessUpload = vi.fn(async () => {
      throw new UploadProcessingCancelledError(upload.id);
    });
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload,
      now: () => now
    });

    await expect(
      processor({ data: { version: 1, uploadId: upload.id, userRef: "user_1" } })
    ).resolves.toEqual({ status: "cancelled", uploadId: upload.id, reason: "deleted" });
    expect(runProcessUpload).toHaveBeenCalledOnce();
  });

  it("acknowledges a tombstoned upload without invoking processUpload", async () => {
    const { store, upload } = await setup({});
    await store.write("deleted-uploads", upload.id, {
      uploadId: upload.id,
      deletedAt: now
    });
    const runProcessUpload = vi.fn();
    const processor = createPipelineJobProcessor({
      getStore: () => store,
      runProcessUpload: runProcessUpload as never,
      now: () => now
    });

    await expect(
      processor({ data: { version: 1, uploadId: upload.id, userRef: "user_1" } })
    ).resolves.toEqual({ status: "cancelled", uploadId: upload.id, reason: "deleted" });
    expect(runProcessUpload).not.toHaveBeenCalled();
  });

  it("rejects malformed queue payloads before resolving a user store", async () => {
    const getStore = vi.fn();
    const processor = createPipelineJobProcessor({ getStore });

    await expect(
      processor({ data: { version: 1, uploadId: "upload_1" } })
    ).rejects.toThrow();
    expect(getStore).not.toHaveBeenCalled();
  });
});
