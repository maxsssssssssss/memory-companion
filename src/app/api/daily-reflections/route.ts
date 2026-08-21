import { createHash, randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";

import {
  DailyReflectionDurationPolicyError,
  normalizeDailyReflectionClientReportedDurationMs
} from "@/lib/domain/daily-reflection-duration";
import { DailyReflectionHistoryResponseSchema } from "@/lib/domain/daily-reflection-api";
import { InputMethodSchema, type InputMethod } from "@/lib/domain/daily-reflection";
import { AudioUploadSchema } from "@/lib/domain/types";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  cleanupDailyReflectionUploadPersistenceFailure,
  DailyReflectionConflictError,
  DailyReflectionDurationProbeError,
  DailyReflectionLeaseLostError,
  DailyReflectionInputContractError,
  DailyReflectionInputOrchestrator,
  DailyReflectionService,
  DailyReflectionTransitionError,
  DailyReflectionVersionConflictError,
  getDailyReflectionRepository,
  isDailyReflectionUploadRecord,
  isDailyReflectionTombstone,
  isDailyReflectionBrowserRecordingEnabled,
  isDailyReflectionToySyncEnabled,
  isDailyReflectionUploadEnabled,
  parseDailyReflectionCanonicalTranscript,
  publishDailyReflectionAsset,
  processDailyReflectionUpload,
  readDailyReflectionPublishedAsset,
  readDailyReflectionJob,
  resolveDailyReflectionAuthoritativeDuration,
  resolveDailyReflectionInputContract,
  type DailyReflectionInputReceiptV2,
} from "@/lib/server/daily-reflection";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueDailyReflectionJob } from "@/lib/server/queue/producer";
import { buildDailyReflectionQueueJobId } from "@/lib/server/queue/types";
import { retrievalSourceStatement } from "@/lib/server/retrieval/source-awareness";
import {
  AudioUploadPersistenceError,
  normalizeUploadRecordingDate,
  persistAudioUpload
} from "@/lib/server/uploads/storage";
import { validateAudioUpload } from "@/lib/server/uploads/validation";

const uploadPersistenceExecutions = new Map<string, Promise<void>>();
const UPLOAD_PERSISTENCE_LEASE_MS = 2 * 60_000;

function featureDisabled() {
  return NextResponse.json({ error: "feature_disabled" }, { status: 404 });
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function parseInputMethod(formData: FormData): InputMethod | null {
  const value = formString(formData, "inputMethod") || "file_upload";
  const parsed = InputMethodSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function clientReportedDurationMs(formData: FormData) {
  const rawValue = formString(formData, "clientReportedDurationMs");
  if (!rawValue || !/^\d+$/u.test(rawValue)) return null;
  return normalizeDailyReflectionClientReportedDurationMs(Number(rawValue));
}

function receipt(input: {
  operation: DailyReflectionInputReceiptV2;
  status: string;
  executionMode: "inline" | "queue";
  queueJobId?: string;
  reused?: boolean;
}) {
  return {
    reflectionId: input.operation.reflectionId,
    uploadId: input.operation.uploadId,
    jobId: input.operation.jobId,
    operationKey: input.operation.operationKey,
    contentHash: input.operation.contentHash,
    capturePurpose: input.operation.capturePurpose,
    status: input.status,
    executionMode: input.executionMode,
    ...(input.queueJobId ? { queueJobId: input.queueJobId } : {}),
    ...(input.reused ? { reused: true } : {})
  };
}

export async function GET(request: Request) {
  if (!isDailyReflectionUploadEnabled()) return featureDisabled();
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }

  const repository = getDailyReflectionRepository();
  const reflections = await Promise.all(
    repository.listAccountReflections(authContext.user.id).map(async (reflection) => {
      const detail = repository.getReflectionDetail(authContext.user.id, reflection.id);
      const plan = detail.processingPlan;
      let recordingDate: string | null = null;
      let transcriptAvailable = false;
      if (plan) {
        const [rawUpload, rawSegments] = await Promise.all([
          readDailyReflectionPublishedAsset<unknown>({
            repository,
            store: authContext.store,
            accountId: authContext.user.id,
            reflectionId: reflection.id,
            uploadId: plan.uploadId,
            assetKind: "upload"
          }),
          readDailyReflectionPublishedAsset<unknown>({
            repository,
            store: authContext.store,
            accountId: authContext.user.id,
            reflectionId: reflection.id,
            uploadId: plan.uploadId,
            assetKind: "segments"
          })
        ]);
        const upload = AudioUploadSchema.safeParse(rawUpload);
        if (
          upload.success
          && isDailyReflectionUploadRecord(rawUpload)
          && rawUpload.reflectionId === reflection.id
          && upload.data.id === plan.uploadId
        ) {
          recordingDate = upload.data.recordingDate;
        }
        const segments = parseDailyReflectionCanonicalTranscript(rawSegments, plan.uploadId);
        transcriptAvailable = Boolean(segments?.length);
      }
      const pendingCount = detail.candidates.filter((candidate) => candidate.status === "pending").length;
      const keptCount = detail.candidates.filter((candidate) => candidate.status === "kept").length;
      const excludedCount = detail.candidates.filter((candidate) => candidate.status === "excluded").length;
      const rememberedCount = detail.admissionOperation
        ? repository.getRememberedCandidateCount(authContext.user.id, reflection.id)
        : 0;
      const revokedCount = Math.max(
        0,
        (detail.admissionOperation?.admittedCount ?? 0) - rememberedCount
      );
      const subjectPersonIds = [...new Set(detail.candidates
        .filter((candidate) => candidate.status === "kept" && candidate.subjectConfirmed)
        .map((candidate) => candidate.subjectPersonId)
        .filter((personId): personId is string => Boolean(personId)))];
      const displayOrigin = reflection.sourceOrigin === "user_reflection"
        ? "user_reflection"
        : reflection.sourceOrigin === "direct_conversation"
          ? "direct_conversation"
          : "unknown";
      const date = recordingDate ?? reflection.createdAt.slice(0, 10);
      return {
        id: reflection.id,
        status: reflection.status,
        inputMethod: reflection.inputMethod,
        sourceOrigin: displayOrigin,
        recordingDate,
        sourceStatement: retrievalSourceStatement(displayOrigin, date),
        candidateCount: detail.candidates.length,
        pendingCount,
        keptCount,
        excludedCount,
        rememberedCount,
        notSavedCount: detail.admissionOperation
          ? detail.admissionOperation.rejectedCount
            + detail.admissionOperation.excludedCount
            + revokedCount
          : excludedCount,
        subjectPersonIds,
        transcriptAvailable,
        createdAt: reflection.createdAt,
        updatedAt: reflection.updatedAt
      };
    })
  );
  return NextResponse.json(DailyReflectionHistoryResponseSchema.parse({ reflections }), {
    headers: { "Cache-Control": "private, no-store" }
  });
}

export async function POST(request: Request) {
  if (!isDailyReflectionUploadEnabled()) return featureDisabled();

  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_multipart" }, { status: 400 });
  }
  const inputMethod = parseInputMethod(formData);
  if (!inputMethod) {
    return NextResponse.json({ error: "invalid_input_method" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }
  const validation = validateAudioUpload(file);
  if (!validation.ok) {
    return NextResponse.json({
      error: validation.errorCode,
      message: validation.message
    }, { status: 400 });
  }
  const recordingDate = normalizeUploadRecordingDate(formData.get("recordingDate"));
  let inputContract;
  try {
    inputContract = resolveDailyReflectionInputContract({
      inputMethod,
      inputAdapter: formString(formData, "inputAdapter"),
      sourceOrigin: formString(formData, "sourceOrigin"),
      capturePurpose: formString(formData, "capturePurpose"),
      operationKey: formString(formData, "operationKey")
        || formString(formData, "idempotencyKey"),
      recordingDate
    });
  } catch (error) {
    if (error instanceof DailyReflectionInputContractError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    throw error;
  }
  if (
    inputContract.inputAdapter === "browser_recorder"
    && !isDailyReflectionBrowserRecordingEnabled()
  ) {
    return featureDisabled();
  }
  if (
    inputContract.inputAdapter === "toy_sync"
    && !isDailyReflectionToySyncEnabled()
  ) {
    return featureDisabled();
  }
  const reportedDurationMs = clientReportedDurationMs(formData);
  let uploadFingerprint: string;
  try {
    uploadFingerprint = createHash("sha256")
      .update(new Uint8Array(await file.arrayBuffer()))
      .digest("hex");
  } catch {
    return NextResponse.json({ error: "invalid_upload_body" }, { status: 400 });
  }

  const repository = getDailyReflectionRepository();
  const service = new DailyReflectionService(repository);
  const orchestrator = new DailyReflectionInputOrchestrator(repository);
  let created;
  try {
    created = orchestrator.reserve({
      accountId: authContext.user.id,
      ...inputContract,
      contentHash: uploadFingerprint
    });
  } catch (error) {
    if (error instanceof DailyReflectionConflictError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    throw error;
  }

  if (created.reflection.status === "deleted") return featureDisabled();
  if (created.reflection.status === "cancelled") {
    return NextResponse.json({ error: "daily_reflection_cancelled" }, { status: 409 });
  }

  const executionMode = resolvePipelineExecutionMode();
  let view = service.get(authContext.user.id, created.reflection.id);
  const operationReceipt = created.receipt;
  const uploadId = operationReceipt.uploadId;

  const persistenceKey = `${authContext.user.id}\u0000${created.reflection.id}`;
  const persistedFingerprint = repository.getUploadFingerprint(
    authContext.user.id,
    created.reflection.id
  );
  if (persistedFingerprint && persistedFingerprint !== uploadFingerprint) {
    return NextResponse.json({
      error: "daily_reflection_idempotency_conflict"
    }, { status: 409 });
  }

  const readPublishedUpload = () => readDailyReflectionPublishedAsset<unknown>({
    repository,
    store: authContext.store,
    accountId: authContext.user.id,
    reflectionId: created.reflection.id,
    uploadId,
    assetKind: "upload"
  });
  let rawStoredUpload = await readPublishedUpload();
  let uploadAvailable = rawStoredUpload !== null;
  if (!uploadAvailable && view.reflection.status === "created") {
    try {
      service.updateStatus({
        accountId: authContext.user.id,
        reflectionId: created.reflection.id,
        expectedVersion: view.reflection.version,
        status: "uploading"
      });
    } catch (error) {
      if (
        !(error instanceof DailyReflectionVersionConflictError)
        && !(error instanceof DailyReflectionTransitionError)
      ) {
        throw error;
      }
    }
    view = service.get(authContext.user.id, created.reflection.id);
  } else if (
    !uploadAvailable
    && view.reflection.status === "failed"
    && view.reflection.errorCode === "daily_reflection_upload_persist_failed"
  ) {
    try {
      service.requestRetry({
        accountId: authContext.user.id,
        reflectionId: created.reflection.id,
        expectedVersion: view.reflection.version,
        resumeStatus: "uploading"
      });
    } catch (error) {
      if (
        !(error instanceof DailyReflectionVersionConflictError)
        && !(error instanceof DailyReflectionTransitionError)
      ) {
        throw error;
      }
    }
    view = service.get(authContext.user.id, created.reflection.id);
  }

  let joinedPersistence = false;
  if (!uploadAvailable) {
    const inFlight = uploadPersistenceExecutions.get(persistenceKey);
    if (inFlight) {
      joinedPersistence = true;
      await inFlight.catch(() => undefined);
      rawStoredUpload = await readPublishedUpload();
      uploadAvailable = rawStoredUpload !== null;
      view = service.get(authContext.user.id, created.reflection.id);
    }
  }

  if (!uploadAvailable && view.reflection.status === "uploading") {
    let fence;
    try {
      fence = orchestrator.claimStaging({
        receipt: operationReceipt,
        leaseOwner: `daily-reflection-upload-${randomUUID()}`,
        leaseDurationMs: UPLOAD_PERSISTENCE_LEASE_MS
      });
    } catch (error) {
      if (error instanceof DailyReflectionConflictError) {
        return NextResponse.json({ error: error.code }, { status: 409 });
      }
      throw error;
    }

    if (fence) {
      // A prior owner publishes the upload before releasing its lease. This
      // reread closes the release/claim window without trusting process state.
      rawStoredUpload = await readPublishedUpload();
      uploadAvailable = rawStoredUpload !== null;
      if (!uploadAvailable) {
        const assertPersistenceFence = () => repository.assertExecutionLease({
          accountId: authContext.user.id,
          reflectionId: created.reflection.id,
          leaseOwner: fence.leaseOwner,
          attemptVersion: fence.attemptVersion
        });
        const execution = persistAudioUpload({
          store: authContext.store,
          uploadId,
          uploadDir: authContext.uploadsRootDir,
          file,
          recordingDate,
          attemptSuffix: `attempt-${fence.attemptVersion}`,
          assertWritable: assertPersistenceFence,
          publishUpload: async (upload) => {
            const duration = await resolveDailyReflectionAuthoritativeDuration({
              filePath: upload.filePath,
              inputMethod: inputContract.inputMethod,
              inputAdapter: inputContract.inputAdapter,
              clientReportedDurationMs: reportedDurationMs
            });
            const current = service.get(
              authContext.user.id,
              created.reflection.id
            );
            orchestrator.bindAuthoritativePlan({
              receipt: operationReceipt,
              expectedVersion: current.reflection.version,
              duration,
              fence
            });
            await publishDailyReflectionAsset({
              repository,
              store: authContext.store,
              accountId: authContext.user.id,
              reflectionId: created.reflection.id,
              uploadId,
              assetKind: "upload",
              fence,
              payload: {
                ...upload,
                durationSeconds: duration.effectiveDurationMs / 1_000,
                effectiveDurationMs: duration.effectiveDurationMs,
                clientReportedDurationMs: duration.clientReportedDurationMs,
                durationSource: duration.durationSource,
                processingProfile: duration.processingProfile
              }
            });
          },
          extra: {
            ingestionContext: "daily_reflection" as const,
            reflectionId: created.reflection.id,
            uploadFingerprint,
            persistenceAttemptVersion: fence.attemptVersion
          }
        }).then(() => undefined);
        uploadPersistenceExecutions.set(persistenceKey, execution);
        try {
          await execution;
          assertPersistenceFence();
          uploadAvailable = true;
        } catch (error) {
          let stillOwnsFence = true;
          try {
            assertPersistenceFence();
          } catch (fenceError) {
            if (fenceError instanceof DailyReflectionLeaseLostError) {
              stillOwnsFence = false;
            } else {
              throw fenceError;
            }
          }
          if (!stillOwnsFence) {
            return NextResponse.json({
              ...receipt({
                operation: operationReceipt,
                status: service.get(authContext.user.id, created.reflection.id)
                  .reflection.status,
                executionMode
              }),
              persistencePending: true
            }, { status: 202 });
          }
          await cleanupDailyReflectionUploadPersistenceFailure({
            store: authContext.store,
            repository,
            accountId: authContext.user.id,
            reflectionId: created.reflection.id,
            uploadId,
            uploadsRootDir: authContext.uploadsRootDir,
            attemptVersion: fence.attemptVersion,
            ...(error instanceof AudioUploadPersistenceError && error.filePath
              ? { persistedFilePath: error.filePath }
              : {})
          }).catch(() => undefined);
          const cause = error instanceof AudioUploadPersistenceError
            ? error.cause
            : error;
          const failure = cause instanceof DailyReflectionDurationPolicyError
            || cause instanceof DailyReflectionDurationProbeError
            ? {
                code: cause.code,
                retryable: cause.retryable,
                status: cause instanceof DailyReflectionDurationPolicyError
                  ? 400
                  : 503
              }
            : {
                code: "daily_reflection_upload_persist_failed",
                retryable: true,
                status: 503
              };
          const current = service.get(authContext.user.id, created.reflection.id);
          // Any retryable failure before a V2 plan exists (including a
          // raw-file write failure before ffprobe starts) must leave the
          // idempotent workflow replayable. Once the immutable plan exists,
          // the explicit retry contract can safely resume it from `failed`.
          // Policy rejection is terminal even without a plan.
          if (
            current.reflection.status === "uploading"
            && (!failure.retryable || current.processingPlan !== null)
          ) {
            try {
              service.updateStatus({
                accountId: authContext.user.id,
                reflectionId: created.reflection.id,
                expectedVersion: current.reflection.version,
                status: "failed",
                errorCode: failure.code,
                errorMessage: failure.code,
                leaseOwner: fence.leaseOwner,
                attemptVersion: fence.attemptVersion
              });
            } catch (settleError) {
              if (
                !(settleError instanceof DailyReflectionVersionConflictError)
                && !(settleError instanceof DailyReflectionLeaseLostError)
              ) {
                throw settleError;
              }
            }
          }
          return NextResponse.json({
            error: failure.code,
            reflectionId: created.reflection.id,
            uploadId,
            retryable: failure.retryable
          }, { status: failure.status });
        } finally {
          if (uploadPersistenceExecutions.get(persistenceKey) === execution) {
            uploadPersistenceExecutions.delete(persistenceKey);
          }
          repository.releaseExecutionLease({
            accountId: authContext.user.id,
            reflectionId: created.reflection.id,
            leaseOwner: fence.leaseOwner,
            attemptVersion: fence.attemptVersion
          });
        }
      } else {
        repository.releaseExecutionLease({
          accountId: authContext.user.id,
          reflectionId: created.reflection.id,
          leaseOwner: fence.leaseOwner,
          attemptVersion: fence.attemptVersion
        });
      }
    } else {
      const claimedInFlight = uploadPersistenceExecutions.get(persistenceKey);
      if (claimedInFlight) {
        joinedPersistence = true;
        await claimedInFlight.catch(() => undefined);
        rawStoredUpload = await readPublishedUpload();
        uploadAvailable = rawStoredUpload !== null;
      }
    }
  }

  rawStoredUpload = await readPublishedUpload();
  uploadAvailable = rawStoredUpload !== null;
  view = service.get(authContext.user.id, created.reflection.id);
  if (!uploadAvailable) {
    return NextResponse.json({
      ...receipt({
        operation: operationReceipt,
        status: view.reflection.status,
        executionMode
      }),
      persistencePending: view.reflection.status === "uploading"
    }, { status: view.reflection.status === "uploading" ? 202 : 409 });
  }
  if (
    !isDailyReflectionUploadRecord(rawStoredUpload)
    || rawStoredUpload.reflectionId !== created.reflection.id
    || rawStoredUpload.uploadFingerprint !== uploadFingerprint
  ) {
    return NextResponse.json({
      error: "daily_reflection_idempotency_conflict"
    }, { status: 409 });
  }

  let job = await readDailyReflectionJob(authContext.store, created.reflection.id);
  const active = !isDailyReflectionTombstone(view.reflection.status)
    && view.reflection.status !== "review_pending"
    && view.reflection.status !== "failed";
  const shouldDispatch = uploadAvailable
    && active
    && job?.status !== "processing"
    && !joinedPersistence;

  const queuedAt = new Date().toISOString();
  const payload = {
    version: 1 as const,
    ingestionContext: "daily_reflection" as const,
    reflectionId: created.reflection.id,
    userRef: authContext.user.id
  };
  const queueJobId = executionMode === "queue"
    ? buildDailyReflectionQueueJobId(payload)
    : undefined;
  job ??= await orchestrator.ensureDurableJob({
    store: authContext.store,
    receipt: operationReceipt,
    executionMode,
    ...(queueJobId ? { queueJobId, queuedAt } : {})
  });

  if (shouldDispatch && executionMode === "queue") {
    try {
      await enqueueDailyReflectionJob(payload);
    } catch (error) {
      console.error(
        `[daily-reflection-queue] enqueue failed reflection_id=${created.reflection.id} ` +
        `error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      return NextResponse.json({
        ...receipt({
          operation: operationReceipt,
          status: view.reflection.status,
          executionMode,
          queueJobId
        }),
        enqueueDeferred: true,
        warning: "pipeline_queue_unavailable"
      }, { status: 202 });
    }
  } else if (shouldDispatch) {
    after(async () => {
      await processDailyReflectionUpload({
        accountId: authContext.user.id,
        reflectionId: created.reflection.id,
        store: authContext.store,
        uploadsRootDir: authContext.uploadsRootDir,
        executionMode: "inline"
      }).catch((error) => {
        console.error(
          `[daily-reflection-inline] processing failed reflection_id=${created.reflection.id} `
          + `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      });
    });
  }

  return NextResponse.json(receipt({
    operation: operationReceipt,
    status: view.reflection.status,
    executionMode,
    queueJobId,
    reused: created.reused
  }), { status: created.reused ? 200 : 201 });
}
