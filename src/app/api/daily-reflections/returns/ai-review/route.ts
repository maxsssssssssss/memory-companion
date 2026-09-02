import { NextResponse } from "next/server";
import { z } from "zod";

import { DailyReflectionAiReviewScopeSchema } from
  "@/lib/domain/daily-reflection-ai-review";

import {
  AI_REVIEW_PRIVATE_HEADERS,
  aiReviewError,
  aiReviewServiceFor,
  requireAiReviewAuth
} from "./shared";

const DateKeySchema = z.string().date();
const InputSchema = z.object({
  scope: DailyReflectionAiReviewScopeSchema,
  referenceDate: DateKeySchema
}).strict();

function invalidInput() {
  return NextResponse.json(
    { error: "invalid_daily_reflection_ai_review_input" },
    { status: 400, headers: AI_REVIEW_PRIVATE_HEADERS }
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const resolved = await requireAiReviewAuth(request);
  if (!resolved.ok) return resolved.response;
  const search = new URL(request.url).searchParams;
  if (
    [...search.keys()].some((key) => !["scope", "referenceDate"].includes(key))
    || search.getAll("scope").length !== 1
    || search.getAll("referenceDate").length !== 1
  ) return invalidInput();
  const input = InputSchema.safeParse({
    scope: search.get("scope"),
    referenceDate: search.get("referenceDate")
  });
  if (!input.success) return invalidInput();
  try {
    const result = await aiReviewServiceFor(resolved.authContext).lookup({
      accountId: resolved.authContext.user.id,
      ...input.data
    });
    return NextResponse.json(result, { headers: AI_REVIEW_PRIVATE_HEADERS });
  } catch (error) {
    return aiReviewError(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const resolved = await requireAiReviewAuth(request);
  if (!resolved.ok) return resolved.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidInput();
  }
  const input = InputSchema.safeParse(body);
  if (!input.success) return invalidInput();
  try {
    const result = await aiReviewServiceFor(resolved.authContext).ensure({
      accountId: resolved.authContext.user.id,
      ...input.data
    });
    if (!result.review || result.review.status === "stale") {
      return NextResponse.json(
        { error: "daily_reflection_ai_review_conflict" },
        { status: 409, headers: AI_REVIEW_PRIVATE_HEADERS }
      );
    }
    return NextResponse.json(result.review, {
      status: result.review.status === "queued" ? 202 : 200,
      headers: AI_REVIEW_PRIVATE_HEADERS
    });
  } catch (error) {
    return aiReviewError(error);
  }
}
