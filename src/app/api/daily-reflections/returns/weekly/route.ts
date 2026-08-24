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

const QuerySchema = z.object({ endDate: z.string().date().optional() }).strict();

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
  if (
    [...search.keys()].some((key) => key !== "endDate")
    || search.getAll("endDate").length > 1
  ) {
    return NextResponse.json({ error: "invalid_weekly_reflection_query" }, { status: 400 });
  }
  const query = QuerySchema.safeParse({
    ...(search.get("endDate") ? { endDate: search.get("endDate") } : {})
  });
  if (!query.success) {
    return NextResponse.json({ error: "invalid_weekly_reflection_query" }, { status: 400 });
  }
  return NextResponse.json(
    getDailyReflectionReturnService().weekly(accountId, query.data.endDate)
  );
}
