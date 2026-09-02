import { NextResponse } from "next/server";

import {
  AI_REVIEW_PRIVATE_HEADERS,
  aiReviewError,
  aiReviewServiceFor,
  requireAiReviewAuth
} from "../shared";

export async function GET(request: Request): Promise<NextResponse> {
  const resolved = await requireAiReviewAuth(request);
  if (!resolved.ok) return resolved.response;
  if (new URL(request.url).searchParams.size > 0) {
    return NextResponse.json(
      { error: "invalid_daily_reflection_ai_review_input" },
      { status: 400, headers: AI_REVIEW_PRIVATE_HEADERS }
    );
  }
  try {
    return NextResponse.json(
      await aiReviewServiceFor(resolved.authContext).summary(resolved.authContext.user.id),
      { headers: AI_REVIEW_PRIVATE_HEADERS }
    );
  } catch (error) {
    return aiReviewError(error);
  }
}
