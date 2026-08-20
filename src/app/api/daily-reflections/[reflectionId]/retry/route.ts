import { after, NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  createDailyReflectionJob,
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionService,
  DailyReflectionVersionConflictError,
  getDailyReflectionRepository,
  isDailyReflectionTombstone,
  isDailyReflectionUploadEnabled,
  parseDailyReflectionCanonicalTranscript,
  processDailyReflectionUpload,
  readDailyReflectionPublishedAsset,
  readDailyReflectionJob,
  updateDailyReflectionJob
} from "@/lib/server/daily-reflection";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueDailyReflectionJob } from "@/lib/server/queue/producer";
import { buildDailyReflectionQueueJobId } from "@/lib/server/queue/types";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) {
    return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
  }
  const parsedId = DailyReflectionIdSchema.safeParse((await params).reflectionId);
  if (!parsedId.success) {
    return NextResponse.json({ error: "invalid_reflection_id" }, { status: 400 });
  }
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const repository = getDailyReflectionRepository();
  const service = new DailyReflectionService(repository);
  let view;
  try {
    view = service.get(authContext.user.id, parsedId.data);
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) {
      return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
    }
    throw error;
  }
  if (!view.processingPlan) {
    return NextResponse.json(
      { error: "daily_reflection_retry_requires_upload_binding" },
      { status: 409 }
    );
  }
  if (view.reflection.status !== "failed") {
    return NextResponse.json(
      { error: "daily_reflection_retry_requires_failed" },
      { status: 409 }
    );
  }
  const rawCanonicalTranscript = await readDailyReflectionPublishedAsset<unknown>({
    repository,
    store: authContext.store,
    accountId: authContext.user.id,
    reflectionId: parsedId.data,
    uploadId: view.processingPlan.uploadId,
    assetKind: "segments"
  });
  const hasCanonicalTranscript = parseDailyReflectionCanonicalTranscript(
    rawCanonicalTranscript,
    view.processingPlan.uploadId
  ) !== null;
  if (rawCanonicalTranscript !== null && !hasCanonicalTranscript) {
    repository.deletePublishedAsset(
      authContext.user.id,
      parsedId.data,
      "segments"
    );
    await authContext.store.delete("segments", view.processingPlan.uploadId);
  }
  const executionMode = resolvePipelineExecutionMode();
  const payload = {
    version: 1 as const,
    ingestionContext: "daily_reflection" as const,
    reflectionId: parsedId.data,
    userRef: authContext.user.id
  };
  const queueJobId = executionMode === "queue"
    ? buildDailyReflectionQueueJobId(payload)
    : undefined;
  let retried;
  try {
    retried = service.requestRetry({
      accountId: authContext.user.id,
      reflectionId: parsedId.data,
      expectedVersion: view.reflection.version,
      resumeStatus: hasCanonicalTranscript ? "extracting" : "transcribing"
    });
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) {
      return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
    }
    if (
      error instanceof DailyReflectionConflictError
      || error instanceof DailyReflectionVersionConflictError
    ) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    throw error;
  }

  const job = await readDailyReflectionJob(authContext.store, parsedId.data)
    ?? await createDailyReflectionJob({
      store: authContext.store,
      accountId: authContext.user.id,
      reflectionId: parsedId.data,
      uploadId: view.processingPlan.uploadId,
      executionMode,
      ...(queueJobId
        ? { queueJobId, queuedAt: new Date().toISOString() }
        : {})
    });
  try {
    const current = service.get(authContext.user.id, parsedId.data);
    if (isDailyReflectionTombstone(current.reflection.status)) {
      await authContext.store.delete("daily-reflection-jobs", parsedId.data);
      return NextResponse.json(
        { error: "daily_reflection_not_found" },
        { status: 404 }
      );
    }
    await updateDailyReflectionJob(authContext.store, job, {
      status: "waiting",
      progress: hasCanonicalTranscript ? 80 : 0,
      executionMode,
      ...(queueJobId ? { queueJobId, queuedAt: new Date().toISOString() } : {}),
      workerStartedAt: undefined,
      finishedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined
    });
  } catch (error) {
    const current = service.get(authContext.user.id, parsedId.data);
    if (isDailyReflectionTombstone(current.reflection.status)) {
      await authContext.store.delete("daily-reflection-jobs", parsedId.data);
      return NextResponse.json(
        { error: "daily_reflection_not_found" },
        { status: 404 }
      );
    }
    throw error;
  }
  if (executionMode === "queue") {
    try {
      await enqueueDailyReflectionJob(payload, { reviveTerminal: true });
    } catch {
      return NextResponse.json({
        reflectionId: parsedId.data,
        uploadId: retried.processingPlan.uploadId,
        jobId: job.id,
        status: retried.reflection.status,
        executionMode,
        queueJobId,
        enqueueDeferred: true,
        warning: "pipeline_queue_unavailable"
      }, { status: 202 });
    }
  } else {
    after(async () => {
      await processDailyReflectionUpload({
        accountId: authContext.user.id,
        reflectionId: parsedId.data,
        store: authContext.store,
        uploadsRootDir: authContext.uploadsRootDir,
        executionMode: "inline"
      });
    });
  }
  return NextResponse.json({
    reflectionId: parsedId.data,
    uploadId: retried.processingPlan.uploadId,
    jobId: job.id,
    status: retried.reflection.status,
    executionMode,
    ...(queueJobId ? { queueJobId } : {})
  }, { status: 202 });
}
