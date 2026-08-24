import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  DailyReflectionCardMemoryRevocationLookupResponseSchema,
  DailyReflectionCardMemoryRevocationRequestSchema,
  DailyReflectionCardMemoryRevocationResponseSchema
} from "@/lib/domain/daily-reflection-memory-revocation";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError,
  DailyReflectionWorkingCardMemoryRevocationServiceError,
  getDailyReflectionWorkingCardMemoryRevocationService,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

function missing() {
  return NextResponse.json(
    { error: "daily_reflection_working_card_not_found" },
    { status: 404 }
  );
}

async function context(request: Request, params: Promise<{ cardId: string }>) {
  if (!isDailyReflectionUploadEnabled()) return { response: missing() } as const;
  const cardId = DailyReflectionIdSchema.safeParse((await params).cardId);
  if (!cardId.success) return { response: missing() } as const;
  try {
    const auth = await requireAuthContext(request);
    return { accountId: auth.user.id, cardId: cardId.data } as const;
  } catch (error) {
    if (isUnauthenticatedError(error)) return { response: unauthorizedResponse() } as const;
    throw error;
  }
}

function publicResult(result: NonNullable<ReturnType<
  ReturnType<typeof getDailyReflectionWorkingCardMemoryRevocationService>["get"]
>> & { reused?: boolean }) {
  const { accountId: _accountId, ...card } = result.card;
  return DailyReflectionCardMemoryRevocationResponseSchema.parse({
    card,
    lifecycleStatus: card.memoryLifecycleStatus,
    operation: {
      status: result.operation.status,
      attemptVersion: result.operation.attemptVersion,
      requestedMemoryLifecycleVersion:
        result.operation.requestedMemoryLifecycleVersion,
      indexRefreshStatus: result.operation.indexRefreshStatus,
      errorCode: result.operation.errorCode,
      updatedAt: result.operation.updatedAt,
      completedAt: result.operation.completedAt
    },
    receipt: result.receipt,
    reused: result.reused ?? true
  });
}

function routeError(error: unknown): NextResponse {
  if (error instanceof DailyReflectionNotFoundError) return missing();
  if (error instanceof DailyReflectionVersionConflictError) {
    return NextResponse.json(
      { error: "version_conflict", currentVersion: error.currentVersion },
      { status: 409 }
    );
  }
  if (error instanceof DailyReflectionConflictError) {
    return NextResponse.json({ error: error.code }, { status: 409 });
  }
  if (error instanceof DailyReflectionWorkingCardMemoryRevocationServiceError) {
    return NextResponse.json({ error: error.code, retryable: true }, { status: 503 });
  }
  throw error;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> }
): Promise<NextResponse> {
  const resolved = await context(request, params);
  if ("response" in resolved) return resolved.response ?? missing();
  try {
    const result = getDailyReflectionWorkingCardMemoryRevocationService()
      .get(resolved.accountId, resolved.cardId);
    if (!result) {
      return NextResponse.json(
        DailyReflectionCardMemoryRevocationLookupResponseSchema.parse({ found: false })
      );
    }
    return NextResponse.json(
      DailyReflectionCardMemoryRevocationLookupResponseSchema.parse({
        found: true,
        result: publicResult(result)
      })
    );
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> }
): Promise<NextResponse> {
  const resolved = await context(request, params);
  if ("response" in resolved) return resolved.response ?? missing();
  const payload = DailyReflectionCardMemoryRevocationRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json(
      { error: "invalid_working_card_memory_revocation" },
      { status: 400 }
    );
  }
  try {
    const result = await getDailyReflectionWorkingCardMemoryRevocationService()
      .revoke({ accountId: resolved.accountId, cardId: resolved.cardId, ...payload.data });
    return NextResponse.json(publicResult(result));
  } catch (error) {
    return routeError(error);
  }
}
