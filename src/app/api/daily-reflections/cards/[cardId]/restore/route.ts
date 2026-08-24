import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import { DailyReflectionWorkingCardLifecycleRequestSchema } from "@/lib/domain/daily-reflection-api";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";
import { workingCardDetailResponse, workingCardRouteError } from "../../shared";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) {
    return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
  }
  const cardId = DailyReflectionIdSchema.safeParse((await params).cardId);
  if (!cardId.success) {
    return NextResponse.json({ error: "daily_reflection_working_card_not_found" }, { status: 404 });
  }
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const payload = DailyReflectionWorkingCardLifecycleRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_working_card_restore" }, { status: 400 });
  }
  try {
    const repository = getDailyReflectionRepository();
    repository.restoreWorkingCard({
      accountId: authContext.user.id,
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
