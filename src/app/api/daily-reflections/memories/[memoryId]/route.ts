import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection";
import { getDailyReflectionMemory } from "@/lib/server/daily-reflection/memory-view";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

function missing() {
  return NextResponse.json({ error: "daily_reflection_memory_not_found" }, { status: 404, headers: PRIVATE_HEADERS });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ memoryId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const parsed = DailyReflectionIdSchema.safeParse((await params).memoryId);
  if (!parsed.success) return missing();
  try {
    const accountId = (await requireAuthContext(request)).user.id;
    const result = getDailyReflectionMemory(accountId, parsed.data);
    return result ? NextResponse.json(result, { headers: PRIVATE_HEADERS }) : missing();
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
}
