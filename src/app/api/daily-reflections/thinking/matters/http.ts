import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AgentFailure } from "@/lib/server/agent/types";
import { ThinkingMatterConflictError, ThinkingMatterNotFoundError } from "@/lib/server/daily-reflection/thinking-matter-repository";
import { requireAuthContext, isUnauthenticatedError } from "@/lib/server/auth/request-context";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

export function thinkingJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
export async function thinkingRequest(request: Request, work: (accountId: string) => Promise<Response>) {
  if (!isDailyReflectionUploadEnabled()) return thinkingJson({ error: "daily_reflection_not_found" }, 404);
  try { const auth = await requireAuthContext(request); return await work(auth.user.id); }
  catch (error) {
    if (isUnauthenticatedError(error)) return thinkingJson({ error: "unauthenticated" }, 401);
    if (error instanceof ZodError || error instanceof SyntaxError) return thinkingJson({ error: "invalid_thinking_matter_request" }, 400);
    if (error instanceof ThinkingMatterNotFoundError) return thinkingJson({ error: "thinking_matter_not_found" }, 404);
    if (error instanceof ThinkingMatterConflictError) return thinkingJson({ error: error.code }, 409);
    if (error instanceof AgentFailure) return thinkingJson({ error: `thinking_${error.code}` }, error.code === "forbidden" ? 404 : 409);
    // Never expose provider bodies, URLs, credentials or source text through errors.
    return thinkingJson({ error: "thinking_matter_unavailable" }, 503);
  }
}
