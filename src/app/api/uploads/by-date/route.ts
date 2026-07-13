import { stat } from "fs/promises";
import { NextResponse } from "next/server";
import type { AudioUpload } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";

type StoredUpload = AudioUpload & {
  createdAt?: string;
  filePath?: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidRecordingDate(value: string) {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

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

  const { searchParams } = new URL(request.url);
  const recordingDate = searchParams.get("date") ?? "";

  if (!isValidRecordingDate(recordingDate)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  const uploads = await authContext.store.list<StoredUpload>("uploads");
  const uploadCandidates = await Promise.all(
    uploads
      .filter(({ value }) => value.recordingDate === recordingDate)
      .map(async (upload) => ({
        ...upload,
        sortTime: await uploadSortTime(upload.value)
      }))
  );
  const uploadsForDate = uploadCandidates.sort((left, right) => {
    if (left.sortTime !== right.sortTime) {
      return left.sortTime - right.sortTime;
    }

    return left.id.localeCompare(right.id);
  });
  const latestUpload = uploadsForDate[uploadsForDate.length - 1];

  return NextResponse.json({
    uploadId: latestUpload?.id ?? null,
    uploadIds: uploadsForDate.map((upload) => upload.id),
    recordingDate
  });
}
