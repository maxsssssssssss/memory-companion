import { NextResponse } from "next/server";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  JsonVoiceSessionTraceRepository,
  VoiceSessionTraceNotFoundError
} from "@/lib/server/voice-qa/trace-repository";
import {
  VoiceSessionExpiredError,
  VoiceSessionManager,
  VoiceSessionNotFoundError
} from "@/lib/server/voice-qa/session-manager";
import {
  isTerminalVoiceSessionTraceStatus,
  logVoiceSessionTrace,
  type UpdateVoiceSessionTraceInput,
  type VoiceSessionTrace
} from "@/lib/server/voice-qa/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClientTraceEvent = "audio_play_started" | "playback_started" | "session_completed";
type ClientTraceOutcome = "completed" | "failed" | "aborted";

type ParsedTraceEvent = {
  traceId: string;
  event: ClientTraceEvent;
  outcome?: ClientTraceOutcome;
};

const PLAYBACK_CHECKPOINT_WAIT_MS = 2_000;
const PLAYBACK_CHECKPOINT_POLL_MS = 25;

class InvalidVoiceTraceTransitionError extends Error {
  constructor() {
    super("Invalid voice trace transition");
    this.name = "InvalidVoiceTraceTransitionError";
  }
}

function noStoreJson(body: unknown, init: { status?: number } = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: { "Cache-Control": "no-store" }
  });
}

function parseTraceEvent(value: unknown): ParsedTraceEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set(["traceId", "event", "outcome"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return null;
  if (typeof candidate.traceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.traceId)) {
    return null;
  }
  if (
    candidate.event !== "audio_play_started" &&
    candidate.event !== "playback_started" &&
    candidate.event !== "session_completed"
  ) {
    return null;
  }
  if (candidate.event === "audio_play_started" || candidate.event === "playback_started") {
    if (candidate.outcome !== undefined) return null;
    return { traceId: candidate.traceId, event: candidate.event };
  }
  const outcome = candidate.outcome ?? "completed";
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "aborted") return null;
  return { traceId: candidate.traceId, event: candidate.event, outcome };
}

function traceUpdate(input: ParsedTraceEvent): UpdateVoiceSessionTraceInput {
  if (input.event === "audio_play_started" || input.event === "playback_started") {
    return { event: input.event };
  }
  if (input.outcome === "failed") {
    return {
      event: "session_completed",
      failure: { stage: "playback", code: "playback_failed" },
      terminalStatus: "failed"
    };
  }
  if (input.outcome === "aborted") {
    return {
      event: "session_completed",
      failure: { stage: "session", code: "client_closed" },
      terminalStatus: "aborted"
    };
  }
  return { event: "session_completed", terminalStatus: "completed" };
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPlaybackCheckpoint(
  repository: JsonVoiceSessionTraceRepository,
  traceId: string
) {
  const initial = await repository.read(traceId);
  if (!initial) throw new VoiceSessionTraceNotFoundError(traceId);
  if (
    initial.timestamps.first_audio_chunk_received ||
    !initial.timestamps.voice_question_received ||
    isTerminalVoiceSessionTraceStatus(initial.status)
  ) {
    return;
  }

  const deadline = Date.now() + PLAYBACK_CHECKPOINT_WAIT_MS;
  while (Date.now() < deadline) {
    await wait(PLAYBACK_CHECKPOINT_POLL_MS);
    const current = await repository.read(traceId);
    if (!current) throw new VoiceSessionTraceNotFoundError(traceId);
    if (
      current.timestamps.first_audio_chunk_received ||
      isTerminalVoiceSessionTraceStatus(current.status)
    ) {
      return;
    }
  }
}

async function updateTrace(
  repository: JsonVoiceSessionTraceRepository,
  parsed: ParsedTraceEvent,
  observedAt: Date
) {
  const update = () => repository.update(
    parsed.traceId,
    { ...traceUpdate(parsed), now: () => observedAt },
    (current) => validateTraceTransition(current, parsed)
  );
  try {
    return await update();
  } catch (error) {
    if (
      parsed.event !== "playback_started" ||
      !(error instanceof InvalidVoiceTraceTransitionError)
    ) {
      throw error;
    }
    await waitForPlaybackCheckpoint(repository, parsed.traceId);
    return update();
  }
}

function validateTraceTransition(current: VoiceSessionTrace, input: ParsedTraceEvent) {
  if (isTerminalVoiceSessionTraceStatus(current.status)) {
    if (input.event === "session_completed") return;
    throw new InvalidVoiceTraceTransitionError();
  }
  if (input.event === "audio_play_started" && !current.timestamps.tts_started) {
    throw new InvalidVoiceTraceTransitionError();
  }
  if (input.event === "playback_started" && !current.timestamps.first_audio_chunk_received) {
    throw new InvalidVoiceTraceTransitionError();
  }
  if (
    input.event === "session_completed" &&
    input.outcome === "completed" &&
    current.timestamps.tts_started &&
    !current.timestamps.audio_play_started &&
    !current.timestamps.playback_started
  ) {
    throw new InvalidVoiceTraceTransitionError();
  }
}

async function synchronizeAbortedVoiceSession(
  trace: VoiceSessionTrace,
  store: JsonStore,
  userId: string
) {
  if (!trace.applicationSessionId) return;
  try {
    await new VoiceSessionManager({ store }).releaseTurn(
      trace.applicationSessionId,
      trace.sessionId,
      userId
    );
  } catch (error) {
    if (
      error instanceof VoiceSessionNotFoundError ||
      error instanceof VoiceSessionExpiredError
    ) {
      return;
    }
    throw error;
  }
}

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return noStoreJson({ error: "invalid_content_type" }, { status: 415 });
  }

  let parsed: ParsedTraceEvent | null = null;
  try {
    parsed = parseTraceEvent(await request.json());
  } catch {
    // Invalid JSON is handled as a bounded client error below.
  }
  if (!parsed) return noStoreJson({ error: "invalid_trace_event" }, { status: 400 });

  try {
    const repository = new JsonVoiceSessionTraceRepository(authContext.store);
    // Streaming playback starts as soon as the first PCM chunk reaches the
    // browser. Persisting the corresponding server checkpoint is intentionally
    // asynchronous, so let that narrow race settle without making playback
    // telemetry retry. Keep the request-arrival time as the actual playback
    // timestamp rather than the later persistence time.
    const observedAt = new Date();
    const result = await updateTrace(repository, parsed, observedAt);
    if (parsed.event === "session_completed" && parsed.outcome === "aborted") {
      await synchronizeAbortedVoiceSession(
        result.trace,
        authContext.store,
        authContext.user.id
      );
    }
    if (
      !result.changed &&
      parsed.event === "session_completed" &&
      isTerminalVoiceSessionTraceStatus(result.trace.status)
    ) {
      return noStoreJson({ ok: true, idempotent: true });
    }
    if (result.changed && parsed.event === "session_completed") {
      logVoiceSessionTrace(result.trace);
    }
    return noStoreJson({ ok: true });
  } catch (error) {
    if (error instanceof VoiceSessionTraceNotFoundError) {
      return noStoreJson({ error: "trace_not_found" }, { status: 404 });
    }
    if (error instanceof InvalidVoiceTraceTransitionError) {
      return noStoreJson({ error: "invalid_trace_transition" }, { status: 409 });
    }
    console.warn(
      `[voice-trace] update_failed session_id=${parsed.traceId} error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return noStoreJson({ error: "trace_update_failed" }, { status: 503 });
  }
}
