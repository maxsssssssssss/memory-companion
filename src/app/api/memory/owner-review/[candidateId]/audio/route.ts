import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { isDailyReflectionUpload } from "@/lib/server/daily-reflection/upload-record";
import {
  isMemoryOwnerReviewAudioPath,
  isMemoryOwnerReviewEnabled,
  MemoryOwnerReviewRepository
} from "@/lib/server/memory/owner-review";

export const runtime = "nodejs";

const KeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ candidateId: string }> }
) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  if (!isMemoryOwnerReviewEnabled()) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 404 });
  }
  const candidateId = KeySchema.safeParse((await params).candidateId);
  const segmentId = KeySchema.safeParse(
    new URL(request.url).searchParams.get("segmentId")
  );
  if (!candidateId.success || !segmentId.success) {
    return NextResponse.json({ error: "invalid_audio_request" }, { status: 400 });
  }
  const repository = new MemoryOwnerReviewRepository(authContext.store);
  await repository.cleanupExpired();
  const candidate = await repository.getCandidate(candidateId.data);
  const upload = candidate
    ? await authContext.store.read<unknown>("uploads", candidate.uploadId)
    : null;
  const clip = candidate?.audioClips.find((item) => item.segmentId === segmentId.data);
  if (
    !candidate ||
    !upload ||
    isDailyReflectionUpload(upload) ||
    candidate.status === "expired" ||
    !clip ||
    !isMemoryOwnerReviewAudioPath(clip.filePath, authContext.uploadsRootDir)
  ) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  const file = await stat(clip.filePath).catch(() => null);
  if (!file?.isFile()) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  return new Response(
    Readable.toWeb(createReadStream(clip.filePath)) as ReadableStream,
    {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(file.size),
        "Cache-Control": "private, max-age=300"
      }
    }
  );
}
