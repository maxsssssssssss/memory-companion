import { NextResponse } from "next/server";
import { z } from "zod";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  DailyReflectionCandidateRevocationError,
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError,
  getDailyReflectionCandidateRevocationService,
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

const RequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(512)
}).strict();

function missing() {
  return NextResponse.json(
    { error: "daily_reflection_not_found" },
    { status: 404, headers: { "Cache-Control": "private, no-store" } }
  );
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string; candidateId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const rawParams = await params;
  const reflectionId = DailyReflectionIdSchema.safeParse(rawParams.reflectionId);
  const candidateId = DailyReflectionIdSchema.safeParse(rawParams.candidateId);
  if (!reflectionId.success || !candidateId.success) {
    return NextResponse.json(
      { error: "invalid_candidate_revocation_target" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const payload = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json(
      { error: "invalid_candidate_revocation_input" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  try {
    const result = await getDailyReflectionCandidateRevocationService().revoke({
      accountId: authContext.user.id,
      reflectionId: reflectionId.data,
      candidateId: candidateId.data,
      expectedVersion: payload.data.expectedVersion,
      idempotencyKey: payload.data.idempotencyKey
    });
    const reflection = getDailyReflectionRepository().getReflection(
      authContext.user.id,
      reflectionId.data
    );
    return NextResponse.json({
      reflectionId: reflectionId.data,
      candidateId: candidateId.data,
      reflectionStatus: reflection.status,
      reflectionVersion: reflection.version,
      revocationStatus: result.operation.status,
      outcome: result.receipt.outcome,
      rememberedCount: result.rememberedCount,
      reused: result.reused
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return missing();
    if (error instanceof DailyReflectionVersionConflictError) {
      return NextResponse.json(
        { error: "version_conflict", currentVersion: error.currentVersion },
        { status: 409, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (error instanceof DailyReflectionConflictError) {
      const retryable = error.code.includes("busy")
        || error.code.includes("claim_conflict")
        || error.code.includes("lease_lost");
      return NextResponse.json(
        { error: "daily_reflection_candidate_revocation_conflict", retryable },
        { status: 409, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (error instanceof DailyReflectionCandidateRevocationError) {
      return NextResponse.json(
        { error: error.code, retryable: true },
        { status: 503, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    throw error;
  }
}
