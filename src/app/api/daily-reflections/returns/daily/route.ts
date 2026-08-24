import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionReturnService,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

const QuerySchema = z.object({ date: z.string().date().optional() }).strict();

export async function GET(request: Request) {
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
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some((key) => key !== "date") || search.getAll("date").length > 1) {
    return NextResponse.json({ error: "invalid_daily_return_query" }, { status: 400 });
  }
  const query = QuerySchema.safeParse({
    ...(search.get("date") ? { date: search.get("date") } : {})
  });
  if (!query.success) {
    return NextResponse.json({ error: "invalid_daily_return_query" }, { status: 400 });
  }
  return NextResponse.json(
    getDailyReflectionReturnService().daily(accountId, query.data.date)
  );
}
