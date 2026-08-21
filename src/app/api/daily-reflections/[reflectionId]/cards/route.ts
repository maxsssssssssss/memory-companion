import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  DailyReflectionCardUpdateRequestSchema,
  DailyReflectionCardUpdateResponseSchema
} from "@/lib/domain/daily-reflection-api";
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
  const payload = DailyReflectionCardUpdateRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_card_update" }, { status: 400 });
  }
  const repository = getDailyReflectionRepository();
  try {
    return NextResponse.json(DailyReflectionCardUpdateResponseSchema.parse(
      repository.updateReflectionCards({
        accountId: authContext.user.id,
        reflectionId: reflectionId.data,
        ...payload.data
      })
    ));
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
