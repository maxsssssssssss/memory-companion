import { NextResponse } from "next/server";
import { z } from "zod";

import {
  MAX_VOICE_QA_CONTEXT_BYTES,
  VoiceQaContextSchema
} from "@/lib/domain/voice-qa-context";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { dateFromKey, formatDateKey } from "@/lib/server/retrieval/memory-scope-qa";
import {
  RealtimeVoiceQaSessionError,
  realtimeVoiceQaSessions
} from "@/lib/server/voice-qa/realtime-session-registry";
import { VoiceSessionConversationMessageSchema } from "@/lib/server/voice-qa/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REALTIME_SESSION_REQUEST_BYTES =
  MAX_VOICE_QA_CONTEXT_BYTES + 64 * 1024;
const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

const RealtimeVoiceSessionRequestSchema = z.object({
  scope: z.enum(["current", "week", "all"]).default("all"),
  uploadId: z.string().min(1).max(200).regex(STORE_KEY_PATTERN).optional(),
  referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  context: VoiceQaContextSchema.optional(),
  conversation: VoiceSessionConversationMessageSchema.array().max(8).optional()
}).strict().superRefine((value, context) => {
  if (value.scope === "current" && !value.uploadId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["uploadId"],
      message: "current scope requires uploadId"
    });
  }
  if (value.scope !== "current" && value.uploadId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["uploadId"],
      message: "uploadId is only valid for current scope"
    });
  }
  if (value.scope !== "week" && value.referenceDate) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["referenceDate"],
      message: "referenceDate is only valid for week scope"
    });
  }
  if (
    value.scope === "current" &&
    value.context &&
    value.context.contextId !== value.uploadId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "contextId"],
      message: "context does not match uploadId"
    });
  }
});

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function parseExactDate(value: string | undefined) {
  if (!value) return undefined;
  const parsed = dateFromKey(value);
  return parsed && formatDateKey(parsed) === value ? parsed : undefined;
}

function publicRealtimeStartFailure(error: unknown) {
  if (error instanceof RealtimeVoiceQaSessionError) {
    if (error.code === "disabled") {
      return { status: 404, code: "voice_realtime_disabled" };
    }
    if (error.code === "session_limit") {
      return { status: 429, code: "voice_realtime_session_limit" };
    }
  }
  return { status: 503, code: "voice_realtime_unavailable" };
}

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_REALTIME_SESSION_REQUEST_BYTES
  ) {
    return noStoreJson({ error: "voice_realtime_request_too_large" }, 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return noStoreJson({ error: "invalid_json" }, 400);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_REALTIME_SESSION_REQUEST_BYTES) {
    return noStoreJson({ error: "voice_realtime_request_too_large" }, 413);
  }
  let decoded: unknown;
  try {
    decoded = text ? JSON.parse(text) : {};
  } catch {
    return noStoreJson({ error: "invalid_json" }, 400);
  }
  const parsed = RealtimeVoiceSessionRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    return noStoreJson({ error: "invalid_voice_realtime_session" }, 400);
  }
  const referenceDate = parseExactDate(parsed.data.referenceDate);
  if (parsed.data.referenceDate && !referenceDate) {
    return noStoreJson({ error: "invalid_reference_date" }, 400);
  }

  try {
    const session = await realtimeVoiceQaSessions.create({
      userId: authContext.user.id,
      store: authContext.store,
      scope: parsed.data.scope,
      ...(parsed.data.uploadId ? { uploadId: parsed.data.uploadId } : {}),
      ...(referenceDate ? { referenceDate } : {}),
      ...(parsed.data.context ? { context: parsed.data.context } : {}),
      ...(parsed.data.conversation
        ? { conversation: parsed.data.conversation }
        : {})
    });
    return noStoreJson({
      version: 1,
      ...session,
      inputAudio: {
        format: "pcm_s16le",
        sampleRate: 16_000,
        channels: 1,
        chunkSamples: 320
      },
      outputAudio: {
        format: "pcm_s16le",
        sampleRate: 24_000,
        channels: 1
      }
    }, 201);
  } catch (error) {
    const failure = publicRealtimeStartFailure(error);
    console.warn(
      `[voice-realtime] start_failed error_code=${failure.code} ` +
      `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return noStoreJson({ error: failure.code }, failure.status);
  }
}
