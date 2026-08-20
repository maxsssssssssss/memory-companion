import { NextResponse } from "next/server";

import { DailyReflectionDetailResponseSchema } from "@/lib/domain/daily-reflection-api";
import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  AudioUploadSchema,
  type AudioUpload,
  type TranscriptSegment
} from "@/lib/domain/types";
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
  isDailyReflectionUploadRecord,
  isDailyReflectionUploadEnabled,
  parseDailyReflectionCanonicalTranscript,
  readDailyReflectionPublishedAsset,
  readDailyReflectionJob
} from "@/lib/server/daily-reflection";
import { deleteMemoryUploadAndRefreshIndex } from
  "@/lib/server/memory/upload-deletion";

function disabledOrMissing() {
  return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
}

function detailUnavailable() {
  return NextResponse.json(
    { error: "daily_reflection_evidence_unavailable" },
    { status: 409 }
  );
}

async function context(request: Request, rawReflectionId: string) {
  if (!isDailyReflectionUploadEnabled()) return { response: disabledOrMissing() } as const;
  const parsed = DailyReflectionIdSchema.safeParse(rawReflectionId);
  if (!parsed.success) {
    return {
      response: NextResponse.json({ error: "invalid_reflection_id" }, { status: 400 })
    } as const;
  }
  try {
    return {
      authContext: await requireAuthContext(request),
      reflectionId: parsed.data
    } as const;
  } catch (error) {
    if (isUnauthenticatedError(error)) return { response: unauthorizedResponse() } as const;
    throw error;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string }> }
) {
  const resolved = await context(request, (await params).reflectionId);
  if ("response" in resolved) return resolved.response;
  const repository = getDailyReflectionRepository();
  const service = new DailyReflectionService(repository);
  let view;
  try {
    view = service.get(resolved.authContext.user.id, resolved.reflectionId);
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return disabledOrMissing();
    throw error;
  }
  if (view.reflection.status === "deleted") return disabledOrMissing();

  const plan = view.processingPlan;
  let upload: AudioUpload | null = null;
  let segments: TranscriptSegment[] = [];
  let invalidPublishedAsset = false;

  if (plan) {
    const [rawUpload, rawSegments] = await Promise.all([
      readDailyReflectionPublishedAsset<unknown>({
        repository,
        store: resolved.authContext.store,
        accountId: resolved.authContext.user.id,
        reflectionId: resolved.reflectionId,
        uploadId: plan.uploadId,
        assetKind: "upload"
      }),
      readDailyReflectionPublishedAsset<unknown>({
        repository,
        store: resolved.authContext.store,
        accountId: resolved.authContext.user.id,
        reflectionId: resolved.reflectionId,
        uploadId: plan.uploadId,
        assetKind: "segments"
      })
    ]);

    if (rawUpload !== null) {
      const parsedUpload = AudioUploadSchema.safeParse(rawUpload);
      if (
        !isDailyReflectionUploadRecord(rawUpload)
        || rawUpload.id !== plan.uploadId
        || rawUpload.reflectionId !== resolved.reflectionId
        || rawUpload.ingestionContext !== plan.ingestionContext
        || !parsedUpload.success
      ) {
        invalidPublishedAsset = true;
      } else {
        upload = parsedUpload.data;
      }
    }

    if (rawSegments !== null) {
      const canonical = parseDailyReflectionCanonicalTranscript(rawSegments, plan.uploadId);
      const awaitingTranscript = (
        view.reflection.status === "created"
        || view.reflection.status === "uploading"
        || view.reflection.status === "transcribing"
        || view.reflection.status === "extracting"
      ) && Array.isArray(rawSegments) && rawSegments.length === 0;
      if (canonical) {
        segments = canonical;
      } else if (!awaitingTranscript) {
        invalidPublishedAsset = true;
      }
    }
  }

  const segmentById = new Map(segments.map((segment) => [segment.id, segment] as const));
  if (segmentById.size !== segments.length) invalidPublishedAsset = true;
  if (
    invalidPublishedAsset
    || (
      (
        view.reflection.status === "review_pending"
        || view.reflection.status === "confirmation_ready"
        || view.reflection.status === "admitting"
        || view.reflection.status === "completed"
        || view.reflection.status === "admission_failed"
      )
      && (!plan || !upload || segments.length === 0)
    )
    || (
      view.candidates.length > 0
      && (!plan || view.candidates.some((candidate) =>
        candidate.sourceSegmentIds.some((sourceId) => !segmentById.has(sourceId))))
    )
  ) {
    return detailUnavailable();
  }
  const job = await readDailyReflectionJob(
    resolved.authContext.store,
    resolved.reflectionId
  );
  const revokedCandidateIds = repository.listCandidateRevocationReceipts(
    resolved.authContext.user.id,
    resolved.reflectionId
  )
    .filter((receipt) => receipt.outcome === "revoked")
    .map((receipt) => receipt.candidateId);
  return NextResponse.json(DailyReflectionDetailResponseSchema.parse({
    reflection: view.reflection,
    processingPlan: plan,
    job,
    upload,
    segments,
    effectiveOrigin: plan?.sourceOrigin ?? null,
    confirmation: view.confirmation,
    admissionOperation: view.admissionOperation,
    admissionResults: view.admissionResults,
    rememberedCount: repository.getRememberedCandidateCount(
      resolved.authContext.user.id,
      resolved.reflectionId
    ),
    revokedCandidateIds,
    candidates: view.candidates.map((candidate) => ({
      ...candidate,
      evidence: candidate.sourceSegmentIds.map((sourceSegmentId) => {
        const segment = segmentById.get(sourceSegmentId)!;
        return {
          sourceSegmentId,
          uploadId: segment.uploadId,
          effectiveOrigin: plan!.sourceOrigin,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          text: segment.text
        };
      })
    }))
  }));
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string }> }
) {
  const resolved = await context(request, (await params).reflectionId);
  if ("response" in resolved) return resolved.response;
  const repository = getDailyReflectionRepository();
  const service = new DailyReflectionService(repository);
  let view;
  try {
    view = service.get(resolved.authContext.user.id, resolved.reflectionId);
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return disabledOrMissing();
    throw error;
  }
  const provisional = repository.getProvisionalUploadOwnership(
    resolved.authContext.user.id,
    resolved.reflectionId
  );
  const uploadId = view.processingPlan?.uploadId
    ?? view.reflection.uploadId
    ?? provisional?.uploadId;
  if (view.reflection.status !== "deleted") {
    repository.markAdmissionDeleteRequested(
      resolved.authContext.user.id,
      resolved.reflectionId
    );
    if (uploadId) {
      try {
        await deleteMemoryUploadAndRefreshIndex({
          userId: resolved.authContext.user.id,
          uploadId,
          indexRefreshFailure: "throw"
        });
      } catch {
        return NextResponse.json({
          error: "daily_reflection_memory_cleanup_failed",
          reflectionId: resolved.reflectionId,
          retryable: true
        }, { status: 503 });
      }
    }
  }
  for (let attempt = 0; attempt < 3 && view.reflection.status !== "deleted"; attempt += 1) {
    try {
      service.updateStatus({
        accountId: resolved.authContext.user.id,
        reflectionId: resolved.reflectionId,
        expectedVersion: view.reflection.version,
        status: "deleted"
      });
    } catch (error) {
      if (!(error instanceof DailyReflectionVersionConflictError)) throw error;
    }
    view = service.get(resolved.authContext.user.id, resolved.reflectionId);
  }
  if (view.reflection.status !== "deleted") {
    return NextResponse.json({
      error: "daily_reflection_delete_conflict",
      retryable: true
    }, { status: 503 });
  }
  if (uploadId) {
    try {
      if (view.processingPlan) {
        await cleanupDailyReflectionStagingAssets({
          store: resolved.authContext.store,
          repository,
          accountId: resolved.authContext.user.id,
          reflectionId: resolved.reflectionId,
          uploadId,
          uploadsRootDir: resolved.authContext.uploadsRootDir,
          removeUpload: true
        });
      } else if (provisional) {
        await cleanupDailyReflectionProvisionalAssets({
          store: resolved.authContext.store,
          repository,
          accountId: resolved.authContext.user.id,
          reflectionId: resolved.reflectionId,
          uploadId: provisional.uploadId,
          uploadsRootDir: resolved.authContext.uploadsRootDir,
          maxAttemptVersion: provisional.attemptVersion,
          tombstone: true
        });
      } else {
        throw new Error("daily_reflection_cleanup_ownership_missing");
      }
    } catch {
      return NextResponse.json({
        error: "daily_reflection_cleanup_failed",
        reflectionId: resolved.reflectionId,
        retryable: true
      }, { status: 503 });
    }
  }
  repository.deleteConfirmationArtifacts(
    resolved.authContext.user.id,
    resolved.reflectionId
  );
  repository.deleteCandidates(resolved.authContext.user.id, resolved.reflectionId);
  return new NextResponse(null, { status: 204 });
}
