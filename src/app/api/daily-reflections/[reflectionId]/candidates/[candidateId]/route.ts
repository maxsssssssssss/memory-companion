import { NextResponse } from "next/server";

import {
  DailyReflectionCandidateExcludeRequestSchema,
  DailyReflectionCandidateExcludeResponseSchema
} from "@/lib/domain/daily-reflection-api";
import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError,
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

function missing() {
  return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string; candidateId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const rawParams = await params;
  const reflectionId = DailyReflectionIdSchema.safeParse(rawParams.reflectionId);
  const candidateId = DailyReflectionIdSchema.safeParse(rawParams.candidateId);
  if (!reflectionId.success || !candidateId.success) {
    return NextResponse.json({ error: "invalid_candidate_id" }, { status: 400 });
  }
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const payload = DailyReflectionCandidateExcludeRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_candidate_exclusion" }, { status: 400 });
  }
  try {
    const result = getDailyReflectionRepository().excludeCandidateV2({
      accountId: authContext.user.id,
      reflectionId: reflectionId.data,
      candidateId: candidateId.data,
      expectedVersion: payload.data.expectedVersion
    });
    return NextResponse.json(DailyReflectionCandidateExcludeResponseSchema.parse(result));
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return missing();
    if (error instanceof DailyReflectionVersionConflictError) {
      return NextResponse.json(
        { error: "version_conflict", currentVersion: error.currentVersion },
        { status: 409 }
      );
    }
    if (error instanceof DailyReflectionConflictError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    throw error;
  }
}
