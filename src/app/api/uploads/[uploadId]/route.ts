import * as fs from "fs/promises";
import { resolve, sep } from "path";
import { NextResponse } from "next/server";
import type { AudioUpload, ProcessingJob, QuestionAnswer } from "@/lib/domain/types";
import { proactiveInsightCacheIdForUpload } from "@/lib/domain/proactive-insights";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { getMemoryRepository } from "@/lib/server/memory";

type StoredUpload = AudioUpload & {
  filePath?: string;
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

  await authContext.store.write("deleted-uploads", uploadId, {
    uploadId,
    deletedAt: new Date().toISOString()
  });

  if (upload.filePath && isUploadFilePath(upload.filePath, authContext.uploadsRootDir)) {
    await fs.rm(upload.filePath, { force: true });
  }

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
    authContext.store.delete("uploads", uploadId),
    authContext.store.delete("jobs-by-upload", uploadId),
    authContext.store.delete("segments", uploadId),
    authContext.store.delete("audio-insights", uploadId),
    authContext.store.delete("semantic-segments", uploadId),
    authContext.store.delete("brief-items", uploadId),
    authContext.store.delete("relationship-signals", uploadId),
    authContext.store.delete("proactive-insights", proactiveInsightCacheIdForUpload(uploadId)),
    authContext.store.delete("answers-by-upload", uploadId)
  ]);

  try {
    getMemoryRepository().deleteByUpload(authContext.user.id, uploadId);
  } catch (error) {
    console.warn(
      "[memory-index] upload cleanup failed; JSON upload deletion completed.",
      error instanceof Error ? error.message : "unknown_error"
    );
  }

  return NextResponse.json({ deleted: true });
}
