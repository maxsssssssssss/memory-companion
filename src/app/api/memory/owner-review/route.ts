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
  isMemoryOwnerReviewEnabled,
  MemoryOwnerReviewRepository
} from "@/lib/server/memory/owner-review";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";

export const runtime = "nodejs";

const UploadIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);

export async function GET(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  if (!isMemoryOwnerReviewEnabled()) {
    return NextResponse.json({ enabled: false, candidates: [], ownerOptions: [] });
  }
  const uploadId = UploadIdSchema.safeParse(
    new URL(request.url).searchParams.get("uploadId")
  );
  if (!uploadId.success) {
    return NextResponse.json({ error: "invalid_upload_id" }, { status: 400 });
  }
  const upload = await authContext.store.read<AudioUpload>("uploads", uploadId.data);
  if (!upload || isDailyReflectionUpload(upload)) {
    return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
  }
  const repository = new MemoryOwnerReviewRepository(authContext.store);
  await repository.cleanupExpired();
  const candidates = await repository.listCandidates(uploadId.data);
  const profiles = await new JsonSpeakerIdentityRepository(authContext.store).listProfiles();
  const ownerOptions = profiles
    .filter((profile) =>
      profile.status === "active" &&
      (
        profile.identityType === "known_contact" ||
        (
          profile.identityType === "known_user" &&
          profile.userId === authContext.user.id
        )
      )
    )
    .map((profile) => ({
      ownerIdentityId: profile.globalSpeakerId,
      identityType: profile.identityType,
      displayName:
        profile.displayName ??
        profile.contactName ??
        (profile.identityType === "known_user" ? "我" : profile.globalSpeakerId)
    }));
  return NextResponse.json({
    enabled: true,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      uploadId: candidate.uploadId,
      memoryId: candidate.memoryId,
      memoryType: candidate.memoryType,
      title: candidate.title,
      summary: candidate.summary,
      evidenceSegmentIds: candidate.evidenceSegmentIds,
      evidenceDigest: candidate.evidenceDigest,
      providerLabels: candidate.providerLabels,
      structuralGate: candidate.structuralGate,
      status: candidate.status,
      audioSegments: candidate.audioClips.map((clip) => ({
        segmentId: clip.segmentId,
        durationMilliseconds: clip.durationMilliseconds
      })),
      confirmedOwnerIdentityId: candidate.confirmedOwnerIdentityId ?? null,
      expiresAt: candidate.expiresAt,
      failureReason: candidate.failureReason ?? null
    })),
    ownerOptions
  });
}
