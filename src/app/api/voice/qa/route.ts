import { NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  MAX_VOICE_QA_CONTEXT_BYTES,
  VoiceQaContextSchema,
  type VoiceQaContext
} from "@/lib/domain/voice-qa-context";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { dateFromKey, formatDateKey } from "@/lib/server/retrieval/memory-scope-qa";
import {
  BrowserVoiceAudioError
} from "@/lib/server/voice/browser-audio";
import {
  DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT,
  wrapPcm16LeAsWav
} from "@/lib/server/voice/audio";
import { VoiceQaAdapterError, type MemoryVoiceQaScope } from "@/lib/server/voice-qa/adapter";
import type { VoiceAnswerMode } from "@/lib/server/voice-qa/answer-strategy";
import {
  BrowserVoiceQaSessionError,
  MAX_BROWSER_VOICE_AUDIO_BYTES,
  runBrowserVoiceQaSession
} from "@/lib/server/voice-qa/browser-session";
import {
  VoiceSessionAccessError,
  VoiceSessionClosedError,
  VoiceSessionExpiredError,
  VoiceSessionManager,
  VoiceSessionNotFoundError,
  VoiceSessionConversationMessageSchema,
  VoiceSessionTransitionError,
  type VoiceSession,
  type VoiceSessionConversationMessage
} from "@/lib/server/voice-qa/session-manager";
import { JsonVoiceSessionTraceRepository } from "@/lib/server/voice-qa/trace-repository";
import {
  VoiceSessionTracer,
  type VoiceSessionTraceRecorder
} from "@/lib/server/voice-qa/trace";
import type { VoiceQaStreamingOutputEvent } from "@/lib/server/voice-qa/bridge";
import {
  encodeVoiceBrowserStreamEvent,
  type VoiceBrowserStreamEvent
} from "@/lib/voice-browser-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 256 * 1024;
const MAX_BROWSER_VOICE_CONVERSATION_BYTES = 16 * 1024;
const MAX_VOICE_STREAM_SCHEMA_ISSUES = 10;
const BrowserVoiceConversationSchema = VoiceSessionConversationMessageSchema
  .array()
  .max(8);
const SUPPORTED_BROWSER_AUDIO_MIME_TYPES = new Set([
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm"
]);

type ParsedVoiceQaForm = {
  audio: File;
  scope: MemoryVoiceQaScope;
  answerMode: VoiceAnswerMode;
  uploadId?: string;
  referenceDate?: Date;
  conversationSessionId?: string;
  conversation?: VoiceSessionConversationMessage[];
  context?: VoiceQaContext;
};

type FormParseResult =
  | { ok: true; value: ParsedVoiceQaForm }
  | { ok: false; error: string; status: number };

function safeVoiceStreamIssuePath(path: ZodError["issues"][number]["path"]) {
  if (path.length === 0) return "$";

  let result = "";
  for (const part of path) {
    if (typeof part === "number") {
      result += `[${Math.max(0, Math.trunc(part))}]`;
      continue;
    }
    const safePart = part.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "unknown";
    result += result ? `.${safePart}` : safePart;
  }
  return result.slice(0, 240);
}

function logVoiceStreamSchemaFailure(
  eventType: VoiceBrowserStreamEvent["type"],
  error: ZodError
) {
  const issueCodes = [...new Set(error.issues.map((issue) => issue.code))]
    .slice(0, MAX_VOICE_STREAM_SCHEMA_ISSUES);
  const issuePaths = [...new Set(
    error.issues.map((issue) => safeVoiceStreamIssuePath(issue.path))
  )].slice(0, MAX_VOICE_STREAM_SCHEMA_ISSUES);

  console.warn(`VOICE_STREAM_SCHEMA_VALIDATION ${JSON.stringify({
    event_type: eventType,
    issue_codes: issueCodes,
    issue_paths: issuePaths
  })}`);
}

function noStoreJson(body: unknown, init: { status?: number } = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function acceptsVoiceNdjson(request: Request) {
  const accept = request.headers.get("accept");
  if (!accept) return false;
  return accept.split(",").some((entry) => {
    const [mediaType, ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    if (mediaType !== "application/x-ndjson") return false;
    return !parameters.some((parameter) => /^q=0(?:\.0*)?$/u.test(parameter));
  });
}

function voiceNdjsonResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function normalizedMimeType(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function singleFormValue(form: FormData, name: string) {
  const values = form.getAll(name);
  return values.length === 1 ? values[0] : values.length === 0 ? null : undefined;
}

function textFormValue(form: FormData, name: string) {
  const value = singleFormValue(form, name);
  if (value === undefined || (value !== null && typeof value !== "string")) return undefined;
  return value?.trim() ?? null;
}

function parseExactDate(value: string) {
  const parsed = dateFromKey(value);
  return parsed && formatDateKey(parsed) === value ? parsed : undefined;
}

function parseVoiceQaForm(form: FormData): FormParseResult {
  if (form.has("userId")) {
    return { ok: false, error: "user_id_not_allowed", status: 400 };
  }
  const audioValue = singleFormValue(form, "audio");
  if (!(audioValue instanceof File)) {
    return { ok: false, error: audioValue === undefined ? "duplicate_audio" : "missing_audio", status: 400 };
  }
  if (audioValue.size === 0) {
    return { ok: false, error: "empty_audio", status: 400 };
  }
  if (audioValue.size > MAX_BROWSER_VOICE_AUDIO_BYTES) {
    return { ok: false, error: "audio_too_large", status: 413 };
  }
  if (!SUPPORTED_BROWSER_AUDIO_MIME_TYPES.has(normalizedMimeType(audioValue.type))) {
    return { ok: false, error: "unsupported_audio_format", status: 415 };
  }

  const rawScope = textFormValue(form, "scope");
  if (rawScope === undefined) {
    return { ok: false, error: "duplicate_scope", status: 400 };
  }
  const scope = rawScope === null ? "all" : rawScope;
  if (scope !== "current" && scope !== "week" && scope !== "all") {
    return { ok: false, error: "invalid_scope", status: 400 };
  }

  const rawAnswerMode = textFormValue(form, "answerMode");
  if (rawAnswerMode === undefined) {
    return { ok: false, error: "duplicate_answer_mode", status: 400 };
  }
  const answerMode = rawAnswerMode === null ? "agent" : rawAnswerMode;
  if (answerMode !== "agent" && answerMode !== "direct") {
    return { ok: false, error: "invalid_answer_mode", status: 400 };
  }

  const rawUploadId = textFormValue(form, "uploadId");
  if (rawUploadId === undefined) {
    return { ok: false, error: "duplicate_upload_id", status: 400 };
  }
  const uploadId = rawUploadId || undefined;
  if (scope === "current") {
    if (!uploadId) return { ok: false, error: "current_upload_required", status: 400 };
    if (!STORE_KEY_PATTERN.test(uploadId)) {
      return { ok: false, error: "invalid_upload_id", status: 400 };
    }
  } else if (uploadId) {
    return { ok: false, error: "upload_not_allowed", status: 400 };
  }

  const rawReferenceDate = textFormValue(form, "referenceDate");
  if (rawReferenceDate === undefined) {
    return { ok: false, error: "duplicate_reference_date", status: 400 };
  }
  if (scope !== "week" && rawReferenceDate) {
    return { ok: false, error: "reference_date_not_allowed", status: 400 };
  }
  const referenceDate = rawReferenceDate ? parseExactDate(rawReferenceDate) : undefined;
  if (rawReferenceDate && !referenceDate) {
    return { ok: false, error: "invalid_reference_date", status: 400 };
  }

  const rawConversationSessionId = textFormValue(form, "conversationSessionId");
  if (rawConversationSessionId === undefined) {
    return { ok: false, error: "duplicate_conversation_session_id", status: 400 };
  }
  const conversationSessionId = rawConversationSessionId || undefined;
  if (conversationSessionId && !STORE_KEY_PATTERN.test(conversationSessionId)) {
    return { ok: false, error: "invalid_conversation_session_id", status: 400 };
  }

  const rawConversation = textFormValue(form, "conversation");
  if (rawConversation === undefined) {
    return { ok: false, error: "duplicate_conversation", status: 400 };
  }
  let conversation: VoiceSessionConversationMessage[] | undefined;
  if (rawConversation !== null) {
    if (Buffer.byteLength(rawConversation, "utf8") > MAX_BROWSER_VOICE_CONVERSATION_BYTES) {
      return { ok: false, error: "conversation_too_large", status: 413 };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawConversation);
    } catch {
      return { ok: false, error: "invalid_conversation", status: 400 };
    }
    const parsedConversation = BrowserVoiceConversationSchema.safeParse(decoded);
    if (!parsedConversation.success) {
      return { ok: false, error: "invalid_conversation", status: 400 };
    }
    conversation = parsedConversation.data;
  }

  const rawContext = textFormValue(form, "context");
  if (rawContext === undefined) {
    return { ok: false, error: "duplicate_voice_context", status: 400 };
  }
  let context: VoiceQaContext | undefined;
  if (rawContext) {
    if (Buffer.byteLength(rawContext, "utf8") > MAX_VOICE_QA_CONTEXT_BYTES) {
      return { ok: false, error: "voice_context_too_large", status: 413 };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawContext);
    } catch {
      return { ok: false, error: "invalid_voice_context", status: 400 };
    }
    const parsedContext = VoiceQaContextSchema.safeParse(decoded);
    if (!parsedContext.success) {
      return { ok: false, error: "invalid_voice_context", status: 400 };
    }
    context = parsedContext.data;
    if (scope === "current" && context.contextId !== uploadId) {
      return { ok: false, error: "voice_context_upload_mismatch", status: 400 };
    }
  }

  return {
    ok: true,
    value: {
      audio: audioValue,
      scope,
      answerMode,
      ...(uploadId ? { uploadId } : {}),
      ...(referenceDate ? { referenceDate } : {}),
      ...(conversationSessionId ? { conversationSessionId } : {}),
      ...(conversation !== undefined ? { conversation } : {}),
      ...(context ? { context } : {})
    }
  };
}

function contentLengthTooLarge(request: Request) {
  const value = request.headers.get("content-length")?.trim();
  if (!value || !/^\d+$/u.test(value)) return false;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >
    MAX_BROWSER_VOICE_AUDIO_BYTES +
      MAX_VOICE_QA_CONTEXT_BYTES +
      MAX_BROWSER_VOICE_CONVERSATION_BYTES +
      MULTIPART_OVERHEAD_ALLOWANCE_BYTES;
}

function publicFailure(error: unknown) {
  if (
    error instanceof VoiceSessionAccessError ||
    error instanceof VoiceSessionNotFoundError
  ) {
    return { status: 404, error: "voice_session_not_found" };
  }
  if (error instanceof VoiceSessionExpiredError) {
    return { status: 410, error: "voice_session_expired" };
  }
  if (
    error instanceof VoiceSessionClosedError ||
    error instanceof VoiceSessionTransitionError
  ) {
    return { status: 409, error: "voice_session_unavailable" };
  }
  if (error instanceof BrowserVoiceQaSessionError) {
    return error.code === "response_timeout"
      ? { status: 504, error: "voice_response_timeout" }
      : { status: 408, error: "voice_request_aborted" };
  }
  if (error instanceof BrowserVoiceAudioError) {
    if (error.code === "unsupported_mime_type") return { status: 415, error: "unsupported_audio_format" };
    if (error.code === "audio_too_large" || error.code === "audio_too_long") {
      return { status: 413, error: error.code };
    }
    if (error.code === "conversion_aborted" || error.code === "stream_aborted") {
      return { status: 408, error: "voice_request_aborted" };
    }
    return { status: 422, error: "invalid_audio" };
  }
  if (error instanceof VoiceQaAdapterError) {
    if (error.code === "upload_not_found") return { status: 404, error: error.code };
    if (error.code === "upload_not_ready") return { status: 409, error: error.code };
    return { status: 400, error: error.code };
  }
  return { status: 503, error: "voice_session_failed" };
}

function deriveCurrentTopic(transcript: string, previous?: string) {
  const normalized = transcript.trim().replace(/\s+/gu, " ");
  const contextualFollowUp = /^(?:这|那|它|他|她|他们|她们|明天|之后|然后|后来|再|还|这个|那个|what about|and then|tomorrow|later|it|that)/iu;
  if (previous && normalized.length <= 80 && contextualFollowUp.test(normalized)) {
    return previous;
  }
  return normalized.split(/[。！？!?\n]/u, 1)[0]?.slice(0, 200) || previous;
}

async function prepareManagedSession(input: {
  manager: VoiceSessionManager;
  userId: string;
  requestedSessionId?: string;
}) {
  if (input.requestedSessionId) {
    return input.manager.claimTurn(input.requestedSessionId, input.userId);
  }
  const session = await input.manager.create({ userId: input.userId });
  return input.manager.claimTurn(session.sessionId, input.userId);
}

async function restoreManagedSessionToIdle(
  manager: VoiceSessionManager,
  sessionId: string,
  userId: string
) {
  try {
    const session = await manager.lookup(sessionId, userId);
    if (session && session.state !== "IDLE" && session.state !== "CLOSED") {
      await manager.transition(sessionId, "IDLE", userId);
    }
  } catch {
    // Failure recovery must not replace the original public error.
  }
}

async function releaseAbortedManagedSession(
  manager: VoiceSessionManager,
  sessionId: string,
  traceId: string,
  userId: string
) {
  try {
    await manager.releaseTurn(sessionId, traceId, userId);
  } catch {
    // Abort recovery must not replace the original public error.
  }
}

function recordResponseErrors(
  trace: VoiceSessionTraceRecorder,
  errors: readonly string[]
) {
  if (errors.includes("asr_failed")) trace.recordFailure("asr", "asr_failed");
  if (errors.includes("qa_failed")) trace.recordFailure("qa", "qa_failed");
  if (errors.includes("tts_failed")) trace.recordFailure("tts", "tts_failed");
}

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }

  if (contentLengthTooLarge(request)) {
    return noStoreJson({ error: "audio_too_large" }, { status: 413 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    return noStoreJson({ error: "invalid_form_data" }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return noStoreJson({ error: "invalid_form_data" }, { status: 400 });
  }
  const parsed = parseVoiceQaForm(form);
  if (!parsed.ok) {
    return noStoreJson({ error: parsed.error }, { status: parsed.status });
  }
  if (request.signal.aborted) {
    return noStoreJson({ error: "voice_request_aborted" }, { status: 408 });
  }

  const sessionManager = new VoiceSessionManager({ store: authContext.store });
  await sessionManager.cleanupExpired().catch(() => undefined);
  let managedSession: VoiceSession;
  try {
    managedSession = await prepareManagedSession({
      manager: sessionManager,
      userId: authContext.user.id,
      requestedSessionId: parsed.value.conversationSessionId
    });
  } catch (error) {
    const failure = publicFailure(error);
    return noStoreJson({ error: failure.error }, { status: failure.status });
  }

  const trace = new VoiceSessionTracer({
    applicationSessionId: managedSession.sessionId,
    scope: parsed.value.scope,
    ...(parsed.value.uploadId ? { uploadId: parsed.value.uploadId } : {}),
    writer: new JsonVoiceSessionTraceRepository(authContext.store)
  });
  await trace.flush();
  managedSession = await sessionManager.attachTrace(
    managedSession.sessionId,
    trace.sessionId,
    authContext.user.id
  );
  const turnConversation = parsed.value.conversation ??
    managedSession.conversationContext;

  if (acceptsVoiceNdjson(request)) {
    const abortController = new AbortController();
    const onRequestAbort = () => abortController.abort();
    request.signal.addEventListener("abort", onRequestAbort, { once: true });
    if (request.signal.aborted) onRequestAbort();

    const transport = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transport.writable.getWriter();
    void writer.closed.catch(() => abortController.abort());
    const writeEvent = async (event: VoiceBrowserStreamEvent) => {
      let encodedEvent: Uint8Array;
      try {
        encodedEvent = encodeVoiceBrowserStreamEvent(event);
      } catch (error) {
        if (error instanceof ZodError) {
          logVoiceStreamSchemaFailure(event.type, error);
        }
        throw error;
      }
      await writer.ready;
      await writer.write(encodedEvent);
    };

    void (async () => {
      let audioChunkCount = 0;
      let answerWritten = false;
      let terminalWritten = false;
      const writeComplete = async (
        status: Extract<VoiceBrowserStreamEvent, { type: "complete" }>["status"],
        errors: string[]
      ) => {
        if (terminalWritten) return;
        await writeEvent({
          type: "complete",
          status,
          errors: [...new Set(errors)]
        });
        terminalWritten = true;
        trace.mark("transport_complete_written");
      };
      try {
        await writeEvent({
          type: "meta",
          version: 1,
          conversationSessionId: managedSession.sessionId,
          traceId: trace.sessionId,
          audio: {
            format: "pcm_s16le",
            sampleRate: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT.sampleRate,
            channels: DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT.channels
          }
        });

        const audio = Buffer.from(await parsed.value.audio.arrayBuffer());
        if (abortController.signal.aborted) {
          throw new BrowserVoiceQaSessionError(
            "request_aborted",
            "Browser Voice QA request was aborted"
          );
        }
        const onStreamingEvent = async (event: VoiceQaStreamingOutputEvent) => {
          if (event.type !== "audio_chunk") return;
          audioChunkCount += 1;
          await writeEvent({
            type: "audio_chunk",
            sequence: event.sequence,
            sentenceSequence: event.sentenceSequence,
            chunkSequence: event.sentenceChunkSequence,
            audioBase64: event.audio.toString("base64")
          });
        };
        const result = await runBrowserVoiceQaSession({
          audio,
          mimeType: parsed.value.audio.type,
          userId: authContext.user.id,
          store: authContext.store,
          scope: parsed.value.scope,
          answerMode: parsed.value.answerMode,
          ...(parsed.value.uploadId ? { uploadId: parsed.value.uploadId } : {}),
          ...(parsed.value.referenceDate ? { referenceDate: parsed.value.referenceDate } : {}),
          ...(parsed.value.context ? { context: parsed.value.context } : {}),
          trace,
          signal: abortController.signal,
          onStreamingEvent,
          applicationSessionId: managedSession.sessionId,
          conversation: turnConversation,
          onLifecycleStateChange: (state) => sessionManager.transitionTurn(
            managedSession.sessionId,
            trace.sessionId,
            state,
            authContext.user.id
          ).then(() => undefined),
          onTurnCompleted: (turn) => sessionManager.appendTurn(
            managedSession.sessionId,
            {
              transcript: turn.transcript.slice(0, 1_200),
              response: turn.response.slice(0, 1_200),
              retrievedMemoryIds: turn.retrievedMemoryIds,
              currentTopic: deriveCurrentTopic(turn.transcript, managedSession.currentTopic)
            },
            authContext.user.id
          ).then((updated) => {
            managedSession = updated;
          })
        });

        const response = result.response;
        const errors = [...(response.errors ?? [])];
        const errorCodes = [...(response.errorCodes ?? [])];
        let fallbackAudioBase64: string | undefined;
        if (response.audio) {
          try {
            fallbackAudioBase64 = wrapPcm16LeAsWav(
              response.audio,
              DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT
            ).toString("base64");
          } catch {
            if (!errors.includes("tts_failed")) errors.push("tts_failed");
            if (!errorCodes.includes("VOICE_TTS_FAILED")) {
              errorCodes.push("VOICE_TTS_FAILED");
            }
          }
        }
        recordResponseErrors(trace, errors);

        if (fallbackAudioBase64) {
          await writeEvent({
            type: "fallback_audio",
            audioBase64: fallbackAudioBase64,
            audioMimeType: "audio/wav"
          });
        }
        await writeEvent({
          type: "answer",
          sessionId: response.sessionId,
          transcript: response.transcript,
          text: response.text,
          ...(response.answer ? {
            answer: {
              id: response.answer.id,
              citedSegmentIds: response.answer.citedSegmentIds,
              citations: response.answer.citations ?? []
            }
          } : {}),
          ...(errors.length > 0 ? { errors: [...new Set(errors)] } : {}),
          ...(errorCodes.length > 0 ? { errorCodes: [...new Set(errorCodes)] } : {})
        });
        answerWritten = true;

        await writeComplete(
          errors.length > 0 ? "completed_with_errors" : "completed",
          errors
        );
        if (audioChunkCount === 0 && !fallbackAudioBase64) {
          trace.complete();
          await trace.flush();
        }
      } catch (error) {
        const failure = publicFailure(error);
        const aborted = failure.error === "voice_request_aborted";
        if (aborted) {
          await releaseAbortedManagedSession(
            sessionManager,
            managedSession.sessionId,
            trace.sessionId,
            authContext.user.id
          );
        } else {
          await restoreManagedSessionToIdle(
            sessionManager,
            managedSession.sessionId,
            authContext.user.id
          );
        }
        let traceStatus: "aborted" | "incomplete" | "failed";
        if (aborted) {
          trace.recordFailure("session", "request_aborted");
          traceStatus = "aborted";
        } else if (failure.error === "voice_response_timeout") {
          const snapshot = trace.snapshot();
          if (!snapshot.timestamps.asr_final_received) {
            trace.recordFailure("asr", "asr_final_missing");
          } else if (snapshot.timestamps.tts_started) {
            trace.recordFailure("tts", "tts_timeout");
          } else if (snapshot.timestamps.qa_started && !snapshot.timestamps.qa_completed) {
            trace.recordFailure("qa", "qa_timeout");
          }
          trace.recordFailure("session", "response_timeout");
          traceStatus = "incomplete";
        } else {
          trace.recordFailure("session", "session_failed");
          traceStatus = "failed";
        }
        console.warn(
          `[browser-voice-qa-stream] failed error_name=${error instanceof Error ? error.name : "unknown"} error_code=${failure.error}`
        );
        if (!terminalWritten) {
          await writeEvent({
            type: "error",
            code: failure.error,
            textAvailable: answerWritten
          }).catch(() => undefined);
          await writeComplete(
            aborted ? "aborted" : "failed",
            [failure.error]
          ).catch(() => undefined);
        }
        trace.complete(traceStatus);
        await trace.flush();
      } finally {
        request.signal.removeEventListener("abort", onRequestAbort);
        await writer.close().catch(() => undefined);
      }
    })();

    return voiceNdjsonResponse(transport.readable);
  }

  try {
    const audio = Buffer.from(await parsed.value.audio.arrayBuffer());
    if (request.signal.aborted) {
      throw new BrowserVoiceQaSessionError(
        "request_aborted",
        "Browser Voice QA request was aborted"
      );
    }
    const result = await runBrowserVoiceQaSession({
      audio,
      mimeType: parsed.value.audio.type,
      userId: authContext.user.id,
      store: authContext.store,
      scope: parsed.value.scope,
      answerMode: parsed.value.answerMode,
      ...(parsed.value.uploadId ? { uploadId: parsed.value.uploadId } : {}),
      ...(parsed.value.referenceDate ? { referenceDate: parsed.value.referenceDate } : {}),
      ...(parsed.value.context ? { context: parsed.value.context } : {}),
      trace,
      signal: request.signal,
      applicationSessionId: managedSession.sessionId,
      conversation: turnConversation,
      onLifecycleStateChange: (state) => sessionManager.transitionTurn(
        managedSession.sessionId,
        trace.sessionId,
        state,
        authContext.user.id
      ).then(() => undefined),
      onTurnCompleted: (turn) => sessionManager.appendTurn(
        managedSession.sessionId,
        {
          transcript: turn.transcript.slice(0, 1_200),
          response: turn.response.slice(0, 1_200),
          retrievedMemoryIds: turn.retrievedMemoryIds,
          currentTopic: deriveCurrentTopic(turn.transcript, managedSession.currentTopic)
        },
        authContext.user.id
      ).then((updated) => {
        managedSession = updated;
      })
    });
    const response = result.response;
    const errors = [...(response.errors ?? [])];
    let audioBase64: string | undefined;
    if (response.audio) {
      try {
        audioBase64 = wrapPcm16LeAsWav(
          response.audio,
          DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT
        ).toString("base64");
      } catch {
        if (!errors.includes("tts_failed")) errors.push("tts_failed");
        if (!response.errorCodes?.includes("VOICE_TTS_FAILED")) {
          response.errorCodes = [...(response.errorCodes ?? []), "VOICE_TTS_FAILED"];
        }
      }
    }
    recordResponseErrors(trace, errors);
    if (!audioBase64) {
      trace.complete();
      await trace.flush();
    }

    return noStoreJson({
      version: 1,
      conversationSessionId: managedSession.sessionId,
      traceId: trace.sessionId,
      sessionId: response.sessionId,
      transcript: response.transcript,
      text: response.text,
      ...(audioBase64 ? {
        audioBase64,
        audioMimeType: "audio/wav"
      } : {}),
      ...(response.answer ? {
        answer: {
          id: response.answer.id,
          citedSegmentIds: response.answer.citedSegmentIds,
          citations: response.answer.citations ?? []
        }
      } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(response.errorCodes && response.errorCodes.length > 0
        ? { errorCodes: response.errorCodes }
        : {})
    });
  } catch (error) {
    const failure = publicFailure(error);
    const aborted = failure.error === "voice_request_aborted";
    if (aborted) {
      await releaseAbortedManagedSession(
        sessionManager,
        managedSession.sessionId,
        trace.sessionId,
        authContext.user.id
      );
    } else {
      await restoreManagedSessionToIdle(
        sessionManager,
        managedSession.sessionId,
        authContext.user.id
      );
    }
    if (aborted) {
      trace.recordFailure("session", "request_aborted");
      trace.complete("aborted");
    } else if (failure.error === "voice_response_timeout") {
      const snapshot = trace.snapshot();
      if (!snapshot.timestamps.asr_final_received) {
        trace.recordFailure("asr", "asr_final_missing");
      } else if (snapshot.timestamps.tts_started) {
        trace.recordFailure("tts", "tts_timeout");
      } else if (snapshot.timestamps.qa_started && !snapshot.timestamps.qa_completed) {
        trace.recordFailure("qa", "qa_timeout");
      }
      trace.recordFailure("session", "response_timeout");
      trace.complete("incomplete");
    } else {
      trace.recordFailure("session", "session_failed");
      trace.complete("failed");
    }
    await trace.flush();
    const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown";
    console.warn(
      `[browser-voice-qa] failed error_name=${error instanceof Error ? error.name : "unknown"} error_code=${errorCode}`
    );
    return noStoreJson({ error: failure.error }, { status: failure.status });
  }
}
