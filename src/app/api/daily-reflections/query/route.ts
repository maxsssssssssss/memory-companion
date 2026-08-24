import { NextResponse } from "next/server";

import {
  DailyReflectionQueryRequestSchema,
  DailyReflectionQueryResponseSchema
} from "@/lib/domain/daily-reflection-query";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionQueryService,
  isDailyReflectionUploadEnabled,
  routeDailyReflectionQueryIntent
} from "@/lib/server/daily-reflection";

export async function POST(request: Request) {
  if (!isDailyReflectionUploadEnabled()) {
    return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
  }
  let accountId: string;
  try {
    accountId = (await requireAuthContext(request)).user.id;
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_daily_reflection_query" }, { status: 400 });
  }
  const input = DailyReflectionQueryRequestSchema.safeParse(payload);
  if (!input.success) {
    return NextResponse.json({ error: "invalid_daily_reflection_query" }, { status: 400 });
  }
  if (!routeDailyReflectionQueryIntent({
    query: input.data.query,
    ...(input.data.personId ? { personId: input.data.personId } : {})
  })) {
    return NextResponse.json({ error: "invalid_daily_reflection_query" }, { status: 400 });
  }
  try {
    return NextResponse.json(DailyReflectionQueryResponseSchema.parse(
      getDailyReflectionQueryService().query(accountId, input.data)
    ));
  } catch {
    return NextResponse.json(
      { error: "daily_reflection_query_unavailable" },
      { status: 503 }
    );
  }
}
