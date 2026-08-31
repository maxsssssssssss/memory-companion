import { NextResponse } from "next/server";

import {
  DailyReflectionMemoryRecommendationResponseSchema
} from "@/lib/domain/daily-reflection-memory-proposal";
import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionMemoryRecommendationService
} from "@/lib/server/daily-reflection/memory-recommendation-service";
import {
  DailyReflectionNotFoundError
} from "@/lib/server/daily-reflection/repository";
import {
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection/runtime-config";

function missing() {
  return NextResponse.json(
    { error: "daily_reflection_not_found" },
    { status: 404, headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const reflectionId = DailyReflectionIdSchema.safeParse((await params).reflectionId);
  if (!reflectionId.success) return missing();
  let accountId: string;
  try {
    accountId = (await requireAuthContext(request)).user.id;
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  try {
    const response = getDailyReflectionMemoryRecommendationService().recommend({
      accountId,
      reflectionId: reflectionId.data
    });
    return NextResponse.json(
      DailyReflectionMemoryRecommendationResponseSchema.parse(response),
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return missing();
    throw error;
  }
}
