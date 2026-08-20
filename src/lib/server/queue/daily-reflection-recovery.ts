import * as fs from "node:fs/promises";

import {
  createDailyReflectionJob,
  cleanupDailyReflectionBoundUploadAttemptAudio,
  cleanupDailyReflectionProvisionalAssets,
  hasDailyReflectionProvisionalAssets,
  DailyReflectionCleanupOwnershipError,
  DailyReflectionLeaseLostError,
  DailyReflectionNotFoundError,
  DailyReflectionTransitionError,
  DailyReflectionVersionConflictError,
  getDailyReflectionRepository,
  isDailyReflectionUploadRecord,
  parseDailyReflectionCanonicalTranscript,
  readDailyReflectionPublishedAsset,
  readDailyReflectionJob,
  updateDailyReflectionJob,
  type DailyReflectionRepository
} from "@/lib/server/daily-reflection";
import {
  getUserScopedStore,
  getUserUploadsRootDir
} from "@/lib/server/auth/session";
import type { JsonStore } from "@/lib/server/storage/json-store";

import type { EnqueuePipelineJobResult } from "./producer";
import {
  buildDailyReflectionQueueJobId,
  type DailyReflectionQueuePayload
} from "./types";

export type DailyReflectionRecoveryReport = {
  workflowsScanned: number;
  enqueued: number;
  existing: number;
  freshActiveSkipped: number;
  missingUploadFailed: number;
  missingPlanFailed: number;
  racesSkipped: number;
  provisionalCleaned: number;
};

export type DailyReflectionRecoveryOptions = {
  enqueue: (
    payload: DailyReflectionQueuePayload,
    options: { reviveTerminal: true }
  ) => Promise<EnqueuePipelineJobResult>;
  staleAfterMs?: number;
};

export type DailyReflectionRecoveryDependencies = {
  repository: DailyReflectionRepository;
  getStore: (userRef: string) => JsonStore;
  getUploadsRootDir: (userRef: string) => string;
  access: typeof fs.access;
  now: () => string;
};

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

function isFresh(timestamp: string, nowMs: number, staleAfterMs: number) {
  const updatedMs = Date.parse(timestamp);
  return Number.isFinite(updatedMs) && nowMs - updatedMs < staleAfterMs;
}

export async function recoverDailyReflectionJobs(
  options: DailyReflectionRecoveryOptions,
  dependencies: Partial<DailyReflectionRecoveryDependencies> = {}
): Promise<DailyReflectionRecoveryReport> {
  const resolved: DailyReflectionRecoveryDependencies = {
    repository: dependencies.repository ?? getDailyReflectionRepository(),
    getStore: dependencies.getStore ?? getUserScopedStore,
    getUploadsRootDir: dependencies.getUploadsRootDir ?? getUserUploadsRootDir,
    access: dependencies.access ?? fs.access,
    now: dependencies.now ?? (() => new Date().toISOString())
  };
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = resolved.now();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error("invalid_daily_reflection_recovery_clock");
  }
  const report: DailyReflectionRecoveryReport = {
    workflowsScanned: 0,
    enqueued: 0,
    existing: 0,
    freshActiveSkipped: 0,
    missingUploadFailed: 0,
    missingPlanFailed: 0,
    racesSkipped: 0,
    provisionalCleaned: 0
  };

  const handledProvisional = new Set<string>();
  for (const listed of resolved.repository.listProvisionalUploadOwnerships()) {
    report.workflowsScanned += 1;
    const workflowKey = `${listed.accountId}\u0000${listed.reflectionId}`;
    try {
      const current = resolved.repository.getProvisionalUploadOwnership(
        listed.accountId,
        listed.reflectionId
      );
      if (!current) {
        report.racesSkipped += 1;
        continue;
      }
      handledProvisional.add(workflowKey);
      if (current.leaseUntil && Date.parse(current.leaseUntil) > nowMs) {
        report.freshActiveSkipped += 1;
        continue;
      }
      if (
        (current.status === "created" || current.status === "uploading")
        && isFresh(current.updatedAt, nowMs, staleAfterMs)
      ) {
        report.freshActiveSkipped += 1;
        continue;
      }
      const store = resolved.getStore(current.accountId);
      const uploadsRootDir = resolved.getUploadsRootDir(current.accountId);
      if (!await hasDailyReflectionProvisionalAssets({
        store,
        repository: resolved.repository,
        accountId: current.accountId,
        reflectionId: current.reflectionId,
        uploadId: current.uploadId,
        uploadsRootDir,
        maxAttemptVersion: current.attemptVersion
      })) {
        report.racesSkipped += 1;
        continue;
      }
      const recoveryLeaseDurationMs = Math.max(
        DEFAULT_STALE_AFTER_MS,
        staleAfterMs || 1
      );
      const fence = resolved.repository.claimExecutionLease({
        accountId: current.accountId,
        reflectionId: current.reflectionId,
        leaseOwner: `daily-reflection-provisional-recovery-${current.attemptVersion + 1}`,
        leaseDurationMs: recoveryLeaseDurationMs,
        uploadFingerprint: current.uploadFingerprint,
        provisionalUploadId: current.uploadId,
        expectedAttemptVersion: current.attemptVersion,
        allowedStatuses: [current.status],
        now
      });
      if (!fence) {
        report.racesSkipped += 1;
        continue;
      }
      try {
        const claimed = resolved.repository.getProvisionalUploadOwnership(
          current.accountId,
          current.reflectionId
        );
        if (!claimed || claimed.attemptVersion !== fence.attemptVersion) {
          report.racesSkipped += 1;
          continue;
        }
        await cleanupDailyReflectionProvisionalAssets({
          store,
          repository: resolved.repository,
          accountId: current.accountId,
          reflectionId: current.reflectionId,
          uploadId: current.uploadId,
          uploadsRootDir,
          maxAttemptVersion: fence.attemptVersion - 1,
          executionFence: fence,
          renewExecutionFence: () => {
            resolved.repository.renewExecutionLease({
              accountId: current.accountId,
              reflectionId: current.reflectionId,
              leaseOwner: fence.leaseOwner,
              attemptVersion: fence.attemptVersion,
              leaseDurationMs: recoveryLeaseDurationMs,
              now: resolved.now()
            });
          },
          ...(current.status === "cancelled" || current.status === "deleted"
            ? { tombstone: true }
            : {})
        });
        report.provisionalCleaned += 1;
      } finally {
        resolved.repository.releaseExecutionLease({
          accountId: current.accountId,
          reflectionId: current.reflectionId,
          leaseOwner: fence.leaseOwner,
          attemptVersion: fence.attemptVersion
        });
      }
    } catch (error) {
      if (
        error instanceof DailyReflectionVersionConflictError
        || error instanceof DailyReflectionTransitionError
        || error instanceof DailyReflectionNotFoundError
        || error instanceof DailyReflectionLeaseLostError
        || error instanceof DailyReflectionCleanupOwnershipError
      ) {
        report.racesSkipped += 1;
        continue;
      }
      throw error;
    }
  }

  for (const { reflection, processingPlan } of resolved.repository.listRecoverableReflections()) {
    if (handledProvisional.has(`${reflection.accountId}\u0000${reflection.id}`)) {
      continue;
    }
    report.workflowsScanned += 1;
    try {
      const executionLease = resolved.repository.getExecutionLease(
        reflection.accountId,
        reflection.id
      );
      if (
        executionLease
        && Date.parse(executionLease.leaseUntil) > nowMs
      ) {
        report.freshActiveSkipped += 1;
        continue;
      }
      // Creation persists the canonical reflection before the upload assets and
      // queue bookkeeping. Recovery must not classify that intentional window
      // as missing data while the creator is still active.
      if (isFresh(reflection.updatedAt, nowMs, staleAfterMs)) {
        report.freshActiveSkipped += 1;
        continue;
      }
      const store = resolved.getStore(reflection.accountId);
      let job = await readDailyReflectionJob(store, reflection.id);
      if (
        reflection.status === "review_pending"
        && job?.status === "completed"
        && job.progress === 100
      ) {
        continue;
      }
      if (
        job?.status === "processing"
        && isFresh(job.updatedAt, nowMs, staleAfterMs)
      ) {
        report.freshActiveSkipped += 1;
        continue;
      }
      if (!processingPlan) {
        // Browser recording creation intentionally persists the reflection
        // before authoritative duration probing can bind an upload and plan.
        // A retryable pre-plan failure remains replayable through the same
        // idempotency key even after the freshness window has elapsed.
        if (
          reflection.inputMethod === "browser_recording"
          && reflection.uploadId === null
          && (reflection.status === "created" || reflection.status === "uploading")
        ) {
          report.racesSkipped += 1;
          continue;
        }
        resolved.repository.transitionStatus({
          accountId: reflection.accountId,
          reflectionId: reflection.id,
          expectedVersion: reflection.version,
          status: "failed",
          errorCode: "daily_reflection_processing_plan_missing",
          errorMessage: "Daily Reflection processing plan is unavailable"
        });
        report.missingPlanFailed += 1;
        continue;
      }
      const rawUpload = await readDailyReflectionPublishedAsset<unknown>({
        repository: resolved.repository,
        store,
        accountId: reflection.accountId,
        reflectionId: reflection.id,
        uploadId: processingPlan.uploadId,
        assetKind: "upload"
      });
      const uploadRecordAvailable = isDailyReflectionUploadRecord(rawUpload)
        && rawUpload.reflectionId === reflection.id;
      const rawCanonicalTranscript = await readDailyReflectionPublishedAsset<unknown>({
        repository: resolved.repository,
        store,
        accountId: reflection.accountId,
        reflectionId: reflection.id,
        uploadId: processingPlan.uploadId,
        assetKind: "segments"
      });
      const canonicalTranscriptAvailable = parseDailyReflectionCanonicalTranscript(
        rawCanonicalTranscript,
        processingPlan.uploadId
      ) !== null;
      if (!uploadRecordAvailable) {
        // review_pending cannot legally transition back to failed. Its upload
        // record is also the ownership proof required by cleanup, so isolate a
        // corrupt row instead of reviving it without that proof.
        if (reflection.status === "review_pending") {
          report.racesSkipped += 1;
          continue;
        }
        const uploadFingerprint = resolved.repository.getUploadFingerprint(
          reflection.accountId,
          reflection.id
        );
        if (
          rawUpload === null
          &&
          reflection.inputMethod === "browser_recording"
          && reflection.status === "uploading"
          && reflection.uploadId === processingPlan.uploadId
          && executionLease
          && uploadFingerprint
        ) {
          const recoveryLeaseDurationMs = Math.max(
            DEFAULT_STALE_AFTER_MS,
            staleAfterMs || 1
          );
          const fence = resolved.repository.claimExecutionLease({
            accountId: reflection.accountId,
            reflectionId: reflection.id,
            leaseOwner:
              `daily-reflection-bound-upload-recovery-${executionLease.attemptVersion + 1}`,
            leaseDurationMs: recoveryLeaseDurationMs,
            uploadFingerprint,
            expectedAttemptVersion: executionLease.attemptVersion,
            allowedStatuses: ["uploading"],
            now
          });
          if (!fence) {
            report.racesSkipped += 1;
            continue;
          }
          try {
            const publishedAfterClaim = await readDailyReflectionPublishedAsset<unknown>({
              repository: resolved.repository,
              store,
              accountId: reflection.accountId,
              reflectionId: reflection.id,
              uploadId: processingPlan.uploadId,
              assetKind: "upload"
            });
            if (publishedAfterClaim !== null) {
              report.racesSkipped += 1;
              continue;
            }
            await cleanupDailyReflectionBoundUploadAttemptAudio({
              store,
              repository: resolved.repository,
              accountId: reflection.accountId,
              reflectionId: reflection.id,
              uploadId: processingPlan.uploadId,
              uploadsRootDir: resolved.getUploadsRootDir(reflection.accountId),
              maxAttemptVersion: fence.attemptVersion - 1,
              executionFence: fence,
              renewExecutionFence: () => {
                resolved.repository.renewExecutionLease({
                  accountId: reflection.accountId,
                  reflectionId: reflection.id,
                  leaseOwner: fence.leaseOwner,
                  attemptVersion: fence.attemptVersion,
                  leaseDurationMs: recoveryLeaseDurationMs,
                  now: resolved.now()
                });
              }
            });
            resolved.repository.transitionStatus({
              accountId: reflection.accountId,
              reflectionId: reflection.id,
              expectedVersion: reflection.version,
              status: "failed",
              errorCode: "daily_reflection_audio_missing",
              errorMessage: "Daily Reflection audio is unavailable",
              leaseOwner: fence.leaseOwner,
              attemptVersion: fence.attemptVersion
            });
            report.missingUploadFailed += 1;
          } finally {
            resolved.repository.releaseExecutionLease({
              accountId: reflection.accountId,
              reflectionId: reflection.id,
              leaseOwner: fence.leaseOwner,
              attemptVersion: fence.attemptVersion
            });
          }
          continue;
        }
        resolved.repository.transitionStatus({
          accountId: reflection.accountId,
          reflectionId: reflection.id,
          expectedVersion: reflection.version,
          status: "failed",
          errorCode: "daily_reflection_audio_missing",
          errorMessage: "Daily Reflection audio is unavailable"
        });
        report.missingUploadFailed += 1;
        continue;
      }
      if (reflection.status === "extracting" && !canonicalTranscriptAvailable) {
        resolved.repository.transitionStatus({
          accountId: reflection.accountId,
          reflectionId: reflection.id,
          expectedVersion: reflection.version,
          status: "failed",
          errorCode: "daily_reflection_transcript_segments_missing",
          errorMessage: "Daily Reflection canonical transcript is unavailable"
        });
        report.missingUploadFailed += 1;
        continue;
      }
      const requiresAudio = reflection.status !== "extracting"
        && reflection.status !== "review_pending"
        && !canonicalTranscriptAvailable;
      if (
        requiresAudio
        && !await resolved.access(rawUpload.filePath).then(() => true, () => false)
      ) {
        resolved.repository.transitionStatus({
          accountId: reflection.accountId,
          reflectionId: reflection.id,
          expectedVersion: reflection.version,
          status: "failed",
          errorCode: "daily_reflection_audio_missing",
          errorMessage: "Daily Reflection audio is unavailable"
        });
        report.missingUploadFailed += 1;
        continue;
      }

      const payload: DailyReflectionQueuePayload = {
        version: 1,
        ingestionContext: "daily_reflection",
        reflectionId: reflection.id,
        userRef: reflection.accountId
      };
      const queueJobId = buildDailyReflectionQueueJobId(payload);
      job ??= await createDailyReflectionJob({
        store,
        accountId: reflection.accountId,
        reflectionId: reflection.id,
        uploadId: processingPlan.uploadId,
        executionMode: "queue",
        queueJobId,
        queuedAt: now,
        now: () => now
      });
      await updateDailyReflectionJob(store, job, {
        status: "waiting",
        executionMode: "queue",
        queueJobId,
        queuedAt: now,
        workerStartedAt: undefined,
        finishedAt: undefined,
        errorCode: undefined,
        errorMessage: undefined,
        updatedAt: now
      });
      const queued = await options.enqueue(payload, { reviveTerminal: true });
      if (queued.enqueued) report.enqueued += 1;
      else report.existing += 1;
    } catch (error) {
      if (
        error instanceof DailyReflectionVersionConflictError
        || error instanceof DailyReflectionTransitionError
        || error instanceof DailyReflectionNotFoundError
        || error instanceof DailyReflectionLeaseLostError
        || error instanceof DailyReflectionCleanupOwnershipError
      ) {
        report.racesSkipped += 1;
        continue;
      }
      throw error;
    }
  }
  return report;
}
