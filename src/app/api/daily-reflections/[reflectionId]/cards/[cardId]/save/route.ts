import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import { DailyReflectionWorkingCardSaveRequestSchema } from "@/lib/domain/daily-reflection-api";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";
import {
  workingCardDetailResponse,
  workingCardRouteError
} from "../../../../cards/shared";

function missing() {
  return NextResponse.json({ error: "daily_reflection_working_card_not_found" }, { status: 404 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string; cardId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const values = await params;
  const reflectionId = DailyReflectionIdSchema.safeParse(values.reflectionId);
  const cardId = DailyReflectionIdSchema.safeParse(values.cardId);
  if (!reflectionId.success || !cardId.success) return missing();
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const payload = DailyReflectionWorkingCardSaveRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_working_card_save" }, { status: 400 });
  }
  try {
    const repository = getDailyReflectionRepository();
    repository.saveWorkingCardFromReflection({
      accountId: authContext.user.id,
      reflectionId: reflectionId.data,
      cardId: cardId.data,
      ...payload.data
    });
    return NextResponse.json(workingCardDetailResponse(
      repository.getWorkingCardWithEvidence(authContext.user.id, cardId.data)
    ));
  } catch (error) {
    return workingCardRouteError(error);
  }
}
