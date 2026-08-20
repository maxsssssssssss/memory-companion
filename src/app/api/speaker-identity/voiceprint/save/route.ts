import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import type { AudioUpload } from "@/lib/domain/types";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { isDailyReflectionUpload } from "@/lib/server/daily-reflection/upload-record";
import {
  VoiceprintProviderError,
  VoiceprintWorkflowError,
  createConfiguredVoiceprintService
} from "@/lib/server/speaker-identity";
import { createVoiceprintProviderRequestId } from "@/lib/server/speaker-identity/voiceprint-api-support";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";

export const runtime = "nodejs";

const StoreKeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);

const SaveRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(512),
  uploadId: StoreKeySchema,
  chunkId: StoreKeySchema,
  localSpeaker: z.string().trim().min(1).max(512),
  globalSpeakerId: z.string().trim().min(1).max(512).optional(),
  displayName: z.string().trim().min(1).max(120)
}).strict();

function contactIdForRequest(requestId: string) {
  return `contact_${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`;
}

function expectedErrorResponse(error: VoiceprintProviderError | VoiceprintWorkflowError) {
  if (error instanceof VoiceprintProviderError) {
    const status =
      error.reason === "invalid_request" ? 400 :
        error.reason === "invalid_configuration" ? 503 :
          error.reason === "timeout" ? 504 : 502;
    return NextResponse.json({
      error: `voiceprint_${error.reason}`,
      retryable: error.retryable
    }, { status });
  }

  const status =
    error.reason === "contact_limit_reached" ? 409 :
      error.reason === "identity_type_conflict" ||
        error.reason === "request_id_conflict" ||
        error.reason === "operation_in_progress" ? 409 :
        error.reason === "invalid_contact_name" ? 400 : 500;
  return NextResponse.json({ error: `voiceprint_${error.reason}` }, { status });
}

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = SaveRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_voiceprint_save_request" }, { status: 400 });
  }

  const upload = await authContext.store.read<AudioUpload>("uploads", parsed.data.uploadId);
  if (!upload || isDailyReflectionUpload(upload)) {
    return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
  }
  const chunks = await new JsonChunkCheckpointStore(authContext.store)
    .listTranscriptChunks(parsed.data.uploadId);
  const chunk = chunks.find((item) => item.id === parsed.data.chunkId);
  if (!chunk) {
    return NextResponse.json({ error: "transcript_chunk_not_found" }, { status: 404 });
  }
  if (!chunk.segments.some((segment) => segment.speaker === parsed.data.localSpeaker)) {
    return NextResponse.json({ error: "local_speaker_not_found" }, { status: 404 });
  }

  try {
    const requestId = createVoiceprintProviderRequestId({
      operation: "save",
      userId: authContext.user.id,
      clientRequestId: parsed.data.requestId
    });
    const result = await createConfiguredVoiceprintService(authContext.store).saveContact({
      userId: authContext.user.id,
      requestId,
      recordId: chunk.audioChunkId,
      uploadId: parsed.data.uploadId,
      chunkId: parsed.data.chunkId,
      localSpeaker: parsed.data.localSpeaker,
      globalSpeakerId: parsed.data.globalSpeakerId ?? contactIdForRequest(requestId),
      displayName: parsed.data.displayName,
      providerSpeakerId: parsed.data.displayName
    });
    return NextResponse.json({
      operation: {
        id: result.operation.operationId,
        requestId: result.operation.providerRequestId,
        status: result.operation.status,
        reused: result.reused
      },
      identity: {
        globalSpeakerId: result.profile.globalSpeakerId,
        displayName: result.profile.displayName,
        identityType: result.profile.identityType
      },
      mapping: {
        uploadId: result.mapping.uploadId,
        chunkId: result.mapping.chunkId,
        localSpeaker: result.mapping.localSpeaker,
        source: result.mapping.source
      }
    });
  } catch (error) {
    if (error instanceof VoiceprintProviderError || error instanceof VoiceprintWorkflowError) {
      return expectedErrorResponse(error);
    }
    console.error(
      `[voiceprint] save_failed error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return NextResponse.json({ error: "voiceprint_save_failed" }, { status: 500 });
  }
}
