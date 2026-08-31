import { NextResponse } from "next/server";

import {
  DailyReflectionThinkingConversationIdSchema,
  DailyReflectionThinkingConversationResponseSchema
} from "@/lib/domain/daily-reflection-thinking";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  createDailyReflectionThinkingConversationService,
  DailyReflectionThinkingConversationNotFoundError
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
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
  const conversationId = DailyReflectionThinkingConversationIdSchema.safeParse(
    (await params).conversationId
  );
  if (!conversationId.success) {
    return json({ error: "invalid_thinking_conversation_id" }, { status: 400 });
  }

  try {
    const conversation = await createDailyReflectionThinkingConversationService({
      store: authContext.store,
      contextResolver: getDailyReflectionThinkingContextResolver()
    }).getConversation(conversationId.data);
    return json(DailyReflectionThinkingConversationResponseSchema.parse({ conversation }));
  } catch (error) {
    if (error instanceof DailyReflectionThinkingConversationNotFoundError) {
      return json({ error: "thinking_conversation_not_found" }, { status: 404 });
    }
    console.warn("[daily-reflection-thinking] conversation_read_failed");
    return json({ error: "daily_reflection_thinking_unavailable" }, { status: 503 });
  }
}
