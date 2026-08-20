import { NextResponse } from "next/server";

import {
  DailyReflectionCandidateUpdateRequestSchema,
  DailyReflectionCandidateUpdateResponseSchema
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
import { getPersonRepository } from "@/lib/server/person";

function missing() {
  return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const reflectionId = DailyReflectionIdSchema.safeParse((await params).reflectionId);
  if (!reflectionId.success) {
    return NextResponse.json({ error: "invalid_reflection_id" }, { status: 400 });
  }
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const payload = DailyReflectionCandidateUpdateRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_candidate_update" }, { status: 400 });
  }

  const repository = getDailyReflectionRepository();
  try {
    const reflection = repository.getReflection(
      authContext.user.id,
      reflectionId.data
    );
    if (reflection.status !== "review_pending") {
      return NextResponse.json(
        { error: "daily_reflection_candidate_update_conflict" },
        { status: 409 }
      );
    }
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return missing();
    throw error;
  }

  const personRepository = getPersonRepository();
  for (const candidate of payload.data.candidates) {
    if (
      candidate.subjectPersonId !== null
      && !personRepository.getConfirmedPerson(authContext.user.id, candidate.subjectPersonId)
    ) {
      return NextResponse.json(
        { error: "daily_reflection_subject_invalid" },
        { status: 409 }
      );
    }
  }

  try {
    const detail = repository.updateCandidateDecisions({
      accountId: authContext.user.id,
      reflectionId: reflectionId.data,
      expectedVersion: payload.data.expectedVersion,
      candidates: payload.data.candidates
    });
    return NextResponse.json(DailyReflectionCandidateUpdateResponseSchema.parse({
      reflection: detail.reflection,
      candidates: detail.candidates
    }));
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return missing();
    if (error instanceof DailyReflectionVersionConflictError) {
      return NextResponse.json(
        { error: "version_conflict", currentVersion: error.currentVersion },
        { status: 409 }
      );
    }
    if (error instanceof DailyReflectionConflictError) {
      return NextResponse.json(
        { error: "daily_reflection_candidate_update_conflict" },
        { status: 409 }
      );
    }
    throw error;
  }
}
