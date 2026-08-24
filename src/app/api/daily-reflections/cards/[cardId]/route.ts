import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  DailyReflectionWorkingCardLifecycleRequestSchema,
  DailyReflectionWorkingCardUpdateRequestSchema
} from "@/lib/domain/daily-reflection-api";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

import { workingCardDetailResponse, workingCardRouteError } from "../shared";

function missing() {
  return NextResponse.json({ error: "daily_reflection_working_card_not_found" }, { status: 404 });
}

async function context(
  request: Request,
  params: Promise<{ cardId: string }>
) {
  if (!isDailyReflectionUploadEnabled()) return { response: missing() } as const;
  const cardId = DailyReflectionIdSchema.safeParse((await params).cardId);
  if (!cardId.success) return { response: missing() } as const;
  try {
    const authContext = await requireAuthContext(request);
    return { accountId: authContext.user.id, cardId: cardId.data } as const;
  } catch (error) {
    if (isUnauthenticatedError(error)) return { response: unauthorizedResponse() } as const;
    throw error;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> }
) {
  const resolved = await context(request, params);
  if ("response" in resolved) return resolved.response;
  try {
    const result = getDailyReflectionRepository().getWorkingCardWithEvidence(
      resolved.accountId,
      resolved.cardId
    );
    return NextResponse.json(workingCardDetailResponse(result));
  } catch (error) {
    return workingCardRouteError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> }
) {
  const resolved = await context(request, params);
  if ("response" in resolved) return resolved.response;
  const payload = DailyReflectionWorkingCardUpdateRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_working_card_update" }, { status: 400 });
  }
  try {
    const repository = getDailyReflectionRepository();
    repository.updateWorkingCard({
      accountId: resolved.accountId,
      cardId: resolved.cardId,
      ...payload.data
    });
    return NextResponse.json(workingCardDetailResponse(
      repository.getWorkingCardWithEvidence(resolved.accountId, resolved.cardId)
    ));
  } catch (error) {
    return workingCardRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> }
) {
  const resolved = await context(request, params);
  if ("response" in resolved) return resolved.response;
  const payload = DailyReflectionWorkingCardLifecycleRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_working_card_remove" }, { status: 400 });
  }
  try {
    const repository = getDailyReflectionRepository();
    repository.removeWorkingCard({
      accountId: resolved.accountId,
      cardId: resolved.cardId,
      ...payload.data
    });
    return NextResponse.json(workingCardDetailResponse(
      repository.getWorkingCardWithEvidence(resolved.accountId, resolved.cardId)
    ));
  } catch (error) {
    return workingCardRouteError(error);
  }
}
