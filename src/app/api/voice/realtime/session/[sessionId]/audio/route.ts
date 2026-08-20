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
const MAX_REALTIME_AUDIO_BYTES = 16_000 * 2 * 60 * 30;
// Preserve the browser's 20 ms cadence instead of introducing up to 80 ms of
// relay buffering before Provider ASR/VAD can observe the newest samples.
const PROVIDER_AUDIO_CHUNK_BYTES = 320 * 2;

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
  if (
    !SESSION_ID_PATTERN.test(sessionId) ||
    !realtimeVoiceQaSessions.has(sessionId, authContext.user.id)
  ) {
    return Response.json(
      { error: "voice_realtime_session_not_found" },
      { status: 404 }
    );
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/octet-stream"
  ) {
    return Response.json(
      { error: "invalid_voice_realtime_audio_type" },
      { status: 415 }
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_REALTIME_AUDIO_BYTES
  ) {
    return Response.json(
      { error: "voice_realtime_audio_too_large" },
      { status: 413 }
    );
  }
  if (!request.body) {
    return Response.json(
      { error: "empty_voice_realtime_audio" },
      { status: 400 }
    );
  }

  const reader = request.body.getReader();
  let buffered = Buffer.alloc(0);
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REALTIME_AUDIO_BYTES) {
        await reader.cancel().catch(() => undefined);
        return Response.json(
          { error: "voice_realtime_audio_too_large" },
          { status: 413 }
        );
      }
      buffered = Buffer.concat([buffered, Buffer.from(value)]);
      while (buffered.byteLength >= PROVIDER_AUDIO_CHUNK_BYTES) {
        const chunk = buffered.subarray(0, PROVIDER_AUDIO_CHUNK_BYTES);
        buffered = buffered.subarray(PROVIDER_AUDIO_CHUNK_BYTES);
        await realtimeVoiceQaSessions.sendAudio(
          sessionId,
          authContext.user.id,
          chunk
        );
      }
    }
    if (buffered.byteLength > 0) {
      if (buffered.byteLength % 2 !== 0) {
        return Response.json(
          { error: "invalid_voice_realtime_pcm" },
          { status: 400 }
        );
      }
      await realtimeVoiceQaSessions.sendAudio(
        sessionId,
        authContext.user.id,
        buffered
      );
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json(
        { error: "voice_realtime_audio_aborted" },
        { status: 408 }
      );
    }
    if (error instanceof RealtimeVoiceQaSessionError) {
      return Response.json(
        { error: "voice_realtime_session_not_found" },
        { status: 404 }
      );
    }
    console.warn(
      `[voice-realtime] audio_failed bytes=${totalBytes} ` +
      `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return Response.json(
      { error: "voice_realtime_audio_failed" },
      { status: 503 }
    );
  } finally {
    reader.releaseLock();
  }
}
