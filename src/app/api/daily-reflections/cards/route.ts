import { NextResponse } from "next/server";

import { DailyReflectionWorkingCardListQuerySchema } from "@/lib/domain/daily-reflection-api";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

import { workingCardListResponse } from "./shared";

function missing() {
  return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
}

export async function GET(request: Request) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const search = new URL(request.url).searchParams;
  const parsed = DailyReflectionWorkingCardListQuerySchema.safeParse({
    ...(search.get("reflectionId") ? { reflectionId: search.get("reflectionId") } : {}),
    ...(search.get("type") || search.get("cardKind")
      ? { cardKind: search.get("type") ?? search.get("cardKind") }
      : {}),
    ...(search.get("status") ? { status: search.get("status") } : {}),
    ...(search.get("q") || search.get("query")
      ? { query: search.get("q") ?? search.get("query") }
      : {}),
    ...(search.get("from") || search.get("createdFrom")
      ? { createdFrom: search.get("from") ?? search.get("createdFrom") }
      : {}),
    ...(search.get("to") || search.get("createdTo")
      ? { createdTo: search.get("to") ?? search.get("createdTo") }
      : {}),
    ...(search.get("sort") ? { sort: search.get("sort") } : {}),
    ...(search.get("limit") ? { limit: search.get("limit") } : {}),
    ...(search.get("offset") ? { offset: search.get("offset") } : {})
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_working_card_query" }, { status: 400 });
  }
  const result = getDailyReflectionRepository().listWorkingCards({
    accountId: authContext.user.id,
    ...parsed.data
  });
  return NextResponse.json(workingCardListResponse(result));
}
