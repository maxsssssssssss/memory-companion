import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  transcribeDailyReflectionAudio,
  type UploadTranscriptionProcessor
} from "@/lib/server/transcription/chunks/process-audio";

import {
  cleanupDailyReflectionCompletedAudio,
  cleanupDailyReflectionStagingAssets
} from "./cleanup";
import { buildDailyReflectionCandidates } from "./candidate-builder";
import { getDailyReflectionDatabase } from "./db";
import {
  createDailyReflectionJob,
  DailyReflectionJobConflictError,
  DailyReflectionJobNotFoundError,
  readDailyReflectionJob,
  updateDailyReflectionJob,
  type DailyReflectionJob
} from "./job-store";
import {
  createDailyReflectionRepository,
  DailyReflectionConflictError,
  DailyReflectionLeaseLostError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError,
  type DailyReflectionExecutionFence,
  type DailyReflectionRepository
} from "./repository";
import {
  publishDailyReflectionAsset,
  readDailyReflectionPublishedAsset
} from "./published-assets";
import { DailyReflectionService } from "./service";
import {
  DailyReflectionTransitionError,
  isDailyReflectionTombstone
} from "./state-machine";
import {
  isDailyReflectionUploadRecord,
  type StoredDailyReflectionUpload
} from "./upload-record";

const PROCESSING_LEASE_MS = 15 * 60_000;

export type DailyReflectionStagingResult = {
  outcome: "completed" | "reused" | "failed" | "tombstoned" | "busy";
  reflectionId: string;
  uploadId: string;
  status: string;
  candidateCount: number;
};

export type ProcessDailyReflectionUploadDependencies = {
  repository: DailyReflectionRepository;
  transcribeAudio: UploadTranscriptionProcessor;
  buildCandidates: typeof buildDailyReflectionCandidates;
  cleanupCompletedAudio: typeof cleanupDailyReflectionCompletedAudio;
  now: () => string;
  beforePublishAsset?: (
    assetKind: "upload" | "segments",
    attemptVersion: number
  ) => void | Promise<void>;
};

class DailyReflectionTombstoneRaceError extends Error {
  constructor() {
    super("Daily Reflection was cancelled or deleted during staging");
  }
}

class DailyReflectionReviewFinalizationFailedError extends Error {
  readonly code = "daily_reflection_review_finalization_failed";

  constructor(cause: unknown) {
    super("Daily Reflection review finalization failed", { cause });
  }
}

function isConcurrentDeliveryError(error: unknown) {
  return error instanceof DailyReflectionVersionConflictError
    || error instanceof DailyReflectionLeaseLostError
    || error instanceof DailyReflectionTransitionError
    || error instanceof DailyReflectionJobNotFoundError
    || error instanceof DailyReflectionJobConflictError
    || error instanceof DailyReflectionTombstoneRaceError;
}

type DailyReflectionWriteGuard = {
  accountId: string;
  reflectionId: string;
  uploadId: string;
  service: DailyReflectionService;
  repository: DailyReflectionRepository;
  fence: DailyReflectionExecutionFence;
  store: JsonStore;
  now: () => string;
};

async function assertDraftWritable(guard: DailyReflectionWriteGuard) {
  guard.repository.assertExecutionLease({
    accountId: guard.accountId,
    reflectionId: guard.reflectionId,
    leaseOwner: guard.fence.leaseOwner,
    attemptVersion: guard.fence.attemptVersion,
    now: guard.now()
  });
  const view = guard.service.get(guard.accountId, guard.reflectionId);
  const deletedMarker = await guard.store.read<{
    reflectionId?: string;
    ingestionContext?: string;
  }>("deleted-uploads", guard.uploadId);
  if (
    isDailyReflectionTombstone(view.reflection.status)
    || (
      deletedMarker?.ingestionContext === "daily_reflection"
      && deletedMarker.reflectionId === guard.reflectionId
    )
  ) {
    throw new DailyReflectionTombstoneRaceError();
  }
  if (
    view.processingPlan?.ingestionContext !== "daily_reflection"
    || view.processingPlan.uploadId !== guard.uploadId
  ) {
    throw new DailyReflectionConflictError(
      "daily_reflection_processing_plan_mismatch"
    );
  }
  return view;
}

function renewDraftLease(guard: DailyReflectionWriteGuard) {
  guard.fence = guard.repository.renewExecutionLease({
    accountId: guard.accountId,
    reflectionId: guard.reflectionId,
    leaseOwner: guard.fence.leaseOwner,
    attemptVersion: guard.fence.attemptVersion,
    leaseDurationMs: PROCESSING_LEASE_MS,
    now: guard.now()
  });
}

function safeSegments(raw: unknown, uploadId: string): TranscriptSegment[] {
  const segments = z.array(TranscriptSegmentSchema).parse(raw).map((segment) => {
    if (segment.uploadId !== uploadId) {
      throw new DailyReflectionConflictError(
        "daily_reflection_transcript_reference_mismatch"
      );
    }
    // Identity is deliberately absent on this transcript-only path. Speaker
    // labels remain raw ASR evidence and are never promoted to owner/subject.
    const { identity: _identity, ...withoutIdentity } = segment;
    return TranscriptSegmentSchema.parse(withoutIdentity);
  });
  return segments;
}

async function writeUploadStatus(
  guard: DailyReflectionWriteGuard,
  status: StoredDailyReflectionUpload["status"],
  error?: { code: string; message: string }
) {
  await assertDraftWritable(guard);
  const upload = await readDailyReflectionPublishedAsset<unknown>({
    repository: guard.repository,
    store: guard.store,
    accountId: guard.accountId,
    reflectionId: guard.reflectionId,
    uploadId: guard.uploadId,
    assetKind: "upload"
  });
  if (
    !isDailyReflectionUploadRecord(upload)
    || upload.id !== guard.uploadId
    || upload.reflectionId !== guard.reflectionId
  ) {
    throw new DailyReflectionConflictError("daily_reflection_upload_missing");
  }
  const next: StoredDailyReflectionUpload = {
    ...upload,
    status,
    ...(error
      ? { errorCode: error.code, errorMessage: error.message }
      : { errorCode: undefined, errorMessage: undefined })
  };
  await publishDailyReflectionAsset({
    repository: guard.repository,
    store: guard.store,
    accountId: guard.accountId,
    reflectionId: guard.reflectionId,
    uploadId: guard.uploadId,
    assetKind: "upload",
    fence: guard.fence,
    payload: next,
    now: guard.now()
  });
  await assertDraftWritable(guard);
  return next;
}

function resultFromView(
  outcome: DailyReflectionStagingResult["outcome"],
  view: ReturnType<DailyReflectionService["get"]>
): DailyReflectionStagingResult {
  return {
    outcome,
    reflectionId: view.reflection.id,
    uploadId: view.processingPlan?.uploadId ?? view.reflection.uploadId ?? "unknown",
    status: view.reflection.status,
    candidateCount: view.candidates.length
  };
}

async function cleanupCompletedAudioForReview(
  input: {
    accountId: string;
    reflectionId: string;
    uploadId: string;
    store: JsonStore;
    uploadsRootDir: string;
  },
  dependencies: ProcessDailyReflectionUploadDependencies
) {
  await dependencies.cleanupCompletedAudio({
    store: input.store,
    repository: dependencies.repository,
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    uploadId: input.uploadId,
    uploadsRootDir: input.uploadsRootDir
  });
}

async function completeSettledReviewPendingJob(input: {
  store: JsonStore;
  reflectionId: string;
  uploadId: string;
  now: () => string;
}) {
  const job = await readDailyReflectionJob(input.store, input.reflectionId);
  if (!job) return;
  if (job.uploadId !== input.uploadId) {
    throw new DailyReflectionJobConflictError();
  }
  if (job.status === "completed" && job.progress === 100) return;
  const now = input.now();
  await updateDailyReflectionJob(input.store, job, {
    status: "completed",
    progress: 100,
    finishedAt: job.finishedAt ?? now,
    updatedAt: now,
    errorCode: undefined,
    errorMessage: undefined
  });
}

async function markJob(
  guard: DailyReflectionWriteGuard,
  job: DailyReflectionJob,
  patch: Partial<DailyReflectionJob>
) {
  await assertDraftWritable(guard);
  const next = await updateDailyReflectionJob(guard.store, job, patch);
  await assertDraftWritable(guard);
  return next;
}

async function executeDailyReflectionUpload(
  input: {
    accountId: string;
    reflectionId: string;
    store: JsonStore;
    uploadsRootDir: string;
    executionMode: "inline" | "queue";
  },
  dependencies: ProcessDailyReflectionUploadDependencies
): Promise<DailyReflectionStagingResult> {
  let service = new DailyReflectionService(dependencies.repository, {
    readTranscriptSegments: async ({ uploadId }) =>
      (await readDailyReflectionPublishedAsset<TranscriptSegment[]>({
        repository: dependencies.repository,
        store: input.store,
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        uploadId,
        assetKind: "segments"
      })) ?? [],
    buildCandidates: dependencies.buildCandidates
  });
  let view = service.get(input.accountId, input.reflectionId);
  const plan = view.processingPlan;
  if (!plan || plan.ingestionContext !== "daily_reflection") {
    throw new DailyReflectionConflictError("daily_reflection_processing_plan_missing");
  }
  if (isDailyReflectionTombstone(view.reflection.status)) {
    await cleanupDailyReflectionStagingAssets({
      store: input.store,
      repository: dependencies.repository,
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      uploadId: plan.uploadId,
      uploadsRootDir: input.uploadsRootDir,
      removeUpload: true,
      now: dependencies.now
    });
    return resultFromView("tombstoned", view);
  }
  if (view.reflection.status === "review_pending") {
    try {
      await cleanupCompletedAudioForReview({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        uploadId: plan.uploadId,
        store: input.store,
        uploadsRootDir: input.uploadsRootDir
      }, dependencies);
      await completeSettledReviewPendingJob({
        store: input.store,
        reflectionId: input.reflectionId,
        uploadId: plan.uploadId,
        now: dependencies.now
      });
    } catch (error) {
      throw new DailyReflectionReviewFinalizationFailedError(error);
    }
    return resultFromView("reused", view);
  }
  if (view.reflection.status === "failed") {
    return resultFromView("failed", view);
  }

  const fence = dependencies.repository.claimExecutionLease({
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    leaseOwner: `daily-reflection-processor-${randomUUID()}`,
    leaseDurationMs: PROCESSING_LEASE_MS,
    allowedStatuses: ["created", "uploading", "transcribing", "extracting"],
    now: dependencies.now()
  });
  if (!fence) {
    return resultFromView(
      "busy",
      service.get(input.accountId, input.reflectionId)
    );
  }
  service = new DailyReflectionService(dependencies.repository, {
    readTranscriptSegments: async ({ uploadId }) =>
      (await readDailyReflectionPublishedAsset<TranscriptSegment[]>({
        repository: dependencies.repository,
        store: input.store,
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        uploadId,
        assetKind: "segments"
      })) ?? [],
    buildCandidates: dependencies.buildCandidates,
    executionFence: fence
  });
  view = service.get(input.accountId, input.reflectionId);

  try {
    const rawUpload = await readDailyReflectionPublishedAsset<unknown>({
      repository: dependencies.repository,
      store: input.store,
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      uploadId: plan.uploadId,
      assetKind: "upload"
    });
    if (
      !isDailyReflectionUploadRecord(rawUpload)
      || rawUpload.id !== plan.uploadId
      || rawUpload.reflectionId !== input.reflectionId
    ) {
      throw new DailyReflectionConflictError("daily_reflection_upload_missing");
    }
    const guard: DailyReflectionWriteGuard = {
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      uploadId: plan.uploadId,
      service,
      repository: dependencies.repository,
      fence,
      store: input.store,
      now: dependencies.now
    };
    let job: DailyReflectionJob | null = null;

    try {
    await assertDraftWritable(guard);
    job = await readDailyReflectionJob(input.store, input.reflectionId)
      ?? await createDailyReflectionJob({
        store: input.store,
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        uploadId: plan.uploadId,
        executionMode: input.executionMode,
        now: dependencies.now
      });
    await assertDraftWritable(guard);
    job = await markJob(guard, job, {
      status: "processing",
      workerStartedAt: dependencies.now(),
      finishedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined
    });
    if (view.reflection.status === "created") {
      service.updateStatus({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        expectedVersion: view.reflection.version,
        status: "uploading",
        leaseOwner: fence.leaseOwner,
        attemptVersion: fence.attemptVersion
      });
      view = service.get(input.accountId, input.reflectionId);
    }
    if (view.reflection.status === "uploading") {
      service.updateStatus({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        expectedVersion: view.reflection.version,
        status: "transcribing",
        leaseOwner: fence.leaseOwner,
        attemptVersion: fence.attemptVersion
      });
      view = service.get(input.accountId, input.reflectionId);
    }

    if (view.reflection.status === "transcribing") {
      await writeUploadStatus(guard, "transcribing");
      job = await markJob(guard, job, { progress: 10 });
      const storedSegments = await readDailyReflectionPublishedAsset<unknown>({
        repository: dependencies.repository,
        store: input.store,
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        uploadId: plan.uploadId,
        assetKind: "segments"
      });
      let segments: TranscriptSegment[];
      if (storedSegments !== null) {
        segments = safeSegments(storedSegments, plan.uploadId);
      } else {
        const transcribingVersion = view.reflection.version;
        renewDraftLease(guard);
        segments = safeSegments(await dependencies.transcribeAudio({
          uploadId: plan.uploadId,
          filePath: rawUpload.filePath,
          mimeType: rawUpload.mimeType,
          store: input.store,
          userId: input.accountId,
          identityPolicy: "skip",
          onChunkProgress: async ({ completed, total }) => {
            try {
              renewDraftLease(guard);
            } catch {
              // The scheduler treats progress failures as ASR failures. A lost
              // lease is therefore observed at the hard post-ASR fence below.
              return;
            }
            const currentJob = await readDailyReflectionJob(input.store, input.reflectionId);
            if (!currentJob || total <= 0) return;
            await markJob(guard, currentJob, {
              progress: Math.min(70, 10 + Math.floor((completed / total) * 60))
            }).catch(() => undefined);
          }
        }), plan.uploadId);

        await assertDraftWritable(guard);
        view = service.get(input.accountId, input.reflectionId);
        if (
          isDailyReflectionTombstone(view.reflection.status)
          || view.reflection.status !== "transcribing"
          || view.reflection.version !== transcribingVersion
        ) {
          if (isDailyReflectionTombstone(view.reflection.status)) {
            await cleanupDailyReflectionStagingAssets({
              store: input.store,
              repository: dependencies.repository,
              accountId: input.accountId,
              reflectionId: input.reflectionId,
              uploadId: plan.uploadId,
              uploadsRootDir: input.uploadsRootDir,
              removeUpload: true,
              now: dependencies.now
            });
          }
          return resultFromView(
            isDailyReflectionTombstone(view.reflection.status) ? "tombstoned" : "busy",
            view
          );
        }
        await assertDraftWritable(guard);
        await publishDailyReflectionAsset({
          repository: dependencies.repository,
          store: input.store,
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          uploadId: plan.uploadId,
          assetKind: "segments",
          fence: guard.fence,
          payload: segments,
          now: dependencies.now(),
          ...(dependencies.beforePublishAsset
            ? {
              beforePublish: () => dependencies.beforePublishAsset!(
                "segments",
                guard.fence.attemptVersion
              )
            }
            : {})
        });
        await assertDraftWritable(guard);
        view = service.get(input.accountId, input.reflectionId);
        if (
          isDailyReflectionTombstone(view.reflection.status)
          || view.reflection.status !== "transcribing"
          || view.reflection.version !== transcribingVersion
        ) {
          if (isDailyReflectionTombstone(view.reflection.status)) {
            await cleanupDailyReflectionStagingAssets({
              store: input.store,
              repository: dependencies.repository,
              accountId: input.accountId,
              reflectionId: input.reflectionId,
              uploadId: plan.uploadId,
              uploadsRootDir: input.uploadsRootDir,
              removeUpload: true,
              now: dependencies.now
            });
          }
          return resultFromView(
            isDailyReflectionTombstone(view.reflection.status) ? "tombstoned" : "busy",
            view
          );
        }
      }

      service.updateStatus({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        expectedVersion: view.reflection.version,
        status: "extracting",
        leaseOwner: fence.leaseOwner,
        attemptVersion: fence.attemptVersion
      });
      await writeUploadStatus(guard, "extracting");
      job = await markJob(guard, job, { progress: 80 });
      view = service.get(input.accountId, input.reflectionId);
    }

    if (view.reflection.status !== "extracting") {
      throw new DailyReflectionConflictError(
        "daily_reflection_not_ready_for_candidate_extraction"
      );
    }
    renewDraftLease(guard);
    await assertDraftWritable(guard);
    const workerResult = await service.executeCandidateWorker({
      accountId: input.accountId,
      reflectionId: input.reflectionId
    });
    await assertDraftWritable(guard);
    view = service.get(input.accountId, input.reflectionId);
    if (
      workerResult.outcome === "tombstoned"
      || isDailyReflectionTombstone(view.reflection.status)
    ) {
      await cleanupDailyReflectionStagingAssets({
        store: input.store,
        repository: dependencies.repository,
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        uploadId: plan.uploadId,
        uploadsRootDir: input.uploadsRootDir,
        removeUpload: true,
        now: dependencies.now
      });
      return resultFromView("tombstoned", view);
    }
    if (workerResult.outcome === "failed") {
      await writeUploadStatus(guard, "failed", {
        code: view.reflection.errorCode ?? "daily_reflection_extraction_failed",
        message: "Daily Reflection candidate extraction failed"
      });
      await markJob(guard, job, {
        status: "failed",
        progress: 80,
        finishedAt: dependencies.now(),
        errorCode: view.reflection.errorCode ?? "daily_reflection_extraction_failed",
        errorMessage: "Daily Reflection candidate extraction failed"
      });
      return resultFromView("failed", view);
    }
    try {
      await cleanupCompletedAudioForReview({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        uploadId: plan.uploadId,
        store: input.store,
        uploadsRootDir: input.uploadsRootDir
      }, dependencies);
      await markJob(guard, job, {
        status: "completed",
        progress: 100,
        finishedAt: dependencies.now()
      });
    } catch (error) {
      throw new DailyReflectionReviewFinalizationFailedError(error);
    }
    return resultFromView(workerResult.outcome, view);
    } catch (error) {
    let current;
    try {
      current = service.get(input.accountId, input.reflectionId);
    } catch (readError) {
      if (readError instanceof DailyReflectionNotFoundError) throw error;
      throw readError;
    }
    if (isDailyReflectionTombstone(current.reflection.status)) {
      await cleanupDailyReflectionStagingAssets({
        store: input.store,
        repository: dependencies.repository,
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        uploadId: plan.uploadId,
        uploadsRootDir: input.uploadsRootDir,
        removeUpload: true,
        now: dependencies.now
      });
      return resultFromView("tombstoned", current);
    }
    if (current.reflection.status === "review_pending") {
      if (error instanceof DailyReflectionReviewFinalizationFailedError) {
        throw error;
      }
      return resultFromView("reused", current);
    }
    if (isConcurrentDeliveryError(error)) {
      return resultFromView("busy", current);
    }
    if (
      current.reflection.status === "created"
      || current.reflection.status === "uploading"
      || current.reflection.status === "transcribing"
      || current.reflection.status === "extracting"
    ) {
      try {
        const failed = service.updateStatus({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          expectedVersion: current.reflection.version,
          status: "failed",
          errorCode: "daily_reflection_processing_failed",
          errorMessage: "Daily Reflection staging failed",
          leaseOwner: fence.leaseOwner,
          attemptVersion: fence.attemptVersion
        });
        await writeUploadStatus(guard, "failed", {
          code: "daily_reflection_processing_failed",
          message: "Daily Reflection staging failed"
        });
        if (job) {
          await markJob(guard, job, {
            status: "failed",
            finishedAt: dependencies.now(),
            errorCode: "daily_reflection_processing_failed",
            errorMessage: "Daily Reflection staging failed"
          });
        }
        return resultFromView("failed", service.get(failed.accountId, failed.id));
      } catch (settleError) {
        const latest = service.get(input.accountId, input.reflectionId);
        if (isDailyReflectionTombstone(latest.reflection.status)) {
          await cleanupDailyReflectionStagingAssets({
            store: input.store,
            repository: dependencies.repository,
            accountId: input.accountId,
            reflectionId: input.reflectionId,
            uploadId: plan.uploadId,
            uploadsRootDir: input.uploadsRootDir,
            removeUpload: true,
            now: dependencies.now
          });
          return resultFromView("tombstoned", latest);
        }
        if (
          latest.reflection.status === "review_pending"
          || isConcurrentDeliveryError(settleError)
        ) {
          return resultFromView(
            latest.reflection.status === "review_pending" ? "reused" : "busy",
            latest
          );
        }
        throw settleError;
      }
    }
    throw error;
    }
  } finally {
    dependencies.repository.releaseExecutionLease({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
  }
}

export function processDailyReflectionUpload(
  input: {
    accountId: string;
    reflectionId: string;
    store: JsonStore;
    uploadsRootDir: string;
    executionMode: "inline" | "queue";
  },
  dependencies: Partial<ProcessDailyReflectionUploadDependencies> = {}
) {
  const resolved: ProcessDailyReflectionUploadDependencies = {
    repository: dependencies.repository
      ?? createDailyReflectionRepository(getDailyReflectionDatabase()),
    transcribeAudio: dependencies.transcribeAudio ?? transcribeDailyReflectionAudio,
    buildCandidates: dependencies.buildCandidates ?? buildDailyReflectionCandidates,
    cleanupCompletedAudio: dependencies.cleanupCompletedAudio
      ?? cleanupDailyReflectionCompletedAudio,
    now: dependencies.now ?? (() => new Date().toISOString()),
    ...(dependencies.beforePublishAsset
      ? { beforePublishAsset: dependencies.beforePublishAsset }
      : {})
  };
  return executeDailyReflectionUpload(input, resolved);
}
