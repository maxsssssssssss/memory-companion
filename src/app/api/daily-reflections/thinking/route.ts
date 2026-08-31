import { NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  DailyReflectionThinkingRequestSchema,
  DailyReflectionThinkingResponseSchema
} from "@/lib/domain/daily-reflection-thinking";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  createDailyReflectionThinkingConversationService,
  DailyReflectionThinkingConversationNotFoundError,
  DailyReflectionThinkingOperationConflictError
} from "@/lib/server/daily-reflection/thinking-conversation";
import { getDailyReflectionThinkingContextResolver } from
  "@/lib/server/daily-reflection/thinking-context-resolver";
import { isDailyReflectionUploadEnabled } from
  "@/lib/server/daily-reflection/runtime-config";

export const runtime = "nodejs";

function privateNoStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function json(body: unknown, init?: ResponseInit) {
  return privateNoStore(NextResponse.json(body, init));
}

export async function POST(request: Request) {
  if (!isDailyReflectionUploadEnabled()) {
    return json({ error: "daily_reflection_not_found" }, { status: 404 });
  }
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return privateNoStore(unauthorizedResponse());
    throw error;
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_daily_reflection_thinking_request" }, { status: 400 });
  }
  const input = DailyReflectionThinkingRequestSchema.safeParse(payload);
  if (!input.success) {
    return json({ error: "invalid_daily_reflection_thinking_request" }, { status: 400 });
  }

  try {
    const response = DailyReflectionThinkingResponseSchema.parse(
      await createDailyReflectionThinkingConversationService({
        store: authContext.store,
        contextResolver: getDailyReflectionThinkingContextResolver()
      }).think(authContext.user.id, input.data, request.signal)
    );
    const status = response.assistantMessage.completionStatus === "provider_error"
      ? 503
      : response.assistantMessage.completionStatus === "cancelled"
        ? 499
        : 200;
    return json(response, { status });
  } catch (error) {
    if (error instanceof DailyReflectionThinkingConversationNotFoundError) {
      return json({ error: "thinking_conversation_not_found" }, { status: 404 });
    }
    if (error instanceof DailyReflectionThinkingOperationConflictError) {
      return json({ error: "thinking_operation_conflict" }, { status: 409 });
    }
    if (error instanceof ZodError) {
      return json({ error: "daily_reflection_thinking_unavailable" }, { status: 503 });
    }
    console.warn("[daily-reflection-thinking] operation_failed");
    return json({ error: "daily_reflection_thinking_unavailable" }, { status: 503 });
  }
}
