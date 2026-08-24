import { NextResponse } from "next/server";

import {
  DailyReflectionMemoryProposalCreateRequestSchema,
  DailyReflectionMemoryProposalPublicSchema
} from "@/lib/domain/daily-reflection-memory-proposal";
import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionMemoryProposalService,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

import { memoryProposalRouteError } from "../../../memory-proposals/shared";

function missing() {
  return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const cardId = DailyReflectionIdSchema.safeParse((await params).cardId);
  if (!cardId.success) return missing();
  let accountId: string;
  try {
    accountId = (await requireAuthContext(request)).user.id;
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const payload = DailyReflectionMemoryProposalCreateRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json(
      { error: "invalid_daily_reflection_memory_proposal" },
      { status: 400 }
    );
  }
  try {
    const result = getDailyReflectionMemoryProposalService().create({
      accountId,
      cardId: cardId.data,
      ...payload.data
    });
    return NextResponse.json({
      proposal: DailyReflectionMemoryProposalPublicSchema.parse(result.proposal),
      reused: result.reused
    }, { status: result.reused ? 200 : 201 });
  } catch (error) {
    return memoryProposalRouteError(error);
  }
}
