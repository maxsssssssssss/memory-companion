import { NextResponse } from "next/server";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  RealtimeVoiceQaSessionError,
  realtimeVoiceQaSessions
} from "@/lib/server/voice-qa/realtime-session-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const { sessionId } = await params;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "voice_realtime_session_not_found" }, {
      status: 404
    });
  }
  try {
    await realtimeVoiceQaSessions.close(sessionId, authContext.user.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof RealtimeVoiceQaSessionError) {
      return NextResponse.json({ error: "voice_realtime_session_not_found" }, {
        status: 404
      });
    }
    return NextResponse.json({ error: "voice_realtime_close_failed" }, {
      status: 503
    });
  }
}
