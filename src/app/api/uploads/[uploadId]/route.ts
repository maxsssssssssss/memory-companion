import * as fs from "fs/promises";
import { resolve, sep } from "path";
import { NextResponse } from "next/server";
import type { AudioUpload, ProcessingJob, QuestionAnswer } from "@/lib/domain/types";
import { proactiveInsightCacheIdForUpload } from "@/lib/domain/proactive-insights";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { isConfirmedEvaluationDelete, isEvaluationRetentionUpload } from "@/lib/server/evaluation/retention";
import { getMemoryRepository } from "@/lib/server/memory";
import { cleanupGeneratedAudioChunks } from "@/lib/server/transcription/chunks/audio-planner";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";
import { JsonAnalysisChunkCheckpointStore } from "@/lib/server/analysis-chunks/checkpoint";

type StoredUpload = AudioUpload & {
  filePath?: string;
  evaluationRetention?: boolean;
};

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
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

export async function DELETE(_request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await params;

  if (!isValidStoreKey(uploadId)) {
    return NextResponse.json({ error: "invalid_upload_id" }, { status: 400 });
  }

  let authContext;
  try {
    authContext = await requireAuthContext(_request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const upload = await authContext.store.read<StoredUpload>("uploads", uploadId);
  if (!upload) {
    return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
  }

  if (isEvaluationRetentionUpload(upload) && !isConfirmedEvaluationDelete(_request)) {
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
      authContext.store.delete("proactive-insights", proactiveInsightCacheIdForUpload(uploadId)),
      authContext.store.delete("answers-by-upload", uploadId)
    ]);

    getMemoryRepository().deleteByUpload(authContext.user.id, uploadId);

    // Keep the parent record addressable until every retryable child cleanup has completed.
    await authContext.store.delete("evaluation-reports", uploadId);
    await authContext.store.delete("uploads", uploadId);
  } catch (error) {
    console.error(
      "[upload-cleanup] cleanup failed; upload record retained for retry.",
      error instanceof Error ? error.message : "unknown_error"
    );
    return NextResponse.json(
      { error: "upload_cleanup_failed", deleted: false, retryable: true },
      { status: 500 }
    );
  }

  return NextResponse.json({ deleted: true });
}
