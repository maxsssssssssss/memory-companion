import { z } from "zod";

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
const PlaybackSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("browser_playback_start"),
    turnSequence: z.number().int().positive()
  }).strict(),
  z.object({
    event: z.literal("truncate"),
    turnSequence: z.number().int().positive(),
    providerItemId: z.string().trim().min(1).max(256),
    audioEndMs: z.number().int().min(0).max(60 * 60_000)
  }).strict()
]);

export async function POST(
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
    return Response.json(
      { error: "voice_realtime_session_not_found" },
      { status: 404 }
    );
  }
  let decoded: unknown;
  try {
    decoded = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = PlaybackSchema.safeParse(decoded);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_voice_realtime_playback" },
      { status: 400 }
    );
  }
  try {
    if (parsed.data.event === "browser_playback_start") {
      const marked = await realtimeVoiceQaSessions.markBrowserPlaybackStarted(
        sessionId,
        authContext.user.id,
        parsed.data.turnSequence
      );
      return Response.json({ marked }, {
        headers: { "Cache-Control": "no-store" }
      });
    }
    const truncated = await realtimeVoiceQaSessions.truncatePlayback(
      sessionId,
      authContext.user.id,
      parsed.data.turnSequence,
      parsed.data.providerItemId,
      parsed.data.audioEndMs
    );
    return Response.json({ truncated }, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof RealtimeVoiceQaSessionError) {
      return Response.json(
        { error: "voice_realtime_session_not_found" },
        { status: 404 }
      );
    }
    return Response.json(
      { error: "voice_realtime_playback_failed" },
      { status: 503 }
    );
  }
}
