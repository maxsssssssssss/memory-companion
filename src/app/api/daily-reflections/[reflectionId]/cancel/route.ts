import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  cleanupDailyReflectionStagingAssets,
  cleanupDailyReflectionProvisionalAssets,
  DailyReflectionNotFoundError,
  DailyReflectionService,
  DailyReflectionVersionConflictError,
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

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
  if (view.reflection.status === "deleted") {
    return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
  }
  if (
    view.reflection.status === "confirmation_ready"
    || view.reflection.status === "admitting"
    || view.reflection.status === "completed"
    || view.reflection.status === "admission_failed"
  ) {
    return NextResponse.json(
      { error: "daily_reflection_cannot_cancel_confirmed" },
      { status: 409 }
    );
  }
  for (let attempt = 0; attempt < 3 && view.reflection.status !== "cancelled"; attempt += 1) {
    if (view.reflection.status === "deleted") {
      return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
    }
    if (view.reflection.status === "failed") {
      return NextResponse.json(
        { error: "daily_reflection_cannot_cancel_failed" },
        { status: 409 }
      );
    }
    try {
      service.updateStatus({
        accountId: authContext.user.id,
        reflectionId: parsedId.data,
        expectedVersion: view.reflection.version,
        status: "cancelled"
      });
    } catch (error) {
      if (!(error instanceof DailyReflectionVersionConflictError)) throw error;
    }
    view = service.get(authContext.user.id, parsedId.data);
  }
  if (view.reflection.status !== "cancelled") {
    return NextResponse.json({
      error: "daily_reflection_cancel_conflict",
      retryable: true
    }, { status: 503 });
  }
  repository.deleteCandidates(authContext.user.id, parsedId.data);
  const provisional = repository.getProvisionalUploadOwnership(
    authContext.user.id,
    parsedId.data
  );
  const uploadId = view.processingPlan?.uploadId
    ?? view.reflection.uploadId
    ?? provisional?.uploadId;
  if (uploadId) {
    try {
      if (view.processingPlan) {
        await cleanupDailyReflectionStagingAssets({
          store: authContext.store,
          repository,
          accountId: authContext.user.id,
          reflectionId: parsedId.data,
          uploadId,
          uploadsRootDir: authContext.uploadsRootDir,
          removeUpload: true
        });
      } else if (provisional) {
        await cleanupDailyReflectionProvisionalAssets({
          store: authContext.store,
          repository,
          accountId: authContext.user.id,
          reflectionId: parsedId.data,
          uploadId: provisional.uploadId,
          uploadsRootDir: authContext.uploadsRootDir,
          maxAttemptVersion: provisional.attemptVersion,
          tombstone: true
        });
      } else {
        throw new Error("daily_reflection_cleanup_ownership_missing");
      }
    } catch {
      return NextResponse.json({
        error: "daily_reflection_cleanup_failed",
        reflectionId: parsedId.data,
        retryable: true
      }, { status: 503 });
    }
  }
  return NextResponse.json({ reflectionId: parsedId.data, status: "cancelled" });
}
