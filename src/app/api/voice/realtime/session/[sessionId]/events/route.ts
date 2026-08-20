import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  RealtimeVoiceQaSessionError,
  realtimeVoiceQaSessions
} from "@/lib/server/voice-qa/realtime-session-registry";
import type { RealtimeVoiceQaEvent } from "@/lib/server/voice-qa/realtime-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const encoder = new TextEncoder();
const MAX_PENDING_REALTIME_EVENTS = 256;
const MAX_PENDING_REALTIME_EVENT_BYTES = 8 * 1024 * 1024;

function wireEvent(event: RealtimeVoiceQaEvent) {
  if (event.type === "audio_chunk") {
    const { audio, ...metadata } = event;
    return {
      ...metadata,
      audioBase64: audio.toString("base64")
    };
  }
  if (event.type === "answer" && event.answer) {
    return {
      ...event,
      answer: {
        id: event.answer.id,
        citedSegmentIds: event.answer.citedSegmentIds,
        citations: event.answer.citations ?? []
      }
    };
  }
  return event;
}

export async function GET(
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

  let unsubscribe: () => void = () => undefined;
  let removeAbortListener: () => void = () => undefined;
  let closed = false;
  let terminalQueued = false;
  let pendingBytes = 0;
  const pending: Uint8Array[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const closeTransport = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    removeAbortListener();
    pending.splice(0);
    pendingBytes = 0;
    try {
      streamController?.close();
    } catch {
      // The client may already have cancelled the stream.
    }
  };
  const failTransport = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    removeAbortListener();
    pending.splice(0);
    pendingBytes = 0;
    try {
      streamController?.error(new Error("voice_realtime_event_backpressure"));
    } catch {
      // The client may already have cancelled the stream.
    }
    // A client that cannot drain bounded audio/events must not leave a costly
    // Provider session orphaned in the in-process registry.
    void realtimeVoiceQaSessions.close(
      sessionId,
      authContext.user.id
    ).catch(() => undefined);
  };
  const drain = () => {
    const controller = streamController;
    if (!controller || closed) return;
    while (
      pending.length > 0 &&
      (controller.desiredSize === null || controller.desiredSize > 0)
    ) {
      const chunk = pending.shift()!;
      pendingBytes -= chunk.byteLength;
      controller.enqueue(chunk);
    }
    if (terminalQueued && pending.length === 0) closeTransport();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      const handleAbort = () => closeTransport();
      request.signal.addEventListener("abort", handleAbort, { once: true });
      removeAbortListener = () =>
        request.signal.removeEventListener("abort", handleAbort);
      try {
        unsubscribe = realtimeVoiceQaSessions.subscribe(
          sessionId,
          authContext.user.id,
          (event) => {
            if (closed) return;
            const encoded = encoder.encode(
              `${JSON.stringify(wireEvent(event))}\n`
            );
            if (
              pending.length >= MAX_PENDING_REALTIME_EVENTS ||
              pendingBytes + encoded.byteLength >
                MAX_PENDING_REALTIME_EVENT_BYTES
            ) {
              failTransport();
              return;
            }
            pending.push(encoded);
            pendingBytes += encoded.byteLength;
            if (event.type === "session_closed") terminalQueued = true;
            drain();
          }
        );
      } catch (error) {
        closed = true;
        removeAbortListener();
        if (error instanceof RealtimeVoiceQaSessionError) {
          controller.error(
            new Error("voice_realtime_session_not_found")
          );
          return;
        }
        controller.error(new Error("voice_realtime_events_failed"));
      }
    },
    pull() {
      drain();
    },
    cancel() {
      closed = true;
      unsubscribe();
      removeAbortListener();
      pending.splice(0);
      pendingBytes = 0;
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
