import { NextResponse } from "next/server";
import { z } from "zod";

import type { AudioUpload } from "@/lib/domain/types";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { isDailyReflectionUpload } from "@/lib/server/daily-reflection/upload-record";
import {
  VoiceprintTrainingCandidateRepository,
  isVoiceprintSelfEnrollmentEnabled
} from "@/lib/server/speaker-identity/voiceprint-training-candidates";
import { VoiceprintSelfEnrollmentOperationRepository } from "@/lib/server/speaker-identity/voiceprint-self-enrollment";

export const runtime = "nodejs";

const UploadIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);

export async function GET(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }
  if (!isVoiceprintSelfEnrollmentEnabled()) {
    return NextResponse.json({ enabled: false, candidates: [] });
  }
  const parsedUploadId = UploadIdSchema.safeParse(
    new URL(request.url).searchParams.get("uploadId")
  );
  if (!parsedUploadId.success) {
    return NextResponse.json({ error: "invalid_upload_id" }, { status: 400 });
  }
  const upload = await authContext.store.read<AudioUpload>(
    "uploads",
    parsedUploadId.data
  );
  if (!upload || isDailyReflectionUpload(upload)) {
    return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
  }
  const repository = new VoiceprintTrainingCandidateRepository(
    authContext.store
  );
  const operations = new VoiceprintSelfEnrollmentOperationRepository(
    authContext.store
  );
  await repository.cleanupExpired(authContext.uploadsRootDir);
  const candidates = await repository.listByUpload(parsedUploadId.data);
  const safeCandidates = await Promise.all(candidates.map(async (candidate) => {
    const operation = candidate.operationId
      ? await operations.get(candidate.operationId)
      : null;
    const canEnroll =
      Boolean(candidate.audioFilePath) &&
      (
        candidate.status === "available" ||
        (
          candidate.status === "failed" &&
          candidate.failureReason !== "audio_generation_failed"
        )
      ) &&
      (
        candidate.identityState === "unknown" ||
        candidate.identityState === "verified_self"
      );
    return {
      candidateId: candidate.candidateId,
      uploadId: candidate.uploadId,
      candidateKey: candidate.candidateKey,
      chunkId: candidate.chunkId,
      speaker: candidate.localSpeaker,
      segmentCount: candidate.segmentIds.length,
      durationMilliseconds: candidate.durationMilliseconds,
      status: candidate.status,
      identityState: candidate.identityState,
      canEnroll,
      hasAudio: Boolean(candidate.audioFilePath),
      expiresAt: candidate.expiresAt,
      ...(candidate.failureReason
        ? { failureReason: candidate.failureReason }
        : {}),
      ...(operation
        ? {
            operation: {
              id: operation.operationId,
              status: operation.status,
              attemptCount: operation.attemptCount,
              errorReason: operation.errorReason ?? null
            }
          }
        : {})
    };
  }));
  return NextResponse.json({
    enabled: true,
    candidates: safeCandidates
  });
}
