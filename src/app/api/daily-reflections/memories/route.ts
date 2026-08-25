import { NextResponse } from "next/server";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection";
import { listDailyReflectionMemories } from "@/lib/server/daily-reflection/memory-view";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(request: Request) {
  if (!isDailyReflectionUploadEnabled()) {
    return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404, headers: PRIVATE_HEADERS });
  }
  try {
    const accountId = (await requireAuthContext(request)).user.id;
    return NextResponse.json(listDailyReflectionMemories(accountId), { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
}
