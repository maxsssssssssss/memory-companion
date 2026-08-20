import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

import {
  getUserScopedStore,
  getUserUploadsRootDir
} from "@/lib/server/auth/session";
import {
  VoiceprintTrainingCandidateRepository,
  isVoiceprintCandidateFilePath
} from "@/lib/server/speaker-identity/voiceprint-training-candidates";

export const runtime = "nodejs";

const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function GET(
  request: Request,
  {
    params
  }: {
    params: Promise<{ userId: string; candidateId: string }>;
  }
) {
  const token = process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN?.trim();
  const requestToken = new URL(request.url).searchParams.get("token")?.trim();
  if (!token || requestToken !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { userId, candidateId } = await params;
  if (
    !SAFE_KEY_PATTERN.test(userId) ||
    !SAFE_KEY_PATTERN.test(candidateId)
  ) {
    return NextResponse.json(
      { error: "invalid_audio_request" },
      { status: 400 }
    );
  }
  const store = getUserScopedStore(userId);
  const uploadsRootDir = getUserUploadsRootDir(userId);
  const repository = new VoiceprintTrainingCandidateRepository(store);
  await repository.cleanupExpired(uploadsRootDir);
  const candidate = await repository.get(candidateId);
  if (
    !candidate?.audioFilePath ||
    !["queued", "trained"].includes(candidate.status) ||
    !isVoiceprintCandidateFilePath(candidate.audioFilePath, uploadsRootDir)
  ) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  const file = await stat(candidate.audioFilePath).catch(() => null);
  if (!file?.isFile()) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  return new Response(
    Readable.toWeb(createReadStream(candidate.audioFilePath)) as ReadableStream,
    {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(file.size),
        "Cache-Control": "private, max-age=300"
      }
    }
  );
}
