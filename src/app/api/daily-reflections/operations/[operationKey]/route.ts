import { NextResponse } from "next/server";
import { z } from "zod";

import { DailyReflectionOperationLookupResponseSchema } from "@/lib/domain/daily-reflection-api";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

const OperationKeySchema = z.string().trim().min(1).max(512);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ operationKey: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) {
    return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
  }
  const operationKey = OperationKeySchema.safeParse((await params).operationKey);
  if (!operationKey.success) {
    return NextResponse.json({ error: "invalid_operation_key" }, { status: 400 });
  }
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const repository = getDailyReflectionRepository();
  return NextResponse.json(DailyReflectionOperationLookupResponseSchema.parse(
    repository.getOperationLookupV2(authContext.user.id, operationKey.data)
  ), { headers: { "Cache-Control": "private, no-store" } });
}
