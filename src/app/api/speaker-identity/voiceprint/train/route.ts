import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";

import type { AudioUpload } from "@/lib/domain/types";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  VoiceprintProviderError,
  VoiceprintWorkflowError,
  createConfiguredVoiceprintService
} from "@/lib/server/speaker-identity";
import {
  buildVoiceprintTrainingAudioUrl,
  createVoiceprintProviderRequestId
} from "@/lib/server/speaker-identity/voiceprint-api-support";

export const runtime = "nodejs";

type StoredUpload = AudioUpload & {
  filePath?: string;
  evaluationRetention?: boolean;
};

const StoreKeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);
const TrainingTimestampSchema = z.number().int().nonnegative().max(86_400_000);

const TrainRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(512),
  audio: z.array(z.object({
    uploadId: StoreKeySchema,
    rule: z.array(
      z.tuple([TrainingTimestampSchema, TrainingTimestampSchema.positive()])
        .refine(([start, end]) => end > start)
    ).min(1).max(100)
  }).strict()).min(1).max(2)
}).strict();

function providerErrorResponse(error: VoiceprintProviderError) {
  const status =
    error.reason === "invalid_request" ? 400 :
      error.reason === "invalid_configuration" ? 503 :
        error.reason === "timeout" ? 504 : 502;
  return NextResponse.json({
    error: `voiceprint_${error.reason}`,
    retryable: error.retryable
  }, { status });
}

function workflowErrorResponse(error: VoiceprintWorkflowError) {
  const status =
    error.reason === "request_id_conflict" || error.reason === "operation_in_progress"
      ? 409
      : 500;
  return NextResponse.json({ error: `voiceprint_${error.reason}` }, { status });
}

function isOwnedUploadFilePath(filePath: string, uploadsRootDir: string) {
  const root = resolve(uploadsRootDir);
  return resolve(filePath).startsWith(`${root}${sep}`);
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
  const parsed = TrainRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_voiceprint_train_request" }, { status: 400 });
  }

  const uploads = await Promise.all(
    parsed.data.audio.map(({ uploadId }) =>
      authContext.store.read<StoredUpload>("uploads", uploadId)
    )
  );
  if (uploads.some((upload) => upload === null)) {
    return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
  }
  const hasOutOfRangeRule = parsed.data.audio.some((audio, index) => {
    const durationSeconds = uploads[index]?.durationSeconds;
    if (durationSeconds === undefined) return false;
    const durationMilliseconds = Math.ceil(durationSeconds * 1_000);
    return audio.rule.some(([, endMilliseconds]) =>
      endMilliseconds > durationMilliseconds
    );
  });
  if (hasOutOfRangeRule) {
    return NextResponse.json(
      { error: "voiceprint_training_range_out_of_bounds" },
      { status: 400 }
    );
  }
  const availableAudio = await Promise.all(
    uploads.map(async (upload) => {
      if (
        !upload?.filePath ||
        !isOwnedUploadFilePath(upload.filePath, authContext.uploadsRootDir)
      ) {
        return false;
      }
      const file = await stat(upload.filePath).catch(() => null);
      return Boolean(file?.isFile());
    })
  );
  if (availableAudio.some((available) => !available)) {
    return NextResponse.json(
      {
        error: "voiceprint_training_audio_unavailable",
        hint: "use an upload whose audio is still retained"
      },
      { status: 409 }
    );
  }

  try {
    const requestId = createVoiceprintProviderRequestId({
      operation: "train",
      userId: authContext.user.id,
      clientRequestId: parsed.data.requestId
    });
    const result = await createConfiguredVoiceprintService(authContext.store).trainUser({
      userId: authContext.user.id,
      requestId,
      audio: parsed.data.audio.map(({ uploadId, rule }) => ({
        url: buildVoiceprintTrainingAudioUrl({
          userId: authContext.user.id,
          uploadId
        }),
        rule
      })),
      ...(authContext.user.name ? { displayName: authContext.user.name } : {})
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
        identityType: result.profile.identityType
      }
    });
  } catch (error) {
    if (error instanceof VoiceprintProviderError) {
      return providerErrorResponse(error);
    }
    if (error instanceof VoiceprintWorkflowError) {
      return workflowErrorResponse(error);
    }
    console.error(
      `[voiceprint] train_failed error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return NextResponse.json({ error: "voiceprint_train_failed" }, { status: 500 });
  }
}
