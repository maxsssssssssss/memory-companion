import { NextResponse } from "next/server";

import { z } from "zod";
import {
  AI_REVIEW_PRIVATE_HEADERS,
  aiReviewError,
  aiReviewServiceFor,
  requireAiReviewAuth
} from "../../shared";

type RouteContext = { params: Promise<{ reviewId: string }> };
const ReviewIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);

export async function POST(
  request: Request,
  context: RouteContext
): Promise<NextResponse> {
  const resolved = await requireAiReviewAuth(request);
  if (!resolved.ok) return resolved.response;
  const parsed = ReviewIdSchema.safeParse((await context.params).reviewId);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "daily_reflection_ai_review_not_found" },
      { status: 404, headers: AI_REVIEW_PRIVATE_HEADERS }
    );
  }
  try {
    const result = await aiReviewServiceFor(resolved.authContext).markSeen(
      resolved.authContext.user.id,
      parsed.data
    );
    return NextResponse.json(result, { headers: AI_REVIEW_PRIVATE_HEADERS });
  } catch (error) {
    return aiReviewError(error);
  }
}
