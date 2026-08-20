// @vitest-environment node

import type Database from "better-sqlite3";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDailyReflectionJob,
  DailyReflectionRepository,
  DailyReflectionVersionConflictError,
  openDailyReflectionDatabase,
  readDailyReflectionJob,
  updateDailyReflectionJob
} from "@/lib/server/daily-reflection";
import { JsonStore } from "@/lib/server/storage/json-store";

import { recoverDailyReflectionJobs } from "./daily-reflection-recovery";
import {
  buildDailyReflectionQueueJobId,
  type DailyReflectionQueuePayload
} from "./types";

const now = "2026-08-13T12:10:00.000Z";
const old = "2026-08-13T11:00:00.000Z";
const fresh = "2026-08-13T12:09:00.000Z";

let database: Database.Database;
let repository: DailyReflectionRepository;
let store: JsonStore;
let temporaryDirectory: string;

beforeEach(async () => {
  database = openDailyReflectionDatabase({ filePath: ":memory:" });
  repository = new DailyReflectionRepository(database, { now: () => old });
  temporaryDirectory = await mkdtemp(join(tmpdir(), "daily-reflection-recovery-"));
  store = new JsonStore(temporaryDirectory);
});

afterEach(async () => {
  database.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createWorkflow(input: {
  reflectionId: string;
  uploadId?: string | null;
}) {
  return repository.createReflection({
    id: input.reflectionId,
    accountId: "account_1",
    uploadId: input.uploadId === undefined ? `upload_${input.reflectionId}` : input.uploadId,
    inputMethod: "file_upload",
    sourceOrigin: "user_reflection",
    processingProfile: "full_recording",
    ingestionContext: "daily_reflection",
    idempotencyKey: `idempotency_${input.reflectionId}`
  });
}

function transitionWorkflow(
  reflectionId: string,
  status: "uploading" | "transcribing" | "extracting" | "review_pending" | "failed" | "cancelled" | "deleted"
) {
  const reflection = repository.getReflection("account_1", reflectionId);
  return repository.transitionStatus({
    accountId: reflection.accountId,
    reflectionId,
    expectedVersion: reflection.version,
    status
  });
}

function moveToReviewPending(reflectionId: string) {
  transitionWorkflow(reflectionId, "uploading");
  transitionWorkflow(reflectionId, "transcribing");
  transitionWorkflow(reflectionId, "extracting");
  return transitionWorkflow(reflectionId, "review_pending");
}

function exposeReviewPendingToRecovery(reflectionId: string) {
  vi.spyOn(repository, "listRecoverableReflections").mockReturnValue([{
    reflection: repository.getReflection("account_1", reflectionId),
    processingPlan: repository.getProcessingPlan("account_1", reflectionId)
  }]);
}

async function writeOwnedUpload(reflectionId: string, uploadId: string) {
  await store.write("uploads", uploadId, {
    id: uploadId,
    filePath: `C:/audio/${uploadId}.wav`,
    ingestionContext: "daily_reflection",
    reflectionId
  });
}

function recoveryDependencies(access = vi.fn(async () => undefined)) {
  return {
    repository,
    getStore: vi.fn(() => store),
    access,
    now: () => now
  };
}

function enqueueResult(enqueued = true) {
  return vi.fn(async (payload: DailyReflectionQueuePayload) => ({
    jobId: buildDailyReflectionQueueJobId(payload),
    enqueued
  }));
}

describe("daily reflection startup recovery", () => {
  it("does not fail a fresh created workflow while upload persistence is in flight", async () => {
    repository = new DailyReflectionRepository(database, { now: () => fresh });
    const workflow = createWorkflow({ reflectionId: "creation_in_flight" });
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs(
      { enqueue, staleAfterMs: 5 * 60_000 },
      recoveryDependencies()
    );

    expect(report).toMatchObject({
      workflowsScanned: 1,
      freshActiveSkipped: 1,
      missingUploadFailed: 0
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(repository.getReflection("account_1", workflow.reflection.id))
      .toMatchObject({ status: "created", errorCode: null });
    await expect(readDailyReflectionJob(store, workflow.reflection.id))
      .resolves.toBeNull();
  });

  it("keeps a stale pre-plan browser workflow replayable", async () => {
    const workflow = repository.createReflection({
      id: "stale_browser_pre_plan",
      accountId: "account_1",
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "idempotency_stale_browser_pre_plan"
    });
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs({ enqueue }, recoveryDependencies());

    expect(report).toMatchObject({
      workflowsScanned: 1,
      missingPlanFailed: 0,
      racesSkipped: 1
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(repository.getReflection("account_1", workflow.reflection.id))
      .toMatchObject({
        status: "created",
        uploadId: null,
        errorCode: null
      });
  });

  it("restarts after a pre-plan raw write crash and lets only one worker clean it", async () => {
    const databasePath = join(temporaryDirectory, "restart.sqlite");
    const uploadsRootDir = join(temporaryDirectory, "restart-uploads");
    const restartStore = new JsonStore(join(temporaryDirectory, "restart-store"));
    const reflectionId = "crashed_browser_raw_write";
    const uploadId = `daily-reflection-${reflectionId}`;
    const attemptPath = join(uploadsRootDir, `${uploadId}.attempt-1.foo-bar`);
    const currentAttemptPath = join(uploadsRootDir, `${uploadId}.attempt-2.wav`);
    const unrelatedPath = join(uploadsRootDir, "other-reflection.attempt-1.wav");

    const crashedDatabase = openDailyReflectionDatabase({ filePath: databasePath });
    const crashedRepository = new DailyReflectionRepository(crashedDatabase, {
      now: () => old
    });
    try {
      const created = crashedRepository.createReflection({
        id: reflectionId,
        accountId: "account_1",
        uploadId: null,
        inputMethod: "browser_recording",
        sourceOrigin: "user_reflection",
        processingProfile: "full_recording",
        ingestionContext: "daily_reflection",
        idempotencyKey: "crashed-browser-raw-write"
      }).reflection;
      const uploading = crashedRepository.transitionStatus({
        accountId: created.accountId,
        reflectionId,
        expectedVersion: created.version,
        status: "uploading"
      });
      expect(crashedRepository.claimExecutionLease({
        accountId: created.accountId,
        reflectionId,
        leaseOwner: "crashed_browser_writer",
        leaseDurationMs: 60_000,
        uploadFingerprint: "c".repeat(64),
        provisionalUploadId: uploadId,
        allowedStatuses: ["uploading"],
        now: old
      })).toMatchObject({ attemptVersion: 1 });
      expect(crashedRepository.getReflection(created.accountId, reflectionId))
        .toMatchObject({ uploadId, version: uploading.version + 1 });
      await mkdir(uploadsRootDir, { recursive: true });
      await Promise.all([
        writeFile(attemptPath, "private browser recording"),
        writeFile(currentAttemptPath, "newer fenced recording"),
        writeFile(unrelatedPath, "unrelated private recording"),
        restartStore.write(
          "daily-reflection-asset-attempts",
          `${reflectionId}-upload-attempt-1`,
          {
            accountId: created.accountId,
            reflectionId,
            uploadId,
            attemptVersion: 1
          }
        ),
        restartStore.write(
          "daily-reflection-asset-attempts",
          `${reflectionId}-upload-attempt-2`,
          {
            accountId: created.accountId,
            reflectionId,
            uploadId,
            attemptVersion: 2
          }
        )
      ]);
      // Compatibility fixture for rows written before upload_id reservation
      // was added: ownership still has fingerprint/attempt/fence evidence.
      crashedDatabase.prepare(`
        UPDATE dr_reflections SET upload_id = NULL
        WHERE account_id = ? AND id = ?
      `).run(created.accountId, reflectionId);
      expect(crashedRepository.getReflection(created.accountId, reflectionId).uploadId)
        .toBeNull();
      // Deliberately omit bind, publish, release, and all compensation before
      // closing the connection: this is the process-abort window under test.
    } finally {
      crashedDatabase.close();
    }

    const databaseA = openDailyReflectionDatabase({ filePath: databasePath });
    const databaseB = openDailyReflectionDatabase({ filePath: databasePath });
    try {
      const repositoryA = new DailyReflectionRepository(databaseA, { now: () => now });
      const repositoryB = new DailyReflectionRepository(databaseB, { now: () => now });
      const enqueueA = enqueueResult();
      const enqueueB = enqueueResult();
      const dependencies = (activeRepository: DailyReflectionRepository) => ({
        repository: activeRepository,
        getStore: () => restartStore,
        getUploadsRootDir: () => uploadsRootDir,
        access,
        now: () => now
      });

      const [reportA, reportB] = await Promise.all([
        recoverDailyReflectionJobs({ enqueue: enqueueA }, dependencies(repositoryA)),
        recoverDailyReflectionJobs({ enqueue: enqueueB }, dependencies(repositoryB))
      ]);

      expect(reportA.provisionalCleaned + reportB.provisionalCleaned).toBe(1);
      expect(
        reportA.freshActiveSkipped + reportB.freshActiveSkipped
        + reportA.racesSkipped + reportB.racesSkipped
      ).toBe(1);
      expect(enqueueA).not.toHaveBeenCalled();
      expect(enqueueB).not.toHaveBeenCalled();
      await expect(access(attemptPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(currentAttemptPath)).resolves.toBeUndefined();
      await expect(access(unrelatedPath)).resolves.toBeUndefined();
      await expect(restartStore.listIds("daily-reflection-asset-attempts"))
        .resolves.toEqual([`${reflectionId}-upload-attempt-2`]);
      expect(repositoryA.getProcessingPlan("account_1", reflectionId)).toBeNull();
      expect(repositoryA.getProvisionalUploadOwnership("account_1", reflectionId))
        .toMatchObject({
          uploadId,
          uploadFingerprint: "c".repeat(64),
          attemptVersion: 2,
          leaseOwner: null,
          status: "uploading"
        });
    } finally {
      databaseB.close();
      databaseA.close();
    }
  });

  it("cleans a fenced browser attempt after bind commits but upload publication crashes", async () => {
    const databasePath = join(temporaryDirectory, "bound-crash.sqlite");
    const uploadsRootDir = join(temporaryDirectory, "bound-crash-uploads");
    const foreignUploadsRoot = join(temporaryDirectory, "bound-crash-foreign-uploads");
    const restartStore = new JsonStore(join(temporaryDirectory, "bound-crash-store"));
    const reflectionId = "crashed_browser_after_bind";
    const uploadId = `daily-reflection-${reflectionId}`;
    const crashedAttemptPath = join(uploadsRootDir, `${uploadId}.attempt-1.foo-bar`);
    const newerAttemptPath = join(uploadsRootDir, `${uploadId}.attempt-2.wav`);
    const foreignAttemptPath = join(
      foreignUploadsRoot,
      `${uploadId}.attempt-1.foo-bar`
    );

    const crashedDatabase = openDailyReflectionDatabase({ filePath: databasePath });
    const crashedRepository = new DailyReflectionRepository(crashedDatabase, {
      now: () => old
    });
    try {
      const created = crashedRepository.createReflection({
        id: reflectionId,
        accountId: "account_1",
        uploadId: null,
        inputMethod: "browser_recording",
        sourceOrigin: "user_reflection",
        processingProfile: "full_recording",
        ingestionContext: "daily_reflection",
        idempotencyKey: "crashed-browser-after-bind"
      }).reflection;
      const uploading = crashedRepository.transitionStatus({
        accountId: created.accountId,
        reflectionId,
        expectedVersion: created.version,
        status: "uploading"
      });
      const writerFence = crashedRepository.claimExecutionLease({
        accountId: created.accountId,
        reflectionId,
        leaseOwner: "crashed_browser_bound_writer",
        leaseDurationMs: 60_000,
        uploadFingerprint: "e".repeat(64),
        provisionalUploadId: uploadId,
        allowedStatuses: ["uploading"],
        now: old
      });
      expect(writerFence).toMatchObject({ attemptVersion: 1 });
      const bound = crashedRepository.bindUploadAndPlan({
        accountId: created.accountId,
        reflectionId,
        expectedVersion: uploading.version + 1,
        uploadId,
        processingProfile: "quick_reflection",
        leaseOwner: writerFence!.leaseOwner,
        attemptVersion: writerFence!.attemptVersion
      });
      expect(bound).toMatchObject({
        reflection: {
          uploadId,
          status: "uploading",
          processingProfile: "quick_reflection"
        },
        processingPlan: { uploadId, processingProfile: "quick_reflection" }
      });
      await Promise.all([
        mkdir(uploadsRootDir, { recursive: true }),
        mkdir(foreignUploadsRoot, { recursive: true })
      ]);
      await Promise.all([
        writeFile(crashedAttemptPath, "private browser recording after bind"),
        writeFile(newerAttemptPath, "newer fenced browser recording"),
        writeFile(foreignAttemptPath, "other account private recording"),
        restartStore.write(
          "daily-reflection-asset-attempts",
          `${reflectionId}-upload-attempt-1`,
          {
            accountId: created.accountId,
            reflectionId,
            uploadId,
            attemptVersion: 1
          }
        ),
        restartStore.write(
          "daily-reflection-asset-attempts",
          `${reflectionId}-upload-attempt-2`,
          {
            accountId: created.accountId,
            reflectionId,
            uploadId,
            attemptVersion: 2
          }
        )
      ]);
      expect(crashedRepository.readPublishedAsset({
        accountId: created.accountId,
        reflectionId,
        assetKind: "upload"
      })).toBeNull();
      // Deliberately omit upload publication, compensation, and lease release:
      // the database closes at the exact bind-committed/publish-pending window.
    } finally {
      crashedDatabase.close();
    }

    const restartedDatabase = openDailyReflectionDatabase({ filePath: databasePath });
    try {
      const restartedRepository = new DailyReflectionRepository(restartedDatabase, {
        now: () => now
      });
      const enqueue = enqueueResult();
      const report = await recoverDailyReflectionJobs({ enqueue }, {
        repository: restartedRepository,
        getStore: () => restartStore,
        getUploadsRootDir: () => uploadsRootDir,
        access,
        now: () => now
      });

      expect(report).toMatchObject({
        workflowsScanned: 1,
        missingUploadFailed: 1,
        racesSkipped: 0,
        provisionalCleaned: 0
      });
      expect(enqueue).not.toHaveBeenCalled();
      await expect(access(crashedAttemptPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(newerAttemptPath)).resolves.toBeUndefined();
      await expect(access(foreignAttemptPath)).resolves.toBeUndefined();
      await expect(restartStore.listIds("daily-reflection-asset-attempts"))
        .resolves.toEqual([`${reflectionId}-upload-attempt-2`]);
      expect(restartedRepository.getReflection("account_1", reflectionId))
        .toMatchObject({
          status: "failed",
          uploadId,
          processingProfile: "quick_reflection",
          errorCode: "daily_reflection_audio_missing"
        });
      expect(restartedRepository.getProcessingPlan("account_1", reflectionId))
        .toMatchObject({ uploadId, processingProfile: "quick_reflection" });
      expect(restartedRepository.getExecutionLease("account_1", reflectionId)).toBeNull();
      expect(() => restartedRepository.publishAssetUnderExecutionFence({
        accountId: "account_1",
        reflectionId,
        leaseOwner: "crashed_browser_bound_writer",
        attemptVersion: 1,
        assetKind: "upload",
        payload: { id: uploadId },
        now
      })).toThrowError(expect.objectContaining({
        code: "daily_reflection_lease_lost"
      }));
    } finally {
      restartedDatabase.close();
    }
  });

  it("skips a fresh active job and requeues a stale job from its persisted plan", async () => {
    const freshWorkflow = createWorkflow({ reflectionId: "fresh_reflection" });
    const staleWorkflow = createWorkflow({ reflectionId: "stale_reflection" });
    const freshPlan = freshWorkflow.processingPlan!;
    const stalePlan = staleWorkflow.processingPlan!;
    await writeOwnedUpload(freshWorkflow.reflection.id, freshPlan.uploadId);
    await writeOwnedUpload(staleWorkflow.reflection.id, stalePlan.uploadId);

    const freshJob = await createDailyReflectionJob({
      store,
      accountId: freshWorkflow.reflection.accountId,
      reflectionId: freshWorkflow.reflection.id,
      uploadId: freshPlan.uploadId,
      executionMode: "queue",
      now: () => old
    });
    await updateDailyReflectionJob(store, freshJob, {
      status: "processing",
      updatedAt: fresh
    });
    const staleJob = await createDailyReflectionJob({
      store,
      accountId: staleWorkflow.reflection.accountId,
      reflectionId: staleWorkflow.reflection.id,
      uploadId: stalePlan.uploadId,
      executionMode: "queue",
      now: () => old
    });
    await updateDailyReflectionJob(store, staleJob, {
      status: "processing",
      updatedAt: old
    });
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs({
      enqueue,
      staleAfterMs: 5 * 60_000
    }, recoveryDependencies());

    expect(report).toMatchObject({
      workflowsScanned: 2,
      enqueued: 1,
      freshActiveSkipped: 1
    });
    expect(enqueue).toHaveBeenCalledWith({
      version: 1,
      ingestionContext: "daily_reflection",
      reflectionId: staleWorkflow.reflection.id,
      userRef: staleWorkflow.reflection.accountId
    }, { reviveTerminal: true });
    expect(enqueue.mock.calls[0]?.[0]).not.toHaveProperty("uploadId");
    await expect(readDailyReflectionJob(store, staleWorkflow.reflection.id))
      .resolves.toMatchObject({
        uploadId: stalePlan.uploadId,
        status: "waiting",
        queueJobId: buildDailyReflectionQueueJobId({
          reflectionId: staleWorkflow.reflection.id,
          userRef: staleWorkflow.reflection.accountId
        })
      });
  });

  it("fails closed for an active workflow with a missing plan or missing audio", async () => {
    const missingPlan = createWorkflow({
      reflectionId: "missing_plan_reflection",
      uploadId: null
    });
    const missingUpload = createWorkflow({ reflectionId: "missing_upload_reflection" });
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs({ enqueue }, recoveryDependencies());

    expect(enqueue).not.toHaveBeenCalled();
    expect(report.workflowsScanned).toBe(2);
    expect(repository.getReflection("account_1", missingPlan.reflection.id))
      .toMatchObject({
        status: "failed",
        errorCode: "daily_reflection_processing_plan_missing"
      });
    expect(repository.getReflection("account_1", missingUpload.reflection.id))
      .toMatchObject({
        status: "failed",
        errorCode: "daily_reflection_audio_missing"
      });
  });

  it("recovers extraction from valid canonical segments without retained audio", async () => {
    const workflow = createWorkflow({ reflectionId: "extracting_without_audio" });
    const uploadId = workflow.processingPlan!.uploadId;
    const uploading = repository.transitionStatus({
      accountId: "account_1",
      reflectionId: workflow.reflection.id,
      expectedVersion: workflow.reflection.version,
      status: "uploading"
    });
    const transcribing = repository.transitionStatus({
      accountId: "account_1",
      reflectionId: workflow.reflection.id,
      expectedVersion: uploading.version,
      status: "transcribing"
    });
    repository.transitionStatus({
      accountId: "account_1",
      reflectionId: workflow.reflection.id,
      expectedVersion: transcribing.version,
      status: "extracting"
    });
    await writeOwnedUpload(workflow.reflection.id, uploadId);
    await store.write("segments", uploadId, [{
      id: "segment_extracting_without_audio",
      uploadId,
      startSeconds: 0,
      endSeconds: 3,
      text: "Canonical transcript survives raw audio cleanup.",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }]);
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs(
      { enqueue },
      recoveryDependencies(vi.fn(async () => {
        throw new Error("audio missing");
      }))
    );

    expect(report).toMatchObject({ enqueued: 1, missingUploadFailed: 0 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      reflectionId: workflow.reflection.id
    }), { reviveTerminal: true });
  });

  it("requeues incomplete review finalization without requiring retained audio", async () => {
    const workflow = createWorkflow({ reflectionId: "review_cleanup_pending" });
    const uploadId = workflow.processingPlan!.uploadId;
    moveToReviewPending(workflow.reflection.id);
    await writeOwnedUpload(workflow.reflection.id, uploadId);
    const job = await createDailyReflectionJob({
      store,
      accountId: workflow.reflection.accountId,
      reflectionId: workflow.reflection.id,
      uploadId,
      executionMode: "queue",
      now: () => old
    });
    await updateDailyReflectionJob(store, job, {
      status: "processing",
      progress: 80,
      workerStartedAt: old,
      updatedAt: old
    });
    exposeReviewPendingToRecovery(workflow.reflection.id);
    const access = vi.fn(async () => {
      throw new Error("raw audio was already removed by partial cleanup");
    });
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs(
      { enqueue },
      recoveryDependencies(access)
    );

    expect(report).toMatchObject({ enqueued: 1, missingUploadFailed: 0 });
    expect(access).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      reflectionId: workflow.reflection.id
    }), { reviveTerminal: true });
    const recoveredJob = await readDailyReflectionJob(store, workflow.reflection.id);
    expect(recoveredJob).toMatchObject({ status: "waiting", progress: 80 });
    expect(recoveredJob).not.toHaveProperty("errorCode");
    expect(recoveredJob).not.toHaveProperty("errorMessage");
  });

  it("does not requeue review finalization after cleanup was durably completed", async () => {
    const workflow = createWorkflow({ reflectionId: "review_cleanup_complete" });
    const uploadId = workflow.processingPlan!.uploadId;
    moveToReviewPending(workflow.reflection.id);
    const job = await createDailyReflectionJob({
      store,
      accountId: workflow.reflection.accountId,
      reflectionId: workflow.reflection.id,
      uploadId,
      executionMode: "queue",
      now: () => old
    });
    await updateDailyReflectionJob(store, job, {
      status: "completed",
      progress: 100,
      finishedAt: old,
      updatedAt: old
    });
    exposeReviewPendingToRecovery(workflow.reflection.id);
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs(
      { enqueue },
      recoveryDependencies()
    );

    expect(report).toMatchObject({ workflowsScanned: 1, enqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    await expect(readDailyReflectionJob(store, workflow.reflection.id))
      .resolves.toMatchObject({ status: "completed", progress: 100 });
  });

  it("keeps failed work settled until explicit retry, then recovers the resumed state", async () => {
    const workflow = createWorkflow({ reflectionId: "failed_then_retried" });
    const uploadId = workflow.processingPlan!.uploadId;
    const failed = transitionWorkflow(workflow.reflection.id, "failed");
    const enqueue = enqueueResult();

    await expect(recoverDailyReflectionJobs(
      { enqueue },
      recoveryDependencies()
    )).resolves.toMatchObject({ workflowsScanned: 0, enqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();

    repository.retryFailed({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version,
      resumeStatus: "uploading"
    });
    await writeOwnedUpload(workflow.reflection.id, uploadId);

    await expect(recoverDailyReflectionJobs(
      { enqueue },
      recoveryDependencies()
    )).resolves.toMatchObject({ workflowsScanned: 1, enqueued: 1 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      reflectionId: workflow.reflection.id
    }), { reviveTerminal: true });
  });

  it("never revives cancelled or deleted workflows", async () => {
    const cancelled = createWorkflow({ reflectionId: "cancelled_workflow" });
    const deleted = createWorkflow({ reflectionId: "deleted_workflow" });
    transitionWorkflow(cancelled.reflection.id, "cancelled");
    transitionWorkflow(deleted.reflection.id, "deleted");
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs(
      { enqueue },
      recoveryDependencies()
    );

    expect(report).toMatchObject({ workflowsScanned: 0, enqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(repository.getReflection("account_1", cancelled.reflection.id).status)
      .toBe("cancelled");
    expect(repository.getReflection("account_1", deleted.reflection.id).status)
      .toBe("deleted");
  });

  it("does not let one optimistic tombstone race block recovery of later workflows", async () => {
    const raced = createWorkflow({ reflectionId: "race_1" });
    const recoverable = createWorkflow({ reflectionId: "race_2" });
    await writeOwnedUpload(
      recoverable.reflection.id,
      recoverable.processingPlan!.uploadId
    );
    const transitionStatus = repository.transitionStatus.bind(repository);
    vi.spyOn(repository, "transitionStatus").mockImplementation((input) => {
      if (input.reflectionId === raced.reflection.id) {
        throw new DailyReflectionVersionConflictError(input.expectedVersion + 1);
      }
      return transitionStatus(input);
    });
    const enqueue = enqueueResult();

    await expect(recoverDailyReflectionJobs(
      { enqueue },
      recoveryDependencies()
    )).resolves.toMatchObject({ workflowsScanned: 2, enqueued: 1 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      reflectionId: recoverable.reflection.id
    }), { reviveTerminal: true });
  });

  it("skips a live persisted lease and recovers an expired lease", async () => {
    const live = createWorkflow({ reflectionId: "live_lease" });
    const expired = createWorkflow({ reflectionId: "expired_lease" });
    repository.claimExecutionLease({
      accountId: live.reflection.accountId,
      reflectionId: live.reflection.id,
      leaseOwner: "live_worker",
      leaseDurationMs: 2 * 60_000,
      allowedStatuses: ["created"],
      now: fresh
    });
    repository.claimExecutionLease({
      accountId: expired.reflection.accountId,
      reflectionId: expired.reflection.id,
      leaseOwner: "crashed_worker",
      leaseDurationMs: 60_000,
      allowedStatuses: ["created"],
      now: old
    });
    await writeOwnedUpload(
      expired.reflection.id,
      expired.processingPlan!.uploadId
    );
    const access = vi.fn(async () => undefined);
    const enqueue = enqueueResult();

    const report = await recoverDailyReflectionJobs(
      { enqueue },
      recoveryDependencies(access)
    );

    expect(report).toMatchObject({
      workflowsScanned: 2,
      freshActiveSkipped: 1,
      enqueued: 1,
      missingUploadFailed: 0
    });
    expect(access).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      reflectionId: expired.reflection.id
    }), { reviveTerminal: true });
    expect(repository.getReflection(live.reflection.accountId, live.reflection.id))
      .toMatchObject({ status: "created" });
  });
});
