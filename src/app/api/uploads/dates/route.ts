import { NextResponse } from "next/server";
import type { AudioUpload } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidRecordingDate(value: string) {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function hasCollectionItems(value: unknown) {
  return Array.isArray(value) && value.length > 0;
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

  const uploads = await authContext.store.list<AudioUpload>("uploads");
  const readyUploadsWithEvidence = await Promise.all(
    uploads
      .map(({ value }) => value)
      .filter((upload) => upload.status === "ready")
      .map(async (upload) => {
        const [segments, semanticSegments, briefItems] = await Promise.all([
          authContext.store.read("segments", upload.id),
          authContext.store.read("semantic-segments", upload.id),
          authContext.store.read("brief-items", upload.id)
        ]);

        return hasCollectionItems(segments) || hasCollectionItems(semanticSegments) || hasCollectionItems(briefItems) ? upload : null;
      })
  );
  const dates = Array.from(
    new Set(
      readyUploadsWithEvidence
        .filter((upload): upload is AudioUpload => Boolean(upload))
        .map((upload) => upload.recordingDate)
        .filter(isValidRecordingDate)
    )
  ).sort();

  return NextResponse.json({ dates });
}
