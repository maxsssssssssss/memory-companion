import * as fs from "fs/promises";
import { resolve, sep } from "path";
import { NextResponse } from "next/server";
import type { AudioUpload, ProcessingJob, QuestionAnswer } from "@/lib/domain/types";
import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import {
  isDateCompanionMarkedUpload,
  type DateCompanionMarkedUpload
} from "@/lib/domain/date-companion-upload";
import { proactiveInsightCacheIdForUpload } from "@/lib/domain/proactive-insights";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { isConfirmedEvaluationDelete, isEvaluationRetentionUpload } from "@/lib/server/evaluation/retention";
import { deleteProviderRawResponseCaptures } from "@/lib/server/evaluation/provider-response-capture";
import {
  DcConflictError,
  DcVersionConflictError,
  getDateCompanionRepository
} from "@/lib/server/date-companion";
import { deleteDateCompanionAudioStaging } from "@/lib/server/date-companion/audio-staging";
import { getMemoryRepository } from "@/lib/server/memory";
import { cleanupGeneratedAudioChunks } from "@/lib/server/transcription/chunks/audio-planner";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";
import { JsonAnalysisChunkCheckpointStore } from "@/lib/server/analysis-chunks/checkpoint";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";

type StoredUpload = AudioUpload & DateCompanionMarkedUpload & {
  filePath?: string;
  evaluationRetention?: boolean;
};

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const BROWSER_CACHE_CLEANUP_MODE = "browser-cache";
const DATE_COMPANION_INTERACTION_HEADER = "x-date-companion-interaction-id";

function isValidStoreKey(value: unknown): value is string {
  return typeof value === "string" && STORE_KEY_PATTERN.test(value);
}

function isUploadFilePath(filePath: string, uploadsRootDir: string) {
  const uploadsRoot = resolve(uploadsRootDir);

  return resolve(filePath).startsWith(`${uploadsRoot}${sep}`);
}

function warnInvalidChildId(kind: "job" | "answer", id: unknown, uploadId: string) {
  console.warn(`Skipping invalid ${kind} id during upload cleanup`, { id, uploadId });
}

function explicitDateCompanionDeletePrecondition(
  request: Request,
  current: { interactionId: string; version: number }
) {
  const interactionId = request.headers.get(DATE_COMPANION_INTERACTION_HEADER);
  const ifMatch = request.headers.get("if-match");
  if (interactionId === null || ifMatch === null) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "interaction_version_required",
          requiredHeaders: [DATE_COMPANION_INTERACTION_HEADER, "if-match"]
        },
        { status: 428 }
      )
    } as const;
  }

  const parsedInteractionId = DcIdSchema.safeParse(interactionId);
  const versionMatch = /^(?:"(\d+)"|(\d+))$/u.exec(ifMatch.trim());
  const expectedVersion = versionMatch
    ? Number(versionMatch[1] ?? versionMatch[2])
    : Number.NaN;
  if (
    !parsedInteractionId.success ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid_interaction_precondition" },
        { status: 400 }
      )
    } as const;
  }
  if (parsedInteractionId.data !== current.interactionId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "interaction_source_conflict" },
        { status: 409 }
      )
    } as const;
  }
  if (expectedVersion !== current.version) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "version_conflict", currentVersion: current.version },
        { status: 409 }
      )
    } as const;
  }
  return {
    ok: true,
    interactionId: current.interactionId,
    expectedVersion
  } as const;
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ uploadId: string }> }
): Promise<Response> {
  const { uploadId } = await params;

  if (!isValidStoreKey(uploadId)) {
    return NextResponse.json({ error: "invalid_upload_id" }, { status: 400 });
  }

  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const isBrowserCacheCleanup =
    request.headers.get("x-daily-brief-cleanup-mode") ===
    BROWSER_CACHE_CLEANUP_MODE;
  const dateCompanionRepository = getDateCompanionRepository();
  const relationshipInteraction = dateCompanionRepository.getInteractionVersionByUpload(
    authContext.user.id,
    uploadId
  );
  const upload = await authContext.store.read<StoredUpload>("uploads", uploadId);
  if (upload && isEvaluationRetentionUpload(upload) && !isConfirmedEvaluationDelete(request)) {
    console.info(`[evaluation-retention] blocked automatic upload cleanup upload_id=${uploadId}`);
    return NextResponse.json(
      {
        error: "evaluation_retention_active",
        retained: true,
        confirmationHeader: "x-evaluation-delete-confirmed"
      },
      { status: 409 }
    );
  }
  if (
    upload &&
    isBrowserCacheCleanup &&
    isDateCompanionMarkedUpload(upload) &&
    !relationshipInteraction
  ) {
    return NextResponse.json(
      { error: "date_companion_import_required", retryable: true },
      { status: 409 }
    );
  }

  const explicitDeletePrecondition =
    !isBrowserCacheCleanup && relationshipInteraction
      ? explicitDateCompanionDeletePrecondition(request, relationshipInteraction)
      : null;
  if (explicitDeletePrecondition && !explicitDeletePrecondition.ok) {
    return explicitDeletePrecondition.response;
  }
  if (relationshipInteraction && explicitDeletePrecondition?.ok) {
    try {
      const prepared = dateCompanionRepository.prepareInteractionDeletion(
        authContext.user.id,
        explicitDeletePrecondition.interactionId,
        explicitDeletePrecondition.expectedVersion
      );
      if (prepared.sourceUploadId !== uploadId) {
        throw new DcConflictError("interaction_source_mismatch");
      }
    } catch (error) {
      if (error instanceof DcVersionConflictError) {
        return NextResponse.json(
          { error: error.code, currentVersion: error.currentVersion },
          { status: 409 }
        );
      }
      if (error instanceof DcConflictError) {
        return NextResponse.json({ error: error.code }, { status: 409 });
      }
      console.error(
        "[upload-cleanup] date companion delete preparation failed.",
        error instanceof Error ? error.message : "unknown_error"
      );
      return NextResponse.json(
        { error: "upload_cleanup_failed", deleted: false, retryable: true },
        { status: 500 }
      );
    }
  }

  if (!upload) {
    try {
      if (isBrowserCacheCleanup && relationshipInteraction) {
        const markedServerCleaned = dateCompanionRepository.markUploadSourceState(
          authContext.user.id,
          uploadId,
          "server_cleaned"
        );
        if (!markedServerCleaned) {
          throw new Error("date_companion_source_state_update_failed");
        }
        await deleteDateCompanionAudioStaging(authContext.store, uploadId);
        return NextResponse.json({
          deleted: true,
          uploadAlreadyDeleted: true,
          relationshipSnapshotRetained: true
        });
      }

      if (
        relationshipInteraction &&
        explicitDeletePrecondition &&
        explicitDeletePrecondition.ok
      ) {
        await deleteDateCompanionAudioStaging(authContext.store, uploadId);
        const deletedRelationshipInteraction =
          dateCompanionRepository.deleteInteractionByUpload(
            authContext.user.id,
            uploadId,
            explicitDeletePrecondition.interactionId,
            explicitDeletePrecondition.expectedVersion
          );
        if (!deletedRelationshipInteraction) {
          throw new Error("date_companion_interaction_delete_failed");
        }
        return NextResponse.json({
          deleted: true,
          uploadAlreadyDeleted: true,
          relationshipInteractionDeleted: true
        });
      }
    } catch (error) {
      if (error instanceof DcVersionConflictError) {
        return NextResponse.json(
          { error: error.code, currentVersion: error.currentVersion },
          { status: 409 }
        );
      }
      if (error instanceof DcConflictError) {
        return NextResponse.json({ error: error.code }, { status: 409 });
      }
      console.error(
        "[upload-cleanup] retained relationship cleanup failed.",
        error instanceof Error ? error.message : "unknown_error"
      );
      return NextResponse.json(
        { error: "upload_cleanup_failed", deleted: false, retryable: true },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
  }

  let relationshipSnapshotRetained = false;
  let relationshipInteractionDeleted = false;
  try {
    await authContext.store.write("deleted-uploads", uploadId, {
      uploadId,
      deletedAt: new Date().toISOString()
    });

    if (upload.filePath && isUploadFilePath(upload.filePath, authContext.uploadsRootDir)) {
      await fs.rm(upload.filePath, { force: true });
    }

    const chunkCheckpoints = new JsonChunkCheckpointStore(authContext.store);
    const chunks = await chunkCheckpoints.listAudioChunks(uploadId);
    await cleanupGeneratedAudioChunks(chunks);
    await chunkCheckpoints.deleteUpload(uploadId);
    await new JsonAnalysisChunkCheckpointStore(authContext.store).deleteUpload(authContext.user.id, uploadId);
    await new JsonSpeakerIdentityRepository(authContext.store).deleteUploadMappings(uploadId);

    const job = await authContext.store.read<ProcessingJob>("jobs-by-upload", uploadId);
    if (job) {
      if (isValidStoreKey(job.id)) {
        await authContext.store.delete("jobs", job.id);
      } else {
        warnInvalidChildId("job", job.id, uploadId);
      }
    }

    const answers = (await authContext.store.read<QuestionAnswer[]>("answers-by-upload", uploadId)) ?? [];
    await Promise.all(
      answers.map((answer) => {
        if (isValidStoreKey(answer.id)) {
          return authContext.store.delete("answers", answer.id);
        }

        warnInvalidChildId("answer", answer.id, uploadId);
        return Promise.resolve();
      })
    );

    await Promise.all([
      authContext.store.delete("jobs-by-upload", uploadId),
      authContext.store.delete("segments", uploadId),
      authContext.store.delete("audio-insights", uploadId),
      authContext.store.delete("audio-insight-corrections", uploadId),
      authContext.store.delete("speaker-aliases", uploadId),
      authContext.store.delete("semantic-segments", uploadId),
      authContext.store.delete("brief-items", uploadId),
      authContext.store.delete("relationship-signals", uploadId),
      authContext.store.delete("relationship-lifecycle", uploadId),
      authContext.store.delete("speaker-identities", uploadId),
      authContext.store.delete("memory-owner-audits", uploadId),
      authContext.store.delete("proactive-insights", proactiveInsightCacheIdForUpload(uploadId)),
      authContext.store.delete("answers-by-upload", uploadId),
      deleteDateCompanionAudioStaging(authContext.store, uploadId)
    ]);

    getMemoryRepository().deleteByUpload(authContext.user.id, uploadId);
    await deleteProviderRawResponseCaptures(uploadId);

    // The relationship snapshot is a separate SQLite durability boundary. Delete
    // the JsonStore parent first so a later SQLite failure leaves confirmed
    // relationship content and Evidence available for an idempotent retry.
    await authContext.store.delete("evaluation-reports", uploadId);
    await authContext.store.delete("uploads", uploadId);

    if (relationshipInteraction) {
      if (isBrowserCacheCleanup) {
        relationshipSnapshotRetained = dateCompanionRepository.markUploadSourceState(
          authContext.user.id,
          uploadId,
          "server_cleaned"
        );
        if (!relationshipSnapshotRetained) {
          throw new Error("date_companion_source_state_update_failed");
        }
      } else {
        if (!explicitDeletePrecondition || !explicitDeletePrecondition.ok) {
          throw new Error("date_companion_delete_precondition_missing");
        }
        relationshipInteractionDeleted = dateCompanionRepository.deleteInteractionByUpload(
          authContext.user.id,
          uploadId,
          explicitDeletePrecondition.interactionId,
          explicitDeletePrecondition.expectedVersion
        );
        if (!relationshipInteractionDeleted) {
          throw new Error("date_companion_interaction_delete_failed");
        }
      }
    }
  } catch (error) {
    if (error instanceof DcVersionConflictError) {
      return NextResponse.json(
        { error: error.code, currentVersion: error.currentVersion },
        { status: 409 }
      );
    }
    if (error instanceof DcConflictError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    console.error(
      "[upload-cleanup] cleanup failed; remaining state is retryable.",
      error instanceof Error ? error.message : "unknown_error"
    );
    return NextResponse.json(
      { error: "upload_cleanup_failed", deleted: false, retryable: true },
      { status: 500 }
    );
  }

  return NextResponse.json({
    deleted: true,
    ...(relationshipSnapshotRetained ? { relationshipSnapshotRetained: true } : {}),
    ...(relationshipInteractionDeleted ? { relationshipInteractionDeleted: true } : {})
  });
}
