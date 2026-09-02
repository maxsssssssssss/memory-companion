import { NextResponse } from "next/server";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse,
  type AuthContext
} from "@/lib/server/auth/request-context";
import {
  DailyReflectionAiReviewNotFoundError,
  getDailyReflectionAiReviewService
} from "@/lib/server/daily-reflection/ai-review-service";
import {
  getDailyReflectionAiReviewMode,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection/runtime-config";

export const AI_REVIEW_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store"
} as const;

export function aiReviewAvailable() {
  return isDailyReflectionUploadEnabled()
    && getDailyReflectionAiReviewMode() !== "off";
}

type AiReviewAuthResult =
  | { ok: true; authContext: AuthContext }
  | { ok: false; response: NextResponse };

export async function requireAiReviewAuth(
  request: Request
): Promise<AiReviewAuthResult> {
  if (!aiReviewAvailable()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "daily_reflection_ai_review_not_found" },
        { status: 404, headers: AI_REVIEW_PRIVATE_HEADERS }
      )
    };
  }
  try {
    return { ok: true, authContext: await requireAuthContext(request) };
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      const response = unauthorizedResponse();
      response.headers.set("Cache-Control", AI_REVIEW_PRIVATE_HEADERS["Cache-Control"]);
      return { ok: false, response };
    }
    throw error;
  }
}

export function aiReviewError(error: unknown): NextResponse {
  if (error instanceof DailyReflectionAiReviewNotFoundError) {
    return NextResponse.json(
      { error: "daily_reflection_ai_review_not_found" },
      { status: 404, headers: AI_REVIEW_PRIVATE_HEADERS }
    );
  }
  throw error;
}

export function aiReviewServiceFor(_authContext: AuthContext) {
  return getDailyReflectionAiReviewService();
}
