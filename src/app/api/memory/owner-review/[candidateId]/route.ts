import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { isDailyReflectionUpload } from "@/lib/server/daily-reflection/upload-record";
import {
  isMemoryOwnerReviewEnabled,
  memoryOwnerReviewOperationId,
  memoryOwnerReviewOperationInputDigest,
  MemoryOwnerReviewOperationSchema,
  MemoryOwnerReviewRepository,
  withMemoryOwnerReviewRequestLock
} from "@/lib/server/memory/owner-review";
import { reprocessUploadMemoryForOwnerReview } from "@/lib/server/memory/reprocess-owner-review";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";

export const runtime = "nodejs";

const KeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);
const RequestSchema = z.object({
  requestId: KeySchema,
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["confirm_owner", "keep_daily_only", "revoke_confirmation"]),
  ownerIdentityId: KeySchema.optional(),
  reviewedAllEvidence: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if (
    value.decision === "confirm_owner" &&
    (!value.ownerIdentityId || value.reviewedAllEvidence !== true)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "confirm_owner requires ownerIdentityId and reviewedAllEvidence=true"
    });
  }
  if (value.decision !== "confirm_owner" && value.ownerIdentityId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ownerIdentityId"],
      message: "ownerIdentityId is only valid for confirm_owner"
    });
  }
});

function operationResponse(operation: z.infer<typeof MemoryOwnerReviewOperationSchema>, reused: boolean) {
  return {
    operation: {
      operationId: operation.operationId,
      status: operation.status,
      decision: operation.decision,
      ownerIdentityId: operation.ownerIdentityId,
      error: operation.error ?? null,
      reused
    }
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ candidateId: string }> }
) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  if (!isMemoryOwnerReviewEnabled()) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 404 });
  }
  const candidateId = KeySchema.safeParse((await params).candidateId);
  if (!candidateId.success) {
    return NextResponse.json({ error: "invalid_candidate_id" }, { status: 400 });
  }
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const body = RequestSchema.safeParse(rawBody);
  if (!body.success) {
    return NextResponse.json({ error: "invalid_owner_review_request" }, { status: 400 });
  }
  return await withMemoryOwnerReviewRequestLock(body.data.requestId, async () => {
    const repository = new MemoryOwnerReviewRepository(authContext.store);
    await repository.cleanupExpired();
    const candidate = await repository.getCandidate(candidateId.data);
    if (!candidate) {
      return NextResponse.json({ error: "owner_review_candidate_not_found" }, { status: 404 });
    }
    const upload = await authContext.store.read<unknown>("uploads", candidate.uploadId);
    if (!upload || isDailyReflectionUpload(upload)) {
      return NextResponse.json({ error: "owner_review_candidate_not_found" }, { status: 404 });
    }
    if (candidate.evidenceDigest !== body.data.evidenceDigest) {
      return NextResponse.json({ error: "owner_review_evidence_stale" }, { status: 409 });
    }
    if (
      body.data.decision !== "revoke_confirmation" &&
      (candidate.status === "expired" || Date.parse(candidate.expiresAt) <= Date.now())
    ) {
      return NextResponse.json({ error: "owner_review_candidate_expired" }, { status: 410 });
    }
    const inputDigest = memoryOwnerReviewOperationInputDigest({
      candidateId: candidate.candidateId,
      evidenceDigest: body.data.evidenceDigest,
      decision: body.data.decision,
      ownerIdentityId: body.data.ownerIdentityId ?? null
    });
    const existing = await repository.getOperationByRequestId(body.data.requestId);
    if (existing) {
      if (existing.inputDigest !== inputDigest) {
        return NextResponse.json({ error: "owner_review_request_id_conflict" }, { status: 409 });
      }
      return NextResponse.json(operationResponse(existing, true));
    }
    if (
      body.data.decision === "confirm_owner" &&
      candidate.status !== "pending" &&
      candidate.status !== "processing_failed"
    ) {
      return NextResponse.json({ error: "owner_review_candidate_not_confirmable" }, { status: 409 });
    }
    if (
      body.data.decision === "confirm_owner" &&
      (
        candidate.structuralGate.status === "blocked" ||
        candidate.audioClips.length !== candidate.evidenceSegmentIds.length ||
        candidate.audioClips.some((clip) => Date.parse(clip.expiresAt) <= Date.now()) ||
        candidate.evidenceSegmentIds.some((segmentId) =>
          !candidate.audioClips.some((clip) => clip.segmentId === segmentId)
        )
      )
    ) {
      return NextResponse.json({ error: "owner_review_evidence_unavailable" }, { status: 409 });
    }
    if (
      body.data.decision === "revoke_confirmation" &&
      candidate.status !== "confirmed"
    ) {
      return NextResponse.json({ error: "owner_review_candidate_not_confirmed" }, { status: 409 });
    }

    if (body.data.ownerIdentityId) {
      const profile = await new JsonSpeakerIdentityRepository(authContext.store)
        .getProfile(body.data.ownerIdentityId);
      const validProfile = Boolean(
        profile &&
        profile.status === "active" &&
        (
          profile.identityType === "known_contact" ||
          (
            profile.identityType === "known_user" &&
            profile.userId === authContext.user.id
          )
        )
      );
      if (!validProfile) {
        return NextResponse.json({ error: "owner_review_invalid_owner" }, { status: 409 });
      }
    }

    const timestamp = new Date().toISOString();
    let operation = MemoryOwnerReviewOperationSchema.parse({
      version: 1,
      operationId: memoryOwnerReviewOperationId(body.data.requestId),
      requestId: body.data.requestId,
      candidateId: candidate.candidateId,
      inputDigest,
      decision: body.data.decision,
      ownerIdentityId: body.data.ownerIdentityId ?? null,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.saveOperation(operation);

    try {
      const reprocessed = await reprocessUploadMemoryForOwnerReview({
        store: authContext.store,
        userId: authContext.user.id,
        uploadId: candidate.uploadId,
        targetCandidateId: candidate.candidateId,
        targetDecision: body.data.decision,
        ...(body.data.ownerIdentityId
          ? { targetOwnerIdentityId: body.data.ownerIdentityId }
          : {})
      });
      const completedAt = new Date().toISOString();
      if (body.data.decision === "confirm_owner") {
        await repository.patchCandidate(candidate.candidateId, {
          status: "confirmed",
          confirmedOwnerIdentityId: body.data.ownerIdentityId,
          confirmedAt: completedAt,
          confirmationSource: "user_confirmed_memory_owner",
          failureReason: undefined
        });
      } else {
        await repository.patchCandidate(candidate.candidateId, {
          status: "daily_only",
          confirmedOwnerIdentityId: undefined,
          confirmedAt: undefined,
          confirmationSource: undefined,
          failureReason: undefined
        });
      }
      operation = MemoryOwnerReviewOperationSchema.parse({
        ...operation,
        status: "succeeded",
        updatedAt: completedAt
      });
      await repository.saveOperation(operation);
      return NextResponse.json({
        ...operationResponse(operation, false),
        memory: reprocessed.result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "owner_review_reprocess_failed";
      const failedAt = new Date().toISOString();
      operation = MemoryOwnerReviewOperationSchema.parse({
        ...operation,
        status: "failed",
        error: message.slice(0, 300),
        updatedAt: failedAt
      });
      await repository.saveOperation(operation);
      if (message === "owner_review_evidence_stale") {
        await repository.patchCandidate(candidate.candidateId, { status: "stale" });
        return NextResponse.json(operationResponse(operation, false), { status: 409 });
      }
      await repository.patchCandidate(candidate.candidateId, {
        status: "processing_failed",
        failureReason: "memory_reprocess_failed"
      });
      return NextResponse.json(operationResponse(operation, false), { status: 500 });
    }
  });
}
