import { stat } from "fs/promises";
import { NextResponse } from "next/server";
import type { AudioUpload } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";

type StoredUpload = AudioUpload & {
  filePath?: string;
};

async function uploadSortTime(upload: StoredUpload): Promise<number> {
  if (upload.createdAt) {
    const createdAt = Date.parse(upload.createdAt);

    if (!Number.isNaN(createdAt)) {
      return createdAt;
    }
  }

  if (upload.filePath) {
    try {
      return (await stat(upload.filePath)).mtimeMs;
    } catch {
      // Older records may point at files that were manually removed. Fall through to date/id sorting.
    }
  }

  const recordingDate = Date.parse(upload.recordingDate);
  return Number.isNaN(recordingDate) ? 0 : recordingDate;
}

export async function GET(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const uploads = await authContext.store.list<StoredUpload>("uploads");
  const uploadCandidates = await Promise.all(
    uploads.map(async (upload) => ({
      ...upload,
      sortTime: await uploadSortTime(upload.value)
    }))
  );
  const latestUpload = uploadCandidates.sort((left, right) => {
    if (left.sortTime !== right.sortTime) {
      return right.sortTime - left.sortTime;
    }

    return right.id.localeCompare(left.id);
  })[0];

  return NextResponse.json({ uploadId: latestUpload?.id ?? null });
}
