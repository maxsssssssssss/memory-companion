import { randomUUID } from "crypto";
import { after, NextResponse } from "next/server";
import { getUploadExtension } from "@/lib/audio/compat";
import {
  DATE_COMPANION_AUDIO_SNAPSHOT_VERSION,
  requestsDateCompanionAudioSnapshot,
  type DateCompanionMarkedUpload
} from "@/lib/domain/date-companion-upload";
import type { AudioUpload, ProcessingJob } from "@/lib/domain/types";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse,
  type AuthContext
} from "@/lib/server/auth/request-context";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import { shouldMarkUploadForEvaluationRetention } from "@/lib/server/evaluation/retention";
import { createJob } from "@/lib/server/jobs/job-store";
import { isUploadProcessingCancelled, processUpload } from "@/lib/server/pipeline/process-upload";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueuePipelineJob } from "@/lib/server/queue/producer";
import { buildPipelineJobId } from "@/lib/server/queue/types";
import {
  cleanupPersistedAudioUploadAttempt,
  normalizeUploadRecordingDate,
  persistAudioUpload
} from "@/lib/server/uploads/storage";
import {
  getToyIngestionDatabasePath,
  inspectToyIngestionRequest,
  openToyIngestionDatabase,
  resolveToyIngestionMode,
  TOY_DATE_COMPANION_DESTINATION,
  type ToyIngestionRequest
} from "@/lib/server/uploads/toy-ingestion-receipt";
import {
  prepareToyRecovery,
  publicToyRecoveryReceipt,
  stageToyRecoveryFile,
  ToyRecoveryReceiptRepository,
  toyRecoveryResponse
} from "@/lib/server/uploads/toy-ingestion-recovery";
import { validateAudioUpload } from "@/lib/server/uploads/validation";

type StoredUpload = AudioUpload & DateCompanionMarkedUpload & {
  filePath: string;
  evaluationRetention?: boolean;
  toyIngestionRelationshipId?: string;
};

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isStrictRecordingDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function toyAudioNormalizationContext(file: File) {
  const extension = getUploadExtension(file.name);
  const mimeType = file.type.trim().toLowerCase();
  if (extension === ".pcm" || mimeType === "audio/x-pcm") return "raw-pcm" as const;
  if (extension === ".opus" || mimeType === "audio/opus") return "opus-auto" as const;
  return "passthrough" as const;
}

async function waitForRecoveryReceipt(input: {
  repository: ToyRecoveryReceiptRepository;
  accountId: string;
  destination: typeof TOY_DATE_COMPANION_DESTINATION;
  operationKey: string;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (input.timeoutMs ?? 5_000);
  let receipt = input.repository.getByOperation(input);
  while (receipt?.state === "reserving" && Date.now() < deadline) {
    await wait(20);
    receipt = input.repository.getByOperation(input);
  }
  return receipt;
}

async function minimalToyRecoveryUpload(input: {
  authContext: AuthContext;
  file: File;
  recordingDate: string;
  toyRequest: ToyIngestionRequest;
  evaluationRetention: boolean;
}) {
  const executionMode = resolvePipelineExecutionMode();
  const database = openToyIngestionDatabase({
    filePath: getToyIngestionDatabasePath(input.authContext.dataRootDir)
  });
  let staged: Awaited<ReturnType<typeof stageToyRecoveryFile>> | undefined;
  try {
    const repository = new ToyRecoveryReceiptRepository(database);
    staged = await stageToyRecoveryFile({
      accountDataRoot: input.authContext.dataRootDir,
      file: input.file
    });
    const prepared = prepareToyRecovery({
      accountId: input.authContext.user.id,
      request: input.toyRequest,
      contentSha256: staged.contentSha256,
      recordingDate: input.recordingDate,
      normalizationContext: toyAudioNormalizationContext(input.file),
      executionMode
    });
    const claim = repository.claim(prepared);
    if (claim.kind === "conflict") {
      return NextResponse.json(
        {
          error: claim.conflict === "relationship_mismatch"
            ? "toy_ingestion_relationship_conflict"
            : "toy_ingestion_operation_conflict"
        },
        { status: 409 }
      );
    }

    if (claim.kind === "replay") {
      let receipt = claim.receipt.state === "reserving"
        ? await waitForRecoveryReceipt({
            repository,
            accountId: input.authContext.user.id,
            destination: input.toyRequest.destination,
            operationKey: input.toyRequest.operationKey
          })
        : claim.receipt;
      if (!receipt) {
        return NextResponse.json({ error: "toy_ingestion_receipt_not_found" }, { status: 404 });
      }
      const job = await input.authContext.store.read<ProcessingJob>(
        "jobs-by-upload",
        receipt.uploadId
      );
      receipt = repository.reconcileJob(
        input.authContext.user.id,
        receipt.receiptId,
        job
      ) ?? receipt;
      if (receipt.executionMode === "queue" && job?.status === "waiting") {
        const queuePayload = {
          version: 1 as const,
          uploadId: receipt.uploadId,
          userRef: input.authContext.user.id
        };
        await enqueuePipelineJob(queuePayload).catch((error) => {
          console.error(
            `[pipeline-queue] enqueue failed upload_id=${receipt!.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        });
      }
      return NextResponse.json(
        toyRecoveryResponse({ receipt, decision: "replayed" }),
        { status: receipt.responseStatus ?? (receipt.serverAcceptedAt ? 200 : 202) }
      );
    }

    let storedUpload: StoredUpload | undefined;
    try {
      storedUpload = await persistAudioUpload({
        store: input.authContext.store,
        uploadId: claim.receipt.uploadId,
        uploadDir: input.authContext.uploadsRootDir,
        file: input.file,
        recordingDate: input.recordingDate,
        extra: {
          dateCompanionAudioSnapshotVersion: DATE_COMPANION_AUDIO_SNAPSHOT_VERSION,
          toyIngestionRelationshipId: input.toyRequest.relationshipId,
          ...(input.evaluationRetention ? { evaluationRetention: true } : {})
        }
      }) satisfies StoredUpload;

      const queuePayload = {
        version: 1 as const,
        uploadId: claim.receipt.uploadId,
        userRef: input.authContext.user.id
      };
      const queueJobId = executionMode === "queue"
        ? buildPipelineJobId(queuePayload)
        : undefined;
      const queuedAt = new Date().toISOString();
      await createJob(input.authContext.store, claim.receipt.uploadId, {
        jobId: claim.receipt.jobId,
        ...(executionMode === "queue"
          ? {
              executionMode: "queue" as const,
              queueJobId: queueJobId!,
              queuedAt,
              now: () => queuedAt
            }
          : { executionMode: "inline" as const })
      });
      const response = executionMode === "queue"
        ? {
            uploadId: claim.receipt.uploadId,
            jobId: claim.receipt.jobId,
            status: "waiting",
            executionMode: "queue",
            queueJobId,
            ...(input.evaluationRetention ? { evaluationRetention: true } : {})
          }
        : {
            uploadId: claim.receipt.uploadId,
            jobId: claim.receipt.jobId,
            status: "uploaded",
            ...(input.evaluationRetention ? { evaluationRetention: true } : {})
          };
      const accepted = repository.markAccepted({
        accountId: input.authContext.user.id,
        receiptId: claim.receipt.receiptId,
        reservationToken: claim.reservationToken,
        responseStatus: 201,
        response,
        ...(queueJobId ? { queueJobId } : {})
      });

      if (executionMode === "queue") {
        try {
          await enqueuePipelineJob(queuePayload);
        } catch (error) {
          console.error(
            `[pipeline-queue] enqueue failed upload_id=${accepted.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
          );
          return NextResponse.json(
            {
              ...response,
              enqueueDeferred: true,
              warning: "pipeline_queue_unavailable",
              ingestionReceipt: publicToyRecoveryReceipt({
                receipt: accepted,
                decision: "accepted"
              })
            },
            { status: 202 }
          );
        }
      } else {
        try {
          after(async () => {
            try {
              await processUpload({
                uploadId: accepted.uploadId,
                store: input.authContext.store,
                userId: input.authContext.user.id
              });
            } catch (error) {
              if (!isUploadProcessingCancelled(error)) {
                console.error("process upload failed", error);
              }
            }
          });
        } catch {
          return NextResponse.json(
            {
              ...response,
              ingestionReceipt: publicToyRecoveryReceipt({
                receipt: accepted,
                decision: "accepted"
              })
            },
            { status: 202 }
          );
        }
      }

      return NextResponse.json(
        {
          ...response,
          ingestionReceipt: publicToyRecoveryReceipt({
            receipt: accepted,
            decision: "accepted"
          })
        },
        { status: 201 }
      );
    } catch {
      if (storedUpload) {
        await cleanupPersistedAudioUploadAttempt({
          store: input.authContext.store,
          upload: storedUpload,
          removeProjection: true
        });
      }
      repository.markFailed({
        accountId: input.authContext.user.id,
        receiptId: claim.receipt.receiptId,
        reservationToken: claim.reservationToken
      });
      return NextResponse.json({ error: "toy_ingestion_failed" }, { status: 500 });
    }
  } finally {
    database.close();
    await staged?.cleanup().catch(() => undefined);
  }
}

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const dateCompanionAudioSnapshot = requestsDateCompanionAudioSnapshot(formData);

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  const validation = validateAudioUpload(file);
  if (!validation.ok) {
    return NextResponse.json(
      {
        error: validation.errorCode,
        message: validation.message
      },
      { status: 400 }
    );
  }

  const recordingDate = normalizeUploadRecordingDate(formData.get("recordingDate"));
  const toyInspection = inspectToyIngestionRequest(formData);
  let toyMode: ReturnType<typeof resolveToyIngestionMode> | null = null;
  if (toyInspection.kind !== "absent") {
    try {
      toyMode = resolveToyIngestionMode();
    } catch {
      return NextResponse.json(
        { error: "toy_ingestion_mode_not_supported" },
        { status: 503 }
      );
    }
  }
  if (toyMode === "off") {
    return NextResponse.json({ error: "toy_ingestion_disabled" }, { status: 503 });
  }
  if (toyInspection.kind === "invalid" && toyMode !== null) {
    return NextResponse.json({ error: toyInspection.error }, { status: 400 });
  }

  const evaluationRetention = shouldMarkUploadForEvaluationRetention(request);
  if (toyInspection.kind === "valid" && toyMode === "recovery") {
    if (!isStrictRecordingDate(recordingDate)) {
      return NextResponse.json(
        { error: "invalid_toy_recording_date" },
        { status: 400 }
      );
    }
    try {
      getDateCompanionRepository().getRelationshipView(
        authContext.user.id,
        toyInspection.request.relationshipId
      );
    } catch {
      return NextResponse.json(
        { error: "toy_ingestion_relationship_scope_invalid" },
        { status: 409 }
      );
    }
    return minimalToyRecoveryUpload({
      authContext,
      file,
      recordingDate,
      toyRequest: toyInspection.request,
      evaluationRetention
    });
  }
  const uploadId = randomUUID();
  const executionMode = resolvePipelineExecutionMode();
  const storedUpload = await persistAudioUpload({
    store: authContext.store,
    uploadId,
    uploadDir: authContext.uploadsRootDir,
    file,
    recordingDate,
    extra: {
      ...(dateCompanionAudioSnapshot
        ? { dateCompanionAudioSnapshotVersion: DATE_COMPANION_AUDIO_SNAPSHOT_VERSION }
        : {}),
      ...(evaluationRetention ? { evaluationRetention: true } : {})
    }
  }) satisfies StoredUpload;

  if (executionMode === "queue") {
    const queuedAt = new Date().toISOString();
    const queuePayload = {
      version: 1 as const,
      uploadId,
      userRef: authContext.user.id
    };
    const queueJobId = buildPipelineJobId(queuePayload);
    const job = await createJob(authContext.store, uploadId, {
      executionMode: "queue",
      queueJobId,
      queuedAt,
      now: () => queuedAt
    });
    try {
      const queued = await enqueuePipelineJob(queuePayload);
      if (queued.jobId !== queueJobId) {
        throw new Error("Queue returned an unexpected stable job id");
      }
    } catch (error) {
      // The waiting product job is a durable outbox record. Do not mark it or
      // the upload terminal here: queue.add may have succeeded before its
      // response was lost, and startup/periodic recovery can safely enqueue the
      // same stable job id once Redis is available again.
      console.error(
        `[pipeline-queue] enqueue failed upload_id=${uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      return NextResponse.json(
        {
          uploadId,
          jobId: job.id,
          status: "waiting",
          executionMode: "queue",
          queueJobId,
          enqueueDeferred: true,
          warning: "pipeline_queue_unavailable",
          ...(evaluationRetention ? { evaluationRetention: true } : {})
        },
        { status: 202 }
      );
    }

    console.info(`[pipeline-queue] enqueued upload_id=${uploadId} queue_job_id=${queueJobId}`);
    return NextResponse.json(
      {
        uploadId,
        jobId: job.id,
        status: "waiting",
        executionMode: "queue",
        queueJobId,
        ...(evaluationRetention ? { evaluationRetention: true } : {})
      },
      { status: 201 }
    );
  }

  const job = await createJob(authContext.store, uploadId, { executionMode: "inline" });

  console.info(`[pipeline] background scheduled upload_id=${uploadId}`);
  after(async () => {
    const startedAt = Date.now();
    console.info(`[pipeline] background started upload_id=${uploadId}`);
    try {
      await processUpload({ uploadId, store: authContext.store, userId: authContext.user.id });
      console.info(`[pipeline] background completed upload_id=${uploadId} elapsed_ms=${Date.now() - startedAt}`);
    } catch (error) {
      if (isUploadProcessingCancelled(error)) {
        return;
      }
      console.info(
        `[pipeline] background failed upload_id=${uploadId} elapsed_ms=${Date.now() - startedAt} error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      console.error("process upload failed", error);
    }
  });

  return NextResponse.json(
    { uploadId, jobId: job.id, status: "uploaded", ...(evaluationRetention ? { evaluationRetention: true } : {}) },
    { status: 201 }
  );
}
